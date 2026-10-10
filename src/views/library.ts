/* library.ts — the library browser: search, filters, sort, cover grid and set list.
 *
 * One component, two uses: the main Library (persistent, keeps scroll position while you visit a
 * set) and collection pages (restricted to the collection's difficulties).
 *
 * The list shows one row per beatmap set; clicking a set opens its matching difficulties right
 * under it, and a difficulty opens the set page on that difficulty.
 */
import { thumbUrl } from "../lib/api";
import {
  bpm, date, displayArtist, displayTitle, duration, esc, holdRatio, keysOrMode, modeLabel, num, patternWords, rankInfo,
  relativeTime, srChip, srColor, stars,
} from "../lib/format";
import {
  DEFAULT_FILTER, filterLibrary, parseQuery, sortSets, type FilterResult, type FilterState, type SetResult, type SetSort,
} from "../lib/search";
import { events, setPrefs, store } from "../lib/store";
import type { LibraryLayout, MapRow } from "../lib/types";
import { player } from "../player";
import { attachSegIndicator, createSelect, openMenu, reduceMotion, updateRange, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { VirtualList } from "../ui/virtual";
import { openSet, setMenu } from "./actions";

const SET_SORTS: { value: SetSort; label: string }[] = [
  { value: "added", label: "Date added" },
  { value: "title", label: "Title" },
  { value: "artist", label: "Artist" },
  { value: "creator", label: "Mapper" },
  { value: "sr", label: "Star rating" },
  { value: "bpm", label: "BPM" },
  { value: "length", label: "Length" },
  { value: "ranked", label: "Ranked date" },
  { value: "played", label: "Last played" },
  { value: "peak", label: "Peak density" },
];

/** Sorts where "descending" is the natural first click. */
const DESC_FIRST = new Set<string>(["added", "sr", "bpm", "length", "ranked", "played", "od", "hp", "objects", "ln", "nps", "grade", "peak"]);

/** The list's date column follows the sort: when sorting by a date, it shows that date. */
const DATE_COLUMN: Partial<Record<SetSort, string>> = { added: "Added", played: "Played", ranked: "Ranked" };

interface Column {
  key: SetSort | "date" | null;
  label: string;
  cls: string;
  tip?: string;
}
const LIST_COLUMNS: Column[] = [
  { key: null, label: "", cls: "l-chev" },
  { key: null, label: "", cls: "l-art" },
  { key: "title", label: "Title", cls: "l-title" },
  { key: "creator", label: "Mapper", cls: "l-creator hide-1" },
  { key: null, label: "Difficulties", cls: "l-diffs" },
  { key: "sr", label: "Stars", cls: "l-sr" },
  { key: "bpm", label: "BPM", cls: "l-num" },
  { key: "length", label: "Length", cls: "l-num" },
  { key: "date", label: "Added", cls: "l-date hide-2" },
  { key: null, label: "Best", cls: "l-best" },
  { key: null, label: "", cls: "l-open" },
];

/** List row heights: set row, difficulty row, and the gap after an open set's last difficulty. */
const SET_H = 58;
const MAP_H = 40;
const GROUP_GAP = 8;

/** A row of the list: a set, or one of its difficulties while the set is open. */
type Line = { kind: "set"; r: SetResult } | { kind: "map"; set: number; map: number; last: boolean; n: number };

const MODES = [
  { mode: -1, label: "All" },
  { mode: 0, label: "osu!" },
  { mode: 1, label: "taiko" },
  { mode: 2, label: "catch" },
  { mode: 3, label: "mania" },
];
const KEY_COUNTS = [4, 5, 6, 7, 8, 9, 10];

const STATUS_FILTERS = [
  { label: "Ranked", values: [1] },
  { label: "Approved", values: [2] },
  { label: "Qualified", values: [3] },
  { label: "Loved", values: [4] },
  { label: "Pending / WIP", values: [0, -1] },
  { label: "Graveyard", values: [-2] },
  { label: "Local", values: [-3, -4] },
];

export interface LibraryOptions {
  title: string;
  /** collection page: only these difficulties */
  restrict?: () => Set<number> | undefined;
  subtitle?: () => string;
  /** collection pages don't write the global layout/sort prefs */
  persistent?: boolean;
  emptyHint?: string;
  /** the view changed its query itself (reset, "more by this mapper") */
  onQuery?: (q: string) => void;
}

export class LibraryView {
  readonly el: HTMLElement;
  private filter: FilterState;
  private result: FilterResult = { sets: [], mapCount: 0 };
  private lines: Line[] = [];
  /** sets opened in the list (set indices) */
  private open = new Set<number>();
  /** the set being opened right now: its difficulty rows animate in */
  private opening = -1;
  private layout: LibraryLayout = store.prefs.layout;
  private setSort = store.prefs.sort as SetSort;
  private setDesc = store.prefs.sortDesc;
  private cols = 4;
  private cardW = 240;
  private list: VirtualList;
  private body: HTMLElement;
  private offs: (() => void)[] = [];

  constructor(private o: LibraryOptions) {
    this.filter = {
      ...DEFAULT_FILTER,
      mode: o.persistent ? store.prefs.mode : -1,
      keys: o.persistent ? [...store.prefs.keys] : [],
    };
    if (!o.persistent) {
      this.layout = "list";
      this.setSort = "added";
    }

    const el = document.createElement("section");
    el.className = "view lib-view";
    el.innerHTML = `
      <header class="lib-head">
        <div class="lib-head-text">
          <h1 class="view-title"></h1>
          <div class="view-sub lib-count num"></div>
        </div>
        <div class="lib-head-tools">
          <span class="lib-sort-host"></span>
          <button class="icon-btn lib-sort-dir" type="button" aria-label="Sort direction"></button>
          <div class="seg-pill lib-layout" role="tablist" aria-label="Layout">
            <button type="button" data-layout="grid" data-tip="Covers" aria-label="Covers">${icon("grid")}</button>
            <button type="button" data-layout="list" data-tip="List" aria-label="List">${icon("rows")}</button>
          </div>
        </div>
      </header>
      <div class="lib-toolbar">
        <div class="seg-pill lib-modes" role="tablist" aria-label="Ruleset">
          ${MODES.map((m) => `<button type="button" data-mode="${m.mode}">${m.label}</button>`).join("")}
        </div>
        <div class="lib-keys" role="group" aria-label="Keys">
          ${KEY_COUNTS.map((k) => `<button type="button" data-keys="${k}">${k}K</button>`).join("")}
        </div>
        <span class="lib-toolbar-gap"></span>
        <button class="btn btn-ghost lib-filters-btn" type="button">${icon("sliders")}<span>Filters</span></button>
      </div>
      <div class="lib-active" hidden></div>
      <div class="lib-list-head" hidden></div>
      <div class="lib-body"></div>
      <div class="empty-state lib-empty" hidden></div>`;
    this.el = el;
    el.querySelector(".view-title")!.textContent = o.title;

    this.body = el.querySelector(".lib-body")!;

    // sort select
    const sortSel = createSelect(SET_SORTS, this.setSort, (v) => this.setSortKey(v), { prefix: "Sort", tip: "Sort sets by" });
    sortSel.el.classList.add("lib-sort");
    el.querySelector(".lib-sort-host")!.replaceWith(sortSel.el);
    this.syncSortUi = () => {
      sortSel.value = this.setSort;
      const dirBtn = el.querySelector<HTMLButtonElement>(".lib-sort-dir")!;
      dirBtn.innerHTML = icon(this.setDesc ? "arrow-down" : "arrow-up");
      dirBtn.dataset.tip = this.setDesc ? "Descending" : "Ascending";
    };

    this.list = new VirtualList({
      scroller: el,
      body: this.body,
      count: () => this.rowCount(),
      heightOf: (i) => this.rowHeight(i),
      keyOf: (i) => this.rowKey(i),
      renderRow: (i, row) => this.renderRow(i, row),
      rowClass: "vrow",
      overscanPx: 700,
    });

    this.bind();
    attachSegIndicator(el.querySelector(".lib-modes")!);
    attachSegIndicator(el.querySelector(".lib-layout")!);
    this.syncControls();
    this.offs.push(
      events.on("library", () => this.run()),
      events.on("prefs", (p) => {
        if ("unicode" in p) this.list.refresh();
      }),
      player.bus.on("track", () => this.syncPlaying()),
      player.bus.on("state", () => this.syncPlaying()),
    );
    new ResizeObserver(() => this.measure()).observe(el);
    this.run();
  }

  private syncSortUi: () => void;

  // ── data ──────────────────────────────────────────────────────────────

  /** Re-filters and re-renders. Keeps the scroll position unless `resetScroll`. */
  run(resetScroll = false): void {
    const ix = store.index;
    if (!ix) return;
    const restrict = this.o.restrict?.();
    this.result = filterLibrary(ix, this.filter, restrict);
    sortSets(ix, this.result.sets, this.setSort, this.setDesc);
    this.buildLines();
    if (resetScroll) this.el.scrollTop = 0;
    this.renderHeader();
    this.measure(true);
  }

  get query(): string {
    return this.filter.text;
  }

  setQuery(q: string): void {
    if (q === this.filter.text) return;
    this.filter.text = q;
    this.run(true);
    this.o.onQuery?.(q);
  }

  /** Set indices in display order: what next/previous in the player walks through. */
  private queueSets(): number[] {
    return this.result.sets.map((r) => r.set);
  }

  /** The list's rows: every set, plus the difficulties of open sets. */
  private buildLines(): void {
    const lines: Line[] = [];
    if (this.layout === "list") {
      for (const r of this.result.sets) {
        lines.push({ kind: "set", r });
        if (!this.open.has(r.set)) continue;
        r.maps.forEach((mi, k) => lines.push({ kind: "map", set: r.set, map: mi, last: k === r.maps.length - 1, n: k }));
      }
    }
    this.lines = lines;
  }

  /** Opens or closes a set in the list. */
  private toggleSet(si: number, row?: HTMLElement | null): void {
    const opening = !this.open.has(si);
    if (opening) this.open.add(si);
    else this.open.delete(si);
    row?.classList.toggle("open", opening);
    row?.setAttribute("aria-expanded", String(opening));
    this.buildLines();
    this.opening = opening ? si : -1;
    this.list.relayout();
    this.opening = -1;
    if (!opening) return;
    // keep the opened difficulties in view (the sticky toolbar and list header cover the top)
    const first = this.lines.findIndex((l) => l.kind === "set" && l.r.set === si);
    let last = first;
    while (last + 1 < this.lines.length && this.lines[last + 1].kind === "map") last++;
    this.list.reveal(first, last, "nearest", { inset: 96, smooth: !reduceMotion() });
  }

  // ── layout maths ──────────────────────────────────────────────────────

  private measure(force = false): void {
    const width = this.body.clientWidth;
    if (!width) return;
    const gap = 18;
    const min = 212;
    const cols = Math.max(1, Math.floor((width + gap) / (min + gap)));
    const cardW = (width - gap * (cols - 1)) / cols;
    const changed = cols !== this.cols || Math.abs(cardW - this.cardW) > 0.5;
    this.cols = cols;
    this.cardW = cardW;
    this.el.style.setProperty("--cols", String(cols));
    this.el.style.setProperty("--card-w", `${cardW}px`);
    if (changed || force) this.list.refresh();
    else this.list.update();
  }

  private rowCount(): number {
    return this.layout === "grid" ? Math.ceil(this.result.sets.length / this.cols) : this.lines.length;
  }

  private rowHeight(i: number): number {
    // art (16:9) + 10 gap + title 20 + artist 17 + diffs 18 + row gap 26
    if (this.layout === "grid") return Math.round((this.cardW * 9) / 16) + 91;
    const line = this.lines[i];
    return line.kind === "set" ? SET_H : MAP_H + (line.last ? GROUP_GAP : 0);
  }

  /** Grid rows are keyed by position; list rows by what they show, so opening a set only moves the rows below. */
  private rowKey(i: number): string {
    if (this.layout === "grid") return `g${i}`;
    const line = this.lines[i];
    return line.kind === "set" ? `s${line.r.set}` : `m${line.map}`;
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private renderRow(i: number, row: HTMLElement): void {
    if (this.layout === "grid") {
      const start = i * this.cols;
      const items = this.result.sets.slice(start, start + this.cols);
      row.className = "vrow grid-row";
      row.innerHTML = items.map((r) => this.cardHtml(r.set, r.maps)).join("");
    } else {
      const line = this.lines[i];
      delete row.dataset.map;
      if (line.kind === "set") {
        const open = this.open.has(line.r.set);
        row.className = `vrow lrow lrow-set${open ? " open" : ""}`;
        row.dataset.set = String(line.r.set);
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.setAttribute("aria-expanded", String(open));
        row.innerHTML = this.setRowHtml(line.r);
      } else {
        row.className = `vrow lrow lrow-map${line.last ? " last" : ""}${line.set === this.opening ? " enter" : ""}`;
        row.dataset.set = String(line.set);
        row.dataset.map = String(line.map);
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.removeAttribute("aria-expanded");
        row.style.setProperty("--n", String(Math.min(line.n, 8)));
        row.innerHTML = this.mapRowHtml(line.map);
      }
    }
    this.syncPlaying(row);
  }

  private cardHtml(si: number, matched: number[]): string {
    const snap = store.snap!;
    const set = snap.sets[si];
    const unicode = store.prefs.unicode;
    const maps = matched.map((mi) => snap.maps[mi]);
    const lo = maps[0]?.sr ?? 0;
    const hi = maps.reduce((m, x) => Math.max(m, x.sr), 0);
    const art = set.bg ? `<img src="${thumbUrl(set.bg, 360)}" alt="" loading="lazy" decoding="async" />` : "";
    const STRIP_MAX = 12;
    const strip = maps
      .slice(0, STRIP_MAX)
      .map((m) => `<i${m.sr >= 7.7 ? ` class="deep"` : ""} style="--c:${srColor(m.sr)}"></i>`)
      .join("");
    const more = maps.length > STRIP_MAX ? `<span class="card-more">+${maps.length - STRIP_MAX}</span>` : "";
    return `
      <div class="card" data-set="${si}" data-map="${matched[0]}">
        <div class="card-art${set.bg ? "" : " img-missing"}">
          ${art}
          ${this.keysBadge(maps)}
          <button class="card-play" type="button" aria-label="Play">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</button>
        </div>
        <div class="card-title">${esc(displayTitle(set, unicode))}</div>
        <div class="card-sub">${esc(displayArtist(set, unicode))}</div>
        <div class="card-diffs"><span class="card-strip">${strip}${more}</span><span class="card-range num">${lo === hi ? stars(hi) : `${stars(lo)}–${stars(hi)}`}</span></div>
      </div>`;
  }

  private keysBadge(maps: MapRow[]): string {
    return `<span class="img-badge card-badge">${esc(keysText(maps))}</span>`;
  }

  private setRowHtml(r: SetResult): string {
    const snap = store.snap!;
    const set = snap.sets[r.set];
    const unicode = store.prefs.unicode;
    const maps = r.maps.map((mi) => snap.maps[mi]);
    let lo = Infinity;
    let hi = 0;
    let bpmLo = Infinity;
    let bpmHi = 0;
    let len = 0;
    let played = 0;
    let best: MapRow["best"];
    for (const m of maps) {
      lo = Math.min(lo, m.sr);
      hi = Math.max(hi, m.sr);
      bpmLo = Math.min(bpmLo, m.bpm);
      bpmHi = Math.max(bpmHi, m.bpm);
      len = Math.max(len, m.length);
      played = Math.max(played, m.played ?? 0);
      if (m.best && (!best || gradeRank(m.best) > gradeRank(best))) best = m.best;
    }
    const STRIP_MAX = 14;
    const strip = maps
      .slice(0, STRIP_MAX)
      .map((m) => `<i${m.sr >= 7.7 ? ` class="deep"` : ""} style="--c:${srColor(m.sr)}"></i>`)
      .join("");
    const total = set.maps.filter((mi) => this.filter.showHidden || !snap.maps[mi].hidden).length;
    const count = maps.length < total ? `${maps.length} of ${total}` : `${maps.length} ${maps.length === 1 ? "diff" : "diffs"}`;
    const bpmText = Math.round(bpmLo) === Math.round(bpmHi) ? bpm(bpmHi) : `${bpm(bpmLo)}–${bpm(bpmHi)}`;
    const bg = set.bg;
    const g = best ? rankInfo(best.rank) : null;
    return `
      <div class="l-chev">${icon("chevron-right")}</div>
      <div class="l-art"><div class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}<button class="t-play" type="button" aria-label="Play">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</button></div></div>
      <div class="l-title"><div class="t-title">${esc(displayTitle(set, unicode))}</div><div class="t-sub">${esc(displayArtist(set, unicode))}</div></div>
      <div class="l-creator hide-1">${esc(set.creator)}</div>
      <div class="l-diffs"><span class="card-strip">${strip}</span><span class="t-sub num">${count} · ${esc(keysText(maps))}</span></div>
      <div class="l-sr">${lo < hi ? `<span class="l-lo num">${stars(lo)} –</span>` : ""}${srChip(hi)}</div>
      <div class="l-num num">${bpmText}</div>
      <div class="l-num num">${duration(len)}</div>
      <div class="l-date hide-2">${this.dateText(set.added, set.ranked, played)}</div>
      <div class="l-best">${g ? `<span class="grade" style="--c:${g.color}">${g.label}</span>` : `<span class="t-none">–</span>`}</div>
      <div class="l-open"><button class="icon-btn sm" type="button" data-open data-tip="Open set" aria-label="Open set">${icon("arrow-right")}</button></div>`;
  }

  /** The date column's value for the current sort. */
  private dateText(added: number | undefined, ranked: number | undefined, played: number): string {
    switch (this.setSort) {
      case "played":
        return played ? relativeTime(played) : `<span class="t-none">never</span>`;
      case "ranked":
        return ranked ? date(ranked) : `<span class="t-none">–</span>`;
      default:
        return added ? relativeTime(added) : `<span class="t-none">–</span>`;
    }
  }

  private mapRowHtml(mi: number): string {
    const m = store.snap!.maps[mi];
    const best = m.best ? rankInfo(m.best.rank) : null;
    const mania = m.mode === 3;
    return `
      <div class="lmap">
        <span class="d-keys">${esc(keysOrMode(m))}</span>
        <span class="d-sr">${srChip(m.sr)}</span>
        <span class="d-name"><b>${esc(m.version)}</b>${m.patterns ? `<span class="t-pat">${esc(patternWords(m.patterns))}</span>` : ""}</span>
        <span class="d-num hide-2"><i>OD</i>${fmt1(m.od)}</span>
        <span class="d-num hide-1"><i>HP</i>${fmt1(m.hp)}</span>
        <span class="d-num">${num(m.objects)}<i>${mania ? "notes" : "objects"}</i></span>
        <span class="d-num hide-1">${m.peak !== undefined ? `${m.peak.toFixed(1)}<i>peak</i>` : `<span class="t-none">–</span>`}</span>
        <span class="d-num hide-2"><i>${HOLDS[m.mode] ?? "Holds"}</i>${Math.round(holdRatio(m) * 100)}%</span>
        <span class="d-best">${best ? `<span class="grade" style="--c:${best.color}">${best.label}</span><span class="t-acc num">${(m.best!.acc * 100).toFixed(2)}%</span>` : `<span class="t-none">not played</span>`}</span>
        <span class="d-go">${icon("arrow-right")}</span>
      </div>`;
  }

  private renderHeader(): void {
    const snap = store.snap!;
    const restrict = this.o.restrict?.();
    const totalSets = restrict ? new Set([...restrict].map((mi) => snap.maps[mi].set)).size : snap.sets.filter((s) => s.maps.length).length;
    const totalMaps = restrict ? restrict.size : snap.maps.length;
    const { sets, mapCount } = this.result;
    const filtered = sets.length !== totalSets || mapCount !== totalMaps;
    const countEl = this.el.querySelector(".lib-count")!;
    const extra = this.o.subtitle?.();
    countEl.textContent = filtered
      ? `${num(sets.length)} of ${num(totalSets)} sets · ${num(mapCount)} difficulties`
      : `${num(totalSets)} sets · ${num(totalMaps)} difficulties${extra ? ` · ${extra}` : ""}`;

    // active filter summary, in words
    const words: string[] = [];
    if (this.filter.status.length) {
      words.push(STATUS_FILTERS.filter((s) => s.values.every((v) => this.filter.status.includes(v))).map((s) => s.label).join(", "));
    }
    if (this.filter.srMin > 0 || this.filter.srMax < Infinity) {
      words.push(this.filter.srMax < Infinity ? `${this.filter.srMin.toFixed(1)}–${this.filter.srMax.toFixed(1)} stars` : `${this.filter.srMin.toFixed(1)}+ stars`);
    }
    if (this.filter.played !== "any") words.push(this.filter.played === "played" ? "Played" : "Not played");
    if (this.filter.showHidden) words.push("Including hidden");
    const q = parseQuery(this.filter.text);
    if (q.conds.length) words.push(`Query: ${q.conds.length} filter${q.conds.length > 1 ? "s" : ""}`);
    const active = this.el.querySelector<HTMLElement>(".lib-active")!;
    active.hidden = !words.length;
    active.innerHTML = words.length
      ? `<span class="lib-active-words">${words.map((w) => `<span>${esc(w)}</span>`).join("")}</span><button class="btn btn-ghost btn-sm lib-reset" type="button">Reset filters</button>`
      : "";
    const filterCount = (this.filter.status.length ? 1 : 0) + (this.filter.srMin > 0 || this.filter.srMax < Infinity ? 1 : 0) + (this.filter.played !== "any" ? 1 : 0) + (this.filter.showHidden ? 1 : 0);
    const fb = this.el.querySelector<HTMLElement>(".lib-filters-btn")!;
    fb.classList.toggle("active", filterCount > 0);
    fb.querySelector("span")!.textContent = filterCount ? `Filters · ${filterCount}` : "Filters";

    // list header: the sortable columns sort the sets, like the sort menu
    const th = this.el.querySelector<HTMLElement>(".lib-list-head")!;
    th.hidden = this.layout !== "list";
    if (this.layout === "list") {
      const dateSort: SetSort = DATE_COLUMN[this.setSort] ? this.setSort : "added";
      th.innerHTML = LIST_COLUMNS.map((c) => {
        if (!c.key) return `<div class="th-blank ${c.cls}">${c.label}</div>`;
        const key = c.key === "date" ? dateSort : c.key;
        const label = c.key === "date" ? DATE_COLUMN[dateSort]! : c.label;
        const on = key === this.setSort;
        return `<button type="button" class="th ${c.cls}${on ? " on" : ""}" data-sort="${key}"${c.tip ? ` data-tip="${esc(c.tip)}"` : ""}>${label}${on ? icon(this.setDesc ? "arrow-down" : "arrow-up", "th-dir") : ""}</button>`;
      }).join("");
    }

    // empty state
    const empty = this.el.querySelector<HTMLElement>(".lib-empty")!;
    const none = sets.length === 0;
    empty.hidden = !none;
    if (none) {
      const anyFilter = filtered || this.filter.text;
      empty.innerHTML = anyFilter
        ? `${icon("search-duo")}<div class="empty-title">Nothing matches</div><div class="empty-sub">Try fewer words or loosen a filter.</div><button class="btn btn-sm lib-reset" type="button">Reset search and filters</button>`
        : `${icon("collection-duo")}<div class="empty-title">Nothing here yet</div><div class="empty-sub">${esc(this.o.emptyHint ?? "")}</div>`;
    }
  }

  private syncControls(): void {
    const el = this.el;
    el.dataset.layout = this.layout;
    el.querySelectorAll<HTMLElement>(".lib-modes button").forEach((b) => b.classList.toggle("active", +b.dataset.mode! === this.filter.mode));
    el.querySelectorAll<HTMLElement>(".lib-layout button").forEach((b) => b.classList.toggle("active", b.dataset.layout === this.layout));
    const keysEl = el.querySelector<HTMLElement>(".lib-keys")!;
    keysEl.hidden = this.filter.mode !== 3;
    keysEl.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("active", this.filter.keys.includes(+b.dataset.keys!)));
    this.syncSortUi();
  }

  /** Marks the playing set's card/row. */
  private syncPlaying(scope: ParentNode = this.body): void {
    const np = player.now;
    const playing = player.playing;
    scope.querySelectorAll<HTMLElement>(".playing").forEach((n) => n.classList.remove("playing", "paused"));
    if (!np) return;
    const sel = this.layout === "grid" ? `.card[data-set="${np.set}"]` : `.lrow-set[data-set="${np.set}"]`;
    const nodes = scope instanceof HTMLElement && scope.matches(sel) ? [scope] : [...scope.querySelectorAll<HTMLElement>(sel)];
    nodes.forEach((n) => {
      n.classList.add("playing");
      n.classList.toggle("paused", !playing);
    });
  }

  // ── events ────────────────────────────────────────────────────────────

  private bind(): void {
    const el = this.el;

    el.querySelector(".lib-modes")!.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-mode]");
      if (!b) return;
      this.filter.mode = +b.dataset.mode!;
      if (this.filter.mode !== 3) this.filter.keys = [];
      if (this.o.persistent) setPrefs({ mode: this.filter.mode, keys: this.filter.keys });
      this.syncControls();
      this.run(true);
    });

    el.querySelector(".lib-keys")!.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-keys]");
      if (!b) return;
      const k = +b.dataset.keys!;
      const keys = new Set(this.filter.keys);
      // plain click = only this key count; ctrl/shift-click = add/remove
      if ((e as MouseEvent).ctrlKey || (e as MouseEvent).shiftKey || (e as MouseEvent).metaKey) {
        if (keys.has(k)) keys.delete(k);
        else keys.add(k);
      } else if (keys.size === 1 && keys.has(k)) keys.clear();
      else {
        keys.clear();
        keys.add(k);
      }
      this.filter.keys = [...keys].sort((a, b) => a - b);
      if (this.o.persistent) setPrefs({ keys: this.filter.keys });
      this.syncControls();
      this.run(true);
    });

    el.querySelector(".lib-layout")!.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-layout]");
      if (!b || b.dataset.layout === this.layout) return;
      this.layout = b.dataset.layout as LibraryLayout;
      if (this.o.persistent) setPrefs({ layout: this.layout });
      this.syncControls();
      this.run(true);
    });

    el.querySelector(".lib-sort-dir")!.addEventListener("click", () => {
      this.setDesc = !this.setDesc;
      if (this.o.persistent) setPrefs({ sortDesc: this.setDesc });
      this.syncControls();
      this.run(true);
    });

    el.querySelector(".lib-filters-btn")!.addEventListener("click", (e) => this.openFilters(e.currentTarget as HTMLElement));

    el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest(".lib-reset")) {
        const hadText = !!this.filter.text;
        this.filter = { ...DEFAULT_FILTER, mode: this.filter.mode, keys: this.filter.keys };
        this.syncControls();
        this.run(true);
        if (hadText) this.o.onQuery?.("");
        return;
      }
      const th = t.closest<HTMLElement>(".th[data-sort]");
      if (th) {
        const key = th.dataset.sort as SetSort;
        if (key !== this.setSort) return this.setSortKey(key);
        this.setDesc = !this.setDesc;
        if (this.o.persistent) setPrefs({ sortDesc: this.setDesc });
        this.syncControls();
        this.run();
        return;
      }
      const play = t.closest(".card-play, .t-play");
      const item = t.closest<HTMLElement>(".card, .lrow");
      if (!item) return;
      const si = +item.dataset.set!;
      const mi = item.dataset.map !== undefined ? +item.dataset.map : undefined;
      if (play) {
        e.stopPropagation();
        player.playSet(si, mi, this.queueSets());
        return;
      }
      if (item.classList.contains("lrow-set") && !t.closest("[data-open]")) return this.toggleSet(si, item);
      openSet(si, mi);
    });

    // double-click a set row: straight to the set page
    el.addEventListener("dblclick", (e) => {
      const t = e.target as Element;
      const item = t.closest<HTMLElement>(".lrow-set");
      if (item && !t.closest("button")) openSet(+item.dataset.set!);
    });

    el.addEventListener("keydown", (e) => {
      const item = (e.target as Element).closest<HTMLElement>(".lrow");
      if (!item || e.target !== item || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      const si = +item.dataset.set!;
      if (item.dataset.map !== undefined) openSet(si, +item.dataset.map);
      else if (e.key === "Enter" && e.shiftKey) openSet(si);
      else this.toggleSet(si, item);
    });

    el.addEventListener("contextmenu", (e) => {
      const item = (e.target as Element).closest<HTMLElement>(".card, .lrow");
      if (!item) return;
      e.preventDefault();
      const mi = item.classList.contains("lrow-map") ? +item.dataset.map! : undefined;
      setMenu({ x: e.clientX, y: e.clientY }, +item.dataset.set!, mi, { onSearch: (q) => this.setQuery(q) });
    });

    // fade images in once decoded; mark failures
    this.body.addEventListener("load", (e) => (e.target as HTMLElement).classList?.add("loaded"), true);
    this.body.addEventListener(
      "error",
      (e) => {
        const img = e.target as HTMLElement;
        if (img.tagName === "IMG") img.parentElement?.classList.add("img-missing");
      },
      true,
    );
  }

  private setSortKey(v: SetSort): void {
    this.setSort = v;
    this.setDesc = DESC_FIRST.has(v);
    if (this.o.persistent) setPrefs({ sort: v, sortDesc: this.setDesc });
    this.syncControls();
    this.run(true);
  }

  private openFilters(anchor: HTMLElement): void {
    // A menu hosts the status list; the star range + played toggle live in a custom panel row.
    const f = this.filter;
    const entries: MenuEntry[] = [{ group: "Status" }];
    for (const s of STATUS_FILTERS) {
      entries.push({
        label: s.label,
        checked: s.values.every((v) => f.status.includes(v)),
        keepOpen: true,
        action: () => {
          const on = s.values.every((v) => f.status.includes(v));
          const set = new Set(f.status);
          for (const v of s.values) on ? set.delete(v) : set.add(v);
          f.status = [...set];
          this.run(true);
          return !on;
        },
      });
    }
    entries.push({ group: "Plays" });
    for (const p of [
      { v: "any", label: "Any" },
      { v: "played", label: "Played" },
      { v: "unplayed", label: "Not played" },
    ] as const) {
      entries.push({
        label: p.label,
        checked: f.played === p.v,
        keepOpen: true,
        radio: "played",
        action: () => {
          f.played = p.v;
          this.run(true);
        },
      });
    }
    entries.push("sep", {
      label: "Show hidden difficulties",
      checked: f.showHidden,
      keepOpen: true,
      action: () => {
        f.showHidden = !f.showHidden;
        this.run(true);
        return f.showHidden;
      },
    });
    openMenu(anchor, entries, { minWidth: 260, className: "filters-menu", header: this.starRange() });
  }

  /** Dual-thumb star range at the top of the filters menu. */
  private starRange(): HTMLElement {
    const f = this.filter;
    const MAX = 10;
    const wrap = document.createElement("div");
    wrap.className = "sr-range";
    wrap.innerHTML = `
      <div class="menu-group">Star rating</div>
      <div class="sr-range-val num"></div>
      <div class="sr-range-track">
        <input type="range" class="sr-lo" min="0" max="${MAX}" step="0.1" aria-label="Minimum stars" />
        <input type="range" class="sr-hi" min="0" max="${MAX}" step="0.1" aria-label="Maximum stars" />
      </div>`;
    const lo = wrap.querySelector<HTMLInputElement>(".sr-lo")!;
    const hi = wrap.querySelector<HTMLInputElement>(".sr-hi")!;
    const val = wrap.querySelector<HTMLElement>(".sr-range-val")!;
    lo.value = String(f.srMin);
    hi.value = String(f.srMax === Infinity ? MAX : f.srMax);
    const paint = () => {
      const a = +lo.value;
      const b = +hi.value;
      wrap.style.setProperty("--lo", `${(a / MAX) * 100}%`);
      wrap.style.setProperty("--hi", `${(b / MAX) * 100}%`);
      val.textContent = b >= MAX ? (a > 0 ? `${a.toFixed(1)}+ stars` : "Any") : `${a.toFixed(1)} – ${b.toFixed(1)} stars`;
    };
    let t = 0;
    const commit = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        f.srMin = +lo.value;
        f.srMax = +hi.value >= MAX ? Infinity : +hi.value;
        this.run(true);
      }, 60);
    };
    lo.addEventListener("input", () => {
      if (+lo.value > +hi.value) lo.value = hi.value;
      paint();
      commit();
    });
    hi.addEventListener("input", () => {
      if (+hi.value < +lo.value) hi.value = lo.value;
      paint();
      commit();
    });
    [lo, hi].forEach(updateRange);
    paint();
    return wrap;
  }

  /** Called when the view becomes visible again. */
  shown(): void {
    this.measure();
    this.syncPlaying();
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.list.destroy();
    this.el.remove();
  }
}

/** What counts as a hold, per ruleset: sliders, drumrolls, long notes. */
const HOLDS: Record<number, string> = { 0: "Sliders", 1: "Rolls", 3: "LN" };

const fmt1 = (v: number): string => (Math.round(v * 10) / 10).toString();

/** "7K", "4K / 7K", or the ruleset when it isn't mania. */
function keysText(maps: MapRow[]): string {
  const keys = [...new Set(maps.filter((m) => m.mode === 3).map((m) => Math.round(m.cs)))].sort((a, b) => a - b);
  const modes = new Set(maps.map((m) => m.mode));
  if (keys.length && modes.size === 1) return keys.length > 3 ? `${keys[0]}–${keys[keys.length - 1]}K` : keys.map((k) => `${k}K`).join(" / ");
  if (modes.size === 1) return modeLabel(maps[0].mode).replace("osu!", "") || "osu!";
  return `${modes.size} modes`;
}

/** Orders best scores: grade first (silver ranks with gold), then accuracy. */
function gradeRank(b: NonNullable<MapRow["best"]>): number {
  const g = b.rank === 5 ? 4 : b.rank === 7 ? 6 : b.rank;
  return g * 1000 + b.acc;
}
