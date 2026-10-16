/* goals.ts — what a goal is and how far along it is. Three kinds:
 *   skill    an osu!mania pattern's skill in a key mode (lib/skills.ts), e.g. Jacks 4K to 4.00★
 *   chart    an accuracy on one difficulty, at a rate or faster, e.g. 96% at 1.10×
 *   profile  osu!'s pp or global rank in a ruleset (after the last sync)
 * Everything here is worked out from the play history; Fumen stores the goals as they are
 * (src-tauri/src/goals.rs) and lib/goals-store.ts keeps them and marks the ones reached.
 */
import { fixed, num, pct } from "./format";
import { bestPerChart, changesChart, PATTERN_LABEL, rateOf, skills, type Skill, type SkillPattern, PATTERNS } from "./skills";
import type { History, MapRow, Play } from "./types";
import { t } from "./i18n";

export type Ruleset = "osu" | "taiko" | "fruits" | "mania";
export const RULESETS: Ruleset[] = ["osu", "taiko", "fruits", "mania"];
export const RULESET_LABEL: Record<Ruleset, string> = { osu: "osu!", taiko: "osu!taiko", fruits: "osu!catch", mania: "osu!mania" };

export type GoalSpec =
  | { kind: "skill"; keys: number; pattern: SkillPattern; target: number }
  | {
      kind: "chart";
      /** the library difficulty, and osu!'s id for it (plays osu! knows match on that too) */
      map: string;
      beatmapId?: number;
      /** how it's called, kept for when it's gone from the library */
      title: string;
      version: string;
      /** accuracy 0–1, at this rate or faster */
      acc: number;
      rate: number;
    }
  | { kind: "profile"; ruleset: Ruleset; metric: "pp" | "rank"; target: number };

export type Goal = GoalSpec & {
  id: string;
  /** unix ms */
  created: number;
  /** where it stood when the goal was set (null: nowhere yet) */
  start: number | null;
  /** when it was reached (unix ms) */
  done?: number;
};

/** What a goal is measured against. */
export interface GoalContext {
  plays: Play[];
  maps: MapRow[];
  mapIndex: (id: string | undefined) => number | undefined;
  stats: History["stats"];
  /** the skills in a key mode (worked out once per context) */
  skillsFor(keys: number): Skill[];
}

export function goalContext(h: Pick<History, "plays" | "stats">, maps: MapRow[], mapIndex: GoalContext["mapIndex"]): GoalContext {
  const cache = new Map<number, Skill[]>();
  return {
    plays: h.plays,
    maps,
    mapIndex,
    stats: h.stats,
    skillsFor(keys) {
      let s = cache.get(keys);
      if (!s) cache.set(keys, (s = skills(bestPerChart(h.plays, mapIndex, maps, keys))));
      return s;
    },
  };
}

/** The best accuracy on a difficulty: passes at the rate or faster, without mods that change it. */
export function bestAcc(plays: Play[], spec: Pick<Extract<GoalSpec, { kind: "chart" }>, "map" | "beatmapId" | "rate">): number | null {
  let best: number | null = null;
  for (const p of plays) {
    if (p.map !== spec.map && !(spec.beatmapId !== undefined && p.beatmapId === spec.beatmapId)) continue;
    if (p.failed || changesChart(p) || rateOf(p) < spec.rate - 1e-6) continue;
    if (best === null || p.acc > best) best = p.acc;
  }
  return best;
}

/** Where a goal stands now; null when there's nothing to go by yet. */
export function goalNow(goal: GoalSpec, ctx: GoalContext): number | null {
  switch (goal.kind) {
    case "skill":
      return ctx.skillsFor(goal.keys)[PATTERNS.indexOf(goal.pattern)]?.value ?? null;
    case "chart":
      return bestAcc(ctx.plays, goal);
    case "profile": {
      const s = ctx.stats[goal.ruleset];
      const v = goal.metric === "pp" ? s?.pp : s?.rank;
      // osu! says rank 0 / null for players without one
      return v ? v : null;
    }
  }
}

const targetOf = (goal: GoalSpec): number => (goal.kind === "chart" ? goal.acc : goal.target);
/** a lower number is better */
const lowerIsBetter = (goal: GoalSpec): boolean => goal.kind === "profile" && goal.metric === "rank";

export function isReached(goal: GoalSpec, now: number | null): boolean {
  if (now === null) return false;
  const target = targetOf(goal);
  return lowerIsBetter(goal) ? now <= target : now >= target - 1e-9;
}

/** How far from where it started to the target, 0–1. */
export function progress(goal: Goal, now: number | null): number {
  if (goal.done || isReached(goal, now)) return 1;
  if (now === null) return 0;
  const target = targetOf(goal);
  // without a start: from a little way off (rank: from twice the target)
  const start = goal.start ?? (goal.kind === "chart" ? Math.max(0, target - 0.1) : lowerIsBetter(goal) ? target * 2 : target * 0.8);
  if (lowerIsBetter(goal)) {
    // ranks move in proportions: #20,000 → #10,000 is as far as #2,000 → #1,000
    const [s, t, n] = [start, target, now].map((v) => Math.log(Math.max(1, v)));
    return s <= t ? 0 : clamp01((s - n) / (s - t));
  }
  return start >= target ? 0 : clamp01((now - start) / (target - start));
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** A target a step beyond where things are now, for a skill, a chart's accuracy, pp or a rank. */
export function suggestTarget(what: "skill" | "chart" | "pp" | "rank", now: number | null): number {
  if (what === "skill") return now === null ? 3 : Math.ceil((now + 0.15) * 20) / 20;
  if (what === "chart") return now === null || now < 0.955 ? 0.96 : Math.min(1, Math.ceil((now + 0.005) * 200) / 200);
  if (what === "rank") return now === null ? 100_000 : roundSig(now * 0.8);
  return now === null ? 1000 : Math.ceil((now + 50) / 100) * 100;
}

/** Two significant digits, down: 12,345 → 12,000. */
const roundSig = (v: number) => {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(v)) - 1));
  return Math.max(1, Math.floor(v / p) * p);
};

/* ---------- words ---------- */

/** "Jacks 4K", "Hours [Feru's HD]", "osu!mania pp" */
export function goalTitle(goal: GoalSpec): string {
  if (goal.kind === "skill") return `${PATTERN_LABEL[goal.pattern]} ${goal.keys}K`;
  if (goal.kind === "chart") return `${goal.title} [${goal.version}]`;
  return goal.metric === "pp" ? `${RULESET_LABEL[goal.ruleset]} pp` : t("{ruleset} rank", { ruleset: RULESET_LABEL[goal.ruleset] });
}

/** A value of the goal's kind: "4.00★", "96.00%", "1,500pp", "#10,000". */
export function goalValue(goal: GoalSpec, v: number): string {
  if (goal.kind === "skill") return `${fixed(v, 2)}★`;
  if (goal.kind === "chart") return pct(v);
  return goal.metric === "pp" ? `${num(Math.round(v))}pp` : `#${num(Math.round(v))}`;
}

/** The target in words: "4.00★", "96.00% at 1.10× or faster". */
export function goalTarget(goal: GoalSpec): string {
  if (goal.kind === "chart") return goal.rate !== 1 ? t("{acc} at {rate}× or faster", { acc: pct(goal.acc), rate: fixed(goal.rate, 2) }) : pct(goal.acc);
  return goalValue(goal, goal.target);
}
