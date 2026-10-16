/* skills.ts — how good you are at each osu!mania pattern (see lib/skills.ts for how it's worked
 * out): a radar now and 90 days ago, per pattern the charts behind the number, the player's goals,
 * and charts from the library to practice the weakest ones on. Another player's skills can be put
 * next to yours (lib/compare.ts): their polygon on the radar, their value and best charts per
 * pattern.
 */
import { asApiError, thumbUrl } from "../lib/api";
import { compareEvents, compareNow, compareWith, endCompare, progressShare, progressText, recentPlayers, type ComparedChart } from "../lib/compare";
import { goalNow, goalTarget, goalTitle, goalValue, progress, type Goal, type GoalContext } from "../lib/goals";
import { currentContext, goalEvents, goalsNow, loadGoals, removeGoal } from "../lib/goals-store";
import { displayTitle, esc, fixed, num, pct, relativeTime, srChip } from "../lib/format";
import { historyEvents, historyNow, loadHistory, mapIndexOf, modsText, playWhen } from "../lib/history";
import {
  bestPerChart, chartStars, keyModes, MIN_CHARTS, MIN_SHARE, MORE_SUGGESTIONS, PATTERN_LABEL, PATTERNS, practice, rateOf, REF_ACC, skills,
  suggest, SUGGESTIONS, TOP, type Aim, type Counted, type Practice, type Skill, type SkillPattern, type Suggestion,
} from "../lib/skills";
import { similarTo } from "../lib/similar";
import { events, store } from "../lib/store";
import type { MapRow, PatternName, Play } from "../lib/types";
import { attachSegIndicator, openMenu, toast, type MenuEntry } from "../ui/controls";
import { icon } from "../ui/icons";
import { openSet, setMenu } from "./actions";
import { openGoalDialog } from "./goal-dialog";
import { openImport } from "./import";
import { lower, t, tn } from "../lib/i18n";

/** the comparison polygon: skills as they were this long ago */
const THEN_MS = 90 * 86_400_000;
/** patterns with practice suggestions before "All patterns" */
const PRACTICE_GROUPS = 3;
/** their charts per practice group, comparing */
const THEIR_PICKS = 3;
/** library charts offered as like one of theirs */
const LIKE_THEIRS = 5;

