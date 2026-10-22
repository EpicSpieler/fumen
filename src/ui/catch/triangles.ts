/* triangles.ts — lazer's "triangles" skin on the osu!catch playfield: the default pieces (MIT, ppy
 * Pty Ltd):
 *
 *  - FruitPiece: pulps (glowing white dots, in a pattern per fruit) inside a white border that
 *    fades 500 ms before the catch; a red border while it's a hyperdash; DropletPiece one pulp;
 *    BananaPiece a round pulp and a long one;
 *  - DefaultCatcher: lazer's own catcher textures (Gameplay/catch/fruit-catcher-*);
 *  - DefaultHitExplosion: soft glows in the object's colour, two leaning at random.
 *
 * Pulps are drawn once per colour into an offscreen canvas (their glows are blurs) and reused.
 */
import { still } from "../still";
import { preload, tex, type TexRef } from "../../lib/skin/skins";
import { css, darken, ease, mix, opacity, WHITE, type Colour } from "../mania/draw";
import { DEFAULT_COMBO } from "../osu/triangles";
import { BANANA, BASE_SIZE, DROPLET, FRUIT, nextSingle, OBJECT_RADIUS, TINY } from "./chart";
import type { CatcherPiece, CatcherState, CatchFrame, CatchPiece, CatchRenderer, ExplosionPiece } from "./playfield";
import { tinted } from "../mania/draw";

const SIZE = OBJECT_RADIUS * 2;
/** FruitPiece.RADIUS_ADJUST and PulpFormation's sizes */
const RADIUS_ADJUST = 1.1;
const LARGE_PULP_3 = 16 * RADIUS_ADJUST;
const DISTANCE_3 = 0.15;
const LARGE_PULP_4 = LARGE_PULP_3 * 0.925;
const DISTANCE_4 = DISTANCE_3 / 0.925;
const SMALL_PULP = LARGE_PULP_3 / 2;
/** Catcher.DEFAULT_HYPER_DASH_COLOUR */
export const HYPER_RED: Colour = [1, 0, 0, 1];

/** PulpFormation.PositionAt: relative to the piece */
const at = (angle: number, distance: number): [number, number] => [distance * Math.sin((angle * Math.PI) / 180), distance * Math.cos((angle * Math.PI) / 180)];

/** [x, y, width, height] per pulp, relative positions (× 128) and absolute sizes */
type Pulp = [number, number, number, number];
const FORMATIONS: Pulp[][] = [
  // pear
  [[0, -0.33, SMALL_PULP, SMALL_PULP], ...[60, 180, 300].map((a): Pulp => [...at(a, DISTANCE_3), LARGE_PULP_3, LARGE_PULP_3])],
  // grape
  [[0, -0.25, SMALL_PULP, SMALL_PULP], ...[0, 120, 240].map((a): Pulp => [...at(a, DISTANCE_3), LARGE_PULP_3, LARGE_PULP_3])],
  // pineapple
  [[0, -0.3, SMALL_PULP, SMALL_PULP], ...[45, 135, 225, 315].map((a): Pulp => [...at(a, DISTANCE_4), LARGE_PULP_4, LARGE_PULP_4])],
  // raspberry
  [[0, -0.34, SMALL_PULP, SMALL_PULP], ...[0, 90, 180, 270].map((a): Pulp => [...at(a, DISTANCE_4), LARGE_PULP_4, LARGE_PULP_4])],
];
/** BananaPulpFormation */
const BANANA_PULPS: Pulp[] = [
  [0, -0.3, SMALL_PULP, SMALL_PULP],
  [0, 0.05, LARGE_PULP_4 * 0.8, LARGE_PULP_4 * 2.5],
];
/** DropletPiece's one pulp (drawn a quarter of the piece across) */
const DROPLET_PULP: Pulp[] = [[0, 0, LARGE_PULP_3, LARGE_PULP_3]];

/** offscreen pulp drawings: 96 units square, this many pixels per unit */
const CACHE_BOX = 96;
const CACHE_RES = 3;
const cache = new Map<string, HTMLCanvasElement>();

