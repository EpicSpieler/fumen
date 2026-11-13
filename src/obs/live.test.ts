import { afterEach, describe, expect, it } from "vitest";
import { STATE, type TosuNow } from "../lib/tosu";
import { live, mapBegins } from "./live";

/** a tosu message for an osu!mania map, as readTosu makes it */
const msg = (state: number, at: number, o: { paused?: boolean; hits?: number; md5?: string } = {}): TosuNow => ({
  md5: o.md5 ?? "a",
  state,
  live: at,
  rate: 1,
  pitch: false,
  artist: "",
  title: "",
  version: "",
  paused: o.paused ?? false,
  client: "lazer",
  mode: 3,
  keys: 4,
  play: {
    failed: false,
    accuracy: 100,
    score: 0,
    maxCombo: o.hits ?? 0,
    combo: o.hits ?? 0,
    misses: 0,
    breaks: 0,
    hits: o.hits ?? 0,
    judges: { geki: o.hits ?? 0, n300: 0, katu: 0, n100: 0, n50: 0, miss: 0 },
    health: 100,
    rank: "SS",
    pp: 0,
    mods: "",
    modList: [],
    player: "",
    me: "",
  },
  firstObject: 886,
  lastObject: 125_836,
  mapCombo: null,
  inBreak: false,
  results: null,
});

const P = STATE.play;

/** Feeds messages to the OBS pages' tosu line; the index of each one the map began with. */
function begins(messages: TosuNow[]): number[] {
  const at: number[] = [];
  let i = 0;
  const off = live.bus.on("begin", () => at.push(i));
  for (; i < messages.length; i++) live.take(messages[i]);
  off();
  return at;
}

afterEach(() => live.take(null));

// Recorded with lazer 2026.1005.0 and tosu (docs/tosu.md): song select, the loading screen with the
// menu's music running on, the music stopping, then the gameplay screen coming in.
describe("a map begins when its gameplay screen comes in", () => {
  it("with a lead-in: at the jump back to the start, not when the song moves at the first note", () => {
    const seen = begins([
      msg(STATE.selectPlay, 53133),
      msg(P, 53282),
      msg(P, 53435),
      msg(P, 55262),
      msg(P, 55379),
      msg(P, 55379, { paused: true }),
      // the gameplay screen: lazer's time back at the start, held there through the lead-in
      msg(P, -13),
      msg(P, -13, { paused: true }),
      msg(P, -13, { paused: true }),
      msg(P, -13, { paused: true }),
      msg(P, 67),
      msg(P, 212),
      msg(P, 990, { hits: 1 }),
    ]);
    expect(seen).toEqual([6]);
  });

  it("without a lead-in (the first note 2 s in or later): at the jump back too", () => {
    expect(begins([msg(STATE.selectPlay, 97043), msg(P, 97192), msg(P, 99426), msg(P, 99426, { paused: true }), msg(P, 80), msg(P, 261)])).toEqual([4]);
  });

  it("not on the loading screen, however long it runs", () => {
    const loading = [msg(STATE.selectPlay, 40_000)];
    for (let t = 40_150; t < 60_000; t += 150) loading.push(msg(P, t));
    expect(begins(loading)).toEqual([]);
  });

  it("not when osu! leaves the results through a moment of playing", () => {
    const seen = begins([
      msg(STATE.resultScreen, 126_496, { paused: true, hits: 1517 }),
      msg(P, 126_496, { paused: true, hits: 1517 }),
      msg(P, 48_645),
      msg(STATE.selectPlay, 48_835),
    ]);
    expect(seen).toEqual([]);
  });

  it("once a note is judged when the jump back wasn't seen", () => {
    expect(begins([msg(STATE.selectPlay, 40), msg(P, 190), msg(P, 340), msg(P, 490), msg(P, 640, { hits: 1 })])).toEqual([4]);
  });

  it("joined in the middle of a map: once the song moves", () => {
    expect(begins([msg(P, 47_548, { hits: 610 }), msg(P, 47_701, { hits: 610 })])).toEqual([1]);
  });

  it("once per map: a retry keeps it", () => {
    const seen = begins([msg(STATE.selectPlay, 30_000), msg(P, 30_150), msg(P, -13), msg(P, 150), msg(P, 9000, { hits: 40 }), msg(P, -13), msg(P, 150)]);
    expect(seen).toEqual([2]);
  });

  it("another map's start isn't this one's", () => {
    expect(mapBegins(msg(P, -13, { md5: "b" }), msg(P, 50_000), true)).toBe(false);
  });
});
