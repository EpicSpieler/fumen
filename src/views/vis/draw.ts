/* draw.ts — what every visualizer style draws from: the frame (the song this moment, the beat, the
 * look) and the pieces they share (the background, the cover with its crossfade, text). */
import type { Analysis } from "../../lib/vis/analysis";
import type { Beat } from "../../lib/vis/beat";
import { css, type Rgb } from "../../lib/vis/palette";
import type { VisPrefs } from "../../lib/types";
import { glowBox } from "../../ui/glow";
import { still } from "../../ui/still";

export interface Art {
  /** the cover, or null while there's none */
  img: HTMLImageElement | HTMLCanvasElement | null;
  /** a small blurred copy for backgrounds */
  blur: HTMLCanvasElement | null;
}

export interface Look {
  a: Rgb;
  b: Rgb;
  /** a near-white tinted by `a` */
  ink: Rgb;
}

export interface VisFrame {
  c: CanvasRenderingContext2D;
  /** the whole canvas, CSS pixels */
  W: number;
  H: number;
  /** the part between the top bar and the transport, where the content goes */
  x: number;
  y: number;
  w: number;
  h: number;
  dt: number;
  /** seconds played, standing still while paused */
  clock: number;
  /** where the song is, seconds as you hear it (at the rate) */
  time: number;
  playing: boolean;
  a: Analysis;
  beat: Beat | null;
  /** a beat began on this frame */
  newBeat: boolean;
  /** the beat as it falls off, 0–1, stronger on a bar's first; the kick's without a beatmap */
  pulse: number;
  /** what styles move by: the pulse or a kick, times the beat setting */
  hit: number;
  /** 0–1, eased in and out */
  kiai: number;
  /** 0–1 of a flash, faded */
  flash: number;
  look: Look;
  art: Art;
  /** the art before a track change and how far the new one has faded in */
  prevArt: Art | null;
  artMix: number;
  meta: { title: string; artist: string; version: string };
  o: VisPrefs;
}

export interface Style {
  /** Draws a frame; true while something still moves on its own (sparks, waves). */
  draw(f: VisFrame): boolean;
}

export const TAU = Math.PI * 2;
export const FONT = `"Instrument Sans", ui-sans-serif, system-ui, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", sans-serif`;
export { css };

/** Bars low to high, or with `mirror` the bass in the middle and the highs to both sides. */
export function bars(f: VisFrame, n: number, mirror: boolean): Float32Array {
  if (!mirror) return f.a.bands(n);
  const half = Math.ceil(n / 2);
  const v = f.a.bands(half);
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = v[Math.min(half - 1, k < half ? half - 1 - k : k - half)];
  return out;
}

function fitImage(c: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number, zoom: number, px: number, py: number): void {
  const iw = (img as HTMLImageElement).naturalWidth || img.width;
  const ih = (img as HTMLImageElement).naturalHeight || img.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * s;
  const dh = ih * s;
  c.drawImage(img, x + (w - dw) / 2 + px * w, y + (h - dh) / 2 + py * h, dw, dh);
}

/** The cover filling x/y/w/h (cropped to fit), the old one under it while the new one fades in. */
export function drawArt(f: VisFrame, x: number, y: number, w: number, h: number, o: { blur?: boolean; zoom?: number; px?: number; py?: number } = {}): void {
  const c = f.c;
  const pick = (a: Art) => (o.blur && a.blur ? still(a.blur) : a.img);
  const cur = pick(f.art);
  const prev = f.prevArt && f.artMix < 1 ? pick(f.prevArt) : null;
  const zoom = o.zoom ?? 1;
  if (!cur && !prev) {
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, "#1d1c24");
    g.addColorStop(1, "#121116");
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
    return;
  }
  if (prev) fitImage(c, prev, x, y, w, h, zoom, o.px ?? 0, o.py ?? 0);
  if (cur) {
    const alpha = c.globalAlpha;
    c.globalAlpha = alpha * (prev ? f.artMix : 1);
    fitImage(c, cur, x, y, w, h, zoom, o.px ?? 0, o.py ?? 0);
    c.globalAlpha = alpha;
  }
}

