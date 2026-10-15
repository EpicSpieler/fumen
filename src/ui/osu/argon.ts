/* argon.ts — lazer's "argon" skin (and argon pro) on the osu! playfield (MIT, ppy Pty Ltd):
 *
 *  - ArgonMainCirclePiece: a dark fill, two gradients and a white ring; hit: the fills drop away,
 *    the bright gradient flashes white and shrinks (elastic), lit by a glow, the whole fading
 *    over 800 ms; slider heads leave out the outer fill;
 *  - ArgonSliderBody: the border in the combo colour, the inside darkened (0.98 opaque, 0.92 pro);
 *    ArgonSliderBall, ArgonFollowCircle, ArgonSliderScorePoint, ArgonReverseArrow;
 *  - ArgonSpinner: a pink glow growing with the spins, 25 ticks turning, arcs top and bottom, the
 *    progress bars at the sides; ArgonFollowPoint's chevrons; ArgonCursor and its trail.
 *
 * Approach circles are lazer's default ones (argon has none of its own).
 */
import { css, darken, ease, opacity, rgb, tween, WHITE, type Colour } from "../mania/draw";
import { OBJECT_RADIUS } from "./chart";
import { arc, box, disc, glow, ICON, icon, ring, sprite, text, vertical } from "./draw";
import { seeded } from "../mania/argon";
import { dimmed, type ApproachPiece, type BallPiece, type BodyStyle, type CirclePiece, type CursorPiece, type FollowPointPiece, type JudgementPiece, type OsuFrame, type OsuRenderer, type RepeatPiece, type SpinnerPiece, type TickPiece, type TrailPart, type TrailStyle } from "./playfield";
import { cursorExpand, defaultApproach, drawTrailParts, followCircle, JUDGEMENT_COLOURS, JUDGEMENT_TEXT, MISS_RED, missMotion, repeatScale, spinnerScales, STORE_SCALE, type DefaultTextures } from "./triangles";

const SIZE = OBJECT_RADIUS * 2;
/** ArgonMainCirclePiece */
const BORDER = SIZE * (2 / 58);
const GRADIENT = BORDER * 2.5;
const OUTER = SIZE - BORDER * 4;
const INNER_GRADIENT = OUTER - GRADIENT * 2;
const INNER_FILL = INNER_GRADIENT - GRADIENT * 2;

/** ArgonSkin's combo colours */
export const ARGON_COMBO: Colour[] = [rgb("#f17400"), rgb("#00f135"), rgb("#0052f1"), rgb("#f10000"), rgb("#e8eb00"), rgb("#5c00f1")];
const PINK = rgb("#fc618f");
const PINK_DARK = rgb("#bb1a41");
const CYAN_GLOW: Colour = [171 / 255, 1, 1, 180 / 255];

export class ArgonOsuRenderer implements OsuRenderer {
  readonly comboColours = ARGON_COMBO;
  readonly trail: TrailStyle;
  private readonly trailSize: number;

  constructor(
    private readonly t: DefaultTextures,
    private readonly pro = false,
  ) {
    // ArgonCursorTrail: Cursor/cursortrail at 0.8, parts closer together, fading sharply
    this.trailSize = 10 * STORE_SCALE * 0.8;
    // (2/5 × 0.4 of a part apart in lazer; a little further here, the parts are many)
    this.trail = { fade: 300, interval: Math.max(1, (this.trailSize / 2.5) * 0.4) };
  }

  body(accent: Colour): BodyStyle {
    const radius = OUTER / 2;
    return {
      radius,
      bands: [
        [0, accent],
        [GRADIENT / radius, opacity(darken(accent, 4), this.pro ? 0.92 : 0.98)],
      ],
    };
  }

