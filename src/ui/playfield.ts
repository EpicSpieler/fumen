/* playfield.ts — canvas drawings of a chart: the osu!mania playfield (notes falling to a
 * judgement line, keys lighting up when hit, like lazer's) and the notes-per-second graph. */
import { lowerBound } from "../lib/charts";
import type { ChartData } from "../lib/types";

/** Lane tones mirrored from the edges, like most mania skins: neutral / accent / centre. */
export function laneTone(lane: number, keys: number): "n" | "a" | "c" {
  if (keys % 2 === 1 && lane === (keys - 1) / 2) return "c";
  return Math.min(lane, keys - 1 - lane) % 2 === 0 ? "n" : "a";
}

/** Accent colours from the page (they follow the cover art), re-read at most a few times a second. */
export class AccentColors {
  accent = "#8b7cff";
  ink = "#c9c1ff";
  private read = -Infinity;

  update(): this {
    const now = performance.now();
    if (now - this.read < 400) return this;
    const cs = getComputedStyle(document.documentElement);
    this.accent = cs.getPropertyValue("--accent").trim() || this.accent;
    this.ink = cs.getPropertyValue("--accent-ink").trim() || this.ink;
    this.read = now;
    return this;
  }

  tone(t: "n" | "a" | "c"): string {
    return t === "n" ? "#e9e9ee" : t === "a" ? this.accent : this.ink;
  }
}

