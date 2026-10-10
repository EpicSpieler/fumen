/* playfield.ts — the osu!mania playfield in a lazer skin: picks the renderer for the skin, lays the
 * stage out in lazer's 768-unit space scaled to the canvas, and runs autoplay over the chart. */
import type { LoadedSkin } from "../../lib/skin/skins";
import type { ChartData } from "../../lib/types";
import { ArgonRenderer } from "./argon";
import { View } from "./draw";
import { LegacyRenderer } from "./legacy";
import { Autoplay, barLines, STAGE_HEIGHT, timeRange, type BarLine, type Renderer } from "./stage";
import { TrianglesRenderer } from "./triangles";

/** Whether a legacy skin skins osu!mania itself (ManiaLegacySkinTransformer.hasKeyTexture). */
function hasKeyTexture(skin: LoadedSkin, keys: number): boolean {
  const own = skin.own;
  if (!own) return false;
  const name = own.ini?.mania.get(keys)?.images.get("KeyImage0") ?? "mania-key1";
  return !!(own.texture(`${name}-0`) ?? own.texture(name));
}

/** The renderer for a skin at a key count, its textures loaded. */
export async function createRenderer(skin: LoadedSkin, keys: number): Promise<Renderer> {
  switch (skin.entry.kind) {
    case "argon":
      return new ArgonRenderer(keys);
    case "argon-pro":
      return new ArgonRenderer(keys, true);
    case "triangles":
      return new TrianglesRenderer(keys);
  }
  // a legacy skin without mania textures uses lazer's classic ones; without those, triangles
  const classic = skin.chain.length > 1 || skin.entry.kind === "classic";
  if (!skin.own || (!hasKeyTexture(skin, keys) && !classic)) return new TrianglesRenderer(keys);
  return LegacyRenderer.create(skin, keys);
}

export class ManiaPlayfield {
  readonly auto: Autoplay;
  private readonly bars: BarLine[];
  private readonly maxHold: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly data: ChartData,
    private renderer: Renderer,
  ) {
    this.auto = new Autoplay(data.notes, data.keys);
    this.bars = barLines(data);
    let max = 0;
    for (let i = 2; i < data.notes.length; i += 3) max = Math.max(max, data.notes[i]);
    this.maxHold = max;
  }

  setRenderer(r: Renderer): void {
    this.renderer = r;
  }

  /**
   * Draws the chart at `t` (song ms). `span`: lazer's scroll time at the scroll speed, times the
   * rate (11485 / speed × rate); `up`: lazer's "Up" direction.
   */
  draw(t: number, span: number, up: boolean, rate: number): void {
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

    const r = this.renderer;
    const geo = r.geo;
    // lazer scales its 768-unit stage to the height; narrow areas scale it down to fit the width
    const scale = Math.min(H / STAGE_HEIGHT, W / (geo.width + 8));
    const S = H / scale;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    const v = new View(ctx, S, up, dpr * scale);
    const hitD = geo.padBottom + geo.hitPosition;
    const len = S - geo.padTop - geo.padBottom - geo.hitPosition;
    const range = timeRange(span, geo.hitPosition);
    r.draw({
      v,
      t,
      rate,
      x0: (W / scale - geo.width) / 2,
      geo,
      auto: this.auto,
      data: this.data,
      bars: this.bars,
      timeRange: range,
      hitD,
      posD: (time) => hitD + ((time - t) / range) * len,
      maxHold: this.maxHold,
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
