import { describe, expect, it } from "vitest";
import { soundStart } from "./silence";

const RATE = 1000;
const at = (len: number, from: number, v = 0.5): Float32Array => {
  const a = new Float32Array(len);
  for (let i = from; i < len; i++) a[i] = i % 2 ? v : -v;
  return a;
};

describe("soundStart", () => {
  it("skips a silent lead-in, a little before the sound", () => {
    expect(soundStart([at(3000, 1500)], RATE)).toBeCloseTo(1.44);
  });

  it("leaves a song alone that starts at once or after mere padding", () => {
    expect(soundStart([at(3000, 0)], RATE)).toBe(0);
    expect(soundStart([at(3000, 100)], RATE)).toBe(0);
  });

  it("counts a sound in any channel", () => {
    expect(soundStart([new Float32Array(3000), at(3000, 800)], RATE)).toBeCloseTo(0.74);
  });

  it("ignores noise below the threshold and silence to the end", () => {
    expect(soundStart([at(3000, 0, 0.001)], RATE)).toBe(0);
    expect(soundStart([new Float32Array(3000)], RATE)).toBe(0);
  });
});
