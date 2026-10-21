/* Sternenfeld: a flight through stars; speed from loudness, a push on every beat and kick, faster in kiai. */
import { background, css, text, type Style, type VisFrame } from "../draw";

interface Star {
  x: number;
  y: number;
  z: number;
  /** colour: 0 the first, 1 the second, 2 ink */
  k: number;
}

const star = (z: number): Star => ({ x: (Math.random() * 2 - 1) * 1.2, y: (Math.random() * 2 - 1) * 0.8, z: z * 0.96 + 0.04, k: (Math.random() * 3) | 0 });

export function stars(): Style {
  let all: Star[] = [];
  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h, W, H, dt } = f;
      background(f, { dim: Math.max(f.o.dim, 0.78) });
      const n = Math.round(Math.min(460, Math.max(50, (W * H) / 4200)));
      if (all.length !== n) all = Array.from({ length: n }, () => star(Math.random()));
      const speed = f.playing ? 0.06 + 0.4 * (f.a.bass * 0.5 + f.a.mid * 0.35 + f.a.high * 0.15) + 1.6 * f.hit + 0.45 * f.kiai : 0;
      const cx = x + w / 2;
      const cy = y + h * 0.47;
      const k = Math.min(W, H) * 0.6;
      // grouped by colour and depth: nine strokes a frame instead of one per star
      const paths = Array.from({ length: 9 }, () => new Path2D());
      for (const s of all) {
        const pz = s.z;
        s.z -= speed * dt * 0.6;
        if (s.z <= 0.04) {
          Object.assign(s, star(1));
          continue;
        }
        const x2 = cx + (s.x / s.z) * k;
        const y2 = cy + (s.y / s.z) * k;
        if (x2 < -20 || x2 > W + 20 || y2 < -20 || y2 > H + 20) {
          Object.assign(s, star(1));
          continue;
        }
        const p = paths[s.k * 3 + (s.z > 0.66 ? 0 : s.z > 0.33 ? 1 : 2)];
        p.moveTo(cx + (s.x / pz) * k, cy + (s.y / pz) * k);
        p.lineTo(x2 + 0.01, y2 + 0.01);
      }
      const colors = [f.look.a, f.look.b, f.look.ink];
      c.lineCap = "round";
      for (let i = 0; i < 9; i++) {
        const d = i % 3;
        c.strokeStyle = css(colors[(i / 3) | 0], [0.35, 0.65, 0.95][d]);
        c.lineWidth = Math.max(0.6, h * [0.0016, 0.003, 0.005][d]);
        c.stroke(paths[i]);
      }
      c.lineCap = "butt";
      if (f.o.title) {
        const s = 1 + 0.03 * f.hit;
        c.save();
        c.translate(cx, cy);
        c.scale(s, s);
        c.shadowColor = css(f.look.a, 0.15 + 0.5 * f.hit);
        c.shadowBlur = h * 0.04;
        text(c, f.meta.title, 0, 0, h * 0.078, { weight: 700, color: "rgba(255,255,255,.97)", align: "center", maxW: w * 0.8, base: "middle" });
        c.shadowBlur = 0;
        text(c, f.meta.artist, 0, h * 0.075, h * 0.027, { weight: 500, color: "rgba(255,255,255,.62)", align: "center", maxW: w * 0.8, base: "middle" });
        c.restore();
      }
      return false;
    },
  };
}
