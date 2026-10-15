/* triangles.ts — lazer's "triangles" skin on the mania playfield: the default pieces
 * (DefaultStageBackground, DefaultColumnBackground, DefaultHitTarget, DefaultKeyArea,
 * DefaultNotePiece, DefaultBodyPiece, DefaultHitExplosion, DefaultBarLine; MIT, ppy Pty Ltd) in
 * the colours of ManiaTrianglesSkinTransformer.
 */
import { lowerBound } from "../../lib/charts";
import { drawDefaultBarLines, drawTextJudgement, pressOverlay, seeded } from "./argon";
import { css, darken, ease, lighten, mix, opacity, tween, WHITE, type Colour, type View } from "./draw";
import { Autoplay, HIT_TARGET_POSITION, isSpecial, layoutColumns, type Frame, type Renderer, type StageGeometry } from "./stage";

const NOTE_HEIGHT = 12;
const COLUMN_WIDTH = 80;
const SPECIAL_COLUMN_WIDTH = 70;

const EVEN: Colour = [6 / 255, 84 / 255, 0, 1];
const ODD: Colour = [94 / 255, 0, 57 / 255, 1];
const SPECIAL: Colour = [0, 48 / 255, 63 / 255, 1];

export class TrianglesRenderer implements Renderer {
  readonly geo: StageGeometry;
  private readonly colours: Colour[];

  constructor(readonly keys: number) {
    const widths = Array.from({ length: keys }, (_, i) => (isSpecial(i, keys) ? SPECIAL_COLUMN_WIDTH : COLUMN_WIDTH));
    const ones = new Array<number>(keys).fill(1);
    const { columns, width } = layoutColumns(widths, ones, ones);
    this.geo = { columns, width, hitPosition: HIT_TARGET_POSITION, padTop: 0, padBottom: 0 };
    this.colours = Array.from({ length: keys }, (_, i) =>
      isSpecial(i, keys) ? SPECIAL : Math.min(i, keys - 1 - i) % 2 === 0 ? ODD : EVEN,
    );
  }

