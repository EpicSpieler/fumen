import { describe, expect, it } from "vitest";
import { accFactor, bestPerChart, keyModes, playStars, skills, starsAt } from "./skills";
import type { MapRow, Play } from "./types";

const map = (id: string, sr: number, shares: number[] | undefined, extra: Partial<MapRow> = {}): MapRow => ({
  set: 0, id, version: id, mode: 3, status: 1, sr, bpm: 180, length: 120_000, objects: 1000, holds: 0,
  hp: 8, cs: 4, od: 8, ar: 0, shares, srHt: sr * 0.75, srDt: sr * 1.4, ...extra,
});

const play = (mapId: string, acc: number, extra: Partial<Play> = {}): Play => ({
  map: mapId, mode: 3, date: 1_000, rank: 4, acc, score: 900_000, combo: 500, source: "lazer", ...extra,
});

describe("starsAt", () => {
  const m = { sr: 4, srHt: 3, srDt: 5.6 };
  it("follows the rated points and the lines between them", () => {
    expect(starsAt(m, 1)).toBe(4);
    expect(starsAt(m, 0.75)).toBeCloseTo(3);
    expect(starsAt(m, 1.5)).toBeCloseTo(5.6);
    expect(starsAt(m, 0.9)).toBeCloseTo(3.6);
    expect(starsAt(m, 1.2)).toBeCloseTo(4.64);
    // beyond: the nearest segment, never below 0
    expect(starsAt(m, 0.5)).toBeCloseTo(2);
    expect(starsAt(m, 2)).toBeCloseTo(7.2);
    expect(starsAt({ sr: 4, srHt: 1 }, 0.5)).toBe(0);
  });
  it("scales with the rate when only 1× is known", () => {
    expect(starsAt({ sr: 4 }, 1.25)).toBe(5);
  });
});

describe("accFactor", () => {
  it("is 1 at 96% and follows osu!mania's pp curve", () => {
    expect(accFactor(0.96)).toBeCloseTo(1);
    expect(accFactor(0.92)).toBeCloseTo(0.877, 3);
    expect(accFactor(0.99)).toBeCloseTo(1.081, 3);
    expect(accFactor(1.2)).toBeCloseTo(accFactor(1));
    expect(accFactor(0.7)).toBe(0);
  });
});

describe("skills", () => {
  //            stream jump  hand chordjack jacks ln
  const maps = [
    map("js5", 5, [10, 70, 10, 0, 0, 0]),
    map("js4", 4, [20, 60, 0, 0, 20, 0]),
    map("jack4", 4, [0, 0, 0, 30, 70, 0]),
    map("ln3", 3, [0, 0, 0, 0, 0, 90]),
    map("seven", 6, [80, 0, 0, 0, 0, 0], { cs: 7 }),
    map("plain", 2, undefined),
    map("taiko", 5, undefined, { mode: 1 }),
  ];
  const ids = new Map(maps.map((m, i) => [m.id, i]));
  const index = (id: string | undefined) => (id === undefined ? undefined : ids.get(id));

  it("counts each chart's best pass in the key mode, without unrated mods", () => {
    const plays = [
      play("js5", 0.96),
      play("js5", 0.92),
      play("js4", 0.99, { rate: 1.5 }),
      play("jack4", 0.9, { failed: true, rank: -1 }),
      play("jack4", 0.96, { mods: ["HO"] }),
      play("jack4", 0.96, { mods: ["HD", "MR"], date: 5_000 }),
      play("ln3", 0.96),
      play("seven", 0.99),
      play("plain", 1),
      play("taiko", 1, { mode: 1 }),
      play("ln3", 1, { mode: 1 }),
    ];
    const charts = bestPerChart(plays, index, maps, 4);
    expect(charts.map((c) => c.map.id)).toEqual(["js4", "js5", "jack4", "ln3"]);
    expect(charts[0].stars).toBeCloseTo(4 * 1.4 * accFactor(0.99));
    expect(charts[1].stars).toBeCloseTo(5);
    // a point in time: only what was played by then
    expect(bestPerChart(plays, index, maps, 4, 1_000).map((c) => c.map.id)).not.toContain("jack4");

    const s = Object.fromEntries(skills(charts).map((k) => [k.pattern, k]));
    // jumpstream: js4 (5.98★, 60%) and js5 (5★, 70%)
    expect(s.jumpstream.value).toBeCloseTo((charts[0].stars * 60 + 5 * 70) / 130);
    expect(s.jumpstream.charts).toBe(2);
    expect(s.jumpstream.top.map((c) => c.share)).toEqual([60, 70]);
    // stream: js4 (20%) counts, js5 (10%) is below the 15% line
    expect(s.stream.charts).toBe(1);
    expect(s.jacks.top.map((c) => c.map.id)).toEqual(["js4", "jack4"]);
    expect(s.ln.value).toBeCloseTo(3);
    expect(s.handstream.value).toBeNull();
    expect(s.handstream.charts).toBe(0);
  });

  it("keeps the five best charts", () => {
    const many = Array.from({ length: 8 }, (_, i) => map(`s${i}`, 1 + i, [100, 0, 0, 0, 0, 0]));
    const idx = new Map(many.map((m, i) => [m.id, i]));
    const charts = bestPerChart(many.map((m) => play(m.id, 0.96)), (id) => idx.get(id!), many, 4);
    const [stream] = skills(charts);
    expect(stream.charts).toBe(8);
    expect(stream.top.length).toBe(5);
    expect(stream.value).toBeCloseTo((8 + 7 + 6 + 5 + 4) / 5);
  });

  it("doesn't drop from an easier chart once it has five", () => {
    const pool = [5, 4.5, 4.2, 4, 3.8, 2, 6].map((sr, i) => map(`j${i}`, sr, [0, 0, 0, 0, 40 + i * 5, 0]));
    const idx = new Map(pool.map((m, i) => [m.id, i]));
    const jacks = (n: number) => skills(bestPerChart(pool.slice(0, n).map((m) => play(m.id, 0.96)), (id) => idx.get(id!), pool, 4))[4];
    // a guess still moves either way …
    expect(jacks(4).charts).toBe(4);
    expect(jacks(5).value!).toBeLessThan(jacks(4).value!);
    // … five charts on, an easier one changes nothing and a harder one lifts it
    expect(jacks(6).value).toBeCloseTo(jacks(5).value!);
    expect(jacks(7).value!).toBeGreaterThan(jacks(6).value!);
  });

  it("lists key modes by plays", () => {
    const plays = [play("js5", 1), play("js4", 1), play("seven", 1), play("plain", 1), play("taiko", 1, { mode: 1 })];
    expect(keyModes(plays, index, maps)).toEqual([
      { keys: 4, plays: 2 },
      { keys: 7, plays: 1 },
    ]);
  });

  it("doesn't count converts or unrated plays", () => {
    expect(playStars(play("taiko", 1), maps[6])).toBeNull();
    expect(playStars(play("js5", 0.96, { mods: ["DA"] }), maps[0])).toBeNull();
    expect(playStars(play("js5", 0.96, { mods: ["DT"], rate: 1.5 }), maps[0])).toBeCloseTo(7);
    // a rate the library has no rating for: the one that came with the play
    expect(playStars(play("js5", 0.96, { mods: ["HT"], rate: 0.5, sr: 2.4 }), maps[0])).toBeCloseTo(2.4);
  });
});
