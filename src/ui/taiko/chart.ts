/* chart.ts — an osu!taiko chart for the playfield (built in src-tauri/src/taiko.rs the way lazer
 * builds it), with what lazer's autoplay does over it as a timeline: when each drum key is hit,
 * when each object is judged, how far each swell has got. The skins animate from it. */
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
  readonly keyPresses: Float64Array[];
  /** every press, sorted, with its object */
  readonly pressTime: Float64Array;
  readonly pressObject: Uint32Array;
  /** swells: when they're cleared (or missed, at their end); NaN for others */
  readonly judged: Float64Array;
  /** hits (centre / rim) judged so far, by time: for combo-based things */
  readonly hitTimes: Float64Array;
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

    const p = t.presses;
    const keys: number[][] = [[], [], [], []];
    const swellPresses = new Map<number, number[]>();
    this.pressTime = new Float64Array(p.length / 3);
    this.pressObject = new Uint32Array(p.length / 3);
    for (let i = 0; i < p.length; i += 3) {
      const time = p[i];
      const k = p[i + 1];
      const obj = p[i + 2];
      this.pressTime[i / 3] = time;
      this.pressObject[i / 3] = obj;
      KEYS.forEach((key, j) => k & key && keys[j].push(time));
      if (this.kind[obj] === SWELL) {
        let list = swellPresses.get(obj);
        if (!list) swellPresses.set(obj, (list = []));
        list.push(time);
      }
    }
    this.keyPresses = keys.map((k) => Float64Array.from(k));
    this.swellPresses = swellPresses;
    this.judged = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (this.kind[i] !== SWELL) continue;
      const list = swellPresses.get(i) ?? [];
      this.judged[i] = list.length >= this.hits[i] && list.length ? list[list.length - 1] : this.end[i];
    }
    const hitTimes: number[] = [];
    for (let i = 0; i < n; i++) if (this.kind[i] <= RIM) hitTimes.push(this.time[i]);
    this.hitTimes = Float64Array.from(hitTimes);

    let ahead = 1;
    for (let i = 0; i < n; i++) ahead = Math.max(ahead, 1 / Math.max(1e-3, this.multiplier(this.time[i])));
    this.maxAhead = ahead;
    this.beats = d.beats;
    this.kiaiSections = d.kiai;
  }

  private readonly swellPresses: Map<number, number[]>;

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

  /** Hits judged by `t` (lazer's combo counts hits only). */
  combo(t: number): number {
    return upper(this.hitTimes, t);
  }
}
