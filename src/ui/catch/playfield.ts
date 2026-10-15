/* playfield.ts — the osu!catch playfield in a lazer skin, laid out and timed the way lazer does it
 * (MIT, ppy Pty Ltd):
 *
 *  - CatchPlayfieldAdjustmentContainer: 0.8 of a 4:3 area (smaller on wider screens), objects
 *    falling from 100 osu!pixels above it to the catcher at 340, over the AR's time range;
 *  - DrawableFruit / Droplet / TinyDroplet / Banana: a fruit tilted at random, droplets turning,
 *    bananas shrinking and turning as they fall; caught, they vanish; missed, they fall on past
 *    the catcher, fading;
 *  - Catcher: autoplay's catcher or a replay's (lib/catch-replay), facing the way it moves, red
 *    while hyperdashing, failing after a miss; caught fruits and bananas pile on its plate (half
 *    size) until the combo ends and they fly off (or fall off, the combo's last missed); droplets
 *    fly off right away; a hit explosion for every catch (hit lighting);
 *  - CatcherTrailDisplay: dashing leaves fading copies of the catcher every 16 ms (in the hyperdash
 *    colour while hyperdashing), a hyperdash an after-image that rises and grows;
 *  - CatchModHidden: objects fade out from 0.6 of their fall time before the catch over the next
 *    0.16, and nothing piles on the plate;
 *  - CatchModFlashlight: black but for a circle around the catcher, 203 osu!pixels across at first,
 *    smaller at 100 and 200 combo, bigger in breaks. (Easy, Hard Rock and Mirror come built into
 *    the chart.)
 *
 * Objects are drawn under the catcher, earlier ones over later ones. The skin renderers
 * (triangles.ts, argon.ts, legacy.ts) draw the pieces; this decides where and when.
 */
import type { CatchReplay } from "../../lib/catch-replay";
import type { Mod } from "../../lib/mods";
import type { ChartData } from "../../lib/types";
import { breakPeriods, Combo, drawCircleLight, FlashlightSize, type FlashlightSpec } from "../flashlight";
import { ease, tween, type Colour } from "../mania/draw";
import { BANANA, CAUGHT_SCALE, CATCHER_Y, CatchChart, catchWidth, DROPLET, FALL_HEIGHT, FRUIT, HEIGHT, OBJECT_RADIUS, PLATE_Y, TINY, upper, WIDTH } from "./chart";

/** CatchPlayfieldAdjustmentContainer.playfield_size_adjust */
const PLAYFIELD_SIZE = 0.8;
/** CatcherArea.trail_generation_interval */
const TRAIL_INTERVAL = 16;
/** CatcherTrail: dash trails fade from 0.4 over 800 ms, the after-image over 1200 ms */
const TRAIL_FADE = 800;
const TRAIL_ALPHA = 0.4;
const AFTER_IMAGE = 1200;
/** Catcher.applyDropAnimation (Explode) */
const EXPLODE_FADE = 750;
const EXPLODE_MOVE = 1000;
/** how long hit explosions can last (LegacyHitExplosion: 700 ms, then fading) */
const EXPLOSION_LIFE = 1400;
/** a missed object falls on, fading over this */
const MISS_FADE = 300;
/** Catcher.applyDropAnimation (Drop): falling 75 osu!pixels as it fades */
const DROP_FALL = 75;
/** CatchModHidden: shares of the fall time */
const HD_OFFSET = 0.6;
const HD_DURATION = 0.44;
/** CatchModFlashlight (osu!stable's sizes for osu!catch) */
const FLASHLIGHT: FlashlightSpec = {
  size: 203.125,
  breakScale: 1.538,
  comboScale: (combo) => (combo >= 200 ? 0.77 : combo >= 100 ? 0.885 : 1),
  speed: 1.154 / 1000,
};
const FL_SMOOTHNESS = 1.4;
/** Banana colours (Banana.getBananaColour) */
const BANANA_COLOURS: Colour[] = [
  [1, 240 / 255, 0, 1],
  [1, 192 / 255, 0, 1],
  [214 / 255, 221 / 255, 28 / 255, 1],
];

export type CatcherState = "idle" | "fail" | "kiai";

