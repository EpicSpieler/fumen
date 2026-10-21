import { describe, expect, it, vi } from "vitest";

// the pool helpers aren't needed for the text formats (and pull in the window's)
vi.mock("./pools", () => ({}));
const { fileName, toCsv, toTsv } = await import("./pool-export");
import type { ExportRow } from "./pool-export";

const row = (extra: Partial<ExportRow> = {}): ExportRow => ({
  slot: "RC1",
  kind: "RC",
  mods: "",
  beatmapId: 2547774,
  artist: "Camellia",
  title: "Ghost, \"Again\"",
  version: "4K Another",
  creator: "Mapper",
  stars: 4.57,
  bpm: 180,
  length: 125,
  maxPp: 312,
  inLibrary: true,
  note: "",
  ...extra,
});

describe("pool exports", () => {
  it("writes CSV the way Excel reads it", () => {
    const csv = toCsv([row(), row({ slot: "TB", note: "two\nlines", artist: "=HYPERLINK(1)" }), { ...row({ slot: "LN1" }), beatmapId: undefined, title: "", artist: "", version: "", creator: "", stars: undefined, bpm: undefined, length: undefined, maxPp: undefined }]);
    const lines = csv.split("\r\n");
    expect(csv.startsWith("\ufeffSlot,Mods,Artist,Title")).toBe(true);
    expect(lines[1]).toBe('RC1,,Camellia,"Ghost, ""Again""",4K Another,Mapper,4.57,180,2:05,312,2547774,https://osu.ppy.sh/b/2547774,');
    // a formula stays text, a line break stays inside its field
    expect(lines[2]).toContain(",'=HYPERLINK(1),");
    expect(csv).toContain('"two\nlines"');
    // an empty slot is its code and nothing else
    expect(csv).toContain("\r\nLN1,,,,,,,,,,,,\r\n");
  });

  it("writes tab-separated text for pasting into a sheet", () => {
    const tsv = toTsv([row({ note: "a\tb\nc", mods: "DT" })]).split("\n");
    expect(tsv[0].split("\t")).toHaveLength(13);
    expect(tsv[1].split("\t").slice(0, 3)).toEqual(["RC1", "DT", "Camellia"]);
    expect(tsv[1].endsWith("\ta b c")).toBe(true);
  });

  it("names files after the pool", () => {
    expect(fileName("RPRO Community Cup · Qualifiers", "csv")).toBe("RPRO Community Cup - Qualifiers.csv");
    expect(fileName('a/b:c*?"<>|d', "json")).toBe("abcd.json");
    expect(fileName("  ", "png")).toBe("pool.png");
  });
});
