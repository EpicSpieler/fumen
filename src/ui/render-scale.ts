/* render-scale.ts — how many canvas pixels the playfields and the visualizer draw per screen pixel.
 * 1 normally; less makes each frame cheaper (and softer), for machines that can't keep up. Not
 * lowered by itself on Linux: WebKitGTK scales a canvas whose pixels don't match the screen's on
 * the processor there, which cost more than the pixels saved (1.3.14: the playfield went from 44
 * fps to 12 with a Full HD budget). */

let scale = 1;

/** Canvas pixels per CSS pixel: the screen's ratio (at most `max`) times the render scale. */
export const pixelRatio = (max = Infinity): number => Math.min(window.devicePixelRatio || 1, max) * scale;

export function setRenderScale(v: number): void {
  scale = Math.max(0.25, Math.min(1, v));
}
