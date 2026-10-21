/* Welle: three soft shapes (bass, mids, highs) glowing into each other, the waveform through them. */
import type { Rgb } from "../../../lib/vis/palette";
import { background, css, text, type Style, type VisFrame } from "../draw";

/** One edge of a shape through the points, smoothed; `sign` −1 above the middle line, 1 below (drawn backwards). */
function edge(c: CanvasRenderingContext2D, ys: number[], x: number, w: number, cy: number, sign: number, first: boolean): void {
  const M = ys.length - 1;
  const pts = ys.map((v, i) => [x + (i / M) * w, cy + sign * v]);
  if (sign > 0) pts.reverse();
  if (first) c.moveTo(pts[0][0], pts[0][1]);
  else c.lineTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) c.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
  const last = pts[pts.length - 1];
  c.lineTo(last[0], last[1]);
}

export function wave(): Style {
  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h, W } = f;
      background(f, { dim: Math.min(0.92, f.o.dim + 0.15) });
      const cy = y + h * 0.45;
      const amp = h * 0.26 * (1 + 0.12 * f.hit);
      const M = 28;
      const v = f.a.bands(96);
      const layers: [number, number, Rgb, number, number][] = [
        [0, 0.4, f.look.b, 1, 0.55],
        [0.15, 0.7, f.look.a, 0.78, 0.5],
        [0.45, 1, f.look.ink, 0.5, 0.4],
      ];
      c.save();
      c.globalCompositeOperation = "lighter";
      for (const [f0, f1, rgb, scale, alpha] of layers) {
        const ys: number[] = [];
        for (let p = 0; p <= M; p++) {
          const u = p / M;
          const d = f.o.mirror ? Math.abs(u - 0.5) * 2 : u;
          const idx = Math.min(95, Math.floor((f0 + (f1 - f0) * d) * 95));
          ys.push(v[idx] * amp * scale * Math.pow(Math.sin(Math.PI * u), 0.7) + h * 0.002);
        }
        const g = c.createLinearGradient(0, cy - amp, 0, cy + amp);
        g.addColorStop(0, css(rgb, 0));
        g.addColorStop(0.5, css(rgb, alpha));
        g.addColorStop(1, css(rgb, 0));
        c.fillStyle = g;
        c.beginPath();
        edge(c, ys, 0, W, cy, -1, true);
        edge(c, ys, 0, W, cy, 1, false);
        c.closePath();
        c.fill();
      }
      c.restore();
      const wv = f.a.wave;
      const N = 400;
      const step = Math.max(1, Math.floor(wv.length / N));
      c.strokeStyle = "rgba(255,255,255,.55)";
      c.lineWidth = Math.max(1, h * 0.0025);
      c.beginPath();
      for (let i = 0; i < N; i++) {
        const px = (i / (N - 1)) * W;
        const py = cy + (wv[i * step] || 0) * h * 0.14 * (1 + 0.3 * f.hit);
        if (i) c.lineTo(px, py);
        else c.moveTo(px, py);
      }
      c.stroke();
      if (f.o.title) {
        const mx = x + w * 0.05;
        text(c, f.meta.title, mx, y + h * 0.88, h * 0.064, { weight: 700, color: "rgba(255,255,255,.96)", maxW: w * 0.8 });
        text(c, `${f.meta.artist}  ·  ${f.meta.version}`, mx, y + h * 0.94, h * 0.026, { weight: 500, color: "rgba(255,255,255,.6)", maxW: w * 0.85 });
      }
      return false;
    },
  };
}