export interface CatchFrame {
  ctx: CanvasRenderingContext2D;
  /** song time, ms */
  t: number;
  chart: CatchChart;
  /** device pixels per osu!pixel at the playfield's scale (canvas doesn't scale blur radii) */
  px: number;
}

/** A fruit, droplet or banana, falling or on the plate. Drawn centred on (0, 0) in its own
 * 128 × 128 box (OBJECT_RADIUS × 2), already turned and scaled. */
export interface CatchPiece {
  i: number;
  kind: number;
  accent: Colour;
  /** a fruit's look: 0 pear, 1 grape, 2 pineapple, 3 raspberry (Fruit.GetVisualRepresentation) */
  visual: number;
  hyper: boolean;
  /** BorderPiece: shown until 500 ms before the catch */
  border: number;
  /** ms since it appeared (DisplayStartTime) and how long it falls */
  since: number;
  duration: number;
  /** degrees it's turned, and its drawn size over 128 (DisplaySize / 128) */
  rotation: number;
  size: number;
}

/** The catcher's body, drawn with (0, 0) at its top centre in its own units (BASE_SIZE across). */
export interface CatcherPiece {
  state: CatcherState;
  /** its colour (white, or the hyperdash colour) */
  colour: Colour;
  /** ms into its animation */
  elapsed: number;
}

/** A hit explosion, drawn in the catcher's space (origin at its top centre, not flipped). */
export interface ExplosionPiece {
  /** Position: where it was caught, from the catcher's centre */
  x: number;
  /** ms since the catch */
  since: number;
  accent: Colour;
  droplet: boolean;
  /** combo before the catch */
  combo: number;
  /** the object's random seed (its time as an int) */
  seed: number;
  /** HitObject.Scale */
  scale: number;
}

export interface CatchRenderer {
  /** the skin's combo colours (the beatmap's own win) */
  readonly comboColours: Colour[];
  /** CatchSkinColour.HyperDash and HyperDashAfterImage */
  readonly hyperColour: Colour;
  readonly afterImageColour: Colour;
  piece(f: CatchFrame, p: CatchPiece): void;
  catcher(f: CatchFrame, c: CatcherPiece): void;
  explosion(f: CatchFrame, e: ExplosionPiece): void;
}

