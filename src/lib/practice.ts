/* practice.ts — what practice mode in the fullscreen playfield works with: a part of the chart
 * (song ms, A to B), remembered per difficulty; its hardest part (the densest stretch, of one
 * pattern when asked); the beats of its timing points; and a metronome on them.
 *
 * The metronome is scheduled a little ahead on the Web Audio clock the song plays through (eq.ts),
 * mapped from the song's position the way the hitsounds are (hitsounds.ts): a jump in the song or
 * a pause stops it and starts over from there. Its clicks don't change pitch with the rate.
 */
import { player } from "../player";
import { audioContext } from "./eq";
import { lowerBound } from "./charts";
import { events as storeEvents, store } from "./store";
import type { ChartData, PatternName } from "./types";

export interface Section {
  a: number;
  b: number;
}

/** the parts picked, per difficulty id (this PC only) */
const KEY = "fumen.practice";
const KEEP = 400;

function saved(): Record<string, Section> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function savedSection(mapId: string): Section | null {
  const s = saved()[mapId];
  return s && Number.isFinite(s.a) && Number.isFinite(s.b) && s.b > s.a ? { a: s.a, b: s.b } : null;
}

export function saveSection(mapId: string, s: Section | null): void {
  try {
    const all = saved();
    delete all[mapId];
    if (s) all[mapId] = { a: Math.round(s.a), b: Math.round(s.b) };
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - KEEP))) delete all[id];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage off: it's just not remembered
  }
}

// ── beats ─────────────────────────────────────────────────────────────

interface Grid {
  t0: number;
  len: number;
  meter: number;
  /** where the next timing point takes over */
  until: number;
}

/** The timing point in force at `t` (the first one before it starts). */
function gridAt(beats: number[], t: number): Grid | null {
  if (beats.length < 3) return null;
  let i = 0;
  while (i + 3 < beats.length && beats[i + 3] <= t + 0.5) i += 3;
  const len = beats[i + 1];
  if (!(len > 0)) return null;
  return { t0: beats[i], len, meter: Math.max(1, beats[i + 2] || 4), until: i + 3 < beats.length ? beats[i + 3] : Infinity };
}

/** The beat at or after `t`: its time, and whether a bar starts on it. */
export function beatFrom(beats: number[], t: number): { t: number; down: boolean } | null {
  const g = gridAt(beats, t);
  if (!g) return null;
  const n = Math.ceil((t - g.t0) / g.len - 1e-6);
  const at = g.t0 + n * g.len;
  // a new timing point restarts the bar
  if (at >= g.until - 1) return { t: g.until, down: true };
  return { t: at, down: ((n % g.meter) + g.meter) % g.meter === 0 };
}

/** `t` on the nearest beat, or the bar's start at or before it (`bar`). */
export function snapBeat(beats: number[], t: number, bar = false): number {
  const g = gridAt(beats, t);
  if (!g) return t;
  if (bar) {
    const step = g.len * g.meter;
    return g.t0 + Math.floor((t - g.t0) / step + 1e-6) * step;
  }
  return g.t0 + Math.round((t - g.t0) / g.len) * g.len;
}

// ── the hardest part ──────────────────────────────────────────────────

/** how long the hardest part runs, s */
const HARDEST = 16;
/** a second of another pattern counts this much when looking for one pattern's hardest part */
const OTHER = 0.3;

/**
 * The densest stretch of about 16 s, from a bar's start; with `pattern` (osu!mania), the one
 * where that pattern is densest.
 */
export function hardest(d: ChartData, pattern?: PatternName | null): Section {
  const a = d.analysis;
  const dens = a.density;
  const w = a.windows;
  const weight = (i: number) => dens[i] * (pattern && w ? (w[i] === pattern ? 1 : OTHER) : 1);
  const span = Math.min(HARDEST, dens.length);
  let best = 0;
  let sum = 0;
  let top = -1;
  for (let i = 0; i < dens.length; i++) {
    sum += weight(i);
    if (i >= span) sum -= weight(i - span);
    if (i >= span - 1 && sum > top) {
      top = sum;
      best = i - span + 1;
    }
  }
  const from = a.start + best * 1000;
  const start = Math.max(0, snapBeat(d.beats, from, true));
  const to = Math.min(a.end + 500, from + span * 1000);
  let end = beatFrom(d.beats, to)?.t ?? to;
  if (end > a.end + 1500) end = a.end + 500;
  return { a: start < from - 4000 ? from : start, b: Math.max(end, start + 2000) };
}

