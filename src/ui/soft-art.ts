/* soft-art.ts — an artwork blurred once, ahead of time, for the backgrounds that blur it.
 *
 * WebKitGTK (Linux) renders CSS `filter: blur()` and `backdrop-filter` so slowly that the whole app
 * stutters behind a full-window blurred cover. There the cover is shrunk, blurred and coloured
 * once on a small canvas, and the browser only scales that picture up: the same soft look, no work
 * per frame. Elsewhere the CSS filters stay. */

/** whether backgrounds are blurred here instead of by CSS (`:root.linux`) */
export const softArtByHand = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

/** pixels across the small copy: a 70px blur on a ~1400px window is about this soft */
const W = 48;
const H = 27;

/** One box-blur pass along rows (`dx` 1) or columns, radius `r`, over RGBA `d` of w × h. */
function boxBlur(d: Uint8ClampedArray, w: number, h: number, r: number, horizontal: boolean): void {
  const src = d.slice();
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const at = (line: number, i: number) => (horizontal ? line * w + i : i * w + line) * 4;
  for (let line = 0; line < lines; line++) {
    for (let i = 0; i < len; i++) {
      let r0 = 0;
      let g0 = 0;
      let b0 = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const j = Math.min(len - 1, Math.max(0, i + k));
        const p = at(line, j);
        r0 += src[p];
        g0 += src[p + 1];
        b0 += src[p + 2];
        n++;
      }
      const p = at(line, i);
      d[p] = r0 / n;
      d[p + 1] = g0 / n;
      d[p + 2] = b0 / n;
      d[p + 3] = 255;
    }
  }
}

/**
 * The image at `url` as a small, blurred canvas with saturation and brightness applied (as CSS's
 * `saturate()` / `brightness()`); scaled up by CSS it looks like the blurred cover. Null when the
 * image can't be read.
 */
export async function softArt(url: string, o: { saturate: number; brightness: number }): Promise<HTMLCanvasElement | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  ctx.drawImage(img, (W - img.naturalWidth * s) / 2, (H - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, W, H);
  } catch {
    return null;
  }
  const d = data.data;
  // three box passes each way: close to a gaussian
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(d, W, H, 2, true);
    boxBlur(d, W, H, 2, false);
  }
  // CSS's saturate() and brightness() matrices
  const k = o.saturate;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    d[i] = ((0.213 + 0.787 * k) * r + (0.715 - 0.715 * k) * g + (0.072 - 0.072 * k) * b) * o.brightness;
    d[i + 1] = ((0.213 - 0.213 * k) * r + (0.715 + 0.285 * k) * g + (0.072 - 0.072 * k) * b) * o.brightness;
    d[i + 2] = ((0.213 - 0.213 * k) * r + (0.715 - 0.715 * k) * g + (0.072 + 0.928 * k) * b) * o.brightness;
  }
  ctx.putImageData(data, 0, 0);
  return c;
}
