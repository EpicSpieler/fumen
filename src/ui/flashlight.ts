/* flashlight.ts — what the visual mods share (MIT, ppy Pty Ltd): the combo autoplay has at a time,
 * when lazer counts it as break time, and the Flashlight mod (ModFlashlight): its size by combo
 * and breaks, moving at osu!stable's speed, and its shader (a black layer with a smoothstep edge
 * around a circle, or a band). */
import type { ChartData } from "../lib/types";

/** BreakPeriod.MIN_BREAK_DURATION; BreakOverlay.BREAK_FADE_DURATION */
const MIN_BREAK = 650;
const BREAK_FADE = MIN_BREAK / 2;
/** DrawableRuleset.GameplayStartTime: two seconds before the first object */
const LEAD_IN = 2000;
/** ModFlashlight.FLASHLIGHT_FADE_DURATION */
const FADE_DURATION = 800;

/** First index whose value is > t. */
function upper(a: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The combo over time: the times of every judgement that adds to it, autoplay missing none. */
export class Combo {
  readonly times: Float64Array;

  constructor(times: number[]) {
    this.times = Float64Array.from(times).sort();
  }

  at(t: number): number {
    return upper(this.times, t);
  }

  get first(): number {
    return this.times.length ? this.times[0] : 0;
  }

  get last(): number {
    return this.times.length ? this.times[this.times.length - 1] : 0;
  }
}

/** A replay's combo over time: `events` are [time, 1 up / 0 nothing / −1 broken]. */
export class ComboLine {
  private readonly times: Float64Array;
  private readonly values: Uint32Array;

  constructor(events: readonly (readonly [number, number])[]) {
    const sorted = [...events].sort((a, b) => a[0] - b[0]);
    this.times = Float64Array.from(sorted.map((e) => e[0]));
    this.values = new Uint32Array(sorted.length);
    let c = 0;
    sorted.forEach(([, d], i) => {
      c = d > 0 ? c + 1 : d < 0 ? 0 : c;
      this.values[i] = c;
    });
  }

  at(t: number): number {
    const i = upper(this.times, t);
    return i ? this.values[i - 1] : 0;
  }
}

/**
 * BreakTracker: lazer's break time, as [start, end) pairs — before gameplay starts, the beatmap's
 * breaks long enough to count (ending a fade early), and once everything is judged.
 */
export function breakPeriods(d: ChartData, combo: Combo): [number, number][] {
  const out: [number, number][] = [[-Infinity, combo.first - LEAD_IN]];
  const b = d.breaks;
  for (let i = 0; i + 1 < b.length; i += 2) if (b[i + 1] - b[i] >= MIN_BREAK) out.push([b[i], b[i + 1] - BREAK_FADE]);
  out.push([combo.last, Infinity]);
  return out;
}

export const inPeriod = (periods: [number, number][], t: number): boolean => periods.some(([a, b]) => t >= a && t < b);

export interface FlashlightSpec {
  /** DefaultFlashlightSize, in the ruleset's units */
  size: number;
  /** BreakTimeScale */
  breakScale: number;
  /** GetComboScaleFor; none: not by combo (osu!mania) */
  comboScale?: (combo: number) => number;
  /** osu!stable's animation speed in sizes per ms; none: FLASHLIGHT_FADE_DURATION */
  speed?: number;
}

/** ModFlashlight.GetComboScaleFor */
export const comboScale = (combo: number): number => (combo >= 200 ? 0.625 : combo >= 100 ? 0.8125 : 1);

interface Step {
  time: number;
  from: number;
  to: number;
  duration: number;
}

/** The flashlight's size over time, worked out once: it moves linearly towards each new size. */
export class FlashlightSize {
  private readonly steps: Step[] = [];

  constructor(spec: FlashlightSpec, combo: Combo, breaks: [number, number][]) {
    // the size goes back down BREAK_FADE after break time ends (at the break's own end)
    const big = breaks.map(([a, b]) => [a, b === Infinity ? b : b + BREAK_FADE] as [number, number]);
    const target = (t: number) => {
      if (inPeriod(big, t)) return spec.size * spec.breakScale;
      return spec.size * (spec.comboScale ? spec.comboScale(combo.at(t)) : 1);
    };
    const changes = new Set<number>();
    for (const [a, b] of big) {
      if (Number.isFinite(a)) changes.add(a);
      if (Number.isFinite(b)) changes.add(b);
    }
    if (spec.comboScale) for (const n of [100, 200]) if (combo.times.length >= n) changes.add(combo.times[n - 1]);
    let value = spec.size * spec.breakScale;
    let last: Step = { time: -Infinity, from: value, to: value, duration: 0 };
    this.steps.push(last);
    for (const time of [...changes].sort((a, b) => a - b)) {
      const to = target(time);
      value = this.valueOf(last, time);
      if (to === last.to) continue;
      const duration = spec.speed ? Math.abs(to - value) / spec.size / spec.speed : FADE_DURATION;
      last = { time, from: value, to, duration };
      this.steps.push(last);
    }
  }

  private valueOf(s: Step, t: number): number {
    if (!(s.duration > 0) || t >= s.time + s.duration) return s.to;
    return s.from + ((s.to - s.from) * Math.max(0, t - s.time)) / s.duration;
  }

  at(t: number): number {
    let lo = 0;
    let hi = this.steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.steps[mid].time <= t) lo = mid + 1;
      else hi = mid;
    }
    return this.valueOf(this.steps[Math.max(0, lo - 1)], t);
  }
}

const smoothstep = (x: number): number => x * x * (3 - 2 * x);
const black = (a: number): string => `rgba(0,0,0,${Math.min(1, Math.max(0, a)).toFixed(4)})`;
/** gradient stops along the smoothstep */
const STOPS = 12;

/**
 * The circular flashlight (sh_CircularFlashlight): black outside a circle of `radius`, fading in
 * with a smoothstep out to radius × `smoothness`; `dim` darkens what's inside too (osu!: while a
 * slider is held). In the canvas's pixels; covers the whole canvas.
 */
export function drawCircleLight(ctx: CanvasRenderingContext2D, w: number, h: number, x: number, y: number, radius: number, smoothness: number, dim = 0): void {
  const outer = Math.max(1, radius * smoothness);
  const inner = Math.max(0, Math.min(1, radius / outer));
  const g = ctx.createRadialGradient(x, y, 0, x, y, outer);
  g.addColorStop(0, black(dim));
  g.addColorStop(inner, black(dim));
  for (let k = 1; k <= STOPS; k++) {
    const s = smoothstep(k / STOPS);
    g.addColorStop(inner + ((1 - inner) * k) / STOPS, black(s + (1 - s) * dim));
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/** The rectangular flashlight (sh_RectangularFlashlight) as osu!mania has it: a band `half` either
 * side of `y`, across the whole width, its edges fading out to `half` × `smoothness`. */
export function drawBandLight(ctx: CanvasRenderingContext2D, w: number, h: number, y: number, half: number, smoothness: number): void {
  const outer = Math.max(1, half * smoothness);
  const g = ctx.createLinearGradient(0, y - outer, 0, y + outer);
  const inner = half / outer;
  for (let k = 0; k <= STOPS; k++) {
    const d = inner + ((1 - inner) * k) / STOPS;
    const a = black(smoothstep(k / STOPS));
    g.addColorStop((1 - d) / 2, a);
    g.addColorStop((1 + d) / 2, a);
  }
  g.addColorStop(0.5, black(0));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
