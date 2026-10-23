/* playfield.ts — chart drawing helpers: lane tones, accent colours, the notes-per-second graph.
 * The osu!mania playfield itself, in lazer's skins, lives in ./mania. */
import { pixelRatio } from "./render-scale";
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
  const dpr = pixelRatio();
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