/** How many of the chart's objects start inside a part. */
export function notesIn(d: ChartData, s: Section): number {
  return (lowerBound(d.notes, s.b) - lowerBound(d.notes, s.a)) / 3;
}

// ── metronome ─────────────────────────────────────────────────────────

/** how far ahead clicks are scheduled, s */
const LOOKAHEAD = 0.12;
const TICK = 25;
/** ms of song the clocks may part before it counts as a jump */
const JUMP = 40;

class Metronome {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private beats: number[] = [];
  private on = false;
  private timer = 0;
  private offs: (() => void)[] = [];
  private anchor: { song: number; at: number; rate: number } | null = null;
  /** the next beat to schedule, song ms */
  private next: { t: number; down: boolean } | null = null;
  private voices: { osc: OscillatorNode; end: number }[] = [];

  constructor() {
    storeEvents.on("prefs", (p) => {
      if ("volume" in p) this.applyVolume();
    });
  }

  setBeats(beats: number[]): void {
    this.beats = beats;
    this.halt();
  }

  setActive(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      const a = player.audio;
      const kick = () => this.tick();
      for (const ev of ["play", "pause", "seeking", "seeked", "ratechange"]) {
        a.addEventListener(ev, kick);
        this.offs.push(() => a.removeEventListener(ev, kick));
      }
      this.timer = window.setInterval(kick, TICK);
      this.tick();
    } else {
      clearInterval(this.timer);
      this.offs.forEach((f) => f());
      this.offs = [];
      this.halt();
    }
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = audioContext();
    if (!ctx) return null;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.applyVolume();
    return ctx;
  }

  private applyVolume(): void {
    if (!this.out || !this.ctx) return;
    const v = store.prefs.volume;
    this.out.gain.setTargetAtTime(v * v * 0.5, this.ctx.currentTime, 0.015);
  }

  private tick(): void {
    const ctx = this.context();
    const a = player.audio;
    if (!this.on || !ctx || a.paused || a.seeking || ctx.state !== "running" || !this.beats.length) return this.halt();
    const now = ctx.currentTime;
    const song = a.currentTime * 1000;
    const rate = player.rate;
    let an = this.anchor;
    if (an && an.rate === rate) {
      const drift = song - (an.song + (now - an.at) * 1000 * rate);
      if (Math.abs(drift) > JUMP) an = null;
      else an.song += drift * 0.1;
    } else an = null;
    if (!an) {
      this.halt();
      an = this.anchor = { song, at: now, rate };
      this.next = beatFrom(this.beats, song);
    }
    const horizon = an.song + (now + LOOKAHEAD - an.at) * 1000 * rate;
    let guard = 64;
    while (this.next && this.next.t <= horizon && guard-- > 0) {
      const at = an.at + (this.next.t - an.song) / 1000 / rate;
      if (at >= now - 0.01) this.click(ctx, Math.max(at, now), this.next.down);
      this.next = beatFrom(this.beats, this.next.t + 1);
    }
    this.voices = this.voices.filter((v) => v.end > now);
  }

  /** a short tick, higher on the bar's first beat */
  private click(ctx: AudioContext, at: number, down: boolean): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = down ? 1720 : 1180;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(down ? 1 : 0.7, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.06);
    osc.connect(g).connect(this.out!);
    osc.start(at);
    osc.stop(at + 0.07);
    this.voices.push({ osc, end: at + 0.07 });
  }

  private halt(): void {
    this.anchor = null;
    this.next = null;
    for (const v of this.voices) {
      try {
        v.osc.stop();
      } catch {
        // never started
      }
    }
    this.voices = [];
  }
}

export const metronome = new Metronome();
