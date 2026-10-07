/* home.ts — the start page: a greeting, shelves of what you played and added lately, and a
 * panel of quick picks to jump into. Everything is derived from the local library.
 */
import { thumbUrl } from "../lib/api";
import { displayArtist, displayTitle, esc, num, relativeTime } from "../lib/format";
import { events, store } from "../lib/store";
import type { SetRow } from "../lib/types";
import { player } from "../player";
import { type IconName, icon } from "../ui/icons";
import { openSet, setMenu } from "./actions";

const SHELF_SIZE = 24;
const PICK_PAGES = 3;
const PICKS_PER_PAGE = 9;

interface Shelf {
  key: string;
  title: string;
  sets: number[];
  /** small third line under a card */
  meta: (si: number) => string;
}

function greeting(hour: number): { icon: IconName; before: string; after: string } {
  if (hour >= 5 && hour < 11) return { icon: "sunrise", before: "Good morning", after: "" };
  if (hour >= 11 && hour < 14) return { icon: "sun", before: "Hello", after: "" };
  if (hour >= 14 && hour < 18) return { icon: "cloud-sun", before: "Good afternoon", after: "" };
  if (hour >= 18 && hour < 23) return { icon: "sunset", before: "Good evening", after: "" };
  return { icon: "moon", before: "Still up", after: "?" };
}

