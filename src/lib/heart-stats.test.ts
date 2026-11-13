import { describe, expect, it } from "vitest";
import { averageIn, dayOf, summarize, totals, type HeartTry } from "./heart-stats";

describe("a try's pulse", () => {
  const samples: [number, number][] = [
    [0, 100],
    [1000, 110],
    [2000, 0], // no reading
    [3000, 150],
    [4000, 160],
    [5000, 120],
  ];

  it("comes to its average, highest and lowest, leaving out empty readings", () => {
    const h = summarize(samples)!;
    expect(h.samples).toHaveLength(5);
    expect(h.avg).toBe(128);
    expect(h.max).toBe(160);
    expect(h.min).toBe(100);
    expect(h.fast).toBeNull();
  });

  it("knows the pulse in the fastest part", () => {
    expect(summarize(samples, { a: 2500, b: 4500 })!.fast).toBe(155);
    expect(averageIn(samples, 2500, 3500)).toBeNull();
  });

  it("needs a few readings", () => {
    expect(summarize([[0, 90], [1000, 95]])).toBeNull();
    expect(summarize([])).toBeNull();
  });
});

describe("the pulse over many tries", () => {
  const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
  const tri = (id: number, md5: string, started: number, avg: number, max: number, min: number, outcome: HeartTry["outcome"] = "fail", fast: number | null = null): HeartTry => ({
    id,
    md5,
    mode: 3,
    started,
    outcome,
    mods: "",
    avg,
    max,
    min,
    fast,
  });
  const list = [
    tri(1, "a", at(12, 20), 120, 150, 90, "pass", 140),
    tri(2, "a", at(12, 21), 130, 170, 100),
    tri(3, "b", at(13, 19), 110, 130, 80, "fail", 125),
    tri(4, "a", at(13, 22), 140, 181, 110, "pass", null),
  ];

  it("puts them together", () => {
    const s = totals(list)!;
    expect(s.tries).toBe(4);
    expect(s.avg).toBe(125);
    expect(s.max).toEqual({ bpm: 181, md5: "a", started: at(13, 22) });
    expect(s.min).toEqual({ bpm: 80, md5: "b", started: at(13, 19) });
    expect(s.fast).toBe(132.5);
    expect(s.passAvg).toBe(130);
    expect(s.restAvg).toBe(120);
  });

  it("by day, oldest first, and by difficulty, the most played first", () => {
    const s = totals(list)!;
    expect(s.days.map((d) => [d.day, d.avg, d.max, d.tries])).toEqual([
      [dayOf(at(12, 12)), 125, 170, 2],
      [dayOf(at(13, 12)), 125, 181, 2],
    ]);
    expect(s.maps.map((m) => [m.md5, m.tries, m.max, m.min, m.fast])).toEqual([
      ["a", 3, 181, 90, 140],
      ["b", 1, 130, 80, 125],
    ]);
  });

  it("is nothing without tries", () => {
    expect(totals([])).toBeNull();
  });
});
