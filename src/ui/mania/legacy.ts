/* legacy.ts — osu!stable-style skins (.osk) on the mania playfield, drawn like lazer's legacy
 * mania components (MIT, ppy Pty Ltd): LegacyStageBackground, LegacyColumnBackground,
 * LegacyHitTarget, LegacyKeyArea, LegacyNotePiece / HoldNoteHead / HoldNoteTail, LegacyBodyPiece,
 * LegacyHitExplosion, LegacyStageForeground, LegacyBarLine and LegacyManiaJudgementPiece.
 *
 * Settings come from the skin's [Mania] section for the key count (lazer's defaults otherwise);
 * textures from the skin, then from lazer's "classic" skin, as in lazer.
 */
import { BODY_STRETCH, maniaDefaults, type ManiaConfig, type Rgba } from "../../lib/skin/ini";
import { frameAt, preload, tex, TextureChain, type Anim, type LoadedSkin, type TexRef } from "../../lib/skin/skins";
import { lowerBound } from "../../lib/charts";
import { ease, fromBytes, tinted, tween, WHITE, type Colour } from "./draw";
import { Autoplay, firstBar, isSpecial, layoutColumns, type Frame, type Renderer, type StageGeometry } from "./stage";

/** LegacyManiaSkinConfiguration.DEFAULT_COLUMN_SIZE */
const DEFAULT_COLUMN_SIZE = 48;

interface Column {
  key: TexRef | null;
  keyDown: TexRef | null;
  note: Anim | null;
  head: Anim | null;
  tail: Anim | null;
  body: Anim | null;
  light: Anim | null;
  lightColour: Colour;
  background: Colour;
  /** left / right line width, 0 when hidden */
  leftLine: number;
  rightLine: number;
  explosion: Anim | null;
  explosionScale: number;
  holdLight: Anim | null;
  holdLightScale: number;
}

/** LegacyColourCompatibility: a stable colour with alpha 0 means opaque */
const disallowZeroAlpha = (c: Colour): Colour => (c[3] === 0 ? [c[0], c[1], c[2], 1] : c);
/** …and ApplyWithDoubledAlpha: alpha applied twice (0 stays invisible) */
const doubledAlpha = (c: Colour): number => c[3] * disallowZeroAlpha(c)[3];

export class LegacyRenderer implements Renderer {
  readonly geo: StageGeometry;
  private readonly cfg: ManiaConfig;
  private readonly cols: Column[] = [];
  private left: TexRef | null = null;
  private right: TexRef | null = null;
  private hint: TexRef | null = null;
  private bottom: Anim | null = null;
  private judgement: Anim | null = null;
  private readonly lineColour: Colour;
  private readonly judgementLine: Colour;
  private readonly barColour: Colour;
  private readonly stretchBody: boolean;
  private readonly noteHeightWidth: number;
  private readonly version: number;

