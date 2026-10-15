/* chart.ts — an osu!taiko chart for the playfield (built in src-tauri/src/taiko.rs the way lazer
 * builds it), with what's played over it as a timeline — lazer's autoplay, or a replay judged by
 * lib/taiko-replay: when each drum key is hit, when and how each object is judged, how far each
 * swell has got. The skins animate from it. */
import type { TaikoReplay } from "../../lib/taiko-replay";
import type { ChartData } from "../../lib/types";

export const CENTRE = 0;
export const RIM = 1;
export const ROLL = 2;
export const SWELL = 3;

/** lazer's TaikoAction, as bits */
export const LEFT_CENTRE = 1;
export const RIGHT_CENTRE = 2;
export const LEFT_RIM = 4;
export const RIGHT_RIM = 8;
export const KEYS = [LEFT_CENTRE, RIGHT_CENTRE, LEFT_RIM, RIGHT_RIM] as const;

/** a note's result */
export const GREAT = 0;
export const OK = 1;
export const MISSED = 2;
export type HitResult = typeof GREAT | typeof OK | typeof MISSED;

/** TaikoHitObject.DEFAULT_SIZE: a hit's size, of the playfield's height */
export const DEFAULT_SIZE = 0.475;
/** TaikoStrongableHitObject.STRONG_SCALE */
export const STRONG_SCALE = 1 / 0.65;
/** TaikoPlayfield.BASE_HEIGHT, INPUT_DRUM_WIDTH; the hit target sits 24 units left of the
 * right area's start, centred on a 200-unit-wide box */
export const BASE_HEIGHT = 200;
export const INPUT_DRUM_WIDTH = 180;
export const HIT_X = INPUT_DRUM_WIDTH - 24 + BASE_HEIGHT / 2;

/** First index whose value is ≥ t in a sorted array. */
export function bound(a: ArrayLike<number>, t: number, stride = 1): number {
  let lo = 0;
  let hi = Math.floor(a.length / stride);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid * stride] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > t in a sorted array. */
export function upper(a: ArrayLike<number>, t: number, stride = 1): number {
  let lo = 0;
  let hi = Math.floor(a.length / stride);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid * stride] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Beat {
  /** when the beat lands */
  time: number;
  index: number;
  length: number;
  meter: number;
}

export class TaikoChart {
  readonly n: number;
  readonly time: Float64Array;
  readonly end: Float64Array;
  readonly kind: Uint8Array;
  readonly strong: Uint8Array;
  readonly kiai: Uint8Array;
  /** swells: hits needed */
  readonly hits: Uint32Array;
  /** drum rolls: their ticks are ticks[tickFrom[i] .. tickFrom[i + 1]) */
  readonly tickFrom: Uint32Array;
  readonly tickTo: Uint32Array;
  readonly ticks: Float64Array;
  /** [time, multiplier] */
  private readonly scrollT: Float64Array;
  private readonly scrollM: Float64Array;
  readonly barTime: Float64Array;
  readonly barMajor: Uint8Array;
  /** per key (KEYS order): press times */
  keyPresses: Float64Array[] = [];
  /** notes: when they were hit, NaN if they weren't */
  hitAt: Float64Array = new Float64Array(0);
  /** notes: when they were missed, NaN if they weren't */
  missAt: Float64Array = new Float64Array(0);
  /** notes: their result once judged (GREAT, OK, MISSED), -1 for the rest */
  result: Int8Array = new Int8Array(0);
  /** strong notes: when the second key landed, NaN if it didn't */
  strongAt: Float64Array = new Float64Array(0);
  /** drum roll ticks: when they were hit or missed (NaN if they weren't), and whether a rim key hit them */
  tickAt: Float64Array = new Float64Array(0);
  tickMissAt: Float64Array = new Float64Array(0);
  tickRim: Uint8Array = new Uint8Array(0);
  /** swells: when they're cleared (or missed, at their end); NaN for others */
  judged: Float64Array = new Float64Array(0);
  /** hits (centre / rim) that kept the combo going, and misses that broke it, by time */
  hitTimes: Float64Array = new Float64Array(0);
  missTimes: Float64Array = new Float64Array(0);
  /** goes up whenever what's played changes (renderers keep things worked out from it) */
  version = 0;
  private swellPresses = new Map<number, number[]>();
  /** the furthest any object scrolls into view ahead of its time, as a share of the time range */
  readonly maxAhead: number;
  private readonly beats: number[];
  private readonly kiaiSections: number[];

