/* browse.ts — Browse: osu!'s beatmaps, found through the mirrors' search (src-tauri/src/
 * mirror_search.rs; never osu!'s servers), to add to osu!lazer one set at a time or a whole
 * search at once. Adding goes through Add beatmaps' import (views/import.ts): sets added while an
 * import runs wait in its queue, and each row follows its set along. Sets the library has open
 * it instead. A set's preview plays from the mirrors too.
 *
 * The search: text, ruleset, osu!mania key counts, status and a star range; the mirror filters
 * and sorts, and the difficulties are checked again on the way back, so a set shows when one of
 * its difficulties fits everything asked. Pages load as the list scrolls. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, asApiError } from "../lib/api";
import { bpm, date, duration, esc, num, pct, srChip, statusLabel } from "../lib/format";
import { router } from "../lib/router";
import { events, store } from "../lib/store";
import type { FoundMap, FoundSet, LazerImportStatus, MirrorQuery, MirrorSort } from "../lib/types";
import { player } from "../player";
import { attachSegIndicator, createSelect, openMenu, toast, uiConfirm, type MenuEntry, type SelectOption } from "../ui/controls";
import { icon } from "../ui/icons";
import { starRange } from "../ui/star-range";
import { openSet } from "./actions";
import { importEvents, importSets, openImport, setImportState, type SetImport } from "./import";
import { fromRust, t, tn } from "../lib/i18n";

const MODES = [
  { mode: -1, label: t("All") },
  { mode: 0, label: "osu!" },
  { mode: 1, label: "taiko" },
  { mode: 2, label: "catch" },
  { mode: 3, label: "mania" },
];
const KEY_COUNTS = [4, 5, 6, 7, 8, 9, 10];

const SORTS: SelectOption<MirrorSort>[] = [
  { value: "relevance", label: t("Best match") },
  { value: "ranked", label: t("Newest ranked") },
  { value: "newest", label: t("Recently updated") },
  { value: "plays", label: t("Most played") },
  { value: "favourites", label: t("Most favourited") },
  { value: "stars", label: t("Easiest first") },
];

const STATUS_FILTERS = [
  { label: t("Ranked"), values: [1, 2] },
  { label: t("Loved"), values: [4] },
  { label: t("Qualified"), values: [3] },
  { label: t("Pending / WIP"), values: [0, -1] },
  { label: t("Graveyard"), values: [-2] },
];

/** difficulty chips in a row before "+n" */
const CHIPS = 6;
/** a whole search added at once from this many sets asks first */
const ASK_FROM = 10;

const cover = (set: number) => `https://assets.ppy.sh/beatmaps/${set}/covers/list.jpg`;
const setUrl = (set: number) => `https://osu.ppy.sh/beatmapsets/${set}`;

// ── previews (from the mirrors; one at a time, and never over the player) ──

let preview: { audio: HTMLAudioElement; set: number } | null = null;
const previewEvents: Set<() => void> = new Set();
const previewChanged = () => previewEvents.forEach((f) => f());

/** The sources a set's preview can come from, in turn. */
const previewSources = (s: FoundSet): string[] => [
  ...(s.maps[0] ? [`https://catboy.best/preview/audio/${s.maps[0].id}`] : []),
  `https://osu.direct/api/media/preview/set/${s.id}`,
];

function stopPreview(): void {
  if (!preview) return;
  preview.audio.pause();
  preview.audio.removeAttribute("src");
  preview.audio.load();
  preview = null;
  previewChanged();
}

function playPreview(s: FoundSet): void {
  if (preview?.set === s.id) return stopPreview();
  stopPreview();
  if (player.playing) player.toggle();
  const audio = new Audio();
  const v = store.prefs.volume;
  audio.volume = Math.max(0, Math.min(1, v * v));
  const sources = previewSources(s);
  let at = 0;
  const next = () => {
    if (preview?.audio !== audio) return;
    if (at >= sources.length) {
      stopPreview();
      toast(t("No mirror has a preview of this set"), { kind: "danger", timeout: 3000 });
      return;
    }
    audio.src = sources[at++];
    audio.play().catch(() => {});
  };
  audio.addEventListener("error", next);
  audio.addEventListener("ended", stopPreview);
  preview = { audio, set: s.id };
  next();
  previewChanged();
}

