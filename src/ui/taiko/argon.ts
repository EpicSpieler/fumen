/* argon.ts — lazer's "argon" (and "argon pro") skin on the osu!taiko playfield (MIT, ppy Pty
 * Ltd): TaikoArgonSkinTransformer's pieces —
 *
 *  - ArgonPlayfieldBackgroundLeft / Right, ArgonInputDrum (grey halves lit with a gradient and a
 *    glow), ArgonHitTarget, ArgonBarLine;
 *  - ArgonCirclePiece (centre / rim / elongated / swell): a dark disc inside two gradient rings,
 *    a chevron (an asterisk on swells), a flash when hit and on kiai beats;
 *  - ArgonHitExplosion (dimmer and shorter for Ok, none for a miss), ArgonTickPiece,
 *    ArgonJudgementPiece (the result with rings, a miss dropping; argon pro shows none for great
 *    hits). No kiai explosions. The swell is the default one around argon's disc.
 */
import { seeded } from "../mania/argon";
import { glowCircle } from "../glow";
import { css, ease, rgb, tween, type Colour } from "../mania/draw";
import { BASE_HEIGHT, DEFAULT_SIZE, GREAT, HIT_X, INPUT_DRUM_WIDTH, LEFT_CENTRE, LEFT_RIM, MISSED, RIGHT_CENTRE, RIGHT_RIM, STRONG_SCALE } from "./chart";
import type { HitEvent, HitPiece, RollPiece, SwellPiece, TaikoFrame, TickPiece } from "./playfield";
import { asterisk, drumPress, missMotion, pill, RESULT_COLOURS, RESULT_TEXT, secondHit, TrianglesRenderer } from "./triangles";

/** ArgonCirclePiece.ICON_SIZE */
const ICON_SIZE = 20 / 70;
const PRE_BEAT = 80;
const STRONG_SIZE = DEFAULT_SIZE * STRONG_SCALE;

type Gradient = [Colour, Colour];
const CENTRE: Gradient = [rgb("#f10000"), rgb("#a70000")];
const RIM: Gradient = [rgb("#00a1f1"), rgb("#006fa7")];
const ROLL: Gradient = [rgb("#f1a100"), rgb("#a76f00")];
const SWELL: Gradient = [rgb("#f0c900"), rgb("#a78b00")];
/** ArgonInputDrum */
const RIM_HIT: Gradient = [rgb("#e3f8ff"), rgb("#c6f5ff")];
const RIM_HIT_GLOW = rgb("#7ed7fd");
const CENTRE_HIT: Gradient = [rgb("#ffe3ec"), rgb("#ffc6d3")];
const CENTRE_HIT_GLOW = rgb("#ff93c7");
const RIM_SIZE = 0.3;

const gray = (v: number): string => `rgb(${v},${v},${v})`;

export class ArgonTaikoRenderer extends TrianglesRenderer {
  constructor(private readonly pro = false) {
    super(null);
  }

  // ── the playfield ─────────────────────────────────────────────────────

  override backgroundRight(f: TaikoFrame): void {
    f.ctx.fillStyle = "rgba(0,0,0,.7)";
    f.ctx.fillRect(0, 0, f.width, BASE_HEIGHT);
  }

  override backgroundLeft(f: TaikoFrame): void {
    f.ctx.fillStyle = "#000";
    f.ctx.fillRect(0, 0, INPUT_DRUM_WIDTH, BASE_HEIGHT);
  }

