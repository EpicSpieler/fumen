/* draw.ts — canvas helpers shared by the skin renderers: lazer's colour maths, easing curves,
 * vertical mirroring for the "Up" scroll direction, tinted and flipped images. */
import { glowBox } from "../glow";
import { still } from "../still";

/** RGBA with channels 0–1, like lazer's Color4 */
export type Colour = [number, number, number, number];

export const rgb = (hex: string, a = 1): Colour => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};
export const fromBytes = (c: [number, number, number, number]): Colour => [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];
export const WHITE: Colour = [1, 1, 1, 1];
export const BLACK: Colour = [0, 0, 0, 1];

/** osu!framework's Color4 extensions */
export const multiply = (c: Colour, s: number): Colour => [Math.min(1, c[0] * s), Math.min(1, c[1] * s), Math.min(1, c[2] * s), c[3]];
export const lighten = (c: Colour, amount: number): Colour => multiply(c, 1 + amount);
export const darken = (c: Colour, amount: number): Colour => multiply(c, 1 / (1 + amount));
export const opacity = (c: Colour, a: number): Colour => [c[0], c[1], c[2], a];
export const mix = (a: Colour, b: Colour, t: number): Colour => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];

export const css = (c: Colour, alpha = 1): string =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.max(0, Math.min(1, c[3] * alpha))})`;

/** osu!framework easings used by the skins (t in 0–1) */
export const ease = {
  none: (t: number) => t,
  out: (t: number) => t * (2 - t),
  in: (t: number) => t * t,
  outQuint: (t: number) => 1 - (1 - t) ** 5,
  inQuint: (t: number) => t ** 5,
  outSine: (t: number) => Math.sin((t * Math.PI) / 2),
  inSine: (t: number) => 1 - Math.cos((t * Math.PI) / 2),
  outElastic: (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((t - 0.075) * (2 * Math.PI)) / 0.3) + 1),
  outElasticHalf: (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin(((0.5 * t - 0.075) * (2 * Math.PI)) / 0.3) + 1),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
};

/** A tween's value at `t` ms after its start, clamped to its ends. */
export function tween(t: number, from: number, to: number, duration: number, curve: (x: number) => number = ease.none): number {
  if (t <= 0) return from;
  if (t >= duration || duration <= 0) return to;
  return from + (to - from) * curve(t / duration);
}

/**
 * Drawing space: one unit is one of lazer's stage units (768 per stage height). Everything is laid
 * out as in the "Down" direction, by distance `d` from the bottom of the stage; "Up" mirrors it.
 */
export class View {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    /** stage height in units */
    readonly S: number,
    readonly up: boolean,
    /** device pixels per unit (for blur radii, which canvas doesn't scale) */
    readonly px: number,
  ) {}

  /** canvas y of the top / bottom of the band d0 ≤ d ≤ d1 */
  band(d0: number, d1: number): [number, number] {
    return this.up ? [d0, d1] : [this.S - d1, this.S - d0];
  }

  rect(x: number, w: number, d0: number, d1: number): void {
    const [top, bottom] = this.band(d0, d1);
    this.ctx.fillRect(x, top, w, bottom - top);
  }

  /**
   * Draws (part of) an image into the band. `mirror`: the image turns upside down with the
   * direction (lazer flips most mania pieces for "Up", but not all).
   */
  image(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, x: number, w: number, d0: number, d1: number, mirror = true): void {
    if (sw <= 0 || sh <= 0 || w === 0 || d1 <= d0) return;
    const [top, bottom] = this.band(d0, d1);
    const flip = this.up && mirror;
    this.drawImage(src, sx, sy, sw, sh, x, top, w, bottom - top, flip);
  }

  /** drawImage with an optional vertical flip of the destination */
  drawImage(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, x: number, y: number, w: number, h: number, flipY: boolean): void {
    const ctx = this.ctx;
    if (!flipY) {
      ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
      return;
    }
    ctx.save();
    ctx.translate(0, y * 2 + h);
    ctx.scale(1, -1);
    ctx.drawImage(src, sx, sy, sw, sh, x, y, w, h);
    ctx.restore();
  }

  /** Clips later drawing to the band (save/restore around it). */
  clip(x: number, w: number, d0: number, d1: number): void {
    const [top, bottom] = this.band(d0, d1);
    this.ctx.beginPath();
    this.ctx.rect(x, top, w, Math.max(0, bottom - top));
    this.ctx.clip();
  }

  roundRect(x: number, w: number, d0: number, d1: number, r: number): void {
    const [top, bottom] = this.band(d0, d1);
    const h = bottom - top;
    if (w <= 0 || h <= 0) return;
    this.ctx.beginPath();
    this.ctx.roundRect(x, top, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  }

  /** canvas y of a distance from the bottom */
  y(d: number): number {
    return this.up ? d : this.S - d;
  }

  /** A vertical gradient over the band, from the colour at d0 to the one at d1. */
  gradient(d0: number, d1: number, c0: string, c1: string): CanvasGradient {
    const g = this.ctx.createLinearGradient(0, this.y(d0), 0, this.y(d1));
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    return g;
  }

  /** Glow (lazer's EdgeEffect) of a rounded box in the band, radius in units; draw the box after it. */
  glow(x: number, w: number, d0: number, d1: number, r: number, colour: Colour, radius: number, alpha = 1): void {
    const [top, bottom] = this.band(d0, d1);
    glowBox(this.ctx, x, top, w, bottom - top, r, radius, colour, alpha);
  }
}

// ── tinting ───────────────────────────────────────────────────────────────

const tints = new Map<string, HTMLCanvasElement>();

/** The image multiplied by a colour (lazer's sprite Colour), alpha kept; cached. */
export function tinted(img: HTMLImageElement, key: string, c: Colour): CanvasImageSource {
  if (c[0] >= 1 && c[1] >= 1 && c[2] >= 1) return img;
  const k = `${key}|${c[0].toFixed(3)},${c[1].toFixed(3)},${c[2].toFixed(3)}`;
  let canvas = tints.get(k);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(img, 0, 0);
    tints.set(k, canvas);
    if (tints.size > 400) tints.delete(tints.keys().next().value!);
  }
  return still(canvas);
}