export class CatchPlayfield {
  readonly chart: CatchChart;
  private hidden = false;
  private light: FlashlightSize | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly data: ChartData,
    private renderer: CatchRenderer,
  ) {
    this.chart = new CatchChart(data);
  }

  /** Plays a replay (judged), or autoplay again (null). */
  setPlay(r: CatchReplay | null): void {
    this.chart.setPlay(r ? r.frames : null, r ? r.caught : null);
  }

  setRenderer(r: CatchRenderer): void {
    this.renderer = r;
  }

  /** The mods it draws (Hidden, Flashlight). */
  setMods(mods: readonly Mod[]): void {
    this.hidden = mods.includes("HD");
    if (!mods.includes("FL")) this.light = null;
    else if (!this.light) {
      // fruits and droplets add to the combo; tiny droplets and bananas don't
      const ch = this.chart;
      const times: number[] = [];
      for (let i = 0; i < ch.n; i++) if (ch.kind[i] === FRUIT || ch.kind[i] === DROPLET) times.push(ch.time[i]);
      const combo = new Combo(times);
      this.light = new FlashlightSize(FLASHLIGHT, combo, breakPeriods(this.data, combo));
    }
  }

  /** PalpableCatchHitObject.GetComboColour (IndexInBeatmap + 1); bananas have their own. */
  private accent(i: number): Colour {
    const ch = this.chart;
    if (ch.kind[i] === BANANA) return BANANA_COLOURS[ch.bananaColour[i]];
    const idx = ch.index[i] + 1;
    if (ch.colours.length) {
      const c = ch.colours[idx % ch.colours.length];
      return [c[0] / 255, c[1] / 255, c[2] / 255, 1];
    }
    const skin = this.renderer.comboColours;
    return skin[idx % skin.length];
  }

  draw(t: number, rate: number): void {
    void rate;
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

    // CatchPlayfieldAdjustmentContainer: a 4:3 game area 0.8 of the height, scaled down to keep
    // its width on wider screens, a little below the middle
    const k = Math.min(1, 4 / 3 / (W / H));
    let s = (H * PLAYFIELD_SIZE * k) / HEIGHT;
    s = Math.min(s, (W * PLAYFIELD_SIZE) / WIDTH);
    const ox = (W - WIDTH * s) / 2;
    const oy = H / 2 - 0.35 * H * k;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

    const ch = this.chart;
    const f: CatchFrame = { ctx, t, chart: ch, px: dpr * s };
    const cs = ch.catcherScale;
    const cx = ch.catcherX(t);
    const plateY = CATCHER_Y + PLATE_Y * cs;

    // flying off the plate (Catcher.Explode): up and back down, outwards, fading; Hidden puts
    // nothing on the plate
    const from = upper(ch.time, t - EXPLODE_MOVE - 2000);
    const caught = upper(ch.time, t);
    for (let i = this.hidden ? caught : from; i < caught; i++) {
      const at = ch.clearAt[i];
      if (!ch.caught[i] || !(at <= t) || t - at >= EXPLODE_FADE) continue;
      const e = t - at;
      const x0 = ch.clearX[i] + ch.plateX[i];
      const y0 = plateY + ch.plateY[i];
      if (ch.dropped[i]) {
        // Drop: straight down, fading
        this.caughtPiece(f, i, x0, y0 + DROP_FALL * ease.inSine(e / EXPLODE_FADE), 1 - e / EXPLODE_FADE);
        continue;
      }
      const y = e < 250 ? y0 - 50 * ease.outSine(e / 250) : y0 - 50 + 50 * ease.inSine(Math.min(1, (e - 250) / 500));
      const x = x0 + (ch.plateX[i] / cs) * 6 * Math.min(1, e / EXPLODE_MOVE);
      this.caughtPiece(f, i, x, y, 1 - e / EXPLODE_FADE);
    }

    // on the plate: everything caught since the plate was last cleared (fruits and bananas)
    for (let i = this.hidden ? caught : from; i < caught; i++) {
      if (!ch.caught[i] || ch.clearAt[i] <= t || ch.kind[i] === DROPLET || ch.kind[i] === TINY) continue;
      this.caughtPiece(f, i, cx + ch.plateX[i], plateY + ch.plateY[i], 1);
    }
    // a plate can hold more than the window above; older ones are still there
    for (let i = this.hidden ? -1 : from - 1; i >= 0; i--) {
      if (ch.clearAt[i] <= t) {
        if (ch.lastInCombo[i]) break;
        continue;
      }
      if (ch.caught[i] && (ch.kind[i] === FRUIT || ch.kind[i] === BANANA)) this.caughtPiece(f, i, cx + ch.plateX[i], plateY + ch.plateY[i], 1);
    }

    // falling: later ones under earlier ones; missed ones falling on
    const preempt = ch.preempt;
    const last = upper(ch.time, t + preempt);
    for (let i = last - 1; i >= 0; i--) {
      const time = ch.time[i];
      if (t >= time && (ch.caught[i] || t - time >= MISS_FADE)) {
        if (t - time >= MISS_FADE + 1000) break;
        continue;
      }
      const y = CATCHER_Y - ((time - t) / preempt) * FALL_HEIGHT;
      const size = ch.scale * ch.pieceScale(i, t);
      let fade = this.hidden ? 1 - Math.min(1, Math.max(0, (t - (time - preempt * HD_OFFSET)) / (preempt * (HD_OFFSET - HD_DURATION)))) : 1;
      if (t >= time) fade *= 1 - ease.outQuint((t - time) / MISS_FADE);
      if (fade <= 0) continue;
      ctx.save();
      ctx.globalAlpha *= fade;
      ctx.translate(ch.x[i], y);
      ctx.rotate((ch.rotation(i, t) * Math.PI) / 180);
      ctx.scale(size, size);
      this.renderer.piece(f, this.state(i, t, size));
      ctx.restore();
    }

    this.catcher(f, cx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // CatchFlashlight: on the catcher, over everything
    if (this.light) drawCircleLight(ctx, bw, bh, dpr * (ox + cx * s), dpr * (oy + CATCHER_Y * s), this.light.at(t) * dpr * s, FL_SMOOTHNESS);
  }

  private state(i: number, t: number, size: number): CatchPiece {
    const ch = this.chart;
    const time = ch.time[i];
    return {
      i,
      kind: ch.kind[i],
      accent: this.accent(i),
      visual: ch.index[i] % 4,
      hyper: ch.hyper[i] === 1,
      border: Math.max(0, Math.min(1, (time - t) / 500)),
      since: t - (time - ch.preempt),
      duration: ch.preempt,
      rotation: ch.rotation(i, Math.min(t, time)),
      size,
    };
  }

  /** A caught object (CaughtObject): as it was when caught, at half its size. */
  private caughtPiece(f: CatchFrame, i: number, x: number, y: number, alpha: number): void {
    const ch = this.chart;
    const ctx = f.ctx;
    const time = ch.time[i];
    const size = ch.scale * ch.pieceScale(i, time) * CAUGHT_SCALE;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y);
    ctx.rotate((ch.rotation(i, time) * Math.PI) / 180);
    ctx.scale(size, size);
    this.renderer.piece(f, { ...this.state(i, f.t, size), border: 0 });
    ctx.restore();
  }

  /** The catcher, its explosions and its trails. */
  private catcher(f: CatchFrame, cx: number): void {
    const ch = this.chart;
    const r = this.renderer;
    const ctx = f.ctx;
    const t = f.t;
    const cs = ch.catcherScale;
    const stateAt = (time: number): CatcherState => ch.stateAt(time);
    const body = (x: number, dir: number, scale: number, c: CatcherPiece) => {
      ctx.save();
      ctx.translate(x, CATCHER_Y);
      ctx.scale(scale * dir, scale);
      r.catcher(f, c);
      ctx.restore();
    };

    // the catcher, turning the hyperdash colour
    const tint = ch.hyperTint(t);
    const colour: Colour = [1 + (r.hyperColour[0] - 1) * tint, 1 + (r.hyperColour[1] - 1) * tint, 1 + (r.hyperColour[2] - 1) * tint, 1];
    body(cx, ch.direction(t), cs, { state: stateAt(t), colour, elapsed: t });

    // hit explosions, in the catcher's space
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = upper(ch.time, t - EXPLOSION_LIFE); i < ch.n && ch.time[i] <= t; i++) {
      if (!ch.caught[i]) continue;
      ctx.save();
      ctx.translate(cx, CATCHER_Y);
      ctx.scale(cs, cs);
      r.explosion(f, {
        x: ch.plateX[i],
        since: t - ch.time[i],
        accent: this.accent(i),
        droplet: ch.kind[i] === DROPLET || ch.kind[i] === TINY,
        combo: ch.combo[i],
        seed: Math.trunc(ch.time[i]) | 0,
        scale: ch.scale,
      });
      ctx.restore();
    }

    // trails: every 16 ms while dashing or hyperdashing
    for (let tau = Math.ceil((t - TRAIL_FADE) / TRAIL_INTERVAL) * TRAIL_INTERVAL; tau <= t; tau += TRAIL_INTERVAL) {
      const hyper = ch.hyperAt(tau) >= 0;
      if (!hyper && !ch.dashing(tau)) continue;
      const a = TRAIL_ALPHA * (1 - ease.outQuint(Math.min(1, (t - tau) / TRAIL_FADE)));
      if (a <= 0.003) continue;
      ctx.globalAlpha = a;
      body(ch.catcherX(tau), ch.direction(tau), cs, { state: stateAt(tau), colour: hyper ? r.hyperColour : [1, 1, 1, 1], elapsed: tau });
    }
    // after-images where hyperdashes begin: rising, growing, fading
    for (let k = upper(ch.hyperStart, t - AFTER_IMAGE); k < ch.hyperStart.length && ch.hyperStart[k] <= t; k++) {
      if (!ch.hyperBegins(k)) continue;
      const start = ch.hyperStart[k];
      const e = t - start;
      ctx.globalAlpha = 1 - e / AFTER_IMAGE;
      ctx.save();
      ctx.translate(0, -10 * ease.in(e / AFTER_IMAGE));
      body(ch.catcherX(start), ch.direction(start), cs * tween(e, 0.95, 1.2, AFTER_IMAGE, ease.in), { state: stateAt(start), colour: r.afterImageColour, elapsed: start });
      ctx.restore();
    }
    ctx.restore();
  }
}

/** The catch area of the catcher, in its own units (for skins that draw it). */
export const CATCH_AREA = catchWidth(1);
export { OBJECT_RADIUS };
