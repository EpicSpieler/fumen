/* argon.ts — lazer's "argon" skin on the osu!catch playfield (MIT, ppy Pty Ltd):
 *
 *  - ArgonFruitPiece: a white dot inside three blob rings in the combo colour (additive), turning
 *    against each other; a red blob ring around it while it's a hyperdash; ArgonDropletPiece two
 *    smaller rings; ArgonBananaPiece a fruit piece with a lens flare that fades as it falls;
 *  - ArgonCatcher: a white bar the width of the catch area, bumpers at its ends and faint lines
 *    out to the sides;
 *  - ArgonHitExplosion: a glow shooting up (higher with the combo) over a wide faint one.
 *
 * osu!'s CircularBlob (a ring whose edge wobbles with noise) is drawn as a path per seed.
 */
import { css, ease, mix, WHITE, type Colour } from "../mania/draw";
import { ARGON_COMBO } from "../osu/argon";
import { BANANA, BASE_SIZE, ALLOWED_CATCH_RANGE, DROPLET, OBJECT_RADIUS, TINY } from "./chart";
import type { CatcherPiece, CatchFrame, CatchPiece, CatchRenderer, ExplosionPiece } from "./playfield";
import { HYPER_RED } from "./triangles";

const SIZE = OBJECT_RADIUS * 2;

