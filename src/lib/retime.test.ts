import { describe, expect, it } from "vitest";
import { retimed } from "./retime";

describe("retimed", () => {
  // notes at 1000 (hit 30 late), 2000 (never pressed), 3000 chord: one pressed 10 early, one not
  const hits = [1000, 1030, 2000, NaN, 3000, NaN, 3000, 2990];

  it("moves a note's sound to its press", () => {
    expect(retimed(hits, 1000)).toBe(1030);
    expect(retimed(hits, 1001)).toBe(1030);
  });
  it("drops the sound of a note never pressed", () => {
    expect(retimed(hits, 2000)).toBeNull();
  });
  it("plays a chord's sound with the first note pressed", () => {
    expect(retimed(hits, 3000)).toBe(2990);
  });
  it("leaves sounds without a note where they are", () => {
    expect(retimed(hits, 1500)).toBe(1500);
    expect(retimed([], 1500)).toBe(1500);
  });
});
