/* playfield.ts — the osu! playfield in a lazer skin, laid out and timed the way lazer does it
 * (MIT, ppy Pty Ltd):
 *
 *  - OsuPlayfieldAdjustmentContainer: 0.8 of the canvas, 4:3 inside that, 512 × 384 osu!pixels;
 *  - DrawableHitCircle: the circle fades in over TimeFadeIn from TimePreempt before it, dimmed
 *    (195, 195, 195) until 400 ms before; the approach circle shrinks from 4× to 1× over the
 *    preempt, reaching 0.9 opacity, gone 50 ms after; autoplay hits everything on time;
 *  - DrawableSlider: the body fades in with the head and snakes in over a third of the preempt,
 *    out along the last span; ticks (preempt: half the time since their span started, plus
 *    200 ms or 0.66 × the preempt on the first span), repeats (the first with the slider, the
 *    rest two spans early) and the ball that follows the path; all fading out 240 ms after the end;
 *  - DrawableSpinner: in the middle, turning as the autoplay cursor circles it;
 *  - FollowPointConnection: points every 32 osu!pixels between objects of one combo;
 *  - the cursor and its trail on top.
 *
 * Later objects are drawn under earlier ones, approach circles above them all. The skin renderers
 * (argon.ts, triangles.ts, legacy.ts) draw the pieces; this decides where and when.
 */
import type { ChartData } from "../../lib/types";
import { ease, multiply, tween, type Colour } from "../mania/draw";
import { BASE_HEIGHT, BASE_WIDTH, bound, CIRCLE, MISS_WINDOW, OBJECT_RADIUS, OsuChart, SLIDER, SPINNER, SPINNER_X, SPINNER_Y, upper, type Slider } from "./chart";

/** OsuPlayfieldAdjustmentContainer */
const PLAYFIELD_SIZE = 0.8;
/** DrawableOsuHitObject: the colour objects have until they can be hit */
const DIM = 195 / 255;
/** DrawableSlider: everything fades out over this once the slider is over */
const SLIDER_FADE_OUT = 240;
/** DrawableSpinner */
const SPINNER_FADE_OUT = 240;
/** how long a hit circle stays after it's hit (DrawableHitCircle: 800 ms, then gone) */
const HIT_LIFE = 800;
/** FollowPointConnection */
const FOLLOW_SPACING = 32;
const FOLLOW_PREEMPT = 800;
const FOLLOW_DURATION = 400;
/** OsuHitObject.PREEMPT_MIN */
const PREEMPT_MIN = 450;
/** DrawableSliderTick.ANIM_DURATION */
const TICK_ANIM = 150;
/** SpinnerSpmCalculator */
const SPM_WINDOW = 595;
/** DrawableSliderBall.FOLLOW_AREA */
export const FOLLOW_AREA = 2.4;

export interface OsuFrame {
  ctx: CanvasRenderingContext2D;
  /** song time, ms */
  t: number;
  rate: number;
  chart: OsuChart;
  /** device pixels per osu!pixel (canvas doesn't scale blur radii) */
  px: number;
  /** OsuHitObject.Scale */
  scale: number;
}

/** A circle: a hit circle, a slider's head, or (legacy skins) its tail / repeat circles. */
export interface CirclePiece {
  i: number;
  x: number;
  y: number;
  accent: Colour;
  /** the combo number shown (0: none) */
  number: number;
  part: "circle" | "head" | "tail" | "repeat";
  /** fade-in (and the slider's fade-out) */
  alpha: number;
  /** colour multiplier: dimmed until it can be hit */
  dim: number;
  /** ms since it was hit (NaN before) */
  hit: number;
}

export interface ApproachPiece {
  x: number;
  y: number;
  accent: Colour;
  /** 4 → 1 */
  scale: number;
  alpha: number;
}

export interface TickPiece {
  x: number;
  y: number;
  accent: Colour;
  alpha: number;
  scale: number;
}

