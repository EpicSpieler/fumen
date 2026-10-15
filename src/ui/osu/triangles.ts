/* triangles.ts — lazer's "triangles" skin on the osu! playfield: the default pieces (MIT, ppy Pty
 * Ltd):
 *
 *  - MainCirclePiece: a glow, the disc in the combo colour with triangles drifting over it, the
 *    number, a white ring; hit: a flash and the circle blown up 1.5×, fading over 800 ms;
 *  - DefaultApproachCircle; the slider body white-edged, the colour fading towards the middle
 *    (DrawableSliderPath); DefaultSliderBall, DefaultFollowCircle, DefaultReverseArrow, the tick's
 *    small ring; DefaultSpinner (DefaultSpinnerDisc and its layers); the follow points' soft dots;
 *  - OsuCursor's default cursor and its trail.
 *
 * These are lazer's own textures (osu.Game.Resources, extracted with the triangles skin).
 */
import { css, darken, ease, multiply, rgb, tween, WHITE, type Colour } from "../mania/draw";
import { preload, type TexRef } from "../../lib/skin/skins";
import { asterisk, triangles } from "../taiko/triangles";
import { box, disc, glow, ICON, icon, ring, sprite, text } from "./draw";
import { OBJECT_RADIUS } from "./chart";
import { dimmed, FOLLOW_AREA, type ApproachPiece, type BallPiece, type BodyStyle, type CirclePiece, type CursorPiece, type FollowPointPiece, type JudgementPiece, type OsuFrame, type OsuRenderer, type RepeatPiece, type SpinnerPiece, type TickPiece, type TrailPart, type TrailStyle } from "./playfield";

const SIZE = OBJECT_RADIUS * 2;

/** SkinConfiguration.DefaultComboColours */
export const DEFAULT_COMBO: Colour[] = [rgb("#ffc000"), rgb("#00ca00"), rgb("#127cff"), rgb("#f21839")];
/** OsuColour.BlueDark / YellowLight (DefaultSpinnerDisc) */
const SPINNER_NORMAL = rgb("#44aadd");
const SPINNER_COMPLETE = rgb("#ffdd55");
/** DrawableSliderPath */
export const BORDER_PORTION = 0.128;
const GRADIENT_PORTION = 1 - BORDER_PORTION;

/** lazer's default textures (osu.Game.Resources: Gameplay/osu, Cursor) */
export interface DefaultTextures {
  approach: TexRef | null;
  disc: TexRef | null;
  ringGlow: TexRef | null;
  trail: TexRef | null;
  repeatEdge: TexRef | null;
}

export async function loadDefaults(find: (name: string) => TexRef | null): Promise<DefaultTextures> {
  const t: DefaultTextures = {
    approach: find("approachcircle"),
    disc: find("disc"),
    ringGlow: find("ring-glow"),
    trail: find("cursortrail"),
    repeatEdge: find("repeat-edge-piece"),
  };
  await preload(Object.values(t));
  return t;
}

/** lazer's TextureStore shows its textures at half their pixels */
export const STORE_SCALE = 0.5;

/** DefaultApproachCircle: the texture tinted, 128 / 118 of its size. */
export function defaultApproach(f: OsuFrame, a: ApproachPiece, tex: TexRef | null): void {
  const ctx = f.ctx;
  ctx.globalAlpha *= a.alpha;
  const s = f.scale * a.scale * (128 / 118);
  if (!sprite(ctx, tex, a.x, a.y, { scale: s * STORE_SCALE, tint: a.accent })) {
    ring(ctx, a.x, a.y, SIZE * s, 4 * s, css(a.accent));
  }
}

/** The follow circle (DefaultFollowCircle, ArgonFollowCircle): grown over 300 ms once followed,
 * pulsing on ticks, back to 1× and gone over 150 ms when let go, blown away when a tick is missed,
 * shrinking away at the end. [scale, alpha] */
