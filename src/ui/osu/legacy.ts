/* legacy.ts — an osu!stable-style skin on the osu! playfield, as lazer's OsuLegacySkinTransformer
 * draws it (MIT, ppy Pty Ltd). Textures come from the skin, then lazer's "classic" skin:
 *
 *  - LegacyMainCirclePiece: hitcircle tinted in the combo colour, hitcircleoverlay over it (and
 *    over the number unless the skin says otherwise), the number from the skin's font
 *    (HitCirclePrefix, 0.8×); slider heads and ends try sliderstartcircle / sliderendcircle
 *    first; hit: 1.4× and faded over 240 ms;
 *  - LegacySliderBody: a faint shadow, the border (SliderBorder) and the track (the combo colour
 *    or SliderTrackOverride, 0.7 opaque) lightening towards the middle;
 *  - LegacySliderBall (sliderb frames, sliderb-nd under, sliderb-spec over), LegacyFollowCircle,
 *    sliderscorepoint, LegacyReverseArrow, followpoint;
 *  - LegacyNewStyleSpinner (spinner-glow / bottom / top / middle2 / middle) or
 *    LegacyOldStyleSpinner (spinner-background / circle / metre), spinner-approachcircle,
 *    spinner-spin and spinner-clear;
 *  - LegacyCursor (cursor turning, cursormiddle) and LegacyCursorTrail.
 *
 * The beatmap's own colours (combo colours, SliderBorder, SliderTrackOverride) win over the skin's.
 */
import { frameAt, preload, tex, TextureChain, type Anim, type LoadedSkin, type TexRef } from "../../lib/skin/skins";
import { darken, ease, fromBytes, tween, WHITE, type Colour } from "../mania/draw";
import { STABLE_SCALE } from "../../lib/skin/ini";
import { OBJECT_RADIUS, type OsuChart } from "./chart";
import { size as texSize, sprite } from "./draw";
import { dimmed, type ApproachPiece, type BallPiece, type BodyStyle, type CirclePiece, type CursorPiece, type FollowPointPiece, type OsuFrame, type OsuRenderer, type RepeatPiece, type SpinnerPiece, type TickPiece, type TrailPart, type TrailStyle } from "./playfield";
import { DEFAULT_COMBO, drawTrailParts, type DefaultTextures } from "./triangles";

const SIZE = OBJECT_RADIUS * 2;
const MAX_CIRCLE: [number, number] = [SIZE * 2, SIZE * 2];
/** OsuLegacySkinTransformer.LEGACY_CIRCLE_RADIUS */
const LEGACY_RADIUS = OBJECT_RADIUS - 5;
/** LegacySpinner */
const SPRITE_SCALE = 0.625;
const SPINNER_TOP = 45 - 16;
const SPINNER_Y_CENTRE = SPINNER_TOP + 219;
const SIXTY_FRAME = 1000 / 60;

/** LegacyColourCompatibility.DisallowZeroAlpha */
const visible = (c: Colour): Colour => (c[3] === 0 ? [c[0], c[1], c[2], 1] : c);
const bytes = (c: [number, number, number] | [number, number, number, number]): Colour => fromBytes([c[0], c[1], c[2], c.length === 4 ? c[3] : 255]);

type Prefix = "hitcircle" | "sliderstartcircle" | "sliderendcircle";

export class LegacyOsuRenderer implements OsuRenderer {
  readonly comboColours: Colour[];
  trail: TrailStyle;
  private readonly chain: TextureChain;
  private readonly version: number;
  private readonly cfg: Map<string, string>;
  private readonly t: Record<string, TexRef | null> = {};
  private readonly circles: Record<Prefix, { circle: TexRef | null; overlay: TexRef | null }>;
  private readonly digits: (TexRef | null)[];
  private readonly overlap: number;
  private readonly overlayAboveNumber: boolean;
  private readonly border: Colour;
  private readonly track: Colour | null;
  private readonly ballColour: Colour;
  private readonly ballTint: boolean;
  private balls: TexRef[] = [];
  private followCircle: Anim | null = null;
  private followPointAnim: Anim | null = null;
  /** the reverse arrow is classic's own (it turns black on bright colours) */
  private arrowIsDefault = false;
  private newSpinner = false;
  private oldSpinner = false;
  private spinnerApproach = false;
  private disjointTrail = false;
  private trailTex: TexRef | null = null;
  private trailSize = 0;
  private readonly spinnerBackground: Colour;

