/* skills.ts — how good you are at each osu!mania pattern (see lib/skills.ts for how it's worked
 * out): a radar now and 90 days ago, per pattern the charts behind the number, and charts from the
 * library to practice the weakest ones on.
 */
import { thumbUrl } from "../lib/api";
import { displayTitle, esc, num, pct, srChip } from "../lib/format";
import { historyEvents, historyNow, loadHistory, mapIndexOf, modsText, playWhen } from "../lib/history";
import {
  bestPerChart, chartStars, keyModes, MIN_CHARTS, MIN_SHARE, MORE_SUGGESTIONS, PATTERN_LABEL, PATTERNS, practice, rateOf, REF_ACC, skills,
  SUGGESTIONS, TOP, type Aim, type Practice, type Skill, type SkillPattern, type Suggestion,
} from "../lib/skills";
import { events, store } from "../lib/store";
import type { Play } from "../lib/types";
import { attachSegIndicator } from "../ui/controls";
import { icon } from "../ui/icons";
import { openSet, setMenu } from "./actions";

/** the comparison polygon: skills as they were this long ago */
const THEN_MS = 90 * 86_400_000;
/** patterns with practice suggestions before "All patterns" */
const PRACTICE_GROUPS = 3;

export class SkillsView {
  readonly el: HTMLElement;
  private offs: (() => void)[] = [];
  /** key mode shown (null: the most played) */
  private keys: number | null = null;
  /** patterns whose charts are open */
  private open = new Set<string>();
  /** practice: every pattern, not just the weakest; patterns showing more suggestions */
  private allPatterns = false;
  private more = new Set<string>();

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
    // charts touched at all, and passed at all (with mods that don't count too)
    const played = new Set<number>();
    const passed = new Set<number>();
    for (const p of h.plays) {
      const i = p.mode === 3 ? mapIndexOf(p.map) : undefined;
      if (i === undefined) continue;
      played.add(i);
      if (!p.failed) passed.add(i);
    }
    const plan = practice(now, charts, snap.maps, keys, { played, shown: (p) => (this.more.has(p) ? MORE_SUGGESTIONS : SUGGESTIONS) });
    sub.innerHTML = [`osu!mania ${keys}K`, `${num(plays)} ${plays === 1 ? "chart" : "charts"} passed`]
      .map((w) => `<span>${w}</span>`)
      .join("");
    body.innerHTML = `
      <div class="skills-grid">
        <section class="panel skills-radar">${radar(now, then)}</section>
        <section class="panel skills-list">${now.map((s, i) => this.row(s, then[i])).join("")}</section>
      </div>
      ${this.practiceHtml(plan, played, passed)}
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

  /** Practice next: the weakest patterns (or all), each with charts a little above its skill. */
  private practiceHtml(plan: Practice[], played: Set<number>, passed: Set<number>): string {
    if (!plan.length) return "";
    const groups = this.allPatterns ? plan : plan.slice(0, PRACTICE_GROUPS);
    return `
      <section class="practice">
        <div class="practice-head">
          <div>
            <h2 class="section-title">Practice next</h2>
            <div class="practice-sub">Charts in your library a little above your weakest skills: hard enough to move them, close enough to pass. Where 1× doesn't land there, a rate does.</div>
          </div>
          ${plan.length > PRACTICE_GROUPS ? `<button class="btn btn-ghost btn-sm practice-all" type="button">${this.allPatterns ? "Weakest only" : `All ${plan.length} patterns`}</button>` : ""}
        </div>
        <div class="practice-groups">${groups.map((g) => this.practiceGroup(g, played, passed)).join("")}</div>
      </section>`;
  }

  private practiceGroup({ skill, aim, picks }: Practice, played: Set<number>, passed: Set<number>): string {
    const name = PATTERN_LABEL[skill.pattern];
    const more = this.more.has(skill.pattern);
    const shown = picks.slice(0, more ? MORE_SUGGESTIONS : SUGGESTIONS);
    const from = aim.from !== null ? `${aim.from.toFixed(2)}★ now${skill.charts < MIN_CHARTS ? ", a guess" : ""}` : "No charts yet";
    const band = `${aim.lo.toFixed(2)}–${aim.hi.toFixed(2)}★`;
    const state = (s: Suggestion): string => {
      if (s.best) {
        const rate = rateOf(s.best.play);
        return `your best ${pct(s.best.play.acc)}${rate !== 1 ? ` at ${rate.toFixed(2)}×` : ""}`;
      }
      return played.has(s.mapIdx) ? (passed.has(s.mapIdx) ? "played" : "not passed yet") : "";
    };
    return `
      <section class="panel practice-group" data-pattern="${skill.pattern}">
        <div class="practice-group-head">
          <span class="skill-name">${name}</span>
          <span class="practice-aim num">${from} · aiming at ${band}</span>
        </div>
        ${
          shown.length
            ? `<div class="practice-list">${shown.map((s) => suggestionRow(s, skill.pattern, aim, state(s))).join("")}</div>`
            : `<div class="practice-none">Nothing in your library with at least ${MIN_SHARE}% ${name.toLowerCase()} reaches ${band}, not even at 0.75× to 1.5×.</div>`
        }
        ${picks.length > SUGGESTIONS ? `<button class="btn btn-ghost btn-sm practice-more" type="button">${more ? "Show fewer" : "Show more"}</button>` : ""}
      </section>`;
  }

  /** Re-renders and puts the focus back on the control that asked for it (now a new element). */
  private rerender(focus: string): void {
    this.render();
    this.el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const t = e.target as Element;
      const k = t.closest<HTMLElement>(".skills-keys [data-keys]");
      if (k) {
        this.keys = +k.dataset.keys!;
        this.open.clear();
        this.more.clear();
        this.allPatterns = false;
        return this.render();
      }
      const head = t.closest<HTMLElement>(".skill-head");
      if (head) {
        const p = head.closest<HTMLElement>(".skill")!.dataset.pattern!;
        if (this.open.has(p)) this.open.delete(p);
        else this.open.add(p);
        return this.rerender(`.skill[data-pattern="${p}"] .skill-head`);
      }
      if (t.closest(".practice-all")) {
        this.allPatterns = !this.allPatterns;
        return this.rerender(".practice-all");
      }
      const more = t.closest<HTMLElement>(".practice-more");
      if (more) {
        const p = more.closest<HTMLElement>(".practice-group")!.dataset.pattern!;
        if (this.more.has(p)) this.more.delete(p);
        else this.more.add(p);
        return this.rerender(`.practice-group[data-pattern="${p}"] .practice-more`);
      }
      const row = t.closest<HTMLElement>(".skill-chart[data-map]");
      if (row) openSet(store.snap!.maps[+row.dataset.map!].set, +row.dataset.map!);
    });
    this.el.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".skill-chart[data-map]");
      if (!row) return;
      e.preventDefault();
      const mapIdx = +row.dataset.map!;
      setMenu({ x: e.clientX, y: e.clientY }, store.snap!.maps[mapIdx].set, mapIdx);
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

/** How lazer plays a chart at a rate: Half Time or Double Time, with the speed adjusted off 0.75×
 * and 1.5× (shown like a play's mods). */
const rateMods = (rate: number): string =>
  rate === 1 ? "" : rate === 0.75 ? "HT" : rate === 1.5 ? "DT" : `${rate < 1 ? "HT" : "DT"} ${rate.toFixed(2)}×`;

function rateTip(rate: number): string {
  const mod = rate < 1 ? "Half Time" : "Double Time";
  return rate === 0.75 || rate === 1.5 ? `${mod}, ${rate}×` : `${mod} with its speed set to ${rate.toFixed(2)}×`;
}

/** One chart to practice on: what it is, the rate to play it at, its star rating there, and what a
 * pass at REF_ACC would make of the skill. */
function suggestionRow(s: Suggestion, pattern: SkillPattern, aim: Aim, state: string): string {
  const snap = store.snap!;
  const set = snap.sets[s.map.set];
  const bg = s.map.bg ?? set.bg;
  const name = PATTERN_LABEL[pattern].toLowerCase();
  const acc = pct(REF_ACC, 0);
  const gain = aim.from !== null ? s.after - aim.from : null;
  const gainTip =
    aim.from !== null
      ? `A ${acc} pass here takes ${name} from ${aim.from.toFixed(2)}★ to ${s.after.toFixed(2)}★`
      : `A ${acc} pass here starts ${name} at ${s.after.toFixed(2)}★`;
  return `
    <div class="skill-chart practice-chart" data-map="${s.mapIdx}" role="button" tabindex="0">
      <span class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text">
        <div class="t-title">${esc(displayTitle(set, store.prefs.unicode))}</div>
        <div class="t-sub">${[esc(s.map.version), `${s.share}% ${name}`, state].filter(Boolean).join(" · ")}</div>
      </div>
      <span class="skill-chart-sr" data-tip="${s.rate !== 1 ? `Star rating at ${s.rate.toFixed(2)}×` : "Star rating"}">${srChip(s.stars)}</span>
      <span class="skill-chart-mods"${s.rate !== 1 ? ` data-tip="${rateTip(s.rate)}"` : ""}>${rateMods(s.rate)}</span>
      <b class="num practice-gain" data-tip="${gainTip}">${gain === null ? "new" : gain < 0.005 ? "+&lt;0.01" : `+${gain.toFixed(2)}`}</b>
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