/** Fits a canvas' backing store to its CSS size; returns the 2D context in CSS pixels. */
export function fitCanvas(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (c.width !== bw || c.height !== bh) {
    c.width = bw;
    c.height = bh;
  }
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/*
 * Layout like lazer's: the stage is laid out in a 768-unit-tall space and scaled uniformly to the
 * height it gets, so columns, notes and keys keep their proportions at any window size.
 */
const STAGE_H = 768;
const COLUMN_W = 60;
/** judgement line, from the bottom (lazer's hit target position) */
const HIT_POSITION = 110;
const NOTE_H = 18;
const KEY_H = 46;

/** Width of one column at a playfield height of `h` px. */
export function columnWidth(h: number): number {
  return Math.max(24, (h / STAGE_H) * COLUMN_W);
}

export class Playfield {
  private readonly maxHold: number;
  private readonly colors = new AccentColors();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly data: ChartData,
  ) {
    let max = 0;
    for (let i = 2; i < data.notes.length; i += 3) max = Math.max(max, data.notes[i]);
    /** longest hold, so holds that started out of view are still drawn */
    this.maxHold = max;
  }

  /**
   * Draws the chart at `t` (song ms). `span` is the song time a note takes from the far edge to
   * the judgement line; `up` puts the judgement line at the top (lazer's "Up" direction).
   */
  draw(t: number, span: number, up = false): void {
    const fit = fitCanvas(this.canvas);
    const d = this.data;
    if (!fit || d.keys < 1) return;
    const { ctx, w: W, h: H } = fit;
    const colors = this.colors.update();

    const keys = d.keys;
    const laneW = W / keys;
    // one stage unit in px; columns may be narrower when the stage doesn't fit the width
    const u = Math.min(H / STAGE_H, laneW / COLUMN_W);
    const judge = Math.round((H / STAGE_H) * HIT_POSITION);
    const judgeY = up ? judge : H - judge;
    const pxPerMs = (H - judge) / span;
    const dir = up ? 1 : -1;
    const y = (ms: number) => judgeY + dir * (ms - t) * pxPerMs;
    const tFar = t + span;
    const tNear = t - judge / pxPerMs;
    const noteH = Math.max(6, NOTE_H * u);
    const radius = noteH * 0.3;
    const pad = Math.max(1.5, 3 * u);

    // columns
    ctx.fillStyle = "rgba(255,255,255,.045)";
    for (let i = 1; i < keys; i++) ctx.fillRect(Math.round(i * laneW), 0, 1, H);

    // bar lines
    ctx.fillStyle = "rgba(255,255,255,.08)";
    const b = d.beats;
    for (let i = 0; i < b.length; i += 3) {
      const t0 = b[i];
      const measure = b[i + 1] * (b[i + 2] || 4);
      const until = i + 3 < b.length ? b[i + 3] : Infinity;
      if (measure < 50 || t0 > tFar || until < tNear) continue;
      for (let k = Math.max(0, Math.ceil((tNear - t0) / measure)); ; k++) {
        const tm = t0 + k * measure;
        if (tm > tFar || tm >= until) break;
        ctx.fillRect(0, Math.round(y(tm)), W, 1);
      }
    }

    // notes; keys under the judgement line light up while a note is being hit
    const lit = new Array<boolean>(keys).fill(false);
    const n = d.notes;
    for (let i = lowerBound(n, tNear - this.maxHold); i < n.length && n[i] <= tFar; i += 3) {
      const start = n[i];
      const lane = n[i + 1];
      const len = n[i + 2];
      const end = start + len;
      if (end < tNear || lane < 0 || lane >= keys) continue;
      const x = lane * laneW;
      const color = colors.tone(laneTone(lane, keys));
      const passed = end < t - 30;
      if (Math.abs(start - t) < 70 || (len > 0 && start <= t && end >= t)) lit[lane] = true;
      ctx.fillStyle = color;
      if (len > 0) {
        const bodyW = (laneW - 2 * pad) * 0.7;
        const a = y(start);
        const e = y(end);
        ctx.globalAlpha = passed ? 0.12 : 0.38;
        ctx.fillRect(x + (laneW - bodyW) / 2, Math.min(a, e), bodyW, Math.abs(a - e));
        ctx.globalAlpha = passed ? 0.22 : 0.9;
        roundRect(ctx, x + (laneW - bodyW) / 2, e - noteH / 4, bodyW, noteH / 2, noteH / 4);
      }
      ctx.globalAlpha = passed ? 0.22 : 1;
      roundRect(ctx, x + pad, y(start) - noteH / 2, laneW - 2 * pad, noteH, radius);
    }
    ctx.globalAlpha = 1;

    // keys just past the judgement line, light up while their column is hit
    const keyH = Math.min(KEY_H * u, judge - 8 * u);
    const gap = 8 * u;
    const keyTop = up ? judgeY - gap - keyH : judgeY + gap;
    for (let i = 0; i < keys; i++) {
      ctx.fillStyle = lit[i] ? colors.tone(laneTone(i, keys)) : "rgba(255,255,255,.07)";
      ctx.globalAlpha = lit[i] ? 0.45 : 1;
      roundRect(ctx, i * laneW + pad, keyTop, laneW - 2 * pad, keyH, Math.max(3, 8 * u));
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.accent;
    ctx.fillRect(0, judgeY - 1, W, 2);
  }
}

/**
 * Notes-per-second graph over the whole chart: breaks dimmed, kiai shaded, one bar per second.
 * `total` is the time axis in song ms.
 */
export function drawDensity(c: HTMLCanvasElement, d: ChartData, total: number, colors: AccentColors): void {
  const fit = fitCanvas(c);
  if (!fit) return;
  const { ctx, w: W, h: H } = fit;
  const a = d.analysis;
  const accent = colors.update().accent;
  const x = (ms: number) => (ms / total) * W;

  ctx.fillStyle = "rgba(255,255,255,.035)";
  for (let i = 0; i < d.breaks.length; i += 2) ctx.fillRect(x(d.breaks[i]), 0, x(d.breaks[i + 1]) - x(d.breaks[i]), H);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.12;
  for (let i = 0; i < d.kiai.length; i += 2) ctx.fillRect(x(d.kiai[i]), 0, x(d.kiai[i + 1]) - x(d.kiai[i]), H);

  const max = Math.max(1, ...a.density);
  const barW = x(1000);
  const gap = barW > 4 ? 1 : 0;
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < a.density.length; i++) {
    const v = a.density[i];
    if (!v) continue;
    const h = Math.max(2, (v / max) * (H - 6));
    ctx.fillRect(x(a.start + i * 1000), H - h, Math.max(1, barW - gap), h);
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}
