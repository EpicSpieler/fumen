/* triangles.ts — lazer's "triangles" skin on the osu!taiko playfield: the default pieces (MIT,
 * ppy Pty Ltd):
 *
 *  - PlayfieldBackgroundLeft / Right, DefaultInputDrum (lazer's drum textures, pink / blue hit
 *    overlays), TaikoHitTarget, DefaultBarLine;
 *  - CirclePiece (CentreHit / RimHit / Elongated / Swell): the accent circle with drifting
 *    triangles, a white ring, the symbol; glow, flashed on kiai beats and when hit;
 *  - DefaultHitExplosion, DefaultKiaiHitExplosion, DefaultSwell, TickPiece, DefaultJudgementPiece.
 */
import { tex, type TexRef } from "../../lib/skin/skins";
import { css, ease, mix, rgb, tinted, tween, type Colour } from "../mania/draw";
import { seeded } from "../mania/argon";
import { BASE_HEIGHT, DEFAULT_SIZE, HIT_X, INPUT_DRUM_WIDTH, KEYS, LEFT_CENTRE, LEFT_RIM, RIGHT_CENTRE, RIGHT_RIM, STRONG_SCALE, type TaikoChart } from "./chart";
import type { HitEvent, HitPiece, RollPiece, SwellPiece, TaikoFrame, TaikoRenderer, TickPiece } from "./playfield";

/** OsuColour */
export const C = {
  gray0: rgb("#000000"),
  gray1: rgb("#111111"),
  pink: rgb("#ff66aa"),
  pinkDarker: rgb("#bb1177"),
  blue: rgb("#66ccff"),
  blueDarker: rgb("#2299bb"),
  yellowLight: rgb("#ffdd55"),
  yellowDark: rgb("#eeaa00"),
  yellowDarker: rgb("#cc6600"),
};
/** Hit.COLOUR_CENTRE / COLOUR_RIM */
export const COLOUR_CENTRE = rgb("#bb1177");
export const COLOUR_RIM = rgb("#2299bb");

/** CirclePiece */
const SYMBOL_SIZE = DEFAULT_SIZE;
const SYMBOL_BORDER = 8;
const PRE_BEAT = 80;
const KIAI_FLASH = 0.15;
const EDGE_ALPHA_KIAI = 0.5;
/** TaikoStrongableHitObject.DEFAULT_STRONG_SIZE */
const STRONG_SIZE = DEFAULT_SIZE * STRONG_SCALE;

export interface DrumTextures {
  outer: TexRef | null;
  outerHit: TexRef | null;
  inner: TexRef | null;
  innerHit: TexRef | null;
}

/** A path of a circle (or a pill, when wider than tall) centred on (x, y). */
export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h / 2, w, h, Math.min(w, h) / 2);
}

/**
 * The input drum's key animations (DefaultInputDrum / LegacyInputDrum style): each press scales
 * the part down by `down` in 40 ms and lights its overlay by +0.5 (capped at 1), then both ease
 * back over `up` ms (OutQuint). Returns [scale, overlay alpha].
 */
export function drumPress(ch: TaikoChart, key: number, t: number, up = 1000, down = 0.05): [number, number] {
  const k = KEYS.indexOf(key as (typeof KEYS)[number]);
  const presses = ch.keyPresses[k];
  const last = ch.lastPress(k, t);
  if (last < 0) return [1, 0];
  // the overlay's alpha when each press came, from the presses before it (a few are enough)
  const alphaAfter = (i: number, at: number, depth: number): number => {
    if (i < 0) return 0;
    const e = at - presses[i];
    const from = depth > 0 ? alphaAfter(i - 1, presses[i], depth - 1) : 0;
    const peak = Math.min(1, from + 0.5);
    if (e < 40) return tween(e, from, peak, 40, ease.outQuint);
    return peak * (1 - ease.outQuint(Math.min(1, (e - 40) / up)));
  };
  const e = t - presses[last];
  const scale = e < 40 ? tween(e, 1, 1 - down, 40, ease.outQuint) : tween(e - 40, 1 - down, 1, up, ease.outQuint);
  return [scale, alphaAfter(last, t, 3)];
}

