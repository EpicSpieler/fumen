/* delete-window.ts — deleting sets in osu!lazer, in a window of its own: the sets, what they take
 * and whether osu!lazer can be written to now; after deleting they turn to smoke where they are
 * (ui/dissolve.ts) and the window says what happened.
 *
 * Fumen deletes nothing itself: osu!lazer's own Delete does it (src-tauri/src/lazer_import.rs),
 * so the sets go from osu!lazer at once and their files the next time it starts. osu!stable's
 * sets and osu!lazer's protected ones are never in it. */
import { api, asApiError, thumbUrl } from "../lib/api";
import { careReport, knownCare } from "../lib/care-data";
import { bytes, displayArtist, displayTitle, esc, num } from "../lib/format";
import { events, reloadLibrary, store } from "../lib/store";
import type { LazerImportStatus } from "../lib/types";
import { closeAnimated, toast } from "../ui/controls";
import { dissolve } from "../ui/dissolve";
import { icon } from "../ui/icons";
import { VirtualList } from "../ui/virtual";
import { t, tn } from "../lib/i18n";

const ROW_H = 52;
/** the list shows this much before it scrolls */
const LIST_MAX = 312;

interface Row {
  id: string;
  title: string;
  sub: string;
  bg?: string;
  maps: number;
}

export interface DeleteRequest {
  /** what the sets are, for the title (translated): "sets shown here", "sets in your library" */
  what: string;
  /** snapshot set indices */
  sets: number[];
  /** after osu!lazer deleted them */
  deleted?: () => void;
}

type State = "ask" | "working" | "gone" | "done";

let current: DeleteWindow | null = null;

/** Opens the window for these sets (osu!stable's and protected ones are left out, and said so). */
export function openDeleteWindow(req: DeleteRequest): void {
  const snap = store.snap;
  if (!snap) return;
  const unicode = store.prefs.unicode;
  const rows: Row[] = [];
  const seen = new Set<string>();
  let stable = 0;
  let kept = 0;
  for (const i of req.sets) {
    const s = snap.sets[i];
    if (!s || seen.has(s.id) || !s.maps.length) continue;
    seen.add(s.id);
    if (s.from === "stable") {
      stable++;
      continue;
    }
    if (s.protected) {
      kept++;
      continue;
    }
    const maps = s.maps.length;
    rows.push({
      id: s.id,
      title: displayTitle(s, unicode),
      sub: [displayArtist(s, unicode), s.creator, tn(maps, "{n} difficulty", "{n} difficulties")].filter(Boolean).join(" · "),
      bg: s.bg,
      maps,
    });
  }
  if (!rows.length) {
    toast(stable ? t("Nothing to delete here: Fumen never touches osu!stable's sets.") : t("Nothing to delete here."));
    return;
  }
  current?.close();
  current = new DeleteWindow(req, rows, stable, kept);
}

