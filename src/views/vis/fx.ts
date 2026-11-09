/* fx.ts — what the visualizer answers a play in osu! with (lib/vis/feel): a spring for a camera
 * that gets bumped and settles, easing, letters spaced like a title card, a heartbeat on the beat,
 * motes of light, a sheen passing over glass. The styles use them in their own way (Stage so far). */
import type { Beat } from "../../lib/vis/beat";
import { css, type Rgb } from "../../lib/vis/palette";
import { still } from "../../ui/still";
import { FONT, TAU } from "./draw";

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
export const easeOut = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeIn = (t: number): number => Math.pow(clamp01(t), 2);
export const easeInOut = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** A small random generator with a seed, so a scatter (the lamps' order, say) stays the same. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A damped spring: bumped, it swings past and settles; given a target, it follows it with a
 * little give. `k` stiffness, `zeta` damping (below 1 it swings). */
export class Spring {
  x = 0;
  v = 0;

  constructor(
    private readonly k = 170,
    private readonly zeta = 0.42,
  ) {}

  /** A bump that takes it about `d` away at the furthest. */
  kick(d: number): void {
    this.v += d * Math.sqrt(this.k) * 1.7;
  }

  step(dt: number, target = 0): number {
    // small steps: steady at any frame time
    const n = Math.max(1, Math.ceil(dt * 240));
    const h = dt / n;
    const c = 2 * this.zeta * Math.sqrt(this.k);
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * (this.x - target) - c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }

  settled(target = 0): boolean {
    return Math.abs(this.x - target) < 1e-4 && Math.abs(this.v) < 1e-3;
  }

  reset(): void {
    this.x = 0;
    this.v = 0;
  }
}

/** How wide spaced() sets `s`. */
export function spacedWidth(c: CanvasRenderingContext2D, s: string, size: number, weight = 700, spacing = 0): number {
  c.font = `${weight} ${size}px ${FONT}`;
  const chars = [...s];
  return chars.reduce((sum, ch) => sum + c.measureText(ch).width, 0) + spacing * size * Math.max(0, chars.length - 1);
}

/** Text with its letters spaced out (`spacing` in em), set letter by letter; `each` can lift or
 * fade a letter (by its index) before it's drawn. The width it takes. */
export function spaced(
  c: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  o: { weight?: number; color?: string | CanvasGradient; spacing?: number; align?: "left" | "right"; each?: (i: number) => { alpha: number; dy: number } } = {},
): number {
  c.font = `${o.weight ?? 700} ${size}px ${FONT}`;
  c.textAlign = "left";
  c.textBaseline = "alphabetic";
  const chars = [...s];
  const gap = (o.spacing ?? 0) * size;
  const widths = chars.map((ch) => c.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, chars.length - 1);
  let cx = o.align === "right" ? x - total : x;
  c.fillStyle = o.color ?? "#fff";
  const alpha = c.globalAlpha;
  chars.forEach((ch, i) => {
    const e = o.each?.(i) ?? { alpha: 1, dy: 0 };
    if (e.alpha > 0.002) {
      c.globalAlpha = alpha * e.alpha;
      c.fillText(ch, cx, y + e.dy);
    }
    cx += widths[i] + gap;
  });
  c.globalAlpha = alpha;
  return total;
}

const beatPulse = (x: number, at: number, w: number): number => {
  const d = x - at;
  // quick to rise, slower to fall
  return Math.exp(-((d / (d < 0 ? w * 0.3 : w)) ** 2));
};

/** A heartbeat on the song's beat, 0–1: a strong beat and a softer one right after; on every other
 * beat when the song is fast. Without a beat 76 a minute, by `clock` (s). */
export function heartbeat(beat: Beat | null, clock: number): number {
  let ms: number;
  if (beat) {
    const double = beat.bpm > 135;
    ms = (double && beat.key & 1 ? beat.length : 0) + beat.phase * beat.length;
  } else ms = (clock * 1000) % (60_000 / 76);
  return Math.min(1, beatPulse(ms, 0, 60) + 0.6 * beatPulse(ms, 210, 75));
}

export interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 1 → 0 */
  life: number;
  /** seconds it lives */
  span: number;
  r: number;
  /** how far it sways from side to side, px, and how fast */
  sway: number;
  freq: number;
  phase: number;
  /** drawn in the warm colour */
  warm: boolean;
}

/** Motes of light, drifting up and swaying, glowing a little, fading in and out. */
export class Motes {
  readonly list: Mote[] = [];
  private age = 0;