export function followCircle(b: BallPiece): [number, number] {
  if (!(b.followOn >= 0)) return [1, 0];
  let scale = tween(b.followOn, 1, FOLLOW_AREA, 300, ease.outQuint);
  let alpha = tween(b.followOn, 0, 1, 300, ease.outQuint);
  if (b.followOff >= 0) {
    const held = b.followOn - b.followOff;
    scale = tween(b.followOff, tween(held, 1, FOLLOW_AREA, 300, ease.outQuint), 1, 150, ease.outQuint);
    alpha = tween(held, 0, 1, 300, ease.outQuint) * (1 - ease.outQuint(Math.min(1, b.followOff / 150)));
  } else if (b.sinceTick >= 0 && b.sinceTick <= b.followOn && b.sinceEnd < 0 && scale >= FOLLOW_AREA * 0.98) {
    scale = b.sinceTick < 40 ? tween(b.sinceTick, FOLLOW_AREA, FOLLOW_AREA * 1.08, 40, ease.outQuint) : tween(b.sinceTick - 40, FOLLOW_AREA * 1.08, FOLLOW_AREA, 200, ease.outQuint);
  }
  if (b.broken >= 0) {
    scale = tween(b.broken, scale, 4, 100);
    alpha *= 1 - Math.min(1, b.broken / 100);
  }
  if (b.sinceEnd >= 0) {
    scale = tween(b.sinceEnd, scale, 1, 300, ease.outQuint);
    alpha *= 1 - ease.outQuint(Math.min(1, b.sinceEnd / 150));
  }
  return [scale, alpha];
}

/** OsuColour.ForHitResult: Great, Ok, Meh, Miss */
export const JUDGEMENT_COLOURS: Colour[] = [rgb("#66ccff"), rgb("#88b300"), rgb("#ffcc22"), rgb("#ed1121")];
export const JUDGEMENT_TEXT = ["GREAT", "OK", "MEH", "MISS"];
/** what a missed tick turns (DrawableSliderTick: Color4.Red) */
export const MISS_RED: Colour = [1, 0, 0, 1];

/** DefaultJudgementPiece's miss (argon's too): from 1.6× to 1 in 100 ms, falling 100 and turning
 * 40° over 800 ms (InQuint). */
export function missMotion(ctx: CanvasRenderingContext2D, el: number): void {
  const s = tween(el, 1.6, 1, 100, ease.in);
  ctx.translate(0, tween(el, 0, 100, 800, ease.inQuint));
  ctx.rotate((tween(el, 0, 40, 800, ease.inQuint) * Math.PI) / 180);
  ctx.scale(s, s);
}

/** SkinnableCursor.Expand / Contract: 1.2× on a press (elastic), back over 400 ms. */
export function cursorExpand(c: CursorPiece): number {
  if (c.pressed >= 0) return tween(c.pressed, 1, 1.2, 400, ease.outElasticHalf);
  if (c.released >= 0) return tween(c.released, 1.2, 1, 400, ease.out);
  return 1;
}

/** The repeat arrow's beat: out to 1.3× in 35 ms, back over 250, every 300 ms; 1.5× once hit. */
export function repeatScale(r: RepeatPiece, hitScale = 1.5): number {
  if (r.hit >= 0) return tween(r.hit, 1, hitScale, Math.min(300, r.spanDuration), ease.out);
  const loop = ((r.loop % 300) + 300) % 300;
  return loop < 35 ? tween(loop, 1, 1.3, 35, ease.out) : tween(loop - 35, 1.3, 1, 250, ease.out);
}

/** Spinner discs (default and argon): scaled in over the preempt, [disc, centre]. */
export function spinnerScales(s: SpinnerPiece, t: number, centreTo: number): [number, number] {
  const p = s.preempt;
  const half = s.start - p / 2;
  if (t < half) return [0, 0];
  if (t < s.start) return [tween(t - half, 0, 0.2, p / 4, ease.outQuint), tween(t - half, 0, 0.3, p / 4, ease.outQuint)];
  return [tween(t - s.start, 0.2, 1, p / 2, ease.outQuint), tween(t - s.start, 0.3, centreTo, p / 2, ease.outQuint)];
}

/** Trail parts as CursorTrail draws them: the texture at each, faded by `exponent`. */
export function drawTrailParts(f: OsuFrame, parts: TrailPart[], tex: TexRef | null, size: number, exponent: number, additive: boolean, tint?: Colour): void {
  const ctx = f.ctx;
  if (additive) ctx.globalCompositeOperation = "lighter";
  const base = ctx.globalAlpha;
  for (const p of parts) {
    const a = p.life ** exponent;
    if (a <= 0.003) continue;
    ctx.globalAlpha = base * a;
    if (!sprite(ctx, tex, p.x, p.y, { scale: 1, tint, max: [size, size] })) disc(ctx, p.x, p.y, size, "#fff");
  }
}

