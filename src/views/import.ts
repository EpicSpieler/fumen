/* import.ts — "Add beatmaps": pasted osu! links → sets downloaded → imported into osu!lazer by
   lazer's own code (src-tauri/src/lazer_import.rs: only tested lazer versions, only while lazer is
   closed) → in the library. The dialog can be closed while an import runs; reopening it shows
   where it is. */
import { api, asApiError, onImportProgress } from "../lib/api";
import { esc, num } from "../lib/format";
import { readLinks } from "../lib/links";
import { events, refreshStatus, reloadLibrary } from "../lib/store";
import type { ImportProgress, ImportStage, ImportSummary, LazerImportStatus } from "../lib/types";
import { closeAnimated, toast } from "../ui/controls";
import { icon } from "../ui/icons";

interface Row {
  link: string;
  stage: ImportStage | "waiting";
  set?: number;
  title?: string;
  done: number;
  total: number;
  message?: string;
}

interface Job {
  rows: Row[];
  running: boolean;
  summary?: ImportSummary;
  /** why the import stopped (or never started) */
  error?: string;
}

/** the last import (shown until "Add more"), or one that couldn't start */
let job: Job | null = null;
/** what's in the field, kept while the dialog is closed */
let draft = "";
let dialog: ImportDialog | null = null;

export const isImporting = (): boolean => !!job?.running;

/** "2 of 5" while an import runs, for the sidebar */
export function importProgressText(): string | null {
  if (!job?.running) return null;
  const finished = job.rows.filter((r) => r.stage === "done" || r.stage === "skipped" || r.stage === "error").length;
  return `${num(finished)} of ${num(job.rows.length)}`;
}

/** Opens the dialog; `text` (pasted links) goes into the field and starts over a finished import. */
export function openImport(text?: string): void {
  if (text && !job?.running) {
    job = null;
    draft = draft.trim() ? `${draft.trim()}\n${text.trim()}` : text.trim();
  }
  if (dialog) dialog.render(true);
  else dialog = new ImportDialog();
}

const short = (v: string) => v.replace(/-lazer$/, "");
const mb = (bytes: number) => (bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0);
const showsRows = (j: Job | null): j is Job => !!j && j.rows.length > 0;

