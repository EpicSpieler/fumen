/* chart.ts — an osu!catch chart as the playfield reads it (src-tauri/src/catch.rs builds it the
 * way lazer does, MIT, ppy Pty Ltd), and what autoplay's catcher does with it:
 *
 *  - where the catcher is (CatchFramedReplayInputHandler: straight between replay frames), which
 *    way it faces (CatcherArea.SetCatcherPosition), when it dashes and hyperdashes
 *    (Catcher.OnNewResult / SetHyperDashState);
 *  - what lands on its plate and where (Catcher.computePositionInStack), until the combo ends and
 *    it all flies off (Catcher.Explode); droplets fly off as they're caught;
 *  - the random looks lazer gives every object (StatelessRNG, seeded by its time).
 */
import type { CatchChartData, ChartData } from "../../lib/types";
import { bound, upper } from "../taiko/chart";

export { bound, upper };

export const FRUIT = 0;
export const DROPLET = 1;
export const TINY = 2;
export const BANANA = 3;

/** CatchPlayfield */
export const WIDTH = 512;
export const HEIGHT = 384;
export const CENTER_X = WIDTH / 2;
/** CatchPlayfieldAdjustmentContainer: osu!stable's catcher line and where fruits come from */
export const CATCHER_Y = 340;
export const FRUIT_START_Y = -100;
/** the scrolling area's height (osu!pixels) */
export const FALL_HEIGHT = CATCHER_Y - FRUIT_START_Y;
/** CatchHitObject.OBJECT_RADIUS */
export const OBJECT_RADIUS = 64;
/** Catcher */
export const BASE_SIZE = 106.75;
export const ALLOWED_CATCH_RANGE = 0.8;
const BASE_DASH_SPEED = 1;
/** Catcher.caught_fruit_scale_adjust */
export const CAUGHT_SCALE = 0.5;
/** Catcher.caughtObjectContainer.Y */
export const PLATE_Y = -5;
/** DrawableBanana */
const BANANA_END_SCALE = 0.6;
const BANANA_SCALE_RANGE = 1.6;
/** DrawableDroplet: it turns twice while it falls (and a while after) */
const DROPLET_SPIN_EXTRA = 2000;
/** Catcher.HYPER_DASH_TRANSITION_DURATION */
export const HYPER_TRANSITION = 180;

const OBJ = 6;

// ── StatelessRNG (osu.Game.Utils) ────────────────────────────────────────

const M64 = (1n << 64n) - 1n;

function mix(x: bigint): bigint {
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & M64;
  x ^= x >> 33n;
  x = (x * 0xc4ceb9fe1a85ec53n) & M64;
  x ^= x >> 33n;
  return x;
}

function nextULong(seed: number, series: number): bigint {
  const combined = (BigInt(series >>> 0) << 32n) | BigInt(seed >>> 0);
  return mix(combined ^ 0x12345678n);
}

/** StatelessRNG.NextSingle: 0 ≤ v < 1 */
export const nextSingle = (seed: number, series: number): number => Number(nextULong(seed, series) & 0xffffffn) / 16777216;
/** StatelessRNG.NextInt */
export const nextInt = (max: number, seed: number, series = 0): number => Number(nextULong(seed, series) % BigInt(max));

/** A seeded generator for what lazer leaves to chance (RNG), so a moment always looks the same. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catcher.CalculateCatchWidth */
export const catchWidth = (catcherScale: number): number => BASE_SIZE * Math.abs(catcherScale) * ALLOWED_CATCH_RANGE;

export class CatchChart {
  readonly n: number;
  /** by time */
  readonly time: Float64Array;
  readonly kind: Uint8Array;
  readonly x: Float32Array;
  readonly hyper: Uint8Array;
  readonly lastInCombo: Uint8Array;
  /** IndexInBeatmap: the colour (index + 1) and a fruit's look (index % 4) */
  readonly index: Int32Array;
  readonly banana: Int32Array;
  readonly kiai: Uint8Array;
  /** combo before it was caught (ComboAtJudgement) */
  readonly combo: Int32Array;
  /** StatelessRNG.NextSingle(seed, 1 / 2 / 3) */
  readonly r1: Float32Array;
  readonly r2: Float32Array;
  readonly r3: Float32Array;
  /** Banana: StatelessRNG.NextInt(3, seed) */
  readonly bananaColour: Uint8Array;

  /** where it sits on the plate, from the catcher (osu!pixels), and how it's shown there */
  readonly plateX: Float32Array;
  readonly plateY: Float32Array;
  /** when it leaves the plate (droplets: right away; Infinity: never) and the catcher's x then */
  readonly clearAt: Float64Array;
  readonly clearX: Float32Array;

  readonly scale: number;
  readonly catcherScale: number;
  readonly preempt: number;
  readonly colours: [number, number, number][];

