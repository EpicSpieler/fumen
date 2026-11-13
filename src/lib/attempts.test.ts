import { describe, expect, it } from "vitest";
import { AttemptTracker, progress, stopHeat, stopSpot, tally, troubleSpot, type Attempt } from "./attempts";
import type { TosuNow } from "./tosu";

const MD5 = "174589aaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "cad1c5bbbbbbbbbbbbbbbbbbbbbbbbbb";

type Step = Partial<Omit<TosuNow, "play">> & { play?: Partial<TosuNow["play"]> };

function msg(s: Step): TosuNow {
  return {
    md5: MD5,
    state: 5,
    live: 0,
    rate: 1,
    pitch: false,
    artist: "A",
    title: "T",
    version: "V",
    paused: false,
    client: "lazer",
    mode: 3,
    keys: 4,
    firstObject: 4802,
    lastObject: 120000,
    mapCombo: null,
    inBreak: false,
    results: null,
    ...s,
    play: { failed: false, accuracy: 100, score: 0, maxCombo: 0, combo: 0, misses: 0, breaks: 0, hits: 0, health: null, rank: "", pp: null, mods: "", modList: [], judges: { geki: 0, n300: 0, katu: 0, n100: 0, n50: 0, miss: 0 }, player: "DerTesti", me: "DerTesti", ...s.play },
  };
}

/** Feeds steps 150 ms apart (like tosu); all tries that came out. */
function run(steps: Step[], t = new AttemptTracker()): Attempt[] {
  const out: Attempt[] = [];
  steps.forEach((s, i) => out.push(...t.feed(msg(s), 1_000_000 + i * 150)));
  return out;
}

/** gameplay from `from` to `to` ms, with hits growing */
function playing(from: number, to: number, extra: Step = {}): Step[] {
  const steps: Step[] = [];
  for (let live = from, i = 0; live <= to; live += 1000, i++) steps.push({ state: 2, live, ...extra, play: { hits: Math.max(0, Math.floor((live - 4802) / 100)), accuracy: 97, maxCombo: i, ...extra.play } });
  return steps;
}

/** start a map: song select, then play with the menu's music running on, then back to 14 ms */
const start = (menu = 74000): Step[] => [
  { state: 5, live: menu },
  { state: 2, live: menu + 600 },
  { state: 2, live: menu + 1200 },
  { state: 2, live: 14 },
  { state: 2, live: 14 },
];