  circle(f: OsuFrame, c: CirclePiece): void {
    if (c.part === "tail" || c.part === "repeat") return;
    const ctx = f.ctx;
    const accent = dimmed(c.accent, c.dim);
    const hit = c.hit;
    ctx.translate(c.x, c.y);
    ctx.scale(f.scale, f.scale);
    ctx.globalAlpha *= c.alpha;
    if (hit >= 0) ctx.globalAlpha *= 1 - ease.out(Math.min(1, hit / 800));
    if (ctx.globalAlpha <= 0) return;
    const fills = hit >= 0 ? 1 - ease.outQuint(Math.min(1, hit / 150)) : 1;
    const dark = css(darken(accent, 4));

    if (c.part === "circle" && fills > 0) {
      ctx.save();
      ctx.globalAlpha *= fills;
      disc(ctx, 0, 0, SIZE - 1, dark);
      ctx.restore();
    }
    // the outer gradient: white for 80 ms from the hit, then gone over 150; shrinking (elastic)
    let outerSize = OUTER;
    let outerAlpha = 1;
    let outerWhite = 0;
    if (hit >= 0) {
      const e = hit - 150 / 12;
      outerSize = tween(e, OUTER, OUTER * 0.8, 400, ease.outElasticHalf);
      outerWhite = Math.min(1, Math.max(0, e) / 80);
      outerAlpha = e > 80 ? 1 - ease.outQuint(Math.min(1, (e - 80) / 150)) : 1;
    }
    if (outerAlpha > 0) {
      ctx.save();
      ctx.globalAlpha *= outerAlpha;
      const top = mixWhite(accent, outerWhite);
      const bottom = mixWhite(darken(accent, 0.1), outerWhite);
      disc(ctx, 0, 0, outerSize, vertical(ctx, 0, outerSize, top, bottom));
      ctx.restore();
    }
    if (fills > 0) {
      ctx.save();
      ctx.globalAlpha *= fills;
      disc(ctx, 0, 0, INNER_GRADIENT, vertical(ctx, 0, INNER_GRADIENT, darken(accent, 0.5), darken(accent, 0.6)));
      disc(ctx, 0, 0, INNER_FILL, dark);
      ctx.restore();
    }
    if (c.number > 0) {
      const a = hit >= 0 ? Math.max(0, 1 - hit / 75) : 1;
      if (a > 0) {
        ctx.save();
        ctx.globalAlpha *= a;
        text(ctx, String(c.number), 0, -2, 46, 700, css(dimmed(WHITE, c.dim)));
        ctx.restore();
      }
    }
    if (hit >= 0) {
      // the flash: a glow in the combo colour (hit lighting)
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      glow(ctx, 0, 0, OBJECT_RADIUS, OBJECT_RADIUS * 1.2, accent, ease.outQuint(Math.min(1, hit / 150)));
      ctx.restore();
    }
    // the ring: white, then the combo colour fading down it; shrinking with the gradient
    let ringSize = SIZE;
    let stroke: string | CanvasGradient = css(dimmed(WHITE, c.dim));
    if (hit >= 0) {
      ringSize = tween(hit, SIZE, SIZE * 0.8 + BORDER, 400, ease.outElasticHalf);
      const k = Math.min(1, hit / 800);
      const g = ctx.createLinearGradient(0, -ringSize / 2, 0, ringSize / 2);
      g.addColorStop(0, css(mixColour(WHITE, accent, k), 1 - 0.5 * k));
      g.addColorStop(1, css(mixColour(WHITE, accent, k), 1 - k));
      stroke = g;
    }
    ring(ctx, 0, 0, ringSize, BORDER, stroke);
  }

  approach(f: OsuFrame, a: ApproachPiece): void {
    defaultApproach(f, a, this.t.approach);
  }

  tick(f: OsuFrame, k: TickPiece): void {
    // ArgonSliderScorePoint: a 12-unit ring in the combo colour
    const ctx = f.ctx;
    ctx.globalAlpha *= k.alpha;
    const s = f.scale * k.scale;
    ring(ctx, k.x, k.y, 12 * s, 3 * s, css(k.miss ? MISS_RED : k.accent));
  }

  repeat(f: OsuFrame, r: RepeatPiece): void {
    // ArgonReverseArrow: a white pill with arrows in the dark colour, the edge piece beside it
    const ctx = f.ctx;
    ctx.globalAlpha *= r.alpha;
    ctx.translate(r.x, r.y);
    ctx.rotate(r.angle);
    ctx.scale(f.scale, f.scale);
    let mainScale = 1;
    let sideX = 0;
    if (r.hit >= 0) {
      const s = tween(r.hit, 1, 1.5, Math.min(300, r.spanDuration), ease.out);
      ctx.scale(s, s);
    } else {
      mainScale = repeatScale(r);
      const loop = ((r.loop % 300) + 300) % 300;
      sideX = loop < 35 ? tween(loop, 0, -12, 35, ease.out) : tween(loop - 35, -12, 0, 250, ease.out);
    }
    ctx.save();
    ctx.translate(sideX, 0);
    sprite(ctx, this.t.repeatEdge, 0, 0, { max: [OUTER, OUTER], scale: 1 });
    ctx.restore();
    ctx.scale(mainScale, mainScale);
    box(ctx, 40, 20, 10);
    ctx.fillStyle = css(dimmed(WHITE, r.dim));
    ctx.fill();
    icon(ctx, ICON.angleDoubleRight, 16, css(darken(r.accent, 4)));
  }

