import { describe, expect, it } from "vitest";
import { beatAt, inKiai } from "./beat";

// 120 BPM in 4/4 from 1000 ms, then 3/4 at 200 BPM from 9000 ms
const BEATS = [1000, 500, 4, 9000, 300, 3];

describe("beatAt", () => {
  it("places a moment in its beat and bar", () => {
    const b = beatAt(BEATS, 2250)!;
    expect(b.phase).toBeCloseTo(0.5);
    expect(b.inBar).toBe(2);
    expect(b.bpm).toBeCloseTo(120);
  });
  it("starts a new bar at every timing point, with its meter", () => {
    const b = beatAt(BEATS, 9000 + 300 * 4 + 30)!;
    expect(b.inBar).toBe(1);
    expect(b.meter).toBe(3);
    expect(b.bpm).toBeCloseTo(200);
    expect(b.phase).toBeCloseTo(0.1);
  });
  it("counts backwards before the first point", () => {
    const b = beatAt(BEATS, 900)!;
    expect(b.inBar).toBe(3);
    expect(b.phase).toBeCloseTo(0.8);
  });
  it("gives every beat its own key", () => {
    const keys = new Set([0, 499, 500, 1500, 8999, 9000, 9299, 9300].map((t) => beatAt(BEATS, 1000 + t)!.key));
    expect(keys.size).toBe(5);
    expect(beatAt([], 0)).toBeNull();
    expect(beatAt([0, 0, 4], 0)).toBeNull();
  });
});

describe("inKiai", () => {
  it("is on from a section's start until its end", () => {
    const kiai = [1000, 2000, 5000, 6000];
    expect([999, 1000, 1999, 2000, 5500, 6000].map((t) => inKiai(kiai, t))).toEqual([false, true, true, false, true, false]);
    expect(inKiai([], 0)).toBe(false);
  });
});
