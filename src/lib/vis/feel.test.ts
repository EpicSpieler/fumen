import { describe, expect, it } from "vitest";
import { breakSize, comboEnergy, Feel, nextMilestone, type FeelEvent, type FeelFrame } from "./feel";
import type { TosuNow } from "../tosu";

const MD5 = "174589aaaaaaaaaaaaaaaaaaaaaaaaaa";

type Step = Partial<Omit<TosuNow, "play">> & { play?: Partial<TosuNow["play"]> };

function msg(s: Step): TosuNow {
  return {
    md5: MD5,
    state: 2,
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
    firstObject: 1000,
    lastObject: 61000,
    mapCombo: 1200,
    inBreak: false,
    results: null,
    ...s,
    play: { failed: false, accuracy: 100, score: 0, maxCombo: 0, combo: 0, misses: 0, breaks: 0, hits: 0, health: 100, rank: "SS", pp: null, mods: "", modList: [], judges: { geki: 0, n300: 0, katu: 0, n100: 0, n50: 0, miss: 0 }, player: "P", me: "P", ...s.play },
  };
}

/** A feel fed like tosu feeds it: a step every 150 ms, a frame after each; what came out. */
class Run {
  feel = new Feel();
  t = 100;
  frames: FeelFrame[] = [];
  events: FeelEvent[] = [];

  steps(steps: Step[]): this {
    for (const s of steps) {
      this.feel.feed(msg(s), this.t);
      this.wait(0.15);
    }
    return this;
  }

  /** frames for `secs` without messages */
  wait(secs: number): this {
    for (let left = secs; left > 1e-9; left -= 1 / 60) {
      const dt = Math.min(1 / 60, left);
      this.t += dt;
      const f = this.feel.frame(dt, this.t);
      if (f) {
        this.frames.push(f);
        this.events.push(...f.events);
      }
    }
    return this;
  }

  get last(): FeelFrame {
    return this.frames[this.frames.length - 1];
  }

  kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

/** song select, then the map started from its lead-in and played on with combo `to` by the end */
function started(): Step[] {
  return [
    { state: 5, live: 40000 },
    // the menu's music runs on into loading
    { state: 2, live: 40150 },
    { state: 2, live: -1500 },
    { state: 2, live: -1350 },
  ];
}

/** playing from `from` to `to` ms, the combo going up by one per step from `combo` (the
 * judgements go up with the time) */
function playing(from: number, to: number, combo = 0, extra: Step["play"] = {}): Step[] {
  const out: Step[] = [];
  for (let live = from, c = combo; live <= to; live += 150, c++) out.push({ state: 2, live, play: { combo: c, maxCombo: c, hits: Math.round(live / 150) + 1, ...extra } });
  return out;
}

describe("Feel", () => {
  it("starts once the map has, and has nothing to say before", () => {
    const r = new Run();
    expect(r.feel.frame(1 / 60, 0)).toBeNull();
    r.steps(started());
    expect(r.kinds()).toEqual(["start"]);
    expect(r.last.phase).toBe("play");
  });

  it("marks combo milestones once each", () => {
    const r = new Run().steps(started());
    r.steps(playing(0, 150 * 260)).wait(0.2);
    expect(r.events.filter((e) => e.kind === "milestone")).toEqual([
      { kind: "milestone", combo: 100, big: false },
      { kind: "milestone", combo: 250, big: false },
    ]);
  });

  it("tells a miss from a combo break, and how much a break hurts", () => {
    const r = new Run().steps(started()).steps(playing(0, 150 * 30, 0));
    // three misses: combo 30 → 0 is a break, 0 → 0 just misses
    r.steps([{ state: 2, live: 4650, play: { combo: 0, misses: 1, hits: 32 } }]);
    r.steps([{ state: 2, live: 4800, play: { combo: 0, misses: 3, hits: 34 } }]);
    // a drop of a few (10 → 2) is a miss
    r.steps(playing(4950, 4950 + 150 * 10, 0, { misses: 3 }));
    r.steps([{ state: 2, live: 6600, play: { combo: 2, misses: 4, hits: 50 } }]);
    const got = r.events.filter((e) => e.kind === "miss" || e.kind === "break");
    expect(got).toEqual([
      { kind: "miss", n: 1, combo: 30 },
      { kind: "break", lost: 30, size: breakSize(30) },
      { kind: "miss", n: 2, combo: 0 },
      { kind: "miss", n: 1, combo: 10 },
    ]);
    expect(r.last.breakSize).toBeCloseTo(breakSize(30));
    expect(r.last.grief).toBeGreaterThan(0);
  });

  it("goes again on a restart", () => {
    const r = new Run().steps(started()).steps(playing(0, 150 * 120));
    r.steps([{ state: 2, live: -1500, play: { combo: 0, hits: 0 } }, { state: 2, live: -1350, play: { combo: 0, hits: 0 } }]);
    expect(r.events.filter((e) => e.kind === "start")).toEqual([
      { kind: "start", retry: false },
      { kind: "start", retry: true },
    ]);
    expect(r.last.combo).toBe(0);
  });

  it("ends in a fail, which fades once osu! leaves it", () => {
    const r = new Run().steps(started()).steps(playing(0, 30000));
    r.steps([{ state: 2, live: 31000, paused: true, play: { failed: true, combo: 0, misses: 9, hits: 210 } }]);
    expect(r.events.at(-1)).toEqual({ kind: "fail", progress: 0.5 });
    expect(r.last.end).toMatchObject({ kind: "fail", k: 1, progress: 0.5 });
    // the fail screen goes on; misses there don't count
    r.steps([{ state: 2, live: 31200, paused: true, play: { failed: true, combo: 0, misses: 12, hits: 213 } }]);
    expect(r.kinds().filter((k) => k === "miss")).toEqual([]);
    r.steps([{ state: 5, live: 31300 }]).wait(1);
    expect(r.last.end).toBeNull();
    // and once the stage has gone dark, nothing more
    r.wait(8);
    expect(r.feel.frame(1 / 60, r.t + 1 / 60)).toBeNull();
  });

  it("ends in a full combo, or a pass when anything was lost", () => {
    const fc = new Run().steps(started()).steps(playing(0, 61500, 0, { rank: "S", accuracy: 98.5 }));
    expect(fc.last.breath).toBeGreaterThan(0.3);
    fc.steps([{ state: 7, live: 62000, results: { scoreId: 5, rank: "S", accuracy: 98.4, score: 1, maxCombo: 411, pp: null } }]);
    expect(fc.events.at(-1)).toMatchObject({ kind: "fc", rank: "S", combo: 411 });
    expect((fc.events.at(-1) as { accuracy: number }).accuracy).toBeCloseTo(0.984);
    expect(fc.last.phase).toBe("end");
    expect(fc.last.end?.kind).toBe("fc");

    const pass = new Run().steps(started()).steps(playing(0, 20000)).steps([{ state: 2, live: 20150, play: { combo: 0, misses: 1, hits: 140 } }]);
    pass.steps(playing(20300, 61500, 1, { misses: 1, rank: "A", accuracy: 95 }));
    expect(pass.last.breath).toBe(0);
    pass.steps([{ state: 7, live: 62000, play: { combo: 278, maxCombo: 133, misses: 1, rank: "A", accuracy: 95 } }]);
    expect(pass.events.at(-1)).toMatchObject({ kind: "pass", rank: "A", accuracy: 0.95 });
  });

  it("feels low health, but not in taiko where it fills up from nothing", () => {
    const r = new Run().steps(started()).steps(playing(0, 3000, 0, { health: 20 })).wait(2);
    expect(r.last.danger).toBeGreaterThan(0.6);
    r.steps(playing(3150, 6000, 20, { health: 90 })).wait(3);
    expect(r.last.danger).toBeLessThan(0.05);
    const taiko = new Run().steps(started().map((s) => ({ ...s, mode: 1 }))).steps(playing(0, 3000, 0, { health: 5 }).map((s) => ({ ...s, mode: 1 }))).wait(2);
    expect(taiko.last.danger).toBe(0);
  });

  it("builds up with the combo and drops at a break", () => {
    const r = new Run().steps(started()).steps(playing(0, 150 * 400)).wait(2);
    const up = r.last.energy;
    expect(up).toBeGreaterThan(0.6);
    r.steps([{ state: 2, live: 150 * 401, play: { combo: 0, misses: 1, hits: 402 } }]).wait(1.5);
    expect(r.last.energy).toBeLessThan(0.1);
  });

  it("forgets moments nobody drew in time", () => {
    const feel = new Feel();
    let t = 0;
    for (const s of [...started(), ...playing(0, 150 * 120)]) {
      feel.feed(msg(s), t);
      t += 0.15;
    }
    // drawn only now: just the last half second's moments are left (the milestone was long ago)
    expect(feel.frame(1 / 60, t)?.events).toEqual([]);
  });
});

describe("feel numbers", () => {
  it("has milestones at 100, 250, 500, 750, 1000, then every 500", () => {
    expect([0, 99, 100, 300, 600, 999, 1000, 1499, 2600].map(nextMilestone)).toEqual([100, 100, 250, 500, 750, 1000, 1500, 1500, 3000]);
  });

  it("weighs breaks and combos", () => {
    expect(breakSize(20)).toBeCloseTo(0.42, 2);
    expect(breakSize(1500)).toBe(1);
    expect(comboEnergy(0, 2000)).toBe(0);
    expect(comboEnergy(600, 2000)).toBeCloseTo(1 - Math.exp(-1.6), 5);
    expect(comboEnergy(240, 800)).toBeCloseTo(1 - Math.exp(-1.6), 5);
  });
});