class ImportDialog {
  private readonly el: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly rowsEl: HTMLElement;
  private readonly lazerEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly goBtn: HTMLButtonElement;
  private status: LazerImportStatus | null = null;
  private poll = 0;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.go();
    }
  };

  constructor() {
    const el = document.createElement("div");
    el.className = "modal-backdrop imp-backdrop";
    el.innerHTML = `
      <div class="modal-panel imp" role="dialog" aria-modal="true" aria-labelledby="imp-title">
        <button class="icon-btn modal-close" type="button" data-act="close" aria-label="Close">${icon("x")}</button>
        <div class="imp-head">
          <div class="imp-title" id="imp-title">Add beatmaps</div>
          <div class="imp-sub">Paste links from osu.ppy.sh. Fumen downloads each set and imports it into osu!lazer, the way lazer itself does.</div>
        </div>
        <div class="imp-lazer"></div>
        <textarea class="imp-input" rows="6" spellcheck="false" autocomplete="off" aria-label="osu! links"
          placeholder="https://osu.ppy.sh/beatmapsets/…&#10;https://osu.ppy.sh/beatmaps/…"></textarea>
        <div class="imp-rows" hidden></div>
        <div class="imp-foot">
          <div class="imp-note"></div>
          <div class="imp-actions">
            <button class="btn btn-ghost" type="button" data-act="close">Close</button>
            <button class="btn btn-primary" type="button" data-act="go">Import</button>
          </div>
        </div>
      </div>`;
    this.el = el;
    this.input = el.querySelector(".imp-input")!;
    this.rowsEl = el.querySelector(".imp-rows")!;
    this.lazerEl = el.querySelector(".imp-lazer")!;
    this.noteEl = el.querySelector(".imp-note")!;
    this.goBtn = el.querySelector('[data-act="go"]')!;

    el.addEventListener("pointerdown", (e) => {
      if (e.target === el) this.close();
    });
    el.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener("click", () => this.close()));
    this.goBtn.addEventListener("click", () => this.go());
    this.input.addEventListener("input", () => {
      draft = this.input.value;
      // editing the links clears why the last try didn't start
      if (job && !job.running && !showsRows(job)) job = null;
      this.render();
    });
    document.addEventListener("keydown", this.onKey, true);
    document.body.appendChild(el);

    this.render(true);
    void this.refreshStatus();
    this.poll = window.setInterval(() => {
      // closing lazer turns the button on without asking
      if (!job?.running) void this.refreshStatus();
    }, 3000);
    setTimeout(() => (showsRows(job) ? this.goBtn : this.input).focus(), 30);
  }

  close(): void {
    clearInterval(this.poll);
    document.removeEventListener("keydown", this.onKey, true);
    closeAnimated(this.el);
    dialog = null;
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.status = await api.lazerImportStatus();
    } catch (e) {
      this.status = { ready: false, reason: null, message: asApiError(e).message, version: null, tested: false, running: false, testedVersions: [] };
    }
    this.renderLazer();
    this.renderActions();
  }

  // ── rendering ─────────────────────────────────────────────────────────

  /** `fromDraft`: the field takes the kept text (after opening, or new links pasted) */
  render(fromDraft = false): void {
    const rows = showsRows(job);
    if (fromDraft && this.input.value !== draft) this.input.value = draft;
    this.input.hidden = rows;
    this.rowsEl.hidden = !rows;
    if (rows) this.renderRows();
    this.renderLazer();
    this.renderNote();
    this.renderActions();
  }

  private renderLazer(): void {
    const st = this.status;
    const el = this.lazerEl;
    if (!st) {
      el.className = "imp-lazer";
      el.innerHTML = `<span class="imp-lazer-text">Checking osu!lazer…</span>`;
      delete el.dataset.tip;
      return;
    }
    el.className = `imp-lazer ${st.ready ? "ok" : st.reason === "running" ? "wait" : "off"}`;
    const ic = icon(st.ready ? "check" : "alert", "imp-lazer-ic");
    el.innerHTML =
      st.ready && st.version
        ? `${ic}<span class="meta-line imp-lazer-text"><span>osu!lazer ${esc(short(st.version))}</span><span>Tested with Fumen</span><span>Closed</span></span>`
        : `${ic}<span class="imp-lazer-text">${esc(st.message ?? "Importing isn't possible right now.")}</span>`;
    if (st.reason === "untested") {
      el.dataset.tip = st.testedVersions.length
        ? `Tested: ${st.testedVersions.map(short).join(", ")}\nImporting comes back once this version is checked.`
        : "No osu!lazer version is tested yet.";
    } else delete el.dataset.tip;
  }

  private renderNote(): void {
    const n = this.noteEl;
    const words = (list: [string, string?][]) =>
      `<span class="meta-line">${list.map(([w, cls]) => `<span${cls ? ` class="${cls}"` : ""}>${esc(w)}</span>`).join("")}</span>`;
    n.className = "imp-note";
    if (job?.running) {
      n.textContent = "You can close this; the import carries on.";
    } else if (job?.summary) {
      const s = job.summary;
      const list: [string, string?][] = [];
      if (s.imported) list.push([`${num(s.imported)} imported`]);
      if (s.skipped) list.push([`${num(s.skipped)} skipped`]);
      if (s.failed) list.push([`${num(s.failed)} failed`, "bad"]);
      n.innerHTML = words(list.length ? list : [["Nothing to import"]]);
    } else if (job?.error) {
      n.classList.add("bad");
      n.textContent = job.error;
    } else {
      const { links, unknown } = readLinks(this.input.value);
      if (!links.length && !unknown.length) n.textContent = "Set or beatmap links, osu:// links or set IDs";
      else {
        const list: [string, string?][] = [[links.length ? `${num(links.length)} ${links.length === 1 ? "link" : "links"}` : "No links"]];
        if (unknown.length) list.push([`${num(unknown.length)} ${unknown.length === 1 ? "line isn't" : "lines aren't"} an osu! link`, "warn"]);
        n.innerHTML = words(list);
      }
    }
  }

  private renderActions(): void {
    const b = this.goBtn;
    if (job?.running) {
      b.disabled = true;
      b.textContent = "Importing…";
    } else if (showsRows(job)) {
      b.disabled = false;
      b.textContent = job.summary?.failed ? "Try failed again" : "Add more";
    } else {
      b.textContent = "Import";
      b.disabled = !this.status?.ready || readLinks(this.input.value).links.length === 0;
    }
  }

  private renderRows(): void {
    if (!job) return;
    if (this.rowsEl.children.length !== job.rows.length) {
      this.rowsEl.innerHTML = job.rows
        .map(() => `<div class="imp-row"><div class="imp-row-title"></div><div class="imp-row-state"></div><div class="imp-bar" hidden><i></i></div></div>`)
        .join("");
    }
    job.rows.forEach((_, i) => this.renderRow(i));
  }

  renderRow(i: number): void {
    const r = job?.rows[i];
    const el = this.rowsEl.children[i] as HTMLElement | undefined;
    if (!r || !el) return;
    el.dataset.stage = r.stage;
    el.querySelector(".imp-row-title")!.textContent = r.title ?? (r.set ? `Beatmap set ${r.set}` : r.link.replace(/^https?:\/\/(www\.)?osu\.ppy\.sh/i, ""));
    el.querySelector(".imp-row-state")!.textContent = stateText(r);
    const bar = el.querySelector<HTMLElement>(".imp-bar")!;
    bar.hidden = r.stage !== "downloading";
    bar.style.setProperty("--p", r.total ? String(Math.min(1, r.done / r.total)) : "0");
  }

  // ── importing ─────────────────────────────────────────────────────────

  private go(): void {
    if (job?.running) return;
    if (showsRows(job)) {
      // "Add more" / "Try failed again": back to the field, the failed links in it
      draft = job.rows.filter((r) => r.stage === "error").map((r) => r.link).join("\n");
      job = null;
      this.render(true);
      this.input.focus();
      return;
    }
    const { links } = readLinks(this.input.value);
    if (links.length && this.status?.ready) void runImport(links);
  }
}

