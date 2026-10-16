// home.js — the homepage: the download buttons (from the update server) and four scenes that show
// what Fumen does. A scene is a pure function of time: frame(t) draws it at t seconds into a loop of
// `duration`, and the end looks exactly like the start, so the loop never jumps. Scenes only run
// while they're on screen; with reduced motion they hold one still frame.
"use strict";

// ── helpers ──────────────────────────────────────────────────────────────

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
/** progress through [a, b] */
const span = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;
const outQuint = (p) => 1 - (1 - p) ** 5;
const outCubic = (p) => 1 - (1 - p) ** 3;
const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const outBack = (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
/** a pulse: 0 → 1 → 0 over [a, b] */
const bump = (t, a, b) => Math.sin(Math.PI * span(t, a, b));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

/** Sets a style only when it changes (frames run 60 times a second). */
function css(e, prop, value) {
  const k = "_" + prop;
  if (e[k] === value) return;
  e[k] = value;
  e.style.setProperty(prop, value);
}

const fmt = (v, d = 2) => v.toFixed(d);

// osu!'s star-rating colours, as Fumen draws them
const SR_DOMAIN = [0.1, 1.25, 2, 2.5, 3.3, 4.2, 4.9, 5.8, 6.7, 7.7, 9];
const SR_RANGE = ["#4290fb", "#4fc0ff", "#4fffd5", "#7cff4f", "#f6f05c", "#ff8068", "#ff4e6f", "#c645b8", "#6563de", "#18158e", "#000000"].map((h) =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)),
);
function srColor(sr) {
  let i = 0;
  while (i < SR_DOMAIN.length - 2 && sr > SR_DOMAIN[i + 1]) i++;
  const t = clamp((sr - SR_DOMAIN[i]) / (SR_DOMAIN[i + 1] - SR_DOMAIN[i]));
  const c = SR_RANGE[i].map((a, k) => Math.round(((a / 255) ** 2.2 * (1 - t) + (SR_RANGE[i + 1][k] / 255) ** 2.2 * t) ** (1 / 2.2) * 255));
  return `rgb(${c.join(",")})`;
}
const srChip = (sr) => `<span class="sx-sr" style="background:${srColor(sr)};color:${sr >= 6.5 ? "#ffd966" : "rgba(0,0,0,.78)"}">★ ${sr.toFixed(2)}</span>`;

// ── made-up covers: skies, a sun or moon, hills (no one's artwork) ───────

const PALETTES = [
  ["#ffb199", "#ff6f91", "#ffe3b3", "#7b2f5e", "#3d1838", 0],
  ["#1c2a6b", "#4f63c8", "#f6f1c7", "#1a2350", "#0b1029", 1],
  ["#b4f2dd", "#3eb6a8", "#fff8dc", "#25695f", "#113a35", 0],
  ["#ffd27a", "#f0874a", "#fff4b8", "#7a3a2c", "#3a1c17", 0],
  ["#cdb8ff", "#7d5cf0", "#ffe7f7", "#3c2b72", "#1d1542", 1],
  ["#a8d8ff", "#5d8bff", "#ffffff", "#2f4194", "#172256", 0],
  ["#ffc2d4", "#ff7ba6", "#fff1f6", "#8a3159", "#461731", 0],
  ["#dff7b0", "#7fc779", "#fffde3", "#316e3c", "#163b21", 0],
  ["#2b1d4f", "#8a4fbf", "#ffd6f0", "#24163f", "#100a22", 1],
  ["#ffe0a6", "#ff9a62", "#fff6d6", "#5a3570", "#2a1838", 0],
];
const covers = new Map();
function cover(i) {
  if (covers.has(i)) return covers.get(i);
  const W = 240;
  const H = 136;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const [s1, s2, sun, h1, h2, night] = PALETTES[i % PALETTES.length];
  const r = rng(i * 977 + 13);
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, s1);
  sky.addColorStop(1, s2);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  if (night) {
    g.fillStyle = "rgba(255,255,255,.8)";
    for (let k = 0; k < 40; k++) g.fillRect(r() * W, r() * H * 0.6, r() < 0.2 ? 2 : 1, r() < 0.2 ? 2 : 1);
  }
  const sx = 40 + r() * (W - 80);
  const sy = 30 + r() * 30;
  const sr = 14 + r() * 16;
  const halo = g.createRadialGradient(sx, sy, sr * 0.6, sx, sy, sr * 3);
  halo.addColorStop(0, sun + "88");
  halo.addColorStop(1, sun + "00");
  g.fillStyle = halo;
  g.fillRect(0, 0, W, H);
  g.fillStyle = sun;
  g.beginPath();
  g.arc(sx, sy, sr, 0, Math.PI * 2);
  g.fill();
  for (const [col, base, amp] of [[h1, 0.62, 16], [h2, 0.8, 12]]) {
    const f1 = 0.01 + r() * 0.02;
    const f2 = 0.03 + r() * 0.03;
    const p1 = r() * 6;
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) g.lineTo(x, H * base + Math.sin(x * f1 + p1) * amp + Math.sin(x * f2) * amp * 0.35);
    g.lineTo(W, H);
    g.fill();
  }
  const url = c.toDataURL("image/png");
  covers.set(i, url);
  return url;
}

// ── a cursor that moves between points and clicks ────────────────────────

