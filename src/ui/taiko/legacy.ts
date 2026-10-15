/* legacy.ts — an osu!stable-style skin on the osu!taiko playfield, as lazer's
 * TaikoLegacySkinTransformer draws it (MIT, ppy Pty Ltd). Textures come from the skin, then from
 * lazer's "classic" skin (lazer's fallback for whatever a legacy skin leaves out):
 *
 *  - LegacyTaikoScroller (taiko-slider above the strip), TaikoLegacyPlayfieldBackgroundRight
 *    (taiko-bar-right, its kiai glow), LegacyInputDrum (taiko-bar-left, drum halves lit on
 *    presses), DrawableTaikoMascot (pippidon: idle / kiai on the beat, fail after a miss, clear
 *    every 50 combo);
 *  - LegacyKiaiGlow, TaikoLegacyHitTarget, LegacyHitExplosion (taiko-hit300 / 100 / 0, the "k"
 *    sprite once a strong note's second key lands; judgements stay hidden), LegacyBarLine;
 *  - LegacyHit / LegacyCirclePiece (taikohitcircle / taikobigcircle tinted, the overlay on top,
 *    flashing on kiai beats), LegacyDrumRoll, sliderscorepoint ticks, LegacySwell.
 */
import { frameAt, preload, tex, TextureChain, type Anim, type LoadedSkin, type TexRef } from "../../lib/skin/skins";
import { ease, fromBytes, tinted, tween, type Colour } from "../mania/draw";
import { BASE_HEIGHT, HIT_X, INPUT_DRUM_WIDTH, KEYS, LEFT_CENTRE, LEFT_RIM, RIGHT_CENTRE, RIGHT_RIM, ROLL, SWELL, upper, type TaikoChart } from "./chart";
import type { HitEvent, HitPiece, RollPiece, SwellPiece, TaikoFrame, TaikoRenderer, TickPiece } from "./playfield";
import { C } from "./triangles";

/** LegacySkin.STABLE_MAGIC_SCALE_FACTOR */
const STABLE_RATIO = 1.6;
/** TaikoLegacyHitTarget.SCALE */
const TARGET_SCALE = 0.8;
/** LegacyCirclePiece */
const CIRCLE_PIECE_SIZE = 128;
const MAX_CIRCLE_SPRITE = 160;
const CENTRE_COLOUR = fromBytes([235, 69, 44, 255]);
const RIM_COLOUR = fromBytes([67, 142, 172, 255]);
const KIAI_GLOW_COLOUR = fromBytes([255, 228, 0, 255]);
/** LegacySwell */
const SWELL_DISPLAY: [number, number] = [250, 100];
const CLEAR_FRAMES = [0, 1, 2, 3, 4, 5, 6, 5, 6, 5, 4, 3, 2, 1, 0];

type Img = NonNullable<ReturnType<typeof tex>>;

/** LegacyColourCompatibility.DisallowZeroAlpha */
const visible = (c: Colour): Colour => (c[3] === 0 ? [c[0], c[1], c[2], 1] : c);

interface Mascot {
  idle: TexRef[];
  kiai: TexRef[];
  fail: TexRef[];
  clear: TexRef[];
}

export class LegacyTaikoRenderer implements TaikoRenderer {
  private readonly chain: TextureChain;
  private readonly version: number;
  private readonly t: Record<string, TexRef | null> = {};
  private hitCircle: Record<"normal" | "big", { circle: Anim | null; overlay: Anim | null }> = { normal: { circle: null, overlay: null }, big: { circle: null, overlay: null } };
  /** per result (Great, Ok, Miss): taiko-hit300 / 100 / 0, and the strong ("k") ones */
  private hitAnim: [Anim | null, Anim | null, Anim | null] = [null, null, null];
  private hitAnimStrong: [Anim | null, Anim | null, Anim | null] = [null, null, null];
  private mascotFrames: Mascot = { idle: [], kiai: [], fail: [], clear: [] };
  private digits: (TexRef | null)[] = [];
  private scoreOverlap = 0;
  /** combo-affecting judgements' times (hits, cleared swells), and when pippidon cheers */
  private clears: number[] = [];
  private clearsFor: TaikoChart | null = null;
  private clearsVersion = -1;