describe("AttemptTracker", () => {
  it("a fail, then a restart, then a quit", () => {
    const out = run([
      ...start(),
      ...playing(500, 33000),
      { state: 2, live: 33656, play: { failed: true, hits: 288, accuracy: 87.09, misses: 20 } },
      { state: 2, live: 34000, paused: true, play: { failed: true, hits: 288, accuracy: 87.09, misses: 20 } },
      // retry: back near the beginning, judgements from 0
      { state: 2, live: 1856, paused: true, play: { hits: 0, accuracy: 0 } },
      { state: 2, live: 1856, play: { hits: 0 } },
      { state: 2, live: 2000, play: { hits: 0 } },
      ...playing(3000, 22000),
      { state: 2, live: 22066, paused: true, play: { hits: 172, accuracy: 91.56 } },
      { state: 2, live: 22169, play: { hits: 172, accuracy: 91.56 } },
      { state: 5, live: 22391 },
    ]);
    expect(out.map((a) => a.outcome)).toEqual(["fail", "quit"]);
    expect(out[0].failedAt).toBe(33656);
    expect(out[0].reached).toBe(33656);
    expect(out[0].accuracy).toBeCloseTo(0.8709);
    expect(out[0].misses).toBe(20);
    expect(out[1].reached).toBe(22169);
    expect(out[1].accuracy).toBeCloseTo(0.9156);
    expect(progress(out[0])).toBeCloseTo((33656 - 4802) / (120000 - 4802));
  });

  it("keeps the pulse with the try under way, not while it loads or behind the fail", () => {
    const t = new AttemptTracker();
    const out: Attempt[] = [];
    let i = 0;
    const feed = (s: Step, bpm: number): void => {
      out.push(...t.feed(msg(s), 1_000_000 + i++ * 150));
      t.pulse(bpm, true);
    };
    for (const s of start()) feed(s, 80);
    playing(500, 30000).forEach((s, k) => feed(s, 100 + k));
    t.pulse(200, false);
    t.pulse(0, true);
    feed({ state: 2, live: 30656, play: { failed: true, hits: 258, misses: 20 } }, 150);
    feed({ state: 2, live: 31000, paused: true, play: { failed: true, hits: 258, misses: 20 } }, 175);
    feed({ state: 5, live: 50000 }, 90);
    expect(out.map((a) => a.outcome)).toEqual(["fail"]);
    const h = out[0].heart!;
    expect(h.samples.length).toBeGreaterThanOrEqual(28);
    expect(h.samples.every(([at, bpm]) => at >= 500 && at <= 30656 && bpm >= 100 && bpm <= 129)).toBe(true);
    expect(h.max).toBe(129);
    expect(h.min).toBeGreaterThanOrEqual(100);
  });

  it("a pass takes the first score the results screen shows", () => {
    const out = run([
      ...start(),
      ...playing(500, 119000),
      { state: 2, live: 120500, paused: true, play: { hits: 1150, accuracy: 97.36, maxCombo: 906 } },
      { state: 7, live: 120500, paused: true },
      { state: 7, live: 120600, results: { scoreId: 7858284056, rank: "S", accuracy: 97.36, score: 901525, maxCombo: 906, pp: 110.8 } },
      { state: 7, live: 120700, results: { scoreId: 7851845074, rank: "S", accuracy: 97.14, score: 900000, maxCombo: 900, pp: 109 } },
      { state: 5, live: 50000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ outcome: "pass", scoreId: 7858284056, rank: "S", score: 901525, maxCombo: 906 });
    expect(out[0].accuracy).toBeCloseTo(0.9736);
  });

  it("a pass whose score never shows still counts", () => {
    const t = new AttemptTracker();
    const out = run([...start(), ...playing(500, 60000), { state: 7, live: 60100 }], t);
    expect(out).toHaveLength(0);
    out.push(...t.feed(msg({ state: 5, live: 1000 }), 2_000_000));
    expect(out.map((a) => a.outcome)).toEqual(["pass"]);
  });

  it("a restart before the end is a retry", () => {
    const out = run([...start(), ...playing(500, 15000), { state: 2, live: 300, play: { hits: 0 } }, { state: 2, live: 500, play: { hits: 0 } }, ...playing(1000, 9000), { state: 5, live: 9500 }]);
    expect(out.map((a) => a.outcome)).toEqual(["retry", "quit"]);
    expect(out[0].reached).toBe(14500);
  });

  it("the menu's music while loading isn't played", () => {
    // quit while it still loads: nothing was played
    const out = run([{ state: 5, live: 74000 }, { state: 2, live: 74600 }, { state: 2, live: 75200 }, { state: 5, live: 75400 }]);
    expect(out).toHaveLength(0);
  });

  it("leaves out autoplay and other people's plays", () => {
    expect(run([...start(), ...playing(500, 9000, { play: { modList: ["AT"] } }), { state: 5, live: 9500 }])).toHaveLength(0);
    expect(run([...start(), ...playing(500, 9000, { play: { player: "peppy" } }), { state: 5, live: 9500 }])).toHaveLength(0);
  });

  it("another map while playing ends the try before", () => {
    const out = run([...start(), ...playing(500, 9000), ...playing(500, 2000, { md5: OTHER }).map((s, i) => (i === 0 ? { ...s, live: 14 } : s))]);
    expect(out.map((a) => [a.md5, a.outcome])).toEqual([[MD5, "quit"]]);
  });

  it("tosu going ends a try under way", () => {
    const t = new AttemptTracker();
    run([...start(), ...playing(500, 9000)], t);
    expect(t.end(3_000_000).map((a) => a.outcome)).toEqual(["quit"]);
  });
});

const tried = (outcome: Attempt["outcome"], end: number, missesAt: number[] = [], extra: Partial<Attempt> = {}): Attempt => ({
  md5: MD5,
  mode: 3,
  client: "lazer",
  started: 0,
  ended: 1,
  outcome,
  reached: end,
  failedAt: outcome === "fail" ? end : null,
  firstObject: 4802,
  lastObject: 120000,
  accuracy: 0.9,
  score: 0,
  maxCombo: 0,
  misses: missesAt.length,
  missesAt,
  mods: "",
  rate: 1,
  pp: null,
  scoreId: null,
  rank: null,
  ...extra,
});

describe("troubleSpot", () => {
  it("starts at the run of misses that led to the fail", () => {
    // an early stray miss, then a run from 27.2 s to the fail at 33.6 s
    expect(troubleSpot(tried("fail", 33656, [9000, 27200, 28900, 30100, 31900, 33400]))).toEqual({ a: 26200, b: 35156 });
  });

  it("is a few seconds before the end without misses there", () => {
    expect(troubleSpot(tried("quit", 22169, [5000]))).toEqual({ a: 17669, b: 23669 });
  });

  it("stays a part, not half the song", () => {
    const misses = Array.from({ length: 40 }, (_, i) => 10000 + i * 1000);
    expect(troubleSpot(tried("fail", 50000, misses))).toEqual({ a: 31500, b: 51500 });
  });

  it("has nothing for a pass", () => {
    expect(troubleSpot(tried("pass", 120000))).toBeNull();
  });
});

describe("stopHeat / stopSpot", () => {
  it("finds the second most tries end around", () => {
    const tries = [tried("fail", 33656, [31000, 33000]), tried("fail", 34100, [32500]), tried("quit", 33200, [32000]), tried("fail", 61000), tried("pass", 120000)];
    const heat = stopHeat(tries, 125);
    expect(heat.indexOf(1)).toBe(33);
    expect(heat[61]).toBeGreaterThan(0);
    expect(heat[61]).toBeLessThan(0.5);
    const spot = stopSpot(tries, 125)!;
    expect(spot.stops).toBe(3);
    expect(spot.section.a).toBeGreaterThan(28000);
    expect(spot.section.a).toBeLessThan(33000);
    expect(spot.section.b).toBeGreaterThan(34000);
  });

  it("takes tries a few seconds apart as the same place", () => {
    const spot = stopSpot([tried("fail", 232400, [228500, 231900]), tried("fail", 235100, [233000, 234800]), tried("pass", 400000)], 410);
    expect(spot?.stops).toBe(2);
  });

  it("needs two tries ending at the same place", () => {
    expect(stopSpot([tried("fail", 33656), tried("fail", 70000)], 125)).toBeNull();
    expect(stopSpot([tried("pass", 120000)], 125)).toBeNull();
  });

  it("counts tries by how they ended", () => {
    expect(tally([tried("fail", 60200), tried("quit", 10000), tried("retry", 5000), tried("pass", 120000)])).toEqual({ tries: 4, pass: 1, fail: 1, left: 2, furthest: 1 });
    expect(tally([tried("fail", 62401)]).furthest).toBeCloseTo(0.5);
  });
});

describe("AttemptTracker misses", () => {
  it("remembers when each miss came, up to the fail", () => {
    const out = run([
      ...start(),
      { state: 2, live: 5000, play: { hits: 5 } },
      { state: 2, live: 9000, play: { hits: 40, misses: 1 } },
      { state: 2, live: 9150, play: { hits: 41, misses: 3 } },
      { state: 2, live: 12000, play: { hits: 60, misses: 3 } },
      { state: 2, live: 12500, play: { hits: 62, misses: 4, failed: true } },
      { state: 2, live: 13000, play: { hits: 62, misses: 6, failed: true } },
      { state: 5, live: 50000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].missesAt).toEqual([9000, 9150, 9150, 12500]);
    expect(out[0].failedAt).toBe(12500);
  });
});
