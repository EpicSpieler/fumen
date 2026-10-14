/* import.ts — "Add beatmaps": sets downloaded → imported into osu!lazer by lazer's own code
   (src-tauri/src/lazer_import.rs: only tested lazer versions, only while lazer is closed) → in the
   library. The sets come from pasted osu! links, from what the player has played (osu!'s play
   counts and top plays, the scores in Performance) that lazer doesn't have, or from Browse (the
   mirrors' search), whose sets wait in a queue while another import runs. Downloads run a few at
   a time while lazer imports what's ready in batches; each set is a card moving along, like
   lazer's own download notifications. The dialog can be closed while an import runs; reopening
   it shows where it is. */
import { api, asApiError, onImportProgress, onPlayedProgress } from "../lib/api";
import { esc, num } from "../lib/format";
import { readLinks } from "../lib/links";
import { Emitter, events, refreshStatus, reloadLibrary } from "../lib/store";
import type { ImportProgress, ImportStage, ImportSummary, LazerImportStatus, OsuAccount, PlayedFound } from "../lib/types";
import { attachSegIndicator, closeAnimated, reduceMotion, toast } from "../ui/controls";
import { icon } from "../ui/icons";

type Mode = "links" | "played";
/** where an import's sets came from: a tab of the dialog, or Browse */
type From = Mode | "search";

interface Line {
  link: string;
  set?: number;
  title?: string;
}

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
  /** where the sets came from */
  from: From;
  /** Stop was pressed; the sets being imported right now still go in */
  stopping?: boolean;
  summary?: ImportSummary;
  /** why the import stopped (or never started) */
  error?: string;
}

/** finding the sets played that lazer doesn't have */
interface Played {
  state: "idle" | "finding" | "found" | "error";
  /** play counts and scores read so far */
  read: number;
  found?: PlayedFound;
  error?: string;
}

/** the last import (shown until "Add more"), or one that couldn't start */
let job: Job | null = null;
/** what's in the field, kept while the dialog is closed */
let draft = "";
let mode: Mode = "links";
let played: Played = { state: "idle", read: 0 };
let dialog: ImportDialog | null = null;
/** sets an older Fumen imported without details are being finished */
let repairing = false;
/** sets from Browse waiting for the running import to end */
let queued: Line[] = [];

/** a set's import moved along (Browse follows its sets with it) */
export const importEvents = new Emitter<{ set: number }>();
/** how each set's last import ended, this session (a queued import replaces the job before) */
const ended = new Map<number, Row>();

export type SetImport = { stage: ImportStage | "waiting" | "queued"; done: number; total: number; message?: string };

/** Where a set is in the running (or last) import, or the queue. */
export function setImportState(id: number): SetImport | null {
  if (queued.some((l) => l.set === id)) return { stage: "queued", done: 0, total: 0 };
  const r = job?.rows.find((x) => x.set === id) ?? ended.get(id);
  return r ? { stage: r.stage, done: r.done, total: r.total, message: r.message } : null;
}

/** Imports sets found in Browse: now, or after the import that's running. Sets already on their
 * way are left out. */
export function importSets(sets: { id: number; title: string }[]): "started" | "queued" | "none" {
  const busy = (id: number) => {
    const s = setImportState(id);
    return !!s && (s.stage === "queued" || (job?.running === true && !FINISHED.has(s.stage as Row["stage"])));
  };
  const lines = sets.filter((s) => !busy(s.id)).map((s) => ({ link: `https://osu.ppy.sh/beatmapsets/${s.id}`, set: s.id, title: s.title }));
  if (!lines.length) return "none";
  if (job?.running) {
    queued.push(...lines);
    lines.forEach((l) => importEvents.emit("set", l.set));
    events.emit("importing", true);
    dialog?.render();
    return "queued";
  }
  void runImport(lines, "search");
  return "started";
}

/** sets waiting in the queue, for the sidebar */
export const queuedCount = (): number => queued.length;

/** Empties the queue (the import was stopped, or couldn't go on). */
function dropQueue(): void {
  const dropped = queued;
  queued = [];
  dropped.forEach((l) => importEvents.emit("set", l.set!));
}

