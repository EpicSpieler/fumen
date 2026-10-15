// roadmap.js — Fumen's roadmap as a timeline: versions you can open, a spine filled up to where
// the project is, the latest release from the update server, and small explainers (canvas, played
// once when they come into view, again on request; never looping).

"use strict";

// ── the plan (docs/PLAN.md) ──────────────────────────────────────────────

/** state: done | next | planned | later; items: [done?, text]; moved: where it was planned before */
const VERSIONS = [
  {
    v: "0.1", name: "Library", state: "done", when: "Oct 2026",
    summary: "Your lazer library, fast.",
    items: [
      [1, "Reads a copy of lazer's database, never the one lazer uses"],
      [1, "Grid and list for 20,000+ difficulties, grouped by set"],
      [1, "Search and filters: keys, star rating, BPM, length, OD, HP, status"],
      [1, "Set pages, backgrounds, playback with a queue"],
      [1, "lazer's collections"],
    ],
  },
  {
    v: "0.2", name: "Charts", state: "done", when: "Oct 2026",
    summary: "See what a chart contains.",
    items: [
      [1, "<b>Fullscreen playfield</b> in your lazer skins, played by lazer's autoplay with the beatmap's hitsounds"],
      [1, "osu!mania, osu!taiko, osu! and osu!catch"],
      [1, "Density graph, BPM, notes per second and the pattern of every second"],
      [1, "Pattern report and dan rating for osu!mania"],
      [1, "Fumen's own osu!mania star rating at any rate, within 0.005★ of lazer on 99.8% of charts"],
    ],
    explain: [["chart", "<b>The playfield and the density graph</b> follow the song together; the number is the notes per second right now."]],
  },
  {
    v: "0.3", name: "Collections", state: "done", when: "Oct 2026",
    summary: "Organise it your way.",
    items: [
      [1, "Fumen collections with drag and drop"],
      [1, "Smart collections: saved searches that keep themselves up to date"],
      [1, "Export to lazer and to collection.db"],
      [1, "osu!stable as a second source"],
    ],
  },
  {
    v: "0.4", name: "You", state: "done", when: "Oct 2026",
    summary: "Your plays, your skills, your goals.",
    items: [
      [1, "<b>Add beatmaps</b> from osu! links straight into lazer, through six mirrors"],
      [1, "osu! login, scores and play history"],
      [1, "<b>Skill radar</b> per pattern, and what to practise next"],
      [1, "Goals for skills, charts, pp and rank"],
      [1, "Compare your skills with another player"],
    ],
    explain: [
      ["mirrors", "<b>Adding beatmaps:</b> every set goes to the least busy of six mirrors, never to osu!'s servers. A mirror that asks to slow down gets a rest. lazer's own importer does the rest."],
      ["radar", "<b>Skill radar:</b> what your best plays say per pattern, now and 90 days ago."],
    ],
  },
  {
    v: "0.5", name: "Discover", state: "done", when: "Oct 2026",
    summary: "Find what to play next.",
    items: [
      [1, "<b>Mods in the playfield:</b> HR, EZ, HD, FI, FL and Mirror, the way lazer plays them"],
      [1, "<b>Similar maps:</b> a chart's fingerprint and the closest ones in your library"],
      [1, "<b>Beatmap search on the mirrors:</b> filters, previews, and a whole search as one pack"],
    ],
    explain: [
      ["mods", "<b>Hard Rock</b> flips the playfield, shrinks the circles and makes them come in faster."],
      ["similar", "<b>Similar maps:</b> the same pattern mix, star rating and speed, closest first."],
    ],
  },
  {
    v: "0.6", name: "Practice", state: "next",
    summary: "Practise with intent.",
    items: [
      [1, "<b>osu!mania replays from lazer in the playfield:</b> judged as lazer does, hit errors, misses on the timeline, accuracy as it goes"],
      [0, "Replays for osu!, osu!taiko and osu!catch, and your score's replay from osu! when lazer doesn't have one"],
      [1, "<b>Practice mode:</b> loop a section, a little faster every time, with a metronome"],
    ],
    explain: [
      ["replay", "<b>Your replay, judged:</b> every hit early or late, the misses where they happened."],
      ["practice", "<b>Practice mode:</b> the hard part on a loop, from 0.80× up to full speed."],
    ],
  },
  {
    v: "0.7", name: "Library care", state: "planned",
    summary: "Keep the library clean.",
    items: [
      [0, "Duplicates across lazer and osu!stable"],
      [0, "Missing or broken audio and backgrounds"],
      [0, "What takes the most space and never gets played"],
      [0, "osu!stable's scores in your history"],
    ],
    note: "Fumen points things out; deleting stays with lazer.",
    explain: [["care", "<b>Library care:</b> the same chart twice, a missing file, and what it all costs."]],
  },
  {
    v: "1.0", name: "Release", state: "planned",
    summary: "Ready for everyone.",
    items: [
      [1, "Installer and auto-update"],
      [0, "English and German"],
      [0, "Dark, OLED, Light and High contrast"],
      [0, "A website with downloads"],
    ],
    explain: [["themes", "<b>Themes and languages,</b> the same app in four looks."]],
  },
  {
    v: "1.1", name: "Pools", state: "later",
    summary: "Build tournament pools.",
    moved: "0.5",
    items: [
      [0, "<b>Pool builder</b> with NM, HD, HR, DT, FM and TB slots; star rating, BPM and length per mod"],
      [0, "Maps you don't own looked up; export to JSON, CSV, a sheet and the RPRO bot; a showcase image"],
      [0, "Similar maps to fill or replace a slot"],
    ],
    explain: [["pool", "<b>A pool fills up</b> with the numbers as each mod makes them."]],
  },
  {
    v: "1.2", name: "Tournament", state: "later",
    summary: "Run the tournament.",
    moved: "0.6",
    items: [
      [0, "Schedule"],
      [0, "Match results from mp links"],
      [0, "Picks, bans and mod strengths per player"],
      [0, "An OBS overlay served from your PC"],
    ],
    explain: [["tournament", "<b>An mp link becomes the match:</b> scores per map, and who took it."]],
  },
  {
    v: "1.3", name: "Sessions", state: "later",
    summary: "Your week at a glance.",
    items: [
      [0, "Plays grouped into sittings"],
      [0, "A weekly report: time played, skills that moved, goals that came closer"],
      [0, "Shareable as an image"],
    ],
    explain: [["sessions", "<b>Your week:</b> when you played and what it did for your skills."]],
  },
  {
    v: "1.4", name: "Skins", state: "later",
    summary: "Every skin, side by side.",
    items: [
      [0, "A skin browser on the same moment of a chart"],
      [0, "Two skins side by side"],
      [0, "Pieces of several skins mixed into one .osk"],
    ],
    explain: [["skins", "<b>Mixing skins:</b> the notes of one, the keys of another, saved as your own .osk."]],
  },
  {
    v: "1.5", name: "Presence", state: "later",
    summary: "Show what you're up to.",
    items: [
      [0, "Discord Rich Presence: listening, practising, building a pool"],
      [0, "Share cards for pools, skills and goals"],
    ],
  },
  {
    v: "1.6", name: "Everywhere", state: "later",
    summary: "Beyond one Windows PC.",
    items: [
      [0, "Linux and macOS, with lazer's library on those systems"],
      [0, "Your goals, skills and pools on fumen.dertesti.dev, for your phone"],
    ],
  },
  {
    v: "1.7", name: "Mapping lens", state: "later",
    summary: "For mappers and pool selectors.",
    items: [
      [0, "Difficulty spikes along a chart"],
      [0, "A pattern heatmap per section"],
      [0, "Spread check across a set's difficulties"],
      [0, "The analyser's leftovers: Azusa's marathon correction, the Roxy and Mixed estimators"],
    ],
  },
];