  private constructor(
    skin: LoadedSkin,
    chart: OsuChart,
    private readonly defaults: DefaultTextures,
  ) {
    this.chain = new TextureChain(skin.chain);
    const own = skin.own;
    this.version = own?.version ?? 2.7;
    this.cfg = own?.ini?.config ?? new Map();
    const combo = own?.ini?.combo ?? [];
    this.comboColours = combo.length ? combo.map((c) => visible(bytes(c))) : DEFAULT_COMBO;
    const colours = own?.ini?.colours;
    this.border = chart.sliderBorder ? bytes(chart.sliderBorder) : colours?.get("SliderBorder") ? bytes(colours.get("SliderBorder")!) : WHITE;
    const track = chart.sliderTrack ?? colours?.get("SliderTrackOverride") ?? null;
    this.track = track ? bytes(track) : null;
    this.ballColour = colours?.get("SliderBall") ? bytes(colours.get("SliderBall")!) : WHITE;
    this.ballTint = this.flag("AllowSliderBallTint", false);
    this.overlayAboveNumber = this.flag("HitCircleOverlayAboveNumber", this.flag("HitCircleOverlayAboveNumer", true));
    const prefix = this.cfg.get("HitCirclePrefix") ?? "default";
    this.overlap = Number.parseFloat(this.cfg.get("HitCircleOverlap") ?? "-2") || 0;
    this.digits = Array.from({ length: 10 }, (_, i) => this.chain.texture(`${prefix}-${i}`));
    // LegacyMainCirclePiece: a prefixed circle only from the skin that has "hitcircle"
    const provider = skin.chain.find((s) => s.texture("hitcircle")) ?? skin.chain[0];
    const circleSet = (name: Prefix) => {
      const use = name === "hitcircle" || provider?.texture(name) ? name : "hitcircle";
      return { circle: this.chain.texture(use), overlay: this.chain.texture(`${use}overlay`) };
    };
    this.circles = { hitcircle: circleSet("hitcircle"), sliderstartcircle: circleSet("sliderstartcircle"), sliderendcircle: circleSet("sliderendcircle") };
    this.trail = { fade: 500, interval: 1 };
    const arrowSource = skin.chain.find((s) => s.texture("reversearrow"));
    this.arrowIsDefault = !!arrowSource && (skin.entry.kind === "classic" || arrowSource !== skin.own);
    const bg = colours?.get("SpinnerBackground");
    this.spinnerBackground = bg ? bytes(bg) : fromBytes([100, 100, 100, 255]);
  }

  static async create(skin: LoadedSkin, chart: OsuChart, defaults: DefaultTextures): Promise<LegacyOsuRenderer> {
    const r = new LegacyOsuRenderer(skin, chart, defaults);
    const c = r.chain;
    for (const name of [
      "approachcircle",
      "sliderscorepoint",
      "reversearrow",
      "sliderb-nd",
      "sliderb-spec",
      "cursor",
      "cursormiddle",
      "cursortrail",
      "spinner-glow",
      "spinner-bottom",
      "spinner-top",
      "spinner-middle",
      "spinner-middle2",
      "spinner-background",
      "spinner-circle",
      "spinner-metre",
      "spinner-approachcircle",
      "spinner-spin",
      "spinner-clear",
    ]) {
      r.t[name] = c.texture(name);
    }
    // sliderb0, sliderb1 … (or sliderb)
    for (let i = 0; ; i++) {
      const f = c.texture(`sliderb${i}`);
      if (!f) break;
      r.balls.push(f);
    }
    if (!r.balls.length) {
      const b = c.texture("sliderb");
      if (b) r.balls.push(b);
    }
    r.followCircle = c.animation("sliderfollowcircle", true, true);
    r.followPointAnim = c.animation("followpoint", true, true);
    r.newSpinner = !!r.t["spinner-top"] && !r.t["spinner-background"];
    r.oldSpinner = !!r.t["spinner-background"];
    // the classic skin's own new-style spinner has no approach circle
    const topSource = skin.chain.find((s) => s.texture("spinner-top"));
    r.spinnerApproach = r.oldSpinner || (!!topSource && topSource === skin.own && skin.entry.kind !== "classic");
    // LegacyCursorTrail: without cursormiddle the trail is separate sprites, 60 a second
    const cursorSource = skin.chain.find((s) => s.texture("cursor"));
    r.disjointTrail = !!r.t.cursortrail && !cursorSource?.texture("cursormiddle");
    r.trailTex = r.t.cursortrail ?? defaults.trail;
    const ts = texSize(r.t.cursortrail);
    r.trailSize = ts ? ts[0] / STABLE_SCALE : 5;
    if (!r.t.cursortrail) r.trail = { fade: 300, interval: 2 };
    else if (r.disjointTrail) r.trail = { fade: 150, interval: 0 };
    else r.trail = { fade: 500, interval: Math.max(1, r.trailSize / 2.5) };
    await preload([
      ...Object.values(r.t),
      ...r.digits,
      ...r.balls,
      r.followCircle,
      r.followPointAnim,
      ...Object.values(r.circles).flatMap((p) => [p.circle, p.overlay]),
    ]);
    return r;
  }

