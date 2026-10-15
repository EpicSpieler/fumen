/* care.ts — library care: what the library takes on disk and where it goes (by kind of file,
 * ruleset or status), and the sets worth a look: never played, the biggest, not played in a year.
 *
 * Sizes come from src-tauri/src/care.rs (lazer's files by their hash, stable's folders); whether
 * and when a set was played from the snapshot (lazer's last played, the merged scores). Fumen
 * only points things out here.
 */
import { api, asApiError, onCareProgress, thumbUrl } from "../lib/api";
import { bytes, displayArtist, displayTitle, esc, MODE_SHORT, num, relativeTime, statusLabel } from "../lib/format";
import { events, store } from "../lib/store";
import type { CareReport } from "../lib/types";
import { attachSegIndicator, openMenu } from "../ui/controls";
import { icon } from "../ui/icons";
import { openSet } from "./actions";

/** rows per "Show more" */
const PAGE = 50;
const YEAR = 365 * 86_400_000;
const KIND_NAMES = ["Songs", "Videos", "Images", "Hitsounds", "Other"];
const KIND_TIPS = [
  "The audio the difficulties play",
  "Background videos",
  "Backgrounds and storyboard images",
  "Hitsounds and storyboard sounds",
  "Charts, storyboard scripts and anything else",
];
/** "Mixed": a set with difficulties of more than one ruleset */
const RULESET_NAMES = [...MODE_SHORT, "Mixed"];
/** the breakdown's colours, in order */
const COLOURS = ["var(--accent)", "var(--info)", "var(--success)", "var(--warning)", "var(--t3)", "var(--t4)"];

type Group = "kind" | "ruleset" | "status";
type Tab = "never" | "biggest" | "stale";

/** A set as library care sees it. */
interface Entry {
  /** index into Snapshot.sets */
  set: number;
  size: number;
  kinds: number[];
  /** 0–3, 4 for mixed */
  ruleset: number;
  /** last played (0: never) */
  played: number;
  stable: boolean;
}

let cached: CareReport | null = null;

