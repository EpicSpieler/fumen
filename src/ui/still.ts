/* still.ts — pictures drawn once into a canvas and never changed again, as ImageBitmaps.
 *
 * WebKitGTK (Linux) draws the playfield's canvas on the graphics card, but small canvases in
 * memory. Drawing one into the other copies it (it might have changed since) and sends the copy up
 * to the card again, every single draw: hundreds a frame for glows and tinted skin pieces. An
 * ImageBitmap can't change, so it goes up once and stays. Elsewhere canvases are drawn as they are.
 * The frame meter's "no bitmaps" test (Ctrl+F12) turns them off, to see what they're worth there
 * (and whether they're what flickers on held sliders). */
import { isLinux } from "../lib/api";

/** null: on its way */
const bitmaps = new WeakMap<HTMLCanvasElement, ImageBitmap | null>();

let on = isLinux;

/** Whether finished pictures are drawn as ImageBitmaps (Linux, unless the meter's test is on). */
export const stillsOn = (): boolean => on;

/** The meter's "no bitmaps" test: false draws the canvases themselves. */
export function setStills(v: boolean): void {
  on = isLinux && v;
}

/**
 * What to draw for `canvas`, a picture that is finished and won't change: on Linux its ImageBitmap
 * once that's made (the canvas itself until then), elsewhere the canvas.
 */
export function still(canvas: HTMLCanvasElement): HTMLCanvasElement | ImageBitmap {
  if (!on) return canvas;
  const b = bitmaps.get(canvas);
  if (b) return b;
  if (b === undefined && canvas.width > 0 && canvas.height > 0) {
    bitmaps.set(canvas, null);
    createImageBitmap(canvas).then(
      (bitmap) => bitmaps.set(canvas, bitmap),
      () => {},
    );
  }
  return canvas;
}