/** The compared player's charts that practise your patterns (their indices, into `maps`). */
interface TheirPractice {
  name: string;
  charts: ComparedChart[];
  maps: MapRow[];
  picks: Map<SkillPattern, Suggestion[]>;
}

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
  /** goals reached, listed */
  private showReached = false;
  /** the field for a player to compare with is open */
  private entering = false;
  /** what the compare bar shows, so progress only updates its line */
  private barKey = "";

  constructor() {
    this.el = document.createElement("section");
    this.el.className = "view skills-view is-rework";
    this.el.innerHTML = `
      <header class="view-head skills-head">
        <div>
          <h1 class="view-title">${t("Skills")}</h1>
          <div class="view-sub skills-sub meta-line num"></div>
        </div>
        <div class="skills-tools">
          <div class="seg-pill skills-keys" role="tablist" aria-label="${t("Keys")}"></div>
          <button class="btn btn-sm skills-compare" type="button">${icon("user")}<span>${t("Compare")}</span></button>
        </div>
      </header>
      <div class="skills-rework" role="note">${icon("alert", "skills-rework-ic")}<div><b>${t("Skills are being reworked")}</b><span>${t("The numbers here can be off until then, and goals and comparisons may change. Everything else in Fumen works as usual.")}</span></div></div>
      <div class="compare-bar" hidden></div>
      <div class="skills-body"></div>`;
    // under rework: greyed (skills.css) and out of reach for the keyboard too
    for (const part of this.el.querySelectorAll<HTMLElement>(".skills-tools, .compare-bar, .skills-body")) part.inert = true;
    this.bind();
    this.offs.push(
      historyEvents.on("history", () => this.render()),
      goalEvents.on("goals", () => this.render()),
      compareEvents.on("compare", (s) => {
        // progress moves the bar along; the rest waits for the answer
        if (s?.status === "loading" && this.barKey.startsWith("loading|")) this.renderBar();
        else this.render();
      }),
      events.on("library", () => this.render()),
      events.on("prefs", (p) => {
        if ("unicode" in p) this.render();
      }),
    );
    this.render();
    loadGoals().catch(() => {});
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
    this.renderBar();
    if (!h || !snap) {
      body.innerHTML = `<div class="skills-loading"><div class="skeleton" style="height:360px"></div></div>`;
      return;
    }
    const cmp = compareNow();
    const them = cmp?.status === "ready" ? cmp : null;
    const theirIndex = (id: string | undefined) => (id === undefined ? undefined : them?.index.get(id));
    const modes = keyModes(h.plays, mapIndexOf, snap.maps);
    // their key modes join yours (after yours)
    if (them) for (const m of keyModes(them.data.plays, theirIndex, them.maps)) if (!modes.some((x) => x.keys === m.keys)) modes.push({ keys: m.keys, plays: 0 });
    const ctx = currentContext();
    if (!modes.length) {
      sub.innerHTML = "";
      keysEl.hidden = true;
      body.innerHTML = `
        <div class="empty-state skills-empty">${icon("radar")}
          <div class="empty-title">${t("Skills come from your osu!mania plays")}</div>
          <div class="empty-sub">${t("Fumen reads the patterns of osu!mania charts. Once you've passed some that are in your library, you'll see here what you're good at.")}</div>
        </div>
        ${this.goalsHtml(ctx)}`;
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
    // theirs, worked out the same way on their charts
    const theirs = them ? skills(bestPerChart(them.data.plays, theirIndex, them.maps, keys)) : null;
    const versus = them && theirs ? { name: them.data.player.name, skills: theirs, charts: them.data.charts } : null;
    const theirPractice = them ? this.theirPractice(plan, charts, them, keys, played) : null;
    sub.innerHTML = [`osu!mania ${keys}K`, tn(plays, "{n} chart passed", "{n} charts passed")]
      .map((w) => `<span>${w}</span>`)
      .join("");
    body.innerHTML = `
      <div class="skills-grid">
        <section class="panel skills-radar">${radar(now, then, this.goalMarks(keys), versus)}</section>
        <section class="panel skills-list">${now.map((s, i) => this.row(s, then[i], versus && { name: versus.name, skill: versus.skills[i], charts: versus.charts })).join("")}</section>
      </div>
      ${this.goalsHtml(ctx)}
      ${this.practiceHtml(plan, played, passed, theirPractice)}
      <p class="skills-how">
        ${t("A play is worth the chart's star rating at the rate you played it, at {acc} accuracy along osu!'s own osu!mania pp curve: a 5★ chart at 92% counts as about 4.4★. A pattern's skill is the average of your {top} best charts with that pattern (at least {share}% of the chart), weighted by how much of each chart it is. Passes only, each chart once, and not with mods that change what you play, like Hold Off.", { acc: pct(REF_ACC, 0), top: TOP, share: MIN_SHARE })}
      </p>`;
  }

  private row(s: Skill, before: Skill, vs: { name: string; skill: Skill; charts: ComparedChart[] } | null): string {
    const label = PATTERN_LABEL[s.pattern];
    const guess = s.charts > 0 && s.charts < MIN_CHARTS;
    // a guess can move either way; a settled skill only grows
    const change = s.value !== null && before.value !== null && s.charts >= MIN_CHARTS && before.charts >= MIN_CHARTS ? s.value - before.value : null;
    let delta =
      change !== null && Math.abs(change) >= 0.01
        ? `<span class="skill-delta ${change > 0 ? "up" : "down"}" data-tip="${t("Since {when}", { when: playWhen(Date.now() - THEN_MS) })}">${change > 0 ? "+" : "−"}${fixed(Math.abs(change), 2)}</span>`
        : "";
    // comparing: their value where the change since 90 days ago was
    if (vs) {
      const th = vs.skill;
      const tip =
        th.value === null
          ? t("{name} has no {pattern} charts", { name: vs.name, pattern: lower(label) })
          : `${t("{name}: {sr}★ from {charts}", { name: vs.name, sr: fixed(th.value, 2), charts: tn(th.charts, "{n} chart", "{n} charts") })}${th.charts < MIN_CHARTS ? `, ${t("a guess")}` : ""}`;
      delta = `<span class="skill-them num" data-tip="${esc(tip)}">${th.value !== null ? `${fixed(th.value, 2)}★` : "–"}</span>`;
    }
    const open = this.open.has(s.pattern);
    const any = s.value !== null || (vs !== null && vs.skill.value !== null);
    const theirList =
      vs && vs.skill.top.length
        ? `<div class="skill-them-head">${t("{name}'s best with {pattern}", { name: esc(vs.name), pattern: lower(label) })}</div>${vs.skill.top.map((c) => theirRow(c, s, vs.charts)).join("")}`
        : "";
    return `
      <div class="skill${open ? " open" : ""}${s.value === null ? " empty" : ""}" data-pattern="${s.pattern}"${s.value !== null ? ` data-value="${s.value}"` : ""}>
        <button class="skill-head" type="button" aria-expanded="${open}"${any ? "" : " disabled"}>
          <span class="skill-name">${label}</span>
          <span class="skill-charts">${s.charts ? `${tn(s.charts, "{n} chart", "{n} charts")}${guess ? ` · ${t("a guess so far")}` : ""}` : t("no charts yet")}</span>
          ${delta}
          <b class="skill-value num">${s.value !== null ? `${fixed(s.value, 2)}★` : "–"}</b>
          ${any ? icon("chevron-down", "skill-chev") : `<span></span>`}
        </button>
        ${
          open
            ? `<div class="skill-charts-list">${vs && s.top.length ? `<div class="skill-them-head">${t("Yours")}</div>` : ""}${s.top.map((c) => chartRow(c, s)).join("")}${theirList}<button class="btn btn-ghost btn-sm skill-goal" type="button">${icon("flag")}<span>${t("Set a goal for {pattern}", { pattern: lower(label) })}</span></button></div>`
            : ""
        }
      </div>`;
  }

  /** The bar under the header: a field for a player's name, the comparison on its way, or who's
   * compared. */
  private renderBar(): void {
    const bar = this.el.querySelector<HTMLElement>(".compare-bar")!;
    const s = compareNow();
    const btn = this.el.querySelector<HTMLElement>(".skills-compare")!;
    btn.classList.toggle("active", !!s || this.entering);
    if (!s && !this.entering) {
      bar.hidden = true;
      this.barKey = "";
      return;
    }
    bar.hidden = false;
    if (s?.status === "loading") {
      if (this.barKey !== `loading|${s.name}`) {
        this.barKey = `loading|${s.name}`;
        bar.innerHTML = `
          <div class="cmp-row">
            <span class="cmp-text"><span class="cmp-who">${t("Comparing with {name}", { name: `<b>${esc(s.name)}</b>` })}</span><span class="cmp-step num"></span></span>
            <button class="btn btn-sm cmp-stop" type="button">${t("Stop")}</button>
          </div>
          <div class="cmp-progress"><i></i></div>`;
      }
      bar.querySelector<HTMLElement>(".cmp-step")!.textContent = progressText(s.progress);
      bar.querySelector<HTMLElement>(".cmp-progress")!.style.setProperty("--p", progressShare(s.progress).toFixed(3));
      return;
    }
    if (s?.status === "ready" && !this.entering) {
      const key = `ready|${s.name}|${s.data.plays.length}`;
      if (this.barKey === key) return;
      this.barKey = key;
      const p = s.data.player;
      const passed = new Set(s.data.plays.filter((x) => !x.failed).map((x) => x.map)).size;
      const meta = [
        p.rank ? `#${num(p.rank)}` : t("Unranked"),
        p.pp ? `${num(Math.round(p.pp))}pp` : "",
        p.accuracy ? pct(p.accuracy) : "",
        tn(passed, "{n} chart passed", "{n} charts passed"),
        s.data.unreadable ? tn(s.data.unreadable, "{n} chart no mirror had", "{n} charts no mirror had") : "",
      ].filter(Boolean);
      bar.innerHTML = `
        <div class="cmp-row">
          <span class="cmp-avatar${p.avatar ? "" : " img-missing"}">${p.avatar ? `<img src="${esc(p.avatar)}" alt="" decoding="async" />` : ""}</span>
          <span class="cmp-text">
            <span class="cmp-who">${t("Compared with {name}", { name: `<b>${esc(p.name || s.name)}</b>` })}</span>
            <span class="meta-line num cmp-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</span>
          </span>
          <button class="btn btn-ghost btn-sm cmp-change" type="button">${t("Other player")}</button>
          <button class="icon-btn sm cmp-close" type="button" data-tip="${t("End the comparison")}" aria-label="${t("End the comparison")}">${icon("x")}</button>
        </div>`;
      return;
    }
    // the field (also after an error)
    const err = s?.status === "error" ? s : null;
    const recent = recentPlayers();
    const key = `field|${err?.error ?? ""}|${recent.join()}`;
    if (this.barKey === key) return;
    this.barKey = key;
    bar.innerHTML = `
      <form class="cmp-row cmp-form" autocomplete="off">
        <input class="cmp-input" type="text" spellcheck="false" maxlength="32" placeholder="${t("osu! player name")}" aria-label="${t("osu! player name")}" value="${esc(err?.name ?? "")}" />
        <button class="btn btn-primary btn-sm" type="submit">${t("Compare")}</button>
        <button class="btn btn-ghost btn-sm cmp-cancel" type="button">${t("Cancel")}</button>
      </form>
      ${err ? `<div class="cmp-error">${icon("alert")}<span>${esc(err.error)}</span></div>` : ""}
      ${
        recent.length
          ? `<div class="cmp-recent"><span class="cmp-recent-label">${t("Recent")}</span>${recent.map((n) => `<button class="chip-toggle cmp-pick" type="button" data-name="${esc(n)}">${esc(n)}</button>`).join("")}</div>`
          : `<div class="cmp-hint">${t("Their top plays, first places, recent passes and most played osu!mania charts come from osu!; charts you don't have are read from the mirrors.")}</div>`
      }`;
    const input = bar.querySelector<HTMLInputElement>(".cmp-input")!;
    setTimeout(() => input.focus(), 0);
  }

  private startCompare(name: string): void {
    if (!name.trim()) return;
    this.entering = false;
    void compareWith(name);
  }

  /** Open skill goals in a key mode, as targets per pattern for the radar. */
  private goalMarks(keys: number): (number | null)[] {
    const goals = (goalsNow() ?? []).filter((g): g is Extract<Goal, { kind: "skill" }> => g.kind === "skill" && !g.done && g.keys === keys);
    return PATTERNS.map((p) => {
      const targets = goals.filter((g) => g.pattern === p).map((g) => g.target);
      return targets.length ? Math.min(...targets) : null;
    });
  }

  /** Goals: the open ones with how far along they are, then the ones reached. */
  private goalsHtml(ctx: GoalContext | null): string {
    const goals = goalsNow();
    if (!goals) return "";
    const open = goals.filter((g) => !g.done);
    const reached = goals.filter((g) => g.done).sort((a, b) => b.done! - a.done!);
    const card = (g: Goal) => {
      const now = ctx ? goalNow(g, ctx) : null;
      const p = progress(g, now);
      const chart = g.kind === "chart" ? mapIndexOf(g.map) : undefined;
      return `
        <div class="panel goal${chart !== undefined ? " is-link" : ""}" data-goal="${g.id}"${chart !== undefined ? ` data-map="${chart}" role="button" tabindex="0"` : ""}>
          <div class="goal-head">
            ${icon("flag", "goal-ic")}
            <span class="goal-title">${esc(goalTitle(g))}</span>
            <button class="icon-btn sm goal-more" type="button" data-tip="${t("More")}" aria-label="${t("More for this goal")}">${icon("more")}</button>
          </div>
          <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}"><span style="--p:${p.toFixed(3)}"></span></div>
          <div class="goal-line num">
            <span>${now !== null ? t("{value} now", { value: esc(goalValue(g, now)) }) : g.kind === "chart" ? t("Not passed yet") : t("Nothing yet")}</span>
            <span class="goal-to">${esc(goalTarget(g))}</span>
          </div>
        </div>`;
    };
    const reachedRow = (g: Goal) => `
      <div class="goal-done" data-goal="${g.id}">
        ${icon("check", "goal-done-ic")}
        <span class="goal-done-title">${esc(goalTitle(g))}</span>
        <span class="goal-done-to num">${esc(goalTarget(g))}</span>
        <span class="goal-done-when" data-tip="${t("Set {when}", { when: relativeTime(g.created) })}">${t("reached {when}", { when: relativeTime(g.done!) })}</span>
        <button class="icon-btn sm goal-more" type="button" data-tip="${t("More")}" aria-label="${t("More for this goal")}">${icon("more")}</button>
      </div>`;
    return `
      <section class="goals">
        <div class="practice-head">
          <div>
            <h2 class="section-title">${t("Goals")}${open.length ? ` <span class="section-count num">${open.length}</span>` : ""}</h2>
            ${open.length ? "" : `<div class="practice-sub">${t("Something to work toward: a skill, an accuracy on a chart, or your pp or rank. Fumen ticks it off when your plays get there.")}</div>`}
          </div>
          <button class="btn btn-sm goal-new" type="button">${icon("plus")}<span>${t("New goal")}</span></button>
        </div>
        ${open.length ? `<div class="goals-grid">${open.map(card).join("")}</div>` : ""}
        ${
          reached.length
            ? `<button class="btn btn-ghost btn-sm goals-reached-toggle" type="button" aria-expanded="${this.showReached}">${this.showReached ? t("Hide reached") : t("Reached {n}", { n: num(reached.length) })}</button>
               ${this.showReached ? `<div class="goals-reached">${reached.map(reachedRow).join("")}</div>` : ""}`
            : ""
        }
      </section>`;
  }

  private goalMenu(id: string, at: Element): void {
    const g = goalsNow()?.find((x) => x.id === id);
    if (!g) return;
    const entries: MenuEntry[] = [];
    const chart = g.kind === "chart" ? mapIndexOf(g.map) : undefined;
    if (chart !== undefined) entries.push({ label: t("Open beatmap"), icon: "library", action: () => openSet(store.snap!.maps[chart].set, chart) });
    if (g.kind === "skill") entries.push({ label: t("Show {keys}K skills", { keys: g.keys }), icon: "radar", action: () => ((this.keys = g.keys), this.render()) });
    entries.push({
      label: t("Delete goal"),
      icon: "trash",
      action: () => void removeGoal(id).catch((e) => toast(t("Couldn't delete the goal: {error}", { error: asApiError(e).message }), { kind: "danger" })),
    });
    openMenu(at, entries, { minWidth: 200 });
  }

  /** What the compared player plays that would practise your patterns: per pattern, their charts
   * in its aim (at a rate, as yours), the ones already suggested from your library left out. */
  private theirPractice(
    plan: Practice[],
    charts: Counted[],
    them: { data: { player: { name: string }; charts: ComparedChart[] }; maps: MapRow[] },
    keys: number,
    played: Set<number>,
  ): TheirPractice {
    // their charts as your library's difficulties, where you have them
    const lib = them.data.charts.map((c) => (c.library !== undefined ? mapIndexOf(c.library) : undefined));
    const mine = new Map(charts.map((c) => [c.mapIdx, c]));
    const shown = new Set<number>();
    for (const g of plan) for (const p of g.picks.slice(0, this.more.has(g.skill.pattern) ? MORE_SUGGESTIONS : SUGGESTIONS)) shown.add(p.mapIdx);
    const exclude = new Set<number>();
    const playedThem = new Set<number>();
    lib.forEach((i, j) => {
      if (i === undefined) return;
      if (shown.has(i)) exclude.add(j);
      if (played.has(i)) playedThem.add(j);
    });
    const picks = new Map<SkillPattern, Suggestion[]>();
    for (const g of plan) {
      const k = PATTERNS.indexOf(g.skill.pattern);
      const bestOf = (j: number) => (lib[j] !== undefined ? mine.get(lib[j]!) : undefined);
      const list = suggest(k, g.aim, charts, them.maps, keys, { played: playedThem, exclude, limit: THEIR_PICKS, bestOf });
      list.forEach((s) => exclude.add(s.mapIdx));
      picks.set(g.skill.pattern, list);
    }
    return { name: them.data.player.name, charts: them.data.charts, maps: them.maps, picks };
  }

  /** Practice next: the weakest patterns (or all), each with charts a little above its skill. */
  private practiceHtml(plan: Practice[], played: Set<number>, passed: Set<number>, theirs: TheirPractice | null): string {
    if (!plan.length) return "";
    const groups = this.allPatterns ? plan : plan.slice(0, PRACTICE_GROUPS);
    return `
      <section class="practice">
        <div class="practice-head">
          <div>
            <h2 class="section-title">${t("Practice next")}</h2>
            <div class="practice-sub">${t("Charts in your library a little above your weakest skills: hard enough to move them, close enough to pass. Where 1× doesn't land there, a rate does.")}</div>
          </div>
          ${plan.length > PRACTICE_GROUPS ? `<button class="btn btn-ghost btn-sm practice-all" type="button">${this.allPatterns ? t("Weakest only") : t("All {n} patterns", { n: plan.length })}</button>` : ""}
        </div>
        <div class="practice-groups">${groups.map((g) => this.practiceGroup(g, played, passed, theirs)).join("")}</div>
      </section>`;
  }

  private practiceGroup({ skill, aim, picks }: Practice, played: Set<number>, passed: Set<number>, theirs: TheirPractice | null): string {
    const name = PATTERN_LABEL[skill.pattern];
    const more = this.more.has(skill.pattern);
    const shown = picks.slice(0, more ? MORE_SUGGESTIONS : SUGGESTIONS);
    const from = aim.from !== null ? `${t("{sr}★ now", { sr: fixed(aim.from, 2) })}${skill.charts < MIN_CHARTS ? `, ${t("a guess")}` : ""}` : t("No charts yet");
    const band = `${fixed(aim.lo, 2)}–${fixed(aim.hi, 2)}★`;
    const state = (s: Suggestion): string => {
      if (s.best) {
        const rate = rateOf(s.best.play);
        return rate !== 1 ? t("your best {acc} at {rate}×", { acc: pct(s.best.play.acc), rate: fixed(rate, 2) }) : t("your best {acc}", { acc: pct(s.best.play.acc) });
      }
      return played.has(s.mapIdx) ? (passed.has(s.mapIdx) ? t("played") : t("not passed yet")) : "";
    };
    return `
      <section class="panel practice-group${theirs?.picks.get(skill.pattern)?.length ? " has-them" : ""}" data-pattern="${skill.pattern}">
        <div class="practice-group-head">
          <span class="skill-name">${name}</span>
          <span class="practice-aim num">${from} · ${t("aiming at {band}", { band })}</span>
        </div>
        ${
          shown.length
            ? `<div class="practice-list">${shown.map((s) => suggestionRow(s, skill.pattern, aim, state(s))).join("")}</div>`
            : `<div class="practice-none">${t("Nothing in your library with at least {share}% {pattern} reaches {band}, not even at 0.75× to 1.5×.", { share: MIN_SHARE, pattern: lower(name), band })}</div>`
        }
        ${picks.length > SUGGESTIONS ? `<button class="btn btn-ghost btn-sm practice-more" type="button">${more ? t("Show fewer") : t("Show more")}</button>` : ""}
        ${this.theirGroup(skill.pattern, aim, theirs)}
      </section>`;
  }

  /** Their charts for a pattern of yours, under yours. */
  private theirGroup(pattern: SkillPattern, aim: Aim, theirs: TheirPractice | null): string {
    const list = theirs?.picks.get(pattern);
    if (!theirs || !list?.length) return "";
    return `
      <div class="practice-them-head">${t("From {name}'s plays", { name: esc(theirs.name) })}</div>
      <div class="practice-list">${list.map((s) => theirSuggestionRow(s, theirs.charts[s.mapIdx], pattern, aim)).join("")}</div>`;
  }

  /** What in your library is like one of their charts (not in it), and a way to add it. */
  private likeMenu(at: Element | { x: number; y: number }, theirId: string): void {
    const s = compareNow();
    const snap = store.snap;
    if (s?.status !== "ready" || !snap) return;
    const j = s.index.get(theirId);
    if (j === undefined) return;
    const chart = s.data.charts[j];
    const key = (title: string, version: string) => `${title.toLowerCase()} / ${version.toLowerCase()}`;
    const same = (m: MapRow) => (m.set >= 0 ? key(snap.sets[m.set]?.title ?? "", m.version) : key(chart.title, chart.version));
    const like = similarTo(s.maps[j], snap.maps, { limit: LIKE_THEIRS, same });
    const unicode = store.prefs.unicode;
    const entries: MenuEntry[] = [];
    if (chart.setId) entries.push({ label: t("Add to osu!lazer…"), icon: "download", action: () => openImport(`https://osu.ppy.sh/beatmapsets/${chart.setId}`) }, "sep");
    entries.push({ group: t("Like it in your library") });
    if (!like.length) entries.push({ label: t("Nothing much like it"), icon: "similar", disabled: true });
    for (const l of like) {
      const m = snap.maps[l.mapIdx];
      const title = displayTitle(snap.sets[m.set], unicode);
      entries.push({
        label: `${title.length > 34 ? `${title.slice(0, 33)}…` : title} [${m.version.length > 22 ? `${m.version.slice(0, 21)}…` : m.version}]`,
        icon: "similar",
        hint: `${fixed(m.sr, 2)}★ · ${pct(l.score, 0)}`,
        action: () => openSet(m.set, l.mapIdx, { similar: true }),
      });
    }
    openMenu(at, entries, { minWidth: 300 });
  }

  /** The weakest pattern in the key mode shown, for a new goal. */
  private weakest(): SkillPattern | undefined {
    const shown = [...this.el.querySelectorAll<HTMLElement>(".skill[data-pattern]")]
      .map((el) => ({ p: el.dataset.pattern as SkillPattern, v: parseFloat(el.dataset.value ?? "") }))
      .filter((x) => Number.isFinite(x.v))
      .sort((a, b) => a.v - b.v);
    return shown[0]?.p;
  }

  /** Re-renders and puts the focus back on the control that asked for it (now a new element). */
  private rerender(focus: string): void {
    this.render();
    this.el.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
  }

  private bind(): void {
    this.el.addEventListener("click", (e) => {
      const target = e.target as Element;
      if (target.closest(".skills-compare")) {
        if (compareNow()?.status === "loading") return;
        this.entering = !this.entering;
        if (!this.entering && compareNow()?.status === "error") endCompare();
        return this.renderBar();
      }
      if (target.closest(".cmp-cancel")) {
        this.entering = false;
        if (compareNow()?.status === "error") endCompare();
        return this.renderBar();
      }
      if (target.closest(".cmp-stop") || target.closest(".cmp-close")) {
        this.entering = false;
        return endCompare();
      }
      if (target.closest(".cmp-change")) {
        this.entering = true;
        return this.renderBar();
      }
      const pick = target.closest<HTMLElement>(".cmp-pick");
      if (pick) return this.startCompare(pick.dataset.name!);
      const like = target.closest<HTMLElement>(".like-btn");
      if (like) return this.likeMenu(like, like.closest<HTMLElement>("[data-their]")!.dataset.their!);
      const add = target.closest<HTMLElement>(".skill-chart[data-add]");
      if (add) return openImport(`https://osu.ppy.sh/beatmapsets/${add.dataset.add}`);
      const k = target.closest<HTMLElement>(".skills-keys [data-keys]");
      if (k) {
        this.keys = +k.dataset.keys!;
        this.open.clear();
        this.more.clear();
        this.allPatterns = false;
        return this.render();
      }
      const head = target.closest<HTMLElement>(".skill-head");
      if (head) {
        const p = head.closest<HTMLElement>(".skill")!.dataset.pattern!;
        if (this.open.has(p)) this.open.delete(p);
        else this.open.add(p);
        return this.rerender(`.skill[data-pattern="${p}"] .skill-head`);
      }
      if (target.closest(".goal-new")) return openGoalDialog({ kind: "skill", keys: this.keys ?? undefined, pattern: this.weakest() });
      const goalMore = target.closest<HTMLElement>(".goal-more");
      if (goalMore) return this.goalMenu(goalMore.closest<HTMLElement>("[data-goal]")!.dataset.goal!, goalMore);
      if (target.closest(".goals-reached-toggle")) {
        this.showReached = !this.showReached;
        return this.rerender(".goals-reached-toggle");
      }
      const skillGoal = target.closest<HTMLElement>(".skill-goal");
      if (skillGoal) {
        const keys = +this.el.querySelector<HTMLElement>(".skills-keys .active")?.dataset.keys! || undefined;
        return openGoalDialog({ kind: "skill", keys, pattern: skillGoal.closest<HTMLElement>(".skill")!.dataset.pattern as SkillPattern });
      }
      const goalCard = target.closest<HTMLElement>(".goal[data-map]");
      if (goalCard) return openSet(store.snap!.maps[+goalCard.dataset.map!].set, +goalCard.dataset.map!);
      if (target.closest(".practice-all")) {
        this.allPatterns = !this.allPatterns;
        return this.rerender(".practice-all");
      }
      const more = target.closest<HTMLElement>(".practice-more");
      if (more) {
        const p = more.closest<HTMLElement>(".practice-group")!.dataset.pattern!;
        if (this.more.has(p)) this.more.delete(p);
        else this.more.add(p);
        return this.rerender(`.practice-group[data-pattern="${p}"] .practice-more`);
      }
      const row = target.closest<HTMLElement>(".skill-chart[data-map]");
      if (row) openSet(store.snap!.maps[+row.dataset.map!].set, +row.dataset.map!);
    });
    this.el.addEventListener("submit", (e) => {
      const form = (e.target as Element).closest(".cmp-form");
      if (!form) return;
      e.preventDefault();
      this.startCompare(form.querySelector<HTMLInputElement>(".cmp-input")!.value);
    });
    this.el.addEventListener("contextmenu", (e) => {
      // one of theirs you don't have: what's like it in yours
      const theirs = (e.target as Element).closest<HTMLElement>(".skill-chart[data-their]:not([data-map])");
      if (theirs) {
        e.preventDefault();
        return this.likeMenu({ x: e.clientX, y: e.clientY }, theirs.dataset.their!);
      }
      const row = (e.target as Element).closest<HTMLElement>(".skill-chart[data-map]");
      if (!row) return;
      e.preventDefault();
      const mapIdx = +row.dataset.map!;
      const rate = row.dataset.rate ? +row.dataset.rate : undefined;
      const pattern = row.closest<HTMLElement>(".practice-group")?.dataset.pattern as PatternName | undefined;
      setMenu({ x: e.clientX, y: e.clientY }, store.snap!.maps[mapIdx].set, mapIdx, {
        practice: { rate, pattern },
        extra: [{ label: t("Set a goal…"), icon: "flag", action: () => openGoalDialog({ kind: "chart", mapIdx, rate }) }],
      });
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (e.target as Element).closest(".cmp-input")) {
        e.stopPropagation();
        this.entering = false;
        if (compareNow()?.status === "error") endCompare();
        return this.renderBar();
      }
      if ((e.target as Element).closest(".like-btn")) return;
      const add = (e.target as Element).closest<HTMLElement>(".skill-chart[data-add]");
      if (add && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        return openImport(`https://osu.ppy.sh/beatmapsets/${add.dataset.add}`);
      }
      const row = (e.target as Element).closest<HTMLElement>(".skill-chart[data-map], .goal[data-map]");
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
        <div class="t-sub">${esc(c.map.version)} · ${t("{pct}% {pattern}", { pct: c.share, pattern: lower(PATTERN_LABEL[s.pattern]) })}</div>
      </div>
      <span class="skill-chart-sr" data-tip="${rate !== 1 ? t("Star rating at {rate}×", { rate: fixed(rate, 2) }) : t("Star rating")}">${srChip(chartStars(c.play, c.map))}</span>
      <span class="skill-chart-mods">${esc(mods)}</span>
      <span class="num skill-chart-acc">${pct(c.play.acc)}</span>
      <b class="num skill-chart-worth" data-tip="${t("What this play is worth at {acc} accuracy", { acc: pct(REF_ACC, 0) })}">${fixed(c.stars, 2)}★</b>
    </div>`;
}

/** One of the other player's charts behind a skill: like yours, with osu!'s cover; a click opens
 * it in the library, or offers to add it. */
function theirRow(c: Skill["top"][number], s: Skill, charts: ComparedChart[]): string {
  const chart = charts.find((x) => x.id === c.map.id);
  const unicode = store.prefs.unicode;
  const title = chart ? `${(unicode && chart.artistUnicode) || chart.artist} - ${(unicode && chart.titleUnicode) || chart.title}` : c.map.version;
  const lib = chart?.library !== undefined ? mapIndexOf(chart.library) : undefined;
  const rate = rateOf(c.play);
  const cover = chart?.setId ? `https://assets.ppy.sh/beatmaps/${chart.setId}/covers/list.jpg` : "";
  const where = lib !== undefined ? ` data-map="${lib}"` : chart?.setId ? ` data-add="${chart.setId}" data-tip="${t("Not in your library: add it")}"` : "";
  return `
    <div class="skill-chart them"${where} data-their="${esc(c.map.id)}" role="button" tabindex="0">
      <span class="t-art${cover ? "" : " img-missing"}">${cover ? `<img src="${cover}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text">
        <div class="t-title">${esc(title)}</div>
        <div class="t-sub">${esc(c.map.version)} · ${t("{pct}% {pattern}", { pct: c.share, pattern: lower(PATTERN_LABEL[s.pattern]) })}${lib === undefined ? ` · ${t("not in your library")}` : ""}</div>
      </div>
      <span class="skill-chart-sr" data-tip="${rate !== 1 ? t("Star rating at {rate}×", { rate: fixed(rate, 2) }) : t("Star rating")}">${srChip(chartStars(c.play, c.map))}</span>
      <span class="skill-chart-mods">${esc(modsText(c.play as Play))}</span>
      <span class="num skill-chart-acc">${pct(c.play.acc)}</span>
      <b class="num skill-chart-worth" data-tip="${t("What this play is worth at {acc} accuracy", { acc: pct(REF_ACC, 0) })}">${fixed(c.stars, 2)}★</b>
    </div>`;
}

/** How lazer plays a chart at a rate: Half Time or Double Time, with the speed adjusted off 0.75×
 * and 1.5× (shown like a play's mods). */
const rateMods = (rate: number): string =>
  rate === 1 ? "" : rate === 0.75 ? "HT" : rate === 1.5 ? "DT" : `${rate < 1 ? "HT" : "DT"} ${fixed(rate, 2)}×`;

function rateTip(rate: number): string {
  const mod = rate < 1 ? "Half Time" : "Double Time";
  return rate === 0.75 || rate === 1.5 ? `${mod}, ${num(rate)}×` : t("{mod} with its speed set to {rate}×", { mod, rate: fixed(rate, 2) });
}

/** One of their charts to practice on, like yours: osu!'s cover; a click opens it in the library or
 * offers to add it, and one you don't have can show what's like it in yours. */
function theirSuggestionRow(s: Suggestion, chart: ComparedChart, pattern: SkillPattern, aim: Aim): string {
  const unicode = store.prefs.unicode;
  const title = `${(unicode && chart.artistUnicode) || chart.artist} - ${(unicode && chart.titleUnicode) || chart.title}`;
  const lib = chart.library !== undefined ? mapIndexOf(chart.library) : undefined;
  const cover = chart.setId ? `https://assets.ppy.sh/beatmaps/${chart.setId}/covers/list.jpg` : "";
  const name = lower(PATTERN_LABEL[pattern]);
  const gain = aim.from !== null ? s.after - aim.from : null;
  const where = lib !== undefined ? ` data-map="${lib}" data-rate="${s.rate}"` : chart.setId ? ` data-add="${chart.setId}" data-tip="${t("Not in your library: add it")}"` : "";
  const state = s.best ? t("your best {acc}", { acc: pct(s.best.play.acc) }) : lib !== undefined ? t("in your library") : t("not in your library");
  return `
    <div class="skill-chart practice-chart them"${where} data-their="${esc(chart.id)}" role="button" tabindex="0">
      <span class="t-art${cover ? "" : " img-missing"}">${cover ? `<img src="${cover}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text">
        <div class="t-title">${esc(title)}</div>
        <div class="t-sub">${[esc(chart.version), t("{pct}% {pattern}", { pct: s.share, pattern: name }), state].join(" · ")}</div>
      </div>
      <span class="skill-chart-sr" data-tip="${s.rate !== 1 ? t("Star rating at {rate}×", { rate: fixed(s.rate, 2) }) : t("Star rating")}">${srChip(s.stars)}</span>
      <span class="skill-chart-mods"${s.rate !== 1 ? ` data-tip="${rateTip(s.rate)}"` : ""}>${rateMods(s.rate)}</span>
      <b class="num practice-gain" data-tip="${gainTip(aim, s, name)}">${gain === null ? t("new") : gain < 0.005 ? `+&lt;${fixed(0.01, 2)}` : `+${fixed(gain, 2)}`}</b>
      ${lib === undefined ? `<button class="icon-btn like-btn" type="button" data-tip="${t("Like it in your library")}" aria-label="${t("Like it in your library")}">${icon("similar")}</button>` : "<span></span>"}
    </div>`;
}

/** One chart to practice on: what it is, the rate to play it at, its star rating there, and what a
 * pass at REF_ACC would make of the skill. */
function suggestionRow(s: Suggestion, pattern: SkillPattern, aim: Aim, state: string): string {
  const snap = store.snap!;
  const set = snap.sets[s.map.set];
  const bg = s.map.bg ?? set.bg;
  const name = lower(PATTERN_LABEL[pattern]);
  const gain = aim.from !== null ? s.after - aim.from : null;
  return `
    <div class="skill-chart practice-chart" data-map="${s.mapIdx}" data-rate="${s.rate}" role="button" tabindex="0">
      <span class="t-art${bg ? "" : " img-missing"}">${bg ? `<img src="${thumbUrl(bg, 160)}" alt="" loading="lazy" decoding="async" />` : ""}</span>
      <div class="prow-text">
        <div class="t-title">${esc(displayTitle(set, store.prefs.unicode))}</div>
        <div class="t-sub">${[esc(s.map.version), t("{pct}% {pattern}", { pct: s.share, pattern: name }), state].filter(Boolean).join(" · ")}</div>
      </div>
      <span class="skill-chart-sr" data-tip="${s.rate !== 1 ? t("Star rating at {rate}×", { rate: fixed(s.rate, 2) }) : t("Star rating")}">${srChip(s.stars)}</span>
      <span class="skill-chart-mods"${s.rate !== 1 ? ` data-tip="${rateTip(s.rate)}"` : ""}>${rateMods(s.rate)}</span>
      <b class="num practice-gain" data-tip="${gainTip(aim, s, name)}">${gain === null ? t("new") : gain < 0.005 ? `+&lt;${fixed(0.01, 2)}` : `+${fixed(gain, 2)}`}</b>
    </div>`;
}

/** What a pass at REF_ACC on a suggestion would make of the skill. */
function gainTip(aim: Aim, s: Suggestion, pattern: string): string {
  const vars = { acc: pct(REF_ACC, 0), pattern, from: aim.from !== null ? fixed(aim.from, 2) : "", to: fixed(s.after, 2) };
  return aim.from !== null ? t("A {acc} pass here takes {pattern} from {from}★ to {to}★", vars) : t("A {acc} pass here starts {pattern} at {to}★", vars);
}

/** The six patterns around a hexagon: now (filled) and 90 days ago (dashed). The centre isn't
 * zero: rings are labelled in stars, so small differences show. */
function radar(now: Skill[], then: Skill[], goals: (number | null)[], vs: { name: string; skills: Skill[] } | null = null): string {
  const values = [...[...now, ...(vs ? vs.skills : then)].map((s) => s.value), ...goals].filter((v): v is number => v !== null);
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
  // comparing: their polygon instead of 90 days ago
  const hasThen = !vs && then.some((s) => s.value !== null) && then.some((s, i) => s.value !== now[i].value);
  const thenPoly = hasThen ? `<polygon class="then" points="${poly(then.map((s, i) => at(i, s.value)))}" />` : "";
  const themPoly = vs && vs.skills.some((s) => s.value !== null) ? `<polygon class="them" points="${poly(vs.skills.map((s, i) => at(i, s.value)))}" />` : "";
  const dots = now
    .map((s, i) => {
      if (s.value === null) return "";
      const [x, y] = nowPts[i];
      return `<circle class="dot${s.charts < MIN_CHARTS ? " guess" : ""}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" />`;
    })
    .join("");
  const marks = goals
    .map((v, i) => {
      if (v === null) return "";
      const [x, y] = at(i, v);
      return `<path class="goal-mark" d="M${x.toFixed(1)} ${(y - 4.2).toFixed(1)}l4.2 4.2-4.2 4.2-4.2-4.2z"><title>${t("Goal: {sr}★", { sr: fixed(v, 2) })}</title></path>`;
    })
    .join("");
  const labels = now
    .map((s, i) => {
      const [x, y] = at(i, hi);
      const k = 1.17;
      const anchor = Math.abs(x) < 1 ? "middle" : x > 0 ? "start" : "end";
      const dy = y < -1 ? -4 : y > 1 ? 14 : 4;
      const theirs = vs ? vs.skills[i].value : undefined;
      const value =
        theirs === undefined
          ? `<tspan class="axis-value" x="${(x * k).toFixed(1)}" dy="13">${s.value !== null ? `${fixed(s.value, 2)}★` : "–"}</tspan>`
          : `<tspan class="axis-value" x="${(x * k).toFixed(1)}" dy="13">${s.value !== null ? fixed(s.value, 2) : "–"}</tspan><tspan class="axis-them"> · ${theirs !== null ? fixed(theirs, 2) : "–"}</tspan>`;
      return `<text class="axis-label" x="${(x * k).toFixed(1)}" y="${(y * k + dy).toFixed(1)}" text-anchor="${anchor}">${PATTERN_LABEL[s.pattern]}${value}</text>`;
    })
    .join("");
  return `
    <svg class="radar" viewBox="-170 -140 340 290" role="img" aria-label="${t("Skill per pattern")}">
      ${rings.join("")}${spokes}${thenPoly}${themPoly}
      <polygon class="now" points="${poly(nowPts)}" />
      ${dots}${marks}${labels}
    </svg>
    <div class="radar-legend">
      <span class="lg-now">${vs ? t("You") : t("Now")}</span>
      ${hasThen ? `<span class="lg-then">${t("90 days ago")}</span>` : ""}
      ${vs ? `<span class="lg-them">${esc(vs.name)}</span>` : ""}
      ${goals.some((v) => v !== null) ? `<span class="lg-goal">${t("Goal")}</span>` : ""}
    </div>`;
}
