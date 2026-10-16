/* skills.ts — how good you are at each osu!mania pattern, from your plays.
 *
 * A play is worth the star rating of the chart at the rate it was played, turned into "stars at
 * 96% accuracy" along osu!'s own osu!mania pp curve (pp grows with SR^2.2 × (5·acc − 4)), so a
 * 5★ chart at 92% counts as about 4.4★. A pattern's skill is the average of your five best
 * charts with that pattern (it's at least 15% of the chart), weighted by how much of each chart
 * it is. Only passes on osu!mania charts in your library count, in one key mode at a time, and
 * not with mods that change what you play (Hold Off, Invert, Easy, Difficulty Adjust, …).
 *
 * Practice suggestions aim a little above a pattern's skill: charts in the library with plenty of
 * the pattern whose star rating lands there, at 1× or at a rate that gets them there.
 */
import type { MapRow, Play } from "./types";
import { t } from "./i18n";

export const PATTERNS = ["stream", "jumpstream", "handstream", "chordjack", "jacks", "ln"] as const;
export type SkillPattern = (typeof PATTERNS)[number];

export const PATTERN_LABEL: Record<SkillPattern, string> = {
  stream: t("Stream"),
  jumpstream: t("Jumpstream"),
  handstream: t("Handstream"),
  chordjack: t("Chordjack"),
  jacks: t("Jacks"),
  ln: t("Long notes"),
};

/** a pattern counts for a chart from this share (the analysis' tag threshold) */
export const MIN_SHARE = 15;
/** charts averaged per pattern */
export const TOP = 5;
/** below this many charts a pattern's skill is a guess: one more, easier chart would still pull
 * the average down (from TOP on, a new chart can only replace a weaker one) */
export const MIN_CHARTS = TOP;
/** the accuracy a skill is stated at */
export const REF_ACC = 0.96;
/** mods that change what's played beyond the rate: such plays don't count */
const UNRATED = new Set(["HO", "IN", "NR", "EZ", "DS", "CO", "AT", "CN", "RX", "AP", "AS", "WU", "WD", "DA", "SG", "TP"]);

/** A chart's star rating at a rate: lazer's at 1×, Fumen's at 0.75× and 1.5×, straight lines
 * between (and beyond, along the nearest segment). Plays at other rates come with their own. */
export function starsAt(map: Pick<MapRow, "sr" | "srHt" | "srDt">, rate: number): number {
  const { sr, srHt: ht, srDt: dt } = map;
  if (Math.abs(rate - 1) < 1e-6) return sr;
  // the segment the rate falls in, or the nearest one at either end
  if (ht !== undefined && (rate < 1 || dt === undefined)) return Math.max(0, sr + ((rate - 1) / 0.25) * (sr - ht));
  if (dt !== undefined) return Math.max(0, sr + ((rate - 1) / 0.5) * (dt - sr));
  return sr * rate;
}

/** How much an accuracy is worth against REF_ACC, as a star-rating factor (osu!mania's pp curve:
 * pp ∝ SR^2.2 × (5·acc − 4)). 96% → 1, 92% → 0.88, 99% → 1.08. */
export function accFactor(acc: number): number {
  const a = Math.max(0, 5 * Math.min(1, acc) - 4);
  return Math.pow(a / (5 * REF_ACC - 4), 1 / 2.2);
}

export const rateOf = (p: Play): number => p.rate ?? 1;

/** Played with mods that change what's played beyond the rate (Hold Off, Easy, Autopilot, …). */
export const changesChart = (p: Play): boolean => !!p.mods?.some((m) => UNRATED.has(m));

/** The chart's star rating at the rate it was played: worked out exactly for rates the library
 * has none for (the backend sends it with the play), else from the library's. */
export const chartStars = (p: Play, map: MapRow): number => p.sr ?? starsAt(map, rateOf(p));

/** A play's worth in stars at REF_ACC; null when it doesn't count. */
export function playStars(p: Play, map: MapRow): number | null {
  if (p.failed || p.mode !== 3 || map.mode !== 3 || !map.shares) return null;
  if (changesChart(p)) return null;
  return chartStars(p, map) * accFactor(p.acc);
}

export const keysOf = (map: MapRow): number => Math.round(map.cs);

export interface Counted {
  play: Play;
  map: MapRow;
  mapIdx: number;
  /** stars at REF_ACC */
  stars: number;
}

export interface Skill {
  pattern: SkillPattern;
  /** stars at REF_ACC; null without any chart */
  value: number | null;
  /** charts with the pattern the player passed */
  charts: number;
  /** the charts behind the value, best first (each with its share of the pattern, %) */
  top: (Counted & { share: number })[];
}