/** The cover in a rounded box, with a coloured glow under it. */
export function artCard(f: VisFrame, x: number, y: number, w: number, h: number, r: number, glow = 0): void {
  const c = f.c;
  if (glow > 0) glowBox(c, x, y, w, h, r, f.h * (0.05 + 0.08 * f.a.bass), unit(f.look.a), glow);
  c.save();
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  c.clip();
  drawArt(f, x, y, w, h);
  c.restore();
}

/** The whole canvas: the cover (blurred, as it is, or none) dimmed, a glow from below in kiai, a vignette. */
export function background(f: VisFrame, o: { dim?: number; still?: boolean } = {}): void {
  const { c, W, H } = f;
  const mode = f.o.background;
  const push = o.still ? 0 : f.hit;
  c.fillStyle = "#060608";
  c.fillRect(0, 0, W, H);
  if (mode === "blur") drawArt(f, 0, 0, W, H, { blur: true, zoom: 1.12 + 0.025 * push });
  else if (mode === "art") drawArt(f, 0, 0, W, H, { zoom: 1.02 + 0.02 * push });
  if (mode !== "black") {
    c.fillStyle = `rgba(0,0,0,${o.dim ?? f.o.dim})`;
    c.fillRect(0, 0, W, H);
  }
  // the gradients are smooth: drawn small once and scaled up, not filled over the window each frame
  if (f.kiai > 0.01) {
    const a = f.look.a;
    const g = layer(`kiai ${W}x${H} ${a.map(Math.round)}`, W, H, (x) => {
      const g = x.createRadialGradient(W / 2, H * 1.05, 0, W / 2, H * 1.05, H);
      g.addColorStop(0, css(a, 0.32));
      g.addColorStop(1, css(a, 0));
      return g;
    });
    c.globalAlpha = f.kiai;
    c.drawImage(still(g), 0, 0, W, H);
    c.globalAlpha = 1;
  }
  const v = layer(`vignette ${W}x${H}`, W, H, (x) => {
    const v = x.createRadialGradient(W / 2, H * 0.45, H * 0.2, W / 2, H * 0.45, Math.max(W, H) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,.55)");
    return v;
  });
  c.drawImage(still(v), 0, 0, W, H);
}

/** a vis colour (0–255) as the glow's (0–1) */
export const unit = (c: Rgb): [number, number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255, 1];

const layers = new Map<string, HTMLCanvasElement>();

/** A W×H gradient, drawn a quarter of the size and kept (the last few). */
function layer(key: string, W: number, H: number, gradient: (c: CanvasRenderingContext2D) => CanvasGradient): HTMLCanvasElement {
  let canvas = layers.get(key);
  if (canvas) return canvas;
  const k = 0.25;
  canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(W * k));
  canvas.height = Math.max(1, Math.ceil(H * k));
  const x = canvas.getContext("2d")!;
  x.scale(canvas.width / W, canvas.height / H);
  x.fillStyle = gradient(x);
  x.fillRect(0, 0, W, H);
  if (layers.size >= 8) layers.delete(layers.keys().next().value!);
  layers.set(key, canvas);
  return canvas;
}

/** One line of text, cut with an ellipsis at `maxW`. */
export function text(
  c: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  o: { weight?: number; color?: string; align?: CanvasTextAlign; maxW?: number; base?: CanvasTextBaseline } = {},
): void {
  c.font = `${o.weight ?? 600} ${size}px ${FONT}`;
  c.fillStyle = o.color ?? "rgba(255,255,255,.92)";
  c.textAlign = o.align ?? "left";
  c.textBaseline = o.base ?? "alphabetic";
  let t = s;
  const maxW = o.maxW ?? Infinity;
  if (c.measureText(t).width > maxW) {
    while (t.length > 1 && c.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    t += "…";
  }
  c.fillText(t, x, y);
}

/** Title and artist, centred at x, the title's baseline at y. */
export function titleBlock(f: VisFrame, x: number, y: number, size: number, align: CanvasTextAlign = "center", maxW = f.w * 0.8): void {
  text(f.c, f.meta.title, x, y, size, { weight: 700, color: "rgba(255,255,255,.95)", align, maxW });
  text(f.c, f.meta.artist, x, y + size * 0.95, size * 0.57, { weight: 500, color: "rgba(255,255,255,.62)", align, maxW });
}
