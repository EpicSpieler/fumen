/* heart-stats.ts — what the pulse during a try came to, and over many (History's heart rate).
 * The readings come from a heart rate monitor (src-tauri/src/heart.rs, ./heart); a try keeps them
 * against the song (lib/attempts). */

/** The pulse during a try: [song ms, beats per minute], about one a second, and what it came to. */
export interface HeartTrack {
  samples: [number, number][];
  avg: number;
  max: number;
  min: number;
  /** the average in the map's fastest part (null without its chart) */
  fast: number | null;
}

/** a try needs this many readings for its pulse to count */
export const MIN_SAMPLES = 3;

/** The average of the readings within song ms a–b; null with fewer than two there. */
export function averageIn(samples: readonly [number, number][], a: number, b: number): number | null {
  const in_ = samples.filter(([t]) => t >= a && t <= b);
  if (in_.length < 2) return null;
  return in_.reduce((s, [, bpm]) => s + bpm, 0) / in_.length;
}

/** What the readings of a try came to; `fast`: the map's fastest part (song ms), if known. Null
 * with too few readings. */
export function summarize(samples: readonly [number, number][], fast: { a: number; b: number } | null = null): HeartTrack | null {
  const ok = samples.filter(([, bpm]) => bpm > 0);
  if (ok.length < MIN_SAMPLES) return null;
  const bpms = ok.map(([, bpm]) => bpm);
  const avg = bpms.reduce((s, v) => s + v, 0) / bpms.length;
  return {
    samples: ok.map(([t, bpm]) => [Math.round(t), Math.round(bpm)]),
    avg: Math.round(avg * 10) / 10,
    max: Math.max(...bpms),
    min: Math.min(...bpms),
    fast: fast ? round1(averageIn(ok, fast.a, fast.b)) : null,
  };
}

const round1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);

/** A try's pulse in short (the totals' rows, src-tauri/src/attempts.rs). */
export interface HeartTry {
  id: number;
  md5: string;
  mode: number;
  started: number;
  outcome: "pass" | "fail" | "quit" | "retry";
  mods: string;
  avg: number;
  max: number;
  min: number;
  fast: number | null;
}

/** One difficulty's tries with a pulse, put together. */
export interface HeartMap {
  md5: string;
  mode: number;
  tries: number;
  avg: number;
  max: number;
  min: number;
  fast: number | null;
  last: number;
}

/** Everything with a pulse, put together. */
export interface HeartTotals {
  tries: number;
  /** the average over all tries (each try counts once) */
  avg: number;
  /** the highest and lowest reading of all, with the try they came in */
  max: { bpm: number; md5: string; started: number } | null;
  min: { bpm: number; md5: string; started: number } | null;
  /** the average in the fastest parts (tries with a chart) */
  fast: number | null;
  /** passes against the rest */
  passAvg: number | null;
  restAvg: number | null;
  /** per day: the average and the highest, oldest first */
  days: { day: string; avg: number; max: number; tries: number }[];
  /** per difficulty, the most played first */
  maps: HeartMap[];
}

const mean = (v: number[]): number | null => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);

/** "2026-11-14" in local time */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The totals of many tries (any order). Null without any. */
export function totals(list: readonly HeartTry[]): HeartTotals | null {
  if (!list.length) return null;
  let max: HeartTotals["max"] = null;
  let min: HeartTotals["min"] = null;
  const byDay = new Map<string, HeartTry[]>();
  const byMap = new Map<string, HeartTry[]>();
  for (const x of list) {
    if (!max || x.max > max.bpm) max = { bpm: x.max, md5: x.md5, started: x.started };
    if (!min || x.min < min.bpm) min = { bpm: x.min, md5: x.md5, started: x.started };
    const day = dayOf(x.started);
    byDay.set(day, [...(byDay.get(day) ?? []), x]);
    byMap.set(x.md5, [...(byMap.get(x.md5) ?? []), x]);
  }
  const fasts = list.flatMap((x) => (x.fast === null ? [] : [x.fast]));
  const days = [...byDay.entries()]
    .map(([day, xs]) => ({ day, avg: mean(xs.map((x) => x.avg))!, max: Math.max(...xs.map((x) => x.max)), tries: xs.length }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const maps = [...byMap.entries()]
    .map(([md5, xs]) => {
      const f = xs.flatMap((x) => (x.fast === null ? [] : [x.fast]));
      return { md5, mode: xs[0].mode, tries: xs.length, avg: mean(xs.map((x) => x.avg))!, max: Math.max(...xs.map((x) => x.max)), min: Math.min(...xs.map((x) => x.min)), fast: mean(f), last: Math.max(...xs.map((x) => x.started)) };
    })
    .sort((a, b) => b.tries - a.tries || b.last - a.last);
  return {
    tries: list.length,
    avg: mean(list.map((x) => x.avg))!,
    max,
    min,
    fast: mean(fasts),
    passAvg: mean(list.filter((x) => x.outcome === "pass").map((x) => x.avg)),
    restAvg: mean(list.filter((x) => x.outcome !== "pass").map((x) => x.avg)),
    days,
    maps,
  };
}