// the player starting stops a preview
player.bus.on("state", (playing) => {
  if (playing) stopPreview();
});

export class BrowseView {
  readonly el: HTMLElement;
  private q: MirrorQuery;
  private sets: FoundSet[] = [];
  private more = false;
  private mirror = "";
  private plain = false;
  private loading: "first" | "more" | null = null;
  private error: string | null = null;
  /** bumped per search, so a late answer to an older one is dropped */
  private job = 0;
  /** sets whose difficulties are open */
  private open = new Set<number>();
  private status: LazerImportStatus | null = null;
  private textTimer = 0;
  /** pages in a row that added nothing (the next one isn't asked for by itself after a few) */
  private empty = 0;
  private io: IntersectionObserver;
  private offs: (() => void)[] = [];

  constructor() {
    const mode = store.prefs.mode >= 0 ? store.prefs.mode : null;
    this.q = {
      text: "",
      mode,
      keys: mode === 3 ? [...store.prefs.keys] : [],
      srMin: null,
      srMax: null,
      status: [1, 2, 4],
      sort: "relevance",
      page: 0,
    };
    this.el = document.createElement("section");
    this.el.className = "view browse-view";
    this.el.innerHTML = `
      <header class="view-head br-head">
        <div>
          <h1 class="view-title">${t("Browse")}</h1>
          <div class="view-sub">${t("osu!'s beatmaps, found through the mirrors. What you add goes into osu!lazer.")}</div>
        </div>
        <div class="br-head-tools"></div>
      </header>
      <div class="lib-toolbar br-toolbar">
        <label class="br-search">${icon("search")}<input type="search" spellcheck="false" placeholder="${t("Title, artist, mapper or tags")}" aria-label="${t("Search the mirrors")}" /></label>
        <div class="seg-pill lib-modes" role="tablist" aria-label="${t("Ruleset")}">
          ${MODES.map((m) => `<button type="button" data-mode="${m.mode}">${m.label}</button>`).join("")}
        </div>
        <div class="lib-keys" role="group" aria-label="${t("Keys")}">
          ${KEY_COUNTS.map((k) => `<button type="button" data-keys="${k}">${k}K</button>`).join("")}
        </div>
        <span class="lib-toolbar-gap"></span>
        <button class="btn btn-ghost lib-filters-btn br-filters-btn" type="button">${icon("sliders")}<span>${t("Filters")}</span></button>
      </div>
      <div class="br-lazer" hidden></div>
      <div class="br-summary"></div>
      <div class="br-list"></div>
      <div class="br-foot"></div>`;
    const sort = createSelect(SORTS, this.q.sort, (v) => {
      this.q.sort = v;
      this.search();
    }, { prefix: t("Sort"), tip: t("Sort the sets by") });
    this.el.querySelector(".br-head-tools")!.appendChild(sort.el);
    attachSegIndicator(this.el.querySelector(".lib-modes")!);
    this.syncControls();
    this.bind();

    // the next page comes as the end of the list comes into view
    this.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && this.more && !this.loading && !this.error) this.load(true);
    }, { rootMargin: "600px 0px" });
    this.io.observe(this.el.querySelector(".br-foot")!);

    this.offs.push(
      importEvents.on("set", (id) => this.renderAction(id)),
      events.on("library", () => this.renderList()),
      events.on("importing", () => void this.refreshStatus()),
      events.on("prefs", (p) => {
        if ("unicode" in p) this.renderList();
      }),
      router.on("change", (r) => {
        if (r.name !== "browse") stopPreview();
      }),
    );
    previewEvents.add(this.onPreview);
    void this.refreshStatus();
    this.search();
  }

  /** The page came on screen: osu!lazer may have opened or closed meanwhile. */
  shown(): void {
    void this.refreshStatus();
  }

  private readonly onPreview = () => {
    for (const b of this.el.querySelectorAll<HTMLElement>(".br-play")) {
      const on = preview?.set === +b.closest<HTMLElement>("[data-set]")!.dataset.set!;
      b.classList.toggle("playing", on);
      b.setAttribute("aria-label", on ? t("Stop the preview") : t("Play the preview"));
      b.dataset.tip = on ? t("Stop the preview") : t("Play the preview");
    }
  };

  // ── searching ─────────────────────────────────────────────────────────

  private search(): void {
    this.q.page = 0;
    this.open.clear();
    this.load(false);
  }

  private load(more: boolean): void {
    const job = ++this.job;
    const q = { ...this.q, page: more ? this.q.page + 1 : 0 };
    this.loading = more ? "more" : "first";
    this.error = null;
    if (!more) {
      this.sets = [];
      this.more = false;
      this.renderList();
    }
    this.renderFoot();
    api.searchMirrors(q).then(
      (page) => {
        if (job !== this.job) return;
        this.q.page = q.page;
        // a set can come twice when the mirror's order moves between pages
        const have = new Set(this.sets.map((s) => s.id));
        const fresh = page.sets.filter((s) => !have.has(s.id));
        this.sets.push(...fresh);
        this.more = page.more;
        this.mirror = page.mirror;
        this.plain = page.plain;
        this.loading = null;
        if (more) this.appendRows(fresh);
        else this.renderList();
        this.renderSummary();
        this.renderFoot();
        // a page the filters thinned out can leave the end in view: the next one, then
        this.empty = fresh.length ? 0 : this.empty + 1;
        requestAnimationFrame(() => {
          const foot = this.el.querySelector<HTMLElement>(".br-foot")!;
          const near = !this.el.hidden && foot.getBoundingClientRect().top < window.innerHeight + 600;
          if (near && this.more && !this.loading && this.empty < 3) this.load(true);
        });
      },
      (e) => {
        if (job !== this.job) return;
        this.loading = null;
        this.error = asApiError(e).message;
        if (!more) this.renderList();
        this.renderFoot();
      },
    );
  }

  private async refreshStatus(): Promise<void> {
    try {
      this.status = await api.lazerImportStatus();
    } catch {
      this.status = null;
    }
    this.renderLazer();
    for (const s of this.sets) this.renderAction(s.id);
    this.renderSummary();
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private syncControls(): void {
    const mode = this.q.mode ?? -1;
    this.el.querySelectorAll<HTMLElement>(".lib-modes [data-mode]").forEach((b) => b.classList.toggle("active", +b.dataset.mode! === mode));
    const keys = this.el.querySelector<HTMLElement>(".lib-keys")!;
    keys.hidden = mode !== 3;
    keys.querySelectorAll<HTMLElement>("[data-keys]").forEach((b) => b.classList.toggle("active", this.q.keys.includes(+b.dataset.keys!)));
    const filters = (this.q.srMin !== null || this.q.srMax !== null ? 1 : 0) + (sameStatus(this.q.status, [1, 2, 4]) ? 0 : 1);
    const fb = this.el.querySelector<HTMLElement>(".br-filters-btn")!;
    fb.classList.toggle("active", filters > 0);
    fb.querySelector("span")!.textContent = filters ? `${t("Filters")} · ${filters}` : t("Filters");
  }

  /** Where the sets come from, how many, and adding all of them. */
  private renderSummary(): void {
    const el = this.el.querySelector<HTMLElement>(".br-summary")!;
    if (!this.sets.length) {
      el.innerHTML = "";
      return;
    }
    const fresh = this.addable();
    const order = this.plain
      ? `<span data-tip="${t("osu.direct couldn't answer, so catboy.best did: its order, filtered here")}">${t("from {mirror}, in its own order", { mirror: esc(this.mirror) })}</span>`
      : `<span>${t("from {mirror}", { mirror: esc(this.mirror) })}</span>`;
    const ready = !!this.status?.ready;
    el.innerHTML = `
      <span class="meta-line num"><span>${this.more ? tn(this.sets.length, "{n} set so far", "{n} sets so far") : tn(this.sets.length, "{n} set", "{n} sets")}</span>${order}</span>
      ${
        fresh.length
          ? `<button class="btn btn-sm br-add-all" type="button"${ready ? "" : ` disabled data-tip="${esc(this.lazerReason())}"`}>${icon("download")}<span>${fresh.length === 1 ? t("Add the new set") : t("Add all {n} new", { n: num(fresh.length) })}</span></button>`
          : ""
      }`;
  }

  /** Why sets can't go into osu!lazer right now (the bar under the toolbar says it too). */
  private lazerReason(): string {
    const s = this.status;
    if (!s) return t("Fumen couldn't check osu!lazer");
    if (s.reason === "running") return t("Close osu!lazer to add sets");
    return s.message ?? t("osu!lazer can't take sets right now");
  }

  private renderLazer(): void {
    const el = this.el.querySelector<HTMLElement>(".br-lazer")!;
    const s = this.status;
    if (!s || s.ready) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const text =
      s.reason === "running"
        ? t("osu!lazer is open. Fumen adds sets with lazer's own code while it's closed, so close it to add these.")
        : s.message ?? t("osu!lazer can't take sets right now.");
    el.innerHTML = `${icon("info")}<span>${esc(text)}</span>${s.reason === "running" ? `<button class="btn btn-ghost btn-sm br-recheck" type="button">${t("Check again")}</button>` : ""}`;
  }

  private renderList(): void {
    const list = this.el.querySelector<HTMLElement>(".br-list")!;
    this.renderSummary();
    if (!this.sets.length) {
      if (this.loading === "first") list.innerHTML = Array.from({ length: 6 }, () => `<div class="skeleton br-skel"></div>`).join("");
      else if (this.error) list.innerHTML = `<div class="empty-state br-empty">${icon("alert")}<div class="empty-title">${t("The mirrors couldn't search")}</div><div class="empty-sub">${esc(this.error)}</div><button class="btn btn-sm br-retry" type="button">${t("Try again")}</button></div>`;
      else list.innerHTML = `<div class="empty-state br-empty">${icon("search-duo")}<div class="empty-title">${t("Nothing on the mirrors matches")}</div><div class="empty-sub">${t("Fewer filters, or other words, find more.")}</div></div>`;
      return;
    }
    const lib = libraryIndex();
    list.innerHTML = this.sets.map((s) => this.setHtml(s, lib)).join("");
    this.onPreview();
  }

  private appendRows(sets: FoundSet[]): void {
    const lib = libraryIndex();
    this.el.querySelector(".br-list")!.insertAdjacentHTML("beforeend", sets.map((s) => this.setHtml(s, lib)).join(""));
    this.onPreview();
  }

  private renderFoot(): void {
    const foot = this.el.querySelector<HTMLElement>(".br-foot")!;
    if (this.loading === "more") foot.innerHTML = `<div class="skeleton br-skel"></div><div class="skeleton br-skel"></div>`;
    else if (this.error && this.sets.length) foot.innerHTML = `<div class="br-foot-note">${icon("alert")}<span>${esc(this.error)}</span><button class="btn btn-ghost btn-sm br-retry" type="button">${t("Try again")}</button></div>`;
    else if (this.more) foot.innerHTML = `<button class="btn btn-ghost btn-sm br-more" type="button">${t("More")}</button>`;
    else foot.innerHTML = this.sets.length ? `<div class="br-foot-note">${t("That's every set the mirror found.")}</div>` : "";
  }

  private setHtml(s: FoundSet, lib: LibraryIndex): string {
    const unicode = store.prefs.unicode;
    const title = (unicode && s.titleUnicode) || s.title;
    const artist = (unicode && s.artistUnicode) || s.artist;
    const matched = s.maps.filter((m) => m.matches);
    const chips = matched
      .slice(0, CHIPS)
      .map((m) => `<span data-tip="${esc(diffTip(m))}">${srChip(m.sr)}</span>`)
      .join("");
    const meta = [
      s.ranked ? `${statusLabel(s.status)} ${date(s.ranked)}` : statusLabel(s.status),
      s.plays ? tn(s.plays, "{n} play", "{n} plays") : "",
      matched[0]?.bpm ? `${bpm(matched[0].bpm)} BPM` : "",
      lib.stable.has(s.id) && !lib.lazer.has(s.id) ? t("in osu!stable") : "",
    ].filter(Boolean);
    const open = this.open.has(s.id);
    return `
      <div class="br-set${open ? " open" : ""}" data-set="${s.id}">
        <div class="br-row" role="button" tabindex="0" aria-expanded="${open}">
          <span class="br-art">
            <img src="${cover(s.id)}" alt="" loading="lazy" decoding="async" />
            <button class="br-play" type="button">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</button>
          </span>
          <div class="br-text">
            <div class="t-title">${esc(title)}</div>
            <div class="t-sub">${esc(artist)} · ${t("mapped by {mapper}", { mapper: esc(s.creator) })}</div>
            <div class="meta-line num br-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
          </div>
          <div class="br-chips">${chips}${matched.length > CHIPS ? `<span class="br-chips-more num">+${matched.length - CHIPS}</span>` : ""}</div>
          <div class="br-act">${this.actionHtml(s.id, lib)}</div>
        </div>
        ${open ? this.diffsHtml(s) : ""}
      </div>`;
  }

  /** A set's difficulties, the ones the search asks for first in strength. */
  private diffsHtml(s: FoundSet): string {
    return `<div class="br-diffs">${s.maps
      .map((m) => {
        const facts = [
          m.mode === 3 ? `${Math.round(m.cs)}K` : "",
          duration(m.length * 1000),
          `${bpm(m.bpm)} BPM`,
          m.mode === 0 || m.mode === 2 ? `AR ${trim(m.ar)} · CS ${trim(m.cs)}` : "",
          `OD ${trim(m.od)}`,
        ].filter(Boolean);
        return `<div class="br-diff${m.matches ? "" : " dim"}">${srChip(m.sr)}<span class="br-diff-name">${esc(m.version)}</span><span class="meta-line num">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</span></div>`;
      })
      .join("")}</div>`;
  }

  /** What can be done with a set: open it, add it, or how its import goes. */
  private actionHtml(id: number, lib: LibraryIndex): string {
    if (lib.lazer.has(id)) return `<button class="btn btn-ghost btn-sm br-open" type="button">${icon("library")}<span>${t("In library")}</span></button>`;
    const st = setImportState(id);
    if (st && st.stage !== "error" && !(st.stage === "skipped" && st.message === "Cancelled")) return stateHtml(st);
    const ready = !!this.status?.ready;
    const why = st?.stage === "error" ? t("Failed: {error}. Again?", { error: st.message ? fromRust(st.message) : t("unknown") }) : ready ? t("Download it and put it into osu!lazer") : this.lazerReason();
    return `<button class="btn btn-sm br-add${st?.stage === "error" ? " failed" : ""}" type="button"${ready ? "" : " disabled"} data-tip="${esc(why)}">${icon(st?.stage === "error" ? "refresh" : "download")}<span>${st?.stage === "error" ? t("Again") : t("Add")}</span></button>`;
  }

  private renderAction(id: number): void {
    const el = this.el.querySelector<HTMLElement>(`.br-set[data-set="${id}"] .br-act`);
    if (el) el.innerHTML = this.actionHtml(id, libraryIndex());
    if (this.sets.length) this.renderSummary();
  }

  /** The sets on screen that can still be added. */
  private addable(): FoundSet[] {
    const lib = libraryIndex();
    return this.sets.filter((s) => {
      if (lib.lazer.has(s.id)) return false;
      const st = setImportState(s.id);
      return !st || st.stage === "error" || (st.stage === "skipped" && st.message === "Cancelled");
    });
  }

  /** `window`: open Add beatmaps on the import (a whole search); one set just follows along here */
  private add(sets: FoundSet[], window = false): void {
    if (!this.status?.ready) return void toast(this.lazerReason(), { kind: "danger", timeout: 3500 });
    const unicode = store.prefs.unicode;
    const how = importSets(sets.map((s) => ({ id: s.id, title: `${(unicode && s.artistUnicode) || s.artist} - ${(unicode && s.titleUnicode) || s.title}` })));
    for (const s of sets) this.renderAction(s.id);
    if (how === "none") return;
    if (window) openImport();
    else if (how === "queued") toast(t("Added after the import that's running"), { timeout: 2600 });
  }

  private async addAll(): Promise<void> {
    const sets = this.addable();
    if (!sets.length) return;
    if (sets.length >= ASK_FROM) {
      const ok = await uiConfirm(t("They download from the mirrors a few at a time and go into osu!lazer, which stays closed until they're in."), {
        title: tn(sets.length, "Add {n} set?", "Add {n} sets?"),
        confirmLabel: t("Add them"),
      });
      if (!ok) return;
    }
    this.add(sets, true);
  }

  private toggle(id: number): void {
    const el = this.el.querySelector<HTMLElement>(`.br-set[data-set="${id}"]`);
    const s = this.sets.find((x) => x.id === id);
    if (!el || !s) return;
    const open = !this.open.has(id);
    if (open) this.open.add(id);
    else this.open.delete(id);
    el.classList.toggle("open", open);
    el.querySelector(".br-row")!.setAttribute("aria-expanded", String(open));
    el.querySelector(".br-diffs")?.remove();
    if (open) el.insertAdjacentHTML("beforeend", this.diffsHtml(s));
  }

  private menu(at: { x: number; y: number }, s: FoundSet): void {
    const lib = libraryIndex();
    const entries: MenuEntry[] = [];
    if (lib.lazer.has(s.id)) entries.push({ label: t("Open in library"), icon: "library", action: () => openLibrarySet(s.id) });
    else entries.push({ label: t("Add to osu!lazer"), icon: "download", disabled: !this.status?.ready, action: () => this.add([s]) });
    entries.push(
      { label: preview?.set === s.id ? t("Stop the preview") : t("Play the preview"), icon: preview?.set === s.id ? "pause" : "play", action: () => playPreview(s) },
      "sep",
      { label: t("View on osu! website"), icon: "external", action: () => void openUrl(setUrl(s.id)) },
      { label: t("Copy link"), icon: "link", action: () => void navigator.clipboard.writeText(setUrl(s.id)).then(() => toast(t("Link copied"), { kind: "success", timeout: 2000 })) },
    );
    openMenu(at, entries, { minWidth: 220 });
  }

  private openFilters(anchor: HTMLElement): void {
    const q = this.q;
    const entries: MenuEntry[] = [{ group: t("Status") }];
    for (const s of STATUS_FILTERS) {
      entries.push({
        label: s.label,
        checked: s.values.every((v) => q.status.includes(v)),
        keepOpen: true,
        action: () => {
          const on = s.values.every((v) => q.status.includes(v));
          const set = new Set(q.status);
          for (const v of s.values) on ? set.delete(v) : set.add(v);
          q.status = [...set].sort((a, b) => a - b);
          this.syncControls();
          this.search();
          return !on;
        },
      });
    }
    const header = starRange({ min: q.srMin ?? 0, max: q.srMax ?? Infinity }, (min, max) => {
      q.srMin = min > 0 ? min : null;
      q.srMax = max === Infinity ? null : max;
      this.syncControls();
      this.search();
    });
    openMenu(anchor, entries, { minWidth: 260, className: "filters-menu", header });
  }

  // ── input ─────────────────────────────────────────────────────────────

  private bind(): void {
    const input = this.el.querySelector<HTMLInputElement>(".br-search input")!;
    input.addEventListener("input", () => {
      clearTimeout(this.textTimer);
      this.textTimer = window.setTimeout(() => {
        if (input.value.trim() === this.q.text) return;
        this.q.text = input.value.trim();
        this.search();
      }, 450);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      clearTimeout(this.textTimer);
      this.q.text = input.value.trim();
      this.search();
    });

    this.el.addEventListener("click", (e) => {
      const target = e.target as Element;
      const mode = target.closest<HTMLElement>(".lib-modes [data-mode]");
      if (mode) {
        const m = +mode.dataset.mode!;
        this.q.mode = m < 0 ? null : m;
        if (m !== 3) this.q.keys = [];
        this.syncControls();
        return this.search();
      }
      const k = target.closest<HTMLElement>(".lib-keys [data-keys]");
      if (k) {
        const n = +k.dataset.keys!;
        this.q.keys = this.q.keys.includes(n) ? this.q.keys.filter((x) => x !== n) : [...this.q.keys, n].sort((a, b) => a - b);
        this.syncControls();
        return this.search();
      }
      if (target.closest(".br-filters-btn")) return this.openFilters(target.closest<HTMLElement>(".br-filters-btn")!);
      if (target.closest(".br-recheck")) return void this.refreshStatus();
      if (target.closest(".br-retry")) return this.load(this.sets.length > 0);
      if (target.closest(".br-more")) return this.load(true);
      if (target.closest(".br-add-all")) return void this.addAll();
      const row = target.closest<HTMLElement>(".br-set");
      if (!row) return;
      const s = this.sets.find((x) => x.id === +row.dataset.set!);
      if (!s) return;
      if (target.closest(".br-play")) return playPreview(s);
      if (target.closest(".br-add")) return this.add([s]);
      if (target.closest(".br-open")) return openLibrarySet(s.id);
      if (target.closest(".br-state")) return openImport();
      if (target.closest(".br-row")) this.toggle(s.id);
    });
    this.el.addEventListener("keydown", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".br-row");
      if (!row || e.target !== row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      this.toggle(+row.closest<HTMLElement>(".br-set")!.dataset.set!);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".br-set");
      const s = row && this.sets.find((x) => x.id === +row.dataset.set!);
      if (!s) return;
      e.preventDefault();
      this.menu({ x: e.clientX, y: e.clientY }, s);
    });
    // a cover that won't load leaves the placeholder
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
    clearTimeout(this.textTimer);
    this.io.disconnect();
    this.offs.forEach((f) => f());
    previewEvents.delete(this.onPreview);
    stopPreview();
    this.el.remove();
  }
}