export interface RepeatPiece {
  x: number;
  y: number;
  accent: Colour;
  /** where the arrow points, radians */
  angle: number;
  /** the arrow's fade (in, and out once hit) */
  alpha: number;
  /** the end circle's (legacy skins draw one under the arrow) */
  circleAlpha: number;
  dim: number;
  /** ms since it was hit (NaN before) */
  hit: number;
  /** ms since its animation started (it loops every 300 ms) */
  loop: number;
  spanDuration: number;
}

export interface BallPiece {
  i: number;
  x: number;
  y: number;
  /** direction of travel, radians */
  angle: number;
  accent: Colour;
  /** ms since the slider started / ended (negative before) */
  sinceStart: number;
  sinceEnd: number;
  /** ms since the last tick or repeat was hit (NaN for none yet) */
  sinceTick: number;
  /** osu!pixels per ms */
  velocity: number;
  /** the slider's fade-out */
  alpha: number;
}

export interface SpinnerPiece {
  i: number;
  x: number;
  y: number;
  start: number;
  end: number;
  preempt: number;
  fadeIn: number;
  /** degrees, signed */
  rotation: number;
  /** 0–1 */
  progress: number;
  /** when it got all its spins (Infinity if never) */
  completed: number;
  /** spins per minute */
  spm: number;
  alpha: number;
}

export interface FollowPointPiece {
  x: number;
  y: number;
  angle: number;
  alpha: number;
  scale: number;
  /** ms since it started fading in */
  since: number;
}

export interface CursorPiece {
  x: number;
  y: number;
  /** ms since a button went down (NaN while none is held) */
  pressed: number;
  /** ms since the buttons were let go (NaN while held) */
  released: number;
}

export interface TrailPart {
  x: number;
  y: number;
  /** 1 new → 0 gone (before the fade exponent) */
  life: number;
}

export interface TrailStyle {
  /** CursorTrail.FadeDuration */
  fade: number;
  /** osu!pixels between parts; 0 for "disjoint" trails (a part every 1/60 s) */
  interval: number;
}

export interface BodyStyle {
  /** path radius at scale 1 */
  radius: number;
  /** the path's colour from the edge (0) to the middle (1): [from, colour] bands */
  bands: [number, Colour][];
}

export interface OsuRenderer {
  /** the skin's combo colours (the beatmap's own win) */
  readonly comboColours: Colour[];
  body(accent: Colour): BodyStyle;
  circle(f: OsuFrame, c: CirclePiece): void;
  approach(f: OsuFrame, a: ApproachPiece): void;
  tick(f: OsuFrame, k: TickPiece): void;
  repeat(f: OsuFrame, r: RepeatPiece): void;
  ball(f: OsuFrame, b: BallPiece): void;
  spinner(f: OsuFrame, s: SpinnerPiece): void;
  followPoint(f: OsuFrame, p: FollowPointPiece): void;
  readonly trail: TrailStyle;
  drawTrail(f: OsuFrame, parts: TrailPart[]): void;
  cursor(f: OsuFrame, c: CursorPiece): void;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export class OsuPlayfield {
  readonly chart: OsuChart;
  private readonly bodies = new BodyCache();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly data: ChartData,
    private renderer: OsuRenderer,
  ) {
    this.chart = new OsuChart(data);
  }

  setRenderer(r: OsuRenderer): void {
    this.renderer = r;
    this.bodies.clear();
  }

  private accent(i: number): Colour {
    const ch = this.chart;
    const idx = ch.colour[i];
    if (ch.colours.length) {
      const c = ch.colours[((idx % ch.colours.length) + ch.colours.length) % ch.colours.length];
      return [c[0] / 255, c[1] / 255, c[2] / 255, 1];
    }
    const skin = this.renderer.comboColours;
    return skin[((idx % skin.length) + skin.length) % skin.length];
  }

  draw(t: number, rate: number): void {
    const c = this.canvas;
    const W = c.clientWidth;
    const H = c.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);

