/* ruleset-stats.ts — chart numbers for osu!, osu!taiko and osu!catch, counted from the chart as
 * lazer plays it (the playfield's data; osu!mania has ManiaMapAnalyser's report instead):
 *
 *  - osu!: jumps (far apart at half a beat or faster) and how far, streams (5+ objects at a
 *    quarter beat) and their length and speed, the slider share, and the lean between aim and
 *    speed that follows from them
 *  - osu!taiko: colour changes and the don/kat patterns they make, finishers, rolls and swells
 *  - osu!catch: hyperdashes, how far the catcher moves between fruits and how much of it dashing
 *    (autoplay's own moves), banana showers
 *
 * Each also names what every second asks for, for the fullscreen's "This second" and the panel's
 * pattern bars. Fumen's own counts, not lazer's difficulty attributes.
 */
import type { ChartData } from "./types";

/** a quarter beat, give or take this much, is still one */
const SLACK = 1.15;

/** The beat length (ms) in force at `t`. */
function beatAt(beats: number[], t: number): number {
  let len = beats[1] || 500;
  for (let i = 0; i < beats.length; i += 3) {
    if (beats[i] > t + 0.5) break;
    if (beats[i + 1] > 0) len = beats[i + 1];
  }
  return len;
}

export interface Share {
  label: string;
  /** seconds it's what the second asks for */
  seconds: number;
  hint: string;
  /** a line under it */
  detail?: string;
  /** a speed, as the BPM of quarter beats at 1× */
  bpm?: number;
}

export interface Fact {
  label: string;
  value: string;
  sub: string;
  tip?: string;
}

export interface RulesetStats {
  /** what the chart is made of, biggest first ([label, count]) */
  parts: [string, number][];
  shares: Share[];
  facts: Fact[];
  /** what each second from `analysis.start` asks for (null: not much) */
  windows: (string | null)[];
}

const pct = (n: number, of: number) => `${of ? Math.round((n / of) * 100) : 0}%`;

