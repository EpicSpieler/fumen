/* pool-dialog.ts — making a pool, or changing its kinds of slot: a name, the ruleset (and key
 * count in osu!mania) when it's new, and the kinds with how many slots each and their mods. A new
 * pool starts from its ruleset's preset (lib/pools). */
import { esc, num } from "../lib/format";
import { t, tn } from "../lib/i18n";
import { createPool, kindInfo, presetKinds, slotCodes, updatePool, type Pool, type PoolKind } from "../lib/pools";
import { store } from "../lib/store";
import { attachSegIndicator, closeAnimated, uiConfirm } from "../ui/controls";
import { icon } from "../ui/icons";

const RULESETS = ["osu!", "osu!taiko", "osu!catch", "osu!mania"];
/** the mods a kind can have, by ruleset (osu!mania: the ones that change its numbers) */
const KIND_MODS = (mode: number): string[] => (mode === 3 ? ["EZ", "NF", "HT", "DT"] : ["EZ", "NF", "HT", "HR", "DT", "HD", "FL"]);
const CLASH: [string, string][] = [
  ["EZ", "HR"],
  ["HT", "DT"],
];

/** The key counts in the library's osu!mania charts, most first. */
function keyCounts(): number[] {
  const n = new Map<number, number>();
  for (const m of store.snap?.maps ?? []) if (m.mode === 3) n.set(Math.round(m.cs), (n.get(Math.round(m.cs)) ?? 0) + 1);
  const out = [...n].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return out.length ? out.slice(0, 6) : [4, 7];
}

