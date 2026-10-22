/* playfield.ts — the osu!taiko playfield in a lazer skin, laid out and scrolled the way lazer does
 * it (MIT, ppy Pty Ltd):
 *
 *  - TaikoPlayfieldAdjustmentContainer: 200 units tall, scaled to the canvas height (taller on
 *    very wide canvases, shorter on narrow ones), its top 135/480 of the way down; the time range
 *    from the aspect ratio (stable's 640 → 160 px in 6000 ms, divided by 1.4);
 *  - TaikoPlayfield: the input drum's 180 units on the left, the hit target 24 units left of the
 *    right area's edge; hit objects masked to the right area until they're hit (then they fly
 *    over everything), bar lines behind them;
 *  - OverlappingScrollAlgorithm: everything moves at the multiplier of its own time;
 *  - DrawableHit: a hit note jumps up and falls away, shrinking and fading; a missed one scrolls
 *    on and fades out in 100 ms; drum roll ticks send up small notes of their own
 *    (DrawableFlyingHit) in the colour that hit them; swells stop at the hit target;
 *  - TaikoPlayfield.OnNewResult: every judged note gets an explosion and a judgement for its
 *    result (Great, Ok, Miss), a strong note's second key a bigger explosion;
 *  - TaikoModHidden: notes and drum roll ticks fade out over the first 0.375 of their way in (hit,
 *    they stay gone);
 *  - TaikoModFlashlight: black but for a circle a little past the hit target, 200 units across at
 *    first, smaller at 100 and 200 combo, bigger in breaks. (Easy and Hard Rock come built into
 *    the chart.)
 *
 * The skin renderers (triangles.ts, argon.ts, legacy.ts) draw the pieces; this decides where and
 * when, from the timeline of what's played (chart.ts: autoplay or a replay).
 */
import type { Mod } from "../../lib/mods";
import type { ChartData } from "../../lib/types";
import { breakPeriods, Combo, comboScale, drawCircleLight, FlashlightSize, type FlashlightSpec } from "../flashlight";
import type { TaikoReplay } from "../../lib/taiko-replay";
import { BASE_HEIGHT, bound, CENTRE, DEFAULT_SIZE, HIT_X, INPUT_DRUM_WIDTH, RIM, ROLL, STRONG_SCALE, SWELL, TaikoChart, upper, type HitResult } from "./chart";

/** stable's game field is 480 tall */
const STABLE_HEIGHT = 480;
const MAX_ASPECT = 16 / 9;
const MIN_ASPECT = 5 / 4;
/** TaikoBeatmapConverter.VELOCITY_MULTIPLIER */
const VELOCITY_MULTIPLIER = 1.4;

export interface TaikoFrame {
  ctx: CanvasRenderingContext2D;
  /** song time, ms */
  t: number;
  rate: number;
  chart: TaikoChart;
  /** playfield width, units */
  width: number;
  /** canvas pixels per unit */
  scale: number;
  /** device pixels per unit (canvas doesn't scale blur radii) */
  px: number;
  /** the playfield's top, in units from the canvas top */
  top: number;
  /** the canvas height, in units */
  canvasHeight: number;
}

/** A hit note (or a drum roll's flying note), centred on (x, y). */
export interface HitPiece {
  /** the object (-1 for flying notes) */
  i: number;
  x: number;
  y: number;
  /** diameter */
  size: number;
  rim: boolean;
  strong: boolean;
  /** when it was hit (NaN while it isn't) */
  hitAt: number;
}

export interface RollPiece {
  i: number;
  /** the head's centre */
  x: number;
  y: number;
  /** head to tail */
  length: number;
  /** the body's height */
  height: number;
  strong: boolean;
  /** 0 idle → 1 engaged (lazer turns rolls darker as ticks are hit, back as they're missed) */
  engaged: number;
}

export interface TickPiece {
  x: number;
  y: number;
  /** the tick drawable's size (its piece is a share of it) */
  size: number;
  first: boolean;
  strong: boolean;
  hitAt: number;
}

export interface SwellPiece {
  i: number;
  x: number;
  y: number;
  size: number;
  /** hits so far, of `required` */
  hits: number;
  required: number;
  start: number;
  end: number;
  /** when it was cleared or missed */
  judgedAt: number;
  cleared: boolean;
}

/** A judged note: explosions, judgements. */
export interface HitEvent {
  i: number;
  /** when it was judged */
  at: number;
  result: HitResult;
  rim: boolean;
  /** a strong note */
  strong: boolean;
  /** when its second key landed, NaN if it didn't (by now) */
  strongAt: number;
  kiai: boolean;
}