/** The glow lazer's EdgeEffect draws around a filled shape (shadow of the shape itself). */
function withGlow(f: TaikoFrame, colour: Colour, radius: number, alpha: number, fill: () => void): void {
  const ctx = f.ctx;
  if (radius <= 0 || alpha <= 0) return fill();
  ctx.save();
  ctx.shadowColor = css(colour, alpha);
  ctx.shadowBlur = radius * f.px;
  fill();
  ctx.restore();
}

export class TrianglesRenderer implements TaikoRenderer {
  constructor(private readonly drumTex: DrumTextures | null = null) {}

  // ── the playfield ─────────────────────────────────────────────────────

  backgroundRight(f: TaikoFrame): void {
    const ctx = f.ctx;
    // a soft shadow under the strip, the strip at 60%, a thin border
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.2)";
    ctx.shadowBlur = 5 * f.px;
    ctx.fillStyle = css(C.gray0, 0.6);
    ctx.fillRect(0, 0, f.width, BASE_HEIGHT);
    ctx.restore();
    ctx.strokeStyle = css(C.gray0);
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, f.width - 2, BASE_HEIGHT - 2);
  }

  backgroundLeft(f: TaikoFrame): void {
    const ctx = f.ctx;
    ctx.fillStyle = css(C.gray1);
    ctx.fillRect(0, 0, INPUT_DRUM_WIDTH, BASE_HEIGHT);
    const g = ctx.createLinearGradient(INPUT_DRUM_WIDTH, 0, INPUT_DRUM_WIDTH + 10, 0);
    g.addColorStop(0, "rgba(0,0,0,.6)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(INPUT_DRUM_WIDTH, 0, 10, BASE_HEIGHT);
  }

  drum(f: TaikoFrame): void {
    const ctx = f.ctx;
    const d = this.drumTex;
    if (!d) return;
    // DefaultInputDrum: a square the drum area's width at its top, everything at 0.9 around its
    // centre; two halves 2.5% apart, each showing half of the outer and inner textures
    const S = INPUT_DRUM_WIDTH;
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.scale(0.9, 0.9);
    ctx.translate(-S / 2, -S / 2);
    const split = 0.025 * S;
    for (const right of [false, true]) {
      const cx = right ? S / 2 + split / 2 : S / 2 - split / 2;
      ctx.save();
      ctx.beginPath();
      if (right) ctx.rect(cx, 0, S, S);
      else ctx.rect(cx - S, 0, S, S);
      ctx.clip();
      const part = (ref: TexRef | null, size: number, scale: number, alpha: number, colour: Colour | null) => {
        const t = tex(ref);
        if (!t || alpha <= 0) return;
        const w = size * scale;
        ctx.save();
        ctx.globalAlpha *= alpha;
        if (colour) ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(colour && ref ? tinted(t.img, ref.url, colour) : t.img, cx - w / 2, S / 2 - w / 2, w, w);
        ctx.restore();
      };
      const [rimScale, rimAlpha] = drumPress(f.chart, right ? RIGHT_RIM : LEFT_RIM, f.t, 1000 * f.rate);
      const [centreScale, centreAlpha] = drumPress(f.chart, right ? RIGHT_CENTRE : LEFT_CENTRE, f.t, 1000 * f.rate);
      part(d.outer, S, rimScale, 1, null);
      part(d.outerHit, S, rimScale, rimAlpha, C.blue);
      part(d.inner, S * 0.7, centreScale, 1, null);
      part(d.innerHit, S * 0.7, centreScale, centreAlpha, C.pink);
      ctx.restore();
    }
    ctx.restore();
  }

  hitTarget(f: TaikoFrame): void {
    const ctx = f.ctx;
    const x = HIT_X;
    const y = BASE_HEIGHT / 2;
    const bar = ((1 - STRONG_SIZE) / 2) * BASE_HEIGHT;
    ctx.fillStyle = "#fff";
    ctx.globalAlpha = 0.1;
    ctx.fillRect(x - 1.25, 0, 2.5, bar);
    ctx.fillRect(x - 1.25, BASE_HEIGHT - bar, 2.5, bar);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.5;
    const ring = (size: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, (size * BASE_HEIGHT) / 2 - 1.25, 0, Math.PI * 2);
      ctx.stroke();
    };
    ring(STRONG_SIZE, 0.1);
    ring(DEFAULT_SIZE, 0.5);
    ctx.globalAlpha = 1;
  }

  barLine(f: TaikoFrame, x: number, major: boolean): void {
    const ctx = f.ctx;
    ctx.fillStyle = "#fff";
    ctx.globalAlpha *= major ? 1 : 0.75;
    ctx.fillRect(x - 1, 0, 2, BASE_HEIGHT);
    if (!major) return;
    // two triangles pointing in, just outside the strip
    const s = 20;
    const h = (s * Math.sqrt(3)) / 2;
    ctx.beginPath();
    ctx.moveTo(x - s / 2, -10 - s);
    ctx.lineTo(x + s / 2, -10 - s);
    ctx.lineTo(x, -10 - s + h);
    ctx.closePath();
    ctx.moveTo(x - s / 2, BASE_HEIGHT + 10 + s);
    ctx.lineTo(x + s / 2, BASE_HEIGHT + 10 + s);
    ctx.lineTo(x, BASE_HEIGHT + 10 + s - h);
    ctx.closePath();
    ctx.fill();
  }

  // ── judged hits ───────────────────────────────────────────────────────

  explosion(f: TaikoFrame, e: HitEvent): void {
    // DefaultHitExplosion: a circle at 15% (additive) growing to 3× in 1 s, gone in 500 ms
    const el = (f.t - e.at) / f.rate;
    if (el < 0 || el >= 500) return;
    const ctx = f.ctx;
    const size = BASE_HEIGHT * DEFAULT_SIZE * (e.strong ? STRONG_SCALE : 1) * tween(el, 1, 3, 1000, ease.outQuint);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.15 * (1 - el / 500);
    pill(ctx, HIT_X, BASE_HEIGHT / 2, size, size);
    ctx.fillStyle = css(e.rim ? C.blueDarker : C.pinkDarker);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  kiaiExplosion(f: TaikoFrame, e: HitEvent): void {
    if (!e.kiai) return;
    // DefaultKiaiHitExplosion: only a glow (radius 60) around a note-wide, full-height pill,
    // stretched to 3× tall in 500 ms, gone in 250 ms
    const el = (f.t - e.at) / f.rate;
    if (el < 0 || el >= 250) return;
    const ctx = f.ctx;
    const w = BASE_HEIGHT * DEFAULT_SIZE;
    const h = BASE_HEIGHT * tween(el, 1, 3, 500, ease.outQuint);
    const off = 10000;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.25 * (1 - el / 250);
    ctx.shadowColor = css(e.rim ? C.blueDarker : C.pinkDarker);
    ctx.shadowBlur = 60 * f.px;
    ctx.shadowOffsetX = -off * f.px;
    pill(ctx, HIT_X + off, BASE_HEIGHT / 2, w, h);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }

  judgement(f: TaikoFrame, e: HitEvent): void {
    // DefaultJudgementPiece (taiko): "GREAT" rising from above the strip, fading over 800 ms
    const el = (f.t - e.at) / f.rate;
    if (el < 0 || el >= 800) return;
    const ctx = f.ctx;
    const y = BASE_HEIGHT / 2 + BASE_HEIGHT * tween(el, -0.6, -1.5, 500);
    const s = tween(el, 0.9, 1, 500, ease.outElastic);
    ctx.save();
    ctx.globalAlpha = 1 - ease.outQuint(el / 800);
    ctx.translate(HIT_X, y);
    ctx.scale(s * 0.85, s);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = css(C.blue);
    ctx.font = `700 20px "Instrument Sans", system-ui, sans-serif`;
    ctx.letterSpacing = "2px";
    ctx.fillText("GREAT", 1, 0);
    ctx.restore();
  }

  // ── objects ───────────────────────────────────────────────────────────

  hit(f: TaikoFrame, h: HitPiece): void {
    const kiai = h.i >= 0 && !!f.chart.kiai[h.i];
    const accent = h.rim ? COLOUR_RIM : COLOUR_CENTRE;
    this.circle(f, h.x, h.y, h.size, h.size, accent, kiai, h.i, h.hitAt, () => {
      const ctx = f.ctx;
      const inner = h.size * SYMBOL_SIZE;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#fff";
      if (h.rim) {
        // a white ring
        ctx.lineWidth = SYMBOL_BORDER;
        ctx.beginPath();
        ctx.arc(h.x, h.y, Math.max(0, inner / 2 - SYMBOL_BORDER / 2), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // a white dot
        ctx.beginPath();
        ctx.arc(h.x, h.y, Math.max(0, inner / 2 - SYMBOL_BORDER), 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  roll(f: TaikoFrame, r: RollPiece): void {
    // ElongatedCirclePiece: from half a height before the head to half one after the tail
    const accent = mix(C.yellowDark, C.yellowDarker, r.engaged);
    const w = r.length + r.height;
    this.circle(f, r.x + r.length / 2, r.y, w, r.height, accent, !!f.chart.kiai[r.i], r.i, NaN, null);
  }

  tick(f: TaikoFrame, k: TickPiece): void {
    // TickPiece: 35% of the tick, a white ring (border 5), the first one filled; a hit tick
    // grows to 1.4× and fades in 200 ms
    const ctx = f.ctx;
    let size = k.size * 0.35;
    let alpha = 1;
    if (!Number.isNaN(k.hitAt)) {
      const e = (f.t - k.hitAt) / f.rate;
      size *= tween(e, 1, 1.4, 200, ease.outQuint);
      alpha = 1 - ease.outQuint(Math.min(1, e / 200));
    }
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    if (k.first) {
      ctx.arc(k.x, k.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const b = Math.min(5, size / 2);
      ctx.lineWidth = b;
      ctx.arc(k.x, k.y, Math.max(0, size / 2 - b / 2), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  swell(f: TaikoFrame, s: SwellPiece): void {
    const ctx = f.ctx;
    const t = f.t;
    const done = t >= s.judgedAt;
    // the body fades out (300 ms, OutQuad) and grows to 1.4× once it's cleared or missed
    const out = done ? (t - s.judgedAt) / f.rate : 0;
    const bodyAlpha = done ? 1 - ease.out(Math.min(1, out / 300)) : 1;
    const bodyScale = done ? tween(out, 1, 1.4, 300) : 1;
    if (bodyAlpha <= 0) return;
    const presses = f.chart.swellPressTimes(s.i);
    const required = Math.max(1, s.required);
    const counted = presses.filter((p) => p <= t).slice(0, required);
    // DampContinuously towards targets that step at every hit
    const damped = (target: (n: number) => number, half: number) => {
      let v = target(0);
      counted.forEach((p, k) => (v += (target(k + 1) - target(k)) * (1 - 2 ** (-(t - p) / f.rate / half))));
      return v;
    };
    const completion = counted.length / required;
    const ringScale = damped((n) => 1 + Math.min(4, 4 * (n / required) * 1.3), 35);
    let ringAlpha = completion / 16;
    counted.forEach((p, k) => (ringAlpha += Math.min(0.6, Math.max(0.1, (k + 1) / required / 16)) * 2 ** (-(t - p) / f.rate / 250)));
    const duration = s.end - s.start;
    const rotation = damped((n) => ((n / required) * duration) / 8, 500);

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.scale(bodyScale, bodyScale);
    ctx.globalAlpha *= bodyAlpha;
    const r = s.size / 2;
    // the expanding ring (additive, light yellow)
    if (t >= s.start && ringAlpha > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= Math.min(1, ringAlpha) * 0.65;
      ctx.fillStyle = css(C.yellowLight);
      ctx.beginPath();
      ctx.arc(0, 0, r * ringScale, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // the target ring grows to 5× from 100 ms after the start
    const targetScale = tween((t - s.start - 100) / f.rate, 1, 5, 400, ease.outQuint);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = css(C.yellowDark, 0.25);
    ctx.lineWidth = 1.4 * targetScale;
    ctx.beginPath();
    ctx.arc(0, 0, r * targetScale - 0.7 * targetScale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1 * targetScale;
    ctx.beginPath();
    ctx.arc(0, 0, r * targetScale - 0.5 * targetScale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // the centre circle, turning with the hits
    const circleAlpha = done ? 1 - ease.out(Math.min(1, out / 300)) : 1;
    if (circleAlpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= circleAlpha;
    this.swellCircle(f, s, rotation);
    ctx.restore();
  }

  /** SwellCirclePiece: an asterisk on yellow */
  protected swellCircle(f: TaikoFrame, s: SwellPiece, rotation: number): void {
    const ctx = f.ctx;
    this.circle(f, s.x, s.y, s.size, s.size, C.yellowDark, !!f.chart.kiai[s.i], s.i, NaN, () => {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((rotation * Math.PI) / 180);
      asterisk(ctx, s.size * SYMBOL_SIZE - SYMBOL_BORDER * 2);
      ctx.restore();
    });
  }

  // ── CirclePiece ───────────────────────────────────────────────────────

  /**
   * The accent shape with its glow (8, or 32 at half strength in kiai, flaring on kiai
   * downbeats), drifting triangles, the white ring (border 8) and its flash (kiai beats while
   * waiting, 0.9 → 0 over 300 ms when hit), then the symbol.
   */
  private circle(f: TaikoFrame, x: number, y: number, w: number, h: number, accent: Colour, kiai: boolean, seed: number, hitAt: number, symbol: (() => void) | null): void {
    const ctx = f.ctx;
    const t = f.t;
    const beat = f.chart.beatAt(t + PRE_BEAT);
    const beatInKiai = !!beat && f.chart.inKiai(beat.time);
    let edge = 1;
    let radius = 8;
    if (kiai) {
      radius = 32;
      edge = EDGE_ALPHA_KIAI;
      if (beat && beatInKiai) {
        // the latest downbeat: up to full in 80 ms, back down over two beats
        const down = beat.time - (((beat.index % beat.meter) + beat.meter) % beat.meter) * beat.length;
        const e = t - (down - PRE_BEAT);
        if (e >= 0 && e < PRE_BEAT + beat.length * 2) {
          edge = e < PRE_BEAT ? tween(e, EDGE_ALPHA_KIAI, 1, PRE_BEAT, ease.outQuint) : tween(e - PRE_BEAT, 1, EDGE_ALPHA_KIAI, beat.length * 2, ease.outQuint);
        }
      }
    }
    withGlow(f, accent, radius, edge, () => {
      pill(ctx, x, y, w, h);
      ctx.fillStyle = css(accent);
      ctx.fill();
    });
    // the triangles: white to 10% darker, drifting up through the shape
    ctx.save();
    pill(ctx, x, y, w, h);
    ctx.clip();
    triangles(ctx, x, y, w, h, t, seed);
    ctx.restore();
    // the ring
    ctx.save();
    pill(ctx, x, y, w - SYMBOL_BORDER, h - SYMBOL_BORDER);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = SYMBOL_BORDER;
    ctx.stroke();
    ctx.restore();
    // the flash
    let flash = 0;
    if (!Number.isNaN(hitAt) && t >= hitAt) flash = 0.9 * (1 - Math.min(1, (t - hitAt) / f.rate / 300));
    else if (beat && beatInKiai) {
      const e = t - (beat.time - PRE_BEAT);
      flash = e < 0 ? 0 : KIAI_FLASH * (1 - ease.outSine(Math.min(1, e / (beat.length * 0.75))));
    }
    if (flash > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= flash;
      pill(ctx, x, y, w, h);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.restore();
    }
    symbol?.();
  }
}

/** osu!framework's Triangles over a CirclePiece: white, faint, drifting upwards. */
function triangles(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number, seed: number): void {
  const rand = seeded(seed * 7919 + 17);
  const n = Math.max(4, Math.round((w * h) / 900));
  const left = x - w / 2;
  const top = y - h / 2;
  for (let i = 0; i < n; i++) {
    const size = h * (0.25 + rand() * 0.45);
    const tx = left + rand() * w;
    const speed = 0.006 + rand() * 0.01;
    const span = h + size;
    const ty = top + h - ((rand() * span + t * speed) % span);
    const shade = 1 - rand() * 0.1;
    ctx.fillStyle = css([shade, shade, shade, 1]);
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.moveTo(tx, ty - (size * Math.sqrt(3)) / 2);
    ctx.lineTo(tx - size / 2, ty);
    ctx.lineTo(tx + size / 2, ty);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** FontAwesome's solid asterisk, roughly: three rounded bars crossing, `size` across. */
export function asterisk(ctx: CanvasRenderingContext2D, size: number): void {
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineWidth = size * 0.2;
  const r = size / 2 - ctx.lineWidth / 2;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 3;
    ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.lineTo(-Math.cos(a) * r, -Math.sin(a) * r);
  }
  ctx.stroke();
}
