/* care.ts — library care: what the library takes on disk and where it goes (by kind of file,
 * ruleset or status), and the sets worth a look: never played, the biggest, not played in a year,
 * duplicates (osu!stable's copies of lazer's sets, a set twice, packs sharing difficulties with
 * sets, re-uploads), and songs or backgrounds that are missing or aren't what their name says.
 *
 * Sizes come from src-tauri/src/care.rs (lazer's files by their hash, stable's folders); whether
 * and when a set was played from the snapshot (lazer's last played, the merged scores). Fumen
 * only points things out here.
 */
import { api, asApiError, onCareProgress, thumbUrl } from "../lib/api";
import { bytes, displayArtist, displayTitle, esc, MODE_SHORT, num, relativeTime, statusLabel } from "../lib/format";
import { events, store } from "../lib/store";
import type { Broken, CareReport, DupeGroup, DupeSet } from "../lib/types";
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
type Tab = "never" | "biggest" | "stale" | "dupes" | "broken";

/** What each kind of duplicate is, and what of it could go. */
const DUPES: Record<DupeGroup["kind"], { title: string; note: (g: DupeGroup) => string }> = {
  "stable-copy": { title: "In osu!stable and osu!lazer", note: () => "Every difficulty of the osu!stable copy is in osu!lazer too." },
  "same-set": { title: "The same beatmap set more than once", note: () => "One set on osu!, newest first." },
  shared: { title: "Difficulties in common", note: (g) => `${num(g.shared)} ${g.shared === 1 ? "difficulty is" : "difficulties are"} in more than one of these sets, like a pack and a set.` },
  reupload: { title: "Most likely a re-upload", note: () => "The same title by the same mapper, with the same song file." },
};

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
          <button type="button" data-tab="dupes">Duplicates</button>
          <button type="button" data-tab="broken">Broken files</button>
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
    // narrow, the tabs scroll: the chosen one in sight
    const tabs = this.el.querySelector<HTMLElement>(".care-tabs");
    const active = tabs?.querySelector<HTMLElement>("button.active");
    if (tabs && active) tabs.scrollLeft = Math.max(0, Math.min(tabs.scrollLeft, active.offsetLeft), active.offsetLeft + active.offsetWidth - tabs.clientWidth);
    if (this.tab === "dupes") return this.renderDupes(list, note);
    if (this.tab === "broken") return this.renderBroken(list, note);
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

  /** The duplicates, group by group: what they are, the sets (newest first), what could go. */
  private renderDupes(list: HTMLElement, note: HTMLElement): void {
    const report = cached!;
    const groups = report.duplicates;
    if (!groups.length) {
      note.textContent = "";
      list.innerHTML = `<div class="care-none">No duplicates: every set in your library is there once.</div>`;
      return;
    }
    const size = new Map(report.sets.map((s) => [s.id, s.size]));
    const info = new Map(report.named.map((s) => [s.id, s]));
    const could = (g: DupeGroup) =>
      g.kind === "stable-copy"
        ? g.sets.filter((id) => info.get(id)?.source === "stable").reduce((s, id) => s + (size.get(id) ?? 0), 0)
        : g.kind === "same-set" || g.kind === "reupload"
          ? g.sets.slice(1).reduce((s, id) => s + (size.get(id) ?? 0), 0)
          : 0;
    const total = groups.reduce((s, g) => s + could(g), 0);
    const sets = groups.reduce((s, g) => s + g.sets.length, 0);
    note.textContent = `${num(sets)} sets in ${num(groups.length)} ${groups.length === 1 ? "group" : "groups"}${total ? `; up to ${bytes(total)} could go` : ""}.`;
    // the ones that free the most first
    const order = [...groups].sort((a, b) => could(b) - could(a));
    list.innerHTML = order
      .map((g) => {
        const d = DUPES[g.kind];
        const c = could(g);
        const what = g.kind === "stable-copy" ? "osu!stable's copy" : "all but the newest";
        return `
        <div class="dupe">
          <div class="dupe-head">
            <div class="dupe-title">${d.title}</div>
            <div class="dupe-note">${esc(d.note(g))}</div>
            ${c ? `<div class="dupe-save num">${what}: ${bytes(c)}</div>` : ""}
          </div>
          ${g.sets.map((id, k) => this.dupeRow(info.get(id), size.get(id) ?? 0, k === 0 && g.kind !== "stable-copy" && g.kind !== "shared")).join("")}
        </div>`;
      })
      .join("");
  }

  /** Sets with a song or background that's missing or broken, the song ones first. */
  private renderBroken(list: HTMLElement, note: HTMLElement): void {
    const report = cached!;
    const bySet = new Map<string, Broken[]>();
    for (const b of report.broken) bySet.set(b.set, [...(bySet.get(b.set) ?? []), b]);
    if (!bySet.size) {
      note.textContent = "";
      list.innerHTML = `<div class="care-none">Every song and background is there, and is what it says.</div>`;
      return;
    }
    const rank = (b: Broken) => ["song", "background", "files"].indexOf(b.what);
    const sets = [...bySet.entries()].map(([id, issues]) => [id, issues.sort((a, b) => rank(a) - rank(b))] as const);
    sets.sort((a, b) => rank(a[1][0]) - rank(b[1][0]));
    const songs = sets.filter(([, issues]) => issues.some((b) => b.what === "song")).length;
    note.textContent = `${num(sets.length)} ${sets.length === 1 ? "set" : "sets"}${songs ? `, ${num(songs)} of them with a song that won't play` : ""}.`;
    const size = new Map(report.sets.map((s) => [s.id, s.size]));
    const info = new Map(report.named.map((s) => [s.id, s]));
    list.innerHTML = sets.map(([id, issues]) => this.dupeRow(info.get(id), size.get(id) ?? 0, false, issues)).join("");
  }

  private dupeRow(s: DupeSet | undefined, size: number, newest: boolean, issues: Broken[] = []): string {
    if (!s) return "";
    const snap = store.snap!;
    const unicode = store.prefs.unicode;
    const idx = this.setIndex(s.id);
    const set = idx !== undefined ? snap.sets[idx] : undefined;
    let played = 0;
    for (const m of set?.maps ?? []) {
      const map = snap.maps[m];
      played = Math.max(played, map.played ?? 0, map.best?.last ?? 0, map.best?.plays ? 1 : 0);
    }
    const sub = [
      s.source === "stable" ? "osu!stable" : "osu!lazer",
      `${num(s.maps)} ${s.maps === 1 ? "difficulty" : "difficulties"}`,
      s.creator,
      s.source === "stable" && s.folder ? `Songs/${s.folder}` : "",
    ]
      .filter(Boolean)
      .map(esc);
    if (newest) sub.unshift(`<b class="dupe-new">Newest</b>`);
    const when = played > 1 ? `played ${relativeTime(played)}` : set && played ? "played" : s.added ? `added ${relativeTime(s.added)}` : "";
    const title = set ? displayTitle(set, unicode) : s.title;
    const bg = set?.bg ?? s.bg;
    return `
      <div class="crow dupe-row${idx === undefined ? " off" : ""}"${idx !== undefined ? ` data-set="${idx}" role="button" tabindex="0"` : ""}>
        <span class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
        <div class="prow-text"><div class="t-title">${esc(title)}</div><div class="t-sub">${sub.join(" · ")}</div>${issues.map((b) => `<div class="broken-line">${issue(b, s)}</div>`).join("")}</div>
        <span class="crow-video"></span>
        <b class="crow-size num">${bytes(size)}</b>
        <span class="crow-when">${when}</span>
      </div>`;
  }

  private setIndex(id: string): number | undefined {
    const snap = store.snap;
    if (!snap) return undefined;
    const i = snap.sets.findIndex((s) => s.id === id);
    // stable sets the library leaves out (all theirs is lazer's) have no difficulties left
    return i >= 0 && snap.sets[i].maps.length ? i : undefined;
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
      const dupe = t.closest<HTMLElement>(".crow[data-set]");
      if (dupe) return openSet(+dupe.dataset.set!);
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
      const dupe = (e.target as Element).closest<HTMLElement>(".crow[data-set]");
      if (dupe && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        return openSet(+dupe.dataset.set!);
      }
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

/** What's wrong, in a line: what the file is, its name, for how many of the set's difficulties. */
function issue(b: Broken, s: DupeSet): string {
  const name = b.name ? `<span class="broken-name">${esc(b.name)}</span>` : "";
  const where = s.source === "stable" ? "the folder" : "the set";
  const text =
    b.what === "files"
      ? `${num(b.count)} ${b.count === 1 ? "file is" : "files are"} missing from osu!lazer's files`
      : b.how === "missing"
        ? `${b.what === "song" ? "Song" : "Background"} ${name} isn't in ${where}`
        : `${b.what === "song" ? "Song" : "Background"} ${name} isn't ${b.what === "song" ? "audio" : "an image"}`;
  const of = b.what !== "files" && s.maps > 1 ? ` · ${b.count === s.maps ? "every difficulty" : `${num(b.count)} of ${num(s.maps)} difficulties`}` : "";
  return `<b>${b.how === "missing" ? "Missing" : "Broken"}</b> ${text}${of}`;
}

/** A share as a whole percentage (under 1: "<1%"). */
const percent = (v: number): string => (v > 0 && v < 0.005 ? "<1%" : `${Math.round(v * 100)}%`);

function tile(k: string, v: string, sub: string): string {
  return `<div class="panel hist-tile"><span class="tile-k">${k}</span><b class="tile-v num">${v}</b><span class="tile-s">${sub}</span></div>`;
}