const CURSOR_SVG = `<svg viewBox="0 0 20 20"><path d="M3 1.8v13.6l3.7-3.5 2.6 5.8 2.3-1-2.6-5.7h5.1z" fill="#fff" stroke="rgba(0,0,0,.65)" stroke-width="1.1" stroke-linejoin="round"/></svg>`;

/** `path`: [time, x, y] stops (eased between, held where two stops share a point); `clicks`: times;
 * `shown`: the [from, to] stretches it's on screen (it fades in and out at their ends) */
function cursor(root, path, clicks, shown) {
  const c = el("div", "sx-cursor", root, CURSOR_SVG);
  const ring = el("div", "sx-click", root);
  return (t) => {
    let i = 0;
    while (i < path.length - 2 && t >= path[i + 1][0]) i++;
    const [t0, x0, y0] = path[i];
    const [t1, x1, y1] = path[i + 1];
    const p = inOut(span(t, t0, t1));
    const x = lerp(x0, x1, p);
    const y = lerp(y0, y1, p);
    const click = clicks.find((k) => t >= k - 0.12 && t < k + 0.5);
    const press = click !== undefined ? bump(t, click - 0.12, click + 0.14) : 0;
    css(c, "transform", `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${(1 - press * 0.14).toFixed(3)})`);
    css(c, "opacity", Math.max(0, ...shown.map(([a, b]) => Math.min(span(t, a, a + 0.3), 1 - span(t, b - 0.3, b)))).toFixed(3));
    const age = click !== undefined ? span(t, click, click + 0.45) : 1;
    css(ring, "transform", `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${(0.3 + outCubic(age) * 0.9).toFixed(3)})`);
    css(ring, "opacity", click !== undefined && t >= click ? ((1 - age) * 0.55).toFixed(3) : "0");
  };
}

// ── 1. search ────────────────────────────────────────────────────────────

const MAPS = [
  { t: "Shooting Star", a: "Nightcord", sr: 5.21, k: 7, st: "Ranked" },
  { t: "Midnight Rail", a: "Tsukiko", sr: 3.84, k: 4, st: "Ranked" },
  { t: "Paper Lanterns", a: "kanade", sr: 4.92, k: 7, st: "Loved" },
  { t: "Glass Garden", a: "Orbit Nine", sr: 6.13, k: 7, st: "Ranked" },
  { t: "Low Tide", a: "Mizu", sr: 2.71, k: 4, st: "Loved" },
  { t: "Neon Bloom", a: "Hikari P", sr: 4.11, k: 7, st: "Graveyard" },
  { t: "Afterglow", a: "sorane", sr: 5.47, k: 4, st: "Ranked" },
  { t: "Clockwork Sky", a: "Rin Aster", sr: 3.32, k: 6, st: "Loved" },
];

