/* Hi-Fi: LED segments with peak hold, a beat lamp and a kiai lamp, like the front of an amplifier. */
import { t } from "../../../lib/i18n";
import { bandPos } from "../../../lib/vis/analysis";
import { glowOf } from "../../../ui/glow";
import { artCard, css, drawArt, FONT, text, TAU, type Style, type VisFrame } from "../draw";

const SEGS = 22;

const time = (s: number): string => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

export function hifi(): Style {
  let peak = new Float32Array(0);
  let hold = new Float32Array(0);
  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h, W, H } = f;
      c.fillStyle = "#0a0a0c";
      c.fillRect(0, 0, W, H);
      if (f.o.background !== "black") {
        c.globalAlpha = 0.16;
        drawArt(f, 0, 0, W, H, { blur: true, zoom: 1.1 });
        c.globalAlpha = 1;
      }
      const cols = Math.max(16, Math.min(64, Math.round(f.o.bars * 0.55)));
      const x0 = x + w * 0.05;
      const x1 = x + w * 0.95;
      const y0 = y + h * 0.25;
      const y1 = y + h * 0.86;
      const cw = (x1 - x0) / cols;
      const sh = (y1 - y0) / SEGS;
      const gx = cw * 0.18;
      const gy = sh * 0.28;
      const v = f.a.bands(cols);
      if (peak.length !== cols) {
        peak = new Float32Array(cols);
        hold = new Float32Array(cols);
      }
      const off = new Path2D();
      const lo = new Path2D();
      const mid = new Path2D();
      const hi = new Path2D();
      const caps = new Path2D();
      let moving = false;
      for (let i = 0; i < cols; i++) {
        const lit = Math.round(v[i] * SEGS);
        if (lit >= peak[i]) {
          peak[i] = lit;
          hold[i] = 0.5;
        } else {
          hold[i] -= f.dt;
          if (hold[i] <= 0) peak[i] = Math.max(0, peak[i] - f.dt * 14);
        }
        if (peak[i] > 0) moving = true;
        const sx = x0 + i * cw + gx / 2;
        for (let s = 0; s < SEGS; s++) (s < lit ? (s < SEGS * 0.6 ? lo : s < SEGS * 0.86 ? mid : hi) : off).rect(sx, y1 - (s + 1) * sh + gy / 2, cw - gx, sh - gy);
        const top = Math.floor(peak[i]);
        if (top > lit && top > 0) caps.rect(sx, y1 - top * sh + gy / 2, cw - gx, sh - gy);
      }
      c.fillStyle = "rgba(255,255,255,.045)";
      c.fill(off);
      c.fillStyle = css(f.look.b);
      c.fill(lo);
      if (f.kiai > 0.02) glowOf(c, x0, y0, x1 - x0, y1 - y0, h * 0.02, css(f.look.a, 0.8 * f.kiai), (g) => g.fill(mid));
      c.fillStyle = css(f.look.a);
      c.fill(mid);
      c.fillStyle = "#ff7b6b";
      c.fill(hi);
      c.fillStyle = css(f.look.ink, 0.9);
      c.fill(caps);
      // the display: cover, title, time and lamps
      const hs = h * 0.12;
      const hy = y + h * 0.04;
      artCard(f, x0, hy, hs, hs, h * 0.012);
      if (f.o.title) {
        text(c, f.meta.title, x0 + hs + h * 0.03, hy + hs * 0.45, h * 0.042, { weight: 700, color: "rgba(255,255,255,.94)", maxW: w * 0.45 });
        text(c, f.meta.artist, x0 + hs + h * 0.03, hy + hs * 0.85, h * 0.024, { weight: 500, color: "rgba(255,255,255,.6)", maxW: w * 0.45 });
      }
      text(c, time(f.time), x1, hy + hs * 0.45, h * 0.05, { color: "rgba(255,255,255,.9)", align: "right" });
      const ly = hy + hs * 0.85;
      const lamp = (right: number, label: string, on: number): number => {
        c.font = `700 ${h * 0.02}px ${FONT}`;
        const tw = c.measureText(label).width;
        text(c, label, right, ly, h * 0.02, { weight: 700, color: on > 0.5 ? "rgba(255,255,255,.85)" : "rgba(255,255,255,.35)", align: "right" });
        const lx = right - tw - h * 0.022;
        c.fillStyle = on > 0.02 ? css(f.look.a, 0.25 + 0.75 * on) : "rgba(255,255,255,.12)";
        c.beginPath();
        c.arc(lx, ly - h * 0.007, h * 0.008, 0, TAU);
        c.fill();
        return lx - h * 0.03;
      };
      let right = lamp(x1, t("Kiai").toUpperCase(), f.kiai);
      right = lamp(right, "BEAT", f.playing ? f.pulse : 0);
      if (f.beat) text(c, `${Math.round(f.beat.bpm)} BPM`, right, ly, h * 0.02, { color: "rgba(255,255,255,.6)", align: "right" });
      for (const [hz, label] of [[50, "50"], [200, "200"], [1000, "1k"], [4000, "4k"], [12000, "12k"]] as const) {
        text(c, label, x0 + bandPos(hz) * (x1 - x0), y1 + h * 0.05, h * 0.018, { weight: 500, color: "rgba(255,255,255,.35)", align: "center" });
      }
      return moving;
    },
  };
}
