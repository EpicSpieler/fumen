/* match-dialog.ts — making a match or changing one: who plays red and who blue (players, or
 * teams), when (in the player's own time), best of how many, warm-ups that don't count, who picks
 * first, and the osu! multiplayer room (a link to it, or later). */
import { esc } from "../lib/format";
import { t } from "../lib/i18n";
import { createMatch, setMatchRoom, updateMatch, type Match, type Side } from "../lib/matches";
import { asApiError } from "../lib/api";
import { attachSegIndicator, closeAnimated } from "../ui/controls";
import { icon } from "../ui/icons";

/** unix ms as a datetime-local field's value (the player's time) */
function localValue(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A new match in a pool (resolves to its id), or a change to one (resolves when saved). */
export function openMatchDialog(poolId: string, edit?: Match): Promise<string | null> {
  return new Promise((resolve) => {
    let bestOf = edit?.bestOf ?? 7;
    let warmups = edit?.warmups ?? 0;
    let firstPick: Side | "" = edit?.firstPick ?? "";
    /** made already (its room's link wasn't right yet) */
    let made: string | null = null;

    const bd = document.createElement("div");
    bd.className = "modal-backdrop dialog-backdrop";
    bd.innerHTML = `
      <div class="modal-panel dialog match-dialog" role="dialog" aria-modal="true" aria-labelledby="match-dialog-title">
        <div class="dialog-title" id="match-dialog-title">${edit ? t("Change the match") : t("New match")}</div>
        <div class="md-sides">
          <label class="md-side red"><span class="label-caps">${t("Red")}</span><input class="dialog-input md-red" type="text" spellcheck="false" autocomplete="off" maxlength="100" placeholder="${t("Player or team")}" value="${esc(edit?.red ?? "")}"></label>
          <span class="md-vs">vs</span>
          <label class="md-side blue"><span class="label-caps">${t("Blue")}</span><input class="dialog-input md-blue" type="text" spellcheck="false" autocomplete="off" maxlength="100" placeholder="${t("Player or team")}" value="${esc(edit?.blue ?? "")}"></label>
        </div>
        <div class="md-grid">
          <span class="md-label">${t("When")}</span>
          <input class="dialog-input md-at" type="datetime-local" value="${localValue(edit?.at)}" aria-label="${t("When")}">
          <span class="md-label">${t("Best of")}</span>
          <span class="pk-count md-step" data-what="bestOf">
            <button class="icon-btn sm" type="button" data-step="-2" aria-label="${t("Fewer")}">${icon("minus")}</button>
            <b class="num"></b>
            <button class="icon-btn sm" type="button" data-step="2" aria-label="${t("More")}">${icon("plus")}</button>
            <span class="md-hint num"></span>
          </span>
          <span class="md-label">${t("Warm-ups")}</span>
          <span class="pk-count md-step" data-what="warmups">
            <button class="icon-btn sm" type="button" data-step="-1" aria-label="${t("Fewer")}">${icon("minus")}</button>
            <b class="num"></b>
            <button class="icon-btn sm" type="button" data-step="1" aria-label="${t("More")}">${icon("plus")}</button>
            <span class="md-hint">${t("games at the start that don't count")}</span>
          </span>
          <span class="md-label">${t("First pick")}</span>
          <div class="seg-pill md-first" role="group" aria-label="${t("First pick")}">
            <button type="button" data-first="">${t("Not yet")}</button>
            <button type="button" data-first="red">${t("Red")}</button>
            <button type="button" data-first="blue">${t("Blue")}</button>
          </div>
          <span class="md-label">${t("osu! room")}</span>
          <input class="dialog-input md-room" type="text" spellcheck="false" autocomplete="off" placeholder="${t("Link to the multiplayer room, once it's open")}" value="${edit?.mpId ? `https://osu.ppy.sh/community/matches/${edit.mpId}` : ""}" aria-label="${t("osu! room")}">
        </div>
        <div class="md-error" hidden></div>
        <div class="dialog-actions">
          <button class="btn btn-ghost" type="button" data-act="cancel">${t("Cancel")}</button>
          <button class="btn btn-primary" type="button" data-act="ok">${edit ? t("Save") : t("Make")}</button>
        </div>
      </div>`;
    const ok = bd.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
    const field = (sel: string) => bd.querySelector<HTMLInputElement>(sel)!;
    const error = bd.querySelector<HTMLElement>(".md-error")!;

    const render = () => {
      bd.querySelector('[data-what="bestOf"] b')!.textContent = String(bestOf);
      bd.querySelector('[data-what="bestOf"] .md-hint')!.textContent = t("first to {n}", { n: Math.floor(bestOf / 2) + 1 });
      bd.querySelector('[data-what="warmups"] b')!.textContent = String(warmups);
      bd.querySelectorAll<HTMLButtonElement>('[data-what="bestOf"] [data-step]').forEach((b) => (b.disabled = +b.dataset.step! < 0 ? bestOf <= 1 : bestOf >= 21));
      bd.querySelectorAll<HTMLButtonElement>('[data-what="warmups"] [data-step]').forEach((b) => (b.disabled = +b.dataset.step! < 0 ? warmups <= 0 : warmups >= 10));
      bd.querySelectorAll<HTMLElement>("[data-first]").forEach((b) => b.classList.toggle("active", b.dataset.first === firstPick));
    };

    const finish = (id: string | null) => {
      document.removeEventListener("keydown", onKey, true);
      closeAnimated(bd);
      resolve(id);
    };
    const save = async () => {
      ok.disabled = true;
      error.hidden = true;
      const when = field(".md-at").value ? new Date(field(".md-at").value).getTime() : 0;
      const patch = { red: field(".md-red").value, blue: field(".md-blue").value, at: Number.isFinite(when) ? when : 0, bestOf, warmups, firstPick };
      const known = edit?.id ?? made;
      const id = known ? ((await updateMatch(known, patch)) !== undefined ? known : null) : await createMatch(poolId, patch);
      if (!id) {
        ok.disabled = false;
        return;
      }
      const room = field(".md-room").value.trim();
      const had = edit?.mpId ? `https://osu.ppy.sh/community/matches/${edit.mpId}` : "";
      if (room !== had) {
        try {
          await setMatchRoom(id, room);
        } catch (e) {
          // the rest is saved; the room's link stays to be fixed
          error.textContent = asApiError(e).message;
          error.hidden = false;
          ok.disabled = false;
          made = id;
          return;
        }
      }
      finish(id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(made);
      } else if (e.key === "Enter" && (e.target as Element).closest?.(".match-dialog")) {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    document.addEventListener("keydown", onKey, true);
    bd.addEventListener("pointerdown", (e) => {
      if (e.target === bd) finish(made);
    });
    bd.addEventListener("click", (e) => {
      const el = e.target as Element;
      const step = el.closest<HTMLButtonElement>("[data-step]");
      if (step && !step.disabled) {
        const what = step.closest<HTMLElement>("[data-what]")!.dataset.what;
        if (what === "bestOf") bestOf = Math.max(1, Math.min(21, bestOf + +step.dataset.step!));
        else warmups = Math.max(0, Math.min(10, warmups + +step.dataset.step!));
        return render();
      }
      const first = el.closest<HTMLElement>("[data-first]");
      if (first) {
        firstPick = first.dataset.first as Side | "";
        return render();
      }
      if (el.closest('[data-act="cancel"]')) return finish(made);
      if (el.closest('[data-act="ok"]')) return void save();
    });

    document.body.appendChild(bd);
    render();
    attachSegIndicator(bd.querySelector<HTMLElement>(".md-first")!);
    setTimeout(() => field(".md-red").focus(), 30);
  });
}
