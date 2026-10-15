import { describe, expect, it } from "vitest";
import { OsuChart } from "../ui/osu/chart";
import { OsuReplay, osuOd, osuWindows } from "./osu-replay";
import { RESULTS } from "./replay";
import type { OsuSliderData } from "./types";

/** legacy buttons: M1 / K1 left (1 / 5), M2 / K2 right (2 / 10) */
const L = 1;
const R = 2;
/** frames from [time, x, y, buttons] */
const frames = (...f: [number, number, number, number][]) => f.flat();

/** a chart (circle size 1, preempt 600) from [time, kind, end, x, y, a, b] objects */
function chart(objects: number[][], sliders: OsuSliderData[] = []): OsuChart {
  const flat = objects.flatMap(([time, kind, end, x, y, a = 0, b = 0]) => [time, kind, end, x, y, 0, 1, 0, a, b]);
  return new OsuChart({ osu: { scale: 1, preempt: 600, fadeIn: 400, objects: flat, sliders, frames: [], colours: [] } } as never);
}
const results = (r: OsuReplay) => r.judgements.map((j) => RESULTS[j.result]);

describe("osu! hit windows", () => {
  it("follows lazer's ranges", () => {
    expect(osuWindows(5)).toEqual([49.5, 99.5, 149.5]);
    expect(osuWindows(10)).toEqual([19.5, 59.5, 99.5]);
    expect(osuOd(5, ["HR"])).toBe(7);
    expect(osuOd(8, ["HR"])).toBe(10);
    expect(osuOd(4, ["EZ"])).toBe(2);
  });
});

describe("circles", () => {
  it("judges a press under the cursor by how far off it is, and misses circles left alone", () => {
    const c = chart([
      [1000, 0, 1000, 100, 100],
      [2000, 0, 2000, 300, 100],
      [3000, 0, 3000, 100, 300],
    ]);
    const r = new OsuReplay(
      c,
      // 10 ms late; 80 ms early; a press away from the third circle
      frames([1010, 110, 100, L], [1050, 110, 100, 0], [1920, 300, 130, R], [1960, 300, 130, 0], [3000, 300, 300, L], [3040, 300, 300, 0]),
      5,
      1,
    );
    expect(results(r)).toEqual(["great", "ok", "miss"]);
    expect(r.hitAt[0]).toBe(1010);
    expect(r.offset[1]).toBe(-80);
    expect(r.missAt[2]).toBe(3000 + 149.5);
    expect(r.stats(4000).accuracy).toBeCloseTo((300 + 100) / 900);
  });

  it("a press up to 400 ms early misses; one earlier does nothing", () => {
    const c = chart([[1000, 0, 1000, 100, 100]]);
    expect(results(new OsuReplay(c, frames([700, 100, 100, L], [720, 100, 100, 0]), 5, 1))).toEqual(["miss"]);
    const r = new OsuReplay(c, frames([500, 100, 100, L], [520, 100, 100, 0], [1000, 100, 100, R], [1020, 100, 100, 0]), 5, 1);
    expect(results(r)).toEqual(["great"]);
  });

  it("note lock: a later circle can't be hit before an earlier one's time; hitting it misses the earlier one", () => {
    const c = chart([
      [1000, 0, 1000, 100, 100],
      [1100, 0, 1100, 300, 100],
    ]);
    // the second circle at 950 (locked, nothing happens), then at 1090
    const r = new OsuReplay(c, frames([950, 300, 100, L], [960, 300, 100, 0], [1090, 300, 100, L], [1100, 300, 100, 0]), 5, 1);
    expect(r.result[0]).toBe(5);
    expect(r.missAt[0]).toBe(1090);
    expect(r.hitAt[1]).toBe(1090);
    expect(RESULTS[r.result[1]]).toBe("great");
  });
});

describe("sliders", () => {
  // from (100, 100) to (300, 100) over 1000 ms, a tick halfway
  const slider: OsuSliderData = { path: [100, 100, 300, 100], spans: 1, spanDuration: 1000, ticks: [1500, 0.5] };
  const c = () => chart([[1000, 1, 2000, 100, 100, 0]], [slider]);
  /** the cursor on the ball from 1000 to 2000, with these buttons */
  const along = (buttons: (t: number) => number) => {
    const f: [number, number, number, number][] = [];
    for (let t = 1000; t <= 2000; t += 50) f.push([t, 100 + (t - 1000) / 5, 100, buttons(t)]);
    f.push([2100, 300, 100, 0]);
    return frames(...f);
  };

  it("followed from the head to the end: the tick and the end are hit", () => {
    const r = new OsuReplay(c(), along(() => L), 5, 1);
    expect(results(r)).toEqual(["great"]);
    expect(r.nested.get(0)!.map((x) => x.hit)).toEqual([true, true]);
    expect(r.largeTickHit).toBe(1);
    expect(r.sliderTailHit).toBe(1);
    expect(r.following(0, 1500)).toBe(true);
    expect(r.stats(3000).accuracy).toBe(1);
  });

  it("only the head's key follows while the other one was down when it was hit", () => {
    // right down first (away from the head), the head hit with left, left let go at 1300: not followed any more
    const r = new OsuReplay(c(), frames([900, 400, 300, R], ...[...Array(21)].map((_, k): [number, number, number, number] => [1000 + k * 50, 100 + k * 10, 100, 1000 + k * 50 < 1300 ? L | R : R]), [2100, 300, 100, 0]), 5, 1);
    expect(results(r)).toEqual(["great"]);
    expect(r.following(0, 1200)).toBe(true);
    expect(r.following(0, 1400)).toBe(false);
    expect(r.nested.get(0)!.map((x) => x.hit)).toEqual([false, false]);
    expect(r.largeTickMiss).toBe(1);
  });
});

describe("spinners", () => {
  // 1000–3000 in the middle, 2 spins needed, up to 3 bonus spins
  const c = () => chart([[1000, 2, 3000, 256, 192, 2, 3]]);
  const circling = (buttons: number) => {
    const f: [number, number, number, number][] = [];
    for (let k = 0; k < 200; k++) {
      const a = (k * 12 * Math.PI) / 180;
      f.push([1000 + k * 10, 256 + 50 * Math.cos(a), 192 + 50 * Math.sin(a), buttons]);
    }
    return frames(...f);
  };

  it("counts the turns while a button is down: spins, then bonus spins", () => {
    const r = new OsuReplay(c(), circling(L), 5, 1);
    expect(results(r)).toEqual(["great"]);
    expect(r.spinTotal[0] / 360).toBeCloseTo((199 * 12) / 360);
    // the spins needed and two more are small bonus, the rest large
    expect(r.smallBonus).toBe(4);
    expect(r.largeBonus).toBe(2);
  });

  it("turning without a button counts nothing", () => {
    const r = new OsuReplay(c(), circling(0), 5, 1);
    expect(results(r)).toEqual(["miss"]);
    expect(r.smallBonus).toBe(0);
  });

  it("faster rates turn more", () => {
    const r = new OsuReplay(c(), circling(L), 5, 1.5);
    expect(r.spinTotal[0] / 360).toBeCloseTo((199 * 12 * 1.5) / 360);
  });
});
