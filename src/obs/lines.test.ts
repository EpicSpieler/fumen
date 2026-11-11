import { describe, expect, it } from "vitest";
import type { ObsTries } from "../lib/obs-parts";
import { endWords, newBest, type EndInput } from "./lines";

const tries = (o: Partial<ObsTries> = {}): ObsTries => ({
  md5: "a",
  count: 6,
  passes: 0,
  fails: 5,
  left: 1,
  ends: [0.3, 0.31, 0.3],
  furthest: 0.62,
  spot: { a: 40_000, b: 48_000, stops: 4 },
  sincePass: 6,
  best: null,
  ...o,
});

const end = (o: Partial<EndInput>): EndInput => ({ tries: tries(), best: null, at: 20_000, kind: "pass", score: 900_000, pp: 210, ...o });

describe("endWords", () => {
  it("a fail where the others ended says how often now; elsewhere nothing more", () => {
    expect(endWords(end({ kind: "fail", at: 41_000 }))).toEqual({ left: { text: "Ended here 5 times now", icon: "flag", tone: "danger" }, right: null });
    expect(endWords(end({ kind: "fail", at: 20_000 }))).toEqual({ left: null, right: null });
  });

  it("a first pass after tries, or a first pass at all", () => {
    expect(endWords(end({})).left).toMatchObject({ text: "First pass after 7 tries", tone: "accent" });
    expect(endWords(end({ tries: null })).left).toMatchObject({ text: "First pass" });
  });

  it("a new best with what it gained, or the best that stays", () => {
    const passed = tries({ passes: 2 });
    const was = { accuracy: 0.95, rank: "A", pp: 196.4, score: 800_000 };
    expect(endWords(end({ tries: passed, best: was }))).toEqual({ left: null, right: { text: "New best, +14 pp", icon: "star", tone: "accent" } });
    expect(endWords(end({ tries: passed, best: { ...was, pp: null } })).right?.text).toBe("New best");
    expect(endWords(end({ tries: passed, best: { accuracy: 0.991, rank: "S", pp: 230, score: 990_000 } })).right).toMatchObject({ text: "Your best stays 99.10%", tone: "plain" });
  });
});

describe("newBest", () => {
  it("goes by pp when both have them, by score otherwise", () => {
    expect(newBest({ score: 1, pp: 200 }, { accuracy: 1, rank: null, pp: 190, score: 5 })).toBe(true);
    expect(newBest({ score: 9, pp: 200.2 }, { accuracy: 1, rank: null, pp: 200, score: 5 })).toBe(true);
    expect(newBest({ score: 9, pp: null }, { accuracy: 1, rank: null, pp: 200, score: 10 })).toBe(false);
  });
});
