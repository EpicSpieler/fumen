import { describe, expect, it } from "vitest";
import { RESULTS } from "./replay";
import { TaikoReplay, taikoOd, taikoWindows } from "./taiko-replay";
import type { TaikoChartData } from "./types";

/** legacy buttons: Left1 left centre, Left2 right centre, Right1 left rim, Right2 right rim */
const K1 = 1;
const K2 = 4;
const M1 = 2;
/** frames from [time, buttons] pairs */
const frames = (...f: [number, number][]) => f.flatMap(([t, b]) => [t, 0, 0, b]);

/** a chart from [time, kind, end, flags, extra] objects */
function chart(objects: number[][], ticks: number[] = [], spacing?: number[]): TaikoChartData {
  return { objects: objects.flat(), ticks, spacing, scroll: [0, 1], bars: [], presses: [] };
}
const results = (r: TaikoReplay) => r.judgements.map((j) => RESULTS[j.result]);

describe("osu!taiko hit windows", () => {
  it("follows lazer's ranges", () => {
    expect(taikoWindows(5)).toEqual([34.5, 79.5, 94.5]);
    expect(taikoWindows(10)).toEqual([19.5, 49.5, 69.5]);
    expect(taikoOd(5, ["HR"])).toBe(7);
    expect(taikoOd(9, ["HR"])).toBe(10);
    expect(taikoOd(6, ["EZ"])).toBe(3);
  });
});

describe("judging", () => {
  it("judges notes by distance and colour, and misses the ones left alone", () => {
    // centres at 1000 (10 late), 2000 (60 early), 3000 (left alone), a rim at 4000 hit with a centre
    const c = chart([
      [1000, 0, 1000, 0, 0],
      [2000, 0, 2000, 0, 0],
      [3000, 0, 3000, 0, 0],
      [4000, 1, 4000, 0, 0],
    ]);
    const r = new TaikoReplay(c, frames([1010, K1], [1050, 0], [1940, K2], [1980, 0], [4005, K1], [4050, 0]), 5, []);
    expect(results(r)).toEqual(["great", "ok", "miss", "miss"]);
    expect(r.hitAt[0]).toBe(1010);
    expect(r.missAt[2]).toBe(3000 + 79.5);
    expect(r.stats(5000).accuracy).toBeCloseTo((300 + 150) / (4 * 300));
  });

  it("an early press past Ok misses; one past the miss window does nothing", () => {
    const c = chart([[1000, 0, 1000, 0, 0]]);
    expect(results(new TaikoReplay(c, frames([910, K1], [950, 0]), 5, []))).toEqual(["miss"]);
    const r = new TaikoReplay(c, frames([890, K1], [895, 0], [1000, K2], [1050, 0]), 5, []);
    expect(results(r)).toEqual(["great"]);
  });

  it("two keys in one frame judge one note", () => {
    const c = chart([
      [1000, 0, 1000, 0, 0],
      [1060, 0, 1060, 0, 0],
    ]);
    // both centres at 1000: the second doesn't reach the note at 1060
    const r = new TaikoReplay(c, frames([1000, K1 | K2], [1030, 0], [1060, K1], [1090, 0]), 5, []);
    expect(results(r)).toEqual(["great", "great"]);
    expect(r.hitAt[1]).toBe(1060);
  });

  it("strong notes: the second key of the colour within 30 ms, while the first is down", () => {
    const c = chart([
      [1000, 0, 1000, 1, 0],
      [2000, 0, 2000, 1, 0],
      [3000, 0, 3000, 1, 0],
    ]);
    const r = new TaikoReplay(
      c,
      frames(
        [1000, K1], [1025, K1 | K2], [1060, 0],
        // too late
        [2000, K1], [2040, K1 | K2], [2080, 0],
        // the first key let go
        [3000, K1], [3010, 0], [3020, K2], [3060, 0],
      ),
      5,
      [],
    );
    expect(results(r)).toEqual(["great", "great", "great"]);
    expect(r.strongAt[0]).toBe(1025);
    expect(Number.isNaN(r.strongAt[1])).toBe(true);
    expect(Number.isNaN(r.strongAt[2])).toBe(true);
    expect(r.largeBonus).toBe(1);
  });

  it("drum rolls: a tick per press within half the spacing", () => {
    // ticks at 1000, 1100, 1200 (spacing 100)
    const c = chart([[1000, 2, 1200, 0, 0]], [1000, 1100, 1200], [100]);
    const r = new TaikoReplay(c, frames([1000, K1], [1010, 0], [1130, M1], [1140, 0]), 5, []);
    expect(r.tickAt[0]).toBe(1000);
    expect(r.tickAt[1]).toBe(1130);
    expect(r.tickRim[1]).toBe(1);
    expect(Number.isNaN(r.tickAt[2])).toBe(true);
    expect(r.tickMissAt[2]).toBe(1250);
    expect(r.smallBonus).toBe(2);
    // rolls aren't notes
    expect(r.judgements).toEqual([]);
  });

  it("swells count presses alternating centre and rim, from their start", () => {
    // 3 hits needed between 1000 and 2000
    const c = chart([[1000, 3, 2000, 0, 3]]);
    const alternating = new TaikoReplay(c, frames([900, K1], [950, 0], [1100, K1], [1150, 0], [1200, K1], [1250, 0], [1300, M1], [1350, 0], [1400, K1], [1450, 0]), 5, []);
    expect(alternating.swellPressTimes(0)).toEqual([1100, 1300, 1400]);
    expect(alternating.cleared[0]).toBe(1);
    expect(alternating.swellAt[0]).toBe(1400);
    const short = new TaikoReplay(c, frames([1100, K1], [1150, 0], [1200, K1], [1250, 0]), 5, []);
    expect(short.cleared[0]).toBe(0);
    expect(short.swellAt[0]).toBe(2000);
    // Relax: no alternating needed
    const relax = new TaikoReplay(c, frames([1100, K1], [1150, 0], [1200, K1], [1250, 0], [1300, K1], [1350, 0]), 5, ["RX"]);
    expect(relax.cleared[0]).toBe(1);
  });
});
