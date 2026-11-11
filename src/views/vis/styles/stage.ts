/* Bühne: the cover fills everything and zooms on the beat; a big title and a strip of light (both
 * going down while the transport slides away).
 *
 * Playing along with osu! (lib/vis/feel) it's lit like a stage. The combo brings the lights up:
 * the lamps along the floor grow and their light spills up over the picture. A miss bumps the
 * camera and makes the lamps flicker. A combo break cuts the light: the picture loses its colour
 * and its focus for a moment, the old combo drops away, and the lamps come back on one by one.
 * Low health closes in from the edges with a heartbeat on the song's beat. After the last note of
 * a full combo the stage holds its breath; then a sheen passes over it, light rises off the lamps
 * and its name comes up over the title. A fail goes out from the right. The combo, accuracy and pp
 * sit across from the title (the `stats` setting). */
import { isLinux } from "../../../lib/api";
import { pct } from "../../../lib/format";
import { t } from "../../../lib/i18n";
import type { FeelFrame } from "../../../lib/vis/feel";
import { mix, type Rgb } from "../../../lib/vis/palette";
import { reduceMotion } from "../../../ui/controls";
import { canvasFilters } from "../../../ui/soft-art";
import { bars, css, drawArt, FONT, TAU, text, type Style, type VisFrame } from "../draw";
import { clamp01, closingDark, easeIn, easeInOut, easeOut, heartbeat, Motes, seeded, sheen, soft, spaced, spacedWidth, Spring } from "../fx";

const WHITE: Rgb = [255, 255, 255];
/** the full combo's light: the look's ink warmed toward gold */
const WARM: Rgb = [255, 224, 168];
/** low health's lamps */
const DANGER: Rgb = [255, 96, 84];
/** a fail's lamps */
const GREY: Rgb = [148, 148, 156];

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

/** A lamp catching (u 0 → 1 over its ignition): up, a dip, up for good. */
function ignite(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < 0.3) return (u / 0.3) * 0.85;
  if (u < 0.45) return 0.3;
  return 0.3 + ((u - 0.45) / 0.55) * 0.7;
}

/** A lamp on a bad contact (s after a miss): out, back, half out, back. */
function flicker(s: number): number {
  if (s < 0 || s > 0.17) return 0;
  if (s < 0.035) return 1;
  if (s < 0.07) return 0.15;
  if (s < 0.1) return 0.65;
  return 0.65 * (1 - (s - 0.1) / 0.07);
}

const glide = (v: number, to: number, dt: number, tau: number): number => v + (to - v) * (1 - Math.exp(-dt / tau));

interface Ending {
  kind: "fc" | "pass" | "fail";
  /** stage time it began */
  at: number;
  text: string;
  detail: string;
}