  constructor(d: ChartData) {
    const t = d.taiko!;
    const o = t.objects;
    const n = o.length / 5;
    this.n = n;
    this.time = new Float64Array(n);
    this.end = new Float64Array(n);
    this.kind = new Uint8Array(n);
    this.strong = new Uint8Array(n);
    this.kiai = new Uint8Array(n);
    this.hits = new Uint32Array(n);
    this.tickFrom = new Uint32Array(n);
    this.tickTo = new Uint32Array(n);
    this.ticks = Float64Array.from(t.ticks);
    const rolls: number[] = [];
    for (let i = 0; i < n; i++) {
      this.time[i] = o[i * 5];
      this.kind[i] = o[i * 5 + 1];
      this.end[i] = o[i * 5 + 2];
      this.strong[i] = o[i * 5 + 3] & 1;
      this.kiai[i] = (o[i * 5 + 3] >> 1) & 1;
      if (this.kind[i] === SWELL) this.hits[i] = o[i * 5 + 4];
      if (this.kind[i] === ROLL) {
        this.tickFrom[i] = o[i * 5 + 4];
        rolls.push(i);
      }
    }
    rolls.forEach((r, k) => (this.tickTo[r] = k + 1 < rolls.length ? this.tickFrom[rolls[k + 1]] : this.ticks.length));

    const s = t.scroll;
    this.scrollT = new Float64Array(s.length / 2);
    this.scrollM = new Float64Array(s.length / 2);
    for (let i = 0; i < s.length; i += 2) {
      this.scrollT[i / 2] = s[i];
      this.scrollM[i / 2] = s[i + 1];
    }
    const b = t.bars;
    this.barTime = new Float64Array(b.length / 2);
    this.barMajor = new Uint8Array(b.length / 2);
    for (let i = 0; i < b.length; i += 2) {
      this.barTime[i / 2] = b[i];
      this.barMajor[i / 2] = b[i + 1];
    }

    this.autoplay = t.presses;
    this.setPlay(null);

    let ahead = 1;
    for (let i = 0; i < n; i++) ahead = Math.max(ahead, 1 / Math.max(1e-3, this.multiplier(this.time[i])));
    this.maxAhead = ahead;
    this.beats = d.beats;
    this.kiaiSections = d.kiai;
  }

  /** autoplay: [time, keys, object] */
  private readonly autoplay: number[];