export interface TaikoRenderer {
  /** legacy: the scrolling strip above the playfield (taiko-slider) */
  scroller?(f: TaikoFrame): void;
  backgroundRight(f: TaikoFrame): void;
  backgroundLeft(f: TaikoFrame): void;
  drum(f: TaikoFrame): void;
  /** legacy: pippidon */
  mascot?(f: TaikoFrame): void;
  kiaiGlow?(f: TaikoFrame): void;
  explosion(f: TaikoFrame, e: HitEvent): void;
  hitTarget(f: TaikoFrame): void;
  barLine(f: TaikoFrame, x: number, major: boolean): void;
  hit(f: TaikoFrame, h: HitPiece): void;
  roll(f: TaikoFrame, r: RollPiece): void;
  tick(f: TaikoFrame, k: TickPiece): void;
  swell(f: TaikoFrame, s: SwellPiece): void;
  kiaiExplosion?(f: TaikoFrame, e: HitEvent): void;
  judgement?(f: TaikoFrame, e: HitEvent): void;
}

/** How long a judged hit's explosion / judgement can show, ms. */
const EVENT_LIFE = 1200;
/** DrawableHit: up 200 units in 300 ms, then down 400 in 600; faded out over 800 ms */
const GRAVITY_TIME = 300;
const GRAVITY_HEIGHT = 200;
const HIT_FADE = 800;
/** TaikoModHidden: fading from the moment it comes in, over this share of its way */
const HD_FADE = 0.375;
/** TaikoModFlashlight: where it sits (osu!stable's 208 × 1.6, both ways, in units) */
const FLASHLIGHT: FlashlightSpec = { size: 200, breakScale: 2.5, comboScale, speed: 1.875 / 1000 };
const FL_POSITION = 208 * 1.6;
const FL_SMOOTHNESS = 1.4;

