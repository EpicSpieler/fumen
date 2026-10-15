import { describe, expect, it } from "vitest";
import { maniaWindows, ManiaReplay, RESULTS } from "./replay";

/** frames from [time, keys] pairs */
const frames = (...f: [number, number][]) => f.flatMap(([t, k]) => [t, k, 0, 0]);

describe("osu!mania hit windows", () => {
  it("follows lazer's ranges", () => {
    // OD 5: the middle of every range
    expect(maniaWindows(5, [], 1)).toEqual([19.5, 49.5, 82.5, 112.5, 136.5, 173.5]);
    // OD 8 at 1.5×: in song time, 1.5 times as wide
    expect(maniaWindows(8, ["DT"], 1.5)[1]).toBe(Math.floor((49 - 15 * 0.6) * 1.5) + 0.5);
    expect(maniaWindows(5, ["HR"], 1)[0]).toBe(Math.floor(19.4 / 1.4) + 0.5);
    expect(maniaWindows(10, ["CL"], 1)).toEqual([16.5, 34.5, 67.5, 97.5, 121.5, 158.5]);
  });
});

describe("judging", () => {
  const w = maniaWindows(5, [], 1);

  it("judges notes by distance and misses the ones left alone", () => {
    // column 0: notes at 1000 (hit 10 late), 2000 (left alone), 3000 (hit 60 early)
    const r = new ManiaReplay([1000, 0, 0, 2000, 0, 0, 3000, 0, 0], 1, frames([1010, 1], [1050, 0], [2940, 1], [2990, 0]), w);
    expect(r.judgements.map((j) => RESULTS[j.result])).toEqual(["perfect", "miss", "good"]);
    expect(r.gone(0)).toBe(1010);
    expect(r.gone(1)).toBe(Infinity);
    expect(r.stats(5000).accuracy).toBeCloseTo((305 + 0 + 200) / (3 * 305));
  });

  it("holds: the tail by the release over 1.5, a break caps it", () => {
    // a hold 1000–2000: pressed on time, let go 30 early (30 / 1.5 = 20 → great)
    const a = new ManiaReplay([1000, 0, 1000], 1, frames([1000, 1], [1970, 0]), w);
    expect(a.judgements.map((j) => RESULTS[j.result])).toEqual(["perfect", "great"]);
    expect(a.held(0, 1500)).toBe(true);
    // let go at 1300 (a break), pressed again at 1400, let go on time: Meh
    const b = new ManiaReplay([1000, 0, 1000], 1, frames([1000, 1], [1300, 0], [1400, 1], [2000, 0]), w);
    expect(b.judgements.map((j) => RESULTS[j.result])).toEqual(["perfect", "meh"]);
    // never let go: missed past the tail's Meh window
    const c = new ManiaReplay([1000, 0, 1000], 1, frames([1000, 1]), w);
    expect(c.judgements.map((j) => RESULTS[j.result])).toEqual(["perfect", "miss"]);
  });
});