function searchScene() {
  const ALL = MAPS.map((_, i) => i);
  const Q1 = "keys=7 sr>4.5";
  const Q2 = "status=loved";
  const TYPE = 0.1;
  // [start, the cards shown from then on], each change a 0.55 s move
  const LAYOUTS = [
    [-1, ALL],
    [1.3 + 6 * TYPE, [0, 2, 3, 5]],
    [1.3 + Q1.length * TYPE, [0, 2, 3]],
    [5.65, ALL],
    [6.6 + Q2.length * TYPE, [2, 4, 7]],
    [11.15, ALL],
  ];
  const COL = 121;
  const GAP = 12;
  const slot = (i) => [20 + (i % 4) * (COL + GAP), 68 + Math.floor(i / 4) * 134];
  return {
    duration: 14,
    still: 4.2,
    build(root) {
      const field = el("div", "sx-field", root);
      el("svg", "sx-field-ic", field).outerHTML = `<svg class="sx-field-ic" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      const ph = el("span", "sx-ph", field, "Search 4,519 sets…");
      const text = el("span", "sx-text", field);
      const caret = el("span", "sx-caret", field);
      const count = el("span", "sx-count num", field);
      const cards = MAPS.map((m, i) => {
        const card = el("div", "sx-card", root);
        const art = el("div", "sx-art", card);
        el("img", "", art).src = cover(i);
        const play = el("span", "sx-play", art, `<svg viewBox="0 0 24 24"><path d="M8 5.8v12.4a1 1 0 0 0 1.5.86l10-6.2a1 1 0 0 0 0-1.72l-10-6.2A1 1 0 0 0 8 5.8z" fill="#fff"/></svg>`);
        el("div", "sx-title", card, m.t);
        el("div", "sx-artist", card, m.a);
        el("div", "sx-meta", card, `${srChip(m.sr)}<span>${m.k}K</span>${m.st !== "Ranked" ? `<span>· ${m.st}</span>` : ""}`);
        return { card, art, play };
      });
      const R = [520, 316];
      const move = cursor(
        root,
        [[0, ...R], [0.4, ...R], [1.0, 210, 36], [2.9, 210, 36], [3.6, 84, 108], [5.0, 84, 108], [5.7, ...R], [8.3, ...R], [9.0, 214, 108], [10.0, 214, 108], [10.7, ...R], [14, ...R]],
        [1.05],
        [[0.15, 5.75], [8.25, 10.75]],
      );
      // which card the cursor rests on, and when
      const HOVER = [[3.55, 5.0, 0], [8.95, 10.0, 1]];
      let shown = "";
      return (t) => {
        move(t);
        const focused = t >= 1.05 && t < 12.0;
        const typed = t < 5.65 ? Q1.slice(0, clamp(Math.floor((t - 1.3) / TYPE) + 1, 0, Q1.length)) : t >= 6.6 && t < 11.15 ? Q2.slice(0, clamp(Math.floor((t - 6.6) / TYPE) + 1, 0, Q2.length)) : "";
        const q = t >= 1.3 ? typed : "";
        const gone = (t >= 5.65 && t < 6.6) || t >= 11.15;
        const text1 = gone ? "" : q;
        if (text1 !== shown) {
          shown = text1;
          text.innerHTML = text1
            .split(" ")
            .map((tok) => tok.replace(/^([a-z]+)([=<>]+)?(.*)$/, (_, k, op = "", v) => `<b>${k}</b>${op ? `<i>${op}</i>${v}` : ""}`))
            .join(" ");
        }
        // select-all before the text goes
        const sel = (t >= 5.4 && t < 5.65) || (t >= 10.9 && t < 11.15);
        css(text, "background-color", sel ? "rgba(139,124,255,.35)" : "transparent");
        css(ph, "opacity", text1 ? "0" : "1");
        css(field, "background-color", focused ? "rgba(255,255,255,.11)" : "rgba(255,255,255,.07)");
        const typing = (t >= 1.3 && t < 1.3 + Q1.length * TYPE + 0.3) || (t >= 6.6 && t < 6.6 + Q2.length * TYPE + 0.3);
        css(caret, "opacity", focused && (typing || (t * 1000) % 1000 < 560) ? "1" : "0");
        // the layout: from the last one to the current one
        let li = 0;
        while (li < LAYOUTS.length - 1 && t >= LAYOUTS[li + 1][0]) li++;
        const prev = LAYOUTS[Math.max(0, li - 1)][1];
        const next = LAYOUTS[li][1];
        const p = li === 0 ? 1 : outQuint(span(t, LAYOUTS[li][0], LAYOUTS[li][0] + 0.55));
        const n = next.length;
        css(count, "opacity", next.length < ALL.length ? clamp(p * 2 - 0.4).toFixed(3) : (1 - clamp(p * 2)).toFixed(3));
        if (next.length < ALL.length) count.textContent = `${n} ${n === 1 ? "set" : "sets"}`;
        cards.forEach((c, i) => {
          const a = prev.indexOf(i);
          const b = next.indexOf(i);
          let x;
          let y;
          let o;
          let s;
          if (a >= 0 && b >= 0) {
            const [ax, ay] = slot(a);
            const [bx, by] = slot(b);
            x = lerp(ax, bx, p);
            y = lerp(ay, by, p);
            o = 1;
            s = 1;
          } else if (b >= 0) {
            [x, y] = slot(b);
            o = p;
            s = 0.92 + 0.08 * p;
          } else if (a >= 0) {
            [x, y] = slot(a);
            o = 1 - clamp(p * 1.6);
            s = 1 - 0.08 * p;
          } else {
            [x, y] = slot(0);
            o = 0;
            s = 0.92;
          }
          css(c.card, "transform", `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${s.toFixed(3)})`);
          css(c.card, "opacity", o.toFixed(3));
          const h = HOVER.find(([a1, b1, idx]) => next[idx] === i && t >= a1 - 0.05 && t < b1 + 0.3);
          const lift = h ? Math.min(outCubic(span(t, h[0], h[0] + 0.24)), 1 - outCubic(span(t, h[1], h[1] + 0.24))) : 0;
          css(c.art, "transform", `translateY(${(-4 * lift).toFixed(2)}px)`);
          css(c.art, "box-shadow", `0 ${(4 + 6 * lift).toFixed(1)}px ${(14 + 10 * lift).toFixed(1)}px rgba(0,0,0,${(0.28 + 0.14 * lift).toFixed(2)})`);
          css(c.play, "opacity", lift.toFixed(3));
          css(c.play, "transform", `translateY(${(8 * (1 - lift)).toFixed(2)}px)`);
        });
      };
    },
  };
}

// ── 2. a chart ───────────────────────────────────────────────────────────

const PATTERNS = [
  ["Stream", "Single notes in quick succession"],
  ["Jumpstream", "Streams with two-note chords mixed in"],
  ["Chordjack", "Chords that keep hitting the same columns"],
  ["Long notes", "Long notes held for most of the time"],
];

function chartScene() {
  const T = 12;
  const SEG = 3;
  const r = rng(42);
  /** [time, lane, length] over one loop */
  const notes = [];
  const free = [0, 0, 0, 0];
  const add = (time, lane, len = 0) => {
    notes.push([time, lane, len]);
    free[lane] = time + len + 0.09;
  };
  let last = -1;
  for (let time = 0.05; time < SEG; time += 0.115) {
    let l;
    do l = Math.floor(r() * 4);
    while (l === last);
    add(time, (last = l));
  }
  let k = 0;
  for (let time = SEG + 0.05; time < 2 * SEG; time += 0.115, k++) {
    let l;
    do l = Math.floor(r() * 4);
    while (l === last);
    add(time, (last = l));
    if (k % 2 === 0) add(time, (l + 1 + Math.floor(r() * 3)) % 4);
  }
  for (let time = 2 * SEG + 0.05, prev = [0, 1]; time < 3 * SEG; time += 0.17) {
    const size = r() < 0.4 ? 3 : 2;
    const keep = prev[Math.floor(r() * prev.length)];
    const lanes = new Set([keep]);
    while (lanes.size < size) lanes.add(Math.floor(r() * 4));
    for (const l of lanes) add(time, l);
    prev = [...lanes];
  }
  for (let time = 3 * SEG + 0.05; time < 4 * SEG - 0.3; time += 0.21 + r() * 0.08) {
    const open = [0, 1, 2, 3].filter((l) => free[l] <= time);
    if (!open.length) continue;
    const l = open[Math.floor(r() * open.length)];
    add(time, l, Math.min(4 * SEG - 0.2 - time, 0.3 + r() * 0.55));
  }
  notes.sort((a, b) => a[0] - b[0]);
  // notes per second, every 50 ms: a soft window around each moment (the loop wraps)
  const STEP = 0.05;
  const SIGMA = 0.2;
  const nps = [];
  for (let s = 0; s < T; s += STEP) {
    let n = 0;
    for (const [time] of notes) {
      const d = ((((s - time) % T) + T * 1.5) % T) - T / 2;
      n += Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
    }
    nps.push(n / (SIGMA * Math.sqrt(2 * Math.PI)));
  }
  const PEAK = Math.max(...nps);
  const npsAt = (time) => {
    const f = ((((time % T) + T) % T) / STEP) % nps.length;
    const i = Math.floor(f);
    return lerp(nps[i], nps[(i + 1) % nps.length], f - i);
  };

  const X0 = 28;
  const LANE = 40;
  const RY = 304;
  const TOP = 22;
  const SPEED = 250;
  const GX = 230;
  const GW = 306;
  const GY = 60;
  const GH = 108;
  const PAST = 4.2;
  const AHEAD = 1.8;
  return {
    duration: T,
    still: 4.6,
    canvas: true,
    build(root) {
      const label = el("div", "sx-pat", root);
      const nameA = el("div", "sx-pat-name", label);
      const nameB = el("div", "sx-pat-name", label);
      const hint = el("div", "sx-pat-hint", root);
      el("div", "sx-chips", root, `<span class="sx-chip"><i>Dan</i>8 mid</span><span class="sx-chip"><i>Peak</i>${PEAK.toFixed(1)}/s</span><span class="sx-chip"><i>Keys</i>4K</span>`);
      return (t, c) => {
        // playfield
        c.fillStyle = "rgba(255,255,255,.035)";
        rrect(c, X0 - 6, TOP - 6, LANE * 4 + 12, RY - TOP + 22, 10);
        for (let l = 0; l < 4; l++) {
          let flash = 0;
          for (const [time, lane, len] of notes) {
            if (lane !== l) continue;
            for (const w of [0, -T]) {
              const d = t - (time + w);
              if (d >= 0 && d < 0.16) flash = Math.max(flash, 1 - d / 0.16);
              if (len && d >= 0 && d < len) flash = Math.max(flash, 0.75);
            }
          }
          if (flash > 0) {
            const g = c.createLinearGradient(0, RY - 70, 0, RY);
            g.addColorStop(0, "rgba(139,124,255,0)");
            g.addColorStop(1, `rgba(139,124,255,${(0.22 * flash).toFixed(3)})`);
            c.fillStyle = g;
            c.fillRect(X0 + l * LANE + 2, RY - 70, LANE - 4, 70);
          }
          c.fillStyle = `rgba(255,255,255,${(0.12 + 0.5 * flash).toFixed(3)})`;
          rrect(c, X0 + l * LANE + 4, RY - 3, LANE - 8, 6, 3);
        }
        for (const [time, l, len] of notes) {
          for (const w of [0, T]) {
            const at = time + w;
            const end = at + len;
            if (end < t - 0.02 || at > t + (RY - TOP) / SPEED + 0.1) continue;
            const yHead = RY - (at - t) * SPEED;
            const yTail = RY - (end - t) * SPEED;
            const outer = l === 0 || l === 3;
            const col = outer ? "255,255,255" : "139,124,255";
            const fade = (y) => clamp((y - TOP) / 30);
            if (len) {
              const top = Math.max(TOP, yTail);
              const bottom = Math.min(RY, yHead);
              if (bottom > top) {
                c.fillStyle = `rgba(${col},${(0.38 * fade(top + 20)).toFixed(3)})`;
                rrect(c, X0 + l * LANE + 8, top - 5, LANE - 16, bottom - top + 5, 5);
              }
            }
            if (at >= t - 0.01) {
              c.fillStyle = `rgba(${col},${((outer ? 0.85 : 1) * fade(yHead)).toFixed(3)})`;
              rrect(c, X0 + l * LANE + 4, yHead - 6, LANE - 8, 12, 6);
            }
          }
        }
        // the graph: 4 s back, 2 s ahead
        const px = (time) => GX + ((time - (t - PAST)) / (PAST + AHEAD)) * GW;
        const py = (v) => GY + GH - (v / (PEAK * 1.12)) * GH;
        const nowX = px(t);
        text(c, "NOTES PER SECOND", GX, 36, "700 10px", "rgba(255,255,255,.37)", "left", 0.6);
        text(c, Math.round(npsAt(t)).toString(), GX + GW, 40, "650 24px", "rgba(255,255,255,.9)", "right");
        c.save();
        c.beginPath();
        rrectPath(c, GX, GY - 6, GW, GH + 6, 6);
        c.clip();
        for (const [from, to, fill, stroke] of [
          [t - PAST, t, "rgba(139,124,255,.2)", "rgba(139,124,255,1)"],
          [t, t + AHEAD, "rgba(255,255,255,.05)", "rgba(255,255,255,.28)"],
        ]) {
          c.beginPath();
          c.moveTo(px(from), GY + GH);
          for (let s = from; s <= to + 1e-6; s += STEP) c.lineTo(px(s), py(npsAt(s)));
          c.lineTo(px(to), GY + GH);
          c.closePath();
          c.fillStyle = fill;
          c.fill();
          c.beginPath();
          for (let s = from; s <= to + 1e-6; s += STEP) (s === from ? c.moveTo : c.lineTo).call(c, px(s), py(npsAt(s)));
          c.strokeStyle = stroke;
          c.lineWidth = 1.6;
          c.lineJoin = "round";
          c.stroke();
        }
        c.restore();
        c.fillStyle = "rgba(255,255,255,.1)";
        c.fillRect(GX, GY + GH, GW, 1);
        c.fillStyle = "rgba(255,255,255,.55)";
        c.fillRect(Math.round(nowX), GY - 4, 1, GH + 4);
        c.beginPath();
        c.arc(nowX + 0.5, py(npsAt(t)), 3.5, 0, Math.PI * 2);
        c.fillStyle = "#fff";
        c.fill();
        // the pattern under the receptors right now, sliding over when it changes
        const seg = Math.floor((((t % T) + T) % T) / SEG);
        const since = t - seg * SEG;
        const p = outQuint(span(since, 0, 0.45));
        const prev = (seg + PATTERNS.length - 1) % PATTERNS.length;
        nameA.textContent = PATTERNS[prev][0];
        nameB.textContent = PATTERNS[seg][0];
        css(nameA, "transform", `translateY(${(-14 * p).toFixed(2)}px)`);
        css(nameA, "opacity", (1 - p).toFixed(3));
        css(nameB, "transform", `translateY(${(14 * (1 - p)).toFixed(2)}px)`);
        css(nameB, "opacity", p.toFixed(3));
        hint.textContent = PATTERNS[since < 0.22 ? prev : seg][1];
        css(hint, "opacity", (since < 0.22 ? 1 - since / 0.22 : clamp((since - 0.22) / 0.25)).toFixed(3));
      };
    },
  };
}

function rrectPath(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  rrectPath(c, x, y, w, h, r);
  c.fill();
}
function text(c, s, x, y, font, color, align = "left", spacing = 0) {
  c.font = `${font} "Instrument Sans", system-ui, sans-serif`;
  c.fillStyle = color;
  c.textAlign = align;
  if ("letterSpacing" in c) c.letterSpacing = `${spacing}px`;
  c.fillText(s, x, y);
  if ("letterSpacing" in c) c.letterSpacing = "0px";
}

// ── 3. skills, next to other players ─────────────────────────────────────

const AXES = ["Stream", "Jumpstream", "Handstream", "Chordjack", "Jacks", "Long notes"];
const YOU = [4.54, 5.3, 4.42, 4.76, 3.37, 5.05];
const PLAYERS = [
  { name: "Kiyomi", color: "#ff8fb1", meta: "#12,408 · 7,950pp", v: [5.12, 4.62, 4.94, 5.41, 4.78, 3.92] },
  { name: "hollowfox", color: "#6bdf96", meta: "#4,215 · 9,870pp", v: [4.08, 5.66, 5.2, 4.31, 3.62, 5.84] },
  { name: "Rin_7k", color: "#64b5f6", meta: "#27,930 · 6,410pp", v: [5.58, 5.08, 3.98, 4.9, 5.32, 4.41] },
];

function skillsScene() {
  const HOLD = 2.7;
  const MORPH = 1.3;
  const EACH = HOLD + MORPH;
  const T = EACH * PLAYERS.length;
  const CX = 158;
  const CY = 172;
  const R = 96;
  const LO = 2;
  const HI = 6;
  const at = (i, v, out = 0) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const r = ((clamp(v, LO, HI) - LO) / (HI - LO)) * R + out;
    return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
  };
  const poly = (vals) => vals.map((v, i) => at(i, v).map((n) => n.toFixed(1)).join(",")).join(" ");
  /** who's compared at t, and how far the change to the next one is */
  const who = (t) => {
    const i = Math.floor(t / EACH) % PLAYERS.length;
    const p = inOut(span(t - i * EACH, HOLD, EACH));
    return { i, j: (i + 1) % PLAYERS.length, p };
  };
  const theirs = (t) => {
    const { i, j, p } = who(t);
    return PLAYERS[i].v.map((v, k) => lerp(v, PLAYERS[j].v[k], p));
  };
  return {
    duration: T,
    still: 1.2,
    build(root) {
      let svg = "";
      for (let s = LO + 1; s <= HI; s++) svg += `<polygon class="sx-grid" points="${poly(AXES.map(() => s))}"/>`;
      for (let i = 0; i < 6; i++) {
        const [x, y] = at(i, HI);
        svg += `<line class="sx-spoke" x1="${CX}" y1="${CY}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      }
      svg += `<polygon class="sx-you" points="${poly(YOU)}"/>`;
      svg += `<polygon class="sx-them" points="${poly(PLAYERS[0].v)}"/>`;
      const [gx, gy] = at(4, 4);
      svg += `<path class="sx-goal" d="M${gx.toFixed(1)} ${(gy - 4.5).toFixed(1)}l4.5 4.5-4.5 4.5-4.5-4.5z"/>`;
      AXES.forEach((name, i) => {
        const [x, y] = at(i, HI, 13);
        const anchor = Math.abs(x - CX) < 2 ? "middle" : x > CX ? "start" : "end";
        svg += `<text class="sx-axis" x="${x.toFixed(1)}" y="${(y + (y < CY - 5 ? -2 : y > CY + 5 ? 10 : 4)).toFixed(1)}" text-anchor="${anchor}">${name}</text>`;
      });
      const radar = el("div", "sx-radar", root, `<svg viewBox="0 0 322 340" width="322" height="340">${svg}</svg>`);
      const them = radar.querySelector(".sx-them");
      const side = el("div", "sx-side", root);
      const who1 = el("div", "sx-who", side);
      const whoA = el("div", "sx-who-in", who1);
      const whoB = el("div", "sx-who-in", who1);
      const rows = AXES.map((name, i) => {
        const row = el("div", "sx-row", side);
        el("div", "sx-row-name", row, name);
        const bars = el("div", "sx-bars", row);
        const you = el("i", "sx-bar you", bars);
        const th = el("i", "sx-bar them", bars);
        el("b", "sx-val num", row, fmt(YOU[i]));
        const tv = el("span", "sx-val them num", row);
        css(you, "transform", `scaleX(${((YOU[i] - LO) / (HI - LO)).toFixed(3)})`);
        return { th, tv };
      });
      el("div", "sx-legend", side, `<span class="you">You</span><span class="them">Them</span><span class="goal">Goal</span>`);
      const whoHtml = (p) => `<span class="sx-avatar" style="background:${p.color}">${p.name[0].toUpperCase()}</span><span><small>Compared with</small><b>${p.name}</b><em class="num">${p.meta}</em></span>`;
      let shown = -1;
      const rgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
      return (t) => {
        const v = theirs(t);
        them.setAttribute("points", poly(v));
        const { i, j, p } = who(t);
        const [a, b] = [rgb(PLAYERS[i].color), rgb(PLAYERS[j].color)];
        css(root, "--them", `rgb(${a.map((n, k) => Math.round(lerp(n, b[k], p))).join(",")})`);
        if (shown !== i) {
          shown = i;
          whoA.innerHTML = whoHtml(PLAYERS[i]);
          whoB.innerHTML = whoHtml(PLAYERS[j]);
        }
        const out = outCubic(clamp(p * 2));
        const inn = outQuint(clamp(p * 2 - 1));
        css(whoA, "opacity", (1 - out).toFixed(3));
        css(whoA, "transform", `translateY(${(-10 * out).toFixed(2)}px)`);
        css(whoB, "opacity", inn.toFixed(3));
        css(whoB, "transform", `translateY(${(10 * (1 - inn)).toFixed(2)}px)`);
        rows.forEach((r, k) => {
          css(r.th, "transform", `scaleX(${((v[k] - LO) / (HI - LO)).toFixed(3)})`);
          r.tv.textContent = fmt(v[k]);
        });
      };
    },
  };
}

