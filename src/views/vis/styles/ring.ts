/* Ring: the cover round in the middle, the spectrum around it, a wave on every beat, sparks in kiai. */
import { mix } from "../../../lib/vis/palette";
import { glowCircle } from "../../../ui/glow";
import { background, css, drawArt, TAU, titleBlock, unit, type Style, type VisFrame } from "../draw";

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  span: number;
  size: number;
  ink: boolean;
}

export function ring(): Style {
  const sparks: Spark[] = [];
  const waves: { r: number; a: number }[] = [];
  let colors: string[] = [];
  let colorKey = "";
  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h, dt } = f;
      background(f);
      const cx = x + w / 2;
      const cy = y + h * 0.45;
      const R = h * 0.18 * (1 + 0.08 * f.hit + 0.04 * f.a.bass);
      const m = Math.max(48, Math.min(200, f.o.bars * 2));
      const half = m >> 1;
      const key = `${f.look.a}|${f.look.b}|${m}`;
      if (key !== colorKey) {
        colors = Array.from({ length: half }, (_, j) => css(mix(f.look.a, f.look.b, j / Math.max(1, half - 1))));
        colorKey = key;
      }
      // a wave outwards on every beat (on kicks without a beatmap)
      const trig = f.beat ? f.newBeat : f.a.onset === "kick";
      if (trig && f.playing && f.hit > 0) waves.push({ r: R, a: f.beat && f.beat.inBar !== 0 ? 0.28 : 0.5 });
      c.lineWidth = Math.max(1, h * 0.004);
      for (let i = waves.length - 1; i >= 0; i--) {
        const q = waves[i];
        q.r += dt * h * 0.42;
        q.a -= dt * 0.75;
        if (q.a <= 0) {
          waves.splice(i, 1);
          continue;
        }
        c.strokeStyle = css(f.look.ink, q.a * Math.min(1, f.o.pulse * 1.4));
        c.beginPath();
        c.arc(cx, cy, q.r, 0, TAU);
        c.stroke();
      }
      const v = f.a.bands(half);
      c.lineCap = "round";
      c.lineWidth = Math.max(1, ((TAU * R) / m) * 0.55);
      for (let k = 0; k < m; k++) {
        const j = k < half ? k : m - 1 - k;
        const ang = -Math.PI / 2 + ((k + 0.5) / m) * TAU;
        const r1 = R + h * 0.02;
        const r2 = r1 + h * 0.004 + v[j] * h * 0.17;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        c.strokeStyle = colors[j];
        c.beginPath();
        c.moveTo(cx + ca * r1, cy + sa * r1);
        c.lineTo(cx + ca * r2, cy + sa * r2);
        c.stroke();
      }
      c.lineCap = "butt";
      const rr = R * 0.94;
      glowCircle(c, cx, cy, rr * 2, h * 0.06, unit(f.look.a), 0.35 + 0.4 * f.a.bass);
      c.save();
      c.beginPath();
      c.arc(cx, cy, rr, 0, TAU);
      c.clip();
      drawArt(f, cx - R, cy - R, R * 2, R * 2);
      c.restore();
      c.strokeStyle = css(f.look.ink, 0.55);
      c.lineWidth = Math.max(1, h * 0.003);
      c.beginPath();
      c.arc(cx, cy, rr, 0, TAU);
      c.stroke();
      // sparks off the ring in kiai
      if (f.kiai > 0.02 && f.playing) {
        let n = f.kiai * (30 + 140 * f.a.bass) * dt * Math.sqrt((w * h) / (1280 * 720));
        while (n > 0) {
          if (Math.random() < n) {
            const ang = Math.random() * TAU;
            const sp = h * (0.12 + Math.random() * 0.3);
            sparks.push({
              x: cx + Math.cos(ang) * R * 1.1,
              y: cy + Math.sin(ang) * R * 1.1,
              vx: Math.cos(ang) * sp,
              vy: Math.sin(ang) * sp,
              life: 1,
              span: 0.8 + Math.random() * 0.8,
              size: h * (0.002 + Math.random() * 0.004),
              ink: Math.random() < 0.5,
            });
          }
          n -= 1;
        }
      }
      c.save();
      c.globalCompositeOperation = "lighter";
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.life -= dt / p.span;
        if (p.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        c.fillStyle = css(p.ink ? f.look.ink : f.look.a, p.life * 0.9);
        c.beginPath();
        c.arc(p.x, p.y, p.size, 0, TAU);
        c.fill();
      }
      c.restore();
      if (f.o.title) titleBlock(f, cx, y + h * 0.92, h * 0.042);
      return sparks.length > 0 || waves.length > 0;
    },
  };
}
