/* legacy.ts — an osu!stable-style skin on the osu!catch playfield, as lazer's
 * CatchLegacySkinTransformer draws it (MIT, ppy Pty Ltd). Textures come from the skin, then
 * lazer's "classic" skin:
 *
 *  - LegacyFruitPiece: fruit-pear / grapes / apple / orange tinted in the combo colour, their
 *    overlays over them, the texture again behind them 1.2× in the hyperdash fruit colour
 *    (additive, 0.7) for hyperdashes; LegacyDropletPiece fruit-drop (0.8×); LegacyBananaPiece
 *    fruit-bananas; all at most 160 across;
 *  - LegacyCatcherNew: fruit-catcher-idle / fail / kiai (animated), or LegacyCatcherOld:
 *    fruit-ryuuta for skins older than 2.3 that have it; at 0.35 of their size;
 *  - LegacyHitExplosion: classic's scoreboard-explosion textures shooting up in the object's
 *    colour;
 *  - [CatchTheBeat] HyperDash, HyperDashFruit, HyperDashAfterImage colours.
 *
 * The beatmap's own combo colours win over the skin's.
 */
import { frameAt, preload, tex, TextureChain, type Anim, type LoadedSkin, type TexRef } from "../../lib/skin/skins";
import { ease, fromBytes, tinted, type Colour } from "../mania/draw";
import { DEFAULT_COMBO } from "../osu/triangles";
import { sprite } from "../osu/draw";
import { BANANA, BASE_SIZE, ALLOWED_CATCH_RANGE, DROPLET, FRUIT, TINY } from "./chart";
import type { CatcherPiece, CatcherState, CatchFrame, CatchPiece, CatchRenderer, ExplosionPiece } from "./playfield";
import { defaultCatcher, defaultExplosion, defaultPiece, HYPER_RED, type DefaultCatcherTextures } from "./triangles";

const MAX: [number, number] = [160, 160];
/** LegacyCatcher */
const CATCHER_SCALE = 0.5 * 0.7;
/** LegacyFruitPiece's names per look */
const FRUITS = ["pear", "grapes", "apple", "orange"];

/** LegacyColourCompatibility.DisallowZeroAlpha */
const visible = (c: Colour): Colour => (c[3] === 0 ? [c[0], c[1], c[2], 1] : c);
const bytes = (c: [number, number, number] | [number, number, number, number]): Colour => fromBytes([c[0], c[1], c[2], c.length === 4 ? c[3] : 255]);

interface Textures {
  main: TexRef | null;
  overlay: TexRef | null;
}

export class LegacyCatchRenderer implements CatchRenderer {
  readonly comboColours: Colour[];
  readonly hyperColour: Colour;
  readonly afterImageColour: Colour;
  private readonly hyperFruitColour: Colour;
  private readonly chain: TextureChain;
  private readonly fruits: Textures[];
  private readonly drop: Textures;
  private readonly bananas: Textures;
  private readonly catchers: Partial<Record<CatcherState, Anim | null>> = {};
  private explosion1: TexRef | null = null;
  private explosion2: TexRef | null = null;

  private constructor(
    skin: LoadedSkin,
    private readonly defaults: DefaultCatcherTextures,
  ) {
    this.chain = new TextureChain(skin.chain);
    const own = skin.own;
    const combo = own?.ini?.combo ?? [];
    this.comboColours = combo.length ? combo.map((c) => visible(bytes(c))) : DEFAULT_COMBO;
    const colours = own?.ini?.colours;
    const colour = (key: string) => (colours?.get(key) ? visible(bytes(colours.get(key)!)) : null);
    this.hyperColour = colour("HyperDash") ?? HYPER_RED;
    this.afterImageColour = colour("HyperDashAfterImage") ?? this.hyperColour;
    this.hyperFruitColour = colour("HyperDashFruit") ?? this.hyperColour;
    const pair = (name: string): Textures => ({ main: this.chain.texture(name), overlay: this.chain.texture(`${name}-overlay`) });
    this.fruits = FRUITS.map((n) => pair(`fruit-${n}`));
    this.drop = pair("fruit-drop");
    this.bananas = pair("fruit-bananas");
    // old-style catchers only for old skins that have one themselves
    const version = own?.version ?? 1;
    const ryuuta = own && (own.texture("fruit-ryuuta") || own.texture("fruit-ryuuta-0"));
    const anim = (name: string) => this.chain.animation(name, true, true, { applyConfigFrameRate: true });
    if (version < 2.3 && ryuuta) {
      const old = anim("fruit-ryuuta");
      this.catchers = { idle: old, fail: old, kiai: old };
    } else {
      const idle = anim("fruit-catcher-idle");
      this.catchers = { idle, fail: anim("fruit-catcher-fail") ?? idle, kiai: anim("fruit-catcher-kiai") ?? idle };
    }
    // the explosions are always classic's (SkinManager.DefaultClassicSkin)
    const classic = skin.chain[skin.chain.length - 1];
    this.explosion1 = classic?.texture("scoreboard-explosion-2") ?? null;
    this.explosion2 = classic?.texture("scoreboard-explosion-1") ?? null;
  }