    // OsuPlayfieldAdjustmentContainer: 0.8 of the area, 4:3 inside it
    const areaW = W * PLAYFIELD_SIZE;
    const areaH = H * PLAYFIELD_SIZE;
    const pfW = Math.min(areaW, (areaH * 4) / 3);
    const s = pfW / BASE_WIDTH;
    const ox = (W - pfW) / 2;
    const oy = (H - BASE_HEIGHT * s) / 2;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

    const ch = this.chart;
    const r = this.renderer;
    const f: OsuFrame = { ctx, t, rate, chart: ch, px: dpr * s, scale: ch.scale };
    const preempt = ch.preempt;

    const from = bound(ch.time, t - ch.maxSpan - HIT_LIFE - 100);
    const to = upper(ch.time, t + preempt + 1);

    // spinners, under everything
    for (let i = from; i < to; i++) {
      if (ch.kind[i] !== SPINNER) continue;
      const start = ch.time[i];
      const end = ch.end[i];
      if (t < start - preempt || t > end + SPINNER_FADE_OUT) continue;
      const spin = ch.spinAt(i, t);
      const before = ch.spinAt(i, t - SPM_WINDOW).total;
      const spm = t > start ? ((spin.total - before) / 360 / Math.min(SPM_WINDOW, Math.max(1, t - start))) * 60000 : 0;
      ctx.save();
      r.spinner(f, {
        i,
        x: SPINNER_X,
        y: SPINNER_Y,
        start,
        end,
        preempt,
        fadeIn: ch.fadeIn,
        rotation: spin.rotation,
        progress: ch.spinProgress(i, t),
        completed: ch.spinCompleted(i),
        spm,
        alpha: t > end ? 1 - (t - end) / SPINNER_FADE_OUT : 1,
      });
      ctx.restore();
    }

    // follow points, between objects of a combo
    for (let i = Math.max(1, from); i < to; i++) {
      if (ch.newCombo[i] || ch.kind[i] === SPINNER || ch.kind[i - 1] === SPINNER) continue;
      this.followPoints(f, i - 1, i);
    }

    // objects: later ones under earlier ones
    const approaches: ApproachPiece[] = [];
    for (let i = to - 1; i >= from; i--) {
      const k = ch.kind[i];
      if (k === CIRCLE) this.hitCircle(f, i, approaches);
      else if (k === SLIDER) this.slider(f, i, approaches);
    }

    for (let j = approaches.length - 1; j >= 0; j--) {
      ctx.save();
      r.approach(f, approaches[j]);
      ctx.restore();
    }