  override drum(f: TaikoFrame): void {
    const ctx = f.ctx;
    // a square the drum area's width at its top, at 0.9 around its centre; each half shows half
    // of a grey disc, its rim and centre lit on presses (+0.5 in 40 ms, out over 750 ms)
    const S = INPUT_DRUM_WIDTH;
    const c = S / 2;
    ctx.save();
    ctx.translate(c, c);
    ctx.scale(0.9, 0.9);
    ctx.translate(-c, -c);
    for (const right of [false, true]) {
      ctx.save();
      ctx.beginPath();
      // the halves' masks reach well past the drum (for the glow)
      if (right) ctx.rect(c, c - S, S * 2, S * 2);
      else ctx.rect(c - S * 2, c - S, S * 2, S * 2);
      ctx.clip();
      const [, rim] = drumPress(f.chart, right ? RIGHT_RIM : LEFT_RIM, f.t, 750 * f.rate, 0);
      const [, centre] = drumPress(f.chart, right ? RIGHT_CENTRE : LEFT_CENTRE, f.t, 750 * f.rate, 0);
      const disc = (size: number, fill: string | CanvasGradient, glow: Colour | null, glowAlpha: number, alpha: number) => {
        if (alpha <= 0) return;
        ctx.save();
        ctx.globalAlpha *= alpha;
        if (glow) glowCircle(ctx, c, c, size, 50, glow, glowAlpha);
        ctx.beginPath();
        ctx.arc(c, c, size / 2, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.restore();
      };
      const across = (g: Gradient, size: number) => {
        const grad = ctx.createLinearGradient(c - size / 2, 0, c + size / 2, 0);
        grad.addColorStop(0, css(g[0]));
        grad.addColorStop(1, css(g[1]));
        return grad;
      };
      disc(S, gray(51), null, 0, 1);
      disc(S, across(RIM_HIT, S), RIM_HIT_GLOW, 0.66, rim);
      disc(S * (1 - RIM_SIZE), gray(64), null, 0, 1);
      disc(S * (1 - RIM_SIZE), across(CENTRE_HIT, S * (1 - RIM_SIZE)), CENTRE_HIT_GLOW, 1, centre);
      ctx.restore();
    }
    // the split down the middle
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, S / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = gray(38);
    ctx.fillRect(c - 3, 0, 6, S);
    ctx.fillStyle = gray(48);
    ctx.fillRect(c - 3, (S * RIM_SIZE) / 2, 6, S * (1 - RIM_SIZE));
    ctx.restore();
    ctx.restore();
  }

  override hitTarget(f: TaikoFrame): void {
    const ctx = f.ctx;
    const x = HIT_X;
    const y = BASE_HEIGHT / 2;
    ctx.save();
    // masked to its own box: the bars start 4 units outside it
    ctx.beginPath();
    ctx.rect(x - BASE_HEIGHT / 2, 0, BASE_HEIGHT, BASE_HEIGHT);
    ctx.clip();
    const bar = (1 - STRONG_SIZE) * BASE_HEIGHT;
    ctx.fillStyle = "#fff";
    pill(ctx, x, -4 + bar / 2, 4, bar);
    ctx.fill();
    pill(ctx, x, BASE_HEIGHT + 4 - bar / 2, 4, bar);
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.1;
    for (const size of [DEFAULT_SIZE, DEFAULT_SIZE * 0.85]) {
      ctx.beginPath();
      ctx.arc(x, y, (size * BASE_HEIGHT) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  override barLine(f: TaikoFrame, x: number, major: boolean): void {
    const ctx = f.ctx;
    const alpha = major ? 1 : 0.5;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - 1, 0, 2, BASE_HEIGHT);
    ctx.restore();
    if (!major) return;
    // short fades out of the strip's edges (additive, at 30%)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha *= alpha * 0.3;
    for (const [from, to] of [[-10, 0], [BASE_HEIGHT + 10, BASE_HEIGHT]]) {
      const g = ctx.createLinearGradient(0, from, 0, to);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, "#fff");
      ctx.fillStyle = g;
      ctx.fillRect(x - 1, Math.min(from, to), 2, 10);
    }
    ctx.restore();
  }

  // ── judged hits ───────────────────────────────────────────────────────

  override explosion(f: TaikoFrame, e: HitEvent): void {
    // ArgonHitExplosion: in over 30 ms, out over 450 (OutQuint) — for Ok only to 0.2 and out over
    // 200, for a miss nothing; a gradient disc, a white one inside it with a glow; a strong
    // note's second key grows the outer disc in 500 ms
    if (e.result === MISSED) return;
    const el = (f.t - e.at) / f.rate;
    const great = e.result === GREAT;
    const out = great ? 450 : 200;
    if (el < 0 || el >= 30 + out) return;
    const peak = great ? 1 : 0.2;
    const alpha = el < 30 ? peak * ease.in(el / 30) : peak * (1 - ease.outQuint((el - 30) / out));
    if (alpha <= 0) return;
    const ctx = f.ctx;
    const base = BASE_HEIGHT * DEFAULT_SIZE;
    const outer = base * (1 + (STRONG_SCALE - 1) * secondHit(f, e, 500, ease.outQuint));
    const x = HIT_X;
    const y = BASE_HEIGHT / 2;
    ctx.save();
    ctx.globalAlpha *= alpha;
    const g = e.rim ? RIM_HIT : CENTRE_HIT;
    const grad = ctx.createLinearGradient(x - outer / 2, 0, x + outer / 2, 0);
    grad.addColorStop(0, css(g[0]));
    grad.addColorStop(1, css(g[1]));
    ctx.beginPath();
    ctx.arc(x, y, outer / 2, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    glowCircle(ctx, x, y, base * 0.85, 45, e.rim ? RIM_HIT_GLOW : CENTRE_HIT_GLOW, 0.5);
    ctx.beginPath();
    ctx.arc(x, y, (base * 0.85) / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.restore();
  }

  override kiaiExplosion(): void {}

  override judgement(f: TaikoFrame, e: HitEvent): void {
    // argon pro shows nothing for great hits
    if (this.pro && e.result === GREAT) return;
    const el = (f.t - e.at) / f.rate;
    if (el < 0 || el >= 1000) return;
    const ctx = f.ctx;
    const colour = RESULT_COLOURS[e.result];
    const fade = 1 - ease.outQuint(Math.min(1, el / 800));
    const text = () => {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = css(colour);
      ctx.font = `400 20px "Instrument Sans", system-ui, sans-serif`;
      ctx.letterSpacing = "10px";
      ctx.fillText(RESULT_TEXT[e.result], 5, 0);
    };
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (e.result === MISSED) {
      // dropping from the hit target, turning
      if (fade > 0) {
        ctx.globalAlpha = fade;
        missMotion(ctx, el, text);
      }
      ctx.restore();
      return;
    }
    // the text: from 0.6 to 1.0 of the strip's height above its centre, growing to 1.4×
    if (fade > 0) {
      const y = BASE_HEIGHT / 2 + BASE_HEIGHT * tween(el, -0.6, -1, 800, ease.outQuint);
      const s = tween(el, 1, 1.4, 800, ease.outQuint);
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(HIT_X, y);
      ctx.scale(s, s);
      text();
      ctx.restore();
    }
    // the rings, flying out of the hit target: 4 small and 4 large for Great, 4 small not as far
    // for Ok
    const ringFade = fade * (1 - ease.outQuint(Math.min(1, el / 1000)));
    if (ringFade > 0) {
      const rand = seeded(e.at + e.i);
      const travel = e.result === GREAT ? 58 : 58 * 0.6;
      ctx.globalAlpha = ringFade;
      ctx.strokeStyle = css(colour);
      ctx.lineWidth = 4;
      for (let k = 0; k < (e.result === GREAT ? 8 : 4); k++) {
        const size = k < 4 ? 9 : 14;
        const dir = rand() * 360;
        const dist = travel / 2 + (rand() * travel) / 2;
        const r = tween(el, dist * 0.6, dist, 600, ease.outQuint);
        ctx.beginPath();
        ctx.arc(HIT_X + Math.cos(dir) * r, BASE_HEIGHT / 2 + Math.sin(dir) * r, size / 2 - 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ── objects ───────────────────────────────────────────────────────────

  override hit(f: TaikoFrame, h: HitPiece): void {
    this.disc(f, h.x, h.y, h.size, h.size, h.rim ? RIM : CENTRE, h.hitAt, () => chevron(f.ctx, h.x, h.y, h.size * ICON_SIZE));
  }

  override roll(f: TaikoFrame, r: RollPiece): void {
    this.disc(f, r.x + r.length / 2, r.y, r.length + r.height, r.height, ROLL, NaN, null);
  }

  override tick(f: TaikoFrame, k: TickPiece): void {
    // ArgonTickPiece: the icon's share of a note; the first a dot, the rest chevrons; a hit tick
    // grows to 1.4× and fades in 200 ms
    const ctx = f.ctx;
    let size = k.size * (ICON_SIZE / DEFAULT_SIZE);
    let alpha = 1;
    if (!Number.isNaN(k.hitAt)) {
      const e = (f.t - k.hitAt) / f.rate;
      size *= tween(e, 1, 1.4, 200, ease.outQuint);
      alpha = 1 - ease.outQuint(Math.min(1, e / 200));
    }
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    if (k.first) {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(k.x, k.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else chevron(ctx, k.x, k.y, size);
    ctx.restore();
  }

  protected override swellCircle(f: TaikoFrame, s: SwellPiece, rotation: number): void {
    const ctx = f.ctx;
    this.disc(f, s.x, s.y, s.size, s.size, SWELL, NaN, () => {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.scale(0.8, 1);
      asterisk(ctx, s.size * ICON_SIZE);
      ctx.restore();
    });
  }

  /**
   * ArgonCirclePiece: a black disc at 75%, a ring 20/70 of the height wide in the accent at half
   * strength, a thin one (5/70) in full, the icon; flashed white when hit (0.9 → 0 over 500 ms)
   * and on kiai beats while waiting.
   */
  private disc(f: TaikoFrame, x: number, y: number, w: number, h: number, accent: Gradient, hitAt: number, icon: (() => void) | null): void {
    const ctx = f.ctx;
    const t = f.t;
    pill(ctx, x, y, w, h);
    ctx.fillStyle = "rgba(0,0,0,.745)";
    ctx.fill();
    const grad = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    grad.addColorStop(0, css(accent[0]));
    grad.addColorStop(1, css(accent[1]));
    ctx.strokeStyle = grad;
    for (const [b, a] of [[(20 / 70) * h, 0.5], [(5 / 70) * h, 1]]) {
      ctx.save();
      ctx.globalAlpha *= a;
      ctx.lineWidth = b;
      pill(ctx, x, y, w - b, h - b);
      ctx.stroke();
      ctx.restore();
    }
    icon?.();
    let flash = 0;
    if (!Number.isNaN(hitAt) && t >= hitAt) flash = 0.9 * (1 - ease.outQuint(Math.min(1, (t - hitAt) / f.rate / 500)));
    else {
      const beat = f.chart.beatAt(t + PRE_BEAT);
      if (beat && f.chart.inKiai(beat.time)) {
        const e = t - (beat.time - PRE_BEAT);
        flash = e < 0 ? 0 : 0.15 * (1 - ease.outSine(Math.min(1, e / (beat.length * 0.75))));
      }
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
  }
}

/** FontAwesome's angle-left in a `size` box, squeezed to 0.8 wide: a rounded chevron. */
function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const w = size * 0.8;
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.18;
  const hw = w * 0.22;
  const hh = size * 0.36;
  ctx.beginPath();
  ctx.moveTo(x + hw, y - hh);
  ctx.lineTo(x - hw, y);
  ctx.lineTo(x + hw, y + hh);
  ctx.stroke();
  ctx.restore();
}