const STATE_LABEL = { done: "Shipped", next: "Up next", planned: "Planned", later: "After 1.0" };
const ERAS = { done: "Shipped", next: "On the way to 1.0", later: "After 1.0" };
const FILTERS = { all: () => true, done: (s) => s === "done", coming: (s) => s === "next" || s === "planned", later: (s) => s === "later" };

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── maths and drawing helpers for the explainers ─────────────────────────

const W = 520;
const H = 220;
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const seg = (t, a, b) => clamp((t - a) / (b - a));
const lerp = (a, b, k) => a + (b - a) * k;
const E = {
  quint: (k) => 1 - (1 - k) ** 5,
  cubic: (k) => 1 - (1 - k) ** 3,
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2),
  back: (k) => {
    const c = 1.70158 * 1.2;
    return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
  },
  sine: (k) => Math.sin((k * Math.PI) / 2),
};
const ACCENT = [139, 124, 255];
const acc = (a = 1) => `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${a})`;
const ink = (a = 1) => `rgba(185,176,255,${a})`;
const w = (a) => `rgba(255,255,255,${a})`;
const WARN = "#f0b429";
const DANGER = "#ff7070";
const FONT = '"Instrument Sans", "Segoe UI", system-ui, sans-serif';

/** A seeded generator, so an explainer always plays the same. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rr(c, x, y, wd, ht, r, fill) {
  if (wd <= 0 || ht <= 0) return;
  c.beginPath();
  c.roundRect(x, y, wd, ht, Math.min(r, wd / 2, ht / 2));
  c.fillStyle = fill;
  c.fill();
}

function text(c, s, x, y, { size = 12, weight = 500, color = w(0.55), align = "left", base = "alphabetic", spacing = 0 } = {}) {
  c.font = `${weight} ${size}px ${FONT}`;
  c.textAlign = align;
  c.textBaseline = base;
  c.fillStyle = color;
  if (spacing && "letterSpacing" in c) c.letterSpacing = `${spacing}px`;
  c.fillText(s, x, y);
  if (spacing && "letterSpacing" in c) c.letterSpacing = "0px";
}

function circle(c, x, y, r, fill) {
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
}

function ring(c, x, y, r, width, stroke) {
  c.beginPath();
  c.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  c.lineWidth = width;
  c.strokeStyle = stroke;
  c.stroke();
}

/** A label that pops (scale overshoot) when it changes at `since`. */
function popText(c, s, x, y, since, opts) {
  const k = since >= 0 && since < 320 ? 1 + 0.16 * (1 - E.cubic(since / 320)) : 1;
  c.save();
  c.translate(x, y);
  c.scale(k, k);
  text(c, s, 0, 0, opts);
  c.restore();
}

// ── the explainers: draw(c, t) at t ms into a run of `duration` ──────────