  private flag(key: string, fallback: boolean): boolean {
    const v = this.cfg.get(key);
    if (v === undefined) return fallback;
    return v.trim() === "1" || v.trim().toLowerCase() === "true";
  }

  body(accent: Colour): BodyStyle {
    // LegacyDrawableSliderPath (osu!stable's MmSliderRendererGL)
    const a = this.track ?? accent;
    const trackColour: Colour = [a[0], a[1], a[2], 0.7];
    const shadowPortion = 1 - LEGACY_RADIUS / OBJECT_RADIUS;
    const borderPortion = 0.1875;
    const outer = darken(trackColour, 0.1);
    const inner = lightenLegacy(trackColour, 0.5);
    const bands: [number, Colour][] = [];
    for (let k = 0; k < 3; k++) {
      const p = (shadowPortion * k) / 3;
      bands.push([p, [0, 0, 0, (0.25 * (k + 0.5)) / 3]]);
    }
    bands.push([shadowPortion, this.border]);
    const steps = 10;
    for (let k = 0; k < steps; k++) {
      const p = borderPortion + ((1 - borderPortion) * k) / steps;
      const w = (k + 0.5) / steps;
      bands.push([p, [outer[0] + (inner[0] - outer[0]) * w, outer[1] + (inner[1] - outer[1]) * w, outer[2] + (inner[2] - outer[2]) * w, 0.7]]);
    }
    return { radius: OBJECT_RADIUS, bands };
  }

  circle(f: OsuFrame, c: CirclePiece): void {
    const ctx = f.ctx;
    const prefix: Prefix = c.part === "circle" ? "hitcircle" : c.part === "head" ? "sliderstartcircle" : "sliderendcircle";
    const set = this.circles[prefix];
    const accent = visible(dimmed(c.accent, c.dim));
    const white = dimmed(WHITE, c.dim);
    ctx.translate(c.x, c.y);
    ctx.scale(f.scale, f.scale);
    ctx.globalAlpha *= c.alpha;
    let pieceAlpha = 1;
    let pieceScale = 1;
    let numberAlpha = 1;
    let numberScale = 1;
    if (c.hit >= 0) {
      pieceAlpha = 1 - Math.min(1, c.hit / 240);
      pieceScale = tween(c.hit, 1, 1.4, 240, ease.out);
      if (this.version > 1) numberAlpha = 1 - Math.min(1, c.hit / 60);
      else {
        numberAlpha = pieceAlpha;
        numberScale = pieceScale;
      }
    }
    const number = () => {
      if (c.number <= 0 || numberAlpha <= 0 || c.part === "tail" || c.part === "repeat") return;
      ctx.save();
      ctx.globalAlpha *= numberAlpha;
      ctx.scale(numberScale * 0.8, numberScale * 0.8);
      this.drawNumber(ctx, String(c.number), white);
      ctx.restore();
    };
    if (pieceAlpha > 0) {
      ctx.save();
      ctx.globalAlpha *= pieceAlpha;
      ctx.scale(pieceScale, pieceScale);
      sprite(ctx, set.circle, 0, 0, { tint: accent, max: MAX_CIRCLE });
      ctx.restore();
    }
    if (!this.overlayAboveNumber) number();
    if (pieceAlpha > 0) {
      ctx.save();
      ctx.globalAlpha *= pieceAlpha;
      ctx.scale(pieceScale, pieceScale);
      sprite(ctx, set.overlay, 0, 0, { tint: white, max: MAX_CIRCLE });
      ctx.restore();
    }
    if (this.overlayAboveNumber) number();
  }