  draw(f: Frame): void {
    const { v, t, x0, geo, auto } = f;
    const ctx = v.ctx;
    const S = v.S;
    const keys = this.keys;
    const hitD = f.hitD;

    // ── stage and column backgrounds ──
    ctx.fillStyle = "#000";
    v.rect(x0, geo.width, 0, S);
    for (let i = 0; i < keys; i++) {
      const box = geo.columns[i];
      const x = x0 + box.x;
      const accent = this.colours[i];
      ctx.fillStyle = css(darken(accent, 5));
      v.rect(x, box.w, 0, S);
      const a = pressOverlay(auto, i, t, f.rate);
      if (a > 0.001) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = a;
        ctx.fillStyle = v.gradient(0, S / 2, css(opacity(accent, 0.6)), css(opacity(accent, 0)));
        v.rect(x, box.w, 0, S / 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
      }
    }

    drawDefaultBarLines(f);

    // ── hit targets, notes, key areas ──
    const n = f.data.notes;
    const len = S - geo.hitPosition;
    const tFar = t + ((S + 30 - hitD) / Math.max(1, len)) * f.timeRange;
    const from = lowerBound(n, t - f.maxHold - 1);
    const to = lowerBound(n, tFar);
    for (let i = 0; i < keys; i++) {
      const box = geo.columns[i];
      const x = x0 + box.x;
      const accent = this.colours[i];
      // DefaultHitTarget: a dark bar with a glowing line on the hit position
      ctx.fillStyle = "rgba(0,0,0,.6)";
      v.rect(x, box.w, hitD, hitD + NOTE_HEIGHT);
      v.glow(opacity(accent, 0.5), 5);
      ctx.fillStyle = "#fff";
      v.rect(x, box.w, hitD, hitD + 2);
      v.glow(null, 0);
    }
    f.notes(() => {
      for (let j = to - 3; j >= from; j -= 3) {
        const col = n[j + 1];
        if (col < 0 || col >= keys) continue;
        this.drawObject(f, col, n[j], n[j + 2], j / 3);
      }
    });
    for (let i = 0; i < keys; i++) this.drawKeyArea(f, i);

    // ── judgement, then explosions (top level) ──
    drawTextJudgement(f, hitD + 180, "triangles");
    for (let i = 0; i < keys; i++) {
      const box = geo.columns[i];
      const hits = auto.hits[i];
      for (let h = Autoplay.upper(hits, t) - 1; h >= 0 && t - hits[h] < 400; h--) {
        this.explosion(v, x0 + box.x, box.w, hitD, t - hits[h], this.colours[i], hits[h]);
      }
    }
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
      this.notePiece(v, x, w, pos, accent);
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
    v.clip(x - 20, w + 40, sizingBottom + NOTE_HEIGHT / 2, Math.max(sizingBottom + NOTE_HEIGHT / 2, endPos + NOTE_HEIGHT));
    const d0 = pos + NOTE_HEIGHT / 2;
    const d1 = endPos + NOTE_HEIGHT / 2;
    if (d1 > d0) {
      // DefaultBodyPiece (additive): the accent, and a lighter frame whose middle is hollowed out
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = css(opacity(accent, 0.7));
      v.rect(x, w, d0, d1);
      const pulse = holding && Math.floor((t - start) / 50) % 2 === 0 ? 1 : 0;
      const fg = mix(accent, lighten(accent, 0.2), pulse);
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, css(opacity(fg, 0.5)));
      g.addColorStop(0.3, css(opacity(fg, 0.12)));
      g.addColorStop(0.5, css(opacity(fg, 0)));
      g.addColorStop(0.7, css(opacity(fg, 0.12)));
      g.addColorStop(1, css(opacity(fg, 0.5)));
      ctx.fillStyle = g;
      v.rect(x, w, d0, d1);
      ctx.globalCompositeOperation = "source-over";
    }
    this.notePiece(v, x, w, endPos, accent);
    ctx.restore();
    this.notePiece(v, x, w, sizingBottom, accent);
  }

  /** DefaultNotePiece, bottom at `d` */
  private notePiece(v: View, x: number, w: number, d: number, accent: Colour): void {
    const ctx = v.ctx;
    v.glow(opacity(lighten(accent, 1), 0.2), 10);
    ctx.fillStyle = "#fff";
    v.roundRect(x, w, d, d + NOTE_HEIGHT, 5);
    ctx.fill();
    v.glow(null, 0);
    ctx.save();
    v.roundRect(x, w, d, d + NOTE_HEIGHT, 5);
    ctx.clip();
    ctx.fillStyle = css(lighten(accent, 0.9), 0.1);
    v.rect(x, w, d, d + NOTE_HEIGHT / 2);
    ctx.restore();
  }

  /** DefaultKeyArea */
  private drawKeyArea(f: Frame, col: number): void {
    const { v, t } = f;
    const ctx = v.ctx;
    const box = f.geo.columns[col];
    const x = f.x0 + box.x;
    ctx.fillStyle = v.gradient(HIT_TARGET_POSITION, 0, "rgba(0,0,0,0)", "rgba(0,0,0,.5)");
    v.rect(x, box.w, 0, HIT_TARGET_POSITION);
    const k = f.auto.key(col, t);
    let scale = 1;
    if (k.down) {
      const e = (t - k.pressed) / f.rate;
      scale = e < 50 ? tween(e, 1, 1.4, 50, ease.outQuint) : tween(e - 50, 1.4, 1.3, 250, ease.outQuint);
    } else if (k.pressed > -Infinity) scale = tween((t - k.released) / f.rate, 1.3, 1, 125, ease.outQuint);
    const cx = x + box.w / 2;
    const cy = v.y(HIT_TARGET_POSITION - 20);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    v.glow(opacity(this.colours[col], 0.5), 5);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-4, -4, 8, 8, 2);
    ctx.stroke();
    v.glow(null, 0);
    ctx.restore();
  }

  /** DefaultHitExplosion: a white glow widening along the hit position, two thin streaks */
  private explosion(v: View, x: number, w: number, hitD: number, e: number, accent: Colour, seed: number): void {
    const ctx = v.ctx;
    const alpha = 1 - ease.out(Math.min(1, e / 200));
    const faint = 1 - Math.min(1, e / 400);
    const cx = x + w / 2;
    const cy = v.y(hitD + NOTE_HEIGHT / 2);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.translate(cx, cy);
    ctx.scale(1, 0.6);
    // largeFaint: 0.8 → 4 wide over 200 ms, out over 400 ms
    const fw = w * 0.8 * tween(e, 1, 5, 200, ease.outQuint);
    ctx.globalAlpha = alpha * faint;
    v.glow(opacity(mix(accent, WHITE, 0.1), 0.3), 200);
    ctx.fillStyle = css(opacity(mix(accent, WHITE, 0.1), 0.3));
    ctx.beginPath();
    ctx.roundRect(-fw / 2, -NOTE_HEIGHT * 0.4, fw, NOTE_HEIGHT * 0.8, NOTE_HEIGHT * 0.4);
    ctx.fill();
    if (alpha > 0) {
      ctx.globalAlpha = alpha;
      const s = tween(e, 1, 1.4, 200, ease.outQuint);
      const main = mix(accent, WHITE, 0.6);
      v.glow(main, 50);
      ctx.fillStyle = css(main);
      ctx.beginPath();
      ctx.roundRect((-w / 2) * s, (-NOTE_HEIGHT / 2) * s, w * s, NOTE_HEIGHT * s, (NOTE_HEIGHT / 2) * s);
      ctx.fill();
      const streak = mix(accent, WHITE, 0.4);
      v.glow(streak, 40);
      ctx.fillStyle = css(streak);
      const rand = seeded(seed + 7);
      for (let i = 0; i < 2; i++) {
        ctx.save();
        ctx.rotate(((rand() * 30 - 15) * Math.PI) / 180);
        ctx.fillRect(-w * 0.005, -NOTE_HEIGHT * 5, w * 0.01, NOTE_HEIGHT * 10);
        ctx.restore();
      }
    }
    v.glow(null, 0);
    ctx.restore();
  }
}
