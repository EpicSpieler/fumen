import { describe, expect, it } from "vitest";
import { authAnswer, EVENTS, identify } from "./obs-ws";
import { clipName, clipReason, HOLD, SceneRules, sceneOf, type OsuScene } from "./obs-rules";
import { STATE, type TosuNow } from "./tosu";

const SCENES: Record<OsuScene, string> = { select: "Song select", play: "Gameplay", results: "Results", closed: "Just chatting" };

describe("obs-websocket", () => {
  it("answers the password challenge as obs-websocket's docs say", async () => {
    // the example in obs-websocket's protocol docs
    expect(await authAnswer("supersecretpassword", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=")).toBe("1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
    // another password, another answer
    expect(await authAnswer("hunter2", "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=", "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=")).not.toBe("1Ct943GAT+6YQUUX47Ia/ncufilbe6+oD6lY+5kaCu4=");
  });

  it("says who it is and asks for scenes and outputs", () => {
    expect(identify(null)).toEqual({ op: 1, d: { rpcVersion: 1, eventSubscriptions: EVENTS } });
    expect(identify("abc").d.authentication).toBe("abc");
    expect(EVENTS).toBe(4 + 64);
  });
});

describe("scenes", () => {
  const now = (state: number): TosuNow => ({ state }) as TosuNow;

  it("reads what osu! shows", () => {
    expect(sceneOf(null)).toBe("closed");
    expect(sceneOf(now(STATE.play))).toBe("play");
    expect(sceneOf(now(STATE.resultScreen))).toBe("results");
    expect(sceneOf(now(STATE.selectPlay))).toBe("select");
    expect(sceneOf(now(STATE.menu))).toBe("select");
  });

  it("switches once a state has held", () => {
    const r = new SceneRules();
    expect(r.decide("play", 0, "Song select", SCENES)).toBeNull();
    expect(r.decide("play", HOLD.play - 1, "Song select", SCENES)).toBeNull();
    expect(r.decide("play", HOLD.play, "Song select", SCENES)).toBe("Gameplay");
    // once per state
    expect(r.decide("play", HOLD.play + 500, "Song select", SCENES)).toBeNull();
  });

  it("lets flicker and retries be", () => {
    const r = new SceneRules();
    r.decide("play", 0, "Gameplay", SCENES);
    expect(r.decide("play", 1000, "Gameplay", SCENES)).toBeNull();
    // a moment in song select, then playing again: nothing
    expect(r.decide("select", 1100, "Gameplay", SCENES)).toBeNull();
    expect(r.decide("play", 1400, "Gameplay", SCENES)).toBeNull();
    expect(r.decide("play", 3000, "Gameplay", SCENES)).toBeNull();
  });

  it("leaves a scene picked by hand alone", () => {
    const r = new SceneRules();
    expect(r.decide("results", 0, "BRB", SCENES)).toBeNull();
    expect(r.decide("results", 5000, "BRB", SCENES)).toBeNull();
    // nothing known about OBS's scene yet: it may switch
    const s = new SceneRules();
    s.decide("results", 0, null, SCENES);
    expect(s.decide("results", HOLD.results, null, SCENES)).toBe("Results");
  });

  it("doesn't switch for a state set to stay", () => {
    const r = new SceneRules();
    r.decide("results", 0, "Gameplay", { ...SCENES, results: "" });
    expect(r.decide("results", 5000, "Gameplay", { ...SCENES, results: "" })).toBeNull();
  });
});

describe("clips", () => {
  const on = { fc: true, best: true, close: true };
  const pass = { pass: true, misses: 3, newBest: false, leastHealth: 0.6, failsBefore: 0 };

  it("keeps the good moments, the best reason first", () => {
    expect(clipReason({ ...pass, misses: 0, newBest: true }, on)).toBe("fc");
    expect(clipReason({ ...pass, newBest: true }, on)).toBe("best");
    expect(clipReason({ ...pass, leastHealth: 0.05 }, on)).toBe("close");
    expect(clipReason({ ...pass, failsBefore: 3 }, on)).toBe("close");
    expect(clipReason(pass, on)).toBeNull();
    expect(clipReason({ ...pass, pass: false, misses: 0 }, on)).toBeNull();
  });

  it("only for what's switched on", () => {
    expect(clipReason({ ...pass, misses: 0 }, { ...on, fc: false })).toBeNull();
    expect(clipReason({ ...pass, misses: 0, newBest: true }, { ...on, fc: false })).toBe("best");
  });

  it("names a clip after the map", () => {
    expect(clipName("Ready Steady", "Hi-Fi", "FC", new Date(2026, 10, 11, 21, 5, 3))).toBe("Ready Steady [Hi-Fi] FC 2026-11-11 21-05-03");
    expect(clipName("Song", "", "best", new Date(2026, 0, 2, 3, 4, 5))).toBe("Song best 2026-01-02 03-04-05");
  });
});