  add(m: Mote): void {
    if (this.list.length < 260) this.list.push(m);
  }

  step(dt: number): void {
    this.age += dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      m.life -= dt / m.span;
      if (m.life <= 0) {
        this.list.splice(i, 1);
        continue;
      }
      // the air holds them back; the sway is a velocity, so it doesn't drift off on its own
      m.vy *= Math.exp(-dt * 0.45);
      m.vx *= Math.exp(-dt * 0.8);
      m.x += (m.vx + Math.cos(this.age * m.freq * TAU + m.phase) * m.sway) * dt;
      m.y += m.vy * dt;
    }
  }

  draw(c: CanvasRenderingContext2D, ink: Rgb, warm: Rgb, alpha = 1): void {
    if (!this.list.length) return;
    c.save();
    c.globalCompositeOperation = "lighter";
    for (const m of this.list) {
      // in quickly, out slowly
      const age = 1 - m.life;
      const a = alpha * Math.min(1, age / 0.12) * Math.pow(m.life, 0.7);
      if (a < 0.01) continue;
      const rgb = m.warm ? warm : ink;
      c.fillStyle = css(rgb, a * 0.16);
      c.beginPath();
      c.arc(m.x, m.y, m.r * 3.2, 0, TAU);
      c.fill();
      c.fillStyle = css(rgb, a * 0.95);
      c.beginPath();
      c.arc(m.x, m.y, m.r, 0, TAU);
      c.fill();
    }
    c.restore();
  }
}

/**
 * A band of light passing over the box like a reflection over glass: `p` from about −0.3 (not in
 * yet) to 1.3 (gone) along `angle` (radians, the way it travels). A sharp front, a long soft tail.
 */
export function sheen(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, p: number, o: { width: number; alpha: number; color: Rgb; angle: number }): void {
  if (o.alpha <= 0.002) return;
  const dx = Math.cos(o.angle);
  const dy = Math.sin(o.angle);
  const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const g = c.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  // the band's brightness along the way: the tail behind, the front ahead
  const shape: [number, number][] = [
    [p - o.width, 0],
    [p - o.width * 0.45, 0.35],
    [p - o.width * 0.08, 1],
    [p, 0.9],
    [p + o.width * 0.12, 0],
  ];
  const at = (u: number): number => {
    if (u <= shape[0][0] || u >= shape[shape.length - 1][0]) return 0;
    for (let i = 1; i < shape.length; i++) {
      const [u1, a1] = shape[i];
      const [u0, a0] = shape[i - 1];
      if (u <= u1) return a0 + ((a1 - a0) * (u - u0)) / (u1 - u0);
    }
    return 0;
  };
  const stops = [0, ...shape.map(([u]) => u).filter((u) => u > 0 && u < 1), 1];
  for (const u of stops) g.addColorStop(u, css(o.color, o.alpha * at(u)));
  c.save();
  c.globalCompositeOperation = "screen";
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
  c.restore();
}

const layers = new Map<string, HTMLCanvasElement>();

/** A W×H picture made once, a quarter of the size (gradients lose nothing by it), and kept. */
export function soft(key: string, W: number, H: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement | ImageBitmap {
  let canvas = layers.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(W / 4));
    canvas.height = Math.max(1, Math.ceil(H / 4));
    const c = canvas.getContext("2d")!;
    c.scale(canvas.width / W, canvas.height / H);
    paint(c);
    if (layers.size >= 6) layers.delete(layers.keys().next().value!);
    layers.set(key, canvas);
  }
  return still(canvas);
}

/** The dark that closes in from the edges (low health): the clear middle is small, so drawn
 * `scale` (1 or more) times the window's size the dark stays outside, and near 1× it's close. */
export function closingDark(c: CanvasRenderingContext2D, W: number, H: number, scale: number, alpha: number): void {
  if (alpha <= 0.002) return;
  const img = soft(`dark ${W}x${H}`, W, H, (x) => {
    const r = Math.hypot(W, H) / 2;
    const g = x.createRadialGradient(W / 2, H / 2, r * 0.32, W / 2, H / 2, r);
    g.addColorStop(0, "rgba(4,0,2,0)");
    g.addColorStop(0.45, "rgba(6,0,3,.5)");
    g.addColorStop(1, "rgba(7,0,3,.94)");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
  });
  c.save();
  c.globalAlpha = alpha;
  const w = W * scale;
  const h = H * scale;
  c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  c.restore();
}
