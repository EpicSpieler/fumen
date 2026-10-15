/* argon.ts — lazer's "argon" skin (and "argon pro") on the mania playfield, drawn after
 * ManiaArgonSkinTransformer and the Argon* pieces (MIT, ppy Pty Ltd): rounded notes in column
 * colours, the key area with its target line and icons, glowing hit explosions, "PERFECT" judgements
 * with rings. Bar lines are the default ones, as argon has none of its own.
 */
import { lowerBound } from "../../lib/charts";
import { css, darken, ease, lighten, mix, opacity, rgb, tween, WHITE, type Colour, type View } from "./draw";
import { Autoplay, firstBar, HIT_TARGET_POSITION, isSpecial, layoutColumns, type Frame, type Renderer, type StageGeometry } from "./stage";

const NOTE_HEIGHT = 42;
const NOTE_ACCENT_RATIO = 0.82;
const CORNER_RADIUS = 3.4;

const YELLOW = rgb("#ffc528");
const ORANGE = rgb("#fc6d01");
const PINK = rgb("#d5235a");
const PURPLE = rgb("#cb3cec");
const CYAN = rgb("#48c6ff");
const GREEN = rgb("#64c05c");
const SPECIAL = rgb("#a96aff");

/** ManiaArgonSkinTransformer.getColourForLayout */
export function argonColour(col: number, keys: number): Colour {
  const table: Record<number, Colour[]> = {
    1: [YELLOW],
    2: [GREEN, CYAN],
    3: [GREEN, SPECIAL, CYAN],
    4: [YELLOW, ORANGE, PINK, PURPLE],
    5: [PINK, ORANGE, YELLOW, GREEN, CYAN],
    6: [PINK, ORANGE, GREEN, CYAN, ORANGE, PINK],
    7: [PINK, ORANGE, PINK, SPECIAL, PINK, ORANGE, PINK],
    8: [PURPLE, PINK, ORANGE, GREEN, CYAN, ORANGE, PINK, PURPLE],
    9: [PURPLE, PINK, ORANGE, YELLOW, SPECIAL, YELLOW, ORANGE, PINK, PURPLE],
    10: [PURPLE, PINK, ORANGE, YELLOW, GREEN, CYAN, YELLOW, ORANGE, PINK, PURPLE],
  };
  if (table[keys]) return table[keys][col];
  if (isSpecial(col, keys)) return SPECIAL;
  return [YELLOW, ORANGE, PINK, PURPLE, CYAN, GREEN][col % 6];
}

/** OsuColour.ForHitResult(Perfect) */
export const PERFECT_COLOUR = rgb("#99eeff");
/** OsuColour.ForHitResult, Perfect … Miss */
export const RESULT_COLOURS = ["#99eeff", "#66ccff", "#b3d944", "#88b300", "#ffcc22", "#ed1121"].map((c) => rgb(c));
const RESULT_TEXT = ["PERFECT", "GREAT", "GOOD", "OK", "MEH", "MISS"];

/**
 * The alpha of a lit-on-press overlay (Default/ArgonColumnBackground): up to 1 in 50 ms, down to 0.5
 * over 250 ms while held, out over 250 ms after release (OutQuint, game clock).
 */
export function pressOverlay(auto: Frame["auto"], col: number, t: number, rate: number): number {
  const k = auto.key(col, t);
  const held = (since: number, from: number) => (since < 50 ? tween(since, from, 1, 50, ease.outQuint) : tween(since - 50, 1, 0.5, 250, ease.outQuint));
  const fade = (since: number, from: number) => tween(since, from, 0, 250, ease.outQuint);
  if (k.down) {
    const before = k.released > -Infinity ? fade((k.pressed - k.released) / rate, 0.5) : 0;
    return held((t - k.pressed) / rate, before);
  }
  if (k.pressed === -Infinity) return 0;
  return fade((t - k.released) / rate, held((k.released - k.pressed) / rate, 0));
}