  private constructor(skin: LoadedSkin) {
    this.chain = new TextureChain(skin.chain);
    this.version = skin.own?.version ?? 2.7;
    const ini = skin.own?.ini?.config;
    const prefix = ini?.get("ScorePrefix") ?? "score";
    this.scoreOverlap = Number.parseFloat(ini?.get("ScoreOverlap") ?? "0") || 0;
    this.digits = Array.from({ length: 10 }, (_, i) => this.chain.texture(`${prefix}-${i}`));
  }

  static async create(skin: LoadedSkin): Promise<LegacyTaikoRenderer> {
    const r = new LegacyTaikoRenderer(skin);
    const c = r.chain;
    for (const name of [
      "taiko-slider",
      "taiko-bar-right",
      "taiko-bar-right-glow",
      "taiko-bar-left",
      "taiko-drum-inner",
      "taiko-drum-outer",
      "taiko-glow",
      "approachcircle",
      "taikobigcircle",
      "taiko-barline",
      "taiko-roll-middle",
      "taiko-roll-end",
      "sliderscorepoint",
      "spinner-warning",
      "spinner-circle",
      "spinner-approachcircle",
      "spinner-osu",
    ]) {
      r.t[name] = c.texture(name);
    }
    // LegacyCirclePiece: "taikobig…" for strong notes, else (and as fallback) "taikohit…"
    const circle = (lookup: string, animatable: boolean, big: boolean) =>
      (big ? c.animation(`taikobig${lookup}`, animatable, false) : null) ?? c.animation(`taikohit${lookup}`, animatable, false);
    r.hitCircle = {
      normal: { circle: circle("circle", false, false), overlay: circle("circleoverlay", true, false) },
      big: { circle: circle("circle", false, true), overlay: circle("circleoverlay", true, true) },
    };
    r.hitAnim = [c.animation("taiko-hit300", true, false), c.animation("taiko-hit100", true, false), c.animation("taiko-hit0", true, false)];
    r.hitAnimStrong = [r.hitAnim[0] ? c.animation("taiko-hit300k", true, false) : null, r.hitAnim[1] ? c.animation("taiko-hit100k", true, false) : null, null];
    // pippidon: each state from the first skin that has it
    const frames = (state: string, order?: number[]): TexRef[] => {
      const source = skin.chain.find((s) => s.texture(`pippidon${state}0`) ?? s.texture(`pippidon${state}`));
      if (!source) return [];
      const at = (i: number) => source.texture(`pippidon${state}${i}`) ?? (i === 0 ? source.texture(`pippidon${state}`) : null);
      const out: TexRef[] = [];
      for (const i of order ?? Array.from({ length: 64 }, (_, k) => k)) {
        const f = at(i);
        if (!f) break;
        out.push(f);
      }
      return out;
    };
    r.mascotFrames = { idle: frames("idle"), kiai: frames("kiai"), fail: frames("fail"), clear: frames("clear", CLEAR_FRAMES) };
    const anims = [r.hitCircle.normal.circle, r.hitCircle.normal.overlay, r.hitCircle.big.circle, r.hitCircle.big.overlay, ...r.hitAnim, ...r.hitAnimStrong];
    const m = r.mascotFrames;
    await preload([...Object.values(r.t), ...anims, ...m.idle, ...m.kiai, ...m.fail, ...m.clear, ...r.digits]);
    return r;
  }

  // ── the playfield ─────────────────────────────────────────────────────

  scroller(f: TaikoFrame): void {
    // LegacyTaikoScroller: from the top of the screen to a 20th into the strip, the slider
    // texture tiled and scrolling left at 0.1 units / ms of the game's 768-unit screen
    const img = tex(this.t["taiko-slider"]);
    if (!img) return;
    const top = -f.top;
    const h = f.top + BASE_HEIGHT / 20;
    const w = (img.w / img.h) * h;
    if (w <= 0) return;
    const speed = (0.1 * f.canvasHeight) / 768;
    let x = -((f.t * speed) % w);
    if (x > 0) x -= w;
    for (; x < f.width; x += w) f.ctx.drawImage(img.img, x, top, w, h);
  }

