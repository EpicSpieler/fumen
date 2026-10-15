/* chart.ts — an osu! chart as the playfield reads it (src-tauri/src/osu.rs lays it out the way
 * lazer does, MIT, ppy Pty Ltd): objects in typed arrays, slider paths with their lengths, the
 * cursor (autoplay's frames or a replay's, positions moving straight between them) and what it
 * does to spinners (SpinnerRotationTracker: the angle it turns around the spinner while holding,
 * counted as SpinnerSpinHistory does).
 */
import type { ChartData, OsuChartData } from "../../lib/types";
import { bound, upper } from "../taiko/chart";

export { bound, upper };

export const CIRCLE = 0;
export const SLIDER = 1;
export const SPINNER = 2;

/** OsuHitObject.OBJECT_RADIUS */
export const OBJECT_RADIUS = 64;
/** OsuPlayfield.BASE_SIZE */
export const BASE_WIDTH = 512;
export const BASE_HEIGHT = 384;
/** where spinners sit (OsuPlayfield.BASE_SIZE / 2) */
export const SPINNER_X = 256;
export const SPINNER_Y = 192;
/** OsuHitWindows.MISS_WINDOW: objects are dimmed until this long before they can be hit */
export const MISS_WINDOW = 400;

const OBJ = 10;

export interface Slider {
  /** absolute [x, y] per point */
  path: Float32Array;
  /** distance along the path to each point */
  cum: Float64Array;
  length: number;
  spans: number;
  spanDuration: number;
  tickTime: Float64Array;
  /** path progress (0–1) per tick */
  tickProgress: Float64Array;
}

/** A spinner's rotation over its duration: cumulative degrees at each time. */
interface Spin {
  time: Float64Array;
  /** signed (the disc's visual rotation) */
  rotation: Float64Array;
  /** the turns counted (SpinnerSpinHistory) */
  total: Float64Array;
}

/** SpinnerSpinHistory: spins count in one direction at a time, turning back undoes them first. */
export class SpinHistory {
  private completed = 0;
  private accumulated = 0;
  private atLastCompletion = 0;
  private currentMax = 0;

  /** degrees */
  get total(): number {
    return 360 * this.completed + this.currentMax;
  }

  report(delta: number): void {
    if (delta === 0) return;
    this.accumulated += delta;
    const current = () => this.accumulated - this.atLastCompletion;
    this.currentMax = Math.max(this.currentMax, Math.abs(current()));
    while (this.currentMax >= 360) {
      const direction = Math.sign(current());
      this.completed++;
      this.atLastCompletion += direction * 360;
      this.currentMax = Math.abs(current());
    }
  }
}

export class OsuChart {
  readonly n: number;
  readonly time: Float64Array;
  readonly end: Float64Array;
  readonly kind: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly colour: Int32Array;
  readonly number: Int32Array;
  readonly newCombo: Uint8Array;
  /** sliders: index into `sliders`; spinners: spins needed */
  readonly a: Float64Array;
  /** spinners: bonus spins */
  readonly b: Float64Array;
  readonly sliders: Slider[];
  readonly scale: number;
  readonly preempt: number;
  readonly fadeIn: number;
  /** the beatmap's own combo colours, 0–255 */
  readonly colours: [number, number, number][];
  readonly sliderBorder: [number, number, number] | null;
  readonly sliderTrack: [number, number, number] | null;
  /** the cursor's frames (autoplay's, or a replay's) */
  frameTime = new Float64Array(0);
  frameX = new Float32Array(0);
  frameY = new Float32Array(0);
  frameButtons = new Uint8Array(0);
  /** cursor travel up to each frame, osu!pixels */
  frameDist = new Float64Array(0);
  private readonly autoplay: number[];
  /** a replay's rate (spins turn that much faster) */
  private spinRate = 1;
  private readonly spins = new Map<number, Spin>();
  /** the longest any object lasts */
  readonly maxSpan: number;