  private constructor(
    skin: LoadedSkin,
    readonly keys: number,
  ) {
    const own = skin.own!;
    const cfg = own.ini?.mania.get(keys) ?? maniaDefaults(keys);
    this.cfg = cfg;
    this.version = own.version;
    const chain = new TextureChain(skin.chain);
    const colour = (name: string): Colour | null => {
      const c = cfg.colours.get(name);
      return c ? fromBytes(c as Rgba) : null;
    };
    const image = (name: string, fallback: string) => cfg.images.get(name) ?? fallback;

    // ColumnFlow: widths and half the spacing either side
    const left = Array.from({ length: keys }, (_, i) => (i === 0 ? 0 : cfg.columnSpacing[i - 1] / 2));
    const right = Array.from({ length: keys }, (_, i) => (i === keys - 1 ? 0 : cfg.columnSpacing[i] / 2));
    const { columns, width } = layoutColumns(cfg.columnWidth, left, right);
    this.geo = { columns, width, hitPosition: cfg.hitPosition, padTop: 0, padBottom: 0 };

    this.noteHeightWidth = cfg.widthForNoteHeightScale > 0 ? cfg.widthForNoteHeightScale : Math.min(...cfg.columnWidth);
    const style = cfg.noteBodyStyle ?? (this.version < 2.5 ? BODY_STRETCH : 3);
    this.stretchBody = style === BODY_STRETCH;
    this.lineColour = colour("ColourColumnLine") ?? WHITE;
    this.judgementLine = disallowZeroAlpha(colour("ColourJudgementLine") ?? WHITE);
    this.barColour = colour("ColourBarline") ?? WHITE;

    this.left = chain.texture(image("StageLeft", "mania-stage-left"));
    this.right = chain.texture(image("StageRight", "mania-stage-right"));
    this.hint = chain.texture(image("StageHint", "mania-stage-hint"));
    this.bottom = chain.animation(image("StageBottom", "mania-stage-bottom"), true, true);
    const lightImage = image("StageLight", "mania-stage-light");
    const effectFrames = (name: string, loop: boolean): Anim | null => {
      // lazer sizes the frame length from a first lookup of the frame count
      const probe = chain.animation(name, true, false);
      const n = probe?.frames.length ?? 0;
      return chain.animation(name, true, loop, { frameLength: n > 1 ? Math.max(1000 / 60, 170 / n) : 0 });
    };
    const explosion = effectFrames(image("LightingN", "lightingN"), false);
    const holdLight = effectFrames(image("LightingL", "lightingL"), true);

    // the judgement comes from the skin itself, else from classic (each with its own setting)
    const judgementFrom = (c: TextureChain, name: string) => c.animation(name, true, true, { frameLength: 1000 / 20 });
    this.judgement =
      judgementFrom(new TextureChain([own]), image("Hit300g", "mania-hit300g")) ??
      (skin.chain[1] ? judgementFrom(new TextureChain([skin.chain[1]]), "mania-hit300g") : null);

    for (let i = 0; i < keys; i++) {
      // LegacyManiaColumnElement.FallbackColumnIndex
      const fb = isSpecial(i, keys) ? "S" : Math.min(i, keys - 1 - i) % 2 === 0 ? "1" : "2";
      const noteAnim = (lookup: string, suffix: string) => chain.animation(image(lookup, `mania-note${fb}${suffix}`), true, true);
      const note = noteAnim(`NoteImage${i}`, "");
      const head = noteAnim(`NoteImage${i}H`, "H") ?? note;
      const tail = noteAnim(`NoteImage${i}T`, "T") ?? head;
      const versionOk = this.version >= 2.5;
      this.cols.push({
        key: chain.texture(image(`KeyImage${i}`, `mania-key${fb}`)),
        keyDown: chain.texture(image(`KeyImage${i}D`, `mania-key${fb}D`)),
        note,
        head,
        tail,
        body: chain.animation(image(`NoteImage${i}L`, `mania-note${fb}L`), true, true, { frameLength: 30 }),
        light: chain.animation(lightImage, true, true, { frameLength: 1000 / cfg.lightFramePerSecond }),
        lightColour: disallowZeroAlpha(colour(`ColourLight${i + 1}`) ?? WHITE),
        background: colour(`Colour${i + 1}`) ?? [0, 0, 0, 1],
        leftLine: cfg.columnLineWidth[i] > 0 ? cfg.columnLineWidth[i] : 0,
        rightLine: (cfg.columnLineWidth[i + 1] > 0 && this.version >= 2.4) || i === keys - 1 ? cfg.columnLineWidth[i + 1] : 0,
        explosion,
        explosionScale: !versionOk ? 1 : (cfg.explosionWidth[i] || cfg.columnWidth[i]) / DEFAULT_COLUMN_SIZE,
        holdLight,
        holdLightScale: !versionOk ? 1 : (cfg.holdNoteLightWidth[i] || cfg.columnWidth[i]) / DEFAULT_COLUMN_SIZE,
      });
    }
  }

