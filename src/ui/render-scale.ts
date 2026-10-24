/* render-scale.ts — how many canvas pixels the playfields and the visualizer draw per screen pixel.
 * The screen's ratio normally; less makes each frame cheaper (and softer), for machines that can't
 * keep up. On Linux a canvas gets at most a Full HD screen's worth of pixels: WebKitGTK draws them
 * on the processor there, so each frame costs as much as it has pixels (the visualizer took 77 ms
 * a frame at 3420×1385). */
import { isLinux } from "../lib/api";

let scale = 1;

/** the most canvas pixels on Linux: 1920 × 1080 */
const LINUX_BUDGET = 1920 * 1080;

/**
 * Canvas pixels per CSS pixel for a canvas `w`×`h` CSS pixels: the screen's ratio (at most `max`)
 * times the render scale, and on Linux less again for one bigger than the budget.
 */
export function pixelRatio(w: number, h: number, max = Infinity): number {
  const r = Math.min(window.devicePixelRatio || 1, max) * scale;
  return isLinux && w * h * r * r > LINUX_BUDGET ? Math.sqrt(LINUX_BUDGET / (w * h)) : r;
}

export function setRenderScale(v: number): void {
  scale = Math.max(0.25, Math.min(1, v));
}
