import { describe, expect, it } from "vitest";
import { SongClock } from "./song-clock";

describe("song clock", () => {
  it("moves on between reports that come in steps", () => {
    const c = new SongClock();
    expect(c.read(1000, 0, 1, true)).toBe(1000);
    // the element still says 1000 a frame later: the clock goes on anyway
    const t = c.read(1000, 16, 1, true);
    expect(t).toBeGreaterThan(1010);
    expect(t).toBeLessThanOrEqual(1016);
  });

  it("never goes back while playing when a report is a little behind", () => {
    const c = new SongClock();
    let last = c.read(1000, 0, 1, true);
    const reports = [1016, 1032, 1020, 1064, 1050, 1096, 1112, 1100, 1144];
    reports.forEach((r, i) => {
      const t = c.read(r, (i + 1) * 16, 1, true);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    });
    expect(c.backSteps).toBe(3);
    // and stays close to the song
    expect(Math.abs(last - 1144)).toBeLessThan(20);
  });

  it("follows seeks both ways, and stands with the song when paused", () => {
    const c = new SongClock();
    c.read(1000, 0, 1, true);
    expect(c.read(5000, 16, 1, true)).toBe(5000);
    expect(c.read(2000, 32, 1, true)).toBe(2000);
    expect(c.read(2000, 1000, 1, false)).toBe(2000);
  });

  it("runs at the song's rate", () => {
    const c = new SongClock();
    c.read(1000, 0, 1.5, true);
    expect(c.read(1000, 20, 1.5, true)).toBeGreaterThan(1025);
  });
});