/** Each chart's best counting play in one key mode, best first. */
export function bestPerChart(
  plays: Play[],
  mapIndex: (id: string | undefined) => number | undefined,
  maps: MapRow[],
  keys: number,
  until = Infinity,
): Counted[] {
  const best = new Map<number, Counted>();
  for (const play of plays) {
    if (play.date > until) continue;
    const mapIdx = mapIndex(play.map);
    if (mapIdx === undefined) continue;
    const map = maps[mapIdx];
    if (keysOf(map) !== keys) continue;
    const stars = playStars(play, map);
    if (stars === null) continue;
    const had = best.get(mapIdx);
    if (!had || stars > had.stars) best.set(mapIdx, { play, map, mapIdx, stars });
  }
  return [...best.values()].sort((a, b) => b.stars - a.stars);
}

type Rated = { map: MapRow; stars: number };

/** Charts (best first) with pattern k. */
const withPattern = <T extends Rated>(charts: T[], k: number): T[] => charts.filter((c) => (c.map.shares?.[k] ?? 0) >= MIN_SHARE);

/** The average of the TOP charts, weighted by each one's share of pattern k; null without any. */
function weighted(top: Rated[], k: number): number | null {
  const weight = top.reduce((s, c) => s + c.map.shares![k], 0);
  return weight > 0 ? top.reduce((s, c) => s + c.stars * c.map.shares![k], 0) / weight : null;
}

/** The skill per pattern from each chart's best play (see `bestPerChart`). */
export function skills(charts: Counted[]): Skill[] {
  return PATTERNS.map((pattern, k) => {
    const with_ = withPattern(charts, k);
    const top = with_.slice(0, TOP).map((c) => ({ ...c, share: c.map.shares![k] }));
    return { pattern, value: weighted(top, k), charts: with_.length, top };
  });
}

/** Key modes with counting plays, most played first. */
export function keyModes(plays: Play[], mapIndex: (id: string | undefined) => number | undefined, maps: MapRow[]): { keys: number; plays: number }[] {
  const n = new Map<number, number>();
  for (const p of plays) {
    const i = mapIndex(p.map);
    if (i === undefined || maps[i].mode !== 3 || p.mode !== 3 || !maps[i].shares) continue;
    const k = keysOf(maps[i]);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()].map(([keys, plays]) => ({ keys, plays })).sort((a, b) => b.plays - a.plays || a.keys - b.keys);
}

/* ---------- Practice next ---------- */

/** Rates a suggestion may use. The library rates charts at 0.75×, 1× and 1.5×, and the lines
 * between those hold to about 0.02★; further out they drift by tenths, so it stops there. */
const PRACTICE_RATES = Array.from({ length: 16 }, (_, i) => (75 + i * 5) / 100);
/** where practice aims, as factors of the skill: hard enough to move it, close enough to pass */
const AIM = { lo: 1.02, ideal: 1.06, hi: 1.12 } as const;
/** a pattern without charts starts this far under the weakest skill there is */
const FIRST_AIM = 0.92;
/** suggestions shown per pattern, and at most after "Show more" */
export const SUGGESTIONS = 5;
export const MORE_SUGGESTIONS = 12;

export interface Aim {
  /** the skill now; null for a pattern without charts */
  from: number | null;
  /** star ratings (at REF_ACC) practice aims for: the band and its sweet spot */
  lo: number;
  ideal: number;
  hi: number;
}

export interface Suggestion {
  map: MapRow;
  mapIdx: number;
  /** the rate to play it at */
  rate: number;
  /** the star rating at that rate */
  stars: number;
  /** the pattern's share of the chart, % */
  share: number;
  /** the player's best counting play on it, if any (below the aim, or it wouldn't be here) */
  best?: Counted;
  /** the pattern's skill after a REF_ACC pass at that rate */
  after: number;
}

export interface Practice {
  skill: Skill;
  aim: Aim;
  /** best first, up to MORE_SUGGESTIONS */
  picks: Suggestion[];
}

/** Where practice for a pattern aims: a little above its skill, or for a pattern without charts
 * a little under the weakest skill there is. Null when there's no skill at all. */
export function aimFor(skill: Skill, all: Skill[]): Aim | null {
  let base = skill.value;
  if (base === null) {
    const known = all.map((s) => s.value).filter((v): v is number => v !== null);
    if (!known.length) return null;
    base = Math.min(...known) * FIRST_AIM;
  }
  return { from: skill.value, lo: base * AIM.lo, ideal: base * AIM.ideal, hi: base * AIM.hi };
}

/** The rate that puts a chart nearest the aim's sweet spot, with its star rating there: 1× whenever
 * that's within the aim. Null when no rate gets it in. */
export function rateFor(map: MapRow, aim: Aim): { rate: number; stars: number } | null {
  if (map.sr >= aim.lo && map.sr <= aim.hi) return { rate: 1, stars: map.sr };
  // without Fumen's own HT/DT ratings there's only lazer's 1× to go by
  if (map.srHt === undefined || map.srDt === undefined) return null;
  // between 0.75× and 1.5× the rating runs along straight lines, so it stays within its three points
  if (Math.max(map.srHt, map.sr, map.srDt) < aim.lo || Math.min(map.srHt, map.sr, map.srDt) > aim.hi) return null;
  let pick: { rate: number; stars: number } | null = null;
  for (const rate of PRACTICE_RATES) {
    const stars = starsAt(map, rate);
    if (stars < aim.lo || stars > aim.hi) continue;
    if (!pick || Math.abs(stars - aim.ideal) < Math.abs(pick.stars - aim.ideal)) pick = { rate, stars };
  }
  return pick;
}

