import { describe, expect, it } from "vitest";
import { HOLD_MAX, readTosu, STALL, StartHold, TosuClock } from "./tosu";

const msg = (o: { live?: number; md5?: string; state?: number; mods?: unknown } = {}) => ({
  state: { number: o.state ?? 2, name: "play" },
  beatmap: { checksum: o.md5 ?? "ABC123", time: { live: o.live ?? 1000, firstObject: 0, lastObject: 0, mp3Length: 0 }, artist: "A", title: "T", version: "V" },
  play: { mods: o.mods ?? { number: 0, name: "", array: [], rate: 1 } },
});

describe("readTosu", () => {
  it("reads the map, place and state", () => {
    expect(readTosu(msg())).toEqual({ md5: "abc123", state: 2, live: 1000, rate: 1, pitch: false, artist: "A", title: "T", version: "V" });
  });

  it("reads the rate and whether the pitch goes with it", () => {
    expect(readTosu(msg({ mods: { rate: 1.5, array: [{ acronym: "DT" }] } }))).toMatchObject({ rate: 1.5, pitch: false });
    expect(readTosu(msg({ mods: { rate: 1.5, array: [{ acronym: "NC" }] } }))).toMatchObject({ rate: 1.5, pitch: true });
    expect(readTosu(msg({ mods: { rate: 1.2, array: [{ acronym: "DT", settings: { adjust_pitch: true } }] } }))).toMatchObject({ pitch: true });
    expect(readTosu(msg({ mods: { rate: 0 } }))).toMatchObject({ rate: 1 });
  });

  it("isn't fooled by other messages", () => {
    expect(readTosu(null)).toBeNull();
    expect(readTosu({ beatmap: {} })).toBeNull();
    expect(readTosu("hello")).toBeNull();
  });
});

describe("TosuClock", () => {
  it("knows where but not that it moves from the first reading", () => {
    const c = new TosuClock();
    c.update(5000, 1, 0);
    expect(c.running(10)).toBe(false);
    expect(c.at(10)).toBe(5000);
  });

  it("runs on between readings, at the rate", () => {
    const c = new TosuClock();
    c.update(5000, 1.5, 0);
    c.update(5150, 1.5, 100);
    expect(c.running(200)).toBe(true);
    expect(c.at(200)).toBeCloseTo(5150 + 100 * 1.5);
  });

  it("stops when the time stops moving", () => {
    const c = new TosuClock();
    c.update(5000, 1, 0);
    c.update(5100, 1, 100);
    c.update(5100, 1, 300);
    expect(c.running(100 + STALL + 1)).toBe(false);
    expect(c.at(100 + STALL + 1)).toBe(5100);
  });
});

describe("StartHold", () => {
  it("waits through the menu's music, then for the start to move", () => {
    const h = new StartHold();
    h.begin(64000, 63900, 0);
    expect(h.on).toBe(true);
    h.update(64100, 100);
    h.update(64900, 900);
    expect(h.on).toBe(true);
    // gameplay loads: back to the beginning, still for a moment
    h.update(0, 1200);
    h.update(0, 1300);
    expect(h.on).toBe(true);
    h.update(16, 1400);
    expect(h.on).toBe(false);
  });

  it("knows lazer's lead-in below zero as the start", () => {
    const h = new StartHold();
    h.begin(52000, null, 0);
    h.update(-1800, 500);
    expect(h.on).toBe(true);
    h.update(-1700, 600);
    expect(h.on).toBe(false);
  });

  it("isn't fooled by the preview looping back to its own point", () => {
    const h = new StartHold();
    h.begin(80000, null, 0);
    h.update(52000, 200);
    h.update(52100, 300);
    expect(h.on).toBe(true);
  });

  it("starts at once when osu! is already back at the beginning", () => {
    const h = new StartHold();
    h.begin(0, 47000, 0);
    h.update(0, 100);
    expect(h.on).toBe(true);
    h.update(30, 200);
    expect(h.on).toBe(false);
  });

  it("takes a start near the beginning as the start when there's no time from before", () => {
    const h = new StartHold();
    h.begin(100, null, 0);
    h.update(100, 100);
    expect(h.on).toBe(true);
    h.update(250, 200);
    expect(h.on).toBe(false);
  });

  it("gives up waiting after a while", () => {
    const h = new StartHold();
    h.begin(64000, null, 0);
    h.update(65000, HOLD_MAX + 1);
    expect(h.on).toBe(false);
  });
});