  static async create(skin: LoadedSkin, defaults: DefaultCatcherTextures): Promise<LegacyCatchRenderer> {
    const r = new LegacyCatchRenderer(skin, defaults);
    await preload([
      ...r.fruits.flatMap((t) => [t.main, t.overlay]),
      r.drop.main,
      r.drop.overlay,
      r.bananas.main,
      r.bananas.overlay,
      r.explosion1,
      r.explosion2,
      ...Object.values(r.catchers),
    ]);
    return r;
  }

  piece(f: CatchFrame, p: CatchPiece): void {
    const ctx = f.ctx;
    const t = p.kind === FRUIT ? this.fruits[p.visual] : p.kind === BANANA ? this.bananas : this.drop;
    if (!tex(t.main)) {
      defaultPiece(f, p);
      return;
    }
    ctx.save();
    if (p.kind === DROPLET || p.kind === TINY) ctx.scale(0.8, 0.8);
    if (p.hyper) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha *= 0.7;
      sprite(ctx, t.main, 0, 0, { max: MAX, scale: 1.2, tint: this.hyperFruitColour });
      ctx.restore();
    }
    sprite(ctx, t.main, 0, 0, { max: MAX, tint: visible(p.accent) });
    sprite(ctx, t.overlay, 0, 0, { max: MAX });
    ctx.restore();
  }

  catcher(f: CatchFrame, c: CatcherPiece): void {
    const a = this.catchers[c.state] ?? this.catchers.idle;
    const ref = a ? frameAt(a, c.elapsed) : null;
    const t = tex(ref);
    if (!t) {
      defaultCatcher(f.ctx, this.defaults, c.state, c.colour);
      return;
    }
    // OriginPosition (width / 2, 16): its top 16 (of its own units) above the line
    const w = t.w * CATCHER_SCALE;
    const h = t.h * CATCHER_SCALE;
    f.ctx.drawImage(tinted(t.img, ref!.url, c.colour), -w / 2, -16 * CATCHER_SCALE, w, h);
  }

  explosion(f: CatchFrame, e: ExplosionPiece): void {
    const s = e.since;
    if (s >= 700) {
      return;
    }
    const ctx = f.ctx;
    const cs = f.chart.catcherScale;
    // in its half-size space, kept inside the catch area (Catcher.CatchWidth)
    const half = (BASE_SIZE * cs * ALLOWED_CATCH_RANGE) / 2;
    const margin = (1 - ALLOWED_CATCH_RANGE) / 2;
    const x = Math.max(-half + margin * 3, Math.min(half - margin * 3, e.x));
    ctx.save();
    ctx.scale(0.5, 0.5);
    const up = (ref: TexRef | null, sx: number, sy: number, alpha: number) => {
      const t = tex(ref);
      if (!t || alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.translate(x, 0);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(sx, sy);
      ctx.drawImage(tinted(t.img, ref!.url, e.accent), 0, -t.h / 2, t.w, t.h);
      ctx.restore();
    };
    if (!e.droplet) {
      const k = Math.min(1.125, Math.max(0.35, e.combo / 200));
      const p = ease.out(Math.min(1, s / 160));
      up(this.explosion1, 1 + (16 * k - 1) * p, 0.9 + 0.2 * p, 1 - s / 300);
    }
    up(this.explosion2, 0.9, 1 + 0.3 * ease.out(Math.min(1, s / 500)), 1 - s / 700);
    ctx.restore();
    if (!this.explosion2) defaultExplosion(f, e);
  }
}