const FINISHED: ReadonlySet<Row["stage"]> = new Set(["done", "skipped", "error"]);
const ACTIVE: ReadonlySet<Row["stage"]> = new Set(["resolving", "downloading", "held", "ready", "importing"]);

export const isImporting = (): boolean => !!job?.running;

/** "2 of 5" while an import runs, for the sidebar */
export function importProgressText(): string | null {
  if (!job?.running) return null;
  const finished = job.rows.filter((r) => FINISHED.has(r.stage)).length;
  return `${num(finished)} of ${num(job.rows.length + queued.length)}`;
}

/** Opens the dialog; `text` (pasted links) goes into the field and starts over a finished import. */
export function openImport(text?: string): void {
  if (text && !job?.running) {
    job = null;
    mode = "links";
    draft = draft.trim() ? `${draft.trim()}\n${text.trim()}` : text.trim();
  }
  if (dialog) dialog.render(true);
  else dialog = new ImportDialog();
}

const short = (v: string) => v.replace(/-lazer$/, "");
const mb = (bytes: number) => (bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0);
const showsRows = (j: Job | null): j is Job => !!j && j.rows.length > 0;
const cover = (set: number) => `https://assets.ppy.sh/beatmaps/${set}/covers/list.jpg`;
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const words = (list: [string, string?][]) =>
  `<span class="meta-line">${list.map(([w, cls]) => `<span${cls ? ` class="${cls}"` : ""}>${esc(w)}</span>`).join("")}</span>`;