export class TrianglesOsuRenderer implements OsuRenderer {
  readonly comboColours = DEFAULT_COMBO;
  readonly trail: TrailStyle;
  private readonly trailSize: number;

  constructor(private readonly t: DefaultTextures) {
    // DefaultCursorTrail: Cursor/cursortrail at its size; parts every 2/5 of it
    const w = t.trail ? 10 * STORE_SCALE : 5;
    this.trailSize = w;
    this.trail = { fade: 300, interval: w / 2.5 };
  }

  body(accent: Colour): BodyStyle {
    // DefaultDrawableSliderPath: a white border, then the colour from 0.8 to 0.3 opacity
    const bands: [number, Colour][] = [[0, WHITE]];
    const steps = 10;
    for (let k = 0; k < steps; k++) {
      const p = BORDER_PORTION + (GRADIENT_PORTION * k) / steps;
      const a = 0.8 - (0.5 * (p - BORDER_PORTION)) / GRADIENT_PORTION;
      bands.push([p, [accent[0], accent[1], accent[2], a * accent[3]]]);
    }
    return { radius: OBJECT_RADIUS, bands };
  }

  circle(f: OsuFrame, c: CirclePiece): void {
    // slider ends have no circle in this skin
    if (c.part === "tail" || c.part === "repeat") return;
    const ctx = f.ctx;
    const accent = dimmed(c.accent, c.dim);
    const white = dimmed(WHITE, c.dim);
    const hit = c.hit;
    ctx.translate(c.x, c.y);
    ctx.scale(f.scale, f.scale);
    ctx.globalAlpha *= c.alpha;
    let pieces = 1;
    if (hit >= 0) {
      const s = tween(hit, 1, 1.5, 400, ease.out);
      ctx.scale(s, s);
      if (hit >= 40) {
        ctx.globalAlpha *= 1 - Math.min(1, (hit - 40) / 800);
        pieces = 0;
      }
    }
    // the glow, gone over 400 ms from the hit
    const glowAlpha = 0.5 * (hit >= 0 ? Math.max(0, 1 - hit / 400) : 1);
    if (glowAlpha > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= glowAlpha;
      sprite(ctx, this.t.ringGlow, 0, 0, { scale: STORE_SCALE, tint: accent });
      ctx.restore();
    }
    if (pieces) {
      // CirclePiece: the disc in the combo colour, triangles over it
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      if (!sprite(ctx, this.t.disc, 0, 0, { scale: STORE_SCALE, tint: accent })) disc(ctx, 0, 0, SIZE, css(accent));
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= 0.5;
      triangles(ctx, 0, 0, SIZE, SIZE, f.t, c.i + 1);
      ctx.restore();
      if (c.number > 0) text(ctx, String(c.number), 0, 1, 36, 600, css(white));
      ring(ctx, 0, 0, SIZE, 9, css(white));
    }
    if (hit >= 0) {
      // the flash: to 0.8 in 40 ms, gone in 100 more; the explosion's triangles
      const flash = hit < 40 ? 0.8 * (hit / 40) : Math.max(0, 0.8 * (1 - (hit - 40) / 100));
      ctx.globalCompositeOperation = "lighter";
      if (flash > 0) {
        ctx.save();
        ctx.globalAlpha *= flash;
        disc(ctx, 0, 0, SIZE, "#fff");
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha *= Math.min(1, hit / 40) * 0.2;
      ctx.beginPath();
      ctx.arc(0, 0, SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      triangles(ctx, 0, 0, SIZE, SIZE, f.t, c.i + 7);
      ctx.restore();
    }
  }

  approach(f: OsuFrame, a: ApproachPiece): void {
    defaultApproach(f, a, this.t.approach);
  }

  tick(f: OsuFrame, k: TickPiece): void {
    // a 16-unit circle: a white ring a quarter of it, the combo colour faintly inside
    const ctx = f.ctx;
    ctx.globalAlpha *= k.alpha;
    const d = 16 * f.scale * k.scale;
    ctx.save();
    ctx.globalAlpha *= 0.3;
    disc(ctx, k.x, k.y, d, css(k.miss ? MISS_RED : k.accent));
    ctx.restore();
    ring(ctx, k.x, k.y, d, d / 4, k.miss ? css(MISS_RED) : "#fff");
  }

  repeat(f: OsuFrame, r: RepeatPiece): void {
    // DefaultReverseArrow: an additive chevron, 0.35 of the circle
    const ctx = f.ctx;
    ctx.globalAlpha *= r.alpha;
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(r.x, r.y);
    ctx.rotate(r.angle);
    const s = f.scale * repeatScale(r);
    ctx.scale(s, s);
    icon(ctx, ICON.chevronRight, SIZE * 0.35, css(dimmed(WHITE, r.dim)));
  }

  ball(f: OsuFrame, b: BallPiece): void {
    const ctx = f.ctx;
    ctx.globalAlpha *= b.alpha;
    ctx.translate(b.x, b.y);
    ctx.scale(f.scale, f.scale);
    // DefaultFollowCircle: an orange ring, faintly filled, additive
    const [fs, fa] = followCircle(b);
    if (fa > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= fa;
      const d = SIZE * fs;
      ctx.save();
      ctx.globalAlpha *= 0.2;
      disc(ctx, 0, 0, d, "#ffa500");
      ctx.restore();
      ring(ctx, 0, 0, d, 5, "#ffa500");
      ctx.restore();
    }
    // DefaultSliderBall: a white ring (additive), lit inside while it's followed
    if (b.sinceStart < 0) return;
    const followed = b.followOn >= 0 && !(b.followOff >= 0);
    const fill = followed ? tween(b.followOn, 0.05, 0.3, 200, ease.outQuint) : b.followOff >= 0 ? tween(b.followOff, 0.3, 0.05, 200, ease.outQuint) : 0.05;
    let alpha = 1;
    let scale = 1;
    if (b.sinceEnd >= 0) {
      alpha = 1 - ease.out(Math.min(1, b.sinceEnd / 112.5));
      scale = tween(b.sinceEnd, 1, 1.4, 450, ease.out);
    }
    if (alpha <= 0) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha *= alpha;
    ctx.scale(scale, scale);
    ctx.save();
    ctx.globalAlpha *= fill;
    disc(ctx, 0, 0, SIZE, "#fff");
    ctx.restore();
    ring(ctx, 0, 0, SIZE, 10, "#fff");
  }

  spinner(f: OsuFrame, s: SpinnerPiece): void {
    const ctx = f.ctx;
    const t = f.t;
    ctx.globalAlpha *= s.alpha;
    ctx.translate(s.x, s.y);
    const [mainScale, centreScale] = spinnerScales(s, t, 0.5);
    const complete = t >= s.completed;
    const colour = complete ? SPINNER_COMPLETE : SPINNER_NORMAL;
    const dark = darken(colour, 1);
    const area = 384;

    // DefaultSpinnerDisc: 1.3×, turning slowly; out to 1.2× that once it's over
    ctx.save();
    let discScale = 1.3;
    let turn = t > s.start - s.preempt / 2 ? tween(t - (s.start - s.preempt / 2), 0, (25 * (s.end - s.start)) / 2000, s.preempt + (s.end - s.start)) : 0;
    if (t > s.end) {
      discScale = tween(t - s.end, 1.3, 1.56, 320, ease.out);
      turn += tween(t - s.end, 0, 180, 320);
    }
    ctx.scale(discScale, discScale);
    ctx.rotate((turn * Math.PI) / 180);

    if (mainScale > 0) {
      ctx.save();
      ctx.rotate((s.rotation * Math.PI) / 180);
      ctx.scale(mainScale, mainScale);
      // the background layer: just its glow
      glow(ctx, 0, 0, area, 40, colour, 1, true);
      // the fill, growing with the spins
      const fillAlpha = s.tracking ? 0.4 : 0.2;
      const fillScale = 0.2 + 0.8 * s.progress;
      ctx.save();
      ctx.globalAlpha *= fillAlpha;
      glow(ctx, 0, 0, area * fillScale, 40, dark, 1, true);
      disc(ctx, 0, 0, area * fillScale, css(dark));
      ctx.restore();
      // SpinnerTicks: 8 rounded bars around the edge, additive
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= 0.4;
      ctx.shadowColor = css(dark, 0.8);
      ctx.shadowBlur = 20 * f.px * mainScale * discScale;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.save();
        ctx.translate((Math.sin(a) / 2) * 0.83 * area, (Math.cos(a) / 2) * 0.83 * area);
        ctx.rotate(((-i / 8) * 360 + 90) * (Math.PI / 180));
        box(ctx, 60, 10, 5);
        ctx.fillStyle = css(dark);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
      ctx.restore();
    }

    // SpinnerCentreLayer: a small circle with an asterisk turning at half the speed
    if (centreScale > 0) {
      ctx.save();
      ctx.scale(centreScale, centreScale);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= 0.5;
      sprite(ctx, this.t.ringGlow, 0, 0, { scale: STORE_SCALE, tint: colour });
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, SIZE / 2, 0, Math.PI * 2);
      ctx.clip();
      if (!sprite(ctx, this.t.disc, 0, 0, { scale: STORE_SCALE, tint: colour })) disc(ctx, 0, 0, SIZE, css(colour));
      ctx.restore();
      ring(ctx, 0, 0, SIZE, 9, "#fff");
      ctx.rotate((s.rotation / 2) * (Math.PI / 180));
      asterisk(ctx, 48);
      ctx.restore();
    }
    ctx.restore();

    // spins per minute, below
    if (t >= s.start) {
      ctx.globalAlpha *= Math.min(1, (t - s.start) / s.fadeIn);
      text(ctx, String(Math.trunc(Math.max(0, s.spm))), 0, 132, 24, 600, "#fff");
      text(ctx, "SPINS PER MINUTE", 0, 156, 12, 600, "#fff");
    }
  }

  judgement(f: OsuFrame, j: JudgementPiece): void {
    // DefaultJudgementPiece: the result's name, stretching from 0.8 to 1.2 wide, fading over
    // 800 ms; a miss falls, turning
    const el = j.since;
    if (el < 0 || el >= 800) return;
    const ctx = f.ctx;
    ctx.translate(j.x, j.y);
    ctx.scale(f.scale, f.scale);
    ctx.globalAlpha *= 1 - el / 800;
    if (j.result === 3) {
      missMotion(ctx, el);
      ctx.scale(0.85, 1);
    } else ctx.scale(tween(el, 0.8, 1.2, 1800, ease.outQuint), 1);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = css(JUDGEMENT_COLOURS[j.result]);
    ctx.font = `700 20px "Instrument Sans", system-ui, sans-serif`;
    ctx.letterSpacing = "2px";
    ctx.fillText(JUDGEMENT_TEXT[j.result], 1, 0);
  }

  followPoint(f: OsuFrame, p: FollowPointPiece): void {
    // a soft white dot, additive
    const ctx = f.ctx;
    ctx.globalAlpha *= p.alpha;
    ctx.globalCompositeOperation = "lighter";
    const d = 8 * p.scale;
    glow(ctx, p.x, p.y, d, 4 * p.scale, WHITE, 0.2);
    ctx.globalAlpha *= 0.5;
    disc(ctx, p.x, p.y, d, "#fff");
  }

  drawTrail(f: OsuFrame, parts: TrailPart[]): void {
    drawTrailParts(f, parts, this.t.trail, this.trailSize, 1.7, true);
  }

  cursor(f: OsuFrame, c: CursorPiece): void {
    // OsuCursor's default: a white ring around a fainter one, a blue dot in the middle
    const ctx = f.ctx;
    const size = 28;
    ctx.translate(c.x, c.y);
    const s = cursorExpand(c);
    ctx.save();
    ctx.scale(s, s);
    glow(ctx, 0, 0, size, 5, [1, 0.753, 0.796, 1], 0.5);
    ring(ctx, 0, 0, size, size / 3, "rgba(255,255,255,0.5)");
    ring(ctx, 0, 0, size, size / 6, "#fff");
    ctx.restore();
    glow(ctx, 0, 0, size * 0.14, 8, WHITE);
    disc(ctx, 0, 0, size * 0.14, css(multiply(rgb("#225dcc"), 1)));
  }
}
