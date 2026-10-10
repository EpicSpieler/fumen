import { describe, expect, it } from "vitest";
import { parseLink, readLinks } from "./links";

describe("parseLink", () => {
  // the same cases as the backend's (src-tauri/src/downloads.rs, `links`)
  const cases: [string, ReturnType<typeof parseLink>][] = [
    ["https://osu.ppy.sh/beatmapsets/1225016#mania/2549232", { kind: "set", id: 1225016 }],
    ["https://osu.ppy.sh/beatmapsets/1225016", { kind: "set", id: 1225016 }],
    ["http://osu.ppy.sh/s/39804", { kind: "set", id: 39804 }],
    ["https://osu.ppy.sh/b/75", { kind: "beatmap", id: 75 }],
    ["https://osu.ppy.sh/beatmaps/2549232?mode=mania", { kind: "beatmap", id: 2549232 }],
    ["https://osu.ppy.sh/p/beatmap?b=75&m=0", { kind: "beatmap", id: 75 }],
    ["osu://s/39804", { kind: "set", id: 39804 }],
    ["osu://b/75", { kind: "beatmap", id: 75 }],
    ["osu://dl/39804", { kind: "set", id: 39804 }],
    ["  1225016  ", { kind: "set", id: 1225016 }],
    ["<https://www.osu.ppy.sh/beatmapsets/7>", { kind: "set", id: 7 }],
    ["https://example.com/beatmapsets/1", null],
    ["https://osu.ppy.sh.example.com/beatmapsets/1", null],
    ["https://osu.ppy.sh/users/2", null],
    ["https://osu.ppy.sh/p/beatmap?b=0", null],
    ["0", null],
    ["hello", null],
    ["", null],
  ];
  it.each(cases)("%s", (line, want) => expect(parseLink(line)).toEqual(want));
});

describe("readLinks", () => {
  it("finds links between words, once each", () => {
    const text = [
      "https://osu.ppy.sh/beatmapsets/1225016#mania/2549232",
      "",
      "try this one https://osu.ppy.sh/b/75 and 39804",
      "https://osu.ppy.sh/beatmapsets/1225016",
      "not a link at all",
    ].join("\n");
    expect(readLinks(text)).toEqual({
      links: ["https://osu.ppy.sh/beatmapsets/1225016#mania/2549232", "https://osu.ppy.sh/b/75", "39804"],
      unknown: ["not a link at all"],
    });
  });
});