  constructor(d: ChartData) {
    const o: OsuChartData = d.osu!;
    const n = Math.floor(o.objects.length / OBJ);
    this.n = n;
    this.time = new Float64Array(n);
    this.end = new Float64Array(n);
    this.kind = new Uint8Array(n);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.colour = new Int32Array(n);
    this.number = new Int32Array(n);
    this.newCombo = new Uint8Array(n);
    this.a = new Float64Array(n);
    this.b = new Float64Array(n);
    let span = 0;
    for (let i = 0; i < n; i++) {
      const j = i * OBJ;
      const v = o.objects;
      this.time[i] = v[j];
      this.kind[i] = v[j + 1];
      this.end[i] = Math.max(v[j], v[j + 2]);
      this.x[i] = v[j + 3];
      this.y[i] = v[j + 4];
      this.colour[i] = v[j + 5];
      this.number[i] = v[j + 6];
      this.newCombo[i] = v[j + 7] & 1;
      this.a[i] = v[j + 8];
      this.b[i] = v[j + 9];
      span = Math.max(span, this.end[i] - this.time[i]);
    }
    this.maxSpan = span;
    this.scale = o.scale;
    this.preempt = o.preempt;
    this.fadeIn = o.fadeIn;
    this.colours = o.colours ?? [];
    this.sliderBorder = o.sliderBorder ?? null;
    this.sliderTrack = o.sliderTrack ?? null;

    this.sliders = o.sliders.map((s) => {
      const path = Float32Array.from(s.path);
      const points = path.length / 2;
      const cum = new Float64Array(Math.max(1, points));
      for (let i = 1; i < points; i++) {
        cum[i] = cum[i - 1] + Math.hypot(path[i * 2] - path[i * 2 - 2], path[i * 2 + 1] - path[i * 2 - 1]);
      }
      const ticks = s.ticks.length / 2;
      const tickTime = new Float64Array(ticks);
      const tickProgress = new Float64Array(ticks);
      for (let i = 0; i < ticks; i++) {
        tickTime[i] = s.ticks[i * 2];
        tickProgress[i] = s.ticks[i * 2 + 1];
      }
      return { path, cum, length: cum[cum.length - 1], spans: Math.max(1, s.spans), spanDuration: s.spanDuration, tickTime, tickProgress };
    });

    this.autoplay = o.frames;
    this.setFrames(null);
  }