class ImportDialog {
  private readonly el: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly playedEl: HTMLElement;
  private readonly overallEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly lazerEl: HTMLElement;
  private readonly repairEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly goBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private status: LazerImportStatus | null = null;
  /** undefined: not asked yet */
  private account: OsuAccount | null | undefined = undefined;
  private poll = 0;
  /** the list of played sets on screen */
  private shownFound: PlayedFound | null = null;
  /** the rows on screen belong to this job */
  private rowsOf: Job | null = null;
  /** the player scrolled the list (following the active sets pauses for a while) */
  private userScrolled = 0;
  private followAt = 0;
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
          <div class="imp-sub"></div>
        </div>
        <div class="seg-pill imp-tabs" role="tablist" aria-label="Where the beatmaps come from">
          <button type="button" role="tab" data-mode="links">Links</button>
          <button type="button" role="tab" data-mode="played">Maps you've played</button>
        </div>
        <div class="imp-lazer"></div>
        <div class="imp-repair" hidden></div>
        <textarea class="imp-input" rows="6" spellcheck="false" autocomplete="off" aria-label="osu! links"
          placeholder="https://osu.ppy.sh/beatmapsets/…&#10;https://osu.ppy.sh/beatmaps/…"></textarea>
        <div class="imp-played" hidden></div>
        <div class="imp-overall" hidden></div>
        <div class="imp-rows" hidden></div>
        <div class="imp-foot">
          <div class="imp-note"></div>
          <div class="imp-actions">
            <button class="btn btn-ghost" type="button" data-act="close">Close</button>
            <button class="btn" type="button" data-act="stop" hidden>Stop</button>
            <button class="btn btn-primary" type="button" data-act="go">Import</button>
          </div>
        </div>
      </div>`;
    this.el = el;
    this.tabsEl = el.querySelector(".imp-tabs")!;
    this.subEl = el.querySelector(".imp-sub")!;
    this.input = el.querySelector(".imp-input")!;
    this.playedEl = el.querySelector(".imp-played")!;
    this.overallEl = el.querySelector(".imp-overall")!;
    this.rowsEl = el.querySelector(".imp-rows")!;
    this.lazerEl = el.querySelector(".imp-lazer")!;
    this.repairEl = el.querySelector(".imp-repair")!;
    this.repairEl.addEventListener("click", (e) => {
      if ((e.target as Element).closest('[data-act="repair"]')) void this.repair();
    });
    this.noteEl = el.querySelector(".imp-note")!;
    this.goBtn = el.querySelector('[data-act="go"]')!;
    this.stopBtn = el.querySelector('[data-act="stop"]')!;

    el.addEventListener("pointerdown", (e) => {
      if (e.target === el) this.close();
    });
    el.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener("click", () => this.close()));
    this.goBtn.addEventListener("click", () => this.go());
    this.stopBtn.addEventListener("click", () => void stopImport());
    this.tabsEl.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-mode]");
      if (!b || job?.running) return;
      mode = b.dataset.mode as Mode;
      if (job && !showsRows(job)) job = null;
      this.render(true);
      if (mode === "links") this.input.focus();
    });
    this.input.addEventListener("input", () => {
      draft = this.input.value;
      // editing the links clears why the last try didn't start
      if (job && !job.running && !showsRows(job)) job = null;
      this.render();
    });
    this.playedEl.addEventListener("click", (e) => {
      if ((e.target as Element).closest('[data-act="find"]')) void findPlayed();
    });
    const scrolled = () => (this.userScrolled = performance.now());
    this.rowsEl.addEventListener("wheel", scrolled, { passive: true });
    this.rowsEl.addEventListener("pointerdown", scrolled);
    document.addEventListener("keydown", this.onKey, true);
    document.body.appendChild(el);
    attachSegIndicator(this.tabsEl);

    this.render(true);
    void this.refreshStatus();
    void api
      .osuAccount()
      .then((a) => (this.account = a))
      .catch(() => (this.account = null))
      .then(() => this.render());
    this.poll = window.setInterval(() => {
      // closing lazer turns the button on without asking
      if (!job?.running) void this.refreshStatus();
    }, 3000);
    setTimeout(() => (showsRows(job) || mode === "played" ? this.goBtn : this.input).focus(), 30);
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
      this.status = { ready: false, reason: null, message: asApiError(e).message, version: null, tested: false, running: false, testedVersions: [], unfinished: 0 };
    }
    this.renderLazer();
    this.renderActions();
  }

  /** finishes the sets an older Fumen imported without their details */
  private async repair(): Promise<void> {
    if (repairing || job?.running || !this.status?.ready) return;
    repairing = true;
    this.renderLazer();
    this.renderActions();
    try {
      const r = await api.repairLazerSets();
      if (r.finished) {
        toast(`${plural(r.finished, "set")} in osu!lazer got ${r.finished === 1 ? "its" : "their"} details`, { kind: "success", timeout: 4200 });
        await reloadLibrary().catch((e) => console.warn("[import] reload failed", e));
      }
      if (r.failed) toast(`${plural(r.failed, "set")} couldn't be finished; osu!lazer does ${r.failed === 1 ? "it" : "them"} on its next start`, { timeout: 6000 });
      if (!r.finished && !r.failed) toast("Nothing to finish: osu!lazer has every set's details");
    } catch (e) {
      toast(`Couldn't finish the sets: ${asApiError(e).message}`, { kind: "danger", timeout: 6000 });
    } finally {
      repairing = false;
      void this.refreshStatus();
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────

  /** `fromDraft`: the field takes the kept text (after opening, or new links pasted) */
  render(fromDraft = false): void {
    const rows = showsRows(job);
    if (fromDraft && this.input.value !== draft) this.input.value = draft;
    this.tabsEl.hidden = rows;
    this.tabsEl.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    });
    this.subEl.textContent =
      rows && job?.from === "search"
        ? "Sets from Browse: Fumen downloads each one from the mirrors and imports it into osu!lazer, the way lazer itself does."
        : mode === "played" && !rows
          ? "Every set you've played on osu! that osu!lazer doesn't have: Fumen downloads them and imports them into lazer, the way lazer itself does."
          : "Paste links from osu.ppy.sh. Fumen downloads each set and imports it into osu!lazer, the way lazer itself does.";
    this.input.hidden = rows || mode !== "links";
    this.playedEl.hidden = rows || mode !== "played";
    this.overallEl.hidden = !rows;
    this.rowsEl.hidden = !rows;
    if (rows) {
      this.renderRows();
      this.renderOverall();
    } else {
      this.rowsOf = null;
      if (mode === "played") this.renderPlayed();
    }
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
    this.renderRepair();
    if (st.reason === "untested") {
      el.dataset.tip = st.testedVersions.length
        ? `Tested: ${st.testedVersions.map(short).join(", ")}\nImporting comes back once this version is checked.`
        : "No osu!lazer version is tested yet.";
    } else delete el.dataset.tip;
  }

  /** sets an older Fumen put into lazer without their details, and the way to finish them */
  private renderRepair(): void {
    const st = this.status;
    const el = this.repairEl;
    const n = st?.unfinished ?? 0;
    el.hidden = !st || (n === 0 && !repairing) || showsRows(job);
    if (!st || el.hidden) return;
    const off = !st.ready || !!job?.running;
    const key = `${n}|${repairing}|${off}|${st.reason}`;
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = `
      ${icon("alert", "imp-lazer-ic")}
      <span class="imp-repair-text">${
        repairing
          ? "Working out star ratings, BPM, length and ranked status…"
          : `${plural(n, "set")} imported by an older Fumen ${n === 1 ? "is" : "are"} missing ${n === 1 ? "its" : "their"} details in osu!lazer: unknown status, 0 BPM, no length.`
      }</span>
      <button class="btn btn-sm" type="button" data-act="repair" ${off || repairing ? "disabled" : ""}>${repairing ? "Finishing…" : "Finish them"}</button>`;
    const b = el.querySelector<HTMLElement>("button")!;
    if (off && !repairing) b.dataset.tip = st.reason === "running" ? "Close osu!lazer first" : (st.message ?? "Not possible right now");
  }

  /** the "Maps you've played" panel before an import */
  renderPlayed(): void {
    if (mode !== "played" || showsRows(job)) return;
    const p = this.playedEl;
    const state = this.account === null ? "login" : played.state;
    if (p.dataset.state !== state) {
      p.dataset.state = state;
      p.innerHTML = "";
      this.shownFound = null;
    }
    if (this.account === undefined) {
      p.innerHTML = `<div class="imp-pl-msg">Checking your osu! login…</div>`;
      return;
    }
    switch (state) {
      case "login":
        p.innerHTML = `<div class="imp-pl-msg">${icon("user", "imp-pl-ic")}<span>Log in to osu! in Settings first. Fumen then finds every set you've played: your play counts, top plays and the scores in Performance.</span></div>`;
        return;
      case "idle":
        p.innerHTML = `<div class="imp-pl-msg">${icon("download", "imp-pl-ic")}<span>Fumen reads your play counts and top plays (every ruleset) from osu!, adds the scores in Performance, and lists the sets osu!lazer doesn't have yet.</span></div>`;
        return;
      case "finding": {
        if (!p.querySelector(".imp-pl-finding")) {
          p.innerHTML = `<div class="imp-pl-finding"><div class="imp-pl-msg"><span>Reading your plays from osu!</span><span class="imp-pl-read"></span></div><div class="imp-bar imp-bar-sweep"><i></i></div></div>`;
        }
        p.querySelector(".imp-pl-read")!.textContent = played.read ? `${num(played.read)} read` : "";
        return;
      }
      case "error":
        p.innerHTML = `<div class="imp-pl-msg bad">${icon("alert", "imp-pl-ic")}<span>${esc(played.error ?? "Couldn't read your plays.")}</span></div>`;
        return;
      case "found": {
        const f = played.found!;
        if (this.shownFound === f) return;
        this.shownFound = f;
        const missing = f.missing;
        const inStable = missing.filter((s) => s.inStable).length;
        const top = missing.filter((s) => s.top).length;
        const meta: [string, string?][] = [[`${plural(f.played, "set")} played in all`]];
        if (top) meta.push([`${num(top)} with top plays`]);
        if (inStable) meta.push([`${num(inStable)} in osu!stable`]);
        p.innerHTML = `
          <div class="imp-pl-sum">
            <div class="imp-pl-big"><b>${num(missing.length)}</b><span>${missing.length === 1 ? "set you've played isn't" : "sets you've played aren't"} in osu!lazer${missing.length ? " yet" : ""}</span></div>
            <button class="btn btn-ghost btn-sm" type="button" data-act="find">${icon("refresh")}Check again</button>
          </div>
          <div class="imp-pl-meta">${words(meta)}</div>
          ${
            missing.length
              ? `<div class="imp-pl-list">${missing
                  .map(
                    (s, i) => `
              <div class="imp-pl-set" style="--i:${Math.min(i, 14)}">
                <div class="imp-cover"><img alt="" loading="lazy" decoding="async" src="${cover(s.id)}"></div>
                <div class="imp-pl-text">
                  <div class="imp-pl-title">${esc(s.title || `Beatmap set ${s.id}`)}</div>
                  <div class="imp-pl-by">${esc(s.artist)}${s.creator ? ` <span>· ${esc(s.creator)}</span>` : ""}</div>
                </div>
                <div class="imp-pl-plays">${s.plays ? plural(s.plays, "play") : s.top ? "Top play" : "Played"}</div>
              </div>`,
                  )
                  .join("")}</div>`
              : ""
          }`;
        wireCovers(p);
        return;
      }
    }
  }

  private renderNote(): void {
    const n = this.noteEl;
    n.className = "imp-note";
    if (job?.running) {
      n.textContent = job.stopping ? "Stopping after the sets going into osu!lazer right now…" : "You can close this; the import carries on.";
    } else if (job?.summary) {
      // the counts are at the top; here only why it ended early
      const s = job.summary;
      if (s.stopped) {
        n.classList.add("bad");
        n.textContent = s.stopped;
      } else if (s.cancelled) n.textContent = job.from === "played" ? "Stopped. What's left stays in the list of played maps." : "Stopped.";
      else if (!s.imported && !s.failed) n.textContent = "Nothing to import";
      else n.textContent = "";
    } else if (job?.error) {
      n.classList.add("bad");
      n.textContent = job.error;
    } else if (mode === "played") {
      n.textContent = played.state === "found" && played.found?.missing.length ? "The sets come from osu! download mirrors." : "";
    } else {
      const { links, unknown } = readLinks(this.input.value);
      if (!links.length && !unknown.length) n.textContent = "Set or beatmap links, osu:// links or set IDs";
      else {
        const list: [string, string?][] = [[links.length ? plural(links.length, "link") : "No links"]];
        if (unknown.length) list.push([`${num(unknown.length)} ${unknown.length === 1 ? "line isn't" : "lines aren't"} an osu! link`, "warn"]);
        n.innerHTML = words(list);
      }
    }
  }

  private renderActions(): void {
    const b = this.goBtn;
    const running = !!job?.running;
    // a running import goes on with the window closed; the sidebar shows how far (and opens it again)
    const close = this.el.querySelector<HTMLElement>('.imp-actions [data-act="close"]')!;
    close.textContent = running ? "Minimize" : "Close";
    if (running) close.dataset.tip = "It keeps going; the sidebar shows how far";
    else delete close.dataset.tip;
    this.stopBtn.hidden = !running;
    this.stopBtn.disabled = !!job?.stopping;
    this.stopBtn.textContent = job?.stopping ? "Stopping…" : "Stop";
    if (running) {
      b.disabled = true;
      b.textContent = "Importing…";
    } else if (repairing) {
      b.disabled = true;
    } else if (showsRows(job)) {
      b.disabled = false;
      b.textContent = job.from === "played" ? "Back to played maps" : job.summary?.failed ? "Try failed again" : "Add more";
    } else if (mode === "played") {
      const missing = played.found?.missing.length ?? 0;
      if (played.state === "found" && missing) {
        b.textContent = `Download and import ${plural(missing, "set")}`;
        b.disabled = !this.status?.ready;
      } else {
        b.textContent = played.state === "finding" ? "Finding…" : played.state === "found" ? "Check again" : "Find played maps";
        b.disabled = played.state === "finding" || !this.account;
      }
    } else {
      b.textContent = "Import";
      b.disabled = !this.status?.ready || readLinks(this.input.value).links.length === 0;
    }
  }

  /** the job's sets, counted up, and a bar for all of them */
  private renderOverall(): void {
    if (!job) return;
    const rows = job.rows;
    const count = (stages: Row["stage"][]) => rows.filter((r) => stages.includes(r.stage)).length;
    const done = count(["done"]);
    const failed = count(["error"]);
    const finished = rows.filter((r) => FINISHED.has(r.stage)).length;
    const el = this.overallEl;
    if (!el.firstChild) {
      el.innerHTML = `
        <div class="imp-ov-top"><span class="imp-ov-count"></span><span class="imp-ov-meta"></span></div>
        <div class="imp-ov-bar"><i class="ok"></i><i class="bad"></i><i class="other"></i></div>`;
    }
    const total = rows.length || 1;
    el.querySelector(".imp-ov-count")!.innerHTML = job.running
      ? `<b>${num(finished)}</b> of ${num(rows.length)}`
      : `<b>${num(done)}</b> ${done === 1 ? "set" : "sets"} imported`;
    const meta: [string, string?][] = [];
    if (job.running) {
      const dl = count(["downloading", "resolving"]);
      const held = count(["held"]);
      const ready = count(["ready"]);
      const importing = count(["importing"]);
      if (queued.length) meta.push([`${num(queued.length)} queued after these`]);
      if (dl) meta.push([`${num(dl)} downloading`]);
      if (held) meta.push([`${num(held)} waiting for a mirror`]);
      if (ready) meta.push([`${num(ready)} ready`]);
      if (importing) meta.push([`${num(importing)} going into osu!lazer`]);
      if (failed) meta.push([`${num(failed)} failed`, "bad"]);
    } else {
      if (failed) meta.push([`${num(failed)} failed`, "bad"]);
      const left = rows.filter((r) => r.stage === "skipped" && r.message === "Cancelled").length;
      const skipped = count(["skipped"]) - left;
      if (skipped) meta.push([`${num(skipped)} skipped`]);
      if (left) meta.push([`${num(left)} left out`]);
    }
    el.querySelector(".imp-ov-meta")!.innerHTML = words(meta);
    const bar = el.querySelector<HTMLElement>(".imp-ov-bar")!;
    bar.style.setProperty("--ok", String(done / total));
    bar.style.setProperty("--bad", String(failed / total));
    bar.style.setProperty("--other", String((finished - done - failed) / total));
  }

  private renderRows(): void {
    if (!job) return;
    if (this.rowsOf !== job || this.rowsEl.children.length !== job.rows.length) {
      // a new import comes in card by card; reopening shows it as it is
      this.rowsEl.classList.toggle("fresh", job.running && job.rows.every((r) => r.stage === "waiting"));
      this.rowsEl.innerHTML = job.rows
        .map(
          (_, i) => `
          <div class="imp-row" style="--i:${Math.min(i, 14)}">
            <div class="imp-cover"></div>
            <div class="imp-row-main"><div class="imp-row-title"></div><div class="imp-row-state"></div></div>
            <div class="imp-row-end"></div>
            <div class="imp-bar"><i></i></div>
          </div>`,
        )
        .join("");
      this.rowsOf = job;
      this.rowsEl.scrollTop = 0;
    }
    job.rows.forEach((_, i) => this.renderRow(i));
  }

  /** `live`: the row just moved on (its change animates) */
  renderRow(i: number, live = false): void {
    const r = job?.rows[i];
    const el = this.rowsEl.children[i] as HTMLElement | undefined;
    if (!r || !el) return;
    const changed = el.dataset.stage !== r.stage;
    el.dataset.stage = r.stage;
    if (live && changed) el.classList.add("live");
    el.querySelector(".imp-row-title")!.textContent = r.title ?? (r.set ? `Beatmap set ${r.set}` : r.link.replace(/^https?:\/\/(www\.)?osu\.ppy\.sh/i, ""));
    const state = el.querySelector<HTMLElement>(".imp-row-state")!;
    state.textContent = stateText(r);
    // long reasons don't fit the card
    if (r.stage === "error" && r.message) state.dataset.tip = r.message;
    else delete state.dataset.tip;
    const art = el.querySelector<HTMLElement>(".imp-cover")!;
    if (r.set && art.dataset.set !== String(r.set)) {
      art.dataset.set = String(r.set);
      art.classList.remove("img-missing");
      art.innerHTML = `<img alt="" loading="lazy" decoding="async" src="${cover(r.set)}">`;
      wireCovers(art);
    }
    if (changed) {
      const end = el.querySelector<HTMLElement>(".imp-row-end")!;
      end.innerHTML = r.stage === "done" ? icon("check") : r.stage === "error" ? icon("alert") : "";
    }
    const bar = el.querySelector<HTMLElement>(".imp-bar")!;
    const p = r.stage === "downloading" ? (r.total ? Math.min(1, r.done / r.total) : 0.04) : r.stage === "waiting" || r.stage === "resolving" || r.stage === "held" ? 0 : 1;
    bar.style.setProperty("--p", String(p));
    if (live && changed && ACTIVE.has(r.stage)) this.follow();
  }

  /** a progress event came in: the counts at the top move along */
  progressed(): void {
    this.renderOverall();
  }

  /** keeps the sets on their way in view, unless the player is looking around */
  private follow(): void {
    const now = performance.now();
    if (!job || now - this.userScrolled < 4000 || now - this.followAt < 350) return;
    const first = job.rows.findIndex((r) => ACTIVE.has(r.stage));
    const el = this.rowsEl.children[first] as HTMLElement | undefined;
    if (!el) return;
    const list = this.rowsEl;
    const top = el.offsetTop - list.offsetTop;
    if (top >= list.scrollTop && top + el.offsetHeight <= list.scrollTop + list.clientHeight * 0.6) return;
    this.followAt = now;
    // far behind (the dialog was closed a while): straight there
    const far = Math.abs(top - list.scrollTop) > list.clientHeight * 2;
    list.scrollTo({ top: Math.max(0, top - 6), behavior: reduceMotion() || far ? "auto" : "smooth" });
  }

  // ── importing ─────────────────────────────────────────────────────────

  private go(): void {
    if (job?.running) return;
    if (showsRows(job)) {
      // "Add more" / "Try failed again": the failed sets go into the field; played maps go back
      // to their list (what failed or was left out is still in it)
      if (job.from !== "played") draft = job.rows.filter((r) => r.stage === "error").map((r) => r.link).join("\n");
      mode = job.from === "played" ? "played" : "links";
      job = null;
      this.render(true);
      if (mode === "links") this.input.focus();
      return;
    }
    if (mode === "played") {
      const missing = played.found?.missing ?? [];
      if (played.state === "found" && missing.length) {
        if (this.status?.ready) void runImport(missing.map((s) => ({ link: String(s.id), set: s.id, title: `${s.artist} - ${s.title}` })), "played");
      } else if (played.state !== "finding" && this.account) void findPlayed();
      return;
    }
    const { links } = readLinks(this.input.value);
    if (links.length && this.status?.ready) void runImport(links.map((link) => ({ link })), "links");
  }
}