  /** LegacySpriteText: the skin's digits, overlapping by HitCircleOverlap. */
  private drawNumber(ctx: CanvasRenderingContext2D, s: string, tint: Colour): void {
    const glyphs = [...s].map((ch) => this.digits[Number(ch)]);
    const sizes = glyphs.map((g) => texSize(g));
    if (sizes.some((z) => !z)) return;
    const widths = sizes.map((z) => Math.min(z![0], (SIZE * 2) / 0.8));
    const spacing = -this.overlap;
    const total = widths.reduce((a, w) => a + w, 0) + spacing * (widths.length - 1);
    let x = -total / 2;
    glyphs.forEach((g, k) => {
      sprite(ctx, g, x + widths[k] / 2, 0, { tint, max: [(SIZE * 2) / 0.8, (SIZE * 2) / 0.8] });
      x += widths[k] + spacing;
    });
  }

  approach(f: OsuFrame, a: ApproachPiece): void {
    const ctx = f.ctx;
    ctx.globalAlpha *= a.alpha;
    sprite(ctx, this.t.approachcircle, a.x, a.y, { scale: f.scale * a.scale, tint: visible(a.accent), max: MAX_CIRCLE });
  }

  tick(f: OsuFrame, k: TickPiece): void {
    const ctx = f.ctx;
    ctx.globalAlpha *= k.alpha;
    sprite(ctx, this.t.sliderscorepoint, k.x, k.y, { scale: f.scale * k.scale, max: [SIZE, SIZE] });
  }

  repeat(f: OsuFrame, r: RepeatPiece): void {
    const ctx = f.ctx;
    // the end circle under the arrow
    if (r.circleAlpha > 0) {
      ctx.save();
      ctx.globalAlpha *= r.circleAlpha;
      ctx.translate(r.x, r.y);
      ctx.scale(f.scale, f.scale);
      sprite(ctx, this.circles.sliderendcircle.circle, 0, 0, { tint: visible(dimmed(r.accent, r.dim)), max: MAX_CIRCLE });
      sprite(ctx, this.circles.sliderendcircle.overlay, 0, 0, { tint: dimmed(WHITE, r.dim), max: MAX_CIRCLE });
      ctx.restore();
    }
    // LegacyReverseArrow: beating every 300 ms (old skins also rock it), 1.4× once hit
    ctx.globalAlpha *= r.alpha;
    ctx.translate(r.x, r.y);
    let rotation = r.angle;
    let scale: number;
    if (r.hit >= 0) scale = tween(r.hit, 1, 1.4, Math.min(300, r.spanDuration), ease.out);
    else {
      const loop = ((r.loop % 300) + 300) % 300;
      if (this.version <= 1) {
        rotation += ((5.625 - (11.25 * loop) / 300) * Math.PI) / 180;
        scale = 1.3 - (0.3 * loop) / 300;
      } else scale = tween(loop, 1.3, 1, 300, ease.out);
    }
    ctx.rotate(rotation);
    const s = f.scale * scale;
    const a = r.accent;
    const tint = this.arrowIsDefault && a[0] + a[1] + a[2] > 600 / 255 ? ([0, 0, 0, 1] as Colour) : WHITE;
    sprite(ctx, this.t.reversearrow, 0, 0, { scale: s, tint: tint === WHITE ? undefined : tint, max: MAX_CIRCLE });
  }

