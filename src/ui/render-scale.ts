/* render-scale.ts — how many canvas pixels the playfields and the visualizer draw per screen pixel.
 * 1 normally; less makes each frame cheaper (and softer), for machines that can't keep up. */

let scale = 1;

/** Canvas pixels per CSS pixel: the screen's ratio times the render scale. */
export const pixelRatio = (): number => (window.devicePixelRatio || 1) * scale;

export const renderScale = (): number => scale;

export function setRenderScale(v: number): void {
  scale = Math.max(0.25, Math.min(1, v));
}
