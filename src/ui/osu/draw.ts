/* draw.ts — canvas pieces the osu! skins share: osu!framework's circles, rings and glows, the
 * FontAwesome icons lazer draws with (SpriteIcon), textures centred and tinted. */
import { tex, type TexRef } from "../../lib/skin/skins";
import { css, tinted, type Colour } from "../mania/draw";

/** FontAwesome 5 solid icons (CC BY 4.0) as SpriteIcon draws them: [path, width, height]. */
export const ICON = {
  angleRight: [new Path2D("M224.3 273l-136 136c-9.4 9.4-24.6 9.4-33.9 0l-22.6-22.6c-9.4-9.4-9.4-24.6 0-33.9l96.4-96.4-96.4-96.4c-9.4-9.4-9.4-24.6 0-33.9L54.3 103c9.4-9.4 24.6-9.4 33.9 0l136 136c9.5 9.4 9.5 24.6.1 34z"), 256, 512],
  angleDoubleRight: [
    new Path2D(
      "M224.3 273l-136 136c-9.4 9.4-24.6 9.4-33.9 0l-22.6-22.6c-9.4-9.4-9.4-24.6 0-33.9l96.4-96.4-96.4-96.4c-9.4-9.4-9.4-24.6 0-33.9L54.3 103c9.4-9.4 24.6-9.4 33.9 0l136 136c9.5 9.4 9.5 24.6.1 34zm192-34l-136-136c-9.4-9.4-24.6-9.4-33.9 0l-22.6 22.6c-9.4 9.4-9.4 24.6 0 33.9l96.4 96.4-96.4 96.4c-9.4 9.4-9.4 24.6 0 33.9l22.6 22.6c9.4 9.4 24.6 9.4 33.9 0l136-136c9.4-9.2 9.4-24.4 0-33.8z",
    ),
    448,
    512,
  ],
  chevronRight: [
    new Path2D(
      "M285.476 272.971L91.132 467.314c-9.373 9.373-24.569 9.373-33.941 0l-22.667-22.667c-9.357-9.357-9.375-24.522-.04-33.901L188.505 256 34.484 101.255c-9.335-9.379-9.317-24.544.04-33.901l22.667-22.667c9.373-9.373 24.569-9.373 33.941 0L285.475 239.03c9.373 9.372 9.373 24.568.001 33.941z",
    ),
    320,
    512,
  ],
} as const;

export type Icon = (typeof ICON)[keyof typeof ICON];

/** A SpriteIcon `size` tall (its glyph keeps its proportions), centred on (0, 0). */
export function icon(ctx: CanvasRenderingContext2D, which: Icon, size: number, fill: string | CanvasGradient, sx = 1, sy = 1): void {
  const [path, w, h] = which;
  const k = size / Math.max(w, h);
  ctx.save();
  ctx.scale(sx * k, sy * k);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillStyle = fill;
  ctx.fill(path);
  ctx.restore();
}

export function disc(ctx: CanvasRenderingContext2D, x: number, y: number, diameter: number, fill: string | CanvasGradient): void {
  if (diameter <= 0) return;
  ctx.beginPath();
  ctx.arc(x, y, diameter / 2, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** osu!framework's CircularContainer border: `thickness` inside the circle's edge. */
export function ring(ctx: CanvasRenderingContext2D, x: number, y: number, diameter: number, thickness: number, stroke: string | CanvasGradient): void {
  const t = Math.min(thickness, diameter / 2);
  if (t <= 0) return;
  ctx.beginPath();
  ctx.arc(x, y, diameter / 2 - t / 2, 0, Math.PI * 2);
  ctx.lineWidth = t;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

/** A vertical gradient across a circle (ColourInfo.GradientVertical). */
export function vertical(ctx: CanvasRenderingContext2D, y: number, diameter: number, top: Colour, bottom: Colour, alpha = 1): CanvasGradient {
  const g = ctx.createLinearGradient(0, y - diameter / 2, 0, y + diameter / 2);
  g.addColorStop(0, css(top, alpha));
  g.addColorStop(1, css(bottom, alpha));
  return g;
}

/** The current transform's scale (device pixels per unit), for blur radii and shadow offsets. */
export function deviceScale(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b);
}

/** An EdgeEffect glow around a circle (just the glow, not the circle): `radius` beyond its edge;
 * hollow: only outside it. */
export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, diameter: number, radius: number, colour: Colour, alpha = 1, hollow = false): void {
  if (radius <= 0 || alpha <= 0 || diameter <= 0) return;
  const k = deviceScale(ctx);
  // the circle is drawn far off and only its shadow lands here (shadow offsets ignore transforms)
  const away = 100000;
  ctx.save();
  if (hollow) {
    // EdgeEffect.Hollow: nothing inside the circle
    const out = diameter / 2 + radius * 2;
    ctx.beginPath();
    ctx.rect(x - out, y - out, out * 2, out * 2);
    ctx.arc(x, y, diameter / 2, 0, Math.PI * 2, true);
    ctx.clip();
  }
  ctx.shadowColor = css(colour, alpha);
  ctx.shadowBlur = radius * k;
  ctx.shadowOffsetX = away * k;
  disc(ctx, x - away, y, diameter, "#000");
  ctx.restore();
}

/** A rounded box centred on (0, 0). */
export function box(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(radius, w / 2, h / 2));
}

/**
 * A texture centred on (x, y) at its own size (pixels / ratio, then `scale`), fitted into
 * `max` (Texture.WithMaximumSize) and tinted. Returns false when there's nothing to draw.
 */
export function sprite(ctx: CanvasRenderingContext2D, ref: TexRef | null | undefined, x: number, y: number, opts: { scale?: number; tint?: Colour; max?: [number, number]; ox?: number; oy?: number } = {}): boolean {
  const t = tex(ref);
  if (!t) return false;
  let { w, h } = t;
  if (opts.max) {
    const k = Math.min(1, opts.max[0] / w, opts.max[1] / h);
    w *= k;
    h *= k;
  }
  const s = opts.scale ?? 1;
  w *= s;
  h *= s;
  const img = opts.tint ? tinted(t.img, ref!.url, opts.tint) : t.img;
  ctx.drawImage(img, x - w * (opts.ox ?? 0.5), y - h * (opts.oy ?? 0.5), w, h);
  return true;
}

/** A texture's size in units (pixels / ratio), or null. */
export function size(ref: TexRef | null | undefined): [number, number] | null {
  const t = tex(ref);
  return t ? [t.w, t.h] : null;
}

/** lazer's numbers on circles and spinners (the app's sans in place of Venera / Torus). */
export function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, weight: number, fill: string): void {
  ctx.font = `${weight} ${px}px "Instrument Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

/** osu!framework's CircularProgress: an arc of `progress` of the circle clockwise from 12 o'clock
 * (then turned by `rotation` degrees), `inner` of the radius thick, with rounded caps. */
export function arc(ctx: CanvasRenderingContext2D, radius: number, progress: number, rotation: number, inner: number, stroke: string): void {
  if (progress <= 0) return;
  const thickness = radius * inner;
  const r = radius - thickness / 2;
  const a0 = ((rotation - 90) * Math.PI) / 180;
  const a1 = a0 + progress * Math.PI * 2;
  ctx.beginPath();
  ctx.arc(0, 0, r, a0, a1);
  ctx.lineWidth = thickness;
  ctx.lineCap = "round";
  ctx.strokeStyle = stroke;
  ctx.stroke();
}
