import { describe, expect, it } from "vitest";
import { activeMods, adjustDifficulty, chartMods, chartModsKey, modsFor, starsKnown, toggleMod } from "./mods";

describe("mods", () => {
  it("has each ruleset's own", () => {
    expect(modsFor(0)).toEqual(["EZ", "HR", "HD", "FL", "MR"]);
    expect(modsFor(1)).not.toContain("MR");
    expect(modsFor(3)).toContain("FI");
    expect(modsFor(-1)).toEqual([]);
  });

  it("keeps the ones a ruleset takes, the first of two that clash", () => {
    // picked in osu!catch, where Hard Rock and Mirror go together; osu! takes only Hard Rock
    expect(activeMods(["HR", "MR"], 2)).toEqual(["HR", "MR"]);
    expect(activeMods(["HR", "MR"], 0)).toEqual(["HR"]);
    expect(activeMods(["MR", "FI"], 1)).toEqual([]);
    expect(activeMods(["FL", "HD"], 3)).toEqual(["HD"]);
    expect(activeMods(["FL", "HD"], 0)).toEqual(["HD", "FL"]);
  });

  it("turns off what doesn't go with a new one", () => {
    expect(toggleMod(["HR", "HD"], "EZ", 0)).toEqual(["EZ", "HD"]);
    expect(toggleMod(["HR"], "MR", 0)).toEqual(["MR"]);
    expect(toggleMod(["HR"], "MR", 2)).toEqual(["HR", "MR"]);
    expect(toggleMod(["HD"], "FI", 3)).toEqual(["FI"]);
    expect(toggleMod(["FI", "MR"], "FL", 3)).toEqual(["FL", "MR"]);
    expect(toggleMod(["HD", "FL"], "HD", 0)).toEqual(["FL"]);
  });

  it("sends only the ones that change the chart", () => {
    expect(chartMods(["HR", "HD", "MR"], 3)).toEqual({ easy: false, hardRock: false, mirror: true });
    expect(chartMods(["EZ", "MR"], 1)).toEqual({ easy: true, hardRock: false, mirror: false });
    expect(chartMods(["HR", "MR"], 0)).toEqual({ easy: false, hardRock: true, mirror: false });
    expect(chartModsKey(chartMods(["HD", "FL"], 0))).toBe("");
    expect(chartModsKey(chartMods(["EZ", "MR"], 2))).toBe("EZMR");
  });

  it("knows a star rating only where it holds", () => {
    expect(starsKnown(["HR", "HD"], 3)).toBe(true);
    expect(starsKnown(["MR"], 0)).toBe(true);
    expect(starsKnown(["HD"], 0)).toBe(false);
    expect(starsKnown([], 1)).toBe(true);
  });

  it("adjusts a difficulty like lazer's song select", () => {
    const base = { cs: 4, ar: 9, od: 8, hp: 6 };
    const hr = adjustDifficulty(base, ["HR"], 0);
    expect(hr.cs).toBeCloseTo(5.2, 5);
    expect(hr.ar).toBe(10);
    expect(hr.od).toBe(10);
    expect(hr.hp).toBeCloseTo(8.4, 5);
    expect(adjustDifficulty(base, ["EZ"], 2)).toEqual({ cs: 2, ar: 4.5, od: 4, hp: 3 });
    // osu!mania: Hard Rock changes the hit windows, not OD
    expect(adjustDifficulty(base, ["HR"], 3)).toEqual({ ...base, hp: adjustDifficulty(base, ["HR"], 0).hp });
    // Double Time: AR from the approach time, OD from the great window
    const dt = adjustDifficulty(base, [], 0, 1.5);
    expect(dt.ar).toBeCloseTo(10.333, 3);
    expect(dt.od).toBeCloseTo(9.778, 3);
    expect(adjustDifficulty(base, [], 2, 0.75).ar).toBeCloseTo(7.667, 3);
    expect(adjustDifficulty(base, [], 1, 1.5).od).toBeCloseTo(10.889, 3);
    expect(adjustDifficulty(base, [], 0, 1)).toEqual(base);
  });
});
