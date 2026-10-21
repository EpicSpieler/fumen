/* analysis.ts — what the visualizer reads from the song each frame: levels per band, bass/mid/high,
 * kicks and snares, the waveform.
 *
 * Two analysers without the browser's smoothing (lib/eq): a long one that's exact in the bass,
 * a short one that's quick above it. 128 log-spaced bands from 30 Hz to 16 kHz, +3 dB per octave
 * so the treble isn't always flat. The level follows the song (up at once, down 5 dB a second),
 * so a loud master doesn't sit at the top and a quiet one still moves; how much of the range
 * shows is the sensitivity. Rise and fall are ours, per frame time, from the reaction setting.
 * Onsets are spectral flux above an adaptive threshold. */
import { analysers } from "../eq";

export const BANDS = 128;
const LO = 30;
const HI = 16_000;
/** below this the long analyser's bins are used */
const SPLIT = 400;

export const bandLo = new Float32Array(BANDS);
export const bandHi = new Float32Array(BANDS);
export const bandMid = new Float32Array(BANDS);
const tilt = new Float32Array(BANDS);
for (let i = 0; i < BANDS; i++) {
  bandLo[i] = LO * Math.pow(HI / LO, i / BANDS);
  bandHi[i] = LO * Math.pow(HI / LO, (i + 1) / BANDS);
  bandMid[i] = Math.sqrt(bandLo[i] * bandHi[i]);
  tilt[i] = 3 * Math.log2(bandMid[i] / 1000);
}

/** Where a frequency sits on the band scale (0 at 30 Hz, 1 at 16 kHz). */
export const bandPos = (hz: number): number => Math.log(hz / LO) / Math.log(HI / LO);

/** A band's level in dB from FFT bins: the loudest bin in it, or between two bins when it's narrower than one. */
export function readBand(db: ArrayLike<number>, hzPerBin: number, lo: number, hi: number): number {
  const b0 = lo / hzPerBin;
  const b1 = hi / hzPerBin;
  if (b1 - b0 < 1.2) {
    const c = (b0 + b1) / 2;
    const i = Math.floor(c);
    const x = i < db.length ? db[i] : -160;
    const y = i + 1 < db.length ? db[i + 1] : -160;
    return x + (y - x) * (c - i);
  }
  let m = -200;
  for (let b = Math.floor(b0); b <= Math.ceil(b1) && b < db.length; b++) if (db[b] > m) m = db[b];
  return m;
}

/** Levels 0–1 from dB per band, following the song's own loudness. A band's steady sound fills at
 * most about half the height; what rises above its own last second (a kick, a snare, a new note)
 * fills the rest, so a loud, dense song doesn't stand still as a wall. */
export class Levels {
  readonly target = new Float32Array(BANDS);
  readonly shown = new Float32Array(BANDS);
  /** each band's level over about the last second, dB */
  readonly avg = new Float32Array(BANDS).fill(-120);
  /** the loudest band lately, dB */
  ceil = -40;

  /** `sensitivity` 0–1 narrows the range shown; `reaction` 0–1 (smooth → fast) sets rise and fall. */
  update(db: Float32Array | null, dt: number, sensitivity: number, reaction: number): void {
    if (db) {
      let mx = -200;
      for (let i = 0; i < BANDS; i++) if (db[i] > mx) mx = db[i];
      this.ceil = mx > this.ceil ? this.ceil + (mx - this.ceil) * Math.min(1, dt * 25) : this.ceil - dt * 5;
      this.ceil = Math.max(this.ceil, -75);
      const range = 50 - 24 * sensitivity;
      const jump = 14 - 6 * sensitivity;
      const k = 1 - Math.exp(-dt / 0.8);
      for (let i = 0; i < BANDS; i++) {
        const v = Math.min(1, Math.max(0, (db[i] - (this.ceil - range)) / range));
        if (this.avg[i] < -110) this.avg[i] = db[i];
        const rise = Math.max(0, db[i] - this.avg[i]) / jump;
        this.avg[i] += (db[i] - this.avg[i]) * k;
        this.target[i] = Math.min(1, 0.5 * Math.pow(v, 1.6) + 0.75 * rise * (0.4 + 0.6 * v));
      }
    } else {
      this.target.fill(0);
      this.avg.fill(-120);
    }
    const up = 1 - Math.exp(-dt / (0.004 + 0.05 * (1 - reaction)));
    const down = 1 - Math.exp(-dt / (0.07 + 0.38 * (1 - reaction)));
    for (let i = 0; i < BANDS; i++) {
      const t = this.target[i];
      const s = this.shown[i];
      this.shown[i] = s + (t - s) * (t > s ? up : down);
    }
  }
}

/** Spectral flux against its own running mean and spread. */
export class Onset {
  private prev = 0;
  private mean = 0;
  private varc = 0;
  private last = -1;

  constructor(
    private readonly k: number,
    private readonly gap: number,
  ) {}