const EXPLAINERS = {
  /** 0.2: four lanes and the density graph following the song */
  chart: (() => {
    const notes = [];
    const r = rng(7);
    for (let time = 350; time < 4300; ) {
      const chord = r() < 0.28 ? 2 : 1;
      const lanes = [0, 1, 2, 3].sort(() => r() - 0.5).slice(0, chord);
      for (const l of lanes) notes.push([time, l]);
      time += time > 1700 && time < 2900 ? 95 : 160 + r() * 70;
    }
    const nps = (t) => notes.filter(([n]) => n <= t && n > t - 1000).length;
    const X0 = 40;
    const LANE = 30;
    const RY = 188;
    const TOP = 22;
    const SPEED = 0.115;
    const GX = 200;
    const GW = 296;
    const GH = 112;
    const END = 4500;
    return {
      duration: 4700,
      draw(c, t) {
        rr(c, X0 - 4, TOP, LANE * 4 + 8, RY - TOP + 12, 8, w(0.035));
        for (let l = 0; l < 4; l++) {
          const last = notes.filter(([n, nl]) => nl === l && n <= t).pop();
          const flash = last ? clamp(1 - (t - last[0]) / 200) : 0;
          rr(c, X0 + l * LANE + 3, RY - 3, LANE - 6, 6, 3, w(0.12));
          if (flash > 0) rr(c, X0 + l * LANE + 3, RY - 3, LANE - 6, 6, 3, acc(flash));
        }
        for (const [n, l] of notes) {
          if (n < t) continue;
          const y = RY - (n - t) * SPEED;
          if (y < TOP - 4) continue;
          const a = clamp((y - TOP) / 28);
          rr(c, X0 + l * LANE + 3, y - 4, LANE - 6, 8, 4, l === 0 || l === 3 ? w(0.82 * a) : acc(a));
        }
        // the graph, drawn up to the song's position
        const upTo = Math.min(t, END);
        const px = (time) => GX + (time / END) * GW;
        const py = (v) => RY - (v / 13) * GH;
        c.beginPath();
        c.moveTo(GX, RY);
        for (let x = 0; x <= upTo; x += 40) c.lineTo(px(x), py(nps(x)));
        c.lineTo(px(upTo), py(nps(upTo)));
        c.lineTo(px(upTo), RY);
        c.closePath();
        c.fillStyle = acc(0.16);
        c.fill();
        c.beginPath();
        for (let x = 0; x <= upTo; x += 40) (x ? c.lineTo : c.moveTo).call(c, px(x), py(nps(x)));
        c.lineTo(px(upTo), py(nps(upTo)));
        c.lineWidth = 1.6;
        c.strokeStyle = acc(1);
        c.lineJoin = "round";
        c.stroke();
        rr(c, GX, RY, GW, 1, 0, w(0.1));
        if (t < END) rr(c, px(upTo), RY - GH - 6, 1, GH + 6, 0, w(0.3));
        text(c, "NOTES PER SECOND", GX, 34, { size: 10, weight: 700, color: w(0.37), spacing: 0.6 });
        text(c, String(nps(upTo)), GX + GW, 38, { size: 22, weight: 650, color: w(0.9), align: "right" });
      },
    };
  })(),

  /** 0.4: links → six mirrors → lazer */
  mirrors: (() => {
    const names = ["osu.direct", "nekoha.moe", "catboy.best", "beatconnect.io", "sayobot.cn", "nerinyan.moe"];
    const assign = [0, 1, 2, 3, 5, 0, 4, 1];
    const rowY = (k) => 36 + k * 30;
    const T1 = 480;
    const DL = 720;
    const T2 = 480;
    const start = (i) => 250 + i * 390;
    return {
      duration: 5400,
      draw(c, t) {
        rr(c, 16, 96, 96, 28, 14, w(0.07));
        text(c, "osu! links", 64, 114, { size: 12, weight: 600, color: w(0.85), align: "center" });
        rr(c, 404, 80, 100, 60, 12, w(0.07));
        text(c, "osu!lazer", 454, 104, { size: 12, weight: 650, color: w(0.88), align: "center" });
        let done = 0;
        for (let i = 0; i < assign.length; i++) if (t >= start(i) + T1 + DL + T2) done++;
        text(c, `${done} of ${assign.length} in`, 454, 124, { size: 11, color: w(0.4), align: "center" });
        // mirrors and what they're downloading
        for (let k = 0; k < names.length; k++) {
          const y = rowY(k);
          text(c, names[k], 196, y, { size: 11.5, color: w(0.5) });
          rr(c, 196, y + 6, 126, 4, 2, w(0.08));
          for (let i = 0; i < assign.length; i++) {
            if (assign[i] !== k) continue;
            const p = seg(t, start(i) + T1, start(i) + T1 + DL);
            if (p > 0 && p < 1) rr(c, 196, y + 6, 126 * p, 4, 2, acc(1));
          }
        }
        // catboy asks to slow down once: it rests
        const rest = seg(t, 2100, 2350) * (1 - seg(t, 4600, 4900));
        if (rest > 0) text(c, "resting", 322, rowY(2), { size: 10.5, weight: 600, color: `rgba(240,180,41,${rest})`, align: "right" });
        // the sets on their way
        for (let i = 0; i < assign.length; i++) {
          const s = start(i);
          if (t < s) continue;
          const y = rowY(assign[i]) + 8;
          let x;
          let yy;
          let a = 1;
          if (t < s + T1) {
            const k = E.inOut(seg(t, s, s + T1));
            x = lerp(112, 184, k);
            yy = lerp(110, y, k);
          } else if (t < s + T1 + DL) {
            x = 184;
            yy = y;
          } else if (t < s + T1 + DL + T2) {
            const k = E.inOut(seg(t, s + T1 + DL, s + T1 + DL + T2));
            x = lerp(330, 404, k);
            yy = lerp(y, 110, k);
          } else {
            x = 404;
            yy = 110;
            a = 1 - seg(t, s + T1 + DL + T2, s + T1 + DL + T2 + 220);
          }
          if (a > 0) rr(c, x - 5, yy - 5, 10, 10, 3, acc(a));
        }
      },
    };
  })(),

  /** 0.4: the radar growing from the middle */
  radar: (() => {
    const axes = ["Stream", "Chordstream", "Jacks", "Coordination", "Density", "Wildcard"];
    const before = [0.55, 0.42, 0.6, 0.34, 0.5, 0.3];
    const now = [0.72, 0.5, 0.78, 0.45, 0.66, 0.4];
    const cx = 220;
    const cy = 114;
    const R = 76;
    const pt = (i, v) => {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / axes.length;
      return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v];
    };
    const poly = (c, vals) => {
      c.beginPath();
      vals.forEach((v, i) => (i ? c.lineTo : c.moveTo).call(c, ...pt(i, v)));
      c.closePath();
    };
    return {
      duration: 2400,
      draw(c, t) {
        for (const k of [1 / 3, 2 / 3, 1]) {
          poly(c, axes.map(() => k));
          c.lineWidth = 1;
          c.strokeStyle = w(0.08);
          c.stroke();
        }
        axes.forEach((name, i) => {
          const [x, y] = pt(i, 1);
          c.beginPath();
          c.moveTo(cx, cy);
          c.lineTo(x, y);
          c.strokeStyle = w(0.06);
          c.stroke();
          const [lx, ly] = pt(i, 1.2);
          text(c, name, lx, ly + 4, { size: 11.5, color: w(0.5), align: Math.abs(lx - cx) < 4 ? "center" : lx > cx ? "left" : "right" });
        });
        const a = seg(t, 0, 500);
        if (a > 0) {
          poly(c, before);
          c.setLineDash([3, 3]);
          c.lineWidth = 1.2;
          c.strokeStyle = w(0.4 * a);
          c.stroke();
          c.setLineDash([]);
        }
        const k = E.back(seg(t, 380, 1500));
        if (k > 0) {
          const vals = now.map((v) => v * k);
          poly(c, vals);
          c.fillStyle = acc(0.2);
          c.fill();
          c.lineWidth = 2;
          c.strokeStyle = acc(1);
          c.lineJoin = "round";
          c.stroke();
          vals.forEach((v, i) => circle(c, ...pt(i, v), 2.6, acc(1)));
        }
        // the number behind one axis
        const n = seg(t, 380, 1700);
        text(c, "JACKS", 500, 44, { size: 10, weight: 700, color: w(0.37), align: "right", spacing: 0.6 });
        text(c, `${(4.62 * E.cubic(n)).toFixed(2)}★`, 500, 70, { size: 22, weight: 650, color: w(0.9), align: "right" });
        text(c, `+${(0.31 * E.cubic(n)).toFixed(2)} in 90 days`, 500, 88, { size: 11, color: ink(0.9 * n), align: "right" });
        rr(c, 404, 186, 14, 2, 1, acc(1));
        text(c, "now", 424, 191, { size: 11, color: w(0.5) });
        c.setLineDash([3, 3]);
        c.beginPath();
        c.moveTo(404, 205);
        c.lineTo(418, 205);
        c.strokeStyle = w(0.4);
        c.lineWidth = 1.2;
        c.stroke();
        c.setLineDash([]);
        text(c, "90 days ago", 424, 209, { size: 11, color: w(0.5) });
      },
    };
  })(),

  /** 0.5: Hard Rock on an osu! playfield */
  mods: (() => {
    const BX = 170;
    const BY = 20;
    const S = 0.43;
    const objs = [
      [110, 92, 1],
      [256, 150, 2],
      [400, 96, 3],
    ];
    const slider = [[120, 300], [256, 230], [392, 300]];
    const hitsNM = [700, 1050, 1400];
    const hitsHR = [3000, 3330, 3660];
    const cs = (k) => lerp(4, 5.2, k);
    const radius = (k) => (64 * ((1 - (0.7 * (cs(k) - 5)) / 5) / 2)) * S;
    return {
      duration: 5000,
      draw(c, t) {
        const k = E.inOut(seg(t, 1800, 2600));
        const pos = (x, y) => [BX + x * S, BY + lerp(y, 384 - y, k) * S];
        rr(c, BX, BY, 512 * S, 384 * S, 8, w(0.035));
        const r = radius(k);
        // the slider
        c.beginPath();
        const [a0, a1] = pos(...slider[0]);
        const [b0, b1] = pos(...slider[1]);
        const [e0, e1] = pos(...slider[2]);
        c.moveTo(a0, a1);
        c.quadraticCurveTo(b0, b1, e0, e1);
        c.lineCap = "round";
        c.lineWidth = r * 2;
        c.strokeStyle = acc(0.55);
        c.stroke();
        c.lineWidth = r * 2 - 4;
        c.strokeStyle = "rgba(20,18,32,.92)";
        c.stroke();
        ring(c, a0, a1, r - 1, 2, w(0.9));
        text(c, "4", a0, a1 + 4, { size: 11, weight: 650, color: w(0.9), align: "center" });
        const hits = k < 0.5 ? hitsNM : hitsHR;
        const pre = k < 0.5 ? 620 : 430;
        objs.forEach(([x, y, n], i) => {
          const [px, py] = pos(x, y);
          const since = t - hits[i];
          const flash = since >= 0 && since < 240 ? 1 - since / 240 : 0;
          circle(c, px, py, r * (1 + flash * 0.25), acc(0.28 + 0.5 * flash));
          ring(c, px, py, r - 1, 2, w(0.9));
          text(c, String(n), px, py + 4, { size: 11, weight: 650, color: w(0.92), align: "center" });
          const p = seg(t, hits[i] - pre, hits[i]);
          if (p > 0 && p < 1) ring(c, px, py, r * lerp(3.2, 1, p), 1.6, acc(0.4 + 0.6 * p));
        });
        // what changed
        const mod = (s, x, a, color) => text(c, s, x, 86, { size: 30, weight: 700, color: color(a), align: "left" });
        if (k < 1) mod("NM", 30, 1 - k, w);
        if (k > 0) mod("HR", 30, k, acc);
        const lines = [
          [`CS ${cs(k).toFixed(1)}`, "circles"],
          [`AR ${lerp(9, 10, k).toFixed(1)}`, "approach"],
          [k > 0.5 ? "flipped" : "as mapped", "playfield"],
        ];
        lines.forEach(([v, l], i) => {
          text(c, v, 30, 116 + i * 30, { size: 13, weight: 650, color: k > 0.02 && k < 1 ? ink(1) : w(0.85) });
          text(c, l, 30, 130 + i * 30, { size: 10.5, color: w(0.37) });
        });
      },
    };
  })(),

  /** 0.5: a pool filling up, DT counting the star rating up */
  pool: (() => {
    const rows = [
      ["NM1", 5.12, 174],
      ["NM2", 5.38, 190],
      ["HD1", 5.21, 168],
      ["HR1", 5.44, 182],
      ["DT1", 4.82, 180],
    ];
    const Y = (i) => 22 + i * 32;
    const arrive = (i) => 200 + i * 230;
    return {
      duration: 4600,
      draw(c, t) {
        rows.forEach(([slot, sr, bpm], i) => {
          const y = Y(i);
          text(c, slot, 24, y + 17, { size: 12.5, weight: 700, color: slot === "DT1" && t > 2700 ? ink(1) : w(0.55) });
          const k = E.quint(seg(t, arrive(i), arrive(i) + 650));
          if (k <= 0) {
            rr(c, 72, y, 424, 26, 8, w(0.025));
            return;
          }
          const x = lerp(540, 72, k);
          c.globalAlpha = seg(t, arrive(i), arrive(i) + 250);
          rr(c, x, y, 424, 26, 8, w(0.06));
          rr(c, x + 4, y + 3, 36, 20, 5, acc(0.25 + i * 0.12));
          rr(c, x + 48, y + 7, 90 + ((i * 37) % 70), 5, 2.5, w(0.32));
          rr(c, x + 48, y + 15, 60 + ((i * 23) % 40), 4, 2, w(0.14));
          const n = E.cubic(seg(t, arrive(i) + 300, arrive(i) + 900));
          const dt = slot === "DT1" ? E.inOut(seg(t, 2900, 3700)) : 0;
          const shownSr = lerp(sr, 6.31, dt) * n;
          const shownBpm = Math.round(lerp(bpm, bpm * 1.5, dt) * n);
          text(c, `${shownBpm} bpm`, x + 340, y + 17, { size: 11.5, color: dt > 0 ? ink(0.9) : w(0.4), align: "right" });
          text(c, `${shownSr.toFixed(2)}★`, x + 414, y + 17, { size: 13, weight: 650, color: dt > 0 ? ink(1) : w(0.9), align: "right" });
          c.globalAlpha = 1;
        });
        // the pool's balance
        const parts = [["Stream", 0.32], ["Jacks", 0.24], ["LN", 0.2], ["Tech", 0.24]];
        const g = E.quint(seg(t, 2200, 3400));
        let x = 72;
        parts.forEach(([name, share], i) => {
          const wd = 424 * share * g - 3;
          rr(c, x, 196, wd, 6, 3, acc(0.95 - i * 0.2));
          if (g > 0.9) text(c, name, x, 190, { size: 10.5, color: w(0.4 * seg(g, 0.9, 1)) });
          x += 424 * share * g;
        });
      },
    };
  })(),

  /** 0.5: a chart's fingerprint against three others */
  similar: (() => {
    const base = [0.8, 0.3, 0.55, 0.2, 0.65, 0.25];
    const cands = [
      [[0.4, 0.7, 0.3, 0.6, 0.2, 0.5], 61],
      [[0.76, 0.34, 0.5, 0.26, 0.7, 0.2], 94],
      [[0.6, 0.18, 0.82, 0.1, 0.42, 0.45], 72],
    ];
    const best = 1;
    return {
      duration: 4200,
      draw(c, t) {
        text(c, "This chart", 24, 40, { size: 12.5, weight: 650, color: w(0.85) });
        text(c, "4K · 4.91★ · 190 bpm", 24, 56, { size: 11, color: w(0.4) });
        base.forEach((v, i) => {
          const h = 92 * v * E.quint(seg(t, 0, 600));
          rr(c, 24 + i * 26, 170 - h, 20, h, 4, w(0.78));
        });
        text(c, "patterns, speed and length", 24, 192, { size: 10.5, color: w(0.37) });
        const hl = E.inOut(seg(t, 2700, 3300));
        cands.forEach(([vals, pct], j) => {
          const y = 30 + j * 62;
          const k = E.quint(seg(t, 500 + j * 260, 1100 + j * 260));
          if (k <= 0) return;
          const dx = (1 - k) * 24;
          c.globalAlpha = k * (j === best ? 1 : 1 - 0.45 * hl);
          rr(c, 220 + dx, y, 276, 52, 10, j === best ? `rgba(139,124,255,${0.06 + 0.08 * hl})` : w(0.04));
          vals.forEach((v, i) => {
            const h = 34 * v;
            rr(c, 232 + dx + i * 13, y + 44 - h, 9, h, 2.5, j === best ? `rgba(${lerp(255, 139, hl)},${lerp(255, 124, hl)},255,${0.7 + 0.3 * hl})` : w(0.6));
            rr(c, 232 + dx + i * 13 - 1, y + 44 - 34 * base[i] - 1, 11, 2, 1, w(0.4));
          });
          rr(c, 324 + dx, y + 16, 70 + j * 12, 5, 2.5, w(0.3));
          rr(c, 324 + dx, y + 26, 46, 4, 2, w(0.14));
          const n = E.cubic(seg(t, 1400 + j * 150, 2400 + j * 150));
          text(c, `${Math.round(pct * n)}%`, 484 + dx, y + 30, { size: 17, weight: 650, color: j === best && hl > 0 ? ink(1) : w(0.88), align: "right" });
          if (j === best && hl > 0) text(c, "closest", 484 + dx, y + 44, { size: 10, weight: 700, color: ink(hl), align: "right", spacing: 0.4 });
          c.globalAlpha = 1;
        });
      },
    };
  })(),

  /** 0.6: an mp link becoming the match */
  tournament: (() => {
    const maps = [
      ["NM1", 0.92, 0.81],
      ["HD1", 0.74, 0.88],
      ["HR2", 0.86, 0.7],
      ["DT1", 0.66, 0.79],
      ["TB", 0.95, 0.9],
    ];
    const start = (i) => 900 + i * 520;
    return {
      duration: 4800,
      draw(c, t) {
        const linkIn = E.quint(seg(t, 0, 500));
        c.globalAlpha = linkIn;
        rr(c, 24, 16, 232, 26, 13, w(0.07));
        text(c, "osu.ppy.sh/mp/116 052 871", 38, 33, { size: 11.5, color: w(0.55) });
        c.globalAlpha = 1;
        let a = 0;
        let b = 0;
        maps.forEach(([slot, sa, sb], i) => {
          const y = 58 + i * 30;
          const k = E.quint(seg(t, start(i), start(i) + 600));
          text(c, slot, 24, y + 14, { size: 12, weight: 700, color: w(k > 0 ? 0.55 : 0.2) });
          rr(c, 70, y + 2, 270, 7, 3.5, w(0.05));
          rr(c, 70, y + 12, 270, 7, 3.5, w(0.05));
          rr(c, 70, y + 2, 270 * sa * k, 7, 3.5, acc(1));
          rr(c, 70, y + 12, 270 * sb * k, 7, 3.5, w(0.55));
          if (k >= 1) {
            if (sa > sb) a++;
            else b++;
            const won = seg(t, start(i) + 600, start(i) + 800);
            text(c, "+1", 350, y + (sa > sb ? 9 : 19), { size: 10.5, weight: 700, color: sa > sb ? ink(won) : w(0.7 * won) });
          }
        });
        rr(c, 384, 58, 112, 82, 12, w(0.05));
        text(c, "Kasumi", 398, 84, { size: 12, color: w(0.6) });
        text(c, "Rin", 398, 120, { size: 12, color: w(0.6) });
        text(c, String(a), 484, 86, { size: 22, weight: 650, color: ink(1), align: "right" });
        text(c, String(b), 484, 122, { size: 22, weight: 650, color: w(0.88), align: "right" });
        rr(c, 384, 150, 6, 6, 3, acc(1));
        text(c, "Kasumi", 396, 156, { size: 10.5, color: w(0.4) });
        rr(c, 440, 150, 6, 6, 3, w(0.55));
        text(c, "Rin", 452, 156, { size: 10.5, color: w(0.4) });
      },
    };
  })(),

  /** 0.7: a replay's hits, early and late, as it plays */
  replay: (() => {
    const r = rng(42);
    const hits = [];
    for (let i = 0; i < 96; i++) {
      const g = (r() + r() + r() - 1.5) * 26;
      hits.push({ x: 30 + (i / 95) * 460, err: g - 2, miss: i === 33 || i === 71 });
    }
    const Y = 118;
    const play = (t) => 24 + 472 * seg(t, 200, 4300);
    return {
      duration: 4800,
      draw(c, t) {
        rr(c, 24, Y - 0.5, 472, 1, 0, w(0.14));
        c.setLineDash([2, 4]);
        for (const off of [-30, 30]) {
          c.beginPath();
          c.moveTo(24, Y + off);
          c.lineTo(496, Y + off);
          c.strokeStyle = w(0.08);
          c.lineWidth = 1;
          c.stroke();
        }
        c.setLineDash([]);
        text(c, "early", 24, Y - 36, { size: 10.5, color: w(0.37) });
        text(c, "late", 24, Y + 46, { size: 10.5, color: w(0.37) });
        const x = play(t);
        let sum = 0;
        let n = 0;
        let err = 0;
        for (const h of hits) {
          if (h.x > x) break;
          const age = (x - h.x) / 0.115;
          if (h.miss) {
            rr(c, h.x - 1, Y - 44, 2, 88, 1, DANGER);
            if (age < 900) text(c, "miss", h.x, Y - 50, { size: 10, weight: 700, color: `rgba(255,112,112,${1 - age / 900})`, align: "center" });
            n++;
            continue;
          }
          const fresh = clamp(1 - age / 300);
          rr(c, h.x - 1, Y + h.err - 4, 2, 8, 1, fresh > 0 ? `rgba(${lerp(255, 139, fresh)},${lerp(255, 124, fresh)},255,${0.55 + 0.45 * fresh})` : w(0.55));
          sum += 100 - Math.abs(h.err) / 3.2;
          err += h.err;
          n++;
        }
        if (t < 4300) rr(c, x, Y - 56, 1, 112, 0, w(0.3));
        const accNow = n ? sum / n : 100;
        text(c, "ACCURACY SO FAR", 496, 30, { size: 10, weight: 700, color: w(0.37), align: "right", spacing: 0.6 });
        text(c, `${accNow.toFixed(2)}%`, 496, 54, { size: 22, weight: 650, color: w(0.9), align: "right" });
        text(c, "MEAN", 24, 30, { size: 10, weight: 700, color: w(0.37), spacing: 0.6 });
        const mean = n ? err / n : 0;
        text(c, `${mean > 0 ? "+" : ""}${mean.toFixed(1)} ms`, 24, 54, { size: 15, weight: 650, color: w(0.8) });
      },
    };
  })(),

  /** 0.7: a section on a loop, faster each time */
  practice: (() => {
    const r = rng(3);
    const bars = Array.from({ length: 64 }, (_, i) => 0.25 + 0.5 * Math.abs(Math.sin(i * 0.21)) + r() * 0.25);
    for (let i = 26; i < 38; i++) bars[i] = Math.min(1, bars[i] + 0.3);
    const A = 0.38;
    const B = 0.6;
    const GX = 24;
    const GW = 472;
    const BASE = 166;
    const rates = [0.8, 0.85, 0.9, 0.95, 1];
    const passes = [];
    let at = 600;
    for (const rate of rates) {
      const d = 820 / rate;
      passes.push([at, at + d, rate]);
      at += d + 120;
    }
    const END = at;
    return {
      duration: END + 600,
      draw(c, t) {
        const xa = GX + GW * A;
        const xb = GX + GW * B;
        const h = E.quint(seg(t, 0, 500));
        rr(c, xa, 36, (xb - xa) * h, BASE - 36, 0, acc(0.1));
        bars.forEach((v, i) => {
          const x = GX + (i / bars.length) * GW;
          const inside = x >= xa && x < xb;
          rr(c, x, BASE - 100 * v, GW / bars.length - 2, 100 * v, 2, inside ? acc(0.55 + 0.25 * h) : w(0.13));
        });
        for (const [x, l] of [[xa, "A"], [xb, "B"]]) {
          c.globalAlpha = h;
          rr(c, x - 1, 30, 2, BASE - 26, 1, acc(1));
          rr(c, x - 8, 22, 16, 16, 5, acc(1));
          text(c, l, x, 34, { size: 10.5, weight: 700, color: "#0d0d0d", align: "center" });
          c.globalAlpha = 1;
        }
        // the playhead and the metronome
        let rate = rates[0];
        let since = -1;
        for (const [s, e, rt] of passes) {
          if (t >= s) {
            rate = rt;
            since = t - s;
          }
          if (t >= s && t < e) {
            const x = lerp(xa, xb, (t - s) / (e - s));
            rr(c, x, 30, 1.5, BASE - 26, 0, w(0.9));
            for (let b = 0; b < 4; b++) {
              const bt = s + ((e - s) * b) / 4;
              const lit = t >= bt ? clamp(1 - (t - bt) / 220) : 0;
              circle(c, lerp(xa, xb, b / 4) + (xb - xa) / 8, BASE + 16, 3, lit > 0 ? acc(0.3 + 0.7 * lit) : w(0.15));
            }
          }
        }
        text(c, "RATE", 496, 22, { size: 10, weight: 700, color: w(0.37), align: "right", spacing: 0.6 });
        popText(c, `${rate.toFixed(2)}×`, 496, 46, since, { size: 22, weight: 650, color: w(0.9), align: "right" });
        const done = seg(t, END, END + 400);
        if (done > 0) text(c, "full speed: ready for the whole chart", 260, 206, { size: 12, color: w(0.55 * done), align: "center" });
      },
    };
  })(),

  /** 0.8: a duplicate merging, a missing file, what it costs */
  care: (() => {
    const card = (c, y, a, cover, label, warn) => {
      c.globalAlpha = a;
      rr(c, 24, y, 316, 40, 10, w(0.05));
      rr(c, 30, y + 6, 48, 28, 6, cover);
      rr(c, 88, y + 12, 120, 5, 2.5, w(0.32));
      rr(c, 88, y + 22, 80, 4, 2, w(0.14));
      text(c, label, 330, y + 25, { size: 11, weight: warn ? 650 : 500, color: warn ? WARN : w(0.4), align: "right" });
      c.globalAlpha = 1;
    };
    return {
      duration: 4400,
      draw(c, t) {
        const m = E.inOut(seg(t, 900, 1700));
        const both = seg(t, 1500, 1800);
        card(c, 30, 1, acc(0.45), both > 0.5 ? "lazer and stable" : "lazer");
        if (m < 1) card(c, lerp(80, 30, m), 1 - m * m, acc(0.45), "stable");
        const up = E.quint(seg(t, 1900, 2500));
        const brokenY = lerp(130, 80, up);
        card(c, brokenY, seg(t, 300, 700), acc(0.18), up > 0.6 ? "audio missing" : "", up > 0.6);
        const rows = [
          ["Duplicates", seg(t, 1700, 2000) ? "1" : "0", 1700],
          ["Space they take", `${Math.round(38 * E.cubic(seg(t, 1700, 2600)))} MB`, 1700],
          ["Missing files", up > 0.6 ? "1" : "0", 2300],
        ];
        rows.forEach(([l, v, at], i) => {
          const y = 48 + i * 46;
          text(c, l.toUpperCase(), 372, y, { size: 10, weight: 700, color: w(0.37), spacing: 0.6 });
          const a = seg(t, at - 300, at);
          text(c, v, 372, y + 22, { size: 18, weight: 650, color: i === 2 && up > 0.6 ? WARN : w(0.3 + 0.6 * a) });
        });
      },
    };
  })(),

  /** 1.0: one window in four themes, two languages */
  themes: (() => {
    const T = [
      { name: "Dark", bg: "#0d0d0d", side: "#141414", card: "#1c1c1c", fg: [255, 255, 255], hi: 0.86, lo: 0.4, de: false },
      { name: "OLED", bg: "#000000", side: "#080808", card: "#0f0f0f", fg: [255, 255, 255], hi: 1, lo: 0.33, de: false },
      { name: "Light", bg: "#f0f0f0", side: "#ffffff", card: "#e8e8e8", fg: [0, 0, 0], hi: 0.9, lo: 0.38, de: true },
      { name: "High contrast", bg: "#0d0d0d", side: "#141414", card: "#1c1c1c", fg: [255, 255, 255], hi: 1, lo: 0.85, de: true },
    ];
    const STEP = 1250;
    const draw1 = (c, th) => {
      const fg = (a) => `rgba(${th.fg[0]},${th.fg[1]},${th.fg[2]},${a})`;
      rr(c, 110, 18, 300, 168, 12, th.bg);
      rr(c, 110, 18, 84, 168, 12, th.side);
      rr(c, 180, 18, 14, 168, 0, th.side);
      const nav = th.de ? ["Bibliothek", "Sammlungen", "Fähigkeiten"] : ["Library", "Collections", "Skills"];
      nav.forEach((n, i) => {
        if (i === 0) rr(c, 116, 38, 72, 22, 7, acc(0.18));
        text(c, n, 124, 53 + i * 26, { size: 10.5, weight: 600, color: i === 0 ? acc(1) : fg(th.lo) });
      });
      text(c, th.de ? "Guten Abend" : "Good evening", 210, 46, { size: 13, weight: 700, color: fg(th.hi) });
      for (let i = 0; i < 3; i++) {
        rr(c, 210 + i * 64, 60, 56, 44, 7, th.card);
        rr(c, 210 + i * 64, 110, 44, 4, 2, fg(th.hi * 0.6));
        rr(c, 210 + i * 64, 118, 30, 3, 1.5, fg(th.lo * 0.7));
      }
      rr(c, 210, 140, 184, 30, 8, th.card);
      rr(c, 218, 151, 60, 4, 2, fg(th.hi * 0.6));
      rr(c, 218, 159, 40, 3, 1.5, fg(th.lo * 0.7));
      rr(c, 352, 147, 34, 16, 8, acc(1));
    };
    return {
      duration: STEP * 4 + 200,
      draw(c, t) {
        const i = Math.min(3, Math.floor(t / STEP));
        const k = i < 3 ? E.inOut(seg(t, (i + 1) * STEP - 420, (i + 1) * STEP)) : 0;
        draw1(c, T[i]);
        if (k > 0) {
          c.globalAlpha = k;
          draw1(c, T[i + 1]);
          c.globalAlpha = 1;
        }
        const name = k > 0.5 ? T[i + 1].name : T[i].name;
        text(c, name, 260, 208, { size: 12.5, weight: 650, color: w(0.85), align: "center" });
      },
    };
  })(),

  /** 1.1: a week of playing */
  sessions: (() => {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const mins = [[25], [0], [40, 20], [15], [0], [70, 35], [55]];
    const total = mins.flat().reduce((a, b) => a + b, 0);
    return {
      duration: 3400,
      draw(c, t) {
        const base = 176;
        days.forEach((d, i) => {
          const x = 40 + i * 46;
          text(c, d, x + 14, 196, { size: 11, color: w(0.4), align: "center" });
          let y = base;
          mins[i].forEach((m, j) => {
            const k = E.quint(seg(t, 200 + i * 140 + j * 120, 900 + i * 140 + j * 120));
            const h = m * 1.15 * k;
            rr(c, x, y - h, 28, Math.max(0, h - 3), 5, j ? acc(0.5) : acc(1));
            y -= h;
          });
          if (!mins[i][0]) rr(c, x, base - 3, 28, 3, 1.5, w(0.1));
        });
        const n = E.cubic(seg(t, 300, 2200));
        const m = Math.round(total * n);
        text(c, "THIS WEEK", 496, 34, { size: 10, weight: 700, color: w(0.37), align: "right", spacing: 0.6 });
        text(c, `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`, 496, 60, { size: 22, weight: 650, color: w(0.9), align: "right" });
        text(c, "7 sittings", 496, 80, { size: 11.5, color: w(0.45), align: "right" });
        const s = seg(t, 2200, 2600);
        text(c, "Jacks +0.12★", 496, 120, { size: 13, weight: 650, color: ink(s), align: "right" });
        text(c, "Goal: 96% on Neurotoxin", 496, 138, { size: 11.5, color: w(0.45 * s), align: "right" });
        text(c, "2.1% to go", 496, 154, { size: 11.5, color: w(0.45 * s), align: "right" });
      },
    };
  })(),

  /** 1.2: the notes of one skin and the keys of another, mixed */
  skins: (() => {
    const notesA = (c, x, y, a) => rr(c, x, y, 22, 8, 4, acc(a));
    const notesB = (c, x, y, a) => {
      rr(c, x, y, 22, 10, 1, w(0.85 * a));
      rr(c, x + 2, y + 2, 18, 6, 1, `rgba(60,60,72,${a})`);
    };
    const keysA = (c, x, y, a) => rr(c, x + 3, y, 16, 5, 2.5, w(0.4 * a));
    const keysB = (c, x, y, a) => {
      rr(c, x, y - 6, 22, 16, 3, `rgba(255,255,255,${0.12 * a})`);
      circle(c, x + 11, y + 2, 4, acc(0.9 * a));
    };
    const panel = (c, x, label, notes, keys, t, na = 1, ka = 1) => {
      rr(c, x, 18, 120, 160, 12, w(0.04));
      for (let l = 0; l < 4; l++) {
        const lx = x + 10 + l * 26;
        if (notes) for (let n = 0; n < 3; n++) {
          const y = 30 + ((t * 0.06 + n * 46 + l * 17) % 120);
          notes(c, lx, y, na * clamp((150 - y) / 20));
        }
        if (keys) keys(c, lx, 160, ka);
      }
      text(c, label, x + 60, 198, { size: 11.5, weight: 600, color: w(0.6), align: "center" });
    };
    return {
      duration: 4400,
      draw(c, t) {
        const move = E.inOut(seg(t, 1400, 2400));
        const still = Math.min(t, 1400);
        panel(c, 20, "Skin A", notesA, keysA, still, 1 - move * 0.6, 1);
        panel(c, 380, "Skin B", notesB, keysB, still, 1, 1 - move * 0.6);
        const mx = 200;
        const ma = seg(t, 1400, 1700);
        c.globalAlpha = ma;
        rr(c, mx, 18, 120, 160, 12, acc(0.08));
        c.globalAlpha = 1;
        for (let l = 0; l < 4; l++) {
          const lx = mx + 10 + l * 26;
          if (move > 0) {
            for (let n = 0; n < 3; n++) {
              const y = 30 + ((still * 0.06 + n * 46 + l * 17) % 120);
              notesA(c, lerp(20 + 10 + l * 26, lx, move), y, move * clamp((150 - y) / 20));
            }
            keysB(c, lerp(380 + 10 + l * 26, lx, move), 160, move);
          }
        }
        const done = seg(t, 2500, 2900);
        text(c, "Your mix", mx + 60, 198, { size: 11.5, weight: 650, color: ink(done), align: "center" });
        if (done > 0) text(c, "my-mix.osk", mx + 60, 214, { size: 10.5, color: w(0.45 * done), align: "center" });
      },
    };
  })(),
};