// ── 4. library care: pick, delete, smoke ─────────────────────────────────

const ROWS = [
  { t: "Shooting Star", a: "Nightcord", sub: "osu!lazer · 5 difficulties", size: "38.2 MB", c: 0, newest: true },
  { t: "Shooting Star", a: "Nightcord", sub: "osu!lazer · 5 difficulties", size: "37.9 MB", c: 0, pick: 1.05 },
  { t: "Glass Garden", a: "Orbit Nine", sub: "osu!lazer · 4 difficulties", size: "46.1 MB", c: 3, newest: true },
  { t: "Glass Garden", a: "Orbit Nine", sub: "osu!lazer · 4 difficulties", size: "45.8 MB", c: 3, pick: 1.75 },
  { t: "Paper Lanterns", a: "kanade", sub: "osu!stable · 3 difficulties", size: "21.4 MB", c: 2, stable: true },
];

function careScene() {
  const T = 12;
  const Y0 = 78;
  const PITCH = 50;
  const H = 44;
  const DEL = 3.0;
  const WAVE = 0.95;
  const CLOSE = 4.2;
  const MEASURE = 8.7;
  const BACK = 9.7;
  // after deleting, the rows that stay close up
  const after = [0, -1, 1, -1, 2];
  const parts = [];
  for (const row of [1, 3]) {
    const r = rng(row * 31 + 7);
    for (let i = 0; i < 90; i++) {
      const u = r();
      parts.push({ row, u, v: r(), s: DEL + u * WAVE + r() * 0.08, life: 0.9 + r() * 0.6, rise: 34 + r() * 60, sway: (r() - 0.5) * 16, ph: r() * 6, size: 0.9 + r() * 1.7 });
    }
  }
  return {
    duration: T,
    still: 1.9,
    canvas: true,
    build(root) {
      el("div", "sx-tabs", root, `<span>Never played</span><span>Biggest</span><span class="on">Duplicates</span><span>Broken files</span>`);
      const measure = el("div", "sx-measure", root, `<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Measure again`);
      const note = el("div", "sx-note", root);
      const noteA = el("span", "", note, "2 groups · up to 84 MB could go");
      const noteB = el("span", "ok", note, "Every set is there once");
      const rows = ROWS.map((m, i) => {
        const row = el("div", "sx-crow", root);
        const pick = el("span", m.stable ? "sx-pick none" : "sx-pick", row, m.stable ? "" : `<svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
        el("img", "sx-crow-art", row).src = cover(m.c);
        el("div", "sx-crow-text", row, `<b>${m.t}</b><span>${m.newest ? `<em>Newest</em> · ` : ""}${m.sub}</span>`);
        el("div", "sx-crow-size num", row, m.size);
        const skel = el("div", "sx-skel", root);
        return { row, pick, skel };
      });
      const bar = el("div", "sx-act", root, `<span class="num">2 sets picked · 84 MB</span>`);
      const del = el("span", "sx-del", bar, `<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Delete in osu!lazer`);
      const toast = el("div", "sx-toast", root, `<svg viewBox="0 0 24 24"><path d="m5.5 12.5 4.2 4.2 8.8-9.4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span><b>2 sets deleted</b> osu!lazer frees 84 MB on its next start</span>`);
      const RST = [512, 318];
      const pickAt = (i) => [39, Y0 + i * PITCH + H / 2 - 2];
      const move = cursor(
        root,
        [[0, ...RST], [0.35, ...RST], [0.95, ...pickAt(1)], [1.15, ...pickAt(1)], [1.65, ...pickAt(3)], [1.85, ...pickAt(3)], [2.45, 354, 304], [2.95, 354, 304], [3.7, ...RST], [7.9, ...RST], [8.5, 488, 26], [8.85, 488, 26], [9.6, ...RST], [12, ...RST]],
        [1.05, 1.75, 2.9, MEASURE - 0.1],
        [[0.05, 3.75], [7.85, 9.65]],
      );
      return (t, c) => {
        move(t);
        // the bar with what's picked
        const barIn = outQuint(span(t, 1.85, 2.25)) * (1 - outCubic(span(t, 3.2, 3.5)));
        css(bar, "opacity", barIn.toFixed(3));
        css(bar, "transform", `translate(-50%, ${(14 * (1 - barIn)).toFixed(2)}px)`);
        css(del, "transform", `scale(${(1 - 0.05 * bump(t, 2.82, 3.02)).toFixed(3)})`);
        const toastIn = outQuint(span(t, 4.7, 5.1)) * (1 - outCubic(span(t, 7.4, 7.7)));
        css(toast, "opacity", toastIn.toFixed(3));
        css(toast, "transform", `translateX(${(16 * (1 - toastIn)).toFixed(2)}px) scale(${(0.96 + 0.04 * toastIn).toFixed(3)})`);
        css(measure, "background-color", t >= 8.45 && t < 8.95 ? "rgba(255,255,255,.12)" : "rgba(255,255,255,.06)");
        const okNote = t >= CLOSE + 0.3 && t < BACK;
        const np = okNote ? outQuint(span(t, CLOSE + 0.3, CLOSE + 0.7)) : t >= BACK ? 1 - outQuint(span(t, BACK, BACK + 0.4)) : 0;
        css(noteA, "opacity", (1 - np).toFixed(3));
        css(noteB, "opacity", np.toFixed(3));
        const close = outQuint(span(t, CLOSE, CLOSE + 0.6));
        rows.forEach((r, i) => {
          const m = ROWS[i];
          // where it is: its own slot, or (after deleting) the one it closes up to
          const to = after[i] >= 0 ? after[i] : i;
          const y = Y0 + lerp(i, to, t >= CLOSE && t < MEASURE + 0.4 ? close : 0) * PITCH;
          // fading out for the new measurement, and back in, one after another
          const back = outQuint(span(t, BACK + i * 0.07, BACK + 0.45 + i * 0.07));
          let o = 1;
          let rise = 0;
          if (t >= MEASURE + 0.1 && t < BACK) o = 1 - span(t, MEASURE + 0.1, MEASURE + 0.35);
          else if (t >= BACK && t < BACK + 1) {
            o = back;
            rise = 10 * (1 - back);
          }
          if (m.pick && t >= DEL && t < BACK) o = 0;
          const y2 = t >= BACK ? Y0 + i * PITCH : y;
          css(r.row, "transform", `translateY(${(y2 + rise).toFixed(1)}px)`);
          css(r.row, "opacity", o.toFixed(3));
          // the wave that takes a deleted row
          if (m.pick) {
            const w = span(t, DEL, DEL + WAVE);
            const dissolving = t >= DEL - 0.01 && t < DEL + WAVE + 0.05;
            if (dissolving) {
              css(r.row, "opacity", "1");
              const edge = (w * 116 - 8).toFixed(1);
              const mask = `linear-gradient(90deg, transparent ${edge}%, #000 ${(+edge + 8).toFixed(1)}%)`;
              css(r.row, "-webkit-mask-image", mask);
              css(r.row, "mask-image", mask);
            } else {
              css(r.row, "-webkit-mask-image", "none");
              css(r.row, "mask-image", "none");
            }
            const on = (t >= m.pick && t < DEL + WAVE) ? outBack(span(t, m.pick, m.pick + 0.3)) : 0;
            css(r.pick, "--on", on.toFixed(3));
          }
          // skeletons while measuring
          const sk = t >= MEASURE + 0.25 && t < BACK + 0.5 ? Math.min(span(t, MEASURE + 0.25, MEASURE + 0.5), 1 - span(t, BACK + i * 0.07, BACK + 0.3 + i * 0.07)) : 0;
          css(r.skel, "transform", `translateY(${(Y0 + i * PITCH).toFixed(1)}px)`);
          css(r.skel, "opacity", (sk * 0.9).toFixed(3));
          css(r.skel, "--sweep", `${(((t * 0.9) % 1) * 140 - 20).toFixed(1)}%`);
        });
        // smoke
        for (const q of parts) {
          const a = t - q.s;
          if (a < 0 || a > q.life) continue;
          const k = a / q.life;
          const x = 20 + q.u * 520 + Math.sin(a * 3 + q.ph) * 4 + q.sway * k;
          const y = Y0 + q.row * PITCH + q.v * H - Math.pow(a, 0.75) * q.rise;
          c.fillStyle = `rgba(255,255,255,${(0.75 * (1 - k) ** 1.5).toFixed(3)})`;
          c.beginPath();
          c.arc(x, y, q.size * (1 - k * 0.4), 0, Math.PI * 2);
          c.fill();
        }
      };
    },
  };
}

// ── running the scenes ───────────────────────────────────────────────────

const SCENES = { search: searchScene, chart: chartScene, skills: skillsScene, care: careScene };
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const running = new Set();
let raf = 0;
let last = 0;

function mount(stage) {
  const def = SCENES[stage.dataset.scene]?.();
  if (!def) return;
  const root = el("div", "scene", stage);
  const canvas = def.canvas ? el("canvas", "", root) : null;
  const ctx = canvas?.getContext("2d");
  const frame = def.build(root);
  const s = { stage, def, t: def.still, scale: 1, draw() {
    if (ctx) {
      const k = this.scale * devicePixelRatio;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.clearRect(0, 0, 560, 340);
    }
    frame(this.t, ctx);
  } };
  new ResizeObserver(() => {
    s.scale = stage.clientWidth / 560;
    root.style.setProperty("--s", s.scale.toFixed(4));
    if (canvas) {
      canvas.width = Math.round(560 * s.scale * devicePixelRatio);
      canvas.height = Math.round(340 * s.scale * devicePixelRatio);
    }
    s.draw();
  }).observe(stage);
  new IntersectionObserver(
    ([e]) => {
      if (e.isIntersecting && !reduced.matches) running.add(s);
      else running.delete(s);
      if (running.size && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
    { rootMargin: "60px" },
  ).observe(stage);
}

function tick(now) {
  // a hidden tab or a slow frame doesn't skip ahead
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const s of running) {
    s.t = (s.t + dt) % s.def.duration;
    s.draw();
  }
  raf = running.size ? requestAnimationFrame(tick) : 0;
}

reduced.addEventListener("change", () => {
  if (reduced.matches) running.clear();
});

// ── downloads ────────────────────────────────────────────────────────────

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function downloads() {
  let info;
  try {
    const res = await fetch("/download/info");
    if (!res.ok) return;
    info = await res.json();
  } catch {
    return;
  }
  const mac = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "") && !/iPhone|iPad/.test(navigator.userAgent);
  const winMeta = document.querySelector("[data-win-meta]");
  if (info.windows) winMeta.textContent = `Version ${info.windows.version} · ${mb(info.windows.size)} · Windows 10 and 11, 64-bit`;
  const macBuild = info.macArm ?? info.macIntel;
  const macMeta = document.querySelector("[data-mac-meta]");
  if (macBuild) macMeta.textContent = `Version ${macBuild.version} · macOS 11 or newer`;
  for (const [sel, ok] of [["[data-mac-arm]", info.macArm], ["[data-mac-intel]", info.macIntel]]) {
    const a = document.querySelector(sel);
    if (!ok) {
      a.setAttribute("aria-disabled", "true");
      a.removeAttribute("href");
    }
  }
  const sub = document.querySelector("[data-main-sub]");
  if (mac && info.macArm) {
    document.querySelector("[data-main]").href = "/download/mac-arm";
    document.querySelector("[data-main-label]").textContent = "Download for macOS";
    document.querySelector("[data-main-icon] use").setAttribute("href", "#i-laptop");
    sub.textContent = `Version ${info.macArm.version} · Apple silicon · Free`;
    document.querySelector("[data-also]").innerHTML = `Also for <a href="#download">${info.macIntel ? "Windows and Intel Macs" : "Windows"}</a> · <a href="/roadmap">See what's coming</a>`;
  } else if (info.windows) {
    sub.textContent = `Version ${info.windows.version} · ${mb(info.windows.size)} · Free`;
  }
}

document.fonts.ready.then(() => document.querySelectorAll("[data-scene]").forEach(mount));
downloads();
