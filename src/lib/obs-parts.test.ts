import { describe, expect, it } from "vitest";
import type { Attempt } from "./attempts";
import { better, sessionStartOf, triesPart } from "./obs-parts";

const MD5 = "174589aaaaaaaaaaaaaaaaaaaaaaaaaa";
const MIN = 60_000;

let at = 1_000_000;
/** a try at MD5 (first note at 0, last at 100 s), a minute after the one before */
function attempt(p: Partial<Attempt>): Attempt {
  at += MIN;
  return {
    md5: MD5,
    mode: 3,
    client: "lazer",
    started: at,
    ended: at + 30_000,
    outcome: "fail",
    reached: 0,
    failedAt: null,
    firstObject: 0,
    lastObject: 100_000,
    accuracy: 0.95,
    score: 500_000,
    maxCombo: 100,
    misses: 5,
    missesAt: [],
    mods: "",
    rate: 1,
    pp: null,
    scoreId: null,
    rank: null,
    ...p,
  };
}

describe("tries at a map", () => {
  const tries = [
    attempt({ outcome: "fail", reached: 30_000, failedAt: 30_000, missesAt: [28_500, 29_400] }),
    attempt({ outcome: "quit", reached: 10_000 }),
    attempt({ outcome: "fail", reached: 31_000, failedAt: 31_000, missesAt: [29_800, 30_600] }),
    attempt({ outcome: "pass", reached: 100_000, accuracy: 0.97, score: 800_000, pp: 210, rank: "S", misses: 2 }),
    attempt({ outcome: "pass", reached: 100_000, accuracy: 0.96, score: 790_000, pp: 205, rank: "A", misses: 4 }),
    attempt({ outcome: "fail", reached: 50_000, failedAt: 50_000 }),
  ];

  it("counts them, in any order", () => {
    const part = triesPart(MD5, [...tries].reverse());
    expect(part).toMatchObject({ md5: MD5, count: 6, passes: 2, fails: 3, left: 1, furthest: 1, sincePass: 1 });
    // where the ones that didn't pass ended, oldest first
    expect(part.ends).toEqual([0.3, 0.1, 0.31, 0.5]);
  });

  it("finds the part most tries ended at", () => {
    expect(triesPart(MD5, tries).spot).toEqual({ a: 26_000, b: 32_000, stops: 2 });
  });

  it("keeps the best pass", () => {
    expect(triesPart(MD5, tries).best).toEqual({ accuracy: 0.97, rank: "S", pp: 210, score: 800_000 });
    expect(triesPart(MD5, tries.slice(0, 3)).best).toBeNull();
  });

  it("weighs pp first, then score", () => {
    expect(better({ pp: 200, score: 1 }, { pp: 190, score: 999 })).toBe(true);
    expect(better({ pp: null, score: 2 }, { pp: 300, score: 1 })).toBe(true);
    expect(better({ pp: 200, score: 1 }, { pp: 200, score: 2 })).toBe(false);
  });
});

describe("the session", () => {
  const now = 10_000 * MIN;
  const tryAt = (min: number) => ({ started: now - min * MIN, ended: now - min * MIN + 2 * MIN });

  it("starts now after an hour without a try", () => {
    expect(sessionStartOf([], now)).toBe(now);
    expect(sessionStartOf([tryAt(63)], now)).toBe(now);
  });

  it("reaches back to the last hour-long pause", () => {
    // pauses of 48 minutes keep it going, 98 minutes end the one before
    const tries = [300, 200, 150, 100, 50, 5].map(tryAt);
    expect(sessionStartOf(tries, now)).toBe(now - 200 * MIN);
    expect(sessionStartOf([...tries].reverse(), now)).toBe(now - 200 * MIN);
  });

  it("starts no earlier than New session", () => {
    const tries = [100, 50, 5].map(tryAt);
    expect(sessionStartOf(tries, now, now - 60 * MIN)).toBe(now - 60 * MIN);
    expect(sessionStartOf(tries, now, now - 500 * MIN)).toBe(now - 100 * MIN);
  });
});
