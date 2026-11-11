/* hud.ts — the live overlay (/obs/hud): over the game, no panels, every part on its own where the
 * skin leaves room for it (lib/hud-layout, arranged in Fumen: views/hud-editor.ts). At first the
 * map's progress runs along the top edge, the title and the stars sit in the corners above, the
 * combo with its health on the left, accuracy and pp on the right, the lamps along the floor.
 *
 * What only Fumen knows is on the progress line, not in sentences: a notch where each earlier try
 * ended, the part where most of them did (with a flag and how many), the furthest any got. Coming
 * up to that part it lights up; getting through it alive ticks it off; getting past the furthest
 * says so at the head of the line. The end says what it means against the tries before (Fumen's
 * lines): a first pass after N, a new best and what it gained, the same place again.
 *
 * Under it all the screen answers like Stage does (it is Stage, see-through, without words:
 * ./stage's mountVisualizer): the lamps light up with the combo and go out after a break, a
 * milestone runs along them, low health closes in from the edges with the song's beat, a full
 * combo sweeps light over everything. The numbers answer too: a miss makes the combo flicker, a
 * combo break drops it away in red and shakes it by how much it hurt, a milestone pops it, a pass
 * turns it into the rank, a fail greys everything out.
 *
 * The source: the stream's size (1920 × 1080), over the game or over where the game sits. */
import { pct, srColor, srInk } from "../lib/format";
import { HUD_PARTS, hudPrefs, type HudPartId, type HudPrefs } from "../lib/hud-layout";
import { t } from "../lib/i18n";
import type { ObsBest, ObsTries } from "../lib/obs-parts";
import { DEFAULT_PREFS } from "../lib/store";
import { STATE } from "../lib/tosu";
import type { VisPrefs } from "../lib/types";
import { beatAt } from "../lib/vis/beat";
import type { FeelEvent, FeelFrame } from "../lib/vis/feel";
import { reduceMotion } from "../ui/controls";
import { icon, injectIconSprite } from "../ui/icons";
import type { Strip } from "../views/vis/draw";
import { endWords, type Said } from "./lines";
import { artUrl, editing, link, parts } from "./link";
import { inMap, live } from "./live";
import { accentFrom } from "./look";
import { Odometer } from "./odometer";
import { RANKS } from "./ranks";
import { mountVisualizer } from "./stage";

/** what Feel says while nothing goes on */
const IDLE: FeelFrame = {
  phase: "idle",
  mode: 0,
  combo: 0,
  maxCombo: 0,
  misses: 0,
  accuracy: 1,
  pp: null,
  rank: "",
  health: null,
  energy: 0,
  grief: 0,
  danger: 0,
  breath: 0,
  rest: 0,
  sinceMiss: Infinity,
  sinceBreak: Infinity,
  breakSize: 0,
  end: null,
  events: [],
};

/** the order the parts come in when a map starts */
const ORDER: HudPartId[] = ["title", "stars", "combo", "hp", "acc", "pp", "lines"];

const EASE_OUT = "cubic-bezier(.22,1,.36,1)";
const POP = "cubic-bezier(.34,1.56,.64,1)";
/** seconds before the part where tries ended that it lights up */
const AHEAD = 6;
/** seconds "further than ever" stays at the head of the line */
const BEYOND_FOR = 4.5;

const glide = (v: number, to: number, dt: number, tau: number): number => v + (to - v) * (1 - Math.exp(-dt / tau));
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const per = (v: number): string => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(3)}%`;
/** a word letter by letter, each with its place for the stagger */
const spelled = (text: string): string => [...text].map((ch, i) => `<span style="--i:${i}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
const said = (s: Said): string => `<span class="tone-${s.tone}">${icon(s.icon)}<span>${esc(s.text)}</span></span>`;

function starsAt(rate: number): number | null {
  const m = parts.map;
  if (!m) return null;
  if (rate > 1.25 && m.srDt) return m.srDt;
  if (rate < 0.9 && m.srHt) return m.srHt;
  return m.sr;
}

