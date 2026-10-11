/* skills.ts — how good you are at each osu!mania pattern (see lib/skills.ts for how it's worked
 * out): a radar now and 90 days ago, and per pattern the charts behind the number.
 */
import { thumbUrl } from "../lib/api";
import { displayTitle, esc, num, pct, srChip } from "../lib/format";
import { historyEvents, historyNow, loadHistory, mapIndexOf, modsText, playWhen } from "../lib/history";
import {
  bestPerChart, chartStars, keyModes, MIN_CHARTS, MIN_SHARE, PATTERN_LABEL, PATTERNS, rateOf, REF_ACC, skills, TOP, type Skill,
} from "../lib/skills";
import { events, store } from "../lib/store";
import type { Play } from "../lib/types";
import { attachSegIndicator } from "../ui/controls";
import { icon } from "../ui/icons";
import { openSet } from "./actions";

/** the comparison polygon: skills as they were this long ago */
const THEN_MS = 90 * 86_400_000;

export class SkillsView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  /** key mode shown (null: the most played) */
  private keys: number | null = null;
  /** patterns whose charts are open */
  private open = new Set<string>();

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view skills-view";
    this.el.innerHTML = `
      <header class="view-head skills-head">
        <div>
          <h1 class="view-title">Skills</h1>
          <div class="view-sub skills-sub meta-line num"></div>
        </div>
        <div class="seg-pill skills-keys" role="tablist" aria-label="Keys"></div>
      </header>
      <div class="skills-body"></div>`;
    this.bind();
    this.offs.push(
      historyEvents.on("history", () => this.render()),
      events.on("library", () => this.render()),
      events.on("prefs", (p) => {
        if ("unicode" in p) this.render();
      }),
    );
    this.render();
    loadHistory().then(
      () => this.render(),
      () => this.render(),
    );
  }

  private render(): void {
    const h = historyNow();
    const snap = store.snap;
    const body = this.el.querySelector<HTMLElement>(".skills-body")!;
    const sub = this.el.querySelector<HTMLElement>(".skills-sub")!;
    const keysEl = this.el.querySelector<HTMLElement>(".skills-keys")!;
    if (!h || !snap) {
      body.innerHTML = `<div class="skills-loading"><div class="skeleton" style="height:360px"></div></div>`;
      return;
    }
    const modes = keyModes(h.plays, mapIndexOf, snap.maps);
    if (!modes.length) {
      sub.innerHTML = "";
      keysEl.hidden = true;
      body.innerHTML = `
        <div class="empty-state skills-empty">${icon("radar")}
          <div class="empty-title">Skills come from your osu!mania plays</div>
          <div class="empty-sub">Fumen reads the patterns of osu!mania charts. Once you've passed some that are in your library, you'll see here what you're good at.</div>
        </div>`;
      return;
    }
    const keys = this.keys !== null && modes.some((m) => m.keys === this.keys) ? this.keys : modes[0].keys;
    keysEl.hidden = modes.length < 2;
    const pills = modes.map((m) => `<button type="button" data-keys="${m.keys}" class="${m.keys === keys ? "active" : ""}">${m.keys}K</button>`).join("");
    if (keysEl.dataset.list !== modes.map((m) => m.keys).join()) {
      keysEl.dataset.list = modes.map((m) => m.keys).join();
      keysEl.innerHTML = pills;
      attachSegIndicator(keysEl);
    } else keysEl.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("active", +b.dataset.keys! === keys));

    const charts = bestPerChart(h.plays, mapIndexOf, snap.maps, keys);
    const now = skills(charts);
    const then = skills(bestPerChart(h.plays, mapIndexOf, snap.maps, keys, Date.now() - THEN_MS));
    const plays = charts.length;
    sub.innerHTML = [`osu!mania ${keys}K`, `${num(plays)} ${plays === 1 ? "chart" : "charts"} passed`]
      .map((w) => `<span>${w}</span>`)
      .join("");
    body.innerHTML = `
      <div class="skills-grid">
        <section class="panel skills-radar">${radar(now, then)}</section>
        <section class="panel skills-list">${now.map((s, i) => this.row(s, then[i])).join("")}</section>
      </div>
      <p class="skills-how">
        A play is worth the chart's star rating at the rate you played it, at ${Math.round(REF_ACC * 100)}% accuracy along osu!'s own osu!mania pp curve:
        a 5★ chart at 92% counts as about 4.4★. A pattern's skill is the average of your ${TOP} best charts with that pattern
        (at least ${MIN_SHARE}% of the chart), weighted by how much of each chart it is. Passes only, each chart once,
        and not with mods that change what you play, like Hold Off.
      </p>`;
  }

  private row(s: Skill, before: Skill): string {
    const label = PATTERN_LABEL[s.pattern];
    const guess = s.charts > 0 && s.charts < MIN_CHARTS;
    // a guess can move either way; a settled skill only grows
    const change = s.value !== null && before.value !== null && s.charts >= MIN_CHARTS && before.charts >= MIN_CHARTS ? s.value - before.value : null;
    const delta =
      change !== null && Math.abs(change) >= 0.01
        ? `<span class="skill-delta ${change > 0 ? "up" : "down"}" data-tip="Since ${playWhen(Date.now() - THEN_MS)}">${change > 0 ? "+" : "−"}${Math.abs(change).toFixed(2)}</span>`
        : "";
    const open = this.open.has(s.pattern);
    return `
      <div class="skill${open ? " open" : ""}${s.value === null ? " empty" : ""}" data-pattern="${s.pattern}">
        <button class="skill-head" type="button" aria-expanded="${open}"${s.value === null ? " disabled" : ""}>
          <span class="skill-name">${label}</span>
          <span class="skill-charts">${s.charts ? `${num(s.charts)} ${s.charts === 1 ? "chart" : "charts"}${guess ? " · a guess so far" : ""}` : "no charts yet"}</span>
          ${delta}
          <b class="skill-value num">${s.value !== null ? `${s.value.toFixed(2)}★` : "–"}</b>
          ${s.value !== null ? icon("chevron-down", "skill-chev") : `<span></span>`}
        </button>
        ${open ? `<div class="skill-charts-list">${s.top.map((c) => chartRow(c, s)).join("")}</div>` : ""}
      </div>`;
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      const k = t.closest<HTMLElement>(".skills-keys [data-keys]");
      if (k) {
        this.keys = +k.dataset.keys!;
        this.open.clear();
        return this.render();
      }
      const head = t.closest<HTMLElement>(".skill-head");
      if (head) {
        const p = head.closest<HTMLElement>(".skill")!.dataset.pattern!;
        if (this.open.has(p)) this.open.delete(p);
        else this.open.add(p);
        return this.render();
      }
      const row = t.closest<HTMLElement>(".skill-chart[data-map]");
      if (row) openSet(store.snap!.maps[+row.dataset.map!].set, +row.dataset.map!);
    });
    this.el.addEventListener("keydown", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".skill-chart[data-map]");
      if (row && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        openSet(store.snap!.maps[+row.dataset.map!].set, +row.dataset.map!);
      }
    });
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