  /** Whose cursor it is: a replay's frames ([time, x, y, buttons 1 left / 2 right]) and rate, or
   * autoplay's (null). */
  setFrames(frames: ArrayLike<number> | null, rate = 1): void {
    const f = frames ?? this.autoplay;
    this.spinRate = frames ? rate : 1;
    this.spins.clear();
    const m = Math.floor(f.length / 4);
    this.frameTime = new Float64Array(m);
    this.frameX = new Float32Array(m);
    this.frameY = new Float32Array(m);
    this.frameButtons = new Uint8Array(m);
    this.frameDist = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      this.frameTime[i] = f[i * 4];
      this.frameX[i] = f[i * 4 + 1];
      this.frameY[i] = f[i * 4 + 2];
      this.frameButtons[i] = f[i * 4 + 3];
      if (i > 0) this.frameDist[i] = this.frameDist[i - 1] + Math.hypot(this.frameX[i] - this.frameX[i - 1], this.frameY[i] - this.frameY[i - 1]);
    }
  }

  slider(i: number): Slider {
    return this.sliders[this.a[i]];
  }

  /** The point `dist` along a slider's path. */
  pointAt(s: Slider, dist: number): [number, number] {
    const p = s.path;
    const last = s.cum.length - 1;
    if (last <= 0) return [p[0], p[1]];
    if (dist <= 0) return [p[0], p[1]];
    if (dist >= s.length) return [p[last * 2], p[last * 2 + 1]];
    const k = Math.max(1, bound(s.cum, dist));
    const seg = s.cum[k] - s.cum[k - 1];
    const w = seg > 0 ? (dist - s.cum[k - 1]) / seg : 0;
    return [p[k * 2 - 2] + (p[k * 2] - p[k * 2 - 2]) * w, p[k * 2 - 1] + (p[k * 2 + 1] - p[k * 2 - 1]) * w];
  }

  /** SliderPath.PositionAt: path progress 0–1. */
  positionAt(s: Slider, progress: number): [number, number] {
    return this.pointAt(s, Math.max(0, Math.min(1, progress)) * s.length);
  }

  /** Slider.ProgressAt: the path progress at a share of the whole slider (spans back and forth). */
  progressAt(s: Slider, completion: number): number {
    const c = Math.max(0, Math.min(1, completion));
    let p = (c * s.spans) % 1;
    if (c >= 1 && s.spans > 0) p = 1;
    if (this.spanAt(s, c) % 2 === 1) p = 1 - p;
    return p;
  }

  /** Slider.SpanAt */
  spanAt(s: Slider, completion: number): number {
    return Math.min(s.spans - 1, Math.floor(Math.max(0, Math.min(1, completion)) * s.spans));
  }

  /** SliderPath.GetPathToProgress: the points from p0 to p1 of the path (both 0–1). */
  subPath(s: Slider, p0: number, p1: number): number[] {
    const d0 = Math.max(0, Math.min(1, p0)) * s.length;
    const d1 = Math.max(0, Math.min(1, p1)) * s.length;
    const out: number[] = [];
    const a = this.pointAt(s, d0);
    out.push(a[0], a[1]);
    const from = upper(s.cum, d0);
    const to = bound(s.cum, d1);
    for (let k = from; k < to; k++) out.push(s.path[k * 2], s.path[k * 2 + 1]);
    const b = this.pointAt(s, d1);
    out.push(b[0], b[1]);
    return out;
  }

  /** Index of the last frame at or before t (-1 before the first). */
  private frameAt(t: number): number {
    return upper(this.frameTime, t) - 1;
  }

  /** The cursor at t: moving straight between frames. */
  cursorAt(t: number): [number, number] {
    const ft = this.frameTime;
    if (!ft.length) return [SPINNER_X, SPINNER_Y];
    const i = this.frameAt(t);
    if (i < 0) return [this.frameX[0], this.frameY[0]];
    if (i >= ft.length - 1) return [this.frameX[ft.length - 1], this.frameY[ft.length - 1]];
    const span = ft[i + 1] - ft[i];
    const w = span > 0 ? (t - ft[i]) / span : 0;
    return [this.frameX[i] + (this.frameX[i + 1] - this.frameX[i]) * w, this.frameY[i] + (this.frameY[i + 1] - this.frameY[i]) * w];
  }

  /** The buttons held at t. */
  buttonsAt(t: number): number {
    const i = this.frameAt(t);
    return i < 0 ? 0 : this.frameButtons[i];
  }

  /** When the buttons last changed to something pressed at or before t (NaN if none held). */
  pressedSince(t: number): number {
    let i = this.frameAt(t);
    if (i < 0 || !this.frameButtons[i]) return NaN;
    const b = this.frameButtons[i];
    while (i > 0 && this.frameButtons[i - 1] === b) i--;
    return this.frameTime[i];
  }

  /** How far the cursor has travelled by t. */
  distAt(t: number): number {
    const ft = this.frameTime;
    if (!ft.length) return 0;
    const i = this.frameAt(t);
    if (i < 0) return 0;
    if (i >= ft.length - 1) return this.frameDist[ft.length - 1];
    const span = ft[i + 1] - ft[i];
    const w = span > 0 ? (t - ft[i]) / span : 0;
    return this.frameDist[i] + (this.frameDist[i + 1] - this.frameDist[i]) * w;
  }

  /** The time the cursor has travelled `dist` (the inverse of distAt). */
  timeAtDist(dist: number): number {
    const d = this.frameDist;
    const k = bound(d, dist);
    if (k <= 0) return this.frameTime[0] ?? 0;
    if (k >= d.length) return this.frameTime[d.length - 1];
    const seg = d[k] - d[k - 1];
    const w = seg > 0 ? (dist - d[k - 1]) / seg : 0;
    return this.frameTime[k - 1] + (this.frameTime[k] - this.frameTime[k - 1]) * w;
  }

  /** A spinner's rotation at t: the disc's (signed) and every turn counted, degrees. */
  spinAt(i: number, t: number): { rotation: number; total: number } {
    const s = this.spin(i);
    const k = upper(s.time, t) - 1;
    if (k < 0) return { rotation: 0, total: 0 };
    if (k >= s.time.length - 1) return { rotation: s.rotation[s.time.length - 1], total: s.total[s.time.length - 1] };
    const span = s.time[k + 1] - s.time[k];
    const w = span > 0 ? (t - s.time[k]) / span : 0;
    return { rotation: s.rotation[k] + (s.rotation[k + 1] - s.rotation[k]) * w, total: s.total[k] + (s.total[k + 1] - s.total[k]) * w };
  }

  /** DrawableSpinner.Progress: turns done of those needed, 0–1. */
  spinProgress(i: number, t: number): number {
    const needed = this.a[i];
    if (needed <= 0) return t >= this.time[i] ? 1 : 0;
    return Math.max(0, Math.min(1, this.spinAt(i, t).total / 360 / needed));
  }

  /** When a spinner got all its spins (Result.TimeCompleted), or Infinity. */
  spinCompleted(i: number): number {
    const needed = this.a[i] * 360;
    if (needed <= 0) return this.time[i];
    const s = this.spin(i);
    const k = bound(s.total, needed);
    if (k >= s.total.length) return Infinity;
    if (k === 0) return s.time[0];
    const seg = s.total[k] - s.total[k - 1];
    const w = seg > 0 ? (needed - s.total[k - 1]) / seg : 0;
    return s.time[k - 1] + (s.time[k] - s.time[k - 1]) * w;
  }

  /** SpinnerRotationTracker under autoplay: the angle the cursor turns around the centre while a
   * button is held, between the spinner's start and end. */
  private spin(i: number): Spin {
    let s = this.spins.get(i);
    if (s) return s;
    const start = this.time[i];
    const end = this.end[i];
    const times = [start];
    for (let k = upper(this.frameTime, start); k < this.frameTime.length && this.frameTime[k] < end; k++) times.push(this.frameTime[k]);
    times.push(end);
    const time = Float64Array.from(times);
    const rotation = new Float64Array(time.length);
    const total = new Float64Array(time.length);
    const history = new SpinHistory();
    let [px, py] = this.cursorAt(start);
    let last = Math.atan2(py - SPINNER_Y, px - SPINNER_X);
    for (let k = 1; k < time.length; k++) {
      [px, py] = this.cursorAt(time[k]);
      const angle = Math.atan2(py - SPINNER_Y, px - SPINNER_X);
      let delta = ((angle - last) * 180) / Math.PI;
      if (delta > 180) delta -= 360;
      else if (delta < -180) delta += 360;
      last = angle;
      if (!this.buttonsAt(time[k - 1])) delta = 0;
      rotation[k] = rotation[k - 1] + delta;
      history.report(delta * this.spinRate);
      total[k] = history.total;
    }
    s = { time, rotation, total };
    this.spins.set(i, s);
    return s;
  }
}
