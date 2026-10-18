/* home.ts — the start page: a greeting over a bento of tiles, each with one job. Where you left
 * off (the last play from osu!lazer, else the last set played), this session, your goals (or this
 * week), what you played and added lately, quick picks to jump into, your collections, and the
 * sets you play most and haven't played in a while. Everything comes from the local library, the
 * replays lazer saved (live.ts) and the play history.
 */
import { api, onLivePlay, thumbUrl } from "../lib/api";
import { displayArtist, displayTitle, duration, esc, num, pct, rankInfo, relativeTime } from "../lib/format";
import { events, setPrefs, store } from "../lib/store";
import type { LivePlay, SetRow } from "../lib/types";
import { isBest, playMods, rankNumber, sessionStart, summary } from "../lib/live";
import { collectionMaps, collectionEvents, fumenCollections } from "../lib/collections";
import { currentContext, goalEvents, goalsNow } from "../lib/goals-store";
import { goalNow, goalTarget, goalTitle, goalValue, progress } from "../lib/goals";
import { historyEvents, historyNow, loadHistory } from "../lib/history";
import { go } from "../lib/router";
import { player } from "../player";
import { type IconName, icon } from "../ui/icons";
import { openSet, setMenu } from "./actions";
import { t, tn } from "../lib/i18n";

const SHELF_SIZE = 24;
const LIST_SIZE = 5;
const PICK_PAGES = 3;
const PICKS_PER_PAGE = 9;
/** the last play stays "where you left off" this long */
const CONTINUE_FOR = 3 * 86_400_000;
const WEEK = 7 * 86_400_000;

interface Shelf {
  key: string;
  title: string;
  sets: number[];
  /** small third line under a card */
  meta: (si: number) => string;
}

function greeting(hour: number): { icon: IconName; before: string; after: string } {
  if (hour >= 5 && hour < 11) return { icon: "sunrise", before: t("Good morning"), after: "" };
  if (hour >= 11 && hour < 14) return { icon: "sun", before: t("Hello"), after: "" };
  if (hour >= 14 && hour < 18) return { icon: "cloud-sun", before: t("Good afternoon"), after: "" };
  if (hour >= 18 && hour < 23) return { icon: "sunset", before: t("Good evening"), after: "" };
  return { icon: "moon", before: t("Still up"), after: "?" };
}