  backgroundRight(f: TaikoFrame): void {
    const ctx = f.ctx;
    const bar = tex(this.t["taiko-bar-right"]);
    if (bar) ctx.drawImage(bar.img, 0, 0, f.width, BASE_HEIGHT);
    // the kiai glow fades in and out over 200 ms
    const glow = tex(this.t["taiko-bar-right-glow"]);
    const a = kiaiRamp(f.chart, f.t, 200 * f.rate, 200 * f.rate);
    if (glow && a > 0) {
      ctx.save();
      ctx.globalAlpha = a;
      ctx.drawImage(glow.img, 0, 0, f.width, BASE_HEIGHT);
      ctx.restore();
    }
  }

  backgroundLeft(): void {}

  drum(f: TaikoFrame): void {
    const ctx = f.ctx;
    const bar = tex(this.t["taiko-bar-left"]);
    if (bar) ctx.drawImage(bar.img, 0, 0, bar.w, bar.h);
    const inner = tex(this.t["taiko-drum-inner"]);
    const outer = tex(this.t["taiko-drum-outer"]);
    // stable's positions (skins before 2.1 have their drum offset)
    const adjust = INPUT_DRUM_WIDTH / STABLE_RATIO;
    const modern = this.version >= 2.1;
    const pos = {
      leftCentre: modern ? [0, 0] : [18 * STABLE_RATIO, 31 * STABLE_RATIO],
      rightCentre: modern ? [(adjust - 56) * STABLE_RATIO, 0] : [(adjust - 54) * STABLE_RATIO, 31 * STABLE_RATIO],
      leftRim: modern ? [0, 0] : [8 * STABLE_RATIO, 23 * STABLE_RATIO],
      rightRim: modern ? [(adjust - 56) * STABLE_RATIO, 0] : [(adjust - 53) * STABLE_RATIO, 23 * STABLE_RATIO],
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, INPUT_DRUM_WIDTH, BASE_HEIGHT);
    ctx.clip();
    const part = (img: Img | null, key: number, x: number, y: number, mirror: boolean) => {
      const a = legacyPress(f.chart, key, f.t, f.rate);
      if (!img || a <= 0) return;
      ctx.save();
      ctx.globalAlpha = a;
      if (mirror) {
        ctx.translate(x + img.w, y);
        ctx.scale(-1, 1);
        ctx.drawImage(img.img, 0, 0, img.w, img.h);
      } else ctx.drawImage(img.img, x, y, img.w, img.h);
      ctx.restore();
    };
    // the left half as placed; the right half is the left one's layout mirrored across the drum
    const W = INPUT_DRUM_WIDTH;
    if (outer) part(outer, LEFT_RIM, pos.leftRim[0] + 0, pos.leftRim[1], true);
    if (inner) part(inner, LEFT_CENTRE, pos.leftCentre[0], pos.leftCentre[1], false);
    if (outer) part(outer, RIGHT_RIM, W - (pos.rightRim[0] + 0), pos.rightRim[1], false);
    if (inner) part(inner, RIGHT_CENTRE, W - pos.rightCentre[0], pos.rightCentre[1], true);
    ctx.restore();
  }

