import { describe, expect, it } from "vitest";
import type { ChartData } from "../lib/types";
import { breakPeriods, Combo, comboScale, FlashlightSize, inPeriod } from "./flashlight";

const chart = (breaks: number[]): ChartData => ({ breaks } as unknown as ChartData);

describe("flashlight", () => {
  // 300 judgements, 10 ms apart from 3 s: the 100th at 3990, the 200th at 4990, the last at 5990
  const combo = new Combo(Array.from({ length: 300 }, (_, i) => 3000 + i * 10));

  it("counts the combo", () => {
    expect(combo.at(2999)).toBe(0);
    expect(combo.at(3000)).toBe(1);
    expect(combo.at(3990)).toBe(100);
    expect(combo.at(1e9)).toBe(300);
  });

  it("knows break time like lazer's BreakTracker", () => {
    // a 2 s break counts (ending 325 ms early), a 500 ms one doesn't
    const periods = breakPeriods(chart([4000, 6000, 7000, 7500]), combo);
    expect(periods).toEqual([
      [-Infinity, 1000],
      [4000, 5675],
      [5990, Infinity],
    ]);
    expect(inPeriod(periods, 999)).toBe(true);
    expect(inPeriod(periods, 1000)).toBe(false);
    expect(inPeriod(periods, 5000)).toBe(true);
    expect(inPeriod(periods, 7200)).toBe(true);
  });

  it("shrinks with the combo and grows in breaks, at osu!stable's speed", () => {
    const size = new FlashlightSize({ size: 100, breakScale: 2, comboScale, speed: 1 / 1000 }, combo, breakPeriods(chart([]), combo));
    // big before gameplay starts, then down (325 ms after break time ends) by a whole size a second
    expect(size.at(0)).toBe(200);
    expect(size.at(1325)).toBe(200);
    expect(size.at(1825)).toBeCloseTo(150, 6);
    expect(size.at(2400)).toBe(100);
    // 100 combo: 0.8125 in 187.5 ms; 200: 0.625
    expect(size.at(3990 + 93.75)).toBeCloseTo(90.625, 6);
    expect(size.at(4500)).toBeCloseTo(81.25, 6);
    expect(size.at(5500)).toBeCloseTo(62.5, 6);
    // all judged: break time, up to 200 over 1375 ms
    expect(size.at(5990 + 687.5)).toBeCloseTo(131.25, 6);
    expect(size.at(9000)).toBe(200);
  });

  it("takes a fixed time where it isn't by combo (osu!mania)", () => {
    const size = new FlashlightSize({ size: 50, breakScale: 2.5 }, combo, breakPeriods(chart([]), combo));
    expect(size.at(1325 + 400)).toBeCloseTo(50 + 75 / 2, 6);
    expect(size.at(4500)).toBe(50);
  });
});