  private readonly fTime: Float64Array;
  private readonly fX: Float32Array;
  private readonly fDash: Uint8Array;
  /** which way the catcher faces from each frame on (1 right, -1 left) */
  private readonly fDir: Int8Array;
  /** hyperdashes: [start, end) */
  readonly hyperStart: Float64Array;
  readonly hyperEnd: Float64Array;

  constructor(d: ChartData) {
    const c = d.catch as CatchChartData;
    const o = c.objects;
    const n = o.length / OBJ;
    this.n = n;
    this.scale = c.scale;
    this.catcherScale = c.scale * 2;
    this.preempt = c.preempt;
    this.colours = c.colours;

    // by time (a juice stream can reach past the next object's start)
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => o[a * OBJ] - o[b * OBJ] || a - b);
    this.time = new Float64Array(n);
    this.kind = new Uint8Array(n);
    this.x = new Float32Array(n);
    this.hyper = new Uint8Array(n);
    this.lastInCombo = new Uint8Array(n);
    this.index = new Int32Array(n);
    this.banana = new Int32Array(n);
    order.forEach((src, i) => {
      const b = src * OBJ;
      this.time[i] = o[b];
      this.kind[i] = o[b + 1];
      this.x[i] = o[b + 2];
      this.hyper[i] = o[b + 3] & 1;
      this.lastInCombo[i] = (o[b + 3] >> 1) & 1;
      this.index[i] = o[b + 4];
      this.banana[i] = o[b + 5];
    });

    const f = c.frames;
    const nf = f.length / 3;
    this.fTime = new Float64Array(nf);
    this.fX = new Float32Array(nf);
    this.fDash = new Uint8Array(nf);
    this.fDir = new Int8Array(nf);
    let dir = 1;
    for (let k = 0; k < nf; k++) {
      this.fTime[k] = f[k * 3];
      this.fX[k] = f[k * 3 + 1];
      this.fDash[k] = f[k * 3 + 2];
    }
    for (let k = 0; k < nf; k++) {
      // the way it moves until the next frame (or kept, standing still)
      if (k + 1 < nf && this.fX[k + 1] !== this.fX[k]) dir = this.fX[k + 1] > this.fX[k] ? 1 : -1;
      this.fDir[k] = dir;
    }