  mascot(f: TaikoFrame): void {
    const m = this.mascotFrames;
    const t = f.t;
    this.prepareClears(f.chart);
    // a cheer runs its 15 frames at 10 per second
    const k = upper(this.clears, t) - 1;
    let frame: TexRef | undefined;
    if (k >= 0 && m.clear.length) {
      const e = (t - this.clears[k]) / f.rate;
      const i = Math.floor(e / 100);
      if (i < m.clear.length) frame = m.clear[i];
    }
    if (!frame) {
      // after a miss it fails until the next hit
      const list = f.chart.missedLast(t) && m.fail.length ? m.fail : f.chart.inKiai(t) && m.kiai.length ? m.kiai : m.idle;
      if (!list.length) return;
      // one frame per beat
      const beat = f.chart.beatAt(t);
      frame = list[beat ? ((beat.index % list.length) + list.length) % list.length : 0];
    }
    const img = tex(frame);
    if (!img) return;
    const w = img.w * 0.6;
    const h = img.h * 0.6;
    f.ctx.drawImage(img.img, 0, BASE_HEIGHT * 0.2 - h, w, h);
  }

  kiaiGlow(f: TaikoFrame): void {
    const img = tex(this.t["taiko-glow"]);
    if (!img) return;
    // in over 100 ms, out over 600; a kiai hit bumps it to 0.95 and back in 80 ms
    const a = kiaiRamp(f.chart, f.t, 100 * f.rate, 600 * f.rate);
    if (a <= 0) return;
    let scale = TARGET_SCALE;
    const last = upper(f.chart.hitTimes, f.t) - 1;
    if (last >= 0 && f.chart.inKiai(f.chart.hitTimes[last])) {
      scale = tween((f.t - f.chart.hitTimes[last]) / f.rate, TARGET_SCALE + 0.15, TARGET_SCALE, 80, ease.out);
    }
    const ctx = f.ctx;
    ctx.save();
    ctx.globalAlpha = a;
    const w = img.w * scale;
    const h = img.h * scale;
    ctx.drawImage(tinted(img.img, this.t["taiko-glow"]!.url, KIAI_GLOW_COLOUR), HIT_X - w / 2, BASE_HEIGHT / 2 - h / 2, w, h);
    ctx.restore();
  }