function stateText(r: Row): string {
  switch (r.stage) {
    case "waiting":
      return "Waiting";
    case "resolving":
      return "Finding its set";
    case "downloading":
      return r.total ? `Downloading · ${mb(r.done)} of ${mb(r.total)} MB` : `Downloading · ${mb(r.done)} MB`;
    case "importing":
      return "Importing into osu!lazer";
    case "done":
      return "Imported";
    case "skipped":
      return r.message ?? "Skipped";
    case "error":
      return r.message ?? "Failed";
  }
}

async function runImport(links: string[]): Promise<void> {
  const current: Job = { rows: links.map((link) => ({ link, stage: "waiting", done: 0, total: 0 })), running: true };
  job = current;
  events.emit("importing", true);
  dialog?.render();
  const stop = await onImportProgress((p: ImportProgress) => {
    const r = current.rows[p.index];
    if (!r) return;
    r.stage = p.stage;
    r.set = p.set ?? r.set;
    r.title = p.title ?? r.title;
    r.done = p.done;
    r.total = p.total;
    r.message = p.message ?? undefined;
    if (job === current) dialog?.renderRow(p.index);
    if (p.stage !== "downloading") events.emit("importing", true);
  });
  try {
    const s = await api.importBeatmaps(links);
    current.summary = s;
    draft = "";
    if (s.imported || s.failed) {
      const parts = [s.imported && `${num(s.imported)} ${s.imported === 1 ? "set" : "sets"} imported into osu!lazer`, s.failed && `${num(s.failed)} failed`];
      toast(parts.filter(Boolean).join(", "), { kind: s.imported ? "success" : "danger", timeout: 4200 });
    }
    if (s.imported) {
      await reloadLibrary().catch((e) => console.warn("[import] reload failed", e));
      await refreshStatus().catch(() => {});
    }
  } catch (e) {
    current.error = asApiError(e).message;
    // nothing happened yet (lazer was opened meanwhile, …): back to the links
    if (current.rows.every((r) => r.stage === "waiting")) current.rows = [];
    else toast(`Import stopped: ${current.error}`, { kind: "danger", timeout: 6000 });
  } finally {
    stop();
    current.running = false;
    events.emit("importing", false);
    dialog?.render();
  }
}
