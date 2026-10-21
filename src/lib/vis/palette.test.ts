import { describe, expect, it } from "vitest";
import { hexRgb, paletteOf, rgbToHsl } from "./palette";

const picture = (parts: [number, [number, number, number]][]): number[] => {
  const out: number[] = [];
  for (const [n, rgb] of parts) for (let i = 0; i < n; i++) out.push(...rgb, 255);
  return out;
};

describe("paletteOf", () => {
  it("takes the strongest colour and one of another hue, lifted for a dark stage", () => {
    // mostly dark navy, a big orange sun, a little teal
    const p = paletteOf(picture([[800, [12, 14, 40]], [300, [240, 120, 30]], [196, [30, 190, 180]]]));
    const [ha, , la] = rgbToHsl(p.a);
    const [hb, , lb] = rgbToHsl(p.b);
    expect(ha).toBeGreaterThan(15);
    expect(ha).toBeLessThan(40);
    expect(hb).toBeGreaterThan(160);
    expect(hb).toBeLessThan(190);
    for (const l of [la, lb]) expect(l).toBeGreaterThanOrEqual(0.6);
  });
  it("makes up a second colour when the cover has one hue only", () => {
    const p = paletteOf(picture([[600, [200, 40, 60]], [300, [90, 15, 25]]]));
    const d = Math.abs(rgbToHsl(p.a)[0] - rgbToHsl(p.b)[0]);
    expect(Math.min(d, 360 - d)).toBeGreaterThan(30);
  });
  it("is the same for the same picture", () => {
    const px = picture([[500, [80, 200, 90]], [500, [200, 60, 220]]]);
    expect(paletteOf(px)).toEqual(paletteOf(px));
  });
});

describe("hexRgb", () => {
  it("reads both forms", () => {
    expect(hexRgb("#8b7cff")).toEqual([139, 124, 255]);
    expect(hexRgb(" #fff")).toEqual([255, 255, 255]);
  });
});