  explosion(f: TaikoFrame, e: HitEvent): void {
    // LegacyHitExplosion: in over 120 ms, out over 180; a single sprite pops 0.6 → 1.1 → 0.9 → 1;
    // a strong note's second key crossfades to the "k" sprite in 50 ms
    const anim = this.hitAnim[e.result];
    if (!anim) return;
    const el = (f.t - e.at) / f.rate;
    if (el < 0 || el >= 300) return;
    const alpha = el < 120 ? el / 120 : 1 - (el - 120) / 180;
    let scale = 1;
    if (anim.frames.length <= 1) {
      if (el < 96) scale = tween(el, 0.6, 1.1, 96);
      else if (el < 144) scale = tween(el - 96, 1.1, 0.9, 48);
      else scale = tween(el - 144, 0.9, 1, 24);
    }
    const strong = this.hitAnimStrong[e.result];
    const k = strong && !Number.isNaN(e.strongAt) ? ease.outQuint(Math.min(1, (f.t - e.strongAt) / f.rate / 50)) : 0;
    const ctx = f.ctx;
    const draw = (a: Anim, opacity: number) => {
      const img = tex(frameAt(a, el));
      if (!img || opacity <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha * opacity;
      const w = img.w * scale;
      const h = img.h * scale;
      ctx.drawImage(img.img, HIT_X - w / 2, BASE_HEIGHT / 2 - h / 2, w, h);
      ctx.restore();
    };
    draw(anim, 1 - k);
    if (strong) draw(strong, k);
  }

  hitTarget(f: TaikoFrame): void {
    const ctx = f.ctx;
    const sprite = (ref: TexRef | null, scale: number, alpha: number) => {
      const img = tex(ref);
      if (!img) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const w = img.w * scale;
      const h = img.h * scale;
      ctx.drawImage(img.img, HIT_X - w / 2, BASE_HEIGHT / 2 - h / 2, w, h);
      ctx.restore();
    };
    sprite(this.t["approachcircle"], TARGET_SCALE + 0.03, 0.47);
    sprite(this.t["taikobigcircle"], TARGET_SCALE, 0.22);
  }

  barLine(f: TaikoFrame, x: number): void {
    const img = tex(this.t["taiko-barline"]);
    if (!img) return;
    // 2 units wide and 88% of the strip, filled keeping the texture's shape
    const boxW = 2;
    const boxH = BASE_HEIGHT * 0.88;
    const s = Math.max(boxW / img.w, boxH / img.h);
    const w = img.w * s;
    const h = img.h * s;
    f.ctx.drawImage(img.img, x - w / 2, BASE_HEIGHT / 2 - h / 2, w, h);
  }

  // ── objects ───────────────────────────────────────────────────────────

  hit(f: TaikoFrame, h: HitPiece): void {
    this.circle(f, h.x, h.y, h.size, h.strong, h.rim ? RIM_COLOUR : CENTRE_COLOUR, h.i);
  }

  roll(f: TaikoFrame, r: RollPiece): void {
    const ctx = f.ctx;
    // the accent, YellowDark → YellowDarker as the roll is played
    const accent = visible(mixColour(C.yellowDark, C.yellowDarker, r.engaged));
    const body = tex(this.t["taiko-roll-middle"]);
    const end = tex(this.t["taiko-roll-end"]);
    const top = r.y - r.height / 2;
    if (body && r.length > 0) ctx.drawImage(tinted(body.img, this.t["taiko-roll-middle"]!.url, accent), r.x, top, r.length, r.height);
    if (end) {
      // fitted to the body's height, right after it
      const w = (end.w / end.h) * r.height;
      ctx.drawImage(tinted(end.img, this.t["taiko-roll-end"]!.url, accent), r.x + r.length, top, w, r.height);
    }
    // the head: a hit circle in the roll's colour
    this.circle(f, r.x, r.y, r.height, r.strong, accent, r.i);
  }

  tick(f: TaikoFrame, k: TickPiece): void {
    const img = tex(this.t["sliderscorepoint"]);
    if (!img) return;
    let scale = 1;
    let alpha = 1;
    if (!Number.isNaN(k.hitAt)) {
      const e = (f.t - k.hitAt) / f.rate;
      scale = tween(e, 1, 1.4, 200, ease.outQuint);
      alpha = 1 - ease.outQuint(Math.min(1, e / 200));
    }
    if (alpha <= 0) return;
    const ctx = f.ctx;
    ctx.save();
    ctx.globalAlpha *= alpha;
    const w = img.w * scale;
    const h = img.h * scale;
    ctx.drawImage(img.img, k.x - w / 2, k.y - h / 2, w, h);
    ctx.restore();
  }

  swell(f: TaikoFrame, s: SwellPiece): void {
    const ctx = f.ctx;
    const t = f.t;
    const el = (t - s.start) / f.rate;
    const warning = tex(this.t["spinner-warning"]);
    const [dx, dy] = SWELL_DISPLAY;
    // the warning rides in on the swell, then flies to the display spot, growing to 3×, gone in 200 ms
    if (warning && el < 200) {
      const base = this.t["spinner-warning"] ? 1 : 0.18;
      const p = Math.max(0, el) / 200;
      const x = s.x + dx * Math.min(1, p);
      const y = s.y + dy * Math.min(1, p);
      const sc = el <= 0 ? base : tween(el, base, 3, 200, ease.out);
      ctx.save();
      ctx.globalAlpha *= el <= 0 ? 1 : 1 - p;
      const w = warning.w * sc;
      const h = warning.h * sc;
      ctx.drawImage(warning.img, x - w / 2, y - h / 2, w, h);
      ctx.restore();
    }
    if (el < 0) return;
    const cx = s.x + dx;
    const cy = s.y + dy;
    const presses = f.chart.swellPressTimes(s.i).filter((p) => p <= t).slice(0, Math.max(1, s.required));
    const out = t >= s.judgedAt ? (t - s.judgedAt) / f.rate : -1;
    // the body: in over 200 ms, out over 300 once judged
    let bodyAlpha = Math.min(1, el / 200);
    if (out >= 0) bodyAlpha *= 1 - ease.out(Math.min(1, out / 300));
    if (bodyAlpha > 0) {
      ctx.save();
      ctx.globalAlpha *= bodyAlpha;
      // the spinner circle: turning half a turn per hit, pulsing out a little with each one
      const circle = tex(this.t["spinner-circle"]);
      if (circle) {
        let rotation = 0;
        let scale = 0.8;
        for (const p of presses) {
          const e = (t - p) / f.rate;
          rotation += 180 * (1 - 2 ** (-e / 130));
          scale += 0.02 * 2 ** (-e / 120);
        }
        scale = Math.min(0.94, scale);
        if (out >= 0) scale += tween(out, 0, 0.05, 300, ease.out);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(circle.img, (-circle.w * scale) / 2, (-circle.h * scale) / 2, circle.w * scale, circle.h * scale);
        ctx.restore();
      }
      // the approach circle shrinks to nothing over the swell
      const approach = tex(this.t["spinner-approachcircle"]);
      if (approach) {
        const p = Math.min(1, el / Math.max(1, (s.end - s.start) / f.rate));
        const w = (approach.w + (0.08 - approach.w) * p) * 1.86 * 0.8;
        const h = (approach.h + (0.08 - approach.h) * p) * 1.86 * 0.8;
        ctx.save();
        ctx.globalAlpha *= 0.8;
        ctx.drawImage(approach.img, cx - w / 2, cy - h / 2, w, h);
        ctx.restore();
      }
      // hits left, in the skin's score font, growing as they run out
      const left = Math.max(0, s.required - presses.length);
      this.number(ctx, String(left), cx, cy + 130, 1.6 - 0.6 * (left / Math.max(1, s.required)));
      ctx.restore();
    }
    // cleared: "spinner-osu" pops up and away
    const clear = tex(this.t["spinner-osu"]);
    if (clear && s.cleared && out >= 0 && out < 660) {
      const y = cy - 40 + tween(out, 0, -90 * (768 / 480), 240, ease.out);
      const sc = tween(out, 0.4, 1, 240, ease.out);
      const a = out < 360 ? 1 : 1 - (out - 360) / 300;
      if (a > 0) {
        ctx.save();
        ctx.globalAlpha *= a;
        ctx.drawImage(clear.img, cx - (clear.w * sc) / 2, y - (clear.h * sc) / 2, clear.w * sc, clear.h * sc);
        ctx.restore();
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * LegacyCirclePiece: the circle (tinted, with an additive copy flashing on kiai beats) and its
   * overlay, scaled so 128 texture units fill the piece. The overlay's two frames alternate with
   * the beat from 50 combo (twice as fast from 150).
   */
  private circle(f: TaikoFrame, x: number, y: number, size: number, strong: boolean, accent: Colour, i: number): void {
    const ctx = f.ctx;
    const set = strong ? this.hitCircle.big : this.hitCircle.normal;
    const scale = size / CIRCLE_PIECE_SIZE;
    const draw = (img: Img, url: string, colour: Colour | null) => {
      const fit = Math.min(1, MAX_CIRCLE_SPRITE / Math.max(img.w, img.h));
      const w = img.w * fit * scale;
      const h = img.h * fit * scale;
      ctx.drawImage(colour ? tinted(img.img, url, colour) : img.img, x - w / 2, y - h / 2, w, h);
    };
    const base = set.circle?.frames[0];
    const baseImg = tex(base);
    if (base && baseImg) {
      draw(baseImg, base.url, visible(accent));
      // kiai: an additive copy at 30% on every beat, out over the beat (OutSine)
      const beat = f.chart.beatAt(f.t);
      if (beat && f.chart.inKiai(beat.time)) {
        const e = f.t - beat.time;
        const a = 0.3 * (1 - ease.outSine(Math.min(1, e / Math.max(80, beat.length - 80))));
        if (a > 0) {
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha *= a;
          draw(baseImg, base.url, visible(accent));
          ctx.restore();
        }
      }
    }
    const overlay = set.overlay;
    if (overlay) {
      let frame = 0;
      if (overlay.frames.length > 1) {
        const combo = f.chart.combo(f.t);
        const multiplier = combo >= 150 ? 2 : combo >= 50 ? 1 : 0;
        const beat = multiplier ? f.chart.beatAt(i >= 0 ? f.chart.time[i] : f.t) : null;
        if (beat && multiplier) {
          const start = beat.time - beat.index * beat.length;
          frame = Math.abs(f.t - start) % ((beat.length * 2) / multiplier) >= beat.length / multiplier ? 0 : 1;
        }
      }
      const ref = overlay.frames[Math.min(frame, overlay.frames.length - 1)];
      const img = tex(ref);
      if (img) draw(img, ref.url, null);
    }
  }

  /** LegacySpriteText in the score font, centred on (x, y). */
  private number(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, scale: number): void {
    const imgs = [...text].map((d) => tex(this.digits[Number(d)]));
    if (imgs.some((i) => !i)) return;
    const list = imgs as Img[];
    const width = list.reduce((w, i) => w + i.w, 0) - this.scoreOverlap * (list.length - 1);
    const h = Math.max(...list.map((i) => i.h));
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    let cx = -width / 2;
    for (const i of list) {
      ctx.drawImage(i.img, cx, -h / 2, i.w, i.h);
      cx += i.w - this.scoreOverlap;
    }
    ctx.restore();
  }

  /** When pippidon cheers: every 50th combo-affecting hit, and every cleared swell. */
  private prepareClears(ch: TaikoChart): void {
    if (this.clearsFor === ch && this.clearsVersion === ch.version) return;
    // [time, a cleared swell, a miss]
    const judged: [number, boolean, boolean][] = [];
    for (let i = 0; i < ch.n; i++) {
      const k = ch.kind[i];
      if (k === ROLL) continue;
      if (k === SWELL) {
        if (ch.swellHits(i, ch.judged[i]) >= ch.hits[i]) judged.push([ch.judged[i], true, false]);
      } else if (!Number.isNaN(ch.hitAt[i])) judged.push([ch.hitAt[i], false, false]);
      else if (!Number.isNaN(ch.missAt[i])) judged.push([ch.missAt[i], false, true]);
    }
    judged.sort((a, b) => a[0] - b[0]);
    const out: number[] = [];
    let combo = 0;
    for (const [time, swell, miss] of judged) {
      combo = miss ? 0 : combo + 1;
      if (swell || (!miss && combo % 50 === 0)) out.push(time);
    }
    this.clears = out;
    this.clearsFor = ch;
    this.clearsVersion = ch.version;
  }
}

const mixColour = (a: Colour, b: Colour, t: number): Colour => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];

/**
 * A legacy drum part's alpha: a press lights it to full over 80 ms × (how far from full it
 * was), it holds until 100 ms after the press, then goes out over 50 ms.
 */
function legacyPress(ch: TaikoChart, key: number, t: number, rate: number): number {
  const k = KEYS.indexOf(key as (typeof KEYS)[number]);
  const presses = ch.keyPresses[k];
  const at = (i: number, time: number, depth: number): number => {
    if (i < 0) return 0;
    const e = (time - presses[i]) / rate;
    const from = depth > 0 ? at(i - 1, presses[i], depth - 1) : 0;
    const d = 80 * (1 - from);
    if (e < d) return from + (1 - from) * ease.out(e / d);
    if (e < 100) return 1;
    if (e < 150) return 1 - (e - 100) / 50;
    return 0;
  };
  return at(ch.lastPress(k, t), t, 2);
}

/** A kiai-following alpha: up over `up` ms once kiai starts, down over `down` once it ends. */
function kiaiRamp(ch: TaikoChart, t: number, up: number, down: number): number {
  const k = ch.kiaiRanges;
  for (let i = 0; i < k.length; i += 2) {
    const [s, e] = [k[i], k[i + 1]];
    if (t >= s && t < e) return Math.min(1, (t - s) / up);
    if (t >= e && t < e + down) return Math.max(0, Math.min(1, (e - s) / up) - (t - e) / down);
  }
  return 0;
}