/** covers that don't load turn into the placeholder */
function wireCovers(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>(".imp-cover img").forEach((img) => {
    const art = img.parentElement!;
    const failed = () => {
      art.classList.add("img-missing");
      img.remove();
    };
    if (img.complete && img.src) {
      if (img.naturalWidth) art.classList.add("loaded");
      else failed();
    } else {
      img.addEventListener("error", failed, { once: true });
      img.addEventListener("load", () => art.classList.add("loaded"), { once: true });
    }
  });
}

function stateText(r: Row): string {
  switch (r.stage) {
    case "waiting":
      return "Waiting";
    case "resolving":
      return "Finding its set";
    case "downloading":
      return r.total ? `Downloading · ${mb(r.done)} of ${mb(r.total)} MB` : r.done ? `Downloading · ${mb(r.done)} MB` : "Downloading";
    case "held":
      return r.total > 2 ? `Mirrors are busy · trying again in ${clock(r.total)}` : "Waiting for a free mirror";
    case "ready":
      return "Downloaded · waiting for osu!lazer";
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

/** "45 s", "3:20" */
function clock(seconds: number): string {
  const s = Math.ceil(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function findPlayed(): Promise<void> {
  if (played.state === "finding") return;
  played = { state: "finding", read: 0 };
  dialog?.render();
  const stop = await onPlayedProgress((n) => {
    played.read = n;
    dialog?.renderPlayed();
  });
  try {
    const found = await api.findPlayedSets();
    played = { state: "found", read: found.read, found };
  } catch (e) {
    played = { state: "error", read: 0, error: asApiError(e).message };
  } finally {
    stop();
    dialog?.render();
  }
}

async function stopImport(): Promise<void> {
  if (!job?.running || job.stopping) return;
  job.stopping = true;
  dropQueue();
  dialog?.render();
  try {
    await api.cancelImport();
  } catch (e) {
    console.warn("[import] stop failed", e);
  }
}

async function runImport(lines: Line[], from: From): Promise<void> {
  const links = lines.map((l) => l.link);
  const current: Job = { rows: lines.map((l) => ({ ...l, stage: "waiting", done: 0, total: 0 })), running: true, from };
  job = current;
  events.emit("importing", true);
  for (const r of current.rows) if (r.set) importEvents.emit("set", r.set);
  dialog?.render();
  let lastBusy = 0;
  const stop = await onImportProgress((p: ImportProgress) => {
    const r = current.rows[p.index];
    if (!r) return;
    r.stage = p.stage;
    r.set = p.set ?? r.set;
    r.title = p.title ?? r.title;
    r.done = p.done;
    r.total = p.total;
    r.message = p.message ?? undefined;
    if (r.set) importEvents.emit("set", r.set);
    if (job === current) {
      dialog?.renderRow(p.index, true);
      dialog?.progressed();
    }
    // the sidebar's "2 of 5", not on every downloaded chunk
    const now = performance.now();
    if (p.stage !== "downloading" && now - lastBusy > 250) {
      lastBusy = now;
      events.emit("importing", true);
    }
  });
  try {
    const s = await api.importBeatmaps(links);
    current.summary = s;
    if (from === "links") draft = "";
    // what went in isn't missing any more
    if (from === "played" && played.found) {
      const imported = new Set(current.rows.filter((r) => r.stage === "done" || (r.stage === "skipped" && r.message !== "Cancelled")).map((r) => r.set));
      played.found = { ...played.found, missing: played.found.missing.filter((m) => !imported.has(m.id)) };
    }
    if (s.stopped) toast(`Import stopped: ${s.stopped}`, { kind: "danger", timeout: 6000 });
    else if (s.imported || s.failed) {
      const parts = [s.imported && `${plural(s.imported, "set")} imported into osu!lazer`, s.failed && `${num(s.failed)} failed`];
      toast(parts.filter(Boolean).join(", "), { kind: s.imported ? "success" : "danger", timeout: 4200 });
    }
    if (s.imported) {
      await reloadLibrary().catch((e) => console.warn("[import] reload failed", e));
      await refreshStatus().catch(() => {});
    }
  } catch (e) {
    current.error = asApiError(e).message;
    // nothing happened yet (lazer was opened meanwhile, …): back to where the sets came from
    if (current.rows.every((r) => r.stage === "waiting")) current.rows = [];
    else toast(`Import stopped: ${current.error}`, { kind: "danger", timeout: 6000 });
  } finally {
    stop();
    current.running = false;
    current.stopping = false;
    // a failed import can't go on with the queue (osu!lazer was opened, …)
    if (current.error || current.summary?.stopped) dropQueue();
    for (const r of current.rows) {
      if (!r.set) continue;
      if (FINISHED.has(r.stage)) ended.set(r.set, { ...r });
      importEvents.emit("set", r.set);
    }
    if (queued.length) {
      const next = queued;
      queued = [];
      void runImport(next, "search");
    } else {
      events.emit("importing", false);
      dialog?.render();
    }
  }
}