/** Pulps: white circles (0.9, additive) glowing in the colour darkened (0.75), as large as they are. */
function pulps(list: Pulp[], accent: Colour): HTMLCanvasElement {
  const key = `${list === BANANA_PULPS ? "b" : list === DROPLET_PULP ? "d" : FORMATIONS.indexOf(list)}|${css(accent)}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = c.height = CACHE_BOX * CACHE_RES;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(CACHE_RES, 0, 0, CACHE_RES, (CACHE_BOX * CACHE_RES) / 2, (CACHE_BOX * CACHE_RES) / 2);
  const glowColour = css(opacity(darken(accent, 0.2), 0.75));
  const away = 10000;
  for (const [rx, ry, w, h] of list) {
    const x = rx * SIZE;
    const y = ry * SIZE;
    // the glow, from a shape drawn far away (shadow offsets ignore the transform)
    ctx.save();
    ctx.shadowColor = glowColour;
    ctx.shadowBlur = (w / 2) * CACHE_RES;
    ctx.shadowOffsetX = away * CACHE_RES;
    ctx.beginPath();
    ctx.roundRect(x - w / 2 - away, y - h / 2, w, h, Math.min(w, h) / 2);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }
  ctx.globalCompositeOperation = "lighter";
  for (const [rx, ry, w, h] of list) {
    ctx.beginPath();
    ctx.roundRect(rx * SIZE - w / 2, ry * SIZE - h / 2, w, h, Math.min(w, h) / 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
  }
  cache.set(key, c);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return c;
}

function drawPulps(ctx: CanvasRenderingContext2D, list: Pulp[], accent: Colour): void {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(still(pulps(list, accent)), -CACHE_BOX / 2, -CACHE_BOX / 2, CACHE_BOX, CACHE_BOX);
  ctx.restore();
}

/** A circle's border (BorderPiece): `thickness` inside its edge. */
function border(ctx: CanvasRenderingContext2D, diameter: number, thickness: number, colour: string): void {
  ctx.beginPath();
  ctx.arc(0, 0, diameter / 2 - thickness / 2, 0, Math.PI * 2);
  ctx.lineWidth = thickness;
  ctx.strokeStyle = colour;
  ctx.stroke();
}

/** HyperBorderPiece: a thick red border, faintly filled (additive). */
function hyperBorder(ctx: CanvasRenderingContext2D, diameter: number, thickness: number, colour: Colour): void {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.beginPath();
  ctx.arc(0, 0, diameter / 2 - thickness, 0, Math.PI * 2);
  ctx.fillStyle = css(colour, 0.3);
  ctx.fill();
  ctx.restore();
  border(ctx, diameter, thickness, css(colour));
}

/** The default pieces (shared with legacy skins that lack a texture). */
export function defaultPiece(f: CatchFrame, p: CatchPiece): void {
  const ctx = f.ctx;
  if (p.kind === FRUIT) {
    drawPulps(ctx, FORMATIONS[p.visual], p.accent);
    if (p.border > 0) {
      ctx.globalAlpha *= p.border;
      border(ctx, SIZE, 6 * RADIUS_ADJUST, "#fff");
      ctx.globalAlpha /= p.border;
    }
    if (p.hyper) hyperBorder(ctx, SIZE, 12 * RADIUS_ADJUST, HYPER_RED);
  } else if (p.kind === DROPLET || p.kind === TINY) {
    // DropletPiece: one pulp, a quarter of the size
    const s = OBJECT_RADIUS / 2 / LARGE_PULP_3;
    ctx.save();
    ctx.scale(s, s);
    drawPulps(ctx, DROPLET_PULP, p.accent);
    ctx.restore();
    if (p.hyper) hyperBorder(ctx, SIZE / 2, 6, HYPER_RED);
  } else if (p.kind === BANANA) {
    drawPulps(ctx, BANANA_PULPS, p.accent);
    if (p.border > 0) {
      ctx.globalAlpha *= p.border;
      border(ctx, SIZE, 6 * RADIUS_ADJUST, "#fff");
      ctx.globalAlpha /= p.border;
    }
  }
}

/** DefaultHitExplosion: soft glows in the object's colour (lighter towards white), two leaning
 * at random; in 50 ms, out over 400 ms. */
export function defaultExplosion(f: CatchFrame, e: ExplosionPiece): void {
  const s = e.since;
  if (s > 450) return;
  const ctx = f.ctx;
  const alpha = s < 50 ? s / 50 : 1 - ease.out(Math.min(1, (s - 50) / 400));
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(e.x, 0);
  ctx.scale(e.scale, e.scale);
  // a 20 × 20 box standing on the catcher
  ctx.translate(0, -10);
  const soft = (rx: number, ry: number, colour: Colour, a: number) => {
    ctx.save();
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, css(colour, a));
    g.addColorStop(0.4, css(colour, a * 0.45));
    g.addColorStop(1, css(colour, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  // large faint: widening 5× (400 ms OutQuint), fading over 800 ms
  const w = 16 * (1 + 4 * ease.outQuint(Math.min(1, s / 400)));
  soft(w / 2 + 120, 8 + 120, mix(e.accent, WHITE, 0.1), 0.3 * (1 - s / 800));
  // small faint
  soft(10 + 30, 10 + 30, mix(e.accent, WHITE, 0.6), 1);
  // directional glows: thin and tall, leaning up to 15° either way
  for (const series of [4, 5]) {
    ctx.save();
    ctx.rotate(((-15 + nextSingle(e.seed, series) * 30) * Math.PI) / 180);
    soft(0.1 + 24, 100 + 24, mix(e.accent, WHITE, 0.4), 0.8);
    ctx.restore();
  }
  ctx.restore();
}

/** A catcher texture fitted into BASE_SIZE (DefaultCatcher: FillMode.Fit), its top 16 above the
 * catcher's line. */
export function fittedCatcher(ctx: CanvasRenderingContext2D, ref: TexRef | null, colour: Colour): boolean {
  const t = tex(ref);
  if (!t) return false;
  const k = Math.min(BASE_SIZE / t.w, BASE_SIZE / t.h);
  const w = t.w * k;
  const h = t.h * k;
  ctx.drawImage(tinted(t.img, ref!.url, colour), -w / 2, -16, w, h);
  return true;
}

export interface DefaultCatcherTextures {
  idle: TexRef | null;
  fail: TexRef | null;
  kiai: TexRef | null;
}

export async function loadCatcherDefaults(find: (name: string) => TexRef | null): Promise<DefaultCatcherTextures> {
  const t = { idle: find("fruit-catcher-idle"), fail: find("fruit-catcher-fail"), kiai: find("fruit-catcher-kiai") };
  await preload(Object.values(t));
  return t;
}

export function defaultCatcher(ctx: CanvasRenderingContext2D, t: DefaultCatcherTextures, state: CatcherState, colour: Colour): void {
  if (fittedCatcher(ctx, t[state] ?? t.idle, colour)) return;
  // no textures: a plain plate
  ctx.beginPath();
  ctx.roundRect(-BASE_SIZE * 0.4, -4, BASE_SIZE * 0.8, 8, 4);
  ctx.fillStyle = css(colour);
  ctx.fill();
}

export class TrianglesCatchRenderer implements CatchRenderer {
  readonly comboColours = DEFAULT_COMBO;
  readonly hyperColour = HYPER_RED;
  readonly afterImageColour = HYPER_RED;

  constructor(private readonly t: DefaultCatcherTextures) {}

  piece(f: CatchFrame, p: CatchPiece): void {
    defaultPiece(f, p);
  }

  catcher(f: CatchFrame, c: CatcherPiece): void {
    defaultCatcher(f.ctx, this.t, c.state, c.colour);
  }

  explosion(f: CatchFrame, e: ExplosionPiece): void {
    defaultExplosion(f, e);
  }
}
