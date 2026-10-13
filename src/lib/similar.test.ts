import { describe, expect, it } from "vitest";
import { differences, likeness, mainPattern, print, similarTo } from "./similar";
import type { MapRow } from "./types";

// shares: stream, jumpstream, handstream, chordjack, jacks, ln
const mania = (id: string, set: number, sr: number, shares: number[] | undefined, extra: Partial<MapRow> = {}): MapRow => ({
  set, id, version: id, mode: 3, status: 1, sr, bpm: 180, length: 120_000, objects: 1200, holds: 0,
  hp: 8, cs: 4, od: 8, ar: 0, shares, ...extra,
});
const osu = (id: string, set: number, sr: number, extra: Partial<MapRow> = {}): MapRow => ({
  set, id, version: id, mode: 0, status: 1, sr, bpm: 200, length: 180_000, objects: 900, holds: 300,
  hp: 5, cs: 4, od: 9, ar: 9.3, ...extra,
});

const JS = [10, 60, 10, 5, 5, 0];

describe("likeness", () => {
  it("is 1 for the same fingerprint and falls with each difference", () => {
    const a = mania("a", 0, 4, JS);
    expect(likeness(print(a), print({ ...a, id: "b" })).score).toBe(1);
    const harder = likeness(print(a), print(mania("b", 1, 4.4, JS)));
    // 0.4★ is one unit, weighted 1.5 of the parts' weights
    expect(harder.diffs.sr).toBeCloseTo(1);
    expect(harder.score).toBeLessThan(1);
    expect(harder.score).toBeGreaterThan(likeness(print(a), print(mania("c", 1, 4.8, JS))).score);
  });
  it("reads the pattern mix as how much of it moved", () => {
    const a = mania("a", 0, 4, JS);
    const jacky = mania("b", 1, 4, [10, 30, 10, 5, 35, 0]);
    expect(likeness(print(a), print(jacky)).diffs.patterns).toBeCloseTo(1);
  });
  it("leaves out what the chart asked about doesn't know, and counts it against a candidate that doesn't", () => {
    const unanalysed = mania("a", 0, 4, undefined);
    expect(likeness(print(unanalysed), print(mania("b", 1, 4, JS))).score).toBe(1);
    const l = likeness(print(mania("a", 0, 4, JS)), print(mania("b", 1, 4, undefined)));
    expect(l.diffs.patterns).toBeUndefined();
    expect(l.score).toBeLessThan(1);
  });
});

describe("similarTo", () => {
  const target = mania("t", 0, 4, JS);
  const lib = [
    target,
    mania("same-set", 0, 4, JS),
    mania("close", 1, 4.1, JS),
    mania("jacks", 2, 4.05, [5, 10, 5, 20, 60, 0]),
    mania("7k", 3, 4, JS, { cs: 7 }),
    mania("far", 4, 7, JS),
    mania("hidden", 5, 4, JS, { hidden: true }),
    osu("osu", 6, 4),
  ];
  it("ranks the same ruleset and key count, closest first, without the chart's set", () => {
    const ids = similarTo(target, lib, { excludeSet: 0 }).map((s) => lib[s.mapIdx].id);
    expect(ids).toEqual(["close", "jacks"]);
  });
  it("keeps a difficulty that's in the library twice once", () => {
    const twice = [target, mania("lazer", 1, 4.1, JS, { onlineId: 7 }), mania("stable", 2, 4.1, JS, { onlineId: 7 }), mania("own", 3, 4, JS, { onlineId: 1 })];
    const ids = similarTo({ ...target, onlineId: 1 }, twice).map((s) => twice[s.mapIdx].id);
    expect(ids).toEqual(["lazer"]);
  });
  it("takes what else makes two difficulties the same chart", () => {
    const again = [target, mania("Insane", 1, 4.1, JS), mania("Insane", 2, 4.12, JS), mania("Hard", 3, 4.2, JS)];
    const ids = similarTo({ ...target, version: "Hard" }, again, { same: (m) => m.version }).map((s) => again[s.mapIdx].set);
    expect(ids).toEqual([1]);
  });
  it("stops at the limit", () => {
    const many = [target, ...Array.from({ length: 30 }, (_, i) => mania(`m${i}`, i + 1, 4 + i * 0.01, JS))];
    expect(similarTo(target, many, { limit: 5 })).toHaveLength(5);
  });
  it("weighs what matters in osu!: AR and BPM", () => {
    const t = osu("t", 0, 5);
    const maps = [t, osu("slow", 1, 5, { bpm: 150 }), osu("lowar", 2, 5, { ar: 8 }), osu("same", 3, 5.1)];
    expect(similarTo(t, maps).map((s) => maps[s.mapIdx].id)).toEqual(["same", "lowar", "slow"]);
  });
});

describe("differences", () => {
  it("says what sets a chart apart, the biggest first", () => {
    const a = mania("a", 0, 4, JS);
    const b = mania("b", 1, 4.6, [5, 15, 5, 5, 70, 0], { length: 240_000, objects: 2400 });
    expect(differences(a, b, likeness(print(a), print(b)))).toEqual(["more jacks", "harder"]);
    const c = mania("c", 1, 4.05, JS);
    expect(differences(a, c, likeness(print(a), print(c)))).toEqual([]);
  });
  it("speaks each ruleset's terms", () => {
    const a = osu("a", 0, 5);
    const b = osu("b", 1, 5, { ar: 8, cs: 5 });
    expect(differences(a, b, likeness(print(a), print(b)))).toEqual(["lower AR", "smaller circles"]);
  });
});

describe("mainPattern", () => {
  it("names the chart's biggest pattern", () => {
    expect(mainPattern(mania("a", 0, 4, JS))).toBe("60% jumpstream");
    expect(mainPattern(mania("a", 0, 4, undefined))).toBe("");
  });
});