    // the random looks (DrawableCatchHitObject.RandomSingle; seeded by the start time as an int)
    this.r1 = new Float32Array(n);
    this.r2 = new Float32Array(n);
    this.r3 = new Float32Array(n);
    this.bananaColour = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const seed = Math.trunc(this.time[i]) | 0;
      this.r1[i] = nextSingle(seed, 1);
      if (this.kind[i] === BANANA) {
        this.r2[i] = nextSingle(seed, 2);
        this.r3[i] = nextSingle(seed, 3);
        this.bananaColour[i] = nextInt(3, seed);
      }
    }

    const kiai = d.kiai;
    this.kiai = new Uint8Array(n);
    this.combo = new Int32Array(n);
    let combo = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      // HitObject.Kiai: the effect point just after its start
      const t = this.time[i] + 1;
      while (s + 2 < kiai.length && kiai[s + 1] <= t) s += 2;
      this.kiai[i] = s + 1 < kiai.length && kiai[s] <= t && t < kiai[s + 1] ? 1 : 0;
      this.combo[i] = combo;
      if (this.kind[i] === FRUIT || this.kind[i] === DROPLET) combo++;
    }

    // hyperdashes: from catching a hyper fruit until the next catch that isn't a tiny droplet,
    // if the catcher has to go faster than dashing to make it
    const hs: number[] = [];
    const he: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.hyper[i] || this.kind[i] === TINY || this.kind[i] === BANANA) continue;
      let j = i + 1;
      while (j < n && this.kind[j] !== FRUIT && this.kind[j] !== DROPLET) j++;
      if (j >= n) continue;
      const at = this.catcherX(this.time[i]);
      const v = (this.x[j] - at) / Math.max(1, this.time[j] - this.time[i] - 1000 / 60);
      if (Math.abs(v) / BASE_DASH_SPEED <= 1 || at === this.x[j]) continue;
      let k = i + 1;
      while (k < n && this.kind[k] === TINY) k++;
      hs.push(this.time[i]);
      he.push(k < n ? this.time[k] : this.time[j]);
    }
    this.hyperStart = Float64Array.from(hs);
    this.hyperEnd = Float64Array.from(he);

    // the plate
    this.plateX = new Float32Array(n);
    this.plateY = new Float32Array(n);
    this.clearAt = new Float64Array(n).fill(Infinity);
    this.clearX = new Float32Array(n);
    const rand = mulberry(n * 7919 + Math.trunc(this.time[0] ?? 0));
    let plate: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = this.time[i];
      const cx = this.catcherX(t);
      // computePositionInStack: nudged up and sideways until it doesn't sit on another
      const adjusted = this.displaySize(i) * (10 / OBJECT_RADIUS);
      const check = adjusted * adjusted;
      let px = this.x[i] - cx;
      let py = 0;
      for (let guard = 0; guard < 200 && plate.some((p) => (this.plateX[p] - px) ** 2 + (this.plateY[p] - py) ** 2 < check); guard++) {
        px += (rand() * 2 - 1) * adjusted;
        py -= rand() * 5;
      }
      this.plateX[i] = px;
      this.plateY[i] = py;
      const k = this.kind[i];
      if (k === FRUIT || k === BANANA) plate.push(i);
      else {
        // CaughtDroplet doesn't stay on the plate
        this.clearAt[i] = t;
        this.clearX[i] = cx;
      }
      if (this.lastInCombo[i]) {
        for (const p of plate) {
          this.clearAt[p] = t;
          this.clearX[p] = cx;
        }
        plate = [];
      }
    }
  }

  /** The drawn size across (DisplaySize.X) as it's caught. */
  displaySize(i: number): number {
    const k = this.kind[i];
    const s = OBJECT_RADIUS * 2 * this.scale;
    return k === TINY ? s / 2 : k === BANANA ? s * BANANA_END_SCALE : s;
  }

  /** The piece's scale at `t` (ScalingContainer.Scale / Scale, before CS): bananas shrink as they fall. */
  pieceScale(i: number, t: number): number {
    const k = this.kind[i];
    if (k === TINY) return 0.5;
    if (k !== BANANA) return 1;
    const p = Math.min(1, (t - (this.time[i] - this.preempt)) / this.preempt);
    const from = BANANA_END_SCALE + BANANA_SCALE_RANGE * this.r3[i];
    return from + (BANANA_END_SCALE - from) * p;
  }

  /** The piece's rotation at `t`, degrees. */
  rotation(i: number, t: number): number {
    const k = this.kind[i];
    if (k === FRUIT) return (this.r1[i] - 0.5) * 40;
    if (k === BANANA) {
      const p = Math.min(1, (t - (this.time[i] - this.preempt)) / this.preempt);
      const from = 180 * (this.r1[i] * 2 - 1);
      const to = 180 * (this.r2[i] * 2 - 1);
      return from + (to - from) * p;
    }
    const start = this.r1[i] * 20;
    const p = (t - (this.time[i] - this.preempt)) / (this.preempt + DROPLET_SPIN_EXTRA);
    return start + 720 * p;
  }

  /** The catcher's x at `t`. */
  catcherX(t: number): number {
    const ft = this.fTime;
    const n = ft.length;
    if (!n) return CENTER_X;
    const k = upper(ft, t) - 1;
    if (k < 0) return this.fX[0];
    if (k >= n - 1) return this.fX[n - 1];
    const span = ft[k + 1] - ft[k];
    const p = span > 0 ? (t - ft[k]) / span : 1;
    return Math.max(0, Math.min(WIDTH, this.fX[k] + (this.fX[k + 1] - this.fX[k]) * p));
  }

  /** Whether autoplay holds dash at `t`. */
  dashing(t: number): boolean {
    const k = upper(this.fTime, t) - 1;
    return k >= 0 && this.fDash[k] === 1;
  }

  /** Which way the catcher faces at `t`: 1 right, -1 left. */
  direction(t: number): number {
    const k = upper(this.fTime, t) - 1;
    if (k < 0) return 1;
    // still on its way from the frame before: it faces the way it moves
    return this.fDir[k];
  }

  /** The hyperdash going on at `t` (index into hyperStart / hyperEnd), or -1. */
  hyperAt(t: number): number {
    const k = upper(this.hyperStart, t) - 1;
    return k >= 0 && t < this.hyperEnd[k] ? k : -1;
  }

  /** How far the catcher has turned the hyperdash colour at `t` (0–1, FadeColour over 180 ms OutQuint). */
  hyperTint(t: number): number {
    const k = upper(this.hyperStart, t) - 1;
    if (k < 0) return 0;
    // a chain of hyperdashes is one long one
    let s = k;
    while (s > 0 && this.hyperEnd[s - 1] >= this.hyperStart[s]) s--;
    const start = this.hyperStart[s];
    const end = this.hyperEnd[k];
    const outQuint = (x: number) => 1 - (1 - Math.min(1, Math.max(0, x))) ** 5;
    const on = outQuint((t - start) / HYPER_TRANSITION);
    return t < end ? on : on * (1 - outQuint((t - end) / HYPER_TRANSITION));
  }

  /** Whether a hyperdash starts at `start` (not one chained to the last): the after-image shows. */
  hyperBegins(k: number): boolean {
    return k === 0 || this.hyperEnd[k - 1] < this.hyperStart[k];
  }

  /** The last object caught by `t` (-1 for none yet). */
  lastCaught(t: number): number {
    return upper(this.time, t) - 1;
  }
}