  static async create(skin: LoadedSkin, keys: number): Promise<LegacyRenderer> {
    const r = new LegacyRenderer(skin, keys);
    await preload([r.left, r.right, r.hint, r.bottom, r.judgement, ...r.cols.flatMap((c) => [c.key, c.keyDown, c.note, c.head, c.tail, c.body, c.light, c.explosion, c.holdLight])]);
    return r;
  }

  /** a note piece's height: the texture scaled to the column width, height by WidthForNoteHeightScale */
  private noteHeight(t: { w: number; h: number }): number {
    return (t.h * this.noteHeightWidth) / t.w;
  }

  draw(f: Frame): void {
    const { v, t, x0, geo, auto } = f;
    const ctx = v.ctx;
    const S = v.S;
    const cfg = this.cfg;
    const keys = this.keys;
    // the key area and column lights run on the game clock (real time), the rest on the song's
    const real = (ms: number) => ms / f.rate;

    // ── stage background (LegacyStageBackground) ──
    const sideL = tex(this.left);
    if (sideL) v.image(sideL.img, 0, 0, sideL.img.naturalWidth, sideL.img.naturalHeight, x0 + 0.05 - sideL.w, sideL.w, 0, S, false);
    const sideR = tex(this.right);
    if (sideR) v.image(sideR.img, 0, 0, sideR.img.naturalWidth, sideR.img.naturalHeight, x0 + geo.width - 0.05, sideR.w, 0, S, false);
    for (let i = 0; i < keys; i++) {
      const c = this.cols[i];
      const box = geo.columns[i];
      const x = x0 + box.x;
      const a = doubledAlpha(c.background);
      if (a > 0) {
        ctx.fillStyle = rgba(c.background, a);
        v.rect(x, box.w, 0, S);
      }
      const la = doubledAlpha(this.lineColour);
      if (la > 0) {
        ctx.fillStyle = rgba(this.lineColour, la);
        // inside HitTargetInsetContainer: from the hit position up
        if (c.leftLine > 0) v.rect(x, c.leftLine * 0.74, cfg.hitPosition, S);
        if (c.rightLine > 0) v.rect(x + box.w + (i === keys - 1 ? -0.16 : 0), c.rightLine * 0.74, cfg.hitPosition, S);
      }
    }
    const hint = tex(this.hint);
    if (hint) {
      const h = hint.h * 0.9 * 1.6025;
      v.image(hint.img, 0, 0, hint.img.naturalWidth, hint.img.naturalHeight, x0, geo.width, cfg.hitPosition - h / 2, cfg.hitPosition + h / 2);
    }
    if (cfg.showJudgementLine) {
      ctx.fillStyle = rgba(this.judgementLine, 0.9 * this.judgementLine[3]);
      v.rect(x0, geo.width, cfg.hitPosition - 1, cfg.hitPosition);
    }

    // ── column lights (LegacyColumnBackground) ──
    for (let i = 0; i < keys; i++) {
      const c = this.cols[i];
      if (!c.light) continue;
      const k = auto.key(i, t);
      let alpha = 1;
      let scaleY = 1;
      if (!k.down) {
        const e = real(t - k.released);
        if (!(e < 250)) continue;
        alpha = scaleY = 1 - e / 250;
      }
      const fr = tex(frameAt(c.light, real(t)));
      if (!fr) continue;
      const box = geo.columns[i];
      ctx.globalAlpha = alpha * c.lightColour[3];
      const d0 = cfg.lightPosition;
      v.image(tinted(fr.img, frameAt(c.light, real(t)).url, c.lightColour), 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, x0 + box.x, box.w, d0, d0 + fr.h * scaleY);
      ctx.globalAlpha = 1;
    }

    // ── bar lines ──
    if (cfg.barLineHeight > 0 && this.barColour[3] > 0) {
      const tTop = this.timeAtD(f, S + 10);
      for (let bi = firstBar(f.bars, t - 150); bi < f.bars.length; bi++) {
        const b = f.bars[bi];
        if (b.time > tTop) break;
        const e = t - b.time;
        const d = f.posD(b.time) + 0.5;
        ctx.fillStyle = rgba(this.barColour, this.barColour[3] * (e > 0 ? 1 - e / 150 : 1));
        v.rect(x0, geo.width, d - cfg.barLineHeight / 2, d + cfg.barLineHeight / 2);
      }
    }

    // ── columns: notes and keys ──
    const tFar = this.timeAtD(f, S + 1000);
    const n = f.data.notes;
    const from = lowerBound(n, t - f.maxHold - 1);
    const to = lowerBound(n, tFar);
    for (let i = 0; i < keys; i++) {
      if (cfg.keysUnderNotes) this.drawKey(f, i);
      // earlier objects on top, as lazer sorts them
      for (let j = to - 3; j >= from; j -= 3) {
        if (n[j + 1] !== i) continue;
        this.drawObject(f, i, n[j], n[j + 2]);
      }
      if (!cfg.keysUnderNotes) this.drawKey(f, i);
    }

    // ── stage foreground (LegacyStageForeground) ──
    if (this.bottom) {
      const fr = tex(frameAt(this.bottom, t));
      if (fr) {
        const w = fr.w * 1.6;
        const h = fr.h * 1.6;
        v.image(fr.img, 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, x0 + (geo.width - w) / 2, w, 0, h, false);
      }
    }

    // ── judgement (LegacyManiaJudgementPiece; autoplay only ever gets 300g) ──
    if (this.judgement) {
      const hitT = auto.lastHit(t);
      const e = t - hitT;
      if (e >= 0 && e < 220) {
        const fr = tex(frameAt(this.judgement, e));
        if (fr) {
          const fromTop = 768 - cfg.hitPosition;
          const centre = cfg.scorePosition > fromTop / 2 ? f.hitD + fromTop - cfg.scorePosition : S - cfg.scorePosition;
          const scale = e < 40 ? tween(e, 0.8, 1, 40) : e < 80 ? tween(e - 40, 0.85, 0.7, 40) : e < 180 ? 0.7 : tween(e - 180, 0.7, 0.4, 40, ease.in);
          ctx.globalAlpha = e < 20 ? tween(e, 0, 1, 20, ease.out) : e < 180 ? 1 : tween(e - 180, 1, 0, 40, ease.in);
          const w = fr.w * scale;
          const h = fr.h * scale;
          v.image(fr.img, 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, x0 + (geo.width - w) / 2, w, centre - h / 2, centre + h / 2, false);
          ctx.globalAlpha = 1;
        }
      }
    }

    // ── top level: hit explosions and hold lights ──
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < keys; i++) {
      const c = this.cols[i];
      const box = geo.columns[i];
      const cx = x0 + box.x + box.w / 2;
      if (c.explosion) {
        const hits = auto.hits[i];
        for (let h = Autoplay.upper(hits, t) - 1; h >= 0 && t - hits[h] < 200; h--) {
          const e = t - hits[h];
          const fr = tex(frameAt(c.explosion, e));
          if (!fr) continue;
          ctx.globalAlpha = e < 80 ? e / 80 : 1 - (e - 80) / 120;
          const w = fr.w * c.explosionScale;
          const hgt = fr.h * c.explosionScale;
          v.image(fr.img, 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, cx - w / 2, w, f.hitD - hgt / 2, f.hitD + hgt / 2, false);
        }
      }
      if (c.holdLight) {
        const hold = this.holdAt(f, i);
        if (hold) {
          const [start, end] = hold;
          const e = t - start;
          const fr = tex(frameAt(c.holdLight, e));
          if (fr) {
            const inA = Math.min(1, e / 80);
            ctx.globalAlpha = t < end ? inA : Math.min(1, (end - start) / 80) * (1 - (t - end) / 120);
            const w = fr.w * c.holdLightScale;
            const hgt = fr.h * c.holdLightScale;
            v.image(fr.img, 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, cx - w / 2, w, f.hitD - hgt / 2, f.hitD + hgt / 2, false);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** The time whose position is `d` from the bottom. */
  private timeAtD(f: Frame, d: number): number {
    const len = f.v.S - f.geo.padTop - f.geo.padBottom - f.geo.hitPosition;
    return f.t + ((d - f.hitD) / Math.max(1, len)) * f.timeRange;
  }

  /** The hold being held in a column at `t` (or let go less than 120 ms ago): [start, end]. */
  private holdAt(f: Frame, col: number): [number, number] | null {
    const n = f.data.notes;
    for (let j = lowerBound(n, f.t + 1) - 3; j >= 0 && f.t - n[j] <= f.maxHold + 120; j -= 3) {
      if (n[j + 1] !== col || !(n[j + 2] > 0)) continue;
      const end = n[j] + n[j + 2];
      if (f.t < end + 120) return [n[j], end];
      return null;
    }
    return null;
  }

  private drawKey(f: Frame, i: number): void {
    const c = this.cols[i];
    const k = f.auto.key(i, f.t);
    const down = k.down || (f.t - k.released) / f.rate < 80;
    const ref = down ? c.keyDown : c.key;
    const fr = tex(ref);
    if (!fr) return;
    const box = f.geo.columns[i];
    f.v.image(fr.img, 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, f.x0 + box.x, box.w, 0, fr.h);
  }

  private drawObject(f: Frame, i: number, start: number, len: number): void {
    const { v, t } = f;
    const c = this.cols[i];
    const box = f.geo.columns[i];
    const x = f.x0 + box.x;
    const w = box.w;
    const pos = f.posD(start);
    if (!(len > 0)) {
      // notes vanish when hit
      if (t >= start || !c.note) return;
      const fr = tex(frameAt(c.note, t - start + f.timeRange));
      if (!fr) return;
      const h = this.noteHeight(fr);
      if (pos > v.S || pos + h < 0) return;
      v.image(fr.img, 0, 0, fr.img.naturalWidth, fr.img.naturalHeight, x, w, pos, pos + h);
      return;
    }
    const end = start + len;
    // the hold is judged (and gone) at its end
    if (t >= end) return;
    const head = c.head ? tex(frameAt(c.head, t - start + f.timeRange)) : null;
    const tail = c.tail ? tex(frameAt(c.tail, t - start + f.timeRange)) : null;
    const headH = head ? this.noteHeight(head) : 0;
    const tailH = tail ? this.noteHeight(tail) : 0;
    const endPos = f.posD(end);
    if (pos - headH > v.S || endPos + tailH < -10) return;
    // being held: the head stays on the hit position and the body is cut there
    const sizingBottom = t >= start ? f.hitD : pos;
    const ctx = v.ctx;
    ctx.save();
    v.clip(x, w, sizingBottom + headH / 2, Math.max(sizingBottom + headH / 2, endPos + tailH));
    const body = c.body ? tex(frameAt(c.body, t >= start ? t - start : 0)) : null;
    if (body) {
      const d0 = pos + headH / 2;
      const d1 = endPos + tailH / 2;
      const bodyH = d1 - d0;
      if (bodyH > 0) {
        if (this.stretchBody) v.image(body.img, 0, 0, body.img.naturalWidth, body.img.naturalHeight, x, w, d0, d1);
        else {
          // lazer stretches the texture over max(body, 32800) units from the tail end down
          const q = Math.max(bodyH, 32800);
          v.image(body.img, 0, 0, body.img.naturalWidth, (body.img.naturalHeight * bodyH) / q, x, w, d0, d1);
        }
      }
    }
    if (tail) {
      // tails are drawn upside down (and the right way up when scrolling up)
      const [top, bottom] = v.band(endPos, endPos + tailH);
      v.drawImage(tail.img, 0, 0, tail.img.naturalWidth, tail.img.naturalHeight, x, top, w, bottom - top, !v.up);
    }
    ctx.restore();
    if (head) v.image(head.img, 0, 0, head.img.naturalWidth, head.img.naturalHeight, x, w, sizingBottom, sizingBottom + headH);
  }
}

const rgba = (c: Colour, alpha: number): string =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.max(0, Math.min(1, alpha))})`;