/** A small seeded generator (lazer's RNG differs per drawable; a seed keeps a piece the same). */
function random(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const blobs = new Map<string, Path2D>();

/** CircularBlob, 1 across: an outer edge wobbling inwards by up to 0.3 of the radius (frequency
 * 1.5), and an inner edge `inner` of the radius in from it. */
function blob(seed: number, inner: number): Path2D {
  const key = `${seed}|${inner}`;
  let p = blobs.get(key);
  if (p) return p;
  const r = random(seed);
  const waves = [0, 1, 2].map((k) => ({ f: 1 + k + Math.floor(r() * 2), phase: r() * Math.PI * 2, w: 1 / (k + 1.5) }));
  const total = waves.reduce((s, w) => s + w.w, 0);
  const N = 72;
  const outer: [number, number][] = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    let n = 0;
    for (const w of waves) n += w.w * (0.5 + 0.5 * Math.sin(a * w.f * 1.5 + w.phase));
    const radius = 0.5 * (1 - 0.3 * (n / total));
    outer.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  p = new Path2D();
  outer.forEach(([x, y], k) => (k ? p!.lineTo(x, y) : p!.moveTo(x, y)));
  p.closePath();
  // the inner edge, the other way round
  for (let k = N - 1; k >= 0; k--) {
    const [x, y] = outer[k];
    const k2 = 1 - inner;
    if (k === N - 1) p.moveTo(x * k2, y * k2);
    else p.lineTo(x * k2, y * k2);
  }
  p.closePath();
  blobs.set(key, p);
  if (blobs.size > 600) blobs.delete(blobs.keys().next().value!);
  return p;
}

function drawBlob(ctx: CanvasRenderingContext2D, seed: number, inner: number, diameter: number, rotation: number, colour: Colour, alpha: number): void {
  if (alpha <= 0) return;
  ctx.save();
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.scale(diameter, diameter);
  ctx.fillStyle = css(colour, alpha);
  ctx.fill(blob(seed, inner), "evenodd");
  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, d: number): void {
  ctx.beginPath();
  ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
}

export class ArgonCatchRenderer implements CatchRenderer {
  readonly comboColours = ARGON_COMBO;
  readonly hyperColour = HYPER_RED;
  readonly afterImageColour = HYPER_RED;

  piece(f: CatchFrame, p: CatchPiece): void {
    const ctx = f.ctx;
    const r = random(p.i + 1);
    const large = Math.floor(r() * 1e9);
    const seeds = [large, Math.floor(r() * 1e9), Math.floor(r() * 1e9)];
    const spin = 0.2 + r() * 0.8;
    const elapsed = Math.max(0, p.since);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (p.kind === DROPLET || p.kind === TINY) {
      // ArgonDropletPiece: two rings at 0.7, turning the other way
      dot(ctx, 20);
      const s = 0.7;
      drawBlob(ctx, seeds[0], 0.5, SIZE * s, -elapsed * 0.4 * spin, p.accent, 0.15);
      drawBlob(ctx, seeds[1], 0.4, SIZE * s * 0.7, -elapsed * 0.4 * spin * 0.5, p.accent, 0.5);
      if (p.hyper) drawBlob(ctx, large, 0.5, SIZE * s, 0, HYPER_RED, 0.15);
    } else {
      // ArgonFruitPiece: three rings, the outer two turning against each other
      const dir = r() < 0.5 ? -1 : 1;
      const turn = (k: number) => elapsed * 0.04 * k * spin * dir * (k % 2 === 1 ? 1 : -1);
      dot(ctx, 20);
      drawBlob(ctx, seeds[0], 0.5, SIZE * 1.1, turn(0), p.accent, 0.15);
      drawBlob(ctx, seeds[1], 0.2, SIZE, turn(1), p.accent, 0.5);
      drawBlob(ctx, seeds[2], 0.05, SIZE, turn(2), p.accent, 1);
      if (p.hyper) drawBlob(ctx, large, 0.08, SIZE * 1.15, 0, HYPER_RED, 1);
      if (p.kind === BANANA) this.flare(ctx, p);
    }
    ctx.restore();
  }

  /** ArgonBananaPiece: a lens flare kept level and its width, gone by 80% of the fall. */
  private flare(ctx: CanvasRenderingContext2D, p: CatchPiece): void {
    const d = p.duration;
    const from = d * 0.3;
    const to = d * 0.8;
    const alpha = p.since <= from ? 1 : p.since >= to ? 0 : 1 - ease.outQuint((p.since - from) / (to - from));
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.save();
    ctx.rotate((-p.rotation * Math.PI) / 180);
    const stretch = 0.4 + 0.6 / Math.max(0.01, p.size);
    ctx.scale(stretch, 1);
    // a long soft line through the middle
    ctx.beginPath();
    ctx.ellipse(0, 0, 100, 4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fill();
    const w = SIZE * 1.6;
    const left = ctx.createLinearGradient(-w, 0, 0, 0);
    left.addColorStop(0, "rgba(255,255,255,0)");
    left.addColorStop(1, "rgba(255,255,255,0.8)");
    ctx.fillStyle = left;
    ctx.fillRect(-w, -1, w, 2);
    const right = ctx.createLinearGradient(0, 0, w, 0);
    right.addColorStop(0, "rgba(255,255,255,0.8)");
    right.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = right;
    ctx.beginPath();
    ctx.roundRect(0, -1, w, 2, 1);
    ctx.fill();
    ctx.restore();
    // a faint ring with a soft glow
    const g = ctx.createRadialGradient(0, 0, SIZE * 0.6, 0, 0, SIZE * 0.6 + 50);
    g.addColorStop(0, "rgba(255,255,255,0.1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, SIZE * 0.6 + 50, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, SIZE * 0.6 - 1.5, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.stroke();
    ctx.restore();
  }

  catcher(f: CatchFrame, c: CatcherPiece): void {
    const ctx = f.ctx;
    const colour = css(c.colour);
    const w = BASE_SIZE;
    const bumper = ((1 - ALLOWED_CATCH_RANGE) / 2) * w;
    ctx.fillStyle = colour;
    // the bar over the catch area
    const bar = w * ALLOWED_CATCH_RANGE;
    ctx.beginPath();
    ctx.roundRect(-bar / 2, -5, bar, 10, 5);
    ctx.fill();
    // bumpers at the ends
    ctx.beginPath();
    ctx.roundRect(-w / 2, -2, bumper, 4, 2);
    ctx.roundRect(w / 2 - bumper, -2, bumper, 4, 2);
    ctx.fill();
    // faint lines out to the sides
    ctx.globalAlpha *= 0.25;
    ctx.fillRect(-w / 2 - w * 20, -0.9, w * 20, 1.8);
    ctx.fillRect(w / 2, -0.9, w * 20, 1.8);
  }

  explosion(f: CatchFrame, e: ExplosionPiece): void {
    const s = e.since;
    if (s > 800) return;
    const ctx = f.ctx;
    const alpha = 1 - s / 400;
    ctx.save();
    ctx.translate(e.x, 0);
    ctx.scale(e.scale, e.scale);
    // the wide faint glow, over 400 ms
    if (alpha > 0) {
      ctx.globalAlpha *= alpha;
      const g = ctx.createRadialGradient(0, -10, 0, 0, -10, 60);
      const c = mix(e.accent, WHITE, 0.2);
      g.addColorStop(0, css(c, 0.9));
      g.addColorStop(0.3, css(c, 0.35));
      g.addColorStop(1, css(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-60, -70, 120, 120);
      ctx.globalAlpha /= alpha;
    }
    // the tall one (not for droplets): up quickly, higher with the combo, then back down
    if (!e.droplet && alpha > 0) {
      const k = Math.min(1.125, Math.max(0.35, e.combo / 200));
      const tall = s < 200 ? 1 + (20 * k - 1) * ease.outQuint(s / 200) : 20 * k + (1 - 20 * k) * ease.in(Math.min(1, (s - 200) / 600));
      const h = 20 * tall;
      const w = 2 * 1.1;
      ctx.globalAlpha *= alpha;
      const g = ctx.createLinearGradient(-w / 2 - 15, 0, w / 2 + 15, 0);
      g.addColorStop(0, css(e.accent, 0));
      g.addColorStop(0.5, css(e.accent, 1));
      g.addColorStop(1, css(e.accent, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(-w / 2 - 15, -h - 15, w + 30, h + 30, 15);
      ctx.fill();
    }
    ctx.restore();
  }
}
