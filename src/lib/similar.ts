/* similar.ts — the charts in the library most like one chart.
 *
 * A chart's fingerprint is what you feel playing it: its star rating, how dense it is, how long,
 * its speed and, in osu!mania, its pattern mix (lib/skills' pattern shares) and how much of it is
 * long notes; in the other rulesets the approach rate and circle size, and how much of it is
 * sliders. Every part is a difference in "units" (one unit is a difference you'd notice: 0.4★,
 * 30 % of the pattern mix moved, a third denser …), weighted by how much it matters, and the
 * weighted mean of their squares is the distance. A chart is `1 / (1 + distance)` alike: 100 %
 * the same, 80 % a quarter unit apart on average, 50 % one unit.
 *
 * Only the same ruleset counts (osu!mania: the same key count), never the chart's own set, and a
 * difficulty that's in the library twice (lazer and stable, or uploaded again) once.
 */
import { PATTERN_LABEL, PATTERNS } from "./skills";
import type { MapRow } from "./types";

/** One part of the fingerprint: its name, what a unit of it is, and its weight per ruleset
 * (osu!, osu!taiko, osu!catch, osu!mania; 0 = left out). */
interface Part {
  key: PartKey;
  weight: [number, number, number, number];
  /** the difference in units, positive when `b` has more; null when either doesn't know */
  diff: (a: Print, b: Print) => number | null;
}

type PartKey = "sr" | "patterns" | "holds" | "density" | "bpm" | "length" | "ar" | "cs" | "od";

/** What the fingerprint reads off a difficulty (unknowns as NaN). */
export interface Print {
  mode: number;
  /** osu!mania's key count, else 0 */
  keys: number;
  sr: number;
  /** notes per second over the drain time */
  density: number;
  bpm: number;
  /** seconds */
  length: number;
  /** share of long notes / sliders, 0–1 */
  holds: number;
  ar: number;
  cs: number;
  od: number;
  /** osu!mania: each pattern's share in percent, in PATTERNS order */
  shares?: number[];
}

const known = (x: number) => Number.isFinite(x) && x > 0;
const ratio = (a: number, b: number, unit: number) => (known(a) && known(b) ? Math.log2(b / a) / unit : null);

const PARTS: Part[] = [
  { key: "sr", weight: [1.5, 1.5, 1.5, 1.5], diff: (a, b) => (known(a.sr) && known(b.sr) ? (b.sr - a.sr) / 0.4 : null) },
  {
    // how far the mix moved: half the summed differences, so 30 % from one pattern to another is 1
    key: "patterns",
    weight: [0, 0, 0, 2],
    diff: (a, b) => {
      if (!a.shares || !b.shares) return null;
      let moved = 0;
      for (let i = 0; i < PATTERNS.length; i++) moved += Math.abs((b.shares[i] ?? 0) - (a.shares[i] ?? 0));
      return moved / 2 / 30;
    },
  },
  { key: "holds", weight: [0.6, 0.3, 0.4, 1.2], diff: (a, b) => (Number.isFinite(a.holds) && Number.isFinite(b.holds) ? (b.holds - a.holds) / (a.mode === 3 ? 0.12 : 0.2) : null) },
  { key: "density", weight: [0.6, 0.8, 0.6, 1], diff: (a, b) => ratio(a.density, b.density, 0.4) },
  // osu!mania's speed is in its density; elsewhere the BPM is what you read
  { key: "bpm", weight: [1, 1, 1, 0.3], diff: (a, b) => ratio(a.bpm, b.bpm, 0.2) },
  { key: "length", weight: [0.5, 0.5, 0.5, 0.5], diff: (a, b) => ratio(a.length, b.length, 1) },
  { key: "ar", weight: [0.8, 0, 0.6, 0], diff: (a, b) => (b.ar - a.ar) / 1 },
  { key: "cs", weight: [0.8, 0, 0.8, 0], diff: (a, b) => (b.cs - a.cs) / 0.8 },
  { key: "od", weight: [0.3, 0.4, 0, 0], diff: (a, b) => (b.od - a.od) / 1.5 },
];

/** what a part the candidate doesn't know costs (in units², before its weight) */
const UNKNOWN = 1;

export function print(m: MapRow): Print {
  const secs = m.length / 1000;
  return {
    mode: m.mode,
    keys: m.mode === 3 ? Math.round(m.cs) : 0,
    sr: m.sr,
    density: secs > 0 && m.objects > 0 ? m.objects / secs : NaN,
    bpm: m.bpm || NaN,
    length: secs || NaN,
    holds: m.objects > 0 ? m.holds / m.objects : NaN,
    ar: m.ar,
    cs: m.cs,
    od: m.od,
    shares: m.mode === 3 && m.shares?.length ? m.shares : undefined,
  };
}

export interface Likeness {
  /** 0–1, 1 the same */
  score: number;
  /** each part's difference in units (b against a), where both know it */
  diffs: Partial<Record<PartKey, number>>;
}