interface LibraryIndex {
  lazer: Set<number>;
  stable: Set<number>;
}

/** The library's sets by osu!'s id: in lazer, and in osu!stable only. */
function libraryIndex(): LibraryIndex {
  const lazer = new Set<number>();
  const stable = new Set<number>();
  for (const s of store.snap?.sets ?? []) {
    if (!s.onlineId || !s.maps.length) continue;
    (s.from === "stable" ? stable : lazer).add(s.onlineId);
  }
  return { lazer, stable };
}

function openLibrarySet(id: number): void {
  const i = store.snap?.sets.findIndex((s) => s.onlineId === id && s.from !== "stable" && s.maps.length) ?? -1;
  if (i >= 0) openSet(i);
}

const sameStatus = (a: number[], b: number[]) => a.length === b.length && b.every((v) => a.includes(v));
const trim = (v: number) => String(Math.round(v * 10) / 10);

function diffTip(m: FoundMap): string {
  return `${m.mode === 3 ? `${Math.round(m.cs)}K · ` : ""}${m.version}`;
}

/** A set on its way into osu!lazer: where it is (a click opens Add beatmaps). */
function stateHtml(st: SetImport): string {
  const share = st.total ? st.done / st.total : 0;
  const text: Record<SetImport["stage"], string> = {
    queued: t("Queued"),
    waiting: t("Waiting"),
    resolving: t("Waiting"),
    downloading: st.total ? pct(share, 0) : t("Downloading"),
    held: t("Mirrors busy"),
    ready: t("Downloaded"),
    importing: t("Importing"),
    done: t("Imported"),
    skipped: st.message ? fromRust(st.message) : t("Skipped"),
    error: t("Failed"),
  };
  const done = st.stage === "done" || st.stage === "skipped";
  const bar = st.stage === "downloading" && st.total ? `<i class="br-state-bar" style="--p:${Math.round(share * 100)}%"></i>` : "";
  return `<button class="br-state${done ? " done" : ""}" type="button" data-tip="${t("Open Add beatmaps")}">${done ? icon("check") : ""}<span>${esc(text[st.stage])}</span>${bar}</button>`;
}