/** The charts practice draws on, per library and key mode: analysed osu!mania charts that lazer
 * shows. Snapshots are replaced, never changed, so this holds as long as the snapshot does. */
const pools = new WeakMap<MapRow[], Map<number, number[]>>();
function poolOf(maps: MapRow[], keys: number): number[] {
  let byKeys = pools.get(maps);
  if (!byKeys) pools.set(maps, (byKeys = new Map()));
  let pool = byKeys.get(keys);
  if (!pool) {
    pool = [];
    for (let i = 0; i < maps.length; i++) {
      const m = maps[i];
      if (m.mode === 3 && m.shares && !m.hidden && keysOf(m) === keys) pool.push(i);
    }
    byKeys.set(keys, pool);
  }
  return pool;
}

/** Pattern k's skill once a chart with it is passed at REF_ACC at the given stars, from the
 * charts with the pattern (best first) and the chart's best so far. */
function skillWith(withK: Counted[], k: number, map: MapRow, stars: number, had: Counted | undefined): number {
  const list: Rated[] = [];
  for (const c of withK) {
    if (list.length === TOP) break;
    if (c !== had) list.push(c);
  }
  list.push({ map, stars: Math.max(stars, had?.stars ?? 0) });
  list.sort((a, b) => b.stars - a.stars);
  return weighted(list.slice(0, TOP), k)!;
}

/** Charts to practice pattern k on, best first: in the key mode, with at least MIN_SHARE of it, at
 * a rate that puts them in the aim and not passed at that level yet. Charts heavy on the pattern
 * lead, then those near the sweet spot; untouched charts and 1× go before replays and rates.
 * One difficulty per set. */
export function suggest(
  k: number,
  aim: Aim,
  charts: Counted[],
  maps: MapRow[],
  keys: number,
  opts: {
    played?: Set<number>;
    exclude?: Set<number>;
    limit?: number;
    /** the player's best on one of `maps`, when `maps` isn't the library `charts` index into */
    bestOf?: (mapIdx: number) => Counted | undefined;
  } = {},
): Suggestion[] {
  const byIdx = new Map(charts.map((c) => [c.mapIdx, c]));
  const bestOf = opts.bestOf ?? ((i: number) => byIdx.get(i));
  const perSet = new Map<number, { pick: Omit<Suggestion, "after">; score: number }>();
  for (const mapIdx of poolOf(maps, keys)) {
    const map = maps[mapIdx];
    const share = map.shares![k];
    if (share < MIN_SHARE || opts.exclude?.has(mapIdx)) continue;
    const best = bestOf(mapIdx);
    if (best && best.stars >= aim.lo) continue;
    const at = rateFor(map, aim);
    if (!at) continue;
    const score =
      share / 100 +
      0.5 * (1 - Math.abs(at.stars - aim.ideal) / (aim.hi - aim.lo)) -
      (at.rate === 1 ? 0 : 0.1 + Math.abs(at.rate - 1) / 2) -
      (best ? 0.15 : opts.played?.has(mapIdx) ? 0.05 : 0);
    const had = perSet.get(map.set);
    if (!had || score > had.score) perSet.set(map.set, { pick: { map, mapIdx, ...at, share, best }, score });
  }
  const withK = withPattern(charts, k);
  return [...perSet.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? SUGGESTIONS)
    .map(({ pick }) => ({ ...pick, after: skillWith(withK, k, pick.map, pick.stars, pick.best) }));
}

/** Practice for every pattern the library has charts for, weakest first (patterns without a chart
 * of yours before all), those with nothing in reach last. A chart is suggested once: to the first
 * pattern that shows it, where `shown` says how many of a pattern's picks are on screen. */
export function practice(
  now: Skill[],
  charts: Counted[],
  maps: MapRow[],
  keys: number,
  opts: { played?: Set<number>; shown?: (p: SkillPattern) => number } = {},
): Practice[] {
  const pool = poolOf(maps, keys);
  const order = now.map((skill, k) => ({ skill, k })).filter(({ k }) => pool.some((i) => maps[i].shares![k] >= MIN_SHARE));
  order.sort((a, b) => (a.skill.value ?? -1) - (b.skill.value ?? -1));
  const exclude = new Set<number>();
  const out: Practice[] = [];
  for (const { skill, k } of order) {
    const aim = aimFor(skill, now);
    if (!aim) continue;
    const picks = suggest(k, aim, charts, maps, keys, { played: opts.played, exclude, limit: MORE_SUGGESTIONS });
    picks.slice(0, opts.shown?.(skill.pattern) ?? SUGGESTIONS).forEach((p) => exclude.add(p.mapIdx));
    out.push({ skill, aim, picks });
  }
  return out.sort((a, b) => Number(!a.picks.length) - Number(!b.picks.length));
}