export class HomeView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  /** quick picks by set id, so they survive a rescan (indices shift) */
  private pickIds: string[] = [];
  private page = 0;
  private picks: number[] = [];
  private greetIcon: IconName | null = null;

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view home-view";
    this.render();
    this.bind();
    this.offs.push(
      events.on("library", () => this.render()),
      events.on("prefs", (p) => {
        if ("unicode" in p || "mode" in p) this.render();
      }),
      player.bus.on("track", () => this.syncPlaying()),
      player.bus.on("state", () => this.syncPlaying()),
    );
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

  private shelves(pool: number[]): Shelf[] {
    const snap = store.snap!;
    const lastPlayed = (si: number) => snap.sets[si].maps.reduce((m, mi) => Math.max(m, snap.maps[mi].played ?? 0), 0);
    const plays = (si: number) => snap.sets[si].maps.reduce((n, mi) => n + (snap.maps[mi].best?.plays ?? 0), 0);
    const top = (score: (si: number) => number, keep: (si: number) => boolean = () => true) =>
      pool
        .filter(keep)
        .map((si) => [si, score(si)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, SHELF_SIZE)
        .map(([si]) => si);
    const monthAgo = Date.now() - 30 * 86_400_000;
    const playsLabel = (si: number) => {
      const n = plays(si);
      return `${num(n)} play${n === 1 ? "" : "s"}`;
    };
    const shelves: Shelf[] = [
      {
        key: "played",
        title: "Recently played",
        sets: top(lastPlayed, (si) => lastPlayed(si) > 0),
        meta: (si) => relativeTime(lastPlayed(si)),
      },
      {
        key: "added",
        title: "Recently added",
        sets: top((si) => snap.sets[si].added ?? 0),
        meta: (si) => (snap.sets[si].added ? relativeTime(snap.sets[si].added!) : ""),
      },
      {
        key: "most",
        title: "Most played",
        sets: top(plays, (si) => plays(si) > 1),
        meta: playsLabel,
      },
      {
        key: "again",
        title: "Haven't played in a while",
        sets: top(plays, (si) => plays(si) > 1 && lastPlayed(si) > 0 && lastPlayed(si) < monthAgo),
        meta: (si) => `Last played ${relativeTime(lastPlayed(si))}`,
      },
    ];
    return shelves.filter((s) => s.sets.length > 0);
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

  // ── rendering ─────────────────────────────────────────────────────────

  private render(): void {
    const snap = store.snap;
    if (!snap) return;
    const pool = this.pool();
    const shelves = this.shelves(pool);
    this.picks = this.pickSets(pool);
    this.page = Math.min(this.page, Math.max(0, Math.ceil(this.picks.length / PICKS_PER_PAGE) - 1));
    const g = greeting(new Date().getHours());
    this.greetIcon = g.icon;
    const name = snap.user?.name;
    const total = snap.sets.filter((s) => s.maps.length).length;

    const [first, ...rest] = shelves;
    this.el.innerHTML = `
      <header class="home-hero">
        <div class="hero-icon">${icon(g.icon)}</div>
        <h1 class="hero-title">${esc(g.before)}${name ? `, <span class="hero-name">${esc(name)}</span>` : ""}${esc(g.after)}</h1>
        <p class="hero-sub num">${num(total)} beatmap sets · ${num(snap.maps.length)} difficulties${snap.scannedAt ? ` · updated ${relativeTime(snap.scannedAt)}` : ""}</p>
      </header>
      ${
        pool.length
          ? `<div class="home-top">
              <div class="home-top-shelves">${[first, rest[0]].filter(Boolean).map((s) => this.shelfHtml(s)).join("")}</div>
              ${this.picks.length ? this.dialHtml() : ""}
            </div>
            ${rest.slice(1).map((s) => this.shelfHtml(s)).join("")}`
          : `<div class="empty-state">${icon("collection-duo")}<div class="empty-title">Nothing to show yet</div><div class="empty-sub">${
              store.prefs.mode >= 0 ? "No sets for the ruleset picked in your library." : "Your library is empty."
            }</div></div>`
      }`;
    this.shelfData = new Map(shelves.map((s) => [s.key, s.sets]));
    this.el.querySelectorAll<HTMLElement>(".shelf-track").forEach((t) => this.syncFades(t));
    this.renderDialPage(false);
    this.syncPlaying();
  }

  private shelfData = new Map<string, number[]>();

  private shelfHtml(s: Shelf): string {
    return `
      <section class="shelf" data-shelf="${s.key}">
        <div class="shelf-head">
          <h2 class="section-title">${esc(s.title)}</h2>
          <div class="pager">
            <button class="pager-btn" type="button" data-dir="-1" aria-label="Scroll left">${icon("chevron-left")}</button>
            <button class="pager-btn" type="button" data-dir="1" aria-label="Scroll right">${icon("chevron-right")}</button>
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
          <button class="card-play" type="button" aria-label="Play preview">${icon("play", "ic-play")}${icon("pause", "ic-pause")}</button>
        </div>
        <div class="card-title">${esc(displayTitle(set, unicode))}</div>
        <div class="card-sub">${esc(displayArtist(set, unicode))}</div>
        ${meta ? `<div class="card-meta">${esc(meta)}</div>` : ""}
      </div>`;
  }

  private dialHtml(): string {
    const pages = Math.ceil(this.picks.length / PICKS_PER_PAGE);
    return `
      <aside class="dial">
        <div class="dial-head">
          <span class="label-caps">Quick picks</span>
          <button class="icon-btn sm dial-reroll" type="button" data-tip="New picks" aria-label="New picks">${icon("shuffle")}</button>
          <div class="pager">
            <button class="pager-btn" type="button" data-page="-1" aria-label="Previous page">${icon("chevron-left")}</button>
            <button class="pager-btn" type="button" data-page="1" aria-label="Next page">${icon("chevron-right")}</button>
          </div>
        </div>
        <div class="dial-grid"></div>
        <div class="dial-dots">${Array.from({ length: pages }, (_, i) => `<button type="button" data-dot="${i}" aria-label="Page ${i + 1}"></button>`).join("")}</div>
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
    scope.querySelectorAll<HTMLElement>(`.card[data-set="${np.set}"], .tile[data-set="${np.set}"]`).forEach((n) => {
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
      const tile = t.closest<HTMLElement>(".tile[data-set]");
      if (tile) {
        player.playSet(+tile.dataset.set!, undefined, this.picks);
        return;
      }
      const card = t.closest<HTMLElement>(".card[data-set]");
      if (!card) return;
      const si = +card.dataset.set!;
      if (t.closest(".card-play")) {
        const shelf = card.closest<HTMLElement>(".shelf")!.dataset.shelf!;
        player.playSet(si, undefined, this.shelfData.get(shelf));
        return;
      }
      openSet(si);
    });

    el.addEventListener("contextmenu", (e) => {
      const item = (e.target as Element).closest<HTMLElement>(".card[data-set], .tile[data-set]");
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
    this.syncPlaying();
  }

  destroy(): void {
    this.offs.forEach((f) => f());
    this.el.remove();
  }
}