/** A small deterministic random in [0, 1) from a seed (for judgement rings). */
export function seeded(seed: number): () => number {
  let s = Math.floor(seed * 1000) % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** FontAwesome's angle-down (solid), as drawn by SpriteIcon */
const ANGLE_DOWN = new Path2D("M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 33.9 0l96.4 96.4 96.4-96.4c9.4-9.4 24.6-9.4 33.9 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 9.4-24.4 9.4-33.8 0z");

export class ArgonRenderer implements Renderer {
  readonly geo: StageGeometry;
  private readonly colours: Colour[];

  constructor(
    readonly keys: number,
    /** argon pro shows no judgement for great and perfect hits */
    private readonly pro = false,
  ) {
    const widths = Array.from({ length: keys }, (_, i) => 60 * (isSpecial(i, keys) ? 2 : 1));
    const ones = new Array<number>(keys).fill(1);
    const { columns, width } = layoutColumns(widths, ones, ones);
    this.geo = { columns, width, hitPosition: HIT_TARGET_POSITION, padTop: 30, padBottom: 30 };
    this.colours = Array.from({ length: keys }, (_, i) => argonColour(i, keys));
  }

  draw(f: Frame): void {
    const { v, t, x0, geo, auto } = f;
    const ctx = v.ctx;
    const bottom = geo.padBottom;
    const top = v.S - geo.padTop;
    const keys = this.keys;

    // ── column backgrounds ──
    for (let i = 0; i < keys; i++) {
      const box = geo.columns[i];
      const x = x0 + box.x;
      const accent = this.colours[i];
      ctx.save();
      v.roundRect(x, box.w, bottom, top, CORNER_RADIUS);
      ctx.clip();
      ctx.fillStyle = css(opacity(darken(accent, 3), 0.8));
      v.rect(x, box.w, bottom, top);
      const a = pressOverlay(auto, i, t, f.rate);
      if (a > 0.001) {
        const half = (top - bottom) / 2;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a;
        ctx.fillStyle = v.gradient(bottom, bottom + half, css(opacity(accent, 0.6)), css(opacity(accent, 0)));
        v.rect(x, box.w, bottom, bottom + half);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    }

    // ── bar lines (DefaultBarLine) ──
    drawDefaultBarLines(f);

    // ── hit targets, then notes ──
    const hitD = f.hitD;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,255,255,.3)";
    for (let i = 0; i < keys; i++) {
      const box = geo.columns[i];
      v.roundRect(x0 + box.x, box.w, hitD, hitD + NOTE_HEIGHT * NOTE_ACCENT_RATIO, CORNER_RADIUS);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    const n = f.data.notes;
    const len = v.S - geo.padTop - geo.padBottom - geo.hitPosition;
    const tFar = t + ((v.S + 60 - hitD) / Math.max(1, len)) * f.timeRange;
    const from = lowerBound(n, t - f.maxHold - 1);
    const to = lowerBound(n, tFar);
    f.notes(() => {
      for (let j = to - 3; j >= from; j -= 3) {
        const col = n[j + 1];
        if (col < 0 || col >= keys) continue;
        this.drawObject(f, col, n[j], n[j + 2], j / 3);
      }
    });

    // ── top level, per column: key area, then explosions ──
    for (let i = 0; i < keys; i++) {
      this.drawKeyArea(f, i);
      const box = geo.columns[i];
      const hits = auto.hits[i];
      const glowColour = this.colours[i];
      for (let h = Autoplay.upper(hits, t) - 1; h >= 0 && t - hits[h] < 200; h--) {
        const e = t - hits[h];
        const alpha = 1 - ease.out(e / 200);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = alpha;
        v.glow(glowColour, 60);
        ctx.fillStyle = css(mix(glowColour, WHITE, 0.8));
        v.roundRect(x0 + box.x, box.w, hitD, hitD + NOTE_HEIGHT * NOTE_ACCENT_RATIO, CORNER_RADIUS);
        ctx.fill();
        v.glow(null, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    }

    // ── judgement ──
    if (!this.pro) drawTextJudgement(f, hitD + 180, "argon");
  }

  private drawObject(f: Frame, col: number, start: number, len: number, obj: number): void {
    const { v, t } = f;
    const box = f.geo.columns[col];
    const x = f.x0 + box.x;
    const w = box.w;
    const accent = this.colours[col];
    const pos = f.posD(start);
    if (!(len > 0)) {
      if (t >= f.auto.gone(obj) || pos > v.S) return;
      this.notePiece(v, x, w, pos, accent, "note");
      return;
    }
    const end = start + len;
    if (t >= f.auto.gone(obj)) return;
    const endPos = f.posD(end);
    if (pos - NOTE_HEIGHT > v.S) return;
    const ctx = v.ctx;
    const holding = f.auto.held(obj, t);
    const sizingBottom = holding ? f.hitD : pos;
    ctx.save();
    v.clip(x, w, sizingBottom + NOTE_HEIGHT / 2, Math.max(sizingBottom + NOTE_HEIGHT / 2, endPos + NOTE_HEIGHT));
    // body: half under the head to half under the tail
    const d0 = pos + NOTE_HEIGHT / 2;
    const d1 = endPos + NOTE_HEIGHT / 2;
    if (d1 > d0) {
      ctx.save();
      v.roundRect(x, w, d0, d1, CORNER_RADIUS);
      ctx.clip();
      ctx.fillStyle = css(darken(accent, 0.6));
      v.rect(x, w, d0, d1);
      const hitting = hittingAlpha(t, start, holding);
      if (hitting > 0) {
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = css(opacity(lighten(accent, 0.2), 0.3), hitting);
        v.rect(x, w, d0, d1);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.restore();
    }
    this.tailPiece(v, x, w, endPos, accent, hittingAlpha(t, start, holding));
    ctx.restore();
    this.notePiece(v, x, w, sizingBottom, accent, "head");
  }

  /** ArgonNotePiece / ArgonHoldNoteHeadPiece, bottom at `d` */
  private notePiece(v: View, x: number, w: number, d: number, accent: Colour, kind: "note" | "head"): void {
    const ctx = v.ctx;
    ctx.save();
    v.roundRect(x, w, d, d + NOTE_HEIGHT, CORNER_RADIUS);
    ctx.clip();
    ctx.fillStyle = v.gradient(d + NOTE_HEIGHT, d, "rgba(0,0,0,0)", "rgba(0,0,0,1)");
    v.rect(x, w, d, d + NOTE_HEIGHT);
    const ah = NOTE_HEIGHT * NOTE_ACCENT_RATIO;
    v.roundRect(x, w, d, d + ah, CORNER_RADIUS);
    ctx.fillStyle = v.gradient(d + ah, d, css(lighten(accent, 0.1)), css(accent));
    ctx.fill();
    // the light rim along the bottom
    ctx.fillStyle = "#fff";
    v.roundRect(x, w, d, d + CORNER_RADIUS * 2, CORNER_RADIUS);
    ctx.fill();
    ctx.restore();
    // the icon, centred (4 down for notes, 2 for heads)
    const cx = x + w / 2;
    const cy = v.y(d + NOTE_HEIGHT / 2) + (v.up ? -1 : 1) * (kind === "note" ? 4 : 2);
    ctx.fillStyle = "#fff";
    if (kind === "head") {
      ctx.beginPath();
      ctx.roundRect(cx - 10, cy - 2.5, 20, 5, 2.5);
      ctx.fill();
      return;
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(20 / 512, ((v.up ? -1 : 1) * 20 * 0.7) / 512);
    ctx.translate(-160, -256);
    ctx.fill(ANGLE_DOWN);
    ctx.restore();
  }

  /** ArgonHoldNoteTailPiece, bottom at `d` */
  private tailPiece(v: View, x: number, w: number, d: number, accent: Colour, hitting: number): void {
    const ctx = v.ctx;
    ctx.save();
    v.roundRect(x, w, d, d + NOTE_HEIGHT, CORNER_RADIUS);
    ctx.clip();
    // dark fade over the top 90 %
    ctx.fillStyle = v.gradient(d + NOTE_HEIGHT, d + NOTE_HEIGHT * 0.1, "rgba(0,0,0,0)", "rgba(0,0,0,1)");
    v.rect(x, w, d + NOTE_HEIGHT * 0.1, d + NOTE_HEIGHT);
    const ah = NOTE_HEIGHT * NOTE_ACCENT_RATIO;
    v.roundRect(x, w, d, d + ah, CORNER_RADIUS);
    ctx.clip();
    ctx.fillStyle = css(darken(accent, 0.6));
    v.rect(x, w, d, d + ah);
    ctx.globalCompositeOperation = "lighter";
    if (hitting > 0) {
      ctx.fillStyle = css(opacity(lighten(accent, 0.2), 0.3), hitting);
      v.rect(x, w, d, d + ah);
    }
    ctx.fillStyle = v.gradient(d + ah, d + ah / 2, css(opacity(accent, 0.4)), css(opacity(accent, 0)));
    v.rect(x, w, d + ah / 2, d + ah);
    ctx.restore();
  }

  /** ArgonKeyArea */
  private drawKeyArea(f: Frame, col: number): void {
    const { v, t, auto } = f;
    const ctx = v.ctx;
    const box = f.geo.columns[col];
    const x = f.x0 + box.x;
    const w = box.w;
    const accent = this.colours[col];
    const bottom = f.geo.padBottom;
    const height = HIT_TARGET_POSITION + CORNER_RADIUS * 2;
    const k = auto.key(col, t);
    const real = (ms: number) => ms / f.rate;
    const lighting = mix(accent, WHITE, 0.2);

    // press: 0 → 1 (70 ms), release: 1 → 0 (800 ms), both OutQuint
    let on: number;
    let bg: number;
    let flash = 0;
    if (k.down) {
      const e = real(t - k.pressed);
      on = tween(e, 0, 1, 70, ease.outQuint);
      bg = e < 70 ? tween(e, 0, 1, 70, ease.outQuint) : tween(e - 70, 1, 0.8, 500);
      flash = 1 - tween(e, 0, 1, 200, ease.outQuint);
    } else if (k.pressed > -Infinity) {
      const e = real(t - k.released);
      on = 1 - tween(e, 0, 1, 800, ease.outQuint);
      const held = real(k.released - k.pressed);
      const at = held < 70 ? tween(held, 0, 1, 70, ease.outQuint) : tween(held - 70, 1, 0.8, 500);
      bg = e < 50 ? tween(e, at, 0.3, 50, ease.outQuint) : tween(e - 50, 0.3, 0, 800, ease.outQuint);
    } else {
      on = 0;
      bg = 0;
    }

    if (bg > 0.001) {
      ctx.save();
      v.roundRect(x, w, bottom, bottom + height, CORNER_RADIUS);
      ctx.clip();
      ctx.globalAlpha = bg;
      ctx.fillStyle = css(mix(darken(accent, 0.2), lighten(accent, 0.8), flash));
      v.rect(x, w, bottom, bottom + height);
      ctx.restore();
    }
    // the hit target line along the top, glowing while pressed
    const gray = 196 / 255;
    const line: Colour = [gray + (1 - gray) * on, gray + (1 - gray) * on, gray + (1 - gray) * on, 1];
    v.glow(lighting, k.down ? 20 * on : 20 + 5 * (1 - on), 0.4 * on);
    ctx.fillStyle = css(line);
    v.roundRect(x, w, bottom + height - CORNER_RADIUS * 2, bottom + height, CORNER_RADIUS);
    ctx.fill();
    v.glow(null, 0);

    const cx = x + w / 2;
    // the pill outline, 30 below the top
    const pillScale = k.down ? 1 - 0.1 * on : 0.9 + 0.1 * tween(real(t - k.released), 0, 1, 200, ease.outQuint);
    const py = v.y(bottom + height - 30);
    ctx.save();
    ctx.translate(cx, py);
    ctx.scale(pillScale, pillScale);
    v.glow(lighting, 20, 0.1 * on);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(-11 + 2, -7 + 2, 22 - 4, 14 - 4, 5);
    ctx.stroke();
    v.glow(null, 0);
    ctx.restore();

    // three dots, 30 above the bottom
    const dots = mix(accent, WHITE, on);
    ctx.globalCompositeOperation = "lighter";
    v.glow(lighting, 30 + 30 * on, 0.2 * on);
    ctx.fillStyle = css(dots);
    const dy = v.up ? -1 : 1;
    const by = v.y(bottom + 30);
    for (const [ox, oy] of [[0, -4.2], [-7, 4.2], [7, 4.2]]) {
      ctx.beginPath();
      ctx.arc(cx + ox, by + oy * dy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    v.glow(null, 0);
    ctx.globalCompositeOperation = "source-over";
  }
}

/** ArgonHoldNoteHittingLayer: pulses between 1 and 0.5 every 80 ms while held, in step with the clock. */
function hittingAlpha(t: number, start: number, holding: boolean): number {
  if (!holding) return 0;
  const sync = start + (160 - (start % 160));
  if (t < sync) return 0;
  const p = (t - sync) % 160;
  const first = t - sync < 160;
  return p < 80 ? tween(p, first ? 0 : 0.5, 1, 80, ease.outSine) : tween(p - 80, 1, 0.5, 80, ease.inSine);
}

/** DefaultBarLine: major lines (every bar's first) thicker, with fading ends outside the stage. */
export function drawDefaultBarLines(f: Frame): void {
  const { v, t, x0, geo } = f;
  const ctx = v.ctx;
  const len = v.S - geo.padTop - geo.padBottom - geo.hitPosition;
  const tTop = t + ((v.S + 10 - f.hitD) / Math.max(1, len)) * f.timeRange;
  for (let i = firstBar(f.bars, t - 150); i < f.bars.length; i++) {
    const b = f.bars[i];
    if (b.time > tTop) break;
    const e = t - b.time;
    const fade = e > 0 ? 1 - e / 150 : 1;
    const h = b.major ? 1.7 : 1.2;
    const d = f.posD(b.time) + 0.5;
    const main = b.major ? 0.5 : 0.2;
    ctx.fillStyle = `rgba(255,255,255,${main * fade})`;
    v.rect(x0, geo.width, d - h / 2, d + h / 2);
    if (b.major) {
      ctx.globalCompositeOperation = "lighter";
      const [y0, y1] = v.band(d - h / 2, d + h / 2);
      for (const [from, dir] of [[x0, -1], [x0 + geo.width, 1]] as const) {
        const g = ctx.createLinearGradient(from, 0, from + dir * 10, 0);
        g.addColorStop(0, `rgba(255,255,255,${main * 0.3 * fade})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(from, from + dir * 10), y0, 10, y1 - y0);
      }
      ctx.globalCompositeOperation = "source-over";
    }
  }
}

/**
 * The text judgements of argon ("PERFECT", rings flying out) and triangles ("PERFECT", popping in).
 * Autoplay only ever gets perfect; a replay gets them all.
 */
export function drawTextJudgement(f: Frame, centre: number, style: "argon" | "triangles"): void {
  const { v, t, x0, geo } = f;
  const ctx = v.ctx;
  const j = f.auto.judgement(t);
  if (!j) return;
  const hit = j.time;
  const colour = RESULT_COLOURS[j.result] ?? PERFECT_COLOUR;
  const text = RESULT_TEXT[j.result] ?? "PERFECT";
  const e = t - hit;
  const life = style === "argon" ? 1800 : 300;
  if (!(e >= 0 && e < life)) return;
  const cx = x0 + geo.width / 2;
  const cy = v.y(centre);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (style === "argon") {
    const alpha = 1 - e / 800;
    if (alpha > 0) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = alpha;
      const s = tween(e, 1, 1.4, 1800, ease.outQuint);
      ctx.save();
      ctx.scale(s, s);
      ctx.fillStyle = css(colour);
      ctx.font = `400 28px "Instrument Sans", system-ui, sans-serif`;
      ctx.letterSpacing = "10px";
      ctx.fillText(text, 5, 0);
      ctx.restore();
      // the rings (hits only)
      const rand = seeded(hit + 1);
      const ringAlpha = j.result === 5 ? 0 : 1 - ease.outQuint(Math.min(1, e / 1000));
      ctx.globalAlpha = alpha * ringAlpha;
      ctx.strokeStyle = css(colour);
      ctx.lineWidth = 4;
      for (let i = 0; i < 8; i++) {
        const size = i < 4 ? 9 : 14;
        const dir = rand() * 360;
        const dist = 26 + rand() * 26;
        const r = tween(e, dist * 0.3, dist, 600, ease.outQuint);
        ctx.beginPath();
        ctx.arc(Math.cos(dir) * r, Math.sin(dir) * r, size / 2 - 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  } else {
    // DefaultManiaJudgementPiece: 0.8 → 1 (elastic), then from 50 ms to 0.75 and out over 200 ms
    const s = e < 50 ? tween(e, 0.8, 1, 250, ease.outElastic) : tween(e - 50, tween(50, 0.8, 1, 250, ease.outElastic), 0.75, 250);
    ctx.globalAlpha = e < 50 ? 1 : Math.max(0, 1 - (e - 50) / 200);
    ctx.scale(s * 0.85, s);
    ctx.fillStyle = css(colour);
    ctx.font = `700 25px "Instrument Sans", system-ui, sans-serif`;
    ctx.letterSpacing = "2px";
    ctx.fillText(text, 1, 0);
  }
  ctx.restore();
}
