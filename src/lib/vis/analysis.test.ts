import { describe, expect, it, vi } from "vitest";

vi.mock("../eq", () => ({ analysers: () => null }));
const { BANDS, bandPos, Levels, Onset, readBand, resample } = await import("./analysis");

const flat = (db: number) => new Float32Array(BANDS).fill(db);

describe("Levels", () => {
  it("follows the song's loudness, so loud and quiet songs look alike", () => {
    const loud = new Levels();
    const quiet = new Levels();
    for (let i = 0; i < 120; i++) {
      loud.update(flat(-10), 1 / 60, 0.5, 1);
      quiet.update(flat(-50), 1 / 60, 0.5, 1);
    }
    expect(loud.shown[10]).toBeCloseTo(quiet.shown[10], 2);
    expect(loud.shown[10]).toBeGreaterThan(0.3);
  });
  it("leaves room above a steady sound for what jumps out of it", () => {
    const l = new Levels();
    for (let i = 0; i < 120; i++) l.update(flat(-20), 1 / 60, 0.5, 1);
    const steady = l.shown[10];
    expect(steady).toBeLessThan(0.6);
    const hit = flat(-20);
    hit[10] = -8;
    for (let i = 0; i < 3; i++) l.update(hit, 1 / 60, 0.5, 1);
    expect(l.shown[10]).toBeGreaterThan(steady + 0.3);
  });
  it("shows a band that drops below the rest lower", () => {
    const l = new Levels();
    const db = flat(-20);
    db[5] = -40;
    for (let i = 0; i < 60; i++) l.update(db, 1 / 60, 0.5, 1);
    expect(l.shown[5]).toBeLessThan(l.shown[6]);
    expect(l.shown[5]).toBeGreaterThan(0);
  });
  it("falls faster with a fast reaction", () => {
    const fast = new Levels();
    const smooth = new Levels();
    for (let i = 0; i < 30; i++) {
      fast.update(flat(-20), 1 / 60, 0.5, 1);
      smooth.update(flat(-20), 1 / 60, 0.5, 0);
    }
    for (let i = 0; i < 6; i++) {
      fast.update(null, 1 / 60, 0.5, 1);
      smooth.update(null, 1 / 60, 0.5, 0);
    }
    expect(fast.shown[0]).toBeLessThan(smooth.shown[0]);
  });
});

describe("Onset", () => {
  it("fires on a jump and not on a steady level", () => {
    const o = new Onset(1.6, 0.1);
    let hits = 0;
    let t = 0;
    for (let i = 0; i < 120; i++, t += 1 / 60) if (o.feed(1, t, 1 / 60)) hits++;
    const steady = hits;
    for (let i = 0; i < 120; i++, t += 1 / 60) if (o.feed(i % 30 === 0 ? 5 : 1, t, 1 / 60)) hits++;
    expect(steady).toBeLessThanOrEqual(1);
    expect(hits - steady).toBe(4);
  });
});

describe("bands", () => {
  it("reads a band between bins when it's narrower than one", () => {
    expect(readBand([-60, -40, -20], 10, 14, 16)).toBeCloseTo(-30);
    expect(readBand([-60, -40, -20, -80], 10, 5, 30)).toBe(-20);
  });
  it("resamples by the loudest merged value", () => {
    expect([...resample(new Float32Array([0.1, 0.9, 0.2, 0.4]), 2)].map((v) => +v.toFixed(2))).toEqual([0.9, 0.4]);
    expect(resample(new Float32Array([0, 1]), 4).length).toBe(4);
  });
  it("spans 30 Hz to 16 kHz", () => {
    expect(bandPos(30)).toBeCloseTo(0);
    expect(bandPos(16000)).toBeCloseTo(1);
  });
});
