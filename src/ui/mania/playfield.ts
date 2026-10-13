/* playfield.ts — the osu!mania playfield in a lazer skin: picks the renderer for the skin, lays the
 * stage out in lazer's 768-unit space scaled to the canvas, and runs autoplay over the chart.
 *
 * The mods it draws (MIT, ppy Pty Ltd; Mirror comes built into the chart):
 *  - ManiaModHidden / ManiaModFadeIn (PlayfieldCoveringWrapper, LegacyPlayfieldCover): each column's
 *    notes covered from the hit line up (Hidden) or from the top down (Fade In), 160 of 768 units
 *    plus half a unit per combo up to 400, then a gradient a quarter of the column long; nothing
 *    in break time;
 *  - ManiaModFlashlight: black but for a band across the middle, 50 units either way, twice and a
 *    half that in breaks. */
import type { Mod } from "../../lib/mods";
import type { LoadedSkin } from "../../lib/skin/skins";
import type { ChartData } from "../../lib/types";
import { breakPeriods, Combo, drawBandLight, FlashlightSize, inPeriod, type FlashlightSpec } from "../flashlight";
import { ArgonRenderer } from "./argon";
import { View } from "./draw";
import { LegacyRenderer } from "./legacy";
import { Autoplay, barLines, STAGE_HEIGHT, timeRange, type BarLine, type Frame, type Renderer } from "./stage";
import { TrianglesRenderer } from "./triangles";

/** ManiaModHidden: the cover, in 768 units from the hit position */
const MIN_COVERAGE = 160;
const MAX_COVERAGE = 400;
const COVERAGE_PER_COMBO = 0.5;
/** PlayfieldCoveringWrapper: the gradient past the cover, of the column's length */
const COVER_GRADIENT = 0.25;
/** ManiaModFlashlight: not by combo; the default smoothness */
const FLASHLIGHT: FlashlightSpec = { size: 50, breakScale: 2.5 };
const FL_SMOOTHNESS = 1.1;

interface ModState {
  combo: Combo;
  breaks: [number, number][];
  /** Hidden: from the hit line up; Fade In: from the top down */
  cover: "hidden" | "fade-in" | null;
  light: FlashlightSize | null;
}

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
  private mods: ModState | null = null;
  /** the notes, drawn apart to be covered */
  private layer: HTMLCanvasElement | null = null;

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

  /** The mods it draws (Hidden, Fade In, Flashlight). */
  setMods(mods: readonly Mod[]): void {
    const cover = mods.includes("HD") ? "hidden" : mods.includes("FI") ? "fade-in" : null;
    const fl = mods.includes("FL");
    if (!cover && !fl) {
      this.mods = null;
      return;
    }
    let state = this.mods;
    if (!state) {
      // notes, and a hold's head and tail, add to the combo
      const n = this.data.notes;
      const times: number[] = [];
      for (let i = 0; i < n.length; i += 3) {
        times.push(n[i]);
        if (n[i + 2] > 0) times.push(n[i] + n[i + 2]);
      }
      const combo = new Combo(times);
      state = { combo, breaks: breakPeriods(this.data, combo), cover: null, light: null };
    }
    state.cover = cover;
    state.light = fl ? (state.light ?? new FlashlightSize(FLASHLIGHT, state.combo, state.breaks)) : null;
    this.mods = state;
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
    const mods = this.mods;
    const frame: Frame = {
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
      notes: (draw) => {
        if (!mods?.cover || inPeriod(mods.breaks, t)) return draw();
        // the notes into a layer of their own, the cover cut out of it, then onto the stage
        const layer = (this.layer ??= document.createElement("canvas"));
        if (layer.width !== bw || layer.height !== bh) {
          layer.width = bw;
          layer.height = bh;
        }
        const lc = layer.getContext("2d")!;
        lc.setTransform(1, 0, 0, 1, 0, 0);
        lc.clearRect(0, 0, bw, bh);
        lc.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
        const lv = new View(lc, S, up, dpr * scale);
        frame.v = lv;
        try {
          draw();
        } finally {
          frame.v = v;
        }
        // LegacyPlayfieldCover: osu!stable's cover is in 768 units from the hit position
        const coverage = Math.min(MAX_COVERAGE, MIN_COVERAGE + mods.combo.at(t) * COVERAGE_PER_COMBO);
        const h = (coverage / Math.max(1, STAGE_HEIGHT - geo.hitPosition)) * len;
        const fade = COVER_GRADIENT * len;
        const top = S - geo.padTop;
        lc.globalCompositeOperation = "destination-out";
        for (const box of geo.columns) {
          const x = frame.x0 + box.x;
          if (mods.cover === "hidden") {
            // what's below the hit line goes too (lazer's cover clips its column there)
            lc.fillStyle = "#000";
            lv.rect(x, box.w, 0, hitD + h);
            lc.fillStyle = lv.gradient(hitD + h, hitD + h + fade, "#000", "rgba(0,0,0,0)");
            lv.rect(x, box.w, hitD + h, hitD + h + fade);
          } else {
            // and what's above the top
            lc.fillStyle = "#000";
            lv.rect(x, box.w, top - h, S);
            lc.fillStyle = lv.gradient(top - h, top - h - fade, "#000", "rgba(0,0,0,0)");
            lv.rect(x, box.w, top - h - fade, top - h);
          }
        }
        lc.globalCompositeOperation = "source-over";
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
      },
    };
    r.draw(frame);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // ManiaFlashlight: a band across the middle of the whole area, over everything
    if (mods?.light) drawBandLight(ctx, bw, bh, bh / 2, mods.light.at(t) * dpr * scale, FL_SMOOTHNESS);
  }
}
