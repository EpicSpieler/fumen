/* palette.ts — two colours from a cover for the visualizer: the strongest colour and the strongest
 * one of another hue (k-means over a small copy), both lifted so they read on a dark stage. */

export type Rgb = [number, number, number];

export interface Palette {
  a: Rgb;
  b: Rgb;
}

export const css = (c: Rgb, alpha = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function hexRgb(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [139, 124, 255];
}

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const hueDist = (p: number, q: number): number => {
  const d = Math.abs(p - q) % 360;
  return d > 180 ? 360 - d : d;
};

/** The palette of RGBA pixels (a small copy of the cover: 48 × 27 is plenty). */
export function paletteOf(rgba: ArrayLike<number>): Palette {
  const px: Rgb[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) px.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
  if (!px.length) return { a: [139, 124, 255], b: [201, 193, 255] };
  const lum = (p: Rgb) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
  px.sort((p, q) => lum(p) - lum(q));
  const K = Math.min(6, px.length);
  // spread over the brightness, so the same picture always gives the same colours
  let cent: Rgb[] = Array.from({ length: K }, (_, k) => [...px[Math.floor(((k + 0.5) / K) * px.length)]] as Rgb);
  let count = new Array<number>(K).fill(0);
  for (let it = 0; it < 8; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let bi = 0;
      let bd = Infinity;
      for (let k = 0; k < K; k++) {
        const q = cent[k];
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < bd) {
          bd = d;
          bi = k;
        }
      }
      const s = sum[bi];
      s[0] += p[0];
      s[1] += p[1];
      s[2] += p[2];
      s[3]++;
    }
    cent = cent.map((q, k) => (sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : q));
    count = sum.map((s) => s[3]);
  }
  const cl = cent.map((rgb, k) => ({ n: count[k], hsl: rgbToHsl(rgb) })).filter((c) => c.n > 0);
  // colourful, neither near black nor near white, and plenty of it
  const score = (c: (typeof cl)[number]) => c.hsl[1] * (c.hsl[2] > 0.22 && c.hsl[2] < 0.85 ? 1 : 0.35) * Math.sqrt(c.n);
  cl.sort((p, q) => score(q) - score(p));
  const A = cl[0];
  const B = cl.find((c) => c !== A && hueDist(c.hsl[0], A.hsl[0]) > 35 && c.hsl[1] > 0.2);
  const lift = (h: number, s: number, l: number): Rgb => hslToRgb(h, Math.max(s, 0.6), Math.min(0.74, Math.max(0.62, l)));
  return {
    a: lift(A.hsl[0], A.hsl[1], A.hsl[2]),
    b: B ? lift(B.hsl[0], B.hsl[1], B.hsl[2]) : lift((A.hsl[0] + 40) % 360, A.hsl[1], A.hsl[2] + 0.08),
  };
}