  /** True when `energy` jumps (at most once per `gap` seconds); `now` in seconds. */
  feed(energy: number, now: number, dt: number): boolean {
    const flux = Math.max(0, energy - this.prev);
    this.prev = energy;
    const hit = flux > this.mean + this.k * Math.sqrt(this.varc) && flux > 1e-4 && now - this.last > this.gap;
    const a = 1 - Math.exp(-dt / 0.45);
    this.mean += (flux - this.mean) * a;
    this.varc += ((flux - this.mean) ** 2 - this.varc) * a;
    if (hit) this.last = now;
    return hit;
  }

  reset(): void {
    this.prev = this.mean = this.varc = 0;
    this.last = -1;
  }
}

/** Fewer or more values from a band array: the loudest of the ones merged, or in between. */
export function resample(src: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  const N = src.length;
  for (let j = 0; j < n; j++) {
    const a = (j * N) / n;
    const b = ((j + 1) * N) / n;
    if (b - a >= 1) {
      let m = 0;
      for (let k = Math.floor(a); k < Math.ceil(b) && k < N; k++) if (src[k] > m) m = src[k];
      out[j] = m;
    } else {
      const c = (a + b) / 2 - 0.5;
      const i = Math.max(0, Math.floor(c));
      const f = c - i;
      out[j] = src[i] * (1 - f) + src[Math.min(N - 1, i + 1)] * f;
    }
  }
  return out;
}

export class Analysis {
  readonly levels = new Levels();
  /** time-domain samples, −1…1 */
  wave = new Float32Array(2048);
  bass = 0;
  mid = 0;
  high = 0;
  /** a kick's pulse: 1 at the kick, falling off */
  kick = 0;
  /** what started on this frame, if anything */
  onset: "kick" | "snare" | null = null;
  private db = new Float32Array(BANDS);
  private fLong = new Float32Array(0);
  private fShort = new Float32Array(0);
  private kicks = new Onset(1.6, 0.14);
  private snares = new Onset(1.8, 0.12);
  private cache = new Map<number, Float32Array>();

  /** Reads one frame; `playing` false lets everything fall. */
  read(dt: number, now: number, playing: boolean, sensitivity: number, reaction: number): void {
    this.cache.clear();
    this.onset = null;
    const a = playing ? analysers() : null;
    if (a) {
      if (this.fLong.length !== a.long.frequencyBinCount) this.fLong = new Float32Array(a.long.frequencyBinCount);
      if (this.fShort.length !== a.short.frequencyBinCount) this.fShort = new Float32Array(a.short.frequencyBinCount);
      if (this.wave.length !== a.short.fftSize) this.wave = new Float32Array(a.short.fftSize);
      a.long.getFloatFrequencyData(this.fLong);
      a.short.getFloatFrequencyData(this.fShort);
      a.short.getFloatTimeDomainData(this.wave);
      const hzLong = a.ctx.sampleRate / a.long.fftSize;
      const hzShort = a.ctx.sampleRate / a.short.fftSize;
      let kick = 0;
      let snare = 0;
      for (let i = 0; i < BANDS; i++) {
        const long = bandHi[i] < SPLIT;
        let d = readBand(long ? this.fLong : this.fShort, long ? hzLong : hzShort, bandLo[i], bandHi[i]);
        if (!(d > -160)) d = -160;
        d += tilt[i];
        this.db[i] = d;
        if (bandMid[i] > 40 && bandMid[i] < 140) kick += Math.pow(10, d / 20);
        else if (bandMid[i] > 1800 && bandMid[i] < 9000) snare += Math.pow(10, d / 20);
      }
      if (this.kicks.feed(kick, now, dt)) {
        this.kick = 1;
        this.onset = "kick";
      }
      if (this.snares.feed(snare, now, dt) && !this.onset) this.onset = "snare";
    } else this.wave.fill(0);
    this.levels.update(a ? this.db : null, dt, sensitivity, reaction);
    this.kick *= Math.exp(-dt / 0.13);
    // bass below 160 Hz, mids to 2 kHz, highs above
    const sum = [0, 0, 0];
    const count = [0, 0, 0];
    const s = this.levels.shown;
    for (let i = 0; i < BANDS; i++) {
      const r = bandMid[i] < 160 ? 0 : bandMid[i] < 2000 ? 1 : 2;
      sum[r] += s[i];
      count[r]++;
    }
    this.bass = sum[0] / count[0];
    this.mid = sum[1] / count[1];
    this.high = sum[2] / count[2];
  }

  /** The levels as `n` bars, low to high. */
  bands(n: number): Float32Array {
    let v = this.cache.get(n);
    if (!v) {
      v = resample(this.levels.shown, n);
      this.cache.set(n, v);
    }
    return v;
  }

  /** Whether anything is still moving (levels falling after a pause). */
  get moving(): boolean {
    const s = this.levels.shown;
    for (let i = 0; i < BANDS; i++) if (s[i] > 0.004) return true;
    return this.kick > 0.01;
  }

  reset(): void {
    this.kicks.reset();
    this.snares.reset();
  }
}
