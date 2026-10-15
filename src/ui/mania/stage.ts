/* stage.ts — what every skin renderer shares: lazer's stage geometry (columns, hit position,
 * padding), its scroll maths, bar lines, and the per-frame state handed to the renderers. */
import type { ChartData } from "../../lib/types";
import { Autoplay, type ManiaPlay } from "./autoplay";
import type { View } from "./draw";

/** lazer's playfield is laid out 768 units tall (DrawSizePreservingFillContainer, 1024 × 768). */
export const STAGE_HEIGHT = 768;
/** Stage.HIT_TARGET_POSITION: the hit position of skins that don't set one */
export const HIT_TARGET_POSITION = 110;
/** LegacyManiaSkinConfiguration.DEFAULT_HIT_POSITION */
const DEFAULT_HIT_POSITION = (480 - 402) * 1.6;

/** StageDefinition.IsSpecialColumn: the middle column of an odd key count */
export const isSpecial = (col: number, keys: number): boolean => keys % 2 === 1 && col === (keys - 1) / 2;

export interface ColumnBox {
  /** left edge, from the stage's left edge */
  x: number;
  w: number;
}

export interface StageGeometry {
  columns: ColumnBox[];
  /** stage width (ColumnFlow: widths plus each column's left / right spacing) */
  width: number;
  hitPosition: number;
  /** stage padding (argon) */
  padTop: number;
  padBottom: number;
}

/** ColumnFlow.updateColumnSize: each column gets its width and half the spacing on either side. */
export function layoutColumns(widths: number[], left: number[], right: number[]): { columns: ColumnBox[]; width: number } {
  const columns: ColumnBox[] = [];
  let x = 0;
  for (let i = 0; i < widths.length; i++) {
    x += left[i];
    columns.push({ x, w: widths[i] });
    x += widths[i] + right[i];
  }
  return { columns, width: x };
}

/** Bar lines (lazer's BarLineGenerator): one per measure of each timing section. */
export interface BarLine {
  time: number;
  major: boolean;
}

export function barLines(d: ChartData): BarLine[] {
  const out: BarLine[] = [];
  const b = d.beats;
  const n = d.notes;
  let last = 0;
  for (let i = 0; i < n.length; i += 3) last = Math.max(last, n[i] + Math.max(0, n[i + 2]));
  for (let i = 0; i < b.length; i += 3) {
    const meter = b[i + 2] || 4;
    const bar = b[i + 1] * meter;
    if (!(bar > 0)) continue;
    const end = i + 3 < b.length ? b[i + 3] : last + bar;
    let beat = 0;
    // Precision.AlmostBigger(end, t)
    for (let t = b[i]; end - t > -1e-3 && out.length < 100_000; t += bar, beat++) {
      const r = Math.round(t);
      out.push({ time: Math.abs(t - r) < 1e-3 ? r : t, major: beat % meter === 0 });
    }
  }
  return out.sort((a, c) => a.time - c.time);
}

/** Index of the first bar line at or after `t`. */
export function firstBar(bars: BarLine[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Everything a renderer needs for one frame. */
export interface Frame {
  v: View;
  /** song time, ms */
  t: number;
  /** playback rate (lazer runs the key area and column lights on real time) */
  rate: number;
  /** stage left edge, in units */
  x0: number;
  geo: StageGeometry;
  /** what's played: autoplay or a replay */
  auto: ManiaPlay;
  data: ChartData;
  bars: BarLine[];
  /** ms of song time from the top of the scroll area to the hit position */
  timeRange: number;
  /** distance from the bottom (Down layout) of the hit line */
  hitD: number;
  /** distance from the bottom of a time's position */
  posD(time: number): number;
  /** longest hold, so holds that started out of view are still drawn */
  maxHold: number;
  /**
   * Draws the notes: renderers draw every column's notes inside this, with `f.v` (the mods'
   * covers hide parts of them, as lazer's cover a column's hit objects but not the rest).
   */
  notes(draw: () => void): void;
}

/**
 * DrawableManiaRuleset.updateTimeRange: the scroll time at a lazer scroll speed, kept the same
 * across hit positions; `span` is 11485 / speed × rate.
 */
export function timeRange(span: number, hitPosition: number): number {
  return (span * (STAGE_HEIGHT - hitPosition)) / (STAGE_HEIGHT - DEFAULT_HIT_POSITION);
}

export interface Renderer {
  readonly geo: StageGeometry;
  draw(f: Frame): void;
}

export { Autoplay };