/** How alike `b` is to `a` (a's ruleset decides the weights). */
export function likeness(a: Print, b: Print): Likeness {
  const w = a.mode >= 0 && a.mode <= 3 ? a.mode : 0;
  let sum = 0;
  let weights = 0;
  const diffs: Likeness["diffs"] = {};
  for (const p of PARTS) {
    const weight = p.weight[w];
    if (!weight) continue;
    const d = p.diff(a, b);
    if (d === null || !Number.isFinite(d)) {
      // left out when the chart asked about doesn't know it either, else it counts against
      if (p.diff(a, a) === null) continue;
      sum += weight * UNKNOWN;
    } else {
      sum += weight * d * d;
      diffs[p.key] = d;
    }
    weights += weight;
  }
  const d2 = weights ? sum / weights : 0;
  return { score: 1 / (1 + d2), diffs };
}

export interface Similar extends Likeness {
  mapIdx: number;
}

/** below this a chart isn't worth showing as alike */
export const MIN_SCORE = 0.25;

/**
 * The difficulties in `maps` most like `target`, closest first. `excludeSet`: the set the target
 * is in (its own difficulties aren't "similar maps"); `skip`: difficulties to leave out;
 * `same`: what makes two difficulties the same chart besides osu!'s id (a song's title and the
 * difficulty's name: a set uploaded again), so it comes once and never as the target's twin.
 */
export function similarTo(
  target: MapRow,
  maps: MapRow[],
  opts: { limit?: number; excludeSet?: number; skip?: (m: MapRow, i: number) => boolean; same?: (m: MapRow) => string } = {},
): Similar[] {
  const limit = opts.limit ?? 10;
  const a = print(target);
  const out: Similar[] = [];
  // a difficulty in the library twice (lazer and stable, two copies of a set) comes once
  const keys = (m: MapRow): string[] => [...(m.onlineId ? [`#${m.onlineId}`] : []), ...(opts.same ? [opts.same(m)] : [])];
  const seen = new Set<string>(keys(target));
  for (let i = 0; i < maps.length; i++) {
    const m = maps[i];
    if (m.id === target.id || m.mode !== target.mode || m.hidden) continue;
    if (opts.excludeSet !== undefined && m.set === opts.excludeSet) continue;
    if (a.keys && Math.round(m.cs) !== a.keys) continue;
    // a chart two and a half stars off isn't alike, whatever else it shares
    if (known(a.sr) && Math.abs(m.sr - a.sr) > 2.5) continue;
    if (opts.skip?.(m, i)) continue;
    const l = likeness(a, print(m));
    if (l.score < MIN_SCORE) continue;
    out.push({ mapIdx: i, ...l });
  }
  out.sort((x, y) => y.score - x.score || maps[x.mapIdx].sr - maps[y.mapIdx].sr);
  const picked: Similar[] = [];
  for (const s of out) {
    const k = keys(maps[s.mapIdx]);
    if (k.some((x) => seen.has(x))) continue;
    for (const x of k) seen.add(x);
    picked.push(s);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** a difference from this many units is worth saying */
const SAY = 0.6;

/** What sets `b` apart from the chart it's like, the biggest first: "harder", "more jacks" … */
export function differences(a: MapRow, b: MapRow, l: Likeness, max = 2): string[] {
  const words: { units: number; text: string }[] = [];
  const say = (units: number | undefined, more: string, less: string) => {
    if (units === undefined || Math.abs(units) < SAY) return;
    words.push({ units: Math.abs(units), text: units > 0 ? more : less });
  };
  const d = l.diffs;
  say(d.sr, "harder", "easier");
  say(d.density, "denser", "lighter");
  say(d.length, "longer", "shorter");
  if (a.mode !== 3) say(d.bpm, "faster", "slower");
  if (a.mode === 3) say(d.holds, "more long notes", "fewer long notes");
  else if (a.mode === 0) say(d.holds, "more sliders", "fewer sliders");
  else if (a.mode === 2) say(d.holds, "more juice streams", "fewer juice streams");
  say(d.ar, "higher AR", "lower AR");
  if (a.mode === 0) say(d.cs, "smaller circles", "bigger circles");
  else if (a.mode === 2) say(d.cs, "smaller fruits", "bigger fruits");
  // the pattern the mix moved toward most (long notes are said above already)
  if (d.patterns !== undefined && d.patterns >= SAY && a.shares && b.shares) {
    let best = -1;
    let gain = 0;
    for (let i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i] === "ln") continue;
      const g = (b.shares[i] ?? 0) - (a.shares[i] ?? 0);
      if (g > gain) [best, gain] = [i, g];
    }
    if (best >= 0 && gain >= 15) words.push({ units: d.patterns, text: `more ${PATTERN_LABEL[PATTERNS[best]].toLowerCase()}` });
  }
  return words
    .sort((x, y) => y.units - x.units)
    .slice(0, max)
    .map((w) => w.text);
}

/** The chart's biggest pattern, as "54% jumpstream" (osu!mania with an analysis). */
export function mainPattern(m: MapRow): string {
  if (!m.shares?.length) return "";
  let best = 0;
  for (let i = 1; i < PATTERNS.length; i++) if ((m.shares[i] ?? 0) > (m.shares[best] ?? 0)) best = i;
  const share = Math.round(m.shares[best] ?? 0);
  return share > 0 ? `${share}% ${PATTERN_LABEL[PATTERNS[best]].toLowerCase()}` : "";
}