export class TaikoPlayfield {
  readonly chart: TaikoChart;
  /** the longest any object lasts, so ones that started long ago are still looked at */
  private readonly maxSpan: number;
  private hidden = false;
  private light: FlashlightSize | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly data: ChartData,
    private renderer: TaikoRenderer,
  ) {
    this.chart = new TaikoChart(data);
    let span = 0;
    for (let i = 0; i < this.chart.n; i++) span = Math.max(span, this.chart.end[i] - this.chart.time[i]);
    this.maxSpan = span;
  }

  setRenderer(r: TaikoRenderer): void {
    this.renderer = r;
  }

  /** Plays a judged replay (lib/taiko-replay) instead of autoplay, or autoplay again (null). */
  setPlay(r: TaikoReplay | null): void {
    this.chart.setPlay(r);
  }

  /** The mods it draws (Hidden, Flashlight). */
  setMods(mods: readonly Mod[]): void {
    this.hidden = mods.includes("HD");
    if (!mods.includes("FL")) this.light = null;
    else if (!this.light) {
      const combo = this.combo();
      this.light = new FlashlightSize(FLASHLIGHT, combo, breakPeriods(this.data, combo));
    }
  }

  private comboCache: Combo | null = null;

  /** Autoplay's combo: hits add to it (a strong one once); drum roll ticks and swells don't. */
  combo(): Combo {
    if (this.comboCache) return this.comboCache;
    const ch = this.chart;
    const times: number[] = [];
    for (let i = 0; i < ch.n; i++) if (ch.kind[i] === CENTRE || ch.kind[i] === RIM) times.push(ch.time[i]);
    return (this.comboCache = new Combo(times));
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

    // TaikoPlayfieldAdjustmentContainer
    const aspect = W / H;
    let relative = BASE_HEIGHT / 768;
    if (aspect > MAX_ASPECT) relative *= aspect / MAX_ASPECT;
    else if (aspect < MIN_ASPECT) relative *= aspect / MIN_ASPECT;
    relative = Math.min(relative, 1 / 3);
    const scale = (H * relative) / BASE_HEIGHT;
    const top = (H * 135) / STABLE_HEIGHT / scale;
    const width = W / scale;
    const clamped = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
    const timeRange = ((clamped * STABLE_HEIGHT - 160) / 100) * 1000 / VELOCITY_MULTIPLIER;
    const length = Math.max(1, width - HIT_X);

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, dpr * scale * top);
    const f: TaikoFrame = { ctx, t, rate, chart: this.chart, width, scale, px: dpr * scale, top, canvasHeight: H / scale };
    const r = this.renderer;
    const ch = this.chart;
    const pos = (time: number, origin = time) => HIT_X + ((time - t) / timeRange) * ch.multiplier(origin) * length;
    const span = (from: number, to: number) => ((to - from) / timeRange) * ch.multiplier(from) * length;
    // Hidden: from when it comes in, over a share of the time it takes to cross
    const hiddenFade = (time: number) => {
      if (!this.hidden) return 1;
      const preempt = timeRange / ch.multiplier(time);
      return 1 - Math.min(1, Math.max(0, (t - (time - preempt)) / (preempt * HD_FADE)));
    };

    ctx.save();
    r.scroller?.(f);
    r.backgroundRight(f);
    r.backgroundLeft(f);
    r.drum(f);
    r.mascot?.(f);
    ctx.restore();

    // judged notes: explosions, kiai explosions, judgements (a late hit or a miss comes up to
    // the Ok window after the note's time)
    const events: HitEvent[] = [];
    const firstEvent = bound(ch.time, t - EVENT_LIFE - 200);
    for (let i = firstEvent; i < ch.n && ch.time[i] <= t + 200; i++) {
      const k = ch.kind[i];
      if (k !== CENTRE && k !== RIM) continue;
      const hit = ch.hitAt[i];
      const at = Number.isNaN(hit) ? ch.missAt[i] : hit;
      if (!(at <= t && t - at < EVENT_LIFE)) continue;
      const strongAt = ch.strongAt[i] <= t ? ch.strongAt[i] : NaN;
      events.push({ i, at, result: ch.result[i] as HitResult, rim: k === RIM, strong: !!ch.strong[i], strongAt, kiai: !!ch.kiai[i] });
    }
    events.sort((a, b) => a.at - b.at);

    ctx.save();
    r.kiaiGlow?.(f);
    for (const e of events) r.explosion(f, e);
    r.hitTarget(f);
    ctx.restore();

    // bar lines: behind the objects, faded out over 150 ms once they pass
    const bars = ch.barTime;
    const fromBar = bound(bars, t - 150);
    const barAhead = t + timeRange * ch.maxAhead * 1.2;
    for (let i = fromBar; i < bars.length && bars[i] <= barAhead; i++) {
      const x = pos(bars[i]);
      if (x > width + 20) continue;
      const fade = t > bars[i] ? 1 - (t - bars[i]) / 150 : 1;
      if (fade <= 0) continue;
      ctx.save();
      ctx.globalAlpha = fade;
      r.barLine(f, x, !!ch.barMajor[i]);
      ctx.restore();
    }

    // objects: those still to be hit scroll under the drum's edge (masked); hit notes and swells
    // being played fly above everything
    const ahead = t + timeRange * ch.maxAhead * (1 + 300 / length);
    const from = bound(ch.time, t - Math.max(this.maxSpan, HIT_FADE) - 700);
    const to = upper(ch.time, ahead);
    const proxied: (() => void)[] = [];
    const flying: (() => void)[] = [];
    const masked: (() => void)[] = [];
    const L = GRAVITY_TIME * rate;
    for (let i = from; i < to; i++) {
      const k = ch.kind[i];
      const time = ch.time[i];
      if (k === CENTRE || k === RIM) {
        const strong = !!ch.strong[i];
        const size = BASE_HEIGHT * DEFAULT_SIZE * (strong ? STRONG_SCALE : 1);
        const x = pos(time);
        const hitAt = ch.hitAt[i];
        const hit = t >= hitAt;
        let fade = hiddenFade(time);
        // missed: it scrolls on, out in 100 ms
        if (t >= ch.missAt[i]) fade *= 1 - (t - ch.missAt[i]) / 100;
        if (fade <= 0) continue;
        if (!hit) {
          if (x - size / 2 > width) continue;
          masked.push(() => {
            f.ctx.save();
            f.ctx.globalAlpha *= fade;
            r.hit(f, { i, x, y: BASE_HEIGHT / 2, size, rim: k === RIM, strong, hitAt: NaN });
            f.ctx.restore();
          });
        } else {
          const e = t - hitAt;
          if (e >= HIT_FADE) continue;
          proxied.push(() => withGravity(f, x, e, L, () => r.hit(f, { i, x, y: BASE_HEIGHT / 2, size, rim: k === RIM, strong, hitAt })));
        }
      } else if (k === ROLL) {
        const end = ch.end[i];
        // DrawableDrumRoll fades out over 100 ms once it's over
        const fade = t > end ? 1 - (t - end) / 100 : 1;
        const x = pos(time);
        if (x > width + 200) continue;
        const strong = !!ch.strong[i];
        const height = BASE_HEIGHT * DEFAULT_SIZE * (strong ? STRONG_SCALE : 1);
        const tickSize = height * DEFAULT_SIZE * (strong ? STRONG_SCALE : 1);
        // the colour: each tick hit takes it a fifth of the way to engaged, each one missed a
        // fifth back (DrawableDrumRoll's rolling hits, 0 to 5), faded over 100 ms per change
        const from = ch.tickFrom[i];
        const to = ch.tickTo[i];
        let rolling = 0;
        let before = 0;
        let changed = -Infinity;
        for (let j = from; j < to && ch.ticks[j] <= t + 1000; j++) {
          const hitAt = ch.tickAt[j];
          const at = Number.isNaN(hitAt) ? ch.tickMissAt[j] : hitAt;
          if (!(at <= t)) continue;
          const next = Math.max(0, Math.min(5, rolling + (Number.isNaN(hitAt) ? -1 : 1)));
          if (next !== rolling) {
            before = rolling;
            rolling = next;
            changed = at;
          }
        }
        const engaged = (before + (rolling - before) * Math.min(1, (t - changed) / 100)) / 5;
        const len = span(time, end);
        if (fade > 0) {
          masked.push(() => {
            f.ctx.save();
            f.ctx.globalAlpha *= fade;
            r.roll(f, { i, x, y: BASE_HEIGHT / 2, length: len, height, strong, engaged });
            for (let j = to - 1; j >= from; j--) {
              const tickTime = ch.ticks[j];
              const tx = x + span(time, tickTime) - span(time, time);
              const tickAt = ch.tickAt[j];
              const tickHit = t >= tickAt;
              // DrawableDrumRollTick: a hit tick grows and fades out in 200 ms
              if (tickHit && t - tickAt >= 200) continue;
              const tickFade = hiddenFade(tickTime);
              if (tickFade <= 0) continue;
              f.ctx.save();
              f.ctx.globalAlpha *= tickFade;
              r.tick(f, { x: tx, y: BASE_HEIGHT / 2, size: tickSize, first: j === from, strong, hitAt: tickHit ? tickAt : NaN });
              f.ctx.restore();
            }
            f.ctx.restore();
          });
        }
        // every tick hit sends up a small note in the colour of the key that hit it
        for (let j = from; j < to; j++) {
          const tickTime = ch.ticks[j];
          if (tickTime > t + 1000) break;
          const tickAt = ch.tickAt[j];
          if (!(tickAt <= t)) continue;
          const e = t - tickAt;
          if (e >= HIT_FADE) continue;
          const fx = pos(tickTime);
          const size = BASE_HEIGHT * DEFAULT_SIZE * (strong ? STRONG_SCALE : 1);
          const rim = !!ch.tickRim[j];
          flying.push(() => withGravity(f, fx, e, L, () => r.hit(f, { i: -1, x: fx, y: BASE_HEIGHT / 2, size, rim, strong, hitAt: tickAt })));
        }
      } else if (k === SWELL) {
        const judgedAt = ch.judged[i];
        const cleared = ch.swellHits(i, judgedAt) >= ch.hits[i];
        // DrawableSwell: gone 660 ms after a clear, 300 ms after a miss
        if (t >= judgedAt + (cleared ? 660 : 300)) continue;
        // it stops at the hit target
        const x = Math.max(HIT_X, pos(time));
        const size = BASE_HEIGHT * DEFAULT_SIZE;
        if (x - size / 2 > width) continue;
        const piece: SwellPiece = {
          i,
          x,
          y: BASE_HEIGHT / 2,
          size,
          hits: ch.swellHits(i, t),
          required: ch.hits[i],
          start: time,
          end: ch.end[i],
          judgedAt,
          cleared,
        };
        // from 100 ms before it starts it's drawn above the drum
        (t >= time - 100 ? proxied : masked).push(() => r.swell(f, piece));
      }
    }

    // earlier objects over later ones
    ctx.save();
    ctx.beginPath();
    ctx.rect(INPUT_DRUM_WIDTH, -f.top, width - INPUT_DRUM_WIDTH, f.canvasHeight);
    ctx.clip();
    for (let j = masked.length - 1; j >= 0; j--) masked[j]();
    ctx.restore();

    ctx.save();
    for (const e of events) r.kiaiExplosion?.(f, e);
    for (const e of events) r.judgement?.(f, e);
    ctx.restore();

    for (const p of proxied) p();
    for (const p of flying) p();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // TaikoFlashlight, over everything (its place is in units from the canvas's top left)
    if (this.light) drawCircleLight(ctx, bw, bh, dpr * scale * FL_POSITION, dpr * scale * FL_POSITION, this.light.at(t) * dpr * scale, FL_SMOOTHNESS);
  }
}

/** DrawableHit's hit transforms around the note's centre: up, then down, shrinking and fading. */
function withGravity(f: TaikoFrame, x: number, e: number, length: number, draw: () => void): void {
  const ctx = f.ctx;
  let y: number;
  if (e < length) {
    const p = e / length;
    y = -GRAVITY_HEIGHT * p * (2 - p);
  } else {
    const p = Math.min(1, (e - length) / (length * 2));
    y = -GRAVITY_HEIGHT + GRAVITY_HEIGHT * 3 * p * p;
  }
  const sp = Math.min(1, e / (length * 2));
  const s = 1 - 0.2 * sp * (2 - sp);
  const alpha = 1 - e / HIT_FADE;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x, BASE_HEIGHT / 2 + y);
  ctx.scale(s, s);
  ctx.translate(-x, -BASE_HEIGHT / 2);
  draw();
  ctx.restore();
}