    this.cursor(f);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** DrawableHitCircle (and a slider's head): the circle, and its approach circle for later. */
  private circleAt(f: OsuFrame, i: number, x: number, y: number, part: "circle" | "head", parentAlpha: number, approaches: ApproachPiece[]): void {
    const ch = this.chart;
    const t = f.t;
    const start = ch.time[i];
    const preempt = ch.preempt;
    const appear = start - preempt;
    if (t < appear) return;
    const hit = t >= start ? t - start : NaN;
    if (hit >= HIT_LIFE) return;
    const accent = this.accent(i);
    const dim = t < start - MISS_WINDOW ? DIM : tween(t - (start - MISS_WINDOW), DIM, 1, 100);
    const alpha = clamp01((t - appear) / ch.fadeIn) * parentAlpha;
    f.ctx.save();
    this.renderer.circle(f, { i, x, y, accent, number: ch.number[i], part, alpha, dim, hit });
    f.ctx.restore();
    // the approach circle: 4× → 1× over the preempt, to 0.9 over two fade-ins; out 50 ms from the start
    if (t < start + 50) {
      let a = 0.9 * clamp01((t - appear) / Math.min(ch.fadeIn * 2, preempt));
      if (t >= start) a *= 1 - (t - start) / 50;
      approaches.push({ x, y, accent, scale: tween(t - appear, 4, 1, preempt), alpha: a * parentAlpha });
    }
  }

  private hitCircle(f: OsuFrame, i: number, approaches: ApproachPiece[]): void {
    const ch = this.chart;
    this.circleAt(f, i, ch.x[i], ch.y[i], "circle", 1, approaches);
  }

  private slider(f: OsuFrame, i: number, approaches: ApproachPiece[]): void {
    const ch = this.chart;
    const t = f.t;
    const start = ch.time[i];
    const end = ch.end[i];
    const preempt = ch.preempt;
    if (t < start - preempt || t > end + SLIDER_FADE_OUT) return;
    const s = ch.slider(i);
    const r = this.renderer;
    const ctx = f.ctx;
    const accent = this.accent(i);
    const duration = Math.max(1, end - start);
    const completion = clamp01((t - start) / duration);
    const alpha = t > end ? clamp01(1 - (t - end) / SLIDER_FADE_OUT) : 1;
    const dim = t < start - MISS_WINDOW ? DIM : tween(t - (start - MISS_WINDOW), DIM, 1, 100);

    // SnakingSliderBody.UpdateProgress (with the head hit at the start)
    const span = Math.min(Math.floor(completion * s.spans), s.spans);
    const spanProgress = ch.progressAt(s, completion);
    let p0 = 0;
    let p1 = clamp01((t - (start - preempt)) / (preempt / 3));
    if (span >= s.spans - 1) {
      if (Math.min(span, s.spans - 1) % 2 === 1) p1 = spanProgress;
      else p0 = spanProgress;
    }
    if (p0 > p1) [p0, p1] = [p1, p0];
    const snakeStart = ch.positionAt(s, p0);
    const snakeEnd = ch.positionAt(s, p1);

    // the body: fades in with the head; gone 40 ms after the end once snaked out
    let bodyAlpha = clamp01((t - (start - preempt)) / ch.fadeIn) * alpha;
    if (t > end) bodyAlpha *= clamp01(1 - (t - end) / 40);
    if (bodyAlpha > 0 && p1 > p0) {
      const style = r.body(accent);
      this.bodies.draw(f, ch, s, ch.a[i], p0, p1, style, bodyAlpha);
    }

    // the tail (legacy skins draw a circle there): with the slider, or two spans early
    const repeats = s.spans - 1;
    const tailPreempt = repeats > 0 ? s.spanDuration * 2 : preempt + duration;
    const tailAppear = end - tailPreempt;
    if (t >= tailAppear) {
      const delay = repeats === 0 ? preempt / 3 : 0;
      const fadeIn = repeats > 0 ? 0 : ch.fadeIn;
      const tailAlpha = (fadeIn > 0 ? clamp01((t - tailAppear - delay) / fadeIn) : t >= tailAppear + delay ? 1 : 0) * alpha;
      const [tx, ty] = repeats % 2 === 0 ? snakeEnd : ch.positionAt(s, 0);
      if (tailAlpha > 0) {
        ctx.save();
        r.circle(f, { i, x: tx, y: ty, accent, number: 0, part: "tail", alpha: tailAlpha, dim, hit: t >= end ? t - end : NaN });
        ctx.restore();
      }
    }

    // ticks
    for (let k = 0; k < s.tickTime.length; k++) {
      const time = s.tickTime[k];
      const spanIndex = Math.min(s.spans - 1, Math.max(0, Math.floor((time - start) / s.spanDuration)));
      const spanStart = start + spanIndex * s.spanDuration;
      const tickPreempt = (time - spanStart) / 2 + (spanIndex > 0 ? 200 : preempt * 0.66);
      const appear = time - tickPreempt;
      if (t < appear) continue;
      let a = clamp01((t - appear) / TICK_ANIM);
      let scale = tween(t - appear, 0.5, 1, TICK_ANIM * 4, ease.outElasticHalf);
      if (t >= time) {
        const e = t - time;
        if (e >= TICK_ANIM) continue;
        a *= 1 - ease.outQuint(e / TICK_ANIM);
        scale *= tween(e, 1, 1.5, TICK_ANIM, ease.out);
      }
      const [x, y] = ch.positionAt(s, s.tickProgress[k]);
      ctx.save();
      r.tick(f, { x, y, accent, alpha: a * alpha, scale });
      ctx.restore();
    }

    // repeats: the first with the slider, the rest two spans before
    for (let k = 0; k < repeats; k++) {
      const time = start + (k + 1) * s.spanDuration;
      const repeatPreempt = k > 0 ? s.spanDuration * 2 : preempt + (time - start);
      const appear = time - repeatPreempt;
      if (t < appear) continue;
      const animDuration = Math.min(300, s.spanDuration);
      if (t >= time + animDuration) continue;
      const delay = k === 0 ? preempt / 3 : 0;
      const arrowFade = k > 0 ? Math.min(s.spanDuration, 150) : 150;
      const circleFade = k > 0 ? 0 : ch.fadeIn;
      let arrowAlpha = clamp01((t - appear - delay) / arrowFade);
      let circleAlpha = circleFade > 0 ? clamp01((t - appear - delay) / circleFade) : t >= appear + delay ? 1 : 0;
      const hit = t >= time ? t - time : NaN;
      if (hit >= 0) {
        const out = 1 - ease.out(Math.min(1, hit / animDuration));
        arrowAlpha *= out;
        circleAlpha *= out;
      }
      // at the end the path goes back from (even repeats), or at the start
      const atEnd = k % 2 === 0;
      const [x, y] = atEnd ? snakeEnd : snakeStart;
      const [ax, ay] = ch.pointAt(s, atEnd ? s.length - 4 : 4);
      ctx.save();
      r.repeat(f, {
        x,
        y,
        accent,
        angle: Math.atan2(ay - y, ax - x),
        alpha: arrowAlpha * alpha,
        circleAlpha: circleAlpha * alpha,
        dim,
        hit,
        loop: t - appear,
        spanDuration: s.spanDuration,
      });
      ctx.restore();
    }

    // the head: a hit circle of its own
    const [hx, hy] = ch.positionAt(s, 0);
    this.circleAt(f, i, hx, hy, "head", alpha, approaches);

    // the ball and follow circle, from the start
    if (t >= start - 1) {
      const [bx, by] = ch.positionAt(s, spanProgress);
      // DrawableSliderBall: the direction it's travelling
      const back = ch.positionAt(s, ch.progressAt(s, Math.max(0, completion - 0.1 / duration)));
      const ahead = ch.positionAt(s, ch.progressAt(s, Math.min(1, completion + 0.1 / duration)));
      let angle = Math.atan2(ahead[1] - back[1], ahead[0] - back[0]);
      if (ahead[0] === back[0] && ahead[1] === back[1]) {
        const d = spanProgress * s.length;
        const fw = span % 2 === 1 ? -1 : 1;
        const [nx, ny] = ch.pointAt(s, d + fw * 2);
        const [qx, qy] = ch.pointAt(s, d - fw * 2);
        angle = Math.atan2(ny - qy, nx - qx);
      }
      // the last tick or repeat hit
      let lastTick = NaN;
      for (let k = 0; k < s.tickTime.length; k++) if (s.tickTime[k] <= t) lastTick = Math.max(Number.isNaN(lastTick) ? -Infinity : lastTick, s.tickTime[k]);
      for (let k = 0; k < repeats; k++) {
        const time = start + (k + 1) * s.spanDuration;
        if (time <= t && time < end) lastTick = Math.max(Number.isNaN(lastTick) ? -Infinity : lastTick, time);
      }
      ctx.save();
      r.ball(f, {
        i,
        x: bx,
        y: by,
        angle,
        accent,
        sinceStart: t - start,
        sinceEnd: t - end,
        sinceTick: Number.isNaN(lastTick) ? NaN : t - lastTick,
        velocity: s.spanDuration > 0 ? s.length / s.spanDuration : 0,
        alpha,
      });
      ctx.restore();
    }
  }

  /** FollowPointConnection between object a's end and object b's start. */
  private followPoints(f: OsuFrame, a: number, b: number): void {
    const ch = this.chart;
    const t = f.t;
    const startTime = ch.end[a];
    const endTime = ch.time[b];
    const preempt = FOLLOW_PREEMPT * Math.min(1, ch.preempt / PREEMPT_MIN);
    if (t < startTime - preempt || t > endTime + FOLLOW_DURATION) return;
    const [sx, sy] = this.endPosition(a);
    const ex = ch.x[b];
    const ey = ch.y[b];
    const dx = ex - sx;
    const dy = ey - sy;
    const distance = Math.floor(Math.hypot(dx, dy));
    if (distance <= 0) return;
    const angle = Math.atan2(dy, dx);
    const duration = endTime - startTime;
    for (let d = Math.floor(FOLLOW_SPACING * 1.5); d < distance - FOLLOW_SPACING; d += FOLLOW_SPACING) {
      const fraction = d / distance;
      const fadeOut = startTime + fraction * duration;
      const fadeIn = fadeOut - preempt;
      if (t < fadeIn || t > fadeOut + FOLLOW_DURATION) continue;
      const e = t - fadeIn;
      const move = ease.out(Math.min(1, e / FOLLOW_DURATION));
      let alpha = Math.min(1, e / FOLLOW_DURATION);
      if (t > fadeOut) alpha *= 1 - (t - fadeOut) / FOLLOW_DURATION;
      if (alpha <= 0) continue;
      const fr = fraction - 0.1 + 0.1 * move;
      f.ctx.save();
      this.renderer.followPoint(f, {
        x: sx + fr * dx,
        y: sy + fr * dy,
        angle,
        alpha,
        scale: ch.scale * (1.5 - 0.5 * move),
        since: e,
      });
      f.ctx.restore();
    }
  }

  /** OsuHitObject.StackedEndPosition */
  private endPosition(i: number): [number, number] {
    const ch = this.chart;
    if (ch.kind[i] !== SLIDER) return [ch.x[i], ch.y[i]];
    const s = ch.slider(i);
    return ch.positionAt(s, s.spans % 2 === 1 ? 1 : 0);
  }

  /** The cursor and its trail. */
  private cursor(f: OsuFrame): void {
    const ch = this.chart;
    const t = f.t;
    if (!ch.frameTime.length) return;
    const r = this.renderer;
    const style = r.trail;
    const parts: TrailPart[] = [];
    if (style.interval > 0) {
      // a part every `interval` along the way the cursor went
      const now = ch.distAt(t);
      const back = ch.distAt(t - style.fade);
      const first = Math.ceil(back / style.interval);
      for (let k = first; k * style.interval <= now; k++) {
        const d = k * style.interval;
        const at = ch.timeAtDist(d);
        const life = 1 - (t - at) / style.fade;
        if (life <= 0) continue;
        const [x, y] = ch.cursorAt(at);
        parts.push({ x, y, life });
      }
    } else {
      const step = 1000 / 60;
      for (let at = Math.ceil((t - style.fade) / step) * step; at <= t; at += step) {
        const [x, y] = ch.cursorAt(at);
        parts.push({ x, y, life: 1 - (t - at) / style.fade });
      }
    }
    f.ctx.save();
    r.drawTrail(f, parts);
    f.ctx.restore();
    const [x, y] = ch.cursorAt(t);
    const since = ch.pressedSince(t);
    let released = NaN;
    if (Number.isNaN(since)) {
      // when the last press ended
      const k = upper(ch.frameTime, t) - 1;
      let j = k;
      while (j >= 0 && !ch.frameButtons[j]) j--;
      if (j >= 0 && j + 1 < ch.frameTime.length) released = t - ch.frameTime[j + 1];
    }
    f.ctx.save();
    r.cursor(f, { x, y, pressed: Number.isNaN(since) ? NaN : t - since, released });
    f.ctx.restore();
  }
}

// ── slider bodies ─────────────────────────────────────────────────────────

interface CachedBody {
  key: string;
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Slider bodies as lazer's path shader draws them: a 1-D texture across the path, edge to middle.
 * Each band is a stroke along the path as wide as the part of the path it covers, drawn over the
 * wider ones (replacing them, alpha and all), into a canvas of its own; the whole body is then
 * drawn at the body's opacity. Bodies that don't change (between snaking in and out) are kept.
 */
class BodyCache {
  private readonly cache = new Map<number, CachedBody>();
  private readonly spare: HTMLCanvasElement[] = [];