export function stage(): Style {
  /** Linux: the shades at the canvas' size, and what they were made for */
  let shade: HTMLCanvasElement | null = null;
  let shadeKey = "";
  /** the title's drop: it follows the light strip down and up, a little behind */
  let textDrop = 0;

  // ── answering the play (lib/vis/feel) ──
  /** the camera: bumped by misses and breaks, leaning in on low health and before a full combo */
  const cam = { x: new Spring(150, 0.45), y: new Spring(150, 0.45), r: new Spring(120, 0.4), z: new Spring(90, 0.6) };
  const motes = new Motes();
  const rnd = seeded(20261109);
  /** stage time, s: runs on while the song stands (a full combo's moment plays over the results) */
  let now = 0;
  /** each lamp's place in the order the lamps come on (0–1, roughly left to right) */
  let order = new Float32Array(0);
  /** the lamps coming back on after a cut (a combo break, the start) */
  let relight: { at: number; depth: number; hold: number; spread: number } | null = null;
  let flickAt = -Infinity;
  let sweeps: { at: number; dur: number; width: number; alpha: number; warm: number }[] = [];
  /** a combo milestone running along the lamps */
  let chaseAt = -Infinity;
  /** the lamps standing taller for a moment (a milestone, the end) */
  let swell = 0;
  /** a full combo's flash */
  let bulb = 0;
  /** motes to let go now, and a second from now on */
  let burst = 0;
  let emit = 0;
  let ending: Ending | null = null;
  /** the lamps' levels of the last moments, and at the end of a pass the ones they hold: osu!
   * shows its results and Fumen's song stands, so they ring out like a last chord instead of
   * dropping right then */
  let heard = new Float32Array(0);
  let chord: Float32Array | null = null;
  let chordAt = 0;
  let takeChord = false;
  let endK = 0;
  /** the combo's digits, from the units up: what shows, what it rolled from, when */
  const odo: { cur: string; prev: string; at: number; roll: number }[] = [];
  let comboPulse = -Infinity;
  let comboBack = -Infinity;
  const falling: { digits: string; at: number; spin: number }[] = [];
  let acc = -1;
  let pp = -1;
  let statsK = 0;

  const bump = (d: number, rot: number, zoom: number): void => {
    const a = rnd() * TAU;
    cam.x.kick(Math.cos(a) * d);
    cam.y.kick(Math.sin(a) * d * 0.7);
    cam.r.kick((rnd() < 0.5 ? -1 : 1) * rot);
    cam.z.kick(zoom);
  };

  /** The play's moments since the last frame. */
  const answer = (P: FeelFrame, calm: boolean): void => {
    const broke = P.events.some((e) => e.kind === "break");
    for (const e of P.events) {
      switch (e.kind) {
        case "start":
          // the show begins: the lamps come on from the left
          relight = { at: now, depth: 1, hold: 0.05, spread: 0.8 };
          chord = null;
          ending = null;
          falling.length = 0;
          swell = 0;
          emit = 0;
          break;
        case "miss":
          if (broke) break;
          if (!calm) {
            const s = Math.min(1, 0.35 + e.combo / 300) * Math.min(1.6, Math.sqrt(e.n));
            bump(0.0035 * s, 0.0035 * s, 0.008 * s);
          }
          flickAt = now;
          break;
        case "break":
          relight = { at: now, depth: 0.5 + 0.5 * e.size, hold: 0.1 + 0.3 * e.size, spread: 0.45 + 0.45 * e.size };
          flickAt = now;
          if (!calm) {
            bump(0.006 * e.size, 0.009 * e.size, 0.022 * e.size);
            cam.y.kick(0.004 * e.size);
          }
          falling.push({ digits: String(e.lost), at: now, spin: rnd() < 0.5 ? -1 : 1 });
          comboBack = now + 0.22;
          break;
        case "milestone":
          sweeps.push({ at: now, dur: 0.95, width: 0.13, alpha: e.big ? 0.2 : 0.12, warm: 0.4 });
          chaseAt = now;
          comboPulse = now;
          swell = Math.max(swell, e.big ? 0.55 : 0.3);
          if (e.big) burst += 26;
          break;
        case "fc":
          bulb = 1;
          sweeps.push({ at: now, dur: 1.25, width: 0.24, alpha: 0.34, warm: 1 }, { at: now + 0.16, dur: 1.05, width: 0.07, alpha: 0.26, warm: 1 });
          swell = 1;
          burst += 80;
          emit = 34;
          relight = null;
          comboPulse = now;
          takeChord = true;
          if (!calm) cam.z.kick(-0.03);
          ending = { kind: "fc", at: now, text: t("Full combo").toLocaleUpperCase(), detail: [e.rank, pct(e.accuracy)].filter(Boolean).join("  ·  ") };
          break;
        case "pass":
          sweeps.push({ at: now, dur: 1.5, width: 0.2, alpha: 0.16, warm: 0.3 });
          swell = Math.max(swell, 0.5);
          burst += 14;
          relight = null;
          takeChord = true;
          ending = { kind: "pass", at: now, text: t("Passed").toLocaleUpperCase(), detail: [e.rank, pct(e.accuracy)].filter(Boolean).join("  ·  ") };
          break;
        case "fail":
          relight = null;
          ending = { kind: "fail", at: now, text: (e.progress === null ? t("Failed") : t("Failed at {at}", { at: pct(e.progress, 0) })).toLocaleUpperCase(), detail: "" };
          break;
      }
    }
  };

  /** How lit lamp `i` is: coming back on one by one after a cut, going out from the right after a fail. */
  const power = (i: number, failT: number | null): number => {
    let p = 1;
    if (relight) p = 1 - relight.depth * (1 - ignite((now - (relight.at + relight.hold + order[i] * relight.spread)) / 0.14));
    if (failT !== null) p *= 1 - ignite((failT - (0.15 + (1 - order[i]) * 0.75)) / 0.16);
    return p;
  };

  /** The combo, right-aligned at `rx`: digits rolling like an odometer, a small × after them. */
  const combo = (c: CanvasRenderingContext2D, value: number, rx: number, y: number, size: number, alpha: number, calm: boolean): void => {
    const digits = String(Math.max(0, value));
    for (let j = 0; j < Math.max(digits.length, odo.length); j++) {
      const d = j < digits.length ? digits[digits.length - 1 - j] : "";
      const cell = (odo[j] ??= { cur: "", prev: "", at: -Infinity, roll: 0.16 });
      if (cell.cur !== d) {
        // a digit that changes all the time (the units in a dense stream) rolls short or not at
        // all: a constant roll reads as a blur; the slower ones roll in full
        cell.roll = Math.min(0.16, Math.max(0, (now - cell.at) * 0.6 - 0.04));
        cell.prev = cell.cur;
        cell.cur = d;
        cell.at = now;
      }
    }
    while (odo.length && !odo[odo.length - 1].cur && now - odo[odo.length - 1].at > 0.2) odo.pop();
    const pulse = now >= comboPulse ? Math.exp(-(now - comboPulse) / 0.13) : 0;
    c.save();
    c.globalAlpha = alpha;
    c.translate(rx, y);
    const s = 1 + 0.1 * pulse;
    c.scale(s, s);
    text(c, "×", 0, 0, size * 0.5, { weight: 600, color: "rgba(255,255,255,.5)", align: "right" });
    c.font = `600 ${size * 0.5}px ${FONT}`;
    const right = -c.measureText("×").width - size * 0.08;
    c.font = `700 ${size}px ${FONT}`;
    const cw = c.measureText("0").width * 1.04;
    // the window the digits roll through
    c.beginPath();
    c.rect(right - (odo.length + 1) * cw, -size * 1.02, (odo.length + 1) * cw, size * 1.3);
    c.clip();
    const ink = css(mix(WHITE, WARM, 0.5 * pulse), 0.97);
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    odo.forEach((cell, j) => {
      const cx = right - (j + 0.5) * cw;
      const u = calm || cell.roll < 0.03 ? 1 : clamp01((now - cell.at) / cell.roll);
      const e = easeOut(u);
      c.fillStyle = ink;
      if (cell.cur) {
        c.globalAlpha = alpha * e;
        c.fillText(cell.cur, cx, (1 - e) * size * 0.62);
      }
      if (cell.prev && u < 1) {
        c.globalAlpha = alpha * (1 - e);
        c.fillText(cell.prev, cx, -e * size * 0.62);
      }
    });
    c.restore();
  };

  return {
    draw(f: VisFrame): boolean {
      const { c, x, y, w, h, W, H, dt } = f;
      now += dt;
      const calm = reduceMotion();
      const P = f.play;
      const react = !!P && f.o.react;
      if (react) answer(P!, calm);
      const end = react ? P!.end : null;
      const failK = end?.kind === "fail" ? easeOut(end.t / 2.4) * end.k : 0;
      const light = react ? P!.energy : 0;
      const grief = react ? P!.grief : 0;
      const danger = react ? P!.danger : 0;
      const breath = react ? P!.breath : 0;
      const rest = react ? P!.rest : 0;
      const hb = danger > 0.003 ? heartbeat(f.beat, now) : 0;
      const flashes = !calm && f.o.flashes !== "off";
      const flick = flashes ? flicker(now - flickAt) : 0;
      if (relight && now > relight.at + relight.hold + relight.spread + 0.3) relight = null;

      // the camera: bumps settle, it leans in on low health and before a full combo, sinks on a fail
      if (calm) for (const s of Object.values(cam)) s.reset();
      else {
        cam.x.step(dt);
        cam.y.step(dt, 0.016 * failK);
        cam.r.step(dt, -0.008 * failK);
        cam.z.step(dt, 0.035 * danger + 0.028 * breath - 0.03 * failK - 0.012 * rest + 0.005 * hb * danger);
      }

      c.fillStyle = "#000";
      c.fillRect(0, 0, W, H);
      // a slow drift across the cover, by the time played
      const px = Math.sin(f.clock * 0.06) * 0.018 + cam.x.x;
      const py = Math.cos(f.clock * 0.045) * 0.012 + cam.y.x;
      const rot = cam.r.x;
      // zoomed in enough that the bumped, turned picture still covers the window
      const need = 1 + 2 * Math.max(Math.abs(px), Math.abs(py)) + Math.abs(rot) * (W / H + H / W) * 1.05;
      const zoom = Math.max(need, 1.07 + 0.035 * f.hit + 0.02 * f.kiai + cam.z.x);
      c.save();
      if (rot) {
        c.translate(W / 2, H / 2);
        c.rotate(rot);
        c.translate(-W / 2, -H / 2);
      }
      drawArt(f, 0, 0, W, H, { zoom, px, py });
      // out of focus for a moment after a combo break, going on a fail (the blurred copy over it)
      const unfocus = isLinux || f.video || !f.art.blur ? 0 : clamp01(0.75 * grief + 0.6 * failK);
      if (unfocus > 0.01) {
        // the blurred copy was made zoomed in a little (its edges): drawn that much smaller to line up
        const made = canvasFilters ? 1 + (4 * Math.round(24 * f.o.blur)) / 180 : 1;
        c.globalAlpha = unfocus;
        drawArt(f, 0, 0, W, H, { blur: true, zoom: zoom / made, px, py });
        c.globalAlpha = 1;
      }
      c.restore();

      // the lamps' light (how many are on, after a cut or a fail) dims or lifts the whole stage
      const m = Math.max(48, Math.min(220, Math.round(f.o.bars * 2.5)));
      if (order.length !== m) order = Float32Array.from({ length: m }, (_, i) => clamp01(i / (m - 1) + (rnd() - 0.5) * 0.12));
      const failT = end?.kind === "fail" ? end.t : null;
      let lit = 0;
      const powers = new Float32Array(m);
      for (let i = 0; i < m; i++) lit += powers[i] = react ? power(i, failT) * (1 - 0.6 * flick) : 1;
      lit /= m;
      const dark = 0.22 * (1 - lit) + 0.35 * failK;
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
        // no blend modes there (each one a pass over the window): a plain cool dark instead
        const veil = dark + 0.22 * clamp01(grief + failK) + 0.18 * danger;
        if (veil > 0.003) {
          c.fillStyle = `rgba(8,10,16,${Math.min(0.9, veil)})`;
          c.fillRect(0, 0, W, H);
        }
      } else {
        shades(c, Math.min(0.95, f.o.dim * (1 - 0.3 * light * lit) + dark), W, H);
        // the colour drains after a combo break, on low health, on a fail
        const drain = clamp01(0.85 * grief + 0.5 * danger + failK);
        if (drain > 0.01) {
          c.save();
          c.globalCompositeOperation = "saturation";
          c.globalAlpha = drain;
          c.fillStyle = "#777";
          c.fillRect(0, 0, W, H);
          c.restore();
        }
        if (danger > 0.01) {
          c.save();
          c.globalCompositeOperation = "multiply";
          c.globalAlpha = 0.32 * danger;
          c.fillStyle = "rgb(186,200,255)";
          c.fillRect(0, 0, W, H);
          c.restore();
        }
      }
      // a miss: the light dips with the lamps
      if (flick > 0) {
        c.fillStyle = `rgba(0,0,0,${0.12 * flick})`;
        c.fillRect(0, 0, W, H);
      }
      let g: CanvasGradient;
      if (f.kiai > 0.01) {
        g = c.createLinearGradient(0, H, 0, H * 0.4);
        g.addColorStop(0, css(f.look.a, 0.35 * f.kiai));
        g.addColorStop(1, css(f.look.a, 0));
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
      }
      // down to the window's edge while the transport is hidden, gliding as it fades
      const floor = y + h + f.drop;
      // the lamps' light spilling up over the picture
      swell *= Math.exp(-dt / 1.1);
      const wash = (0.05 + 0.17 * f.a.bass) * light * lit + 0.2 * swell + 0.12 * breath;
      if (wash > 0.004) {
        const q = f.look.a.map((v) => Math.round(v / 8) * 8) as Rgb;
        const spill = soft(`spill ${W}x${H} ${q}`, W, H, (s) => {
          const sg = s.createLinearGradient(0, H, 0, H * 0.35);
          sg.addColorStop(0, css(q, 1));
          sg.addColorStop(0.45, css(q, 0.3));
          sg.addColorStop(1, css(q, 0));
          s.fillStyle = sg;
          s.fillRect(0, 0, W, H);
        });
        c.save();
        c.globalCompositeOperation = "screen";
        c.globalAlpha = Math.min(0.6, wash);
        c.drawImage(spill, 0, floor - H, W, H);
        c.restore();
      }
      // sheens: a milestone, the end
      const shine = mix(f.look.ink, WARM, 0.6);
      sweeps = sweeps.filter((s) => now - s.at < s.dur);
      for (const s of sweeps) {
        const u = (now - s.at) / s.dur;
        if (u >= 0) sheen(c, 0, 0, W, H, -0.3 + 1.6 * easeInOut(u), { width: s.width, alpha: s.alpha * (calm ? 0.6 : 1), color: mix(f.look.ink, WARM, s.warm * 0.6), angle: 0.28 });
      }
      if (bulb > 0.005) {
        if (flashes) {
          c.save();
          c.globalCompositeOperation = "screen";
          c.fillStyle = css(shine, 0.2 * bulb);
          c.fillRect(0, 0, W, H);
          c.restore();
        }
        bulb *= Math.exp(-dt / 0.22);
      }
      // low health: the dark closes in, beating with the song; a fail darkens the edges too
      if (danger > 0.003 || failK > 0.003) closingDark(c, W, H, 1.15 + 1.1 * (1 - Math.max(danger, failK * 0.6)), Math.min(1, danger * (0.5 + 0.5 * hb * (calm ? 0.3 : 1)) + 0.55 * failK));

      // the strip of light along the box's floor: lamps, taller as the stage lights up
      const v = bars(f, m, f.o.mirror);
      if (heard.length !== m) heard = new Float32Array(m);
      for (let i = 0; i < m; i++) heard[i] = Math.max(v[i], heard[i] * Math.exp(-dt / 0.6));
      if (takeChord) {
        chord = Float32Array.from(heard);
        chordAt = now;
        takeChord = false;
      }
      if (chord && (chord.length !== m || now - chordAt > 9 || !react)) chord = null;
      const ring = chord ? Math.exp(-(now - chordAt) / 2.8) : 0;
      const sw = w / m;
      const maxH = h * Math.min(0.125, 0.09 * (1 + 0.32 * light * lit + 0.5 * swell + 0.25 * breath));
      const top = mix(mix(f.look.ink, DANGER, 0.55 * danger), GREY, 0.85 * failK);
      const bottom = mix(mix(f.look.a, DANGER, 0.35 * danger), GREY, 0.85 * failK);
      // by how lit they are: six levels, one fill each
      const levels = Array.from({ length: 6 }, () => new Path2D());
      const hot = new Path2D();
      const chase = (now - chaseAt) / 0.65;
      const tops = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const p = powers[i];
        // a held chord breathes a little, each lamp in its own time
        const lv = chord ? Math.max(v[i], chord[i] * ring * (0.86 + 0.14 * Math.sin(now * 2.1 + i * 0.37))) : v[i];
        const bh = Math.max(h * 0.003, lv * maxH) * (0.3 + 0.7 * p);
        const lx = x + i * sw + sw * 0.15;
        tops[i] = bh;
        levels[Math.round(clamp01(p) * 5)].rect(lx, floor - bh, sw * 0.7, bh);
        if (chase >= 0 && chase <= 1.2) {
          // a milestone runs along them, each lamp flaring as it passes
          const b = Math.exp(-(((i / (m - 1) - (chase * 1.25 - 0.1)) / 0.045) ** 2));
          if (b > 0.2) hot.rect(lx, floor - bh * (1 + 0.4 * b), sw * 0.7, bh * (1 + 0.4 * b));
        }
      }
      levels.forEach((path, k) => {
        const a = 0.12 + 0.88 * (k / 5);
        g = c.createLinearGradient(0, floor - maxH, 0, floor);
        g.addColorStop(0, css(top, 0.9 * a));
        g.addColorStop(1, css(bottom, 0.5 * a));
        c.fillStyle = g;
        c.fill(path);
      });
      if (chase >= 0 && chase <= 1.2) {
        c.fillStyle = css(shine, 0.95);
        c.fill(hot);
      }
      // light rising off the lamps (a full combo, a big milestone, a pass)
      if (!calm) {
        let n = burst + emit * dt;
        burst = 0;
        emit *= Math.exp(-dt / 1.6);
        if (emit < 0.5) emit = 0;
        const unit = h / 720;
        while (n > 0) {
          if (n >= 1 || rnd() < n) {
            const i = Math.floor(rnd() * m);
            motes.add({
              x: x + (i + 0.15 + rnd() * 0.7) * sw,
              y: floor - tops[i] * (0.3 + rnd() * 0.7),
              vx: (rnd() - 0.5) * h * 0.03,
              vy: -h * (0.07 + rnd() * 0.13),
              life: 1,
              span: 2 + rnd() * 2.4,
              r: (0.7 + rnd() * 1.5) * unit,
              sway: h * (0.004 + rnd() * 0.01),
              freq: 0.4 + rnd() * 0.9,
              phase: rnd() * TAU,
              warm: rnd() < 0.6,
            });
          }
          n -= 1;
        }
      } else burst = emit = 0;
      motes.step(dt);
      motes.draw(c, mix(f.look.ink, WHITE, 0.3), shine);

      // the words
      const mx = x + w * 0.05;
      const rx = x + w * 0.95;
      const settled = Math.abs(f.drop - textDrop) < 0.3;
      textDrop = settled ? f.drop : textDrop + (f.drop - textDrop) * (1 - Math.exp(-f.dt / 0.2));
      const ty = y + textDrop;
      // across from the title: the combo, and the accuracy and pp under it
      const showStats = !!P && f.o.stats && (P.phase === "play" || P.phase === "end");
      statsK = glide(statsK, showStats ? 1 - 0.45 * rest : 0, dt, 0.25);
      let reserve = 0;
      if (statsK > 0.005 && P) {
        const cs = h * 0.062;
        const cy = ty + h * 0.805;
        const back = now < comboBack ? 0 : easeOut((now - comboBack) / 0.2);
        combo(c, P.combo, rx, cy, cs, statsK * back * (1 - 0.4 * failK), calm);
        // a broken combo drops away
        for (let i = falling.length - 1; i >= 0; i--) {
          const fl = falling[i];
          const u = (now - fl.at) / 0.75;
          if (u >= 1) {
            falling.splice(i, 1);
            continue;
          }
          c.save();
          c.globalAlpha = statsK * Math.pow(1 - u, 1.3);
          c.translate(rx, cy + (calm ? 0 : cs * 2.4 * easeIn(u)));
          if (!calm) c.rotate(fl.spin * 0.2 * easeIn(u));
          const red = css(mix(WHITE, DANGER, 0.6));
          text(c, "×", 0, 0, cs * 0.5, { weight: 600, color: red, align: "right" });
          c.font = `600 ${cs * 0.5}px ${FONT}`;
          text(c, fl.digits, -c.measureText("×").width - cs * 0.08, 0, cs, { weight: 700, color: red, align: "right" });
          c.restore();
        }
        acc = acc < 0 ? P.accuracy : glide(acc, P.accuracy, dt, 0.12);
        pp = P.pp === null ? -1 : pp < 0 ? P.pp : glide(pp, P.pp, dt, 0.2);
        const size = h * 0.026;
        const ly = ty + h * 0.85;
        c.save();
        c.globalAlpha = statsK * (1 - 0.4 * failK);
        let right = rx;
        if (pp >= 0) {
          text(c, "pp", right, ly, size * 0.8, { weight: 600, color: "rgba(255,255,255,.45)", align: "right" });
          c.font = `600 ${size * 0.8}px ${FONT}`;
          right -= c.measureText("pp").width + size * 0.15;
          text(c, String(Math.round(pp)), right, ly, size, { weight: 600, color: "rgba(255,255,255,.62)", align: "right" });
          c.font = `600 ${size}px ${FONT}`;
          right -= c.measureText(String(Math.round(pp))).width + size * 0.9;
        }
        text(c, pct(acc), right, ly, size, { weight: 600, color: "rgba(255,255,255,.86)", align: "right" });
        c.restore();
        c.font = `700 ${cs}px ${FONT}`;
        reserve = (Math.max(3, String(P.combo).length) * c.measureText("0").width + cs * 0.6 + h * 0.05) * statsK;
      }
      if (f.o.title) {
        const maxW = w * 0.88 - reserve;
        const fade = 1 - 0.45 * failK;
        text(c, f.meta.title, mx, ty + h * 0.74, h * 0.1, { weight: 700, color: `rgba(255,255,255,${fade})`, maxW });
        text(c, f.meta.artist, mx, ty + h * 0.805, h * 0.036, { weight: 550, color: `rgba(255,255,255,${0.82 * fade})`, maxW: Math.min(w * 0.7, maxW) });
        text(c, f.meta.version, mx, ty + h * 0.85, h * 0.024, { weight: 500, color: `rgba(255,255,255,${0.55 * fade})`, maxW: Math.min(w * 0.7, maxW) });
        // over the title, how it ended: the letters coming up one after another
        endK = glide(endK, end ? end.k : 0, dt, 0.15);
        if (ending && endK > 0.005) {
          const e0 = ending;
          const age = now - e0.at;
          const size = h * 0.022;
          const ey = ty + h * 0.652;
          const from = e0.kind === "fail" ? 0.45 : 0.22;
          const base = e0.kind === "fc" ? shine : e0.kind === "pass" ? f.look.ink : WHITE;
          const width = spacedWidth(c, e0.text, size, 700, 0.34);
          // a full combo's name gets a sheen across it once it's there
          let color: string | CanvasGradient = css(base, e0.kind === "fail" ? 0.62 : 0.97);
          const su = (age - 1.3) / 0.9;
          if (e0.kind === "fc" && su > 0 && su < 1) {
            const sg = c.createLinearGradient(mx, 0, mx + width, 0);
            const p = -0.2 + 1.4 * easeInOut(su);
            sg.addColorStop(0, css(base, 0.97));
            if (p - 0.15 > 0 && p - 0.15 < 1) sg.addColorStop(p - 0.15, css(base, 0.97));
            if (p > 0 && p < 1) sg.addColorStop(p, "rgba(255,255,255,1)");
            if (p + 0.15 > 0 && p + 0.15 < 1) sg.addColorStop(p + 0.15, css(base, 0.97));
            sg.addColorStop(1, css(base, 0.97));
            color = sg;
          }
          c.save();
          c.globalAlpha = endK;
          spaced(c, e0.text, mx, ey, size, {
            weight: 700,
            spacing: 0.34,
            color,
            each: (i) => {
              const u = (age - from - i * 0.035) / 0.32;
              const k = calm ? clamp01(u) : easeOut(u);
              return { alpha: k, dy: calm ? 0 : (1 - k) * size * 0.55 };
            },
          });
          if (e0.detail) {
            const k = easeOut((age - from - e0.text.length * 0.035 - 0.15) / 0.45);
            c.globalAlpha = endK * k * 0.8;
            text(c, e0.detail, mx + width + size * 1.2, ey + (calm ? 0 : (1 - k) * size * 0.35), size, { weight: 550, color: "#fff" });
          }
          c.restore();
        }
      }
      // still moving: the title gliding after the strip, the camera settling, light in the air
      const camMoving = !calm && !(cam.x.settled() && cam.y.settled(0.016 * failK) && cam.r.settled(-0.008 * failK));
      return !settled || camMoving || !!P || motes.list.length > 0 || sweeps.length > 0 || falling.length > 0 || statsK > 0.005 || endK > 0.005 || ring > 0.01 || bulb > 0.005 || swell > 0.01 || flick > 0;
    },
  };
}
