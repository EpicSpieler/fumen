import { describe, expect, it, vi } from "vitest";

// the pool helpers: a slot's kind is its letters
vi.mock("./pools", () => ({ kindOfSlot: (_: unknown, slot: string) => ({ code: slot.replace(/\d+$/, ""), count: 1, mods: [] }) }));
vi.mock("./api", () => ({ api: {}, asApiError: (e: unknown) => e }));
vi.mock("./store", () => ({ Emitter: class {}, events: { on: () => () => {} } }));
vi.mock("../ui/controls", () => ({ toast: () => {} }));
vi.mock("./i18n", () => ({ t: (s: string) => s }));
const { matchState, strengths } = await import("./matches");
import type { Match, MatchGame, MatchScore } from "./matches";
import type { Pool } from "./pools";

const SLOTS: Record<number, string> = { 1: "RC1", 2: "RC2", 3: "LN1", 4: "LN2", 5: "HB1", 9: "TB" };
const slotOf = (b: number) => SLOTS[b] ?? null;

const score = (user: number, score: number, extra: Partial<MatchScore> = {}): MatchScore => ({
  user, score, acc: score / 1_000_000, combo: 100, misses: 0, team: "none", passed: true, mods: [], ...extra,
});
let gid = 0;
const game = (beatmapId: number, scores: MatchScore[], extra: Partial<MatchGame> = {}): MatchGame => ({
  id: ++gid, beatmapId, title: "", start: 1, end: 2, mode: 3, mods: [], scoring: "scorev2", teamType: "head-to-head", scores, ...extra,
});
const match = (games: MatchGame[], extra: Partial<Match> = {}): Match => ({
  id: "m", poolId: "p", red: "Alpha", blue: "beta", bestOf: 5, warmups: 0, bans: [], picks: [], note: "", created: 0, updated: 0,
  result: { id: 1, name: "room", users: [{ id: 10, name: "alpha" }, { id: 20, name: "Beta" }, { id: 30, name: "Ref" }], games },
  ...extra,
});

describe("a match's games", () => {
  it("counts points, finds players by name and tells picks from the first one", () => {
    const m = match(
      [
        game(7, [score(10, 500_000), score(20, 400_000)]), // warm-up
        game(1, [score(20, 900_000), score(10, 950_000)]),
        game(3, [score(10, 800_000), score(20, 850_000)]),
        game(42, [score(10, 990_000), score(20, 700_000)]), // not in the pool: counts
        game(4, [score(10, 600_000), score(20, 610_000)]),
        game(9, [score(10, 700_000), score(20, 650_000)]), // the tiebreaker
      ],
      { warmups: 1, firstPick: "blue", picks: [{ side: "red", slot: "LN1" }] },
    );
    const s = matchState(m, slotOf);
    expect(s.players.red.map((p) => p.name)).toEqual(["alpha"]);
    expect(s.players.blue.map((p) => p.name)).toEqual(["Beta"]);
    expect(s.games.map((g) => [g.slot, g.winner, g.pickedBy, g.tiebreaker])).toEqual([
      ["RC1", "red", "blue", false],
      // set by hand
      ["LN1", "blue", "red", false],
      [null, "red", "blue", false],
      ["LN2", "blue", "red", false],
      ["TB", "red", null, true],
    ]);
    expect([s.points, s.winner, s.status, s.nextPick]).toEqual([{ red: 3, blue: 2 }, "red", "done", null]);
  });

  it("knows what's being played and whose pick is next", () => {
    const m = match([game(1, [score(10, 1), score(20, 2)]), game(2, [], { end: undefined })], { firstPick: "red", red: "", blue: "" });
    const s = matchState(m, slotOf);
    // no names: the order they first played in
    expect([s.players.red[0].id, s.players.blue[0].id]).toEqual([10, 20]);
    expect([s.points, s.status, s.nextPick, s.live?.beatmapId]).toEqual([{ red: 0, blue: 1 }, "live", "blue", 2]);
    // at the tiebreaker nobody picks
    const tb = matchState(match([game(1, [score(10, 2), score(20, 1)]), game(2, [score(10, 1), score(20, 2)])], { bestOf: 3, firstPick: "red" }), slotOf);
    expect([tb.nextPick, tb.winner, tb.status]).toEqual([null, null, "live"]);
    // nothing played, the time not here yet
    expect(matchState({ ...match([]), result: undefined, at: Date.now() + 60_000 }, slotOf).status).toBe("upcoming");
  });

  it("adds up teams and goes by accuracy where the room does", () => {
    const team = (user: number, s: number, side: "red" | "blue") => score(user, s, { team: side });
    const s = matchState(
      match([
        game(1, [team(1, 400_000, "red"), team(2, 400_000, "red"), team(3, 700_000, "blue"), team(4, 50_000, "blue")], { teamType: "team-vs" }),
        game(2, [team(1, 900_000, "red"), team(3, 800_000, "blue")], { teamType: "team-vs", scoring: "accuracy" }),
      ]),
      slotOf,
    );
    expect(s.games.map((g) => [g.red, g.blue, g.winner])).toEqual([
      [800_000, 750_000, "red"],
      [0.9, 0.8, "red"],
    ]);
    expect(s.players.red.map((p) => p.id)).toEqual([1, 2]);
  });
});

describe("strengths", () => {
  it("adds up each player's games by kind", () => {
    const pool = {} as Pool;
    const a = match([game(1, [score(10, 900_000), score(20, 800_000)]), game(3, [score(10, 700_000), score(20, 800_000)]), game(2, [score(10, 950_000), score(20, 600_000)])]);
    const st = strengths([{ match: a, pool, state: matchState(a, slotOf) }]);
    const alpha = st.get("alpha")!;
    expect(alpha.get("RC")).toEqual({ played: 2, won: 2, acc: 0.9 + 0.95 });
    expect(alpha.get("LN")).toEqual({ played: 1, won: 0, acc: 0.7 });
    expect(st.get("Beta")!.get("LN")!.won).toBe(1);
  });
});