  ball(f: OsuFrame, b: BallPiece): void {
    const ctx = f.ctx;
    ctx.globalAlpha *= b.alpha;
    ctx.translate(b.x, b.y);
    ctx.scale(f.scale, f.scale);
    // ArgonFollowCircle: a ring in the combo colour, faintly filled, additive
    const [fs, fa] = followCircle(b);
    if (fa > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= fa;
      const d = SIZE * fs;
      ctx.save();
      ctx.globalAlpha *= 0.3;
      disc(ctx, 0, 0, d, vertical(ctx, 0, d, b.accent, darken(b.accent, 0.5)));
      ctx.restore();
      ring(ctx, 0, 0, d, 4, vertical(ctx, 0, d, b.accent, darken(b.accent, 0.5)));
      ctx.restore();
    }
    // ArgonSliderBall: in over 200 ms from the start, out in 50 at the end
    if (b.sinceStart < 0) return;
    let alpha = ease.outQuint(Math.min(1, b.sinceStart / 200));
    let iconScale = tween(b.sinceStart, 0, 1, 200, ease.outElasticHalf);
    if (b.sinceEnd >= 0) {
      alpha *= 1 - ease.outQuint(Math.min(1, b.sinceEnd / 50));
      iconScale = tween(b.sinceEnd, 1, 0.9, 200, ease.outQuint);
    }
    if (alpha <= 0) return;
    ctx.globalAlpha *= alpha;
    // the fill keeps its gradient upright; the ring and the arrow turn with the ball
    disc(ctx, 0, 0, OUTER, vertical(ctx, 0, OUTER, b.accent, darken(b.accent, 0.5)));
    ring(ctx, 0, 0, OUTER, GRADIENT, "#fff");
    ctx.rotate(b.angle);
    icon(ctx, ICON.angleRight, 48, "#fff", 0.6 * iconScale, 0.8 * iconScale);
  }

