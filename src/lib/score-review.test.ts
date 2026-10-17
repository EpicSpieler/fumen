import { describe, expect, it } from "vitest";
import { judge, rateHint, review, stretches, timing } from "./score-review";
import { rankNumber } from "./live";
import type { ChartData } from "./types";

/** a 1-key osu!mania chart: a note every 250 ms for 20 s */
function chart(): ChartData {
  const notes: number[] = [];
  for (let t = 1000; t < 21000; t += 250) notes.push(t, 0, 0);
  return {
    mode: 3,
    keys: 1,
    notes,
    beats: [0, 500, 4],
    breaks: [],
    kiai: [],
    stars: [],
    analysis: { start: 1000, end: 20750, drain: 19750, notes: notes.length / 3, holds: 0, npsAvg: 4, npsPeak: 4, density: [], longestBurst: 0, lanes: [], chords: [0, 0, 0, 0], jackRatio: 1, lnTime: 0, patterns: [], tags: [] },
    report: { category: "Jacks", mode: "RC", lnRatio: 0, svAmount: 0, clusters: [], start: 1000, labels: ["Jacks", "Stream"], seconds: Array.from({ length: 20 }, (_, i) => (i >= 10 && i < 14 ? 0 : 1)) },
  };
}

/** presses on every note (`late` ms late), skipping the ones in `skip` (s of song) */
function frames(d: ChartData, late: (t: number) => number, skip: (t: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < d.notes.length; i += 3) {
    const t = d.notes[i];
    if (skip(t)) continue;
    out.push(t + late(t), 1, 0, 0, t + late(t) + 40, 0, 0, 0);
  }
  return out;
}

describe("a play looked at afterwards", () => {
  it("finds where the accuracy went, with the pattern there", () => {
    const d = chart();
    // perfect, except misses from 11 s to 13 s (the jacks)
    const r = judge(d, 8, [], 1, frames(d, () => 0, (t) => t >= 11000 && t < 13000))!;
    const rv = review(d, r, 1);
    expect(rv.misses.length).toBe(8);
    expect(rv.accuracy).toBeCloseTo(72 / 80, 6);
    expect(rv.stretches[0]).toMatchObject({ start: 11000, misses: 8, pattern: "Jacks" });
    expect(rv.stretches[0].end).toBeGreaterThanOrEqual(13000);
    expect(rv.stretches[0].loss).toBeCloseTo(8 / 80, 6);
    // the losses add up to what the accuracy lost
    expect(rv.loss.reduce((a, b) => a + b, 0)).toBeCloseTo(1 - rv.accuracy, 6);
  });

  it("names nothing when nothing went wrong", () => {
    const d = chart();
    const rv = review(d, judge(d, 8, [], 1, frames(d, () => 0, () => false))!, 1);
    expect(rv.accuracy).toBe(1);
    expect(rv.stretches).toEqual([]);
  });

  it("measures the lean and spread in real time", () => {
    const js = Array.from({ length: 20 }, (_, i) => ({ time: i * 100, result: 0 as const, offset: i % 2 ? 12 : 8, col: 0, obj: i, tail: false }));
    const tm = timing(js, 1.5)!;
    expect(tm.mean).toBeCloseTo(10 / 1.5, 6);
    expect(tm.ur).toBeCloseTo((2 / 1.5) * 10, 6);
    expect(tm.late).toBe(20);
    expect(timing(js.slice(0, 5), 1)).toBeNull();
  });

  it("keeps worst stretches apart", () => {
    const d = chart();
    // a minute long, so the two stand out from an even spread
    const loss = new Array(60).fill(0);
    loss[3] = 0.05;
    loss[4] = 0.05;
    loss[15] = 0.03;
    const s = stretches(d, loss, new Array(60).fill(0), new Array(60).fill(1));
    expect(s.map((x) => [x.start, x.end])).toEqual([
      [3000, 5000],
      [15000, 16000],
    ]);
  });

  it("ranks and rates", () => {
    expect(rankNumber("XH")).toBe(7);
    expect(rankNumber("A")).toBe(3);
    expect(rankNumber(null)).toBe(-1);
    expect(rateHint(3, 0.99, 1)).toBe(1.1);
    expect(rateHint(3, 0.9, 1.2)).toBe(1.1);
    expect(rateHint(3, 0.95, 1)).toBeNull();
    expect(rateHint(0, 0.99, 1)).toBeNull();
  });
});