  ball(f: OsuFrame, b: BallPiece): void {
    const ctx = f.ctx;
    ctx.globalAlpha *= b.alpha;
    ctx.translate(b.x, b.y);
    ctx.scale(f.scale, f.scale);
    // LegacyFollowCircle: to 2× on the press, a pulse on ticks, 1.6× and gone at the end
    if (this.followCircle && b.sinceStart >= 0) {
      const press = Math.max(1, Math.min(180, -b.sinceEnd + b.sinceStart));
      let scale = tween(b.sinceStart, 1, 2, Math.min(180, press), ease.out);
      let alpha = Math.min(1, b.sinceStart / Math.min(60, press));
      if (b.sinceTick >= 0 && b.sinceEnd < 0 && scale >= 2) scale = tween(b.sinceTick, 2.2, 2, 200);
      if (b.sinceEnd >= 0) {
        scale = tween(b.sinceEnd, scale, 1.6, 200, ease.out);
        alpha *= 1 - ease.in(Math.min(1, b.sinceEnd / 200));
      }
      if (alpha > 0) {
        ctx.save();
        ctx.globalAlpha *= alpha;
        const frame = frameAt(this.followCircle, b.sinceStart);
        sprite(ctx, frame, 0, 0, { scale: 0.5 * scale, max: [SIZE * 3 * 2, SIZE * 3 * 2] });
        ctx.restore();
      }
    }
    // LegacySliderBall: shown from the start to the end
    if (b.sinceStart < 0 || b.sinceEnd >= 0 || !this.balls.length) return;
    const max: [number, number] = [SIZE * 3, SIZE * 3];
    sprite(ctx, this.t["sliderb-nd"], 0, 0, { tint: fromBytes([5, 5, 5, 255]), max });
    const delay = Math.max(b.velocity > 0 ? (0.15 / b.velocity) * SIXTY_FRAME : SIXTY_FRAME, SIXTY_FRAME);
    const frame = this.balls[Math.floor(b.sinceStart / delay) % this.balls.length];
    const tint = this.ballTint ? b.accent : this.ballColour;
    ctx.save();
    ctx.rotate(b.angle);
    sprite(ctx, frame, 0, 0, { tint: tint === WHITE ? undefined : tint, max });
    ctx.restore();
    ctx.globalCompositeOperation = "lighter";
    sprite(ctx, this.t["sliderb-spec"], 0, 0, { max });
  }

  spinner(f: OsuFrame, s: SpinnerPiece): void {
    const ctx = f.ctx;
    const t = f.t;
    if (!this.newSpinner && !this.oldSpinner) return;
    // the 640 × 480 area, 8 up from the middle
    ctx.translate(s.x, s.y - 8 - 240);
    ctx.globalAlpha *= s.alpha;
    // in over the fade-in before the start
    ctx.globalAlpha *= Math.max(0, Math.min(1, (t - (s.start - s.fadeIn)) / s.fadeIn));
    if (ctx.globalAlpha <= 0) return;
    const centre = SPINNER_Y_CENTRE;
    const deg = Math.PI / 180;
    if (this.newSpinner) {
      const turnRatio = this.t["spinner-middle2"] ? 0.5 : 1;
      const scale = SPRITE_SCALE * (0.8 + ease.out(s.progress) * 0.2);
      ctx.save();
      ctx.translate(0, centre);
      ctx.scale(scale, scale);
      const glowAlpha = s.progress * (t > s.end ? Math.max(0, 1 - (t - s.end) / 300) : 1);
      if (glowAlpha > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha *= glowAlpha;
        sprite(ctx, this.t["spinner-glow"], 0, 0, { tint: fromBytes([3, 151, 255, 255]) });
        ctx.restore();
      }
      const top = s.rotation * turnRatio;
      const spin = (ref: TexRef | null, r: number, tint?: Colour) => {
        ctx.save();
        ctx.rotate(r * deg);
        sprite(ctx, ref, 0, 0, { tint });
        ctx.restore();
      };
      spin(this.t["spinner-bottom"], top / 3);
      spin(this.t["spinner-top"], top);
      spin(this.t["spinner-middle2"], s.rotation);
      // the middle turns red over the spinner's length
      const red = t <= s.start ? 0 : Math.min(1, (t - s.start) / Math.max(1, s.end - s.start));
      spin(this.t["spinner-middle"], 0, [1, 1 - red, 1 - red, 1]);
      ctx.restore();
    } else {
      sprite(ctx, this.t["spinner-background"], 0, centre, { scale: SPRITE_SCALE, tint: this.spinnerBackground });
      ctx.save();
      ctx.translate(0, centre);
      ctx.rotate(s.rotation * deg);
      sprite(ctx, this.t["spinner-circle"], 0, 0, { scale: SPRITE_SCALE });
      ctx.restore();
      // the metre: bars from the bottom, ten in all (the last one blinking)
      const metre = tex(this.t["spinner-metre"]);
      if (metre) {
        const height = metre.h * SPRITE_SCALE;
        const width = metre.w * SPRITE_SCALE;
        const progress = Math.min(99, s.progress * 100);
        const bars = Math.floor(progress / 10) + ((progress % 10) / 10 > 0.5 && Math.floor(t / 50) % 2 ? 1 : 0);
        const shown = (bars / 10) * (692 * SPRITE_SCALE);
        ctx.save();
        ctx.beginPath();
        ctx.rect(-320, SPINNER_TOP + 692 * SPRITE_SCALE - shown, 640, shown);
        ctx.clip();
        ctx.drawImage(metre.img, -320, SPINNER_TOP, width, height);
        ctx.restore();
      }
    }
    // the approach circle, shrinking to a tenth over the spinner
    if (this.spinnerApproach && !s.hidden && t >= s.start - s.fadeIn && t <= s.end) {
      const k = t <= s.start ? 1 : 1 - (0.9 * (t - s.start)) / Math.max(1, s.end - s.start);
      sprite(ctx, this.t["spinner-approachcircle"], 0, centre, { scale: SPRITE_SCALE * 1.86 * k });
    }
    // "spin!" and "clear"
    const spinOut = Math.min(400, s.end - s.start);
    if (t >= s.start - s.fadeIn / 2 && t < s.end) {
      let a = Math.min(1, (t - (s.start - s.fadeIn / 2)) / (s.fadeIn / 2));
      if (t > s.end - spinOut) a *= 1 - (t - (s.end - spinOut)) / spinOut;
      ctx.save();
      ctx.globalAlpha *= a;
      sprite(ctx, this.t["spinner-spin"], 0, SPINNER_TOP + 335, { scale: SPRITE_SCALE });
      ctx.restore();
    }
    if (t >= s.completed && t < s.end) {
      const from = Math.min(s.completed, s.end - 400);
      const e = t - from;
      let a = ease.out(Math.min(1, e / 400));
      if (t > s.end - 50) a *= (s.end - t) / 50;
      const scale = e < 240 ? tween(e, SPRITE_SCALE * 2, SPRITE_SCALE * 0.8, 240, ease.out) : tween(e - 240, SPRITE_SCALE * 0.8, SPRITE_SCALE, 160);
      ctx.save();
      ctx.globalAlpha *= a;
      sprite(ctx, this.t["spinner-clear"], 0, SPINNER_TOP + 115, { scale });
      ctx.restore();
    }
  }

