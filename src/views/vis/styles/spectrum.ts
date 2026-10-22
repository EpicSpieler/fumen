/* Spektrum: bars in the cover's colours with falling peaks and a reflection; the cover breathes on the beat. */
import { glowOf } from "../../../ui/glow";
import { artCard, background, bars, css, titleBlock, type Style, type VisFrame } from "../draw";

export function spectrum(): Style {
  let peak = new Float32Array(0);
  let fall = new Float32Array(0);
  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h } = f;
      background(f);
      const n = f.o.bars;
      const v = bars(f, n, f.o.mirror);
      if (peak.length !== n) {
        peak = new Float32Array(n);
        fall = new Float32Array(n);
      }
      const s = 1 + 0.045 * f.hit;
      const ah = h * 0.36 * s;
      const aw = Math.min(ah * 16 / 9, w * 0.8);
      artCard(f, x + (w - aw) / 2, y + h * 0.27 - ah / 2, aw, ah, h * 0.022, 0.25 + 0.45 * f.a.bass);
      if (f.o.title) titleBlock(f, x + w / 2, y + h * 0.56, h * 0.045);
      const base = y + h * 0.9;
      const maxH = h * 0.24;
      const x0 = x + w * 0.04;
      const slot = (w * 0.92) / n;
      const bw = Math.max(1, slot * 0.62);
      const r = Math.min(bw / 2, h * 0.006);
      const path = new Path2D();
      let moving = false;
      for (let i = 0; i < n; i++) {
        const bh = Math.max(h * 0.006, v[i] * maxH);
        path.roundRect(x0 + i * slot + (slot - bw) / 2, base - bh, bw, bh, r);
        if (v[i] >= peak[i]) {
          peak[i] = v[i];
          fall[i] = 0;
        } else {
          fall[i] += f.dt * 2.4;
          peak[i] = Math.max(0, peak[i] - fall[i] * f.dt);
        }
        if (peak[i] > 0.01) moving = true;
      }
      const g = c.createLinearGradient(0, base - maxH, 0, base);
      g.addColorStop(0, css(f.look.a));
      g.addColorStop(1, css(f.look.b));
      if (f.kiai > 0.02) glowOf(c, x0, base - maxH, slot * n, maxH, h * 0.035, css(f.look.a, 0.7 * f.kiai), (g) => g.fill(path));
      c.fillStyle = g;
      c.fill(path);
      // the reflection
      const g2 = c.createLinearGradient(0, base, 0, base + maxH * 0.35);
      g2.addColorStop(0, css(f.look.b, 0.28));
      g2.addColorStop(1, css(f.look.b, 0));
      c.fillStyle = g2;
      c.beginPath();
      for (let i = 0; i < n; i++) c.rect(x0 + i * slot + (slot - bw) / 2, base + h * 0.008, bw, Math.max(h * 0.003, v[i] * maxH * 0.35));
      c.fill();
      // the peaks
      c.fillStyle = css(f.look.ink, 0.9);
      c.beginPath();
      for (let i = 0; i < n; i++) if (peak[i] > 0.02) c.rect(x0 + i * slot + (slot - bw) / 2, base - peak[i] * maxH - h * 0.014, bw, Math.max(1, h * 0.004));
      c.fill();
      return moving;
    },
  };
}
