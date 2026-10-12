import { describe, expect, it } from "vitest";
import { buildIndex, DEFAULT_FILTER, filterLibrary, parseQuery, sortMaps, sortSets, type FilterState } from "./search";
import type { MapRow, SetRow, Snapshot } from "./types";

function map(set: number, over: Partial<MapRow>): MapRow {
  return {
    set, id: `m${Math.random()}`, version: "Normal", mode: 3, status: 1, sr: 3, bpm: 180, length: 120_000,
    objects: 1000, holds: 100, hp: 8, cs: 7, od: 8, ar: 5, ...over,
  };
}

function snapshot(): Snapshot {
  const sets: SetRow[] = [
    { id: "a", status: 1, title: "Galaxy Collapse", artist: "Kurokotei", creator: "Mismagius", tags: "dnb speedcore", added: 3_000, maps: [] },
    { id: "b", status: 4, title: "Koala", titleUnicode: "コアラ", artist: "Will Stetson", creator: "popy", added: 2_000, ranked: Date.UTC(2024, 7, 1), maps: [] },
    { id: "c", status: -3, title: "Local Song", artist: "Nobody", creator: "me", added: 1_000, from: "stable", maps: [] },
  ];
  const maps: MapRow[] = [
    map(0, { version: "Extreme", sr: 7.2, bpm: 230, cs: 4, length: 300_000, best: { rank: 3, acc: 0.95, score: 900_000, plays: 3 }, peak: 18.5, patterns: "jumpstream chordjack stamina", srHt: 5.4, srDt: 10.1, dan: "Gamma high", danValue: 13.38, category: "Jumpstream" }),
    map(0, { version: "Hard", sr: 4.1, bpm: 230, cs: 7, dan: "Regular 3 mid", category: "Dense Chordstream Tech" }),
    map(1, { version: "Easy", status: 4, sr: 1.4, bpm: 200, cs: 4, holds: 500, objects: 1000 }),
    map(1, { version: "LN Insane", status: 4, sr: 5.05, bpm: 200, cs: 4, holds: 800, objects: 1000, played: Date.now() - 2 * 86_400_000, peak: 9, patterns: "ln", srHt: 3.8, srDt: 7.3, dan: "Reform 4 low || LN 9 mid", category: "Column Lock" }),
    map(2, { version: "Taiko Oni", status: -3, mode: 1, sr: 5.5, bpm: 150, cs: 5 }),
  ];
  maps.forEach((m, i) => sets[m.set].maps.push(i));
  return { source: "lazer", sets, maps, collections: [], mania: {} };
}

const ix = buildIndex(snapshot());
const run = (f: Partial<FilterState>) => filterLibrary(ix, { ...DEFAULT_FILTER, ...f });
const versions = (f: Partial<FilterState>) =>
  run(f).sets.flatMap((r) => r.maps.map((mi) => ix.snap.maps[mi].version));

describe("parseQuery", () => {
  it("splits terms, phrases, exclusions and conditions", () => {
    const q = parseQuery('galaxy "big black" -taiko keys=7 sr>=4.5 creator="some mapper"');
    expect(q.terms).toEqual(["galaxy", "big black"]);
    expect(q.excluded).toEqual(["taiko"]);
    expect(q.conds.map((c) => c.key)).toEqual(["keys", "sr", "creator"]);
    expect(q.conds[2]).toMatchObject({ key: "creator", value: "some mapper" });
  });

  it("treats unknown keys as plain text", () => {
    const q = parseQuery("foo=bar");
    expect(q.conds).toHaveLength(0);
    expect(q.terms).toEqual(["foo=bar"]);
  });

  it("parses lengths in several forms", () => {
    const secs = (s: string) => (parseQuery(`length<${s}`).conds[0] as { value: number }).value;
    expect(secs("90")).toBe(90);
    expect(secs("2:30")).toBe(150);
    expect(secs("2m")).toBe(120);
    expect(secs("1m30s")).toBe(90);
  });
});

