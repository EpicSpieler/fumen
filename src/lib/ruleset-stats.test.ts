import { describe, expect, it } from "vitest";
import { rulesetStats } from "./ruleset-stats";
import type { ChartData } from "./types";

const base = (mode: number, end: number): ChartData =>
  ({
    mode,
    keys: 0,
    notes: [],
    beats: [0, 500, 4],
    breaks: [],
    kiai: [],
    stars: [],
    analysis: { start: 0, end, density: Array.from({ length: Math.ceil(end / 1000) + 1 }, () => 4) },
  }) as unknown as ChartData;

describe("osu!", () => {
  it("counts a stream and a jump", () => {
    const d = base(0, 6000);
    const objects: number[] = [];
    // 8 circles a quarter beat (125 ms) apart, close together
    for (let i = 0; i < 8; i++) objects.push(i * 125, 0, i * 125, 100 + i * 10, 100, 0, i + 1, 0, 0, 0);
    // then two far apart, half a beat apart
    objects.push(2000, 0, 2000, 50, 50, 0, 1, 1, 0, 0, 2250, 0, 2250, 450, 330, 0, 2, 0, 0, 0);
    d.osu = { scale: 0.5, preempt: 1200, fadeIn: 400, objects, sliders: [], frames: [], colours: [] };
    const st = rulesetStats(d)!;
    expect(st.facts.find((f) => f.label === "Streams")!.value).toBe("8");
    expect(st.facts.find((f) => f.label === "Jumps")!.value).toBe(`${Math.round(Math.hypot(400, 280))} px`);
    expect(st.shares.find((s) => s.label === "Streams")!.bpm).toBeCloseTo(120);
    expect(st.windows[0]).toBe("Streams");
  });
});

describe("osu!taiko", () => {
  it("counts colour changes and patterns", () => {
    const d = base(1, 3000);
    const objects: number[] = [];
    // D K D K D K at a quarter beat
    for (let i = 0; i < 6; i++) objects.push(i * 125, i % 2, i * 125, i === 0 ? 1 : 0, 0);
    d.taiko = { objects, ticks: [], scroll: [], bars: [], presses: [] };
    const st = rulesetStats(d)!;
    expect(st.facts.find((f) => f.label === "Colour changes")!.value).toBe("100%");
    expect(st.facts.find((f) => f.label === "Patterns")!.sub).toContain("DKD");
    expect(st.facts.find((f) => f.label === "Longest run")!.value).toBe("6");
  });
});

describe("osu!catch", () => {
  it("counts hyperdashes and banana time", () => {
    const d = base(2, 5000);
    const objects = [0, 0, 100, 1, 0, 0, 300, 0, 450, 0, 1, 0, 1000, 3, 200, 0, 2, 0, 2000, 3, 300, 0, 2, 1];
    d.catch = { scale: 1, preempt: 1000, objects, frames: [0, 100, 0, 300, 450, 1], colours: [] };
    const st = rulesetStats(d)!;
    expect(st.facts.find((f) => f.label === "Hyperdashes")!.value).toBe("50%");
    expect(st.facts.find((f) => f.label === "Bananas")!.value).toBe("1 s");
    expect(st.facts.find((f) => f.label === "Dashing")!.value).toBe("100%");
  });
});