/** Counts the seconds of each label, biggest first. */
function tally(windows: (string | null)[], hints: Record<string, string>): Share[] {
  const n = new Map<string, number>();
  for (const w of windows) if (w) n.set(w, (n.get(w) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([label, seconds]) => ({ label, seconds, hint: hints[label] ?? "" }));
}

/** The most common label per second (at least `min` votes). */
function perSecond(start: number, length: number, votes: [number, string][], min = 2): (string | null)[] {
  const out: (string | null)[] = [];
  const bins: Map<string, number>[] = Array.from({ length }, () => new Map());
  for (const [t, label] of votes) {
    const i = Math.floor((t - start) / 1000);
    if (i >= 0 && i < length) bins[i].set(label, (bins[i].get(label) ?? 0) + 1);
  }
  for (const b of bins) {
    let best: string | null = null;
    let top = min - 1;
    for (const [label, c] of b) if (c > top) [best, top] = [label, c];
    out.push(best);
  }
  return out;
}

export function rulesetStats(d: ChartData): RulesetStats | null {
  if (d.mode === 0 && d.osu) return osuStats(d);
  if (d.mode === 1 && d.taiko) return taikoStats(d);
  if (d.mode === 2 && d.catch) return catchStats(d);
  return null;
}

// ── osu! ──────────────────────────────────────────────────────────────

const OSU_HINTS: Record<string, string> = {
  Jumps: "Objects far apart, half a beat or faster: aim",
  Streams: "Five or more objects a quarter beat apart: speed and stamina",
  Sliders: "Sliders to follow",
  Spinners: "Spinning",
};

function osuStats(d: ChartData): RulesetStats {
  const o = d.osu!;
  const ob = o.objects;
  const N = 10;
  const diameter = 128 * o.scale;
  let circles = 0;
  let sliders = 0;
  let spinners = 0;
  const votes: [number, string][] = [];
  // where each object ends (a slider: the end of its last span)
  const endPos = (i: number): [number, number] => {
    if (ob[i + 1] !== 1) return [ob[i + 3], ob[i + 4]];
    const s = o.sliders[ob[i + 8]];
    if (!s || s.spans % 2 === 0 || s.path.length < 2) return [ob[i + 3], ob[i + 4]];
    return [s.path[s.path.length - 2], s.path[s.path.length - 1]];
  };
  let jumps = 0;
  let jumpSum = 0;
  let jumpMax = 0;
  let streams = 0;
  let bursts = 0;
  let longest = 0;
  let longestBpm = 0;
  let inStreams = 0;
  let run = 1;
  let runGap = 0;
  let prev = -1;
  const endRun = () => {
    if (run >= 5) {
      streams++;
      inStreams += run;
      if (run > longest) {
        longest = run;
        longestBpm = runGap ? 60000 / (runGap / (run - 1)) / 4 : 0;
      }
    } else if (run >= 3) bursts++;
    run = 1;
    runGap = 0;
  };
  for (let i = 0; i < ob.length; i += N) {
    const kind = ob[i + 1];
    const t = ob[i];
    if (kind === 2) {
      spinners++;
      votes.push([t, "Spinners"], [t, "Spinners"]);
      endRun();
      prev = -1;
      continue;
    }
    if (kind === 1) {
      sliders++;
      votes.push([t, "Sliders"]);
    } else circles++;
    if (prev >= 0) {
      const beat = beatAt(d.beats, t);
      const gap = t - ob[prev];
      const [px, py] = endPos(prev);
      const dist = Math.hypot(ob[i + 3] - px, ob[i + 4] - py);
      if (gap <= (beat / 4) * SLACK) {
        run++;
        runGap += gap;
        votes.push([t, "Streams"]);
      } else {
        endRun();
        if (gap <= (beat / 2) * SLACK && dist >= diameter * 1.2) {
          jumps++;
          jumpSum += dist;
          jumpMax = Math.max(jumpMax, dist);
          votes.push([t, "Jumps"]);
        }
      }
    }
    prev = i;
  }
  endRun();
  const all = circles + sliders + spinners;
  const a = d.analysis;
  const windows = perSecond(a.start, a.density.length, votes);
  const shares = tally(windows, OSU_HINTS);
  for (const s of shares) {
    if (s.label === "Streams" && streams) {
      s.detail = `${streams} ${streams === 1 ? "stream" : "streams"}, the longest ${longest} objects`;
      s.bpm = longestBpm;
    }
    if (s.label === "Jumps" && jumps) s.detail = `${Math.round(jumpSum / jumps)} osu!px on average`;
  }
  // aim against speed: objects jumped to against objects streamed
  const lean = jumps + inStreams ? (inStreams - jumps) / (inStreams + jumps) : 0;
  const leanLabel = jumps + inStreams < 10 ? "Neither" : lean < -0.25 ? "Aim" : lean > 0.25 ? "Speed" : "Both";
  const facts: Fact[] = [
    {
      label: "Jumps",
      value: jumps ? `${Math.round(jumpSum / jumps)} px` : "–",
      sub: jumps ? `on average, ${pct(jumps, all)} of objects · the farthest ${Math.round(jumpMax)} px (${(jumpMax / diameter).toFixed(1)} circles)` : "none at half a beat or faster",
      tip: "Distance in osu!pixels (the playfield is 512 across) from the end of one object to the next, for objects half a beat apart or closer",
    },
    {
      label: "Streams",
      value: streams ? `${longest}` : "–",
      sub: streams ? `objects in the longest · ${streams} ${streams === 1 ? "stream" : "streams"}${bursts ? `, ${bursts} bursts` : ""} · ${pct(inStreams, all)} of objects` : bursts ? `${bursts} bursts of 3 or 4, nothing longer` : "no quarter-beat runs",
    },
    { label: "Sliders", value: pct(sliders, all), sub: `of objects · ${spinners} ${spinners === 1 ? "spinner" : "spinners"}` },
    {
      label: "Leans on",
      value: leanLabel,
      sub: leanLabel === "Neither" ? "few jumps or streams" : `${jumps} objects jumped to, ${inStreams} streamed`,
      tip: "Fumen's count of jumps against stream objects, not lazer's aim and speed difficulty",
    },
  ];
  const parts: [string, number][] = [
    ["Circles", circles],
    ["Sliders", sliders],
    ["Spinners", spinners],
  ];
  return { parts: parts.filter(([, n]) => n > 0), shares, facts, windows };
}

// ── osu!taiko ─────────────────────────────────────────────────────────

const TAIKO_HINTS: Record<string, string> = {
  "Colour changes": "Don and kat swapping: reading and finger control",
  Streams: "Long runs of one colour at a quarter beat or faster",
  Rhythm: "Hits with room between them",
  Drumrolls: "Drumrolls and swells",
};

function taikoStats(d: ChartData): RulesetStats {
  const tk = d.taiko!;
  const ob = tk.objects;
  const N = 5;
  let dons = 0;
  let kats = 0;
  let finishers = 0;
  let rolls = 0;
  let swells = 0;
  let rollTime = 0;
  let changes = 0;
  let pairs = 0;
  let longest = 0;
  let longestBpm = 0;
  const patterns = new Map<string, number>();
  let patternCount = 0;
  const votes: [number, string][] = [];
  // the hits of the run under way (a quarter beat apart or closer)
  let run: { t: number; k: number }[] = [];
  const endRun = () => {
    if (run.length >= 3) {
      for (let j = 0; j + 3 <= run.length; j++) {
        const p = run
          .slice(j, j + 3)
          .map((h) => (h.k ? "K" : "D"))
          .join("");
        patterns.set(p, (patterns.get(p) ?? 0) + 1);
        patternCount++;
      }
    }
    if (run.length > longest) {
      longest = run.length;
      longestBpm = run.length > 1 ? 60000 / ((run[run.length - 1].t - run[0].t) / (run.length - 1)) / 4 : 0;
    }
    run = [];
  };
  let last: { t: number; k: number } | null = null;
  for (let i = 0; i < ob.length; i += N) {
    const [t, kind, end, flags] = [ob[i], ob[i + 1], ob[i + 2], ob[i + 3]];
    if (kind >= 2) {
      if (kind === 2) rolls++;
      else swells++;
      rollTime += Math.max(0, end - t);
      for (let s = t; s < end; s += 250) votes.push([s, "Drumrolls"]);
      endRun();
      last = null;
      continue;
    }
    if (kind === 0) dons++;
    else kats++;
    if (flags & 1) finishers++;
    const hit = { t, k: kind };
    const beat = beatAt(d.beats, t);
    if (last && t - last.t <= (beat / 4) * SLACK) {
      pairs++;
      const swap = last.k !== kind;
      if (swap) changes++;
      votes.push([t, swap ? "Colour changes" : "Streams"]);
      run.push(hit);
    } else {
      endRun();
      run = [hit];
      votes.push([t, "Rhythm"]);
    }
    last = hit;
  }
  endRun();
  const a = d.analysis;
  const hits = dons + kats;
  const windows = perSecond(a.start, a.density.length, votes);
  const shares = tally(windows, TAIKO_HINTS);
  const top = [...patterns].sort((x, y) => y[1] - x[1]).slice(0, 4);
  for (const s of shares) {
    if (s.label === "Colour changes" && top.length) s.detail = top.map(([p, n]) => `${p} ${pct(n, patternCount)}`).join(" · ");
    if (s.label === "Streams" && longest > 1) {
      s.detail = `the longest run ${longest} hits`;
      s.bpm = longestBpm;
    }
  }
  const facts: Fact[] = [
    {
      label: "Colour changes",
      value: pairs ? pct(changes, pairs) : "–",
      sub: pairs ? "of quarter-beat steps swap don and kat" : "no quarter-beat hits",
      tip: "Of every two hits a quarter beat apart or closer, how often the colour swaps",
    },
    {
      label: "Patterns",
      value: top.length ? top[0][0] : "–",
      sub: top.length ? top.map(([p, n]) => `${p} ${pct(n, patternCount)}`).join(" · ") : "no runs of three",
      tip: "Every three hits in a row inside quarter-beat runs: D don (centre), K kat (rim)",
    },
    { label: "Finishers", value: pct(finishers, hits), sub: `of hits · ${finishers} big notes` },
    {
      label: "Longest run",
      value: longest > 1 ? `${longest}` : "–",
      sub: `hits a quarter beat apart · ${rolls} ${rolls === 1 ? "drumroll" : "drumrolls"}, ${swells} ${swells === 1 ? "swell" : "swells"} (${Math.round(rollTime / 1000)} s)`,
    },
  ];
  const parts: [string, number][] = [
    ["Dons", dons],
    ["Kats", kats],
    ["Drumrolls", rolls],
    ["Swells", swells],
  ];
  return { parts: parts.filter(([, n]) => n > 0), shares, facts, windows };
}

// ── osu!catch ─────────────────────────────────────────────────────────

const CATCH_HINTS: Record<string, string> = {
  Hyperdashes: "Fruits too far to dash to: the catcher flies",
  Dashes: "Moves only a dash reaches",
  Movement: "Walking between fruits",
  Streams: "Droplets and fruits close together",
  Bananas: "Banana showers",
};

function catchStats(d: ChartData): RulesetStats {
  const c = d.catch!;
  const ob = c.objects;
  const fr = c.frames;
  const N = 6;
  let fruits = 0;
  let droplets = 0;
  let tiny = 0;
  let bananas = 0;
  let hypers = 0;
  let moveSum = 0;
  let moveMax = 0;
  let moves = 0;
  const showers = new Map<number, [number, number]>();
  const votes: [number, string][] = [];
  let prev: { t: number; x: number } | null = null;
  for (let i = 0; i < ob.length; i += N) {
    const [t, kind, x, flags, index] = [ob[i], ob[i + 1], ob[i + 2], ob[i + 3], ob[i + 4]];
    if (kind === 3) {
      bananas++;
      const s = showers.get(index);
      if (s) s[1] = t;
      else showers.set(index, [t, t]);
      votes.push([t, "Bananas"]);
      continue;
    }
    if (kind === 2) {
      tiny++;
      continue;
    }
    if (kind === 0) fruits++;
    else droplets++;
    if (flags & 1) {
      hypers++;
      votes.push([t, "Hyperdashes"], [t, "Hyperdashes"]);
    }
    if (prev) {
      const dist = Math.abs(x - prev.x);
      const gap = t - prev.t;
      if (dist > 0) {
        moves++;
        moveSum += dist;
        moveMax = Math.max(moveMax, dist);
      }
      // lazer's catcher walks 0.5 osu!px a ms and dashes at 1
      if (gap > 0 && !(flags & 1)) votes.push([t, dist / gap > 0.5 ? "Dashes" : dist / gap > 0.15 ? "Movement" : "Streams"]);
    }
    prev = { t, x };
  }
  // autoplay's moves: how much of the moving is dashed
  let moving = 0;
  let dashing = 0;
  for (let i = 3; i < fr.length; i += 3) {
    const dt = fr[i] - fr[i - 3];
    if (dt <= 0 || fr[i + 1] === fr[i - 2]) continue;
    moving += dt;
    if (fr[i + 2]) dashing += dt;
  }
  const banana = [...showers.values()].reduce((s, [a, b]) => s + (b - a), 0);
  const a = d.analysis;
  const windows = perSecond(a.start, a.density.length, votes);
  const shares = tally(windows, CATCH_HINTS);
  const caught = fruits + droplets;
  const facts: Fact[] = [
    { label: "Hyperdashes", value: pct(hypers, caught), sub: `of fruits and droplets · ${hypers} in all`, tip: "Fruits lazer marks as too far to reach by dashing" },
    {
      label: "Moves",
      value: moves ? `${Math.round(moveSum / moves)} px` : "–",
      sub: moves ? `between fruits on average · the farthest ${Math.round(moveMax)} px` : "the catcher stays put",
      tip: "Sideways distance in osu!pixels (the playfield is 512 across) between one fruit or droplet and the next",
    },
    {
      label: "Dashing",
      value: moving ? pct(dashing, moving) : "–",
      sub: "of the time the catcher moves, as autoplay plays it",
    },
    {
      label: "Bananas",
      value: showers.size ? `${Math.round(banana / 1000)} s` : "–",
      sub: showers.size ? `${showers.size} ${showers.size === 1 ? "shower" : "showers"}, ${bananas} bananas` : "no banana showers",
    },
  ];
  const parts: [string, number][] = [
    ["Fruits", fruits],
    ["Droplets", droplets],
    ["Tiny droplets", tiny],
    ["Bananas", bananas],
  ];
  return { parts: parts.filter(([, n]) => n > 0), shares, facts, windows };
}
