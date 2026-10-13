/* similar.ts — "Similar maps" in the set page's chart panel: the difficulties in the library most
 * like this one (lib/similar.ts), closest first, each with what sets it apart. */
import { thumbUrl } from "../lib/api";
import { bpm, displayTitle, esc, srChip } from "../lib/format";
import { differences, mainPattern, similarTo, type Similar } from "../lib/similar";
import { store } from "../lib/store";
import type { MapRow } from "../lib/types";
import { openSet, setMenu } from "./actions";

/** listed before "Show more", and with it */
const FEW = 5;
const MORE = 15;

export class SimilarMaps {
  readonly el: HTMLElement;
  private all = false;
  private list: Similar[] = [];

  constructor(private mapIdx: number) {
    this.el = document.createElement("div");
    this.el.className = "similar";
    const snap = store.snap!;
    const map = snap.maps[mapIdx];
    // the same song and difficulty name in another set is the same chart uploaded again
    const same = (m: MapRow) => `${snap.sets[m.set]?.title.toLowerCase()} / ${m.version.toLowerCase()}`;
    this.list = similarTo(map, snap.maps, { limit: MORE, excludeSet: map.set, same });
    this.render();
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      if (t.closest(".similar-more")) {
        this.all = !this.all;
        this.render();
        this.el.querySelector<HTMLElement>(".similar-more")?.focus();
        return;
      }
      const row = t.closest<HTMLElement>(".sim-row");
      if (row) open(+row.dataset.map!);
    });
    this.el.addEventListener("keydown", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".sim-row");
      if (!row || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      open(+row.dataset.map!);
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
    this.el.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".sim-row");
      if (!row) return;
      e.preventDefault();
      const mi = +row.dataset.map!;
      setMenu({ x: e.clientX, y: e.clientY }, store.snap!.maps[mi].set, mi);
    });
  }

  private render(): void {
    const snap = store.snap!;
    const map = snap.maps[this.mapIdx];
    const head = `<div class="similar-head"><div class="label-caps">Similar maps</div><span class="similar-sub">${esc(basis(map))}</span></div>`;
    if (!this.list.length) {
      this.el.innerHTML = `${head}<p class="chart-note">Nothing in your library is much like this one${map.mode === 3 ? ` in ${Math.round(map.cs)}K` : ""}.</p>`;
      return;
    }
    const shown = this.all ? this.list : this.list.slice(0, FEW);
    this.el.innerHTML = `
      ${head}
      <div class="sim-list">${shown.map((s) => row(map, s)).join("")}</div>
      ${this.list.length > FEW ? `<button class="btn btn-ghost btn-sm similar-more" type="button">${this.all ? "Show fewer" : "Show more"}</button>` : ""}`;
  }

  /** Scrolls the section into view (asked for from a menu). */
  reveal(): void {
    requestAnimationFrame(() => this.el.scrollIntoView({ block: "center", behavior: "smooth" }));
  }

  destroy(): void {
    this.el.remove();
  }
}

function open(mi: number): void {
  const m = store.snap?.maps[mi];
  if (m) openSet(m.set, mi);
}

/** What "alike" means in the chart's ruleset. */
function basis(m: MapRow): string {
  switch (m.mode) {
    case 3:
      return "pattern mix, star rating, density and long notes";
    case 1:
      return "star rating, BPM and density";
    case 2:
      return "star rating, BPM, approach rate and fruit size";
    default:
      return "star rating, BPM, approach rate and circle size";
  }
}

/** One alike difficulty: what it is, what sets it apart, its star rating and how alike it is. */
function row(target: MapRow, s: Similar): string {
  const snap = store.snap!;
  const m = snap.maps[s.mapIdx];
  const set = snap.sets[m.set];
  const bg = m.bg ?? set.bg;
  const trait = m.mode === 3 ? mainPattern(m) : m.bpm ? `${bpm(m.bpm)} BPM` : "";
  const apart = differences(target, m, s);
  const sub = [esc(m.version), trait, apart.length ? apart.join(", ") : "much the same"].filter(Boolean).join(" · ");
  const pct = Math.round(s.score * 100);
  return `
    <div class="sim-row" data-map="${s.mapIdx}" role="button" tabindex="0">
      <span class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text">
        <div class="t-title">${esc(displayTitle(set, store.prefs.unicode))}</div>
        <div class="t-sub">${sub}</div>
      </div>
      <span class="sim-sr">${srChip(m.sr)}</span>
      <b class="num sim-score" data-tip="${pct}% alike">${pct}%</b>
    </div>`;
}