/** One chart behind a skill: what it is, how it was played, what it's worth. */
function chartRow(c: Skill["top"][number], s: Skill): string {
  const snap = store.snap!;
  const set = snap.sets[c.map.set];
  const bg = c.map.bg ?? set.bg;
  const rate = rateOf(c.play);
  const mods = modsText(c.play as Play);
  return `
    <div class="skill-chart" data-map="${c.mapIdx}" role="button" tabindex="0">
      <span class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text">
        <div class="t-title">${esc(displayTitle(set, store.prefs.unicode))}</div>
        <div class="t-sub">${esc(c.map.version)} · ${c.share}% ${PATTERN_LABEL[s.pattern].toLowerCase()}</div>
      </div>
      <span class="skill-chart-sr" data-tip="${rate !== 1 ? `Star rating at ${rate.toFixed(2)}×` : "Star rating"}">${srChip(chartStars(c.play, c.map))}</span>
      <span class="skill-chart-mods">${esc(mods)}</span>
      <span class="num skill-chart-acc">${pct(c.play.acc)}</span>
      <b class="num skill-chart-worth" data-tip="What this play is worth at ${Math.round(REF_ACC * 100)}% accuracy">${c.stars.toFixed(2)}★</b>
    </div>`;
}

/** The six patterns around a hexagon: now (filled) and 90 days ago (dashed). The centre isn't
 * zero: rings are labelled in stars, so small differences show. */
