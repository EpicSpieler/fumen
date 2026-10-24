/* Bühne: the cover fills everything and zooms on the beat; a big title, a bar counter, a strip of light. */
import { isLinux } from "../../../lib/api";
import { t } from "../../../lib/i18n";
import { bars, css, drawArt, text, type Style, type VisFrame } from "../draw";

/** Darker toward the bottom and the left, over the cover dimmed. */
function shades(c: CanvasRenderingContext2D, dim: number, W: number, H: number): void {
  c.fillStyle = `rgba(0,0,0,${dim * 0.45})`;
  c.fillRect(0, 0, W, H);
  let g = c.createLinearGradient(0, H, 0, H * 0.3);
  g.addColorStop(0, "rgba(0,0,0,.9)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  g = c.createLinearGradient(0, 0, W * 0.65, 0);
  g.addColorStop(0, "rgba(0,0,0,.45)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
}

export function stage(): Style {
  /** Linux: the shades at the canvas' size, and what they were made for */
  let shade: HTMLCanvasElement | null = null;
  let shadeKey = "";
  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h, W, H } = f;
      c.fillStyle = "#000";
      c.fillRect(0, 0, W, H);
      // a slow drift across the cover, by the time played
      const zoom = 1.07 + 0.035 * f.hit + 0.02 * f.kiai;
      drawArt(f, 0, 0, W, H, { zoom, px: Math.sin(f.clock * 0.06) * 0.018, py: Math.cos(f.clock * 0.045) * 0.012 });
      if (isLinux) {
        // the three shades over the cover put together once, then copied over as they are
        const bw = c.canvas.width;
        const bh = c.canvas.height;
        const key = `${f.o.dim} ${bw}x${bh} ${W}x${H}`;
        if (shadeKey !== key) {
          shade ??= document.createElement("canvas");
          shade.width = bw;
          shade.height = bh;
          const s = shade.getContext("2d")!;
          s.setTransform(bw / W, 0, 0, bh / H, 0, 0);
          shades(s, f.o.dim, W, H);
          shadeKey = key;
        }
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.drawImage(shade!, 0, 0);
        c.restore();
      } else shades(c, f.o.dim, W, H);
      let g: CanvasGradient;
      if (f.kiai > 0.01) {
        g = c.createLinearGradient(0, H, 0, H * 0.4);
        g.addColorStop(0, css(f.look.a, 0.35 * f.kiai));
        g.addColorStop(1, css(f.look.a, 0));
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
      }
      // the strip of light along the box's floor
      const m = Math.max(48, Math.min(220, Math.round(f.o.bars * 2.5)));
      const v = bars(f, m, f.o.mirror);
      const sw = w / m;
      const floor = y + h;
      g = c.createLinearGradient(0, floor - h * 0.09, 0, floor);
      g.addColorStop(0, css(f.look.ink, 0.9));
      g.addColorStop(1, css(f.look.a, 0.5));
      c.fillStyle = g;
      c.beginPath();
      for (let i = 0; i < m; i++) {
        const bh = Math.max(h * 0.003, v[i] * h * 0.09);
        c.rect(x + i * sw + sw * 0.15, floor - bh, sw * 0.7, bh);
      }
      c.fill();
      const mx = x + w * 0.05;
      if (f.o.title) {
        text(c, f.meta.title, mx, y + h * 0.74, h * 0.1, { weight: 700, color: "#fff", maxW: w * 0.88 });
        text(c, f.meta.artist, mx, y + h * 0.805, h * 0.036, { weight: 550, color: "rgba(255,255,255,.82)", maxW: w * 0.7 });
        text(c, f.meta.version, mx, y + h * 0.85, h * 0.024, { weight: 500, color: "rgba(255,255,255,.55)", maxW: w * 0.7 });
      }
      // the bar counter
      const b = f.beat;
      if (b) {
        const s = h * 0.018;
        const gap = h * 0.012;
        const ty = y + h * 0.04;
        const meter = Math.min(b.meter, 8);
        for (let i = 0; i < meter; i++) {
          c.fillStyle = f.playing && b.inBar === i ? css(f.look.a, 0.55 + 0.45 * f.pulse) : "rgba(255,255,255,.22)";
          c.beginPath();
          c.roundRect(mx + i * (s + gap), ty, s, s, s * 0.3);
          c.fill();
        }
        const lx = mx + meter * (s + gap) + gap;
        text(c, `${Math.round(b.bpm)} BPM`, lx, ty + s * 0.85, h * 0.022, { color: "rgba(255,255,255,.75)" });
        if (f.kiai > 0.05) text(c, t("Kiai"), lx + h * 0.14, ty + s * 0.85, h * 0.022, { weight: 700, color: css(f.look.a, f.kiai) });
      }
      return false;
    },
  };
}