  followPoint(f: OsuFrame, p: FollowPointPiece): void {
    if (!this.followPointAnim) return;
    const ctx = f.ctx;
    ctx.globalAlpha *= p.alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    sprite(ctx, frameAt(this.followPointAnim, p.since), 0, 0, { scale: p.scale, max: [SIZE, SIZE / 2] });
  }

  drawTrail(f: OsuFrame, parts: TrailPart[]): void {
    if (!this.t.cursortrail) {
      drawTrailParts(f, parts, this.defaults.trail, 5, 1.7, true);
      return;
    }
    const ts = texSize(this.trailTex);
    const max = ts ? Math.max(ts[0], ts[1]) / STABLE_SCALE : this.trailSize;
    if (this.disjointTrail) drawTrailParts(f, parts, this.trailTex, max, 1, false);
    else drawTrailParts(f, parts.filter((p) => p.life < 0.999), this.trailTex, max, 1, true);
  }

  cursor(f: OsuFrame, c: CursorPiece): void {
    const ctx = f.ctx;
    const cursor = this.t.cursor;
    if (!cursor) return;
    const centre = this.flag("CursorCentre", true);
    const rotate = this.flag("CursorRotate", true);
    const expand = this.flag("CursorExpand", true);
    ctx.translate(c.x, c.y);
    // NonPlayfieldSprite: stable's sizes, not the playfield's
    const k = 1 / STABLE_SCALE;
    let scale = 1;
    if (expand && c.pressed >= 0) scale = tween(c.pressed, 1, 1.3, 100, ease.out);
    else if (expand && c.released >= 0) scale = tween(c.released, 1.3, 1, 100, ease.out);
    const origin = centre ? 0.5 : 0;
    ctx.save();
    if (rotate) ctx.rotate(((f.t % 10000) / 10000) * Math.PI * 2);
    ctx.scale(scale, scale);
    sprite(ctx, cursor, 0, 0, { scale: k, ox: origin, oy: origin });
    ctx.restore();
    sprite(ctx, this.t.cursormiddle, 0, 0, { scale: k, ox: origin, oy: origin });
  }
}

/** LegacyDrawableSliderPath.lighten */
function lightenLegacy(c: Colour, amount: number): Colour {
  const a = amount * 0.5;
  return [Math.min(1, c[0] * (1 + 0.5 * a) + a), Math.min(1, c[1] * (1 + 0.5 * a) + a), Math.min(1, c[2] * (1 + 0.5 * a) + a), c[3]];
}