  spinner(f: OsuFrame, s: SpinnerPiece): void {
    const ctx = f.ctx;
    const t = f.t;
    ctx.globalAlpha *= s.alpha;
    ctx.translate(s.x, s.y);
    const area = 384;
    const [discScale0, centreScale] = spinnerScales(s, t, 0.8);
    let discScale = discScale0;
    let turn = t > s.start - s.preempt / 2 ? tween(t - (s.start - s.preempt / 2), 0, (25 * (s.end - s.start)) / 2000, s.preempt + (s.end - s.start)) : 0;
    if (t > s.end) {
      discScale = tween(t - s.end, 1, 1.2, 320, ease.out);
      turn += tween(t - s.end, 0, 180, 320);
    }
    const complete = t >= s.completed;
    const tracking = s.tracking;

    if (discScale > 0) {
      ctx.save();
      ctx.scale(discScale, discScale);
      const inner = area - 16;
      // the fill: a pink glow, growing with the spins
      const fillScale = 0.1 + 0.88 * s.progress;
      glow(ctx, 0, 0, inner * fillScale, 40, PINK, tracking ? 0.4 : 0.2);
      // ticks: 25 hollow bars, turning with the spins
      ctx.save();
      ctx.rotate(((turn + s.rotation) * Math.PI) / 180);
      ctx.shadowColor = "rgba(255,255,255,0.2)";
      ctx.shadowBlur = 30 * f.px * discScale;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      for (let i = 0; i < 25; i++) {
        const a = (i / 25) * Math.PI * 2;
        ctx.save();
        ctx.translate((Math.sin(a) / 2) * 0.75 * inner, (Math.cos(a) / 2) * 0.75 * inner);
        ctx.rotate(((-i / 25) * 360 - 120) * (Math.PI / 180));
        box(ctx, 29, 4, 2.5);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      // the ring's arcs, top and bottom, longer and thicker once it's done
      const ringFill = complete ? 0.5 : 0.31;
      const ringInner = complete ? 0.044 : 0.02;
      ctx.save();
      arc(ctx, inner / 2, ringFill, -ringFill * 180, ringInner, "#fff");
      ctx.scale(1, -1);
      arc(ctx, inner / 2, ringFill, -ringFill * 180, ringInner, "#fff");
      ctx.restore();
      // the progress bars at the sides
      for (const side of [1, -1]) {
        ctx.save();
        ctx.scale(side, 1);
        if (s.progress < 1) arc(ctx, area / 2, 0.15, 90 - 0.15 * 180, 0.12, "rgba(255,255,255,0.25)");
        const p = s.progress < 1 ? 0.15 * s.progress : 0;
        if (p > 0 && s.progress > 0) {
          ctx.save();
          ctx.shadowColor = css(CYAN_GLOW);
          ctx.shadowBlur = 25 * f.px * discScale;
          arc(ctx, area / 2, p, 90 - p * 180, 0.12, "#fff");
          ctx.restore();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    // the centre: two rings, smaller while it's spun
    if (centreScale > 0) {
      const size = tracking ? 40 : 80;
      ctx.save();
      ctx.scale(centreScale, centreScale);
      ring(ctx, 0, 0, size * 0.8, 10, "#fff");
      ring(ctx, 0, 0, size, 3, "#fff");
      ctx.restore();
    }

    if (t >= s.start) {
      ctx.globalAlpha *= Math.min(1, (t - s.start) / s.fadeIn);
      text(ctx, String(Math.trunc(Math.max(0, s.spm))), 0, 74, 28, 600, "#fff");
      text(ctx, "SPINS PER MINUTE", 0, 100, 16, 600, "#fff");
    }
  }

  judgement(f: OsuFrame, j: JudgementPiece): void {
    // ArgonJudgementPiece: the result's name, in over 300 ms and growing to 1.2×, fading over
    // 800 ms, rings flying out of hits; a miss falls, turning. Argon pro shows none for Great.
    if (this.pro && j.result === 0) return;
    const el = j.since;
    if (el < 0 || el >= 1000) return;
    const ctx = f.ctx;
    const colour = JUDGEMENT_COLOURS[j.result];
    const fade = 1 - Math.min(1, el / 800);
    ctx.translate(j.x, j.y);
    ctx.scale(f.scale, f.scale);
    ctx.globalCompositeOperation = "lighter";
    const text = () => {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = css(colour);
      ctx.font = `400 20px "Instrument Sans", system-ui, sans-serif`;
      ctx.letterSpacing = "10px";
      ctx.fillText(JUDGEMENT_TEXT[j.result], 5, 0);
    };
    if (j.result === 3) {
      if (fade <= 0) return;
      ctx.globalAlpha *= fade;
      missMotion(ctx, el);
      text();
      return;
    }
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha *= fade * ease.outQuint(Math.min(1, el / 300));
      const s = tween(el, 1, 1.2, 1800, ease.outQuint);
      ctx.scale(s, s);
      text();
      ctx.restore();
    }
    // the rings: 4 small and 4 large for Great, fewer and not as far for Ok and Meh
    const ringFade = (1 - ease.outQuint(Math.min(1, el / 1000))) * Math.max(fade, 0);
    if (ringFade <= 0) return;
    const rand = seeded(j.seed);
    const travel = 58 * (j.result === 0 ? 1 : j.result === 1 ? 0.6 : 0.3);
    const count = j.result === 0 ? 8 : j.result === 1 ? 4 : 3;
    ctx.globalAlpha *= ringFade;
    ctx.strokeStyle = css(colour);
    ctx.lineWidth = 4;
    for (let k = 0; k < count; k++) {
      const size = k < 4 ? 9 : 14;
      const dir = rand() * Math.PI * 2;
      const dist = travel / 2 + (rand() * travel) / 2;
      const r = tween(el, dist * 0.6, dist, 600, ease.outQuint);
      ctx.beginPath();
      ctx.arc(Math.cos(dir) * r, Math.sin(dir) * r, size / 2 - 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  followPoint(f: OsuFrame, p: FollowPointPiece): void {
    // ArgonFollowPoint: two small chevrons, the second bright, additive
    const ctx = f.ctx;
    ctx.globalAlpha *= p.alpha;
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.scale(p.scale, p.scale);
    const g = vertical(ctx, 0, 8, PINK, PINK_DARK);
    ctx.save();
    ctx.translate(-2, 0);
    ctx.globalAlpha *= 0.2;
    icon(ctx, ICON.chevronRight, 8, g);
    ctx.restore();
    ctx.translate(2, 0);
    icon(ctx, ICON.chevronRight, 8, g);
  }

  drawTrail(f: OsuFrame, parts: TrailPart[]): void {
    f.ctx.globalAlpha *= 0.8;
    drawTrailParts(f, parts, this.t.trail, this.trailSize, 4, true);
  }

  cursor(f: OsuFrame, c: CursorPiece): void {
    // ArgonCursor: a pink ring, a faint white one inside, a glowing white dot
    const ctx = f.ctx;
    const size = 28;
    ctx.translate(c.x, c.y);
    const s = cursorExpand(c);
    ctx.save();
    ctx.scale(s, s);
    ctx.save();
    ctx.globalAlpha *= 0.4;
    disc(ctx, 0, 0, size, css(darken(PINK, 0.6)));
    ctx.restore();
    ring(ctx, 0, 0, size, 6, vertical(ctx, 0, size, PINK, PINK_DARK));
    ring(ctx, 0, 0, size, 2, "rgba(255,255,255,0.8)");
    ctx.restore();
    glow(ctx, 0, 0, size * 0.2, 20, [171 / 255, 1, 1, 1], 100 / 255);
    disc(ctx, 0, 0, size * 0.2, "#fff");
  }
}

function mixWhite(c: Colour, k: number): Colour {
  return mixColour(c, WHITE, k);
}

function mixColour(a: Colour, b: Colour, k: number): Colour {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
}