export class HomeView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  /** quick picks by set id, so they survive a rescan (indices shift) */
  private pickIds: string[] = [];
  private page = 0;
  private picks: number[] = [];
  private greetIcon: IconName | null = null;
  /** plays from lazer's replays, the last week, newest first */
  private live: LivePlay[] = [];
  /** sets per shelf and list, for playing them in order */
  private lists = new Map<string, number[]>();

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view home-view";
    this.render();
    this.bind();
    void this.loadLive();
    this.offs.push(
      events.on("library", () => this.render()),
      events.on("prefs", (p) => {
        if ("unicode" in p || "mode" in p) this.render();
        if ("companion" in p) this.renderSession();
      }),
      collectionEvents.on("collections", () => this.renderTile("collections")),
      goalEvents.on("goals", () => this.renderTile("progress")),
      historyEvents.on("history", () => this.renderTile("progress")),
      player.bus.on("track", () => this.syncPlaying()),
      player.bus.on("state", () => this.syncPlaying()),
    );
    void onLivePlay(() => void this.loadLive()).then((off) => this.offs.push(off));
  }

  private async loadLive(): Promise<void> {
    this.live = await api.livePlays(Date.now() - WEEK).catch(() => []);
    this.renderTile("continue");
    this.renderSession();
  }

  // ── data ──────────────────────────────────────────────────────────────

  /** Sets to show: the ruleset you picked in the library (if any), with difficulties. */
  private pool(): number[] {
    const snap = store.snap!;
    const mode = store.prefs.mode;
    const out: number[] = [];
    snap.sets.forEach((s, si) => {
      if (!s.maps.length) return;
      if (mode >= 0 && !s.maps.some((mi) => snap.maps[mi].mode === mode)) return;
      out.push(si);
    });
    return out;
  }

  private lastPlayed(si: number): number {
    const snap = store.snap!;
    return snap.sets[si].maps.reduce((m, mi) => Math.max(m, snap.maps[mi].played ?? 0), 0);
  }

  private plays(si: number): number {
    const snap = store.snap!;
    return snap.sets[si].maps.reduce((n, mi) => n + (snap.maps[mi].best?.plays ?? 0), 0);
  }

  private shelves(pool: number[]): Shelf[] {
    const snap = store.snap!;
    const lastPlayed = (si: number) => this.lastPlayed(si);
    const plays = (si: number) => this.plays(si);
    const top = (score: (si: number) => number, keep: (si: number) => boolean = () => true) =>
      pool
        .filter(keep)
        .map((si) => [si, score(si)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SHELF_SIZE)
        .map(([si]) => si);
    const monthAgo = Date.now() - 30 * 86_400_000;
    return [
      {
        key: "played",
        title: t("Recently played"),
        sets: top(lastPlayed, (si) => lastPlayed(si) > 0),
        meta: (si) => relativeTime(lastPlayed(si)),
      },
      {
        key: "added",
        title: t("Recently added"),
        sets: top((si) => snap.sets[si].added ?? 0),
        meta: (si) => (snap.sets[si].added ? relativeTime(snap.sets[si].added!) : ""),
      },
      {
        key: "most",
        title: t("Most played"),
        sets: top(plays, (si) => plays(si) > 1),
        meta: (si) => tn(plays(si), "{n} play", "{n} plays"),
      },
      {
        key: "again",
        title: t("Haven't played in a while"),
        sets: top(plays, (si) => plays(si) > 1 && lastPlayed(si) > 0 && lastPlayed(si) < monthAgo),
        meta: (si) => relativeTime(lastPlayed(si)),
      },
    ];
  }

  /** Random sets with artwork and audio; keeps earlier picks that still exist. */
  private pickSets(pool: number[], reroll = false): number[] {
    const snap = store.snap!;
    const byId = new Map<string, number>();
    pool.forEach((si) => byId.set(snap.sets[si].id, si));
    const want = PICK_PAGES * PICKS_PER_PAGE;
    const picked = reroll ? [] : this.pickIds.map((id) => byId.get(id)).filter((si): si is number => si !== undefined);
    const usable = pool.filter((si) => snap.sets[si].bg && (snap.sets[si].audio || snap.sets[si].maps.some((mi) => snap.maps[mi].audio)));
    const taken = new Set(picked);
    for (let tries = 0; picked.length < want && tries < want * 20 && usable.length > taken.size; tries++) {
      const si = usable[Math.floor(Math.random() * usable.length)];
      if (taken.has(si)) continue;
      taken.add(si);
      picked.push(si);
    }
    this.pickIds = picked.map((si) => snap.sets[si].id);
    return picked;
  }

  /** the library's set behind a play, or -1 */
  private setOf(p: LivePlay): number {
    return p.set ? store.snap!.sets.findIndex((s) => s.id === p.set) : -1;
  }

  // ── rendering ─────────────────────────────────────────────────────────

  private render(): void {
    const snap = store.snap;
    if (!snap) return;
    const pool = this.pool();
    const shelves = this.shelves(pool);
    this.picks = this.pickSets(pool);
    this.page = Math.min(this.page, Math.max(0, Math.ceil(this.picks.length / PICKS_PER_PAGE) - 1));
    this.lists = new Map(shelves.map((s) => [s.key, s.sets]));
    const g = greeting(new Date().getHours());
    this.greetIcon = g.icon;
    const name = snap.user?.name;
    const total = snap.sets.filter((s) => s.maps.length).length;
    const shelf = (key: string) => shelves.find((s) => s.key === key)!;

    this.el.innerHTML = `
      <header class="home-hero">
        <div class="hero-icon">${icon(g.icon)}</div>
        <h1 class="hero-title">${esc(g.before)}${name ? `, <span class="hero-name">${esc(name)}</span>` : ""}${esc(g.after)}</h1>
        <p class="hero-sub num">${tn(total, "{n} beatmap set", "{n} beatmap sets")} · ${tn(snap.maps.length, "{n} difficulty", "{n} difficulties")}${snap.scannedAt ? ` · ${t("updated {when}", { when: relativeTime(snap.scannedAt) })}` : ""}</p>
      </header>
      ${
        pool.length
          ? `<div class="bento">
              <article class="bt bt-continue" data-tile="continue"></article>
              <article class="bt bt-session" data-tile="session"></article>
              <article class="bt bt-progress" data-tile="progress"></article>
              ${this.shelfHtml(shelf("played"), "bt-played")}
              ${this.picks.length ? this.dialHtml() : ""}
              ${this.shelfHtml(shelf("added"), "bt-added")}
              <section class="bt bt-collections" data-tile="collections"></section>
              ${this.listHtml(shelf("most"), "bt-most")}
              ${this.listHtml(shelf("again"), "bt-again")}
            </div>`
          : `<div class="empty-state">${icon("collection-duo")}<div class="empty-title">${t("Nothing to show yet")}</div><div class="empty-sub">${
              store.prefs.mode >= 0 ? t("No sets for the ruleset picked in your library.") : t("Your library is empty.")
            }</div></div>`
      }`;
    for (const key of ["continue", "session", "progress", "collections"] as const) this.renderTile(key);
    this.el.querySelectorAll<HTMLElement>(".shelf-track").forEach((t) => this.syncFades(t));
    this.renderDialPage(false);
    this.syncPlaying();
  }

  private renderTile(key: "continue" | "session" | "progress" | "collections"): void {
    const el = this.el.querySelector<HTMLElement>(`[data-tile="${key}"]`);
    if (!el || !store.snap) return;
    el.innerHTML = key === "continue" ? this.continueHtml() : key === "session" ? this.sessionHtml() : key === "progress" ? this.progressHtml() : this.collectionsHtml();
    if (key === "continue") this.syncPlaying(el);
  }

  private renderSession(): void {
    this.renderTile("session");
  }

  /** where you left off: the last play from lazer, else the last set played, else the newest */
  private continueHtml(): string {
    const snap = store.snap!;
    const unicode = store.prefs.unicode;
    const recent = this.live.find((p) => Date.now() - p.date < CONTINUE_FOR && this.setOf(p) >= 0);
    let si = recent ? this.setOf(recent) : -1;
    let label = t("Where you left off");
    let line = "";
    if (si < 0) {
      si = this.lists.get("played")?.[0] ?? this.lists.get("added")?.[0] ?? -1;
      if (si < 0) return `<div class="bt-hint">${t("Nothing played yet")}</div>`;
      const last = this.lastPlayed(si);
      label = last ? t("Last played") : t("New in your library");
      line = last ? relativeTime(last) : snap.sets[si].added ? relativeTime(snap.sets[si].added!) : "";
    }
    const set: SetRow = snap.sets[si];
    const art = set.bg ? `<img class="bt-art" src="${thumbUrl(set.bg, 960)}" alt="" decoding="async" />` : "";
    let result = "";
    if (recent) {
      const g = rankInfo(rankNumber(recent.rank));
      const delta = recent.bestBefore === null ? null : recent.accuracy - recent.bestBefore;
      const best = isBest(recent);
      line = [recent.version ? `[${recent.version}]` : "", playMods(recent), relativeTime(recent.date)].filter(Boolean).join(" · ");
      result = `
        <div class="bt-result">
          <span class="bt-grade" style="--c:${g.color}">${g.label}</span>
          <span class="bt-acc"><b class="num">${pct(recent.accuracy)}</b><span class="num${best ? " up" : ""}">${
            delta === null ? t("First pass") : best ? t("New best, +{d}", { d: pct(delta) }) : t("{d} to your best", { d: pct(-delta) })
          }</span></span>
        </div>`;
    }
    return `
      <div class="bt-cover${set.bg ? "" : " img-missing"}">${art}<div class="bt-scrim"></div></div>
      <div class="bt-continue-body" data-set="${si}">
        <span class="label-caps">${esc(label)}</span>
        <div class="bt-continue-row">
          <div class="bt-continue-text">
            <h2 class="bt-title">${esc(displayTitle(set, unicode))}</h2>
            <div class="bt-sub">${esc(displayArtist(set, unicode))}${line ? ` <span>· ${esc(line)}</span>` : ""}</div>
          </div>
          ${result}
        </div>
        <div class="bt-actions">
          ${recent ? `<button class="btn btn-primary btn-sm" type="button" data-score="${esc(recent.id)}">${icon("radar")}${t("Show the score")}</button>` : ""}
          <button class="btn btn-sm bt-play" type="button" data-play="${si}">${icon("play", "ic-play")}${icon("pause", "ic-pause")}<span>${t("Listen")}</span></button>
          <button class="btn btn-ghost btn-sm" type="button" data-open="${si}">${t("Open the set")}</button>
        </div>
      </div>`;
  }

  /** this session from lazer's replays (plays since the last hour-long pause) */
  private sessionHtml(): string {
    const start = sessionStart(this.live);
    const plays = this.live.filter((p) => p.date >= start - 1);
    const companion = store.prefs.companion;
    const head = `
      <div class="bt-head">
        <span class="label-caps">${t("This session")}</span>
        <button class="bt-link" type="button" data-companion>${companion ? t("Companion window is open") : t("Open the companion window")}</button>
      </div>`;
    if (!plays.length) {
      const week = this.live.length;
      return `${head}<div class="bt-hint">${
        week ? tn(week, "No session right now. {n} pass this week.", "No session right now. {n} passes this week.") : t("Pass a map in osu!lazer and your session shows up here.")
      }</div>`;
    }
    const s = summary(plays);
    return `${head}
      <div class="bt-stats">
        <div><i>${t("Plays")}</i><b class="num">${num(s.plays)}</b></div>
        <div><i>${t("Played")}</i><b class="num">${s.time ? duration(s.time) : "–"}</b></div>
        <div><i>${t("Accuracy")}</i><b class="num">${s.accuracy === null ? "–" : pct(s.accuracy)}</b></div>
        <div><i>${t("New bests")}</i><b class="num${s.bests ? " up" : ""}">${num(s.bests)}</b></div>
      </div>`;
  }

  /** your goals, closest first; without any, this week from the play history */
  private progressHtml(): string {
    const goals = (goalsNow() ?? []).filter((g) => !g.done);
    const ctx = goals.length ? currentContext() : null;
    if (goals.length) {
      const rows = goals
        .map((g) => {
          const now = ctx ? goalNow(g, ctx) : null;
          return { g, now, p: progress(g, now) };
        })
        .sort((a, b) => b.p - a.p)
        .slice(0, 2);
      return `
        <div class="bt-head"><span class="label-caps">${t("Your goals")}</span><button class="bt-link" type="button" data-go="skills">${tn(goals.length, "{n} open", "{n} open")}</button></div>
        <div class="bt-goals">${rows
          .map(
            ({ g, now, p }) => `
          <div class="bt-goal">
            <div class="bt-goal-top"><b>${esc(goalTitle(g))}</b><span class="num">${now === null ? "–" : esc(goalValue(g, now))} / ${esc(goalTarget(g))}</span></div>
            <div class="bt-bar"><i style="width:${Math.round(p * 100)}%"></i></div>
          </div>`,
          )
          .join("")}</div>`;
    }
    const h = historyNow();
    if (!h) {
      void loadHistory().catch(() => {});
      return `<div class="bt-head"><span class="label-caps">${t("This week")}</span></div><div class="bt-hint">${t("Reading your plays…")}</div>`;
    }
    const since = Date.now() - WEEK;
    const week = h.plays.filter((p) => p.date >= since);
    const maps = new Set(week.map((p) => p.map ?? `b${p.beatmap ?? p.beatmapId}`));
    const acc = week.length ? week.reduce((a, p) => a + p.acc, 0) / week.length : null;
    return `
      <div class="bt-head"><span class="label-caps">${t("This week")}</span><button class="bt-link" type="button" data-go="history">${t("History")}</button></div>
      ${
        week.length
          ? `<div class="bt-stats three">
              <div><i>${t("Plays")}</i><b class="num">${num(week.length)}</b></div>
              <div><i>${t("Maps")}</i><b class="num">${num(maps.size)}</b></div>
              <div><i>${t("Accuracy")}</i><b class="num">${acc === null ? "–" : pct(acc)}</b></div>
            </div>`
          : `<div class="bt-hint">${t("No plays this week yet.")}</div>`
      }`;
  }

  /** Fumen's collections first, then lazer's and stable's, each with a few covers */
  private collectionsHtml(): string {
    const snap = store.snap!;
    const covers = (maps: Iterable<number>) => {
      const out: string[] = [];
      const seen = new Set<number>();
      for (const mi of maps) {
        const si = snap.maps[mi]?.set;
        if (si === undefined || seen.has(si)) continue;
        seen.add(si);
        const bg = snap.sets[si].bg;
        if (bg) out.push(bg);
        if (out.length === 4) break;
      }
      return out;
    };
    const all = [
      ...fumenCollections().map((c) => {
        const maps = collectionMaps(c);
        return { id: c.id, name: c.name, count: maps.size, covers: covers(maps) };
      }),
      ...snap.collections.map((c) => ({ id: c.id, name: c.name, count: c.maps.length, covers: covers(c.maps) })),
    ]
      .filter((c) => c.count > 0)
      .slice(0, 4);
    const head = `<div class="bt-head"><span class="label-caps">${t("Collections")}</span></div>`;
    if (!all.length) return `${head}<div class="bt-hint">${t("Make one with + in the sidebar, or drag sets onto it.")}</div>`;
    return `${head}
      <div class="bt-cols">${all
        .map(
          (c) => `
        <button class="bt-col" type="button" data-collection="${esc(c.id)}">
          <span class="bt-mosaic n${c.covers.length}">${c.covers.map((bg) => `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />`).join("") || icon("collection")}</span>
          <span class="bt-col-name">${esc(c.name)}</span>
          <span class="bt-col-n num">${tn(c.count, "{n} difficulty", "{n} difficulties")}</span>
        </button>`,
        )
        .join("")}</div>`;
  }

  private shelfHtml(s: Shelf, cls: string): string {
    if (!s.sets.length) return "";
    return `
      <section class="bt ${cls} shelf" data-shelf="${s.key}">
        <div class="shelf-head">
          <h2 class="section-title">${esc(s.title)}</h2>
          <div class="pager">
            <button class="pager-btn" type="button" data-dir="-1" aria-label="${t("Scroll left")}">${icon("chevron-left")}</button>
            <button class="pager-btn" type="button" data-dir="1" aria-label="${t("Scroll right")}">${icon("chevron-right")}</button>
          </div>
        </div>
        <div class="shelf-track">${s.sets.map((si) => this.cardHtml(si, s.meta(si))).join("")}</div>
      </section>`;
  }

  private cardHtml(si: number, meta: string): string {
    const set: SetRow = store.snap!.sets[si];
    const unicode = store.prefs.unicode;
    return `
      <div class="card hcard" data-set="${si}">
        <div class="card-art${set.bg ? "" : " img-missing"}">
          ${set.bg ? `<img src="${thumbUrl(set.bg, 360)}" alt="" loading="lazy" decoding="async" />` : ""}
          <button class="card-play" type="button" aria-label="${t("Play")}">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</button>
        </div>
        <div class="card-title">${esc(displayTitle(set, unicode))}</div>
        <div class="card-sub">${esc(displayArtist(set, unicode))}</div>
        ${meta ? `<div class="card-meta">${esc(meta)}</div>` : ""}
      </div>`;
  }

  /** a short list: cover, title, artist, and the line that says why it's here */
  private listHtml(s: Shelf, cls: string): string {
    if (!s.sets.length) return "";
    const snap = store.snap!;
    const unicode = store.prefs.unicode;
    return `
      <section class="bt bt-list ${cls}" data-shelf="${s.key}">
        <div class="bt-head"><h2 class="section-title">${esc(s.title)}</h2></div>
        <div class="bt-rows">${s.sets
          .slice(0, LIST_SIZE)
          .map((si) => {
            const set = snap.sets[si];
            return `
          <div class="bt-row card" data-set="${si}">
            <div class="bt-row-art card-art${set.bg ? "" : " img-missing"}">
              ${set.bg ? `<img src="${thumbUrl(set.bg, 120)}" alt="" loading="lazy" decoding="async" />` : ""}
              <button class="card-play" type="button" aria-label="${t("Play")}">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</button>
            </div>
            <div class="bt-row-text"><b>${esc(displayTitle(set, unicode))}</b><span>${esc(displayArtist(set, unicode))}</span></div>
            <span class="bt-row-meta num">${esc(s.meta(si))}</span>
          </div>`;
          })
          .join("")}</div>
      </section>`;
  }

  private dialHtml(): string {
    const pages = Math.ceil(this.picks.length / PICKS_PER_PAGE);
    return `
      <aside class="bt bt-picks dial">
        <div class="dial-head">
          <span class="label-caps">${t("Quick picks")}</span>
          <button class="icon-btn sm dial-reroll" type="button" data-tip="${t("New picks")}" aria-label="${t("New picks")}">${icon("shuffle")}</button>
          <div class="pager">
            <button class="pager-btn" type="button" data-page="-1" aria-label="${t("Previous page")}">${icon("chevron-left")}</button>
            <button class="pager-btn" type="button" data-page="1" aria-label="${t("Next page")}">${icon("chevron-right")}</button>
          </div>
        </div>
        <div class="dial-grid"></div>
        <div class="dial-dots">${Array.from({ length: pages }, (_, i) => `<button type="button" data-dot="${i}" aria-label="${t("Page {n}", { n: i + 1 })}"></button>`).join("")}</div>
      </aside>`;
  }

  private renderDialPage(animate = true): void {
    const grid = this.el.querySelector<HTMLElement>(".dial-grid");
    if (!grid) return;
    const snap = store.snap!;
    const unicode = store.prefs.unicode;
    const items = this.picks.slice(this.page * PICKS_PER_PAGE, (this.page + 1) * PICKS_PER_PAGE);
    grid.innerHTML = Array.from({ length: PICKS_PER_PAGE }, (_, i) => {
      const si = items[i];
      if (si === undefined) return `<div class="tile tile-empty"></div>`; // keeps the panel's height
      const set = snap.sets[si];
      return `
        <div class="tile" data-set="${si}" style="--k:${i}">
          <img src="${thumbUrl(set.bg!, 360)}" alt="" decoding="async" />
          <div class="tile-text"><div class="tile-title">${esc(displayTitle(set, unicode))}</div><div class="tile-sub">${esc(displayArtist(set, unicode))}</div></div>
          <span class="tile-play">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</span>
        </div>`;
    }).join("");
    grid.classList.toggle("turn", animate);
    const pages = Math.ceil(this.picks.length / PICKS_PER_PAGE);
    this.el.querySelectorAll<HTMLElement>("[data-dot]").forEach((d) => d.classList.toggle("on", +d.dataset.dot! === this.page));
    this.el.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((b) => (b.disabled = pages < 2));
    this.syncPlaying(grid);
  }

  private syncFades(track: HTMLElement): void {
    const max = track.scrollWidth - track.clientWidth;
    const left = track.scrollLeft > 2;
    const right = track.scrollLeft < max - 2;
    track.classList.toggle("more-left", left);
    track.classList.toggle("more-right", right);
    const btns = track.closest(".shelf")?.querySelectorAll<HTMLButtonElement>(".pager-btn");
    if (btns) {
      btns[0].disabled = !left;
      btns[1].disabled = !right;
    }
  }

  private syncPlaying(scope: ParentNode = this.el): void {
    const np = player.now;
    scope.querySelectorAll<HTMLElement>(".playing").forEach((n) => n.classList.remove("playing", "paused"));
    if (!np) return;
    scope.querySelectorAll<HTMLElement>(`.card[data-set="${np.set}"], .tile[data-set="${np.set}"], .bt-play[data-play="${np.set}"]`).forEach((n) => {
      n.classList.add("playing");
      n.classList.toggle("paused", !player.playing);
    });
  }

  // ── events ────────────────────────────────────────────────────────────

  private bind(): void {
    const el = this.el;
    el.addEventListener("click", (e) => {
      const t = e.target as Element;
      const pager = t.closest<HTMLButtonElement>(".shelf .pager-btn");
      if (pager) {
        const track = pager.closest(".shelf")!.querySelector<HTMLElement>(".shelf-track")!;
        track.scrollBy({ left: +pager.dataset.dir! * track.clientWidth * 0.85, behavior: "smooth" });
        return;
      }
      const pageBtn = t.closest<HTMLElement>("[data-page], [data-dot]");
      if (pageBtn) {
        const pages = Math.ceil(this.picks.length / PICKS_PER_PAGE);
        const target = pageBtn.dataset.dot !== undefined ? +pageBtn.dataset.dot : (this.page + +pageBtn.dataset.page! + pages) % pages;
        if (target !== this.page) {
          this.page = target;
          this.renderDialPage();
        }
        return;
      }
      if (t.closest(".dial-reroll")) {
        this.picks = this.pickSets(this.pool(), true);
        this.page = 0;
        this.renderDialPage();
        return;
      }
      const score = t.closest<HTMLElement>("[data-score]");
      if (score) return go({ name: "score", id: score.dataset.score! });
      const play = t.closest<HTMLElement>("[data-play]");
      if (play) {
        const si = +play.dataset.play!;
        if (player.now?.set === si) player.toggle();
        else player.playSet(si);
        return;
      }
      const open = t.closest<HTMLElement>("[data-open]");
      if (open) return openSet(+open.dataset.open!);
      const col = t.closest<HTMLElement>("[data-collection]");
      if (col) return go({ name: "collection", id: col.dataset.collection! });
      const to = t.closest<HTMLElement>("[data-go]");
      if (to) return go({ name: to.dataset.go as "skills" | "history" });
      if (t.closest("[data-companion]")) {
        const on = !store.prefs.companion;
        setPrefs({ companion: on });
        void (on ? api.openCompanion() : api.closeCompanion()).catch(() => {});
        return;
      }
      const tile = t.closest<HTMLElement>(".tile[data-set]");
      if (tile) {
        player.playSet(+tile.dataset.set!, undefined, this.picks);
        return;
      }
      const card = t.closest<HTMLElement>(".card[data-set]");
      if (!card) return;
      const si = +card.dataset.set!;
      if (t.closest(".card-play")) {
        const shelf = card.closest<HTMLElement>("[data-shelf]")?.dataset.shelf;
        player.playSet(si, undefined, shelf ? this.lists.get(shelf) : undefined);
        return;
      }
      openSet(si);
    });

    el.addEventListener("contextmenu", (e) => {
      const item = (e.target as Element).closest<HTMLElement>(".card[data-set], .tile[data-set], .bt-continue-body[data-set]");
      if (!item) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY }, +item.dataset.set!, undefined, { onSearch: (q) => events.emit("search", q) });
    });

    el.addEventListener("scroll", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList?.contains("shelf-track")) this.syncFades(t);
    }, true);

    new ResizeObserver(() => this.el.querySelectorAll<HTMLElement>(".shelf-track").forEach((t) => this.syncFades(t))).observe(el);

    el.addEventListener("load", (e) => (e.target as HTMLElement).classList?.add("loaded"), true);
    el.addEventListener("error", (e) => {
      const img = e.target as HTMLElement;
      if (img.tagName === "IMG") img.parentElement?.classList.add("img-missing");
    }, true);
  }

  shown(): void {
    // the app may have stayed open since the morning
    if (this.greetIcon && greeting(new Date().getHours()).icon !== this.greetIcon) return this.render();
    this.el.querySelectorAll<HTMLElement>(".shelf-track").forEach((t) => this.syncFades(t));
    this.renderTile("continue");
    this.renderSession();
    this.syncPlaying();
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