  /** Plays a judged replay over the chart, or autoplay again (null). */
  setPlay(r: TaikoReplay | null): void {
    const n = this.n;
    this.version++;
    if (r) {
      this.keyPresses = r.keyPresses;
      this.hitAt = r.hitAt;
      this.missAt = r.missAt;
      // the replay's results are lazer's (Great 1, Ok 3, Miss 5)
      this.result = Int8Array.from(r.result, (v) => (v < 0 ? -1 : v === 1 ? GREAT : v === 3 ? OK : MISSED));
      this.strongAt = r.strongAt;
      this.tickAt = r.tickAt;
      this.tickMissAt = r.tickMissAt;
      this.tickRim = r.tickRim;
      this.swellPresses = new Map();
      this.judged = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (this.kind[i] !== SWELL) continue;
        this.swellPresses.set(i, r.swellPressTimes(i));
        this.judged[i] = r.swellAt[i];
      }
    } else {
      // autoplay hits everything on time, both keys on strong notes
      const p = this.autoplay;
      const keys: number[][] = [[], [], [], []];
      this.swellPresses = new Map();
      for (let i = 0; i < p.length; i += 3) {
        const time = p[i];
        const obj = p[i + 2];
        KEYS.forEach((key, j) => p[i + 1] & key && keys[j].push(time));
        if (this.kind[obj] === SWELL) {
          let list = this.swellPresses.get(obj);
          if (!list) this.swellPresses.set(obj, (list = []));
          list.push(time);
        }
      }
      this.keyPresses = keys.map((k) => Float64Array.from(k));
      this.hitAt = new Float64Array(n).fill(NaN);
      this.missAt = new Float64Array(n).fill(NaN);
      this.result = new Int8Array(n).fill(-1);
      this.strongAt = new Float64Array(n).fill(NaN);
      this.judged = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        if (this.kind[i] <= RIM) {
          this.hitAt[i] = this.time[i];
          this.result[i] = GREAT;
          if (this.strong[i]) this.strongAt[i] = this.time[i];
        } else if (this.kind[i] === SWELL) {
          const list = this.swellPresses.get(i) ?? [];
          this.judged[i] = list.length >= this.hits[i] && list.length ? list[list.length - 1] : this.end[i];
        }
      }
      this.tickAt = Float64Array.from(this.ticks);
      this.tickMissAt = new Float64Array(this.ticks.length).fill(NaN);
      this.tickRim = new Uint8Array(this.ticks.length);
    }
    const hits: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(this.hitAt[i])) hits.push(this.hitAt[i]);
      else if (!Number.isNaN(this.missAt[i])) misses.push(this.missAt[i]);
    }
    this.hitTimes = Float64Array.from(hits).sort();
    this.missTimes = Float64Array.from(misses).sort();
  }

  /** The scroll multiplier in effect at a time (the first one before any). */
  multiplier(time: number): number {
    const i = upper(this.scrollT, time);
    return this.scrollM[Math.max(0, i - 1)] ?? 1;
  }

  /** How many hits a swell had by `t`. */
  swellHits(i: number, t: number): number {
    const list = this.swellPresses.get(i);
    if (!list) return 0;
    return Math.min(this.hits[i], upper(list, t));
  }

  /** The swell's press times. */
  swellPressTimes(i: number): number[] {
    return this.swellPresses.get(i) ?? [];
  }

  /** Index of the latest press of a key at or before `t`, or -1. */
  lastPress(key: number, t: number): number {
    return upper(this.keyPresses[key], t) - 1;
  }

  /** Whether `t` is in a kiai section. */
  inKiai(t: number): boolean {
    const k = this.kiaiSections;
    for (let i = 0; i < k.length; i += 2) if (t >= k[i] && t < k[i + 1]) return true;
    return false;
  }

  /** Kiai sections as [start, end] pairs. */
  get kiaiRanges(): number[] {
    return this.kiaiSections;
  }

  /** The beat at or before `t` (lazer's BeatSyncedContainer), or null before the first timing point. */
  beatAt(t: number): Beat | null {
    const b = this.beats;
    if (!b.length) return null;
    let i = 0;
    while (i + 3 < b.length && b[i + 3] <= t) i += 3;
    const start = b[i];
    const length = b[i + 1];
    const meter = b[i + 2] || 4;
    if (!(length > 0)) return null;
    const index = Math.floor((t - start) / length);
    return { time: start + index * length, index, length, meter };
  }

  /** The combo at `t`: hits since the last miss (lazer's combo counts notes only). */
  combo(t: number): number {
    const miss = upper(this.missTimes, t) - 1;
    return upper(this.hitTimes, t) - (miss < 0 ? 0 : upper(this.hitTimes, this.missTimes[miss]));
  }

  /** Whether the latest note judged by `t` was a miss. */
  missedLast(t: number): boolean {
    const miss = upper(this.missTimes, t) - 1;
    if (miss < 0) return false;
    const hit = upper(this.hitTimes, t) - 1;
    return hit < 0 || this.hitTimes[hit] <= this.missTimes[miss];
  }
}