function radar(now: Skill[], then: Skill[]): string {
  const values = [...now, ...then].map((s) => s.value).filter((v): v is number => v !== null);
  const max = values.length ? Math.max(...values) : 1;
  const min = values.length ? Math.min(...values) : 0;
  const step = max - min > 3 ? 1 : 0.5;
  const lo = Math.max(0, Math.floor((min - step) / step) * step);
  const hi = Math.max(lo + step, Math.ceil((max + step * 0.25) / step) * step);
  const R = 100;
  const n = PATTERNS.length;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const at = (i: number, v: number | null): [number, number] => {
    const r = v === null ? 0 : (Math.max(0, v - lo) / (hi - lo)) * R;
    return [Math.cos(angle(i)) * r, Math.sin(angle(i)) * r];
  };
  const poly = (pts: [number, number][]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const rings: string[] = [];
  for (let v = lo + step; v <= hi + 1e-6; v += step) {
    const r = ((v - lo) / (hi - lo)) * R;
    const pts = PATTERNS.map((_, i) => [Math.cos(angle(i)) * r, Math.sin(angle(i)) * r] as [number, number]);
    rings.push(`<polygon class="ring" points="${poly(pts)}" />`);
    // whole stars get a label, beside the top spoke
    if (Math.abs(v - Math.round(v)) < 1e-6) rings.push(`<text class="ring-label" x="4" y="${(-r + 3).toFixed(1)}">${Math.round(v)}★</text>`);
  }
  const spokes = PATTERNS.map((_, i) => {
    const [x, y] = at(i, hi);
    return `<line class="spoke" x1="0" y1="0" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" />`;
  }).join("");
  const nowPts = now.map((s, i) => at(i, s.value));
  const hasThen = then.some((s) => s.value !== null) && then.some((s, i) => s.value !== now[i].value);
  const thenPoly = hasThen ? `<polygon class="then" points="${poly(then.map((s, i) => at(i, s.value)))}" />` : "";
  const dots = now
    .map((s, i) => {
      if (s.value === null) return "";
      const [x, y] = nowPts[i];
      return `<circle class="dot${s.charts < MIN_CHARTS ? " guess" : ""}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" />`;
    })
    .join("");
  const labels = now
    .map((s, i) => {
      const [x, y] = at(i, hi);
      const k = 1.17;
      const anchor = Math.abs(x) < 1 ? "middle" : x > 0 ? "start" : "end";
      const dy = y < -1 ? -4 : y > 1 ? 14 : 4;
      return `<text class="axis-label" x="${(x * k).toFixed(1)}" y="${(y * k + dy).toFixed(1)}" text-anchor="${anchor}">${PATTERN_LABEL[s.pattern]}<tspan class="axis-value" x="${(x * k).toFixed(1)}" dy="13">${s.value !== null ? `${s.value.toFixed(2)}★` : "–"}</tspan></text>`;
    })
    .join("");
  return `
    <svg class="radar" viewBox="-170 -140 340 290" role="img" aria-label="Skill per pattern">
      ${rings.join("")}${spokes}${thenPoly}
      <polygon class="now" points="${poly(nowPts)}" />
      ${dots}${labels}
    </svg>
    <div class="radar-legend">
      <span class="lg-now">Now</span>
      ${hasThen ? `<span class="lg-then">90 days ago</span>` : ""}
    </div>`;
}