export class CareView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  private group: Group = "kind";
  private tab: Tab = "never";
  private shownRows = PAGE;
  private entries: Entry[] = [];
  private rows: Entry[] = [];
  private failed: string | null = null;
  private progress: { done: number; total: number } | null = null;
  private loading = false;

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view care-view";
    this.el.innerHTML = `
      <header class="view-head care-head">
        <div class="care-head-text">
          <h1 class="view-title">Library care</h1>
          <div class="view-sub care-sub meta-line num"></div>
        </div>
        <button class="btn btn-ghost btn-sm care-refresh" type="button">${icon("refresh")}<span>Measure again</span></button>
      </header>
      <div class="care-body"></div>`;
    this.bind();
    this.offs.push(
      events.on("library", () => void this.load(true)),
      events.on("prefs", (p) => {
        if ("unicode" in p) this.renderList();
      }),
    );
    void this.load(false);
  }

  /** The sizes (measured once a session, again after a library update or when asked). */
  private async load(again: boolean): Promise<void> {
    if (this.loading) return;
    if (cached && !again) return this.build(cached);
    this.loading = true;
    this.failed = null;
    this.progress = null;
    this.render();
    const off = await onCareProgress((p) => {
      this.progress = p;
      this.renderLoading();
    });
    try {
      cached = await api.libraryCare();
    } catch (e) {
      this.failed = asApiError(e).message;
    } finally {
      off();
      this.loading = false;
    }
    if (cached && !this.failed) this.build(cached);
    else this.render();
  }

  private build(report: CareReport): void {
    const snap = store.snap;
    this.entries = [];
    if (snap) {
      const byId = new Map(snap.sets.map((s, i) => [s.id, i]));
      for (const c of report.sets) {
        const i = byId.get(c.id);
        if (i === undefined) continue;
        const set = snap.sets[i];
        const modes = new Set<number>();
        let played = 0;
        for (const m of set.maps) {
          const map = snap.maps[m];
          if (map.mode >= 0) modes.add(map.mode);
          played = Math.max(played, map.played ?? 0, map.best?.last ?? 0, map.best?.plays ? 1 : 0);
        }
        this.entries.push({ set: i, size: c.size, kinds: c.kinds, ruleset: modes.size === 1 ? [...modes][0] : 4, played, stable: set.from === "stable" });
      }
    }
    this.entries.sort((a, b) => b.size - a.size);
    this.render();
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private render(): void {
    const body = this.el.querySelector<HTMLElement>(".care-body")!;
    const sub = this.el.querySelector<HTMLElement>(".care-sub")!;
    this.el.querySelector<HTMLButtonElement>(".care-refresh")!.disabled = this.loading;
    if (this.failed) {
      sub.textContent = "";
      body.innerHTML = `<div class="empty-state">${icon("alert")}<div class="empty-title">Couldn't measure the library</div><div class="empty-sub">${esc(this.failed)}</div></div>`;
      return;
    }
    if (this.loading || !cached) {
      sub.textContent = "";
      body.innerHTML = `
        <div class="care-loading">
          <div class="care-progress meta-line num"></div>
          <div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:170px"></div><div class="skeleton" style="height:280px"></div>
        </div>`;
      this.renderLoading();
      return;
    }
    const e = this.entries;
    const total = e.reduce((s, x) => s + x.size, 0);
    const lazer = cached.lazerSize;
    const stable = cached.stableSize;
    sub.innerHTML = [`${num(e.length)} ${e.length === 1 ? "set" : "sets"}`, lazer ? `${bytes(lazer)} in osu!lazer` : "", stable ? `${bytes(stable)} in osu!stable` : ""]
      .filter(Boolean)
      .map((w) => `<span>${w}</span>`)
      .join("");
    if (!e.length) {
      body.innerHTML = `<div class="empty-state care-empty">${icon("folder")}<div class="empty-title">Nothing to measure yet</div><div class="empty-sub">Library care looks at your sets once the library has been read.</div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="hist-tiles care-tiles">${this.tiles(total)}</div>
      <section class="panel care-split">
        <div class="panel-head">
          <div class="label-caps">Where it goes</div>
          <div class="seg-pill care-groups" role="tablist" aria-label="Split by">
            <button type="button" data-group="kind">Files</button>
            <button type="button" data-group="ruleset">Ruleset</button>
            <button type="button" data-group="status">Status</button>
          </div>
        </div>
        <div class="care-split-body"></div>
      </section>
      <section class="section care-lists">
        <div class="seg-tabs care-tabs" role="tablist" aria-label="Sets">
          <button type="button" data-tab="never">Never played</button>
          <button type="button" data-tab="biggest">Biggest</button>
          <button type="button" data-tab="stale">Not played in a year</button>
        </div>
        <div class="care-note"></div>
        <div class="care-list"></div>
      </section>`;
    attachSegIndicator(body.querySelector(".care-groups")!);
    attachSegIndicator(body.querySelector(".care-tabs")!);
    this.renderSplit();
    this.renderList();
  }

  private renderLoading(): void {
    const el = this.el.querySelector<HTMLElement>(".care-progress");
    if (!el) return;
    const p = this.progress;
    el.textContent = p && p.total > 0 ? `Measuring files · ${num(p.done)} of ${num(p.total)}` : "Measuring the library";
  }

  /** `total`: the sets' sizes added up (a file two sets share counts for both) */
  private tiles(total: number): string {
    const e = this.entries;
    const now = Date.now();
    const never = e.filter((x) => !x.played);
    const stale = e.filter((x) => x.played > 1 && now - x.played > YEAR);
    const videos = e.filter((x) => x.kinds[1] > 0);
    const sum = (list: Entry[], f: (x: Entry) => number = (x) => x.size) => list.reduce((s, x) => s + f(x), 0);
    const share = (v: number) => (total ? `${Math.round((v / total) * 100)}% of it` : "");
    return [
      // a file two sets share is on disk once
      tile("On disk", bytes(cached!.lazerSize + cached!.stableSize), `${num(e.length)} sets`),
      tile("Never played", bytes(sum(never)), `${num(never.length)} sets · ${share(sum(never))}`),
      tile("Videos", bytes(sum(videos, (x) => x.kinds[1])), `in ${num(videos.length)} sets · ${share(sum(videos, (x) => x.kinds[1]))}`),
      tile("Not played in a year", bytes(sum(stale)), `${num(stale.length)} sets`),
    ].join("");
  }

  /** The stacked bar and its legend, split the chosen way. */
  private renderSplit(): void {
    const el = this.el.querySelector<HTMLElement>(".care-split-body");
    if (!el) return;
    this.el.querySelectorAll<HTMLElement>(".care-groups button").forEach((b) => b.classList.toggle("active", b.dataset.group === this.group));
    const snap = store.snap!;
    const parts = new Map<string, { size: number; sets: number; tip: string }>();
    const add = (name: string, size: number, tip = "") => {
      if (size <= 0) return;
      const p = parts.get(name) ?? { size: 0, sets: 0, tip };
      p.size += size;
      p.sets++;
      parts.set(name, p);
    };
    for (const x of this.entries) {
      if (this.group === "kind") x.kinds.forEach((v, k) => add(KIND_NAMES[k], v, KIND_TIPS[k]));
      else if (this.group === "ruleset") add(RULESET_NAMES[x.ruleset], x.size);
      else add(statusLabel(snap.sets[x.set].status), x.size);
    }
    // files in their own order; the rest biggest first
    let list = [...parts.entries()];
    if (this.group === "kind") list.sort((a, b) => KIND_NAMES.indexOf(a[0]) - KIND_NAMES.indexOf(b[0]));
    else if (this.group === "ruleset") list.sort((a, b) => RULESET_NAMES.indexOf(a[0]) - RULESET_NAMES.indexOf(b[0]));
    else {
      list.sort((a, b) => b[1].size - a[1].size);
      // the long tail in one
      if (list.length > 6) {
        const rest = list.slice(5);
        list = [...list.slice(0, 5), ["Other statuses", { size: rest.reduce((s, [, p]) => s + p.size, 0), sets: rest.reduce((s, [, p]) => s + p.sets, 0), tip: rest.map(([n]) => n).join(", ") }]];
      }
    }
    const total = list.reduce((s, [, p]) => s + p.size, 0) || 1;
    const setWord = this.group === "kind" ? "with them" : "";
    el.innerHTML = `
      <div class="care-bar">${list
        .map(([name, p], i) => `<i style="flex-grow:${p.size};background:${COLOURS[i % COLOURS.length]}" data-tip="${esc(name)} · ${bytes(p.size)}"></i>`)
        .join("")}</div>
      <div class="care-legend">${list
        .map(
          ([name, p], i) => `
          <div class="care-leg"${p.tip ? ` data-tip="${esc(p.tip)}"` : ""}>
            <i style="background:${COLOURS[i % COLOURS.length]}"></i>
            <span class="care-leg-name">${esc(name)}</span>
            <b class="num">${bytes(p.size)}</b>
            <span class="care-leg-sub num">${percent(p.size / total)} · ${num(p.sets)} ${p.sets === 1 ? "set" : "sets"}${setWord ? ` ${setWord}` : ""}</span>
          </div>`,
        )
        .join("")}</div>`;
  }

  private renderList(): void {
    const list = this.el.querySelector<HTMLElement>(".care-list");
    const note = this.el.querySelector<HTMLElement>(".care-note");
    if (!list || !note) return;
    this.el.querySelectorAll<HTMLElement>(".care-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === this.tab));
    const now = Date.now();
    this.rows =
      this.tab === "never"
        ? this.entries.filter((x) => !x.played)
        : this.tab === "stale"
          ? this.entries.filter((x) => x.played > 1 && now - x.played > YEAR)
          : this.entries;
    const size = this.rows.reduce((s, x) => s + x.size, 0);
    note.textContent = this.rows.length
      ? this.tab === "never"
        ? `${num(this.rows.length)} sets you've never played take ${bytes(size)}. Biggest first.`
        : this.tab === "stale"
          ? `${num(this.rows.length)} sets you last played over a year ago take ${bytes(size)}. Biggest first.`
          : "Every set, biggest first."
      : "";
    if (!this.rows.length) {
      list.innerHTML = `<div class="care-none">${this.tab === "never" ? "You've played every set in your library." : "Nothing here."}</div>`;
      return;
    }
    const shown = this.rows.slice(0, this.shownRows);
    const left = this.rows.length - shown.length;
    list.innerHTML = shown.map((x, i) => this.row(x, i)).join("") + (left > 0 ? `<button class="btn btn-ghost btn-sm hist-more care-more" type="button">Show ${num(Math.min(PAGE, left))} more</button>` : "");
  }

  private row(x: Entry, i: number): string {
    const snap = store.snap!;
    const set = snap.sets[x.set];
    const unicode = store.prefs.unicode;
    const diffs = set.maps.length;
    const sub = [RULESET_NAMES[x.ruleset], `${num(diffs)} ${diffs === 1 ? "difficulty" : "difficulties"}`, displayArtist(set, unicode), x.stable ? "osu!stable" : ""].filter(Boolean).map(esc).join(" · ");
    const when = x.played > 1 ? `played ${relativeTime(x.played)}` : set.added ? `added ${relativeTime(set.added)}` : "";
    const video = x.kinds[1];
    return `
      <div class="crow" data-i="${i}" role="button" tabindex="0">
        <span class="t-art${set.bg ? "" : " img-missing"}">${set.bg ? `<img src="${thumbUrl(set.bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
        <div class="prow-text"><div class="t-title">${esc(displayTitle(set, unicode))}</div><div class="t-sub">${sub}</div></div>
        <span class="crow-video num">${video ? `<span data-tip="The background video">${icon("play")}${bytes(video)}</span>` : ""}</span>
        <b class="crow-size num">${bytes(x.size)}</b>
        <span class="crow-when">${when}</span>
      </div>`;
  }

  // ── actions ───────────────────────────────────────────────────────────

  private open(i: number): void {
    const x = this.rows[i];
    if (x) openSet(x.set);
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest(".care-refresh")) return void this.load(true);
      const group = t.closest<HTMLElement>(".care-groups [data-group]");
      if (group) {
        this.group = group.dataset.group as Group;
        return this.renderSplit();
      }
      const tab = t.closest<HTMLElement>(".care-tabs [data-tab]");
      if (tab) {
        if (this.tab === tab.dataset.tab) return;
        this.tab = tab.dataset.tab as Tab;
        this.shownRows = PAGE;
        return this.renderList();
      }
      if (t.closest(".care-more")) {
        this.shownRows += PAGE;
        return this.renderList();
      }
      const row = t.closest<HTMLElement>(".crow[data-i]");
      if (row) this.open(+row.dataset.i!);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".crow[data-i]");
      if (!row) return;
      e.preventDefault();
      const i = +row.dataset.i!;
      openMenu({ x: e.clientX, y: e.clientY }, [{ label: "Open beatmap set", icon: "library", action: () => this.open(i) }]);
    });
    this.el.addEventListener("keydown", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".crow[data-i]");
      if (row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.open(+row.dataset.i!);
      }
    });
    this.el.addEventListener(
      "load",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName === "IMG") img.classList.add("loaded");
      },
      true,
    );
    this.el.addEventListener(
      "error",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName !== "IMG") return;
        img.parentElement?.classList.add("img-missing");
        img.remove();
      },
      true,
    );
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}

/** A share as a whole percentage (under 1: "<1%"). */
const percent = (v: number): string => (v > 0 && v < 0.005 ? "<1%" : `${Math.round(v * 100)}%`);

function tile(k: string, v: string, sub: string): string {
  return `<div class="panel hist-tile"><span class="tile-k">${k}</span><b class="tile-v num">${v}</b><span class="tile-s">${sub}</span></div>`;
}