/** A new pool (resolves to its id), or the kinds of one (resolves when saved). */
export function openPoolDialog(edit?: Pool): Promise<string | null> {
  return new Promise((resolve) => {
    const keyChoices = keyCounts();
    let mode = edit?.mode ?? 3;
    let keys: number | null = edit ? (edit.keys ?? null) : keyChoices[0];
    let kinds: PoolKind[] = (edit?.categories ?? presetKinds(mode)).map((k) => ({ ...k, mods: [...k.mods] }));
    /** still the preset: a change of ruleset brings the new one's */
    let untouched = !edit;

    const bd = document.createElement("div");
    bd.className = "modal-backdrop dialog-backdrop";
    bd.innerHTML = `
      <div class="modal-panel dialog pool-dialog" role="dialog" aria-modal="true" aria-labelledby="pool-dialog-title">
        <div class="dialog-title" id="pool-dialog-title">${edit ? t("Slots of {pool}", { pool: esc(edit.name) }) : t("New pool")}</div>
        ${edit ? "" : `<input class="dialog-input pool-name" type="text" spellcheck="false" autocomplete="off" maxlength="100" placeholder="${t("Name, like the tournament's")}" aria-label="${t("Name")}">`}
        ${
          edit
            ? ""
            : `<div class="pool-dialog-row">
                <div class="seg-pill pool-modes" role="group" aria-label="${t("Ruleset")}">${RULESETS.map((r, i) => `<button type="button" data-mode="${i}">${r}</button>`).join("")}</div>
                <div class="seg-pill pool-keys" role="group" aria-label="${t("Keys")}">${keyChoices.map((k) => `<button type="button" data-keys="${k}">${k}K</button>`).join("")}</div>
              </div>`
        }
        <div class="pool-dialog-label label-caps">${t("Kinds of slot")}</div>
        <div class="pool-kinds-edit"></div>
        <button class="btn btn-ghost btn-sm pool-kind-add" type="button">${icon("plus")}<span>${t("Add a kind")}</span></button>
        <div class="dialog-actions">
          <span class="pool-dialog-count num"></span>
          <button class="btn btn-ghost" type="button" data-act="cancel">${t("Cancel")}</button>
          <button class="btn btn-primary" type="button" data-act="ok">${edit ? t("Save") : t("Make")}</button>
        </div>
      </div>`;
    const list = bd.querySelector<HTMLElement>(".pool-kinds-edit")!;
    const name = bd.querySelector<HTMLInputElement>(".pool-name");
    const ok = bd.querySelector<HTMLButtonElement>('[data-act="ok"]')!;

    const render = () => {
      bd.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("active", +b.dataset.mode! === mode));
      const keyPill = bd.querySelector<HTMLElement>(".pool-keys");
      if (keyPill) {
        keyPill.hidden = mode !== 3;
        keyPill.querySelectorAll<HTMLElement>("[data-keys]").forEach((b) => b.classList.toggle("active", +b.dataset.keys! === keys));
      }
      const mods = KIND_MODS(mode);
      list.innerHTML = kinds
        .map((k, i) => {
          const info = kindInfo(k.code);
          return `<div class="pk-row" data-i="${i}">
            <span class="pk-dot" style="background:${info.color}"></span>
            <input class="pk-code" type="text" maxlength="4" spellcheck="false" autocomplete="off" value="${esc(k.code)}" aria-label="${t("Short name")}">
            <span class="pk-name">${info.name !== k.code ? esc(info.name) : ""}</span>
            <span class="pk-count">
              <button class="icon-btn sm" type="button" data-step="-1" aria-label="${t("Fewer")}"${k.count <= 1 ? " disabled" : ""}>${icon("minus")}</button>
              <b class="num">${k.count}</b>
              <button class="icon-btn sm" type="button" data-step="1" aria-label="${t("More")}"${k.count >= 16 ? " disabled" : ""}>${icon("plus")}</button>
            </span>
            <span class="pk-mods">${mods.map((m) => `<button class="chip-toggle pk-mod${k.mods.includes(m) ? " active" : ""}" type="button" data-mod="${m}" aria-pressed="${k.mods.includes(m)}">${m}</button>`).join("")}</span>
            <button class="icon-btn sm pk-remove" type="button" data-tip="${t("Remove this kind")}" aria-label="${t("Remove this kind")}"${kinds.length <= 1 ? " disabled" : ""}>${icon("x")}</button>
          </div>`;
        })
        .join("");
      const total = kinds.reduce((s, k) => s + k.count, 0);
      bd.querySelector(".pool-dialog-count")!.textContent = tn(total, "{n} slot", "{n} slots");
    };

    const valid = (): boolean => {
      const codes = kinds.map((k) => k.code);
      return kinds.length > 0 && codes.every((c) => /^[A-Z]{1,4}$/.test(c)) && new Set(codes).size === codes.length && (!!edit || !!name?.value.trim());
    };
    const sync = () => {
      ok.disabled = !valid();
    };

    const finish = (id: string | null) => {
      document.removeEventListener("keydown", onKey, true);
      closeAnimated(bd);
      resolve(id);
    };
    const save = async () => {
      if (!valid()) return;
      if (edit) {
        const keep = new Set(slotCodes(kinds));
        const lost = edit.slots.filter((s) => !keep.has(s.slot)).map((s) => s.slot);
        if (lost.length) {
          const go = await uiConfirm(t("{slots} have maps in them; those maps leave the pool.", { slots: lost.join(", ") }), {
            title: tn(lost.length, "{n} slot goes", "{n} slots go"),
            confirmLabel: t("Save"),
            danger: true,
          });
          if (!go) return;
        }
        ok.disabled = true;
        await updatePool(edit.id, { categories: kinds });
        finish(edit.id);
      } else {
        ok.disabled = true;
        const id = await createPool(name!.value.trim(), mode, mode === 3 ? keys : null, kinds);
        if (id) finish(id);
        else ok.disabled = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".menu")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && (e.target as Element).closest?.(".pool-dialog")) {
        e.preventDefault();
        e.stopPropagation();
        void save();
      }
    };
    document.addEventListener("keydown", onKey, true);
    bd.addEventListener("pointerdown", (e) => {
      if (e.target === bd) finish(null);
    });
    bd.addEventListener("input", (e) => {
      const input = (e.target as Element).closest<HTMLInputElement>(".pk-code");
      if (input) {
        const i = +input.closest<HTMLElement>(".pk-row")!.dataset.i!;
        const code = input.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
        if (input.value !== code) input.value = code;
        kinds[i].code = code;
        untouched = false;
        // the name and colour follow the letters, without redrawing the field being typed in
        const row = input.closest<HTMLElement>(".pk-row")!;
        const info = kindInfo(code);
        row.querySelector<HTMLElement>(".pk-dot")!.style.background = info.color;
        row.querySelector(".pk-name")!.textContent = info.name !== code ? info.name : "";
      }
      sync();
    });
    bd.addEventListener("click", (e) => {
      const el = e.target as Element;
      const m = el.closest<HTMLElement>("[data-mode]");
      if (m) {
        mode = +m.dataset.mode!;
        if (untouched) kinds = presetKinds(mode);
        else for (const k of kinds) k.mods = k.mods.filter((x) => KIND_MODS(mode).includes(x));
        render();
        return sync();
      }
      const kb = el.closest<HTMLElement>("[data-keys]");
      if (kb) {
        keys = +kb.dataset.keys!;
        return render();
      }
      const row = el.closest<HTMLElement>(".pk-row");
      const i = row ? +row.dataset.i! : -1;
      const step = el.closest<HTMLButtonElement>("[data-step]");
      if (step && !step.disabled) {
        kinds[i].count = Math.max(1, Math.min(16, kinds[i].count + +step.dataset.step!));
        untouched = false;
        return render();
      }
      const mod = el.closest<HTMLElement>("[data-mod]");
      if (mod) {
        const x = mod.dataset.mod!;
        const k = kinds[i];
        k.mods = k.mods.includes(x) ? k.mods.filter((y) => y !== x) : [...k.mods.filter((y) => !CLASH.some(([a, b]) => (a === x && y === b) || (b === x && y === a))), x];
        untouched = false;
        return render();
      }
      if (el.closest(".pk-remove") && kinds.length > 1) {
        kinds.splice(i, 1);
        untouched = false;
        render();
        return sync();
      }
      if (el.closest(".pool-kind-add") && kinds.length < 12) {
        kinds.push({ code: "", count: 1, mods: [] });
        untouched = false;
        render();
        sync();
        list.querySelector<HTMLInputElement>(".pk-row:last-child .pk-code")?.focus();
        return;
      }
      if (el.closest('[data-act="cancel"]')) return finish(null);
      if (el.closest('[data-act="ok"]')) return void save();
    });

    document.body.appendChild(bd);
    render();
    sync();
    const modes = bd.querySelector<HTMLElement>(".pool-modes");
    if (modes) attachSegIndicator(modes);
    setTimeout(() => (name ?? list.querySelector<HTMLInputElement>(".pk-code"))?.focus(), 30);
  });
}

/** How many slots a pool has. */
export const slotCount = (p: Pool): string => `${num(p.slots.length)}/${num(slotCodes(p.categories).length)}`;