  clear(): void {
    for (const b of this.cache.values()) this.spare.push(b.canvas);
    this.cache.clear();
  }

  draw(f: OsuFrame, ch: OsuChart, s: Slider, id: number, p0: number, p1: number, style: BodyStyle, alpha: number): void {
    const radius = style.radius * f.scale;
    const px = f.px;
    const key = `${p0.toFixed(4)}|${p1.toFixed(4)}|${radius.toFixed(3)}|${px.toFixed(3)}|${style.bands.map(([p, c]) => `${p.toFixed(3)}:${c.map((v) => v.toFixed(3)).join(",")}`).join(";")}`;
    let body = this.cache.get(id);
    if (!body || body.key !== key) {
      const points = ch.subPath(s, p0, p1);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k < points.length; k += 2) {
        minX = Math.min(minX, points[k]);
        maxX = Math.max(maxX, points[k]);
        minY = Math.min(minY, points[k + 1]);
        maxY = Math.max(maxY, points[k + 1]);
      }
      const x = minX - radius - 1;
      const y = minY - radius - 1;
      const w = maxX - minX + radius * 2 + 2;
      const h = maxY - minY + radius * 2 + 2;
      const cw = Math.max(1, Math.ceil(w * px));
      const chh = Math.max(1, Math.ceil(h * px));
      const canvas = body?.canvas ?? this.spare.pop() ?? document.createElement("canvas");
      if (canvas.width !== cw || canvas.height !== chh) {
        canvas.width = cw;
        canvas.height = chh;
      }
      const g = canvas.getContext("2d")!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cw, chh);
      g.setTransform(px, 0, 0, px, -x * px, -y * px);
      g.lineCap = "round";
      g.lineJoin = "round";
      const path = new Path2D();
      path.moveTo(points[0], points[1]);
      for (let k = 2; k < points.length; k += 2) path.lineTo(points[k], points[k + 1]);
      if (points.length === 2 || (points.length === 4 && points[0] === points[2] && points[1] === points[3])) path.lineTo(points[0] + 0.01, points[1]);
      for (const [p, colour] of style.bands) {
        const width = 2 * radius * (1 - p);
        if (width <= 0) continue;
        g.lineWidth = width;
        // replace what's under it, as the shader would
        g.globalCompositeOperation = "destination-out";
        g.strokeStyle = "#000";
        g.stroke(path);
        g.globalCompositeOperation = "source-over";
        g.strokeStyle = `rgba(${Math.round(colour[0] * 255)},${Math.round(colour[1] * 255)},${Math.round(colour[2] * 255)},${colour[3]})`;
        g.stroke(path);
      }
      body = { key, canvas, x, y, w: cw / px, h: chh / px };
      this.cache.set(id, body);
      if (this.cache.size > 48) {
        const oldest = this.cache.keys().next().value!;
        this.spare.push(this.cache.get(oldest)!.canvas);
        this.cache.delete(oldest);
      }
    }
    const ctx = f.ctx;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.drawImage(body.canvas, body.x, body.y, body.w, body.h);
    ctx.restore();
  }
}

/** A colour with lazer's dim applied (a multiplier on red, green and blue). */
export const dimmed = (c: Colour, dim: number): Colour => (dim >= 1 ? c : multiply(c, dim));

export { OBJECT_RADIUS };
