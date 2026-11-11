import { describe, expect, it } from "vitest";
import { DEFAULT_HUD, guides, hudPrefs, MARGIN_X, pinsFor, placeAt, rectOf, snapEdge, snapRect, SIZE_MAX } from "./hud-layout";

describe("hud layout", () => {
  it("keeps the defaults as they are", () => {
    expect(hudPrefs({ layout: DEFAULT_HUD, react: true })).toEqual({ layout: DEFAULT_HUD, react: true });
  });

  it("fills in what's missing and mends what's broken", () => {
    const p = hudPrefs({ layout: { pp: { x: 4, size: 99, ax: 0.3, on: false }, combo: "no" }, react: "yes" });
    expect(p.layout.pp).toEqual({ ...DEFAULT_HUD.pp, x: 1, size: SIZE_MAX, on: false });
    expect(p.layout.combo).toEqual(DEFAULT_HUD.combo);
    expect(p.layout.vis).toEqual(DEFAULT_HUD.vis);
    expect(p.react).toBe(true);
    expect(hudPrefs(null).layout).toEqual(DEFAULT_HUD);
  });

  it("finds a part from its pin and its size", () => {
    const acc = { ...DEFAULT_HUD.acc, x: 0.9, y: 0.8, ax: 1 as const, ay: 1 as const };
    expect(rectOf(acc, "words", { w: 0.1, h: 0.05 })).toEqual({ x: 0.8, y: 0.75, w: 0.1, h: 0.05 });
    const vis = { ...DEFAULT_HUD.vis, x: 0, y: 1, ax: 0 as const, ay: 1 as const, w: 1, h: 0.2 };
    expect(rectOf(vis, "area", { w: 0.5, h: 0.01 })).toEqual({ x: 0, y: 0.8, w: 1, h: 0.2 });
    const bar = { ...DEFAULT_HUD.bar, w: 0.5 };
    expect(rectOf(bar, "line", { w: 0.9, h: 0.01 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.01 });
  });

  it("pins a part to the edge it's nearest to", () => {
    expect(pinsFor({ x: 0.02, y: 0.7, w: 0.1, h: 0.05 })).toEqual({ ax: 0, ay: 1 });
    expect(pinsFor({ x: 0.85, y: 0.02, w: 0.1, h: 0.05 })).toEqual({ ax: 1, ay: 0 });
    expect(pinsFor({ x: 0.45, y: 0.4, w: 0.1, h: 0.05 })).toEqual({ ax: 0.5, ay: 0 });
  });

  it("stays where it was put when its pins change", () => {
    const r = { x: 0.8, y: 0.1, w: 0.1, h: 0.04 };
    const p = placeAt(DEFAULT_HUD.title, "words", r);
    expect(p.ax).toBe(1);
    expect(p.ay).toBe(0);
    expect(rectOf(p, "words", { w: r.w, h: r.h })).toEqual(r);
    const line = placeAt(DEFAULT_HUD.hp, "line", { x: 0.6, y: 0.9, w: 0.3, h: 0.01 });
    expect(line.w).toBeCloseTo(0.3);
    expect(rectOf(line, "line", { w: 0, h: 0.01 }).x).toBeCloseTo(0.6);
  });

  it("snaps to the margin, the middle and the other parts", () => {
    const lines = guides([{ x: 0.7, y: 0.3, w: 0.2, h: 0.1 }]);
    const within = { x: 0.01, y: 0.01 };
    const s = snapRect({ x: MARGIN_X + 0.006, y: 0.396, w: 0.1, h: 0.05 }, lines, within);
    expect(s.dx).toBeCloseTo(-0.006);
    expect(s.gx).toBe(MARGIN_X);
    expect(s.gy).toBeCloseTo(0.4);
    expect(s.dy).toBeCloseTo(0.004);
    const centred = snapRect({ x: 0.448, y: 0.2, w: 0.1, h: 0.05 }, lines, within);
    expect(centred.gx).toBe(0.5);
    const free = snapRect({ x: 0.2, y: 0.2, w: 0.1, h: 0.05 }, lines, within);
    expect(free).toEqual({ dx: 0, dy: 0, gx: null, gy: null });
    expect(snapEdge(0.995, lines.x, 0.01)).toEqual({ at: 1, guide: 1 });
    expect(snapEdge(0.6, lines.x, 0.01)).toEqual({ at: 0.6, guide: null });
  });
});
