/* card.ts — the song card (/obs/card): when a map starts in osu!, what it is, for a few seconds,
 * then out of the way (a retry of the same map doesn't bring it back). The only thing on screen
 * with a shape of its own while playing, and only at the start.
 *
 * The cover on the left; next to it the ruleset and difficulty, the title, the artist, the mapper,
 * the stars (in osu!'s colour, counting up), BPM and length at the rate played, the dan and what
 * the chart is made of (osu!mania), and your best on it. A bar in the accent grows beside the words
 * as they're uncovered line by line; the cover is uncovered from the left. It holds still, then
 * goes the way it came, quicker.
 *
 * Address options: `delay` (seconds after the start, default 1), `hold` (seconds shown, default 7).
 * The source: the stream's size (1920 × 1080); the card sits on the left, a little below the middle. */
import { bpm, duration, MODE_SHORT, pct, srColor, srInk } from "../lib/format";
import { t } from "../lib/i18n";
import type { ObsMap } from "../lib/obs-parts";
import { reduceMotion } from "../ui/controls";
import { artUrl, link, params, parts } from "./link";
import { live } from "./live";
import { accentFrom } from "./look";

const num = (k: string, def: number, lo: number, hi: number): number => {
  const v = Number(params.get(k));
  return Number.isFinite(v) && params.has(k) ? Math.min(hi, Math.max(lo, v)) : def;
};

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const RANK: Record<string, string> = { XH: "SS", SSH: "SS", X: "SS", SS: "SS", SH: "S", S: "S", A: "A", B: "B", C: "C", D: "D" };

function starsAt(m: ObsMap, rate: number): number | null {
  if (rate > 1.25 && m.srDt) return m.srDt;
  if (rate < 0.9 && m.srHt) return m.srHt;
  return m.sr;
}

export function start(): void {
  const delay = num("delay", 1, 0, 30) * 1000;
  const hold = num("hold", 7, 2, 60) * 1000;
  const root = document.getElementById("obs")!;
  root.innerHTML = `<div class="card" data-state="out"></div>`;
  const card = root.querySelector<HTMLElement>(".card")!;
  let shown = "";
  let timers: number[] = [];

  const clear = (): void => {
    for (const id of timers) clearTimeout(id);
    timers = [];
  };

  const fill = (m: ObsMap, rate: number): number | null => {
    const stars = starsAt(m, rate);
    const kind = m.mode === 3 && m.keys ? `${m.keys}K` : (MODE_SHORT[m.mode as 0] ?? "osu!");
    const facts = [m.bpm ? `${bpm(m.bpm * rate)} BPM` : "", m.length ? duration(m.length / rate) : "", m.dan ?? "", m.patterns.join(", ")].filter(Boolean);
    const best = m.best ? [m.best.rank ? (RANK[m.best.rank] ?? m.best.rank) : "", pct(m.best.accuracy)].filter(Boolean).join("  ·  ") : "";
    const line = (cls: string, html: string, i: number) => `<div class="card-line ${cls}" style="--i:${i}"><div>${html}</div></div>`;
    let i = 0;
    card.innerHTML = `
      <div class="card-cover">${m.bg ? `<img alt="" src="${artUrl(m.bg, 640)}" />` : ""}</div>
      <div class="card-words">
        <i class="card-bar"></i>
        ${line("card-kind", `${esc(kind)}<span>${esc(m.version)}</span>`, i++)}
        ${line("card-title", esc(m.title), i++)}
        ${line("card-artist", esc(m.artist), i++)}
        ${m.creator ? line("card-mapper", esc(t("mapped by {name}", { name: m.creator })), i++) : ""}
        ${line(
          "card-facts",
          `${stars ? `<span class="card-sr" style="--c:${srColor(stars)};--ink:${srInk(stars)}"><b>${stars.toFixed(2)}</b><small>★</small></span>` : ""}${facts.map((f) => `<span>${esc(f)}</span>`).join("")}`,
          i++,
        )}
        ${best ? line("card-best", `<span>${esc(t("Your best"))}</span>${esc(best)}`, i++) : ""}
      </div>`;
    accentFrom(m.bg ? artUrl(m.bg, 320) : null);
    return stars;
  };

  /** the stars counting up to where they are */
  const countUp = (to: number): void => {
    const b = card.querySelector<HTMLElement>(".card-sr b");
    if (!b || reduceMotion()) return;
    const t0 = performance.now() + 380;
    const step = (now: number): void => {
      const u = Math.min(1, Math.max(0, (now - t0) / 750));
      b.textContent = (to * (1 - Math.pow(1 - u, 3))).toFixed(2);
      if (u < 1 && card.dataset.state === "in") requestAnimationFrame(step);
    };
    b.textContent = "0.00";
    requestAnimationFrame(step);
  };

  const show = (md5: string, wait = delay): void => {
    clear();
    const at = performance.now();
    const go = (): void => {
      const now = live.now;
      const m = parts.map?.md5 === md5 ? parts.map : null;
      // what the window knows about it may come a moment after the start
      if (!m) {
        if (performance.now() - at < wait + 3000) timers.push(window.setTimeout(go, 150));
        return;
      }
      const stars = fill(m, now?.md5 === md5 ? now.rate : 1);
      card.dataset.state = "in";
      if (stars) countUp(stars);
      timers.push(window.setTimeout(() => (card.dataset.state = "out"), hold));
    };
    timers.push(window.setTimeout(go, wait));
  };

  live.bus.on("start", (now) => {
    if (now.md5 === shown) return;
    shown = now.md5;
    show(now.md5);
  });
  // out of the map before the card has gone: it goes too
  live.bus.on("leave", () => {
    clear();
    card.dataset.state = "out";
  });
  // a button in Fumen's settings: now, for the map osu! is on
  link.on("cue", (c) => {
    if (c?.kind !== "card") return;
    const md5 = live.now?.md5 ?? parts.map?.md5;
    if (md5) show(md5, 0);
  });
}