describe("filterLibrary", () => {
  it("matches words across set metadata and difficulty names", () => {
    expect(versions({ text: "galaxy" })).toEqual(["Extreme", "Hard"]);
    expect(versions({ text: "galaxy extreme" })).toEqual(["Extreme"]);
    expect(versions({ text: "コアラ" })).toEqual(["Easy", "LN Insane"]);
    expect(versions({ text: "speedcore" })).toEqual(["Extreme", "Hard"]);
  });

  it("excludes words", () => {
    expect(versions({ text: "-galaxy -local" })).toEqual(["Easy", "LN Insane"]);
  });

  it("filters numbers with sensible equality", () => {
    expect(versions({ text: "sr=5" })).toEqual(["LN Insane", "Taiko Oni"]);
    expect(versions({ text: "sr>5" })).toEqual(["Extreme", "LN Insane", "Taiko Oni"]);
    expect(versions({ text: "keys=4" })).toEqual(["Extreme", "Easy", "LN Insane"]);
    expect(versions({ text: "keys=7" })).toEqual(["Hard"]);
    expect(versions({ text: "ln>=50" })).toEqual(["Easy", "LN Insane"]);
    expect(versions({ text: "length>4:00" })).toEqual(["Extreme"]);
  });

  it("filters status, mode, grade and played", () => {
    expect(versions({ text: "status=loved" })).toEqual(["Easy", "LN Insane"]);
    expect(versions({ text: "mode=taiko" })).toEqual(["Taiko Oni"]);
    expect(versions({ text: "grade>=a" })).toEqual(["Extreme"]);
    expect(versions({ text: "played=no" })).toEqual(["Extreme", "Hard", "Easy", "Taiko Oni"]);
    expect(versions({ text: "played<7" })).toEqual(["LN Insane"]);
    expect(versions({ text: "year=2024" })).toEqual(["Easy", "LN Insane"]);
  });

  it("filters by which osu! a set is in", () => {
    expect(versions({ text: "game=stable" })).toEqual(["Taiko Oni"]);
    expect(versions({ text: "game=lazer" })).toEqual(["Extreme", "Hard", "Easy", "LN Insane"]);
    expect(versions({ text: "from!=stable" })).toEqual(["Extreme", "Hard", "Easy", "LN Insane"]);
    // not a game: plain text, which matches nothing here
    expect(versions({ text: "game=cuttingedge" })).toEqual([]);
  });

  it("filters by chart analysis", () => {
    expect(versions({ text: "pattern=js" })).toEqual(["Extreme"]);
    expect(versions({ text: "pattern=ln" })).toEqual(["LN Insane"]);
    expect(versions({ text: "pattern!=stamina mode=mania" })).toEqual(["Hard", "Easy", "LN Insane"]);
    expect(versions({ text: "peak>10" })).toEqual(["Extreme"]);
    // not analysed yet: never matches a number
    expect(versions({ text: "peak<10" })).toEqual(["LN Insane"]);
    expect(versions({ text: "dt>8" })).toEqual(["Extreme"]);
    expect(versions({ text: "htsr<4" })).toEqual(["LN Insane"]);
    expect(parseQuery("pattern=nonsense").conds).toHaveLength(0);
  });

  it("filters by dan and category", () => {
    expect(versions({ text: "dan=gamma" })).toEqual(["Extreme"]);
    expect(versions({ text: "dan=13" })).toEqual(["Extreme"]);
    expect(versions({ text: 'dan="gamma high"' })).toEqual(["Extreme"]);
    expect(versions({ text: 'dan="gamma low"' })).toEqual([]);
    // Regular 3 (7K) reads as 3 on the same scale; an LN chart by its rice reading
    expect(versions({ text: 'dan<="reform 5"' })).toEqual(["Hard", "LN Insane"]);
    expect(versions({ text: "dan>=alpha" })).toEqual(["Extreme"]);
    expect(versions({ text: 'dan="ln 9"' })).toEqual(["LN Insane"]);
    expect(versions({ text: "category=tech" })).toEqual(["Hard"]);
    expect(versions({ text: 'cat="column lock"' })).toEqual(["LN Insane"]);
  });

  it("combines the UI filters with the query", () => {
    expect(versions({ mode: 3, keys: [4], srMin: 2 })).toEqual(["Extreme", "LN Insane"]);
    expect(versions({ status: [-3] })).toEqual(["Taiko Oni"]);
    expect(versions({ played: "played" })).toEqual(["Extreme", "LN Insane"]);
    expect(versions({ played: "unplayed", mode: 3 })).toEqual(["Hard", "Easy"]);
  });

  it("restricts to a set of difficulties (collections)", () => {
    const r = filterLibrary(ix, DEFAULT_FILTER, new Set([1, 4]));
    expect(r.mapCount).toBe(2);
    expect(r.sets.map((s) => s.set)).toEqual([0, 2]);
  });
});

describe("sorting", () => {
  it("sorts sets by added date and by best matching star rating", () => {
    const res = run({});
    expect(sortSets(ix, [...res.sets], "added", true).map((r) => r.set)).toEqual([0, 1, 2]);
    expect(sortSets(ix, [...res.sets], "sr", true).map((r) => r.set)).toEqual([0, 2, 1]);
    expect(sortSets(ix, [...res.sets], "title", false).map((r) => r.set)).toEqual([0, 1, 2]);
  });

  it("sorts difficulties for the table", () => {
    const mis = sortMaps(ix, run({}).sets, "sr", true);
    expect(mis.map((mi) => ix.snap.maps[mi].version)).toEqual(["Extreme", "Taiko Oni", "LN Insane", "Hard", "Easy"]);
  });
});
