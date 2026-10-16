/* dissolve.ts — rows turning to smoke: each one is wiped away from left to right while what was
 * there rises off it as small white particles, drifting and thinning out. A one-shot effect for
 * something that's gone for real (sets deleted in osu!lazer), in a wave down the rows. The rows
 * keep their place (only their content goes), so nothing around them moves.
 *
 * With reduced motion the rows just fade. */

import { reduceMotion } from "./controls";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  age: number;
  /** its own sway, so the smoke doesn't move in step */
  phase: number;
  bright: number;
}

interface Item {
  el: HTMLElement;
  /** the part of the row that can be seen (particles only come off that) */
  rect: { left: number; top: number; width: number; height: number };
  start: number;
  emitted: number;
  budget: number;
}

/** the wipe's soft edge, as a share of the row's width */
const EDGE = 0.22;

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

function setMask(el: HTMLElement, value: string): void {
  el.style.maskImage = value;
  el.style.setProperty("-webkit-mask-image", value);
}

/**
 * Dissolves `rows` (in this order, a wave), seen through `clip` (the list's visible box: rows or
 * parts of rows outside it go without particles). Resolves when the last particle is gone; the
 * rows are left invisible, in place.
 */
export function dissolve(rows: HTMLElement[], clip?: DOMRect, opts: { duration?: number; wave?: number } = {}): Promise<void> {
  if (!rows.length) return Promise.resolve();
  if (reduceMotion()) {
    for (const r of rows) {
      r.style.transition = "opacity .25s ease";
      r.style.opacity = "0";
    }
    return new Promise((done) => setTimeout(done, 260));
  }

  const canvas = document.createElement("canvas");
  canvas.className = "dissolve-canvas";
  document.body.appendChild(canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  const ctx = canvas.getContext("2d")!;
  // white smoke on the dark themes, dark on the light one
  const ink = "rgb(" + (getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "255 255 255") + ")";
  ctx.scale(dpr, dpr);

  const duration = opts.duration ?? 720;
  // the whole wave takes about as long whatever the number of rows
  const step = Math.min(70, (opts.wave ?? 560) / Math.max(1, rows.length - 1));
  const items: Item[] = rows.map((el, i) => {
    const r = el.getBoundingClientRect();
    const top = clip ? Math.max(r.top, clip.top) : r.top;
    const bottom = clip ? Math.min(r.bottom, clip.bottom) : r.bottom;
    const rect = { left: r.left, top, width: r.width, height: Math.max(0, bottom - top) };
    return { el, rect, start: i * step, emitted: 0, budget: Math.min(420, Math.round((rect.width * rect.height) / 85)) };
  });

  const parts: Particle[] = [];
  const t0 = performance.now();
  let last = t0;

  return new Promise((done) => {
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now - t0;
      let wiping = false;

      for (const it of items) {
        const p = Math.min(1, Math.max(0, (t - it.start) / duration));
        if (p < 1) wiping = true;
        if (p <= 0) continue;
        // where the wipe is: everything left of `gone` is gone, right of `front` still there
        const front = ease(p) * (1 + EDGE);
        const gone = front - EDGE;
        setMask(it.el, p >= 1 ? "linear-gradient(transparent, transparent)" : `linear-gradient(90deg, transparent ${(gone * 100).toFixed(2)}%, #000 ${(front * 100).toFixed(2)}%)`);
        // particles for what the wipe has passed since the last frame, off its soft edge
        const passed = Math.min(1, Math.max(0, front - EDGE / 2));
        const want = Math.round(passed * it.budget);
        const { left, top, width, height } = it.rect;
        for (; it.emitted < want && height > 0; it.emitted++) {
          const at = Math.min(1, Math.max(0, passed - Math.random() * EDGE * 0.7));
          parts.push({
            x: left + at * width,
            y: top + Math.random() * height,
            vx: rand(6, 48),
            vy: -rand(24, 90),
            size: rand(0.8, 2.2),
            life: rand(0.9, 1.8),
            age: 0,
            phase: Math.random() * Math.PI * 2,
            bright: rand(0.55, 1),
          });
        }
      }

      ctx.clearRect(0, 0, vw, vh);
      ctx.fillStyle = ink;
      for (let i = parts.length - 1; i >= 0; i--) {
        const q = parts[i];
        q.age += dt;
        if (q.age >= q.life) {
          parts[i] = parts[parts.length - 1];
          parts.pop();
          continue;
        }
        // rising faster as it goes, swaying, slowing sideways: smoke
        q.vy -= 95 * dt;
        q.vx = q.vx * (1 - 1.2 * dt) + Math.sin(q.age * 4 + q.phase) * 26 * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        const a = 1 - q.age / q.life;
        ctx.globalAlpha = 0.95 * q.bright * a * a;
        const s = q.size * (0.55 + 0.45 * a);
        ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      }
      ctx.globalAlpha = 1;

      if (wiping || parts.length) requestAnimationFrame(frame);
      else {
        canvas.remove();
        done();
      }
    };
    requestAnimationFrame(frame);
  });
}