// ── a stage: one explainer on a canvas ───────────────────────────────────

class Stage {
  constructor(figure, kind) {
    this.figure = figure;
    this.canvas = $("canvas", figure);
    this.ctx = this.canvas.getContext("2d");
    this.x = EXPLAINERS[kind];
    this.t = 0;
    this.played = false;
    this.raf = 0;
    $(".again", figure).addEventListener("click", (e) => {
      const b = e.currentTarget;
      b.classList.remove("spin");
      void b.offsetWidth;
      b.classList.add("spin");
      this.play();
    });
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.draw(this.t);
  }

  draw(t) {
    const c = this.ctx;
    const k = this.canvas.width / W;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(k, 0, 0, k, 0, 0);
    this.x.draw(c, t);
  }

  play() {
    this.played = true;
    cancelAnimationFrame(this.raf);
    if (reduced) {
      this.t = this.x.duration;
      this.draw(this.t);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      this.t = Math.min(this.x.duration, now - start);
      this.draw(this.t);
      if (this.t < this.x.duration) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
}

// ── the page ─────────────────────────────────────────────────────────────

const timeline = $("[data-timeline]");
const spine = $("[data-spine]");
const stages = [];

function versionHtml(v) {
  const id = `v${v.v.replace(".", "-")}`;
  const state = v.state === "done" ? `${STATE_LABEL.done} · ${v.when}` : STATE_LABEL[v.state];
  const items = v.items
    .map(([done, s]) => `<li class="${done ? "done" : ""}"><svg class="mk"><use href="#i-${done ? "check" : "open"}"/></svg><span>${s}</span></li>`)
    .join("");
  const stagesHtml = (v.explain ?? [])
    .map(([kind, caption]) => `<figure class="stage" data-kind="${kind}"><canvas></canvas><figcaption>${caption}</figcaption><button class="again" type="button" data-tip="Play again" aria-label="Play again"><svg><use href="#i-replay"/></svg></button></figure>`)
    .join("");
  return `
    <li class="ver" id="${id}" data-state="${v.state}">
      <span class="node" aria-hidden="true"></span>
      <div class="card">
        <button class="head" type="button" aria-expanded="false" aria-controls="${id}-body">
          <span class="v">${esc(v.v)}</span>
          <span><span class="name">${esc(v.name)}${v.moved ? `<span class="moved">was ${esc(v.moved)}</span>` : ""}</span><span class="summary">${esc(v.summary)}</span></span>
          <span class="state">${esc(state)}</span>
          <svg class="chev"><use href="#i-chevron"/></svg>
        </button>
        <div class="body" id="${id}-body"><div class="body-in"><div class="body-pad">
          ${v.moved ? `<p class="moved-note"><svg class="ic"><use href="#i-info"/></svg><span>Planned for ${esc(v.moved)} until 13 Oct 2026, moved after 1.0: Fumen doesn't need it before the release.</span></p>` : ""}
          <ul class="items">${items}</ul>
          ${v.note ? `<p class="note">${esc(v.note)}</p>` : ""}
          ${stagesHtml ? `<div class="stages">${stagesHtml}</div>` : ""}
        </div></div></div>
      </div>
    </li>`;
}

function render() {
  let html = "";
  let era = "";
  for (const v of VERSIONS) {
    const e = v.state === "done" ? "done" : v.state === "later" ? "later" : "next";
    if (e !== era) {
      era = e;
      html += `<li class="era" data-era="${e}">${ERAS[e]}</li>`;
    }
    html += versionHtml(v);
  }
  timeline.insertAdjacentHTML("beforeend", html);
  for (const fig of timeline.querySelectorAll(".stage")) stages.push(new Stage(fig, fig.dataset.kind));
}

/** The spine fills down to the version that's next (or the last one shipped that's showing). */
function fillTarget() {
  const shown = [...timeline.querySelectorAll(".ver:not([hidden])")];
  const next = shown.find((el) => el.dataset.state === "next") ?? shown.filter((el) => el.dataset.state === "done").pop();
  if (!next) return 0;
  return next.offsetTop + 28 - 26;
}

function updateSpine() {
  spine.style.setProperty("--fill", `${Math.max(0, fillTarget())}px`);
}

function toggle(ver, open = !ver.classList.contains("open")) {
  ver.classList.toggle("open", open);
  $(".head", ver).setAttribute("aria-expanded", String(open));
  if (open) for (const s of stages) if (ver.contains(s.figure)) requestAnimationFrame(() => s.resize());
}

/** The filter: rows that stay glide to their new places (FLIP), new ones rise in. */
function applyFilter(name) {
  const test = FILTERS[name];
  const rows = [...timeline.querySelectorAll(".ver, .era")];
  const before = new Map(rows.filter((el) => !el.hidden).map((el) => [el, el.getBoundingClientRect().top]));
  for (const el of rows) {
    if (el.classList.contains("era")) {
      const e = el.dataset.era;
      el.hidden = !(name === "all" || (name === "done" && e === "done") || (name === "coming" && e === "next") || (name === "later" && e === "later"));
    } else el.hidden = !test(el.dataset.state);
  }
  updateSpine();
  if (reduced) return;
  let n = 0;
  for (const el of rows) {
    if (el.hidden) continue;
    const top = el.getBoundingClientRect().top;
    if (before.has(el)) {
      const dy = before.get(el) - top;
      if (Math.abs(dy) > 0.5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
    } else {
      el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 420, delay: Math.min(n++, 10) * 30, easing: "cubic-bezier(.22,1,.36,1)", fill: "backwards" });
    }
  }
}

function setupFilter() {
  const seg = $(".seg");
  const bar = $(".seg-bar", seg);
  // measured from the boxes as drawn (sub-pixel, zoom and a late web font included)
  const move = (btn) => {
    const s = seg.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    bar.style.setProperty("--seg-x", `${r.left - s.left + seg.scrollLeft + 12}px`);
    bar.style.setProperty("--seg-w", `${Math.max(0, r.width - 24)}px`);
  };
  const current = () => $("[aria-selected='true']", seg);
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-filter]");
    if (!btn || btn.getAttribute("aria-selected") === "true") return;
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-selected", String(b === btn));
    move(btn);
    applyFilter(btn.dataset.filter);
  });
  // the buttons change size when the font comes in or the page is zoomed
  new ResizeObserver(() => move(current())).observe(seg);
  for (const b of seg.querySelectorAll("button")) new ResizeObserver(() => move(current())).observe(b);
  document.fonts.ready.then(() => move(current()));
  move(current());
}

/** Digits that roll into place (the latest version). */
function odometer(el, value) {
  if (reduced) {
    el.textContent = value;
    return;
  }
  el.textContent = "";
  el.setAttribute("aria-label", value);
  const wrap = document.createElement("span");
  wrap.className = "odo";
  wrap.setAttribute("aria-hidden", "true");
  let i = 0;
  for (const ch of value) {
    if (!/\d/.test(ch)) {
      const s = document.createElement("span");
      s.textContent = ch;
      wrap.append(s);
      continue;
    }
    const col = document.createElement("span");
    col.className = "odo-col";
    col.style.setProperty("--odo-delay", `${0.25 + i++ * 0.08}s`);
    col.innerHTML = Array.from({ length: 10 }, (_, d) => `<span>${d}</span>`).join("");
    wrap.append(col);
    requestAnimationFrame(() => requestAnimationFrame(() => (col.style.transform = `translateY(${-Number(ch) * 1.2}em)`)));
  }
  el.append(wrap);
}

async function latest() {
  const el = $("[data-latest]");
  const date = $("[data-latest-date]");
  try {
    const r = await fetch("/updates/latest.json", { cache: "no-store" });
    const j = await r.json();
    if (typeof j.version !== "string") throw new Error();
    odometer(el, j.version);
    const d = new Date(j.pub_date);
    date.textContent = Number.isNaN(d.getTime()) ? "" : `Released ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  } catch {
    odometer(el, el.textContent.trim());
    date.textContent = "";
  }
}

function stats() {
  const pre = VERSIONS.filter((v) => v.state !== "later");
  const shipped = pre.filter((v) => v.state === "done").length;
  $("[data-shipped]").textContent = String(shipped);
  $("[data-total]").textContent = String(pre.length);
  const meter = $("[data-meter]");
  requestAnimationFrame(() => requestAnimationFrame(() => (meter.style.transform = `scaleX(${shipped / pre.length})`)));
  const next = VERSIONS.find((v) => v.state === "next");
  if (next) {
    $("[data-next]").textContent = `${next.v} ${next.name}`;
    $("[data-next-sub]").textContent = next.summary;
  }
}

function init() {
  render();
  stats();
  void latest();
  setupFilter();

  timeline.addEventListener("click", (e) => {
    const head = e.target.closest(".head");
    if (head) toggle(head.closest(".ver"));
  });

  // what's next is open; a link to a version opens that one
  const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
  const open = target?.classList.contains("ver") ? target : timeline.querySelector(".ver[data-state='next']");
  if (open) toggle(open, true);
  // and so does following one on the page
  addEventListener("hashchange", () => {
    const el = document.getElementById(location.hash.slice(1));
    if (el?.classList.contains("ver")) toggle(el, true);
  });

  // the versions rise in, one after another
  if (!reduced) timeline.querySelectorAll(".ver, .era").forEach((el, i) => {
    el.style.animationDelay = `${0.35 + Math.min(i, 12) * 0.045}s`;
    el.classList.add("enter");
  });

  // the spine fills once, then follows the layout
  updateSpine();
  requestAnimationFrame(() => requestAnimationFrame(() => spine.classList.add("in")));
  spine.addEventListener("transitionend", () => spine.classList.add("settled"), { once: true });
  new ResizeObserver(updateSpine).observe(timeline);

  // explainers play when they come into view the first time
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const s = stages.find((x) => x.figure === en.target);
        if (s && !s.played) {
          s.resize();
          s.play();
        }
      }
    },
    { threshold: 0.55 },
  );
  document.fonts.ready.then(() => {
    for (const s of stages) {
      s.resize();
      io.observe(s.figure);
    }
  });
  addEventListener("resize", () => stages.forEach((s) => s.resize()));
  if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
}

init();