export function start(): void {
  injectIconSprite();
  const root = document.getElementById("obs")!;
  // being arranged: Fumen's lines are only there at the end, so something stands in for them
  const ghost = editing
    ? `<div class="hud-ghost"><div class="hud-endname">${spelled(t("Full combo").toLocaleUpperCase())}</div><div class="hud-say">${said({ text: t("New best, +{pp} pp", { pp: 14 }), icon: "star", tone: "accent" })}</div></div>`
    : "";
  root.innerHTML = `
    <canvas class="obs-canvas"></canvas>
    <div class="hud" data-phase="off" data-end="">
      <div class="hud-part" data-part="vis"></div>
      <div class="hud-part" data-part="bar"><div class="hud-in"><div class="hud-bar">
        <div class="hud-bar-line"><i class="hud-bar-fill"></i></div>
        <div class="hud-ends"></div>
        <div class="hud-zone" hidden><i class="hud-zone-band"></i><span class="hud-zone-tag">${icon("flag")}${icon("check")}<b></b></span></div>
        <i class="hud-far" hidden></i>
        <span class="hud-beyond"><span>${t("Further than ever")}</span></span>
      </div></div></div>
      <div class="hud-part" data-part="title"><div class="hud-in"><b class="hud-name"></b><span class="hud-sub"></span></div></div>
      <div class="hud-part" data-part="stars"><div class="hud-in"><span class="hud-sr"></span><span class="hud-mods"></span></div></div>
      <div class="hud-part" data-part="combo"><div class="hud-in"><div class="hud-swap">
        <div class="hud-combo">
          <span class="hud-label">${t("Combo")}</span>
          <div class="hud-big"><span class="hud-count"></span><span class="hud-x">×</span></div>
        </div>
        <div class="hud-result"><b class="hud-rank"></b></div>
      </div></div></div>
      <div class="hud-part" data-part="hp"><div class="hud-in"><div class="hud-hp"><i></i></div></div></div>
      <div class="hud-part" data-part="acc"><div class="hud-in"><span class="hud-label">${t("Accuracy")}</span><b class="hud-acc"></b></div></div>
      <div class="hud-part" data-part="pp"><div class="hud-in"><span class="hud-label">pp</span><b class="hud-pp"></b></div></div>
      <div class="hud-part" data-part="lines"><div class="hud-in"><div class="hud-endname"></div><div class="hud-say"></div><div class="hud-say"></div>${ghost}</div></div>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const hud = $(".hud");
  const swap = $(".hud-swap");
  const big = $(".hud-big");
  const combo = new Odometer();
  $(".hud-count").append(combo.el);
  const acc = $(".hud-acc");
  const pp = $(".hud-pp");
  const hp = $(".hud-hp");
  const hpFill = $(".hud-hp i");
  const fill = $(".hud-bar-fill");
  const ends = $(".hud-ends");
  const zone = $(".hud-zone");
  const zoneTag = $(".hud-zone-tag");
  const zoneCount = $(".hud-zone-tag b");
  const far = $(".hud-far");
  const beyond = $(".hud-beyond");
  const endName = $('.hud-part[data-part="lines"] .hud-in > .hud-endname');
  const [sayFirst, saySecond] = [...root.querySelectorAll<HTMLElement>('.hud-part[data-part="lines"] .hud-in > .hud-say')];

  // ── where each part sits ──
  const partEl = {} as Record<HudPartId, HTMLElement>;
  for (const { id } of HUD_PARTS) partEl[id] = $(`.hud-part[data-part="${id}"]`);
  let look: HudPrefs = hudPrefs(parts.config?.hud);
  const place = (): void => {
    look = hudPrefs(parts.config?.hud);
    for (const { id } of HUD_PARTS) {
      const p = look.layout[id];
      const el = partEl[id];
      const s = el.style;
      el.hidden = !p.on;
      s.setProperty("--x", String(p.x));
      s.setProperty("--y", String(p.y));
      s.setProperty("--ax", String(p.ax));
      s.setProperty("--ay", String(p.ay));
      s.setProperty("--size", String(p.size));
      s.setProperty("--w", String(p.w));
      s.setProperty("--h", String(p.h));
      el.dataset.align = p.ax === 0 ? "start" : p.ax === 1 ? "end" : "center";
      el.dataset.side = p.ay === 1 ? "up" : "down";
      // it comes in from the edge it's pinned to (from above or below in the middle)
      s.setProperty("--dx", String(p.ax === 0 ? -1 : p.ax === 1 ? 1 : 0));
      s.setProperty("--dy", String(p.ax === 0.5 ? (p.ay === 0 ? -1 : 1) : 0));
      s.setProperty("--k", String(Math.max(0, ORDER.indexOf(id))));
    }
  };
  place();
  link.on("config", place);

  // ── the screen under it: Stage, see-through, without its words, its lamps where their part is ──
  const canvas = $<HTMLCanvasElement>("canvas");
  let feel: FeelFrame | null = null;
  const prefs = (): VisPrefs => ({
    ...DEFAULT_PREFS.visualizer,
    ...(parts.config?.vis ?? {}),
    style: "stage",
    title: false,
    stats: false,
    video: false,
    react: true,
  });
  const strip = (): Strip | null => {
    const v = look.layout.vis;
    if (!v.on) return null;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const y = (v.y - v.ay * v.h) * H;
    return { x: (v.x - v.ax * v.w) * W, y, w: v.w * W, h: v.h * H, flip: y + (v.h * H) / 2 < H / 2 };
  };
  const screen = mountVisualizer(canvas, {
    clear: true,
    lamps: () => look.layout.vis.on,
    strip,
    screen: () => look.react,
    fumen: false,
    prefs,
    play: () => feel,
  });

  // ── the map: its title, its stars ──
  let headKey = "";
  const head = (tries: ObsTries | null): void => {
    const now = live.now!;
    const m = parts.map?.md5 === now.md5 ? parts.map : null;
    const stars = starsAt(now.rate);
    const mods = now.play.modList.filter((x) => x !== "CL");
    const speed = Math.abs(now.rate - 1) > 0.001 && !mods.some((x) => ["DT", "NC", "HT", "DC"].includes(x)) ? `${String(Math.round(now.rate * 100) / 100)}×` : "";
    const n = (tries?.count ?? 0) + 1;
    const key = `${now.md5} ${m?.title} ${m?.bg} ${stars} ${mods.join("")} ${speed} ${n}`;
    if (key === headKey) return;
    headKey = key;
    $(".hud-name").textContent = m?.title ?? now.title;
    $(".hud-sub").textContent = [m?.version ?? now.version, t("Try {n}", { n })].filter(Boolean).join("  ·  ");
    const sr = $(".hud-sr");
    sr.hidden = !stars;
    if (stars) {
      sr.innerHTML = `${stars.toFixed(2)}<small>★</small>`;
      sr.style.setProperty("--c", srColor(stars));
      sr.style.setProperty("--ink", srInk(stars));
    }
    $(".hud-mods").textContent = [...mods, speed].filter(Boolean).join(" ");
    accentFrom(m?.bg ? artUrl(m.bg, 320) : null);
  };

  // ── what only Fumen knows, on the progress line ──
  let marksKey = "";
  const marks = (tr: ObsTries | null): void => {
    const now = live.now;
    const span = now && now.lastObject !== null ? now.lastObject - (now.firstObject ?? 0) : null;
    const key = `${tr?.md5} ${tr?.count} ${span}`;
    if (key === marksKey) return;
    marksKey = key;
    ends.innerHTML = (tr?.ends ?? []).map((e) => `<i style="left:${per(e)}"></i>`).join("");
    const first = now?.firstObject ?? 0;
    zone.hidden = !(tr?.spot && span);
    if (tr?.spot && span) {
      zone.style.left = per((tr.spot.a - first) / span);
      zone.style.width = `${Math.max(0.4, ((tr.spot.b - tr.spot.a) / span) * 100).toFixed(3)}%`;
      zoneCount.textContent = String(tr.spot.stops);
    }
    const rec = tr && tr.count && tr.furthest !== null && tr.furthest < 1 ? tr.furthest : null;
    far.hidden = rec === null;
    if (rec !== null) far.style.left = per(rec);
    fill.style.setProperty("--rec", rec === null ? "100%" : per(rec));
  };

  const say = (el: HTMLElement, s: Said | null, delay: number): void => {
    el.innerHTML = s ? said(s) : "";
    if (s && !reduceMotion()) (el.firstElementChild as HTMLElement).animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 480, delay, easing: EASE_OUT, fill: "backwards" });
  };

  // ── the numbers' moments ──
  const shake = (size: number): void => {
    if (reduceMotion()) return;
    const d = 4 + 9 * size;
    swap.animate([{ transform: "none" }, { transform: `translateX(${-d}px)` }, { transform: `translateX(${d * 0.75}px)` }, { transform: `translateX(${-d * 0.4}px)` }, { transform: `translateX(${d * 0.15}px)` }, { transform: "none" }], { duration: 320 + 180 * size, easing: "ease-out" });
  };
  const drop = (lost: number, size: number): void => {
    if (reduceMotion()) return;
    const el = document.createElement("span");
    el.className = "hud-fall";
    el.innerHTML = `${lost}<small>×</small>`;
    big.append(el);
    const spin = Math.random() < 0.5 ? -1 : 1;
    el.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: `translate(${spin * 10}px, ${40 + 50 * size}px) rotate(${spin * (4 + 7 * size)}deg)`, opacity: 0 },
      ],
      { duration: 650 + 250 * size, easing: "cubic-bezier(.55,0,.8,.3)", fill: "forwards" },
    ).onfinish = () => el.remove();
    combo.el.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: 380, delay: 220, easing: EASE_OUT, fill: "backwards" });
  };
  const pop = (): void => {
    if (reduceMotion()) return;
    big.animate([{ transform: "scale(1)" }, { transform: "scale(1.09)", offset: 0.35 }, { transform: "scale(1)" }], { duration: 480, easing: POP });
  };
  const flicker = (): void => {
    if (reduceMotion()) return;
    combo.el.animate([{ opacity: 1 }, { opacity: 0.3, offset: 0.2 }, { opacity: 0.85, offset: 0.45 }, { opacity: 0.45, offset: 0.6 }, { opacity: 1 }], { duration: 190 });
  };

  // ── the try ──
  let startTries: ObsTries | null = null;
  let startBest: ObsBest | null = null;
  let beyondAt = -Infinity;
  let zoneState = "";
  let accShown = -1;
  let ppShown = -1;
  let hpShown = 1;
  let lastBeat = Number.NaN;
  let endKind = "";
  let endAt = 0;
  let passPp: number | null = null;
  let passScore = 0;
  let resultsTaken = false;
  let worded = false;

  const begin = (): void => {
    const md5 = live.now?.md5 ?? "";
    startTries = parts.tries?.md5 === md5 ? parts.tries : null;
    startBest = (parts.map?.md5 === md5 ? parts.map.best : null) ?? startTries?.best ?? null;
    beyondAt = -Infinity;
    zoneState = "";
    accShown = -1;
    ppShown = -1;
    hpShown = 1;
    endKind = "";
    resultsTaken = false;
    worded = false;
    marksKey = "";
    hud.dataset.end = "";
    zone.dataset.state = "";
    beyond.classList.remove("on");
    far.classList.remove("passed");
    endName.innerHTML = "";
    sayFirst.innerHTML = "";
    saySecond.innerHTML = "";
    combo.set(0, true);
    for (const f of big.querySelectorAll(".hud-fall")) f.remove();
  };

  const onEvent = (e: FeelEvent, f: FeelFrame): void => {
    switch (e.kind) {
      case "start":
        begin();
        break;
      case "miss":
        if (!f.events.some((x) => x.kind === "break")) flicker();
        break;
      case "break":
        drop(e.lost, e.size);
        shake(e.size);
        combo.set(f.combo, true);
        break;
      case "milestone":
        pop();
        break;
      case "fc":
      case "pass":
      case "fail": {
        const kind = e.kind;
        endKind = kind;
        endAt = (live.song()?.pos ?? 0) * 1000;
        resultsTaken = false;
        worded = false;
        passPp = live.now?.play.pp ?? null;
        passScore = live.now?.play.score ?? 0;
        const rank = e.kind === "fail" ? null : (RANKS[e.rank] ?? null);
        const name = (
          e.kind === "fail"
            ? e.progress === null
              ? t("Failed")
              : t("Failed at {at}", { at: pct(e.progress, 0) })
            : e.kind === "fc"
              ? t("Full combo")
              : t("Passed")
        ).toLocaleUpperCase();
        window.setTimeout(
          () => {
            if (endKind !== kind) return;
            hud.dataset.end = kind;
            const r = $(".hud-rank");
            r.textContent = rank?.label ?? "";
            r.style.color = rank?.color ?? "";
            endName.innerHTML = spelled(name);
          },
          kind === "fail" ? 0 : 280,
        );
        break;
      }
    }
  };

  // ── every frame ──
  let last = performance.now();
  const frame = (tm: number): void => {
    const dt = Math.min(0.1, Math.max(0, (tm - last) / 1000));
    last = tm;
    feel = live.feel.frame(dt, tm / 1000);
    const f = feel ?? IDLE;
    const now = live.now;
    for (const e of f.events) onEvent(e, f);
    // osu!'s fail screen is still "playing" to tosu: here it's the end
    const failing = !!now && endKind === "fail" && now.state === STATE.play;
    const playing = !!now && !failing && (f.phase === "play" || f.phase === "hold") && now.state === STATE.play;
    const ended = !!now && (failing || (f.phase === "end" && inMap(now.state)));
    const phase = !now ? "off" : playing ? "play" : ended ? "end" : "select";
    if (hud.dataset.phase !== phase) {
      if (phase === "play" && hud.dataset.phase !== "end") begin();
      // out of the map: the end's look goes with it
      if (phase === "select" || phase === "off") {
        endKind = "";
        hud.dataset.end = "";
      }
      hud.dataset.phase = phase;
    }
    screen.frame(dt);

    const tr = now && parts.tries?.md5 === now.md5 ? parts.tries : null;
    // tries that came in late (the page just opened, the last try was still being kept): while the
    // map runs this one can't be among them yet, so they're the ones before it
    if (playing && tr && (!startTries || tr.count > startTries.count)) {
      startTries = tr;
      startBest = (parts.map?.md5 === tr.md5 ? parts.map.best : null) ?? tr.best;
    }
    if (now && (playing || ended)) {
      head(startTries);
      marks(startTries);
      update(f, dt, tm, playing, ended);
    }
    requestAnimationFrame(frame);
  };

  const update = (f: FeelFrame, dt: number, tm: number, playing: boolean, ended: boolean): void => {
    const now = live.now!;
    // the numbers
    if (combo.current !== f.combo) combo.set(f.combo);
    accShown = accShown < 0 ? f.accuracy : glide(accShown, f.accuracy, dt, 0.12);
    acc.innerHTML = esc(pct(accShown)).replace(/(\s?%)$/, "<small>$1</small>");
    if (f.pp === null) pp.textContent = "–";
    else {
      ppShown = ppShown < 0 ? f.pp : glide(ppShown, f.pp, dt, 0.2);
      pp.textContent = String(Math.round(ppShown));
    }
    const health = endKind === "fail" ? 0 : (f.health ?? 1);
    hpShown = glide(hpShown, health, dt, 0.18);
    hpFill.style.transform = `scaleX(${hpShown.toFixed(4)})`;
    hud.style.setProperty("--low", f.danger.toFixed(3));
    const song = live.song();
    const at = (song?.pos ?? 0) * 1000;
    // low health: the bar beats with the song
    const beats = parts.map?.md5 === now.md5 ? parts.map.beats : [];
    const beat = song && beats.length ? beatAt(beats, at) : null;
    if (beat && beat.key !== lastBeat && f.danger > 0.3 && !reduceMotion())
      hp.animate([{ filter: "brightness(1.7)", transform: "scaleY(1.7)" }, { filter: "none", transform: "none" }], { duration: 280, easing: "ease-out" });
    lastBeat = beat ? beat.key : Number.NaN;

    // the progress line
    const prog = live.progress();
    const p = ended && endKind !== "fail" ? 1 : (prog ?? 0);
    fill.style.clipPath = `inset(0 ${(100 - Math.min(1, Math.max(0, p)) * 100).toFixed(3)}% 0 0)`;
    const tries = startTries;
    const rec = tries && tries.count && tries.furthest !== null && tries.furthest < 1 ? tries.furthest : null;
    if (playing && rec !== null && prog !== null && prog > rec && beyondAt === -Infinity) {
      beyondAt = tm;
      far.classList.add("passed");
      beyond.classList.add("on");
    }
    if (beyond.classList.contains("on")) {
      beyond.style.left = per(p);
      if ((tm - beyondAt) / 1000 > BEYOND_FOR) beyond.classList.remove("on");
    }
    // the part where most tries ended: coming up, in it, through it
    const s = tries?.spot;
    if (s && !zone.hidden) {
      const failedThere = endKind === "fail" && endAt >= s.a - 1500 && endAt <= s.b + 1500;
      const next = failedThere ? "failed" : at > s.b ? "cleared" : at >= s.a ? "in" : at >= s.a - AHEAD * 1000 ? "near" : "ahead";
      if (next !== zoneState) {
        const was = zoneState;
        zoneState = next;
        zone.dataset.state = next;
        if (!reduceMotion() && (next === "near" || next === "failed" || (next === "cleared" && was === "in")))
          zoneTag.animate([{ transform: "scale(1)" }, { transform: "scale(1.24)", offset: 0.4 }, { transform: "scale(1)" }], { duration: 540, easing: POP });
        if (next === "failed") zoneCount.textContent = String(s.stops + 1);
      }
    }

    // the end, against the tries before
    if (ended && !resultsTaken && now.results) {
      resultsTaken = true;
      passPp = now.results.pp ?? passPp;
      passScore = now.results.score || passScore;
    }
    if (ended && endKind && !worded && (resultsTaken || endKind === "fail" || (f.end?.t ?? 0) > 2.5)) {
      worded = true;
      const w = endWords({ tries, best: startBest, at: endAt, kind: endKind as "fc" | "pass" | "fail", score: passScore, pp: passPp });
      say(sayFirst, w.left, 650);
      say(saySecond, w.right, 800);
    }
  };
  requestAnimationFrame(frame);
  link.on("tries", () => (marksKey = ""));

  // being arranged: where each part is, for the editor's handles (0–1 of the page)
  if (editing)
    (window as unknown as { fumenHud: unknown }).fumenHud = {
      rects(): Partial<Record<HudPartId, { x: number; y: number; w: number; h: number }>> {
        const W = innerWidth;
        const H = innerHeight;
        const out: Partial<Record<HudPartId, { x: number; y: number; w: number; h: number }>> = {};
        for (const { id } of HUD_PARTS) {
          const el = partEl[id];
          if (el.hidden) continue;
          const r = el.getBoundingClientRect();
          out[id] = { x: r.left / W, y: r.top / H, w: r.width / W, h: r.height / H };
        }
        return out;
      },
    };
}
