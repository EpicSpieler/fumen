/* glow.ts — glows (lazer's EdgeEffect: a blurred copy of a shape under it) from a cache.
 *
 * A canvas shadow blurs again on every draw. For a playfield that's hundreds of blurs a second,
 * which WebKitGTK (Linux) does on the processor: a few frames a second. Here each glow is rendered
 * once, with the same shadow, into a small offscreen canvas, and after that only drawn, stretched
 * to the shape — the way lazer draws its glows as textures. Sizes are rounded to 4 % steps for the
 * cache (a glow that much wider or narrower looks the same), colours to 1/32. */
import type { Colour } from "./mania/draw";

/** a shape: a box with rounded corners (a circle when r = w / 2 = h / 2), filled or outlined */
interface Shape {
  w: number;
  h: number;
  r: number;
  /** outline width; 0: filled */
  stroke: number;
}

/** a rendered glow: the shape was `w` × `h` device pixels, the picture reaches `margin` past it */
interface Rendered {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  margin: number;
}

const cache = new Map<string, Rendered>();
const MAX = 300;
/** the largest side of a cached glow, pixels */
const LIMIT = 256;

const STEP = Math.log(1.04);
const q = (v: number) => (v > 0 ? Math.round(Math.log(v) / STEP) : -999);
const back = (k: number) => (k === -999 ? 0 : Math.exp(k * STEP));
const qc = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 32);

/** The current transform's scale (device pixels per unit). */
function scaleOf(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b) || 1;
}

/** The glow of shape `s` (device pixels), shadow blur `blur`, in `colour` at full strength. */
function render(s: Shape, blur: number, hollow: boolean, colour: Colour): Rendered {
  // a canvas shadow reaches about 1.5 × its blur
  const margin = blur * 1.5 + s.stroke;
  const W = s.w + margin * 2;
  const H = s.h + margin * 2;
  // big glows are kept smaller than they're shown: a blur loses nothing by it
  const k = Math.min(1, LIMIT / Math.max(W, H));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(W * k));
  canvas.height = Math.max(1, Math.ceil(H * k));
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const path = (dx: number) => {
    ctx.beginPath();
    ctx.roundRect(margin + dx, margin, s.w, s.h, Math.max(0, Math.min(s.r, s.w / 2, s.h / 2)));
  };
  // the shape far off; only its shadow lands here (shadow offsets ignore the transform)
  const away = 100000;
  ctx.save();
  ctx.shadowColor = `rgb(${colour.slice(0, 3).map((c) => Math.round(c * 255)).join(",")})`;
  ctx.shadowBlur = blur * k;
  ctx.shadowOffsetX = away * k;
  path(-away);
  if (s.stroke > 0) {
    ctx.lineWidth = s.stroke;
    ctx.strokeStyle = "#000";
    ctx.stroke();
  } else {
    ctx.fillStyle = "#000";
    ctx.fill();
  }
  ctx.restore();
  if (hollow) {
    // EdgeEffect.Hollow: nothing inside the shape
    ctx.globalCompositeOperation = "destination-out";
    path(0);
    ctx.fill();
  }
  return { canvas, w: s.w, h: s.h, margin };
}

/**
 * The glow of a rounded box at (x, y, w, h) in the current transform: what a canvas shadow of
 * `shadowBlur = blur × scale` and colour `colour` (alpha × `alpha`) would draw for it. Draw the
 * shape itself after it. `stroke`: the glow of its outline that wide; `hollow`: none inside it.
 */
export function glowBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, blur: number, colour: Colour, alpha = 1, o: { stroke?: number; hollow?: boolean } = {}): void {
  const a = colour[3] * alpha;
  if (blur <= 0 || a <= 0 || w <= 0 || h <= 0) return;
  // in device pixels, so the blur is as sharp as the shadow's would be
  const px = scaleOf(ctx);
  const parts = [q(w * px), q(h * px), q(r * px), q(blur * px), q((o.stroke ?? 0) * px)];
  const tint = [qc(colour[0]), qc(colour[1]), qc(colour[2])];
  const key = [...parts, o.hollow ? 1 : 0, ...tint].join(",");
  let hit = cache.get(key);
  if (hit) cache.delete(key);
  else {
    const [qw, qh, qr, qb, qs] = parts.map(back);
    hit = render({ w: qw, h: qh, r: qr, stroke: qs }, qb, !!o.hollow, [tint[0] / 32, tint[1] / 32, tint[2] / 32, 1]);
    if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  }
  // most recently used last
  cache.set(key, hit);
  // the rounded shape stretched onto this one, its margins with it
  const sx = w / hit.w;
  const sy = h / hit.h;
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.drawImage(hit.canvas, x - hit.margin * sx, y - hit.margin * sy, (hit.w + hit.margin * 2) * sx, (hit.h + hit.margin * 2) * sy);
  ctx.restore();
}

let scratch: HTMLCanvasElement | null = null;

/**
 * The glow of whatever `shape` fills (bars, text: shapes that change every frame, so nothing to
 * cache), inside the box x/y/w/h of the current transform: blurred on a small canvas, a quarter of
 * the size or so, and scaled up. A blur loses nothing by it, and it's a sixteenth of the work.
 * `blur` as for glowBox, `colour` a CSS colour.
 */
export function glowOf(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, blur: number, colour: string, shape: (c: CanvasRenderingContext2D) => void): void {
  if (blur <= 0 || w <= 0 || h <= 0) return;
  const px = scaleOf(ctx);
  // small, but with the blur still a few pixels wide
  const k = Math.min(1, Math.max(0.25, 6 / (blur * px))) * px;
  const margin = blur * 1.5;
  const cw = Math.max(1, Math.ceil((w + margin * 2) * k));
  const ch = Math.max(1, Math.ceil((h + margin * 2) * k));
  scratch ??= document.createElement("canvas");
  // one empty pixel more each way: scaling up reads a little past the picture's edge
  if (scratch.width < cw + 1 || scratch.height < ch + 1) {
    scratch.width = Math.max(scratch.width, cw + 1);
    scratch.height = Math.max(scratch.height, ch + 1);
  }
  const c = scratch.getContext("2d")!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cw + 1, ch + 1);
  // the shape far off; only its shadow lands here
  const away = 100000;
  c.setTransform(k, 0, 0, k, (margin - x - away) * k, (margin - y) * k);
  c.shadowColor = colour;
  c.shadowBlur = blur * k;
  c.shadowOffsetX = away * k;
  c.fillStyle = "#000";
  shape(c);
  c.shadowColor = "transparent";
  ctx.drawImage(scratch, 0, 0, cw, ch, x - margin, y - margin, cw / k, ch / k);
}

/** The glow of a circle of `diameter` around (x, y). */
export function glowCircle(ctx: CanvasRenderingContext2D, x: number, y: number, diameter: number, blur: number, colour: Colour, alpha = 1, o: { stroke?: number; hollow?: boolean } = {}): void {
  glowBox(ctx, x - diameter / 2, y - diameter / 2, diameter, diameter, diameter / 2, blur, colour, alpha, o);
}
