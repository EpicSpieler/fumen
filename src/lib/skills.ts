/* skills.ts — how good you are at each osu!mania pattern, from your plays.
 *
 * A play is worth the star rating of the chart at the rate it was played, turned into "stars at
 * 96% accuracy" along osu!'s own osu!mania pp curve (pp grows with SR^2.2 × (5·acc − 4)), so a
 * 5★ chart at 92% counts as about 4.4★. A pattern's skill is the average of your five best
 * charts with that pattern (it's at least 15% of the chart), weighted by how much of each chart
 * it is. Only passes on osu!mania charts in your library count, in one key mode at a time, and
 * not with mods that change what you play (Hold Off, Invert, Easy, Difficulty Adjust, …).
 */
import type { MapRow, Play } from "./types";

export const PATTERNS = ["stream", "jumpstream", "handstream", "chordjack", "jacks", "ln"] as const;
export type SkillPattern = (typeof PATTERNS)[number];

export const PATTERN_LABEL: Record<SkillPattern, string> = {
  stream: "Stream",
  jumpstream: "Jumpstream",
  handstream: "Handstream",
  chordjack: "Chordjack",
  jacks: "Jacks",
  ln: "Long notes",
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
  if (Math.abs(rate - 1) < 1e-6) return map.sr;
  const pts: [number, number][] = [[1, map.sr]];
  if (map.srHt !== undefined) pts.unshift([0.75, map.srHt]);
  if (map.srDt !== undefined) pts.push([1.5, map.srDt]);
  if (pts.length === 1) return map.sr * rate;
  // the segment the rate falls in, or the nearest one at either end
  let i = 0;
  while (i < pts.length - 2 && rate > pts[i + 1][0]) i++;
  const [[x0, y0], [x1, y1]] = [pts[i], pts[i + 1]];
  return Math.max(0, y0 + ((rate - x0) / (x1 - x0)) * (y1 - y0));
}

/** How much an accuracy is worth against REF_ACC, as a star-rating factor (osu!mania's pp curve:
 * pp ∝ SR^2.2 × (5·acc − 4)). 96% → 1, 92% → 0.88, 99% → 1.08. */
export function accFactor(acc: number): number {
  const a = Math.max(0, 5 * Math.min(1, acc) - 4);
  return Math.pow(a / (5 * REF_ACC - 4), 1 / 2.2);
}

export const rateOf = (p: Play): number => p.rate ?? 1;

/** The chart's star rating at the rate it was played: worked out exactly for rates the library
 * has none for (the backend sends it with the play), else from the library's. */
export const chartStars = (p: Play, map: MapRow): number => p.sr ?? starsAt(map, rateOf(p));

/** A play's worth in stars at REF_ACC; null when it doesn't count. */
export function playStars(p: Play, map: MapRow): number | null {
  if (p.failed || p.mode !== 3 || map.mode !== 3 || !map.shares) return null;
  if (p.mods?.some((m) => UNRATED.has(m))) return null;
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

/** The skill per pattern from each chart's best play (see `bestPerChart`). */
export function skills(charts: Counted[]): Skill[] {
  return PATTERNS.map((pattern, k) => {
    const with_ = charts.filter((c) => (c.map.shares?.[k] ?? 0) >= MIN_SHARE);
    const top = with_.slice(0, TOP).map((c) => ({ ...c, share: c.map.shares![k] }));
    const weight = top.reduce((s, c) => s + c.share, 0);
    return {
      pattern,
      value: weight > 0 ? top.reduce((s, c) => s + c.stars * c.share, 0) / weight : null,
      charts: with_.length,
      top,
    };
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