class DeleteWindow {
  private el: HTMLElement;
  private state: State = "ask";
  private status: LazerImportStatus | null = null;
  private sizes: Map<string, number> | null = null;
  private list: VirtualList;
  private poll = 0;
  private result: { deleted: number; skipped: number } | null = null;
  private error: string | null = null;

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (this.state === "ask" || this.state === "done") this.close();
  };

  constructor(
    private req: DeleteRequest,
    private rows: Row[],
    private stable: number,
    private kept: number,
  ) {
    const el = document.createElement("div");
    el.className = "modal-backdrop dw-backdrop";
    el.innerHTML = `
      <div class="modal-panel dw" role="dialog" aria-modal="true" aria-labelledby="dw-title">
        <button class="icon-btn modal-close" type="button" data-act="close" aria-label="${t("Close")}">${icon("x")}</button>
        <div class="dw-head">
          <div class="dw-title" id="dw-title"></div>
          <div class="dw-sub meta-line num"></div>
        </div>
        <div class="dw-stage">
          <div class="imp-lazer dw-lazer"></div>
          <div class="dw-list-wrap">
            <div class="dw-list"><div class="dw-body"></div></div>
          </div>
          <div class="dw-note"></div>
          <div class="dw-error" hidden></div>
          <div class="dw-done" hidden></div>
        </div>
        <div class="dw-actions">
          <button class="btn btn-ghost" type="button" data-act="cancel">${t("Cancel")}</button>
          <button class="btn btn-danger dw-go" type="button" data-act="go">${icon("trash")}<span>${t("Delete in osu!lazer")}</span></button>
        </div>
      </div>`;
    this.el = el;
    const listEl = el.querySelector<HTMLElement>(".dw-list")!;
    // the list keeps its height from start to end: nothing in the window moves
    el.querySelector<HTMLElement>(".dw-list-wrap")!.style.height = `${Math.min(LIST_MAX, rows.length * ROW_H)}px`;
    this.list = new VirtualList({
      scroller: listEl,
      body: el.querySelector(".dw-body")!,
      count: () => this.rows.length,
      rowHeight: () => ROW_H,
      keyOf: (i) => this.rows[i].id,
      renderRow: (i, row) => this.renderRow(i, row),
      rowClass: "dw-row",
      overscanPx: 160,
    });

    el.addEventListener("click", (e) => {
      const act = (e.target as Element).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "close" || act === "cancel") {
        if (this.state === "ask" || this.state === "done") this.close();
      } else if (act === "go") {
        if (this.state === "done") this.close();
        else void this.go();
      }
    });
    el.addEventListener("pointerdown", (e) => {
      if (e.target === el && (this.state === "ask" || this.state === "done")) this.close();
    });
    el.addEventListener(
      "load",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName === "IMG") img.classList.add("loaded");
      },
      true,
    );
    el.addEventListener(
      "error",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName !== "IMG") return;
        img.parentElement?.classList.add("img-missing");
        img.remove();
      },
      true,
    );
    document.addEventListener("keydown", this.onKey, true);
    document.body.appendChild(el);
    this.list.refresh();
    this.render();

    // what they take on disk: from library care's report (measured now if it hasn't been)
    const known = knownCare();
    if (known) this.takeSizes(known.sets);
    else
      void careReport()
        .then((r) => this.takeSizes(r.sets))
        .catch(() => {});
    void this.refreshStatus();
    // closing osu!lazer turns the button on without asking
    this.poll = window.setInterval(() => {
      if (this.state === "ask") void this.refreshStatus();
    }, 3000);
    setTimeout(() => el.querySelector<HTMLElement>('[data-act="cancel"]')?.focus(), 30);
  }

  close(): void {
    clearInterval(this.poll);
    this.list.destroy();
    document.removeEventListener("keydown", this.onKey, true);
    closeAnimated(this.el);
    if (current === this) current = null;
  }

  private takeSizes(sets: { id: string; size: number }[]): void {
    this.sizes = new Map(sets.map((s) => [s.id, s.size]));
    // rows turning to smoke stay as they are
    if (this.state === "ask" || this.state === "working") this.list.refresh();
    this.renderHead();
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.status = await api.lazerImportStatus();
    } catch (e) {
      this.status = { ready: false, reason: null, message: asApiError(e).message, version: null, tested: false, running: false, testedVersions: [], unfinished: 0 };
    }
    this.renderLazer();
    this.renderActions();
  }

  // ── deleting ──────────────────────────────────────────────────────────

  private async go(): Promise<void> {
    if (this.state !== "ask" || !this.status?.ready) return;
    this.state = "working";
    this.error = null;
    this.render();
    events.emit("importing", true);
    try {
      this.result = await api.deleteSetsInLazer(this.rows.map((r) => r.id));
    } catch (e) {
      const err = asApiError(e);
      this.error = err.code === "lazer-running" ? t("osu!lazer was opened: close it, then delete again.") : t("osu!lazer couldn't delete them: {error}", { error: err.message });
      this.state = "ask";
      this.render();
      void this.refreshStatus();
      return;
    } finally {
      events.emit("importing", false);
    }
    this.req.deleted?.();
    // the library follows while they turn to smoke
    void reloadLibrary().catch((e) => console.warn("[delete] reload failed", e));

    this.state = "gone";
    this.render();
    const listEl = this.el.querySelector<HTMLElement>(".dw-list")!;
    const box = listEl.getBoundingClientRect();
    const rendered = [...listEl.querySelectorAll<HTMLElement>(".dw-row")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const seen: HTMLElement[] = [];
    for (const r of rendered) {
      const rr = r.getBoundingClientRect();
      if (rr.bottom > box.top + 2 && rr.top < box.bottom - 2) seen.push(r);
      else r.style.opacity = "0";
    }
    await dissolve(seen, box);
    this.state = "done";
    this.render();
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private render(): void {
    this.el.querySelector(".dw")!.setAttribute("data-state", this.state);
    this.renderHead();
    this.renderLazer();
    this.renderNote();
    this.renderDone();
    this.renderActions();
    const err = this.el.querySelector<HTMLElement>(".dw-error")!;
    err.hidden = !this.error;
    err.textContent = this.error ?? "";
  }

  private total(): number | null {
    if (!this.sizes) return null;
    return this.rows.reduce((s, r) => s + (this.sizes!.get(r.id) ?? 0), 0);
  }

  private renderHead(): void {
    const n = this.rows.length;
    const done = this.state === "done";
    const title = this.el.querySelector<HTMLElement>(".dw-title")!;
    title.textContent = done
      ? n === 1
        ? t("Deleted “{title}”", { title: this.rows[0].title })
        : t("Deleted {n} {what}", { n: num(this.result?.deleted ?? n), what: this.req.what })
      : n === 1
        ? t("Delete “{title}”?", { title: this.rows[0].title })
        : t("Delete {n} {what}?", { n: num(n), what: this.req.what });
    const maps = this.rows.reduce((s, r) => s + r.maps, 0);
    const total = this.total();
    this.el.querySelector<HTMLElement>(".dw-sub")!.innerHTML = [
      n === 1 ? "" : tn(n, "{n} set", "{n} sets"),
      tn(maps, "{n} difficulty", "{n} difficulties"),
      total === null ? t("measuring…") : t("{size} on disk", { size: bytes(total) }),
    ]
      .filter(Boolean)
      .map((w) => `<span>${w}</span>`)
      .join("");
  }

  private renderLazer(): void {
    const el = this.el.querySelector<HTMLElement>(".dw-lazer")!;
    const st = this.status;
    if (!st) {
      el.className = "imp-lazer dw-lazer";
      el.innerHTML = `<span class="imp-lazer-text">${t("Checking osu!lazer…")}</span>`;
      return;
    }
    el.className = `imp-lazer dw-lazer ${st.ready ? "ok" : st.reason === "running" ? "wait" : "off"}`;
    const short = (v: string) => v.replace(/-lazer$/, "");
    const ic = icon(st.ready ? "check" : "alert", "imp-lazer-ic");
    const why =
      st.reason === "running"
        ? t("osu!lazer is running. Close it to delete.")
        : st.reason === "untested" && st.version
          ? t("osu!lazer {version} isn't tested with Fumen yet; deleting through it stays off until it is.", { version: short(st.version) })
          : (st.message ?? t("osu!lazer can't be written to right now."));
    el.innerHTML =
      st.ready && st.version
        ? `${ic}<span class="meta-line imp-lazer-text"><span>osu!lazer ${esc(short(st.version))}</span><span>${t("Tested with Fumen")}</span><span>${t("Closed")}</span></span>`
        : `${ic}<span class="imp-lazer-text">${esc(why)}</span>`;
  }

  private renderNote(): void {
    const el = this.el.querySelector<HTMLElement>(".dw-note")!;
    const one = this.rows.length === 1;
    const left = [
      this.stable ? tn(this.stable, "{n} osu!stable set stays: Fumen never touches osu!stable's files.", "{n} osu!stable sets stay: Fumen never touches osu!stable's files.") : "",
      this.kept ? tn(this.kept, "{n} of osu!lazer's own sets stays (protected).", "{n} of osu!lazer's own sets stay (protected).") : "",
    ].filter(Boolean);
    el.innerHTML =
      `<p>${
        one
          ? t("osu!lazer's own Delete: it's gone from osu!lazer at once, and the next time osu!lazer starts it removes it and its files for good. Your scores on it stay. osu!lazer's database is backed up first.")
          : t("osu!lazer's own Delete: they're gone from osu!lazer at once, and the next time osu!lazer starts it removes them and their files for good. Your scores on them stay. osu!lazer's database is backed up first.")
      }</p>` +
      (left.length ? `<p class="dw-left">${esc(left.join(" "))}</p>` : "");
  }

  private renderDone(): void {
    const el = this.el.querySelector<HTMLElement>(".dw-done")!;
    if (this.state !== "done") {
      el.hidden = true;
      return;
    }
    const r = this.result ?? { deleted: this.rows.length, skipped: 0 };
    const total = this.total();
    el.innerHTML = `
      <div class="dw-done-num num">${num(r.deleted)}</div>
      <div class="dw-done-what">${r.deleted === 1 ? t("set deleted") : t("sets deleted")}</div>
      <div class="dw-done-sub">${
        total ? t("osu!lazer frees up to {size} the next time it starts.", { size: `<b class="num">${bytes(total)}</b>` }) : t("osu!lazer removes the files the next time it starts.")
      } ${r.deleted === 1 ? t("Your scores on it stay.") : t("Your scores on them stay.")}${r.skipped ? ` ${tn(r.skipped, "{n} was already gone.", "{n} were already gone.")}` : ""}</div>`;
    el.hidden = false;
  }

  private renderActions(): void {
    const cancel = this.el.querySelector<HTMLButtonElement>('[data-act="cancel"]')!;
    const go = this.el.querySelector<HTMLButtonElement>(".dw-go")!;
    const closeX = this.el.querySelector<HTMLButtonElement>('[data-act="close"]')!;
    const busy = this.state === "working" || this.state === "gone";
    closeX.disabled = busy;
    cancel.hidden = this.state === "done";
    cancel.disabled = busy;
    if (this.state === "done") {
      go.className = "btn btn-primary dw-go";
      go.innerHTML = `<span>${t("Close")}</span>`;
      go.disabled = false;
      go.focus();
      return;
    }
    go.className = "btn btn-danger dw-go";
    go.innerHTML = busy ? `<span>${t("Deleting…")}</span>` : `${icon("trash")}<span>${t("Delete in osu!lazer")}</span>`;
    go.disabled = busy || !this.status?.ready;
  }

  private renderRow(i: number, row: HTMLElement): void {
    const r = this.rows[i];
    const size = this.sizes?.get(r.id);
    row.style.maskImage = "";
    row.style.removeProperty("-webkit-mask-image");
    row.style.opacity = "";
    row.innerHTML = `
      <span class="t-art${r.bg ? "" : " img-missing"}">${r.bg ? `<img src="${thumbUrl(r.bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text"><div class="t-title">${esc(r.title)}</div><div class="t-sub">${esc(r.sub)}</div></div>
      <b class="dw-size num">${size !== undefined ? bytes(size) : ""}</b>`;
  }
}
