import { describe, expect, it } from "vitest";
import { CatchChart, catchWidth } from "../ui/catch/chart";
import { CatchReplay } from "./catch-replay";
import { RESULTS } from "./replay";

/** a chart (scale 0.5: the catcher at 1) from [time, kind, x] objects; kind 0 fruit, 1 droplet, 2 tiny, 3 banana */
function chart(objects: number[][]): CatchChart {
  const flat = objects.flatMap(([time, kind, x], i) => [time, kind, x, 0, i, 0]);
  return new CatchChart({ catch: { scale: 0.5, preempt: 1000, objects: flat, frames: [], colours: [] }, kiai: [] } as never);
}

describe("catching", () => {
  const half = catchWidth(1) / 2;

  it("catches what's within half the catch width of the catcher, where it is between frames", () => {
    const c = chart([
      [1000, 0, 100],
      [2000, 0, 300],
      [2500, 1, 200 + half - 1],
      [2500, 2, 200 + half + 1],
      [3000, 3, 300],
    ]);
    // at 100 until 1000, at 200 by 2500, at 400 by 3000
    const r = new CatchReplay(c, [0, 100, 0, 0, 1000, 100, 0, 1, 2500, 200, 0, 1, 3000, 400, 0, 0]);
    expect(Array.from(r.caught)).toEqual([1, 0, 1, 0, 0]);
    expect(r.judgements.map((j) => RESULTS[j.result])).toEqual(["great", "miss", "ok"]);
    expect([r.great, r.miss, r.largeTickHit, r.smallTickMiss, r.largeBonus]).toEqual([1, 1, 1, 1, 0]);
    // every fruit, droplet and tiny droplet counts the same
    expect(r.stats(4000).accuracy).toBeCloseTo(2 / 4);
    // dashing: the left button
    expect(r.frames).toEqual([0, 100, 0, 1000, 100, 1, 2500, 200, 1, 3000, 400, 0]);
  });

  it("the playfield's catcher follows the replay: missed fruits stay off the plate and the catcher fails", () => {
    const c = chart([
      [1000, 0, 100],
      [2000, 0, 400],
    ]);
    const r = new CatchReplay(c, [0, 100, 0, 0, 3000, 100, 0, 0]);
    c.setPlay(r.frames, r.caught);
    expect(c.catcherX(2000)).toBe(100);
    expect(c.stateAt(1500)).toBe("idle");
    expect(c.stateAt(2500)).toBe("fail");
    expect(Array.from(c.combo)).toEqual([0, 1]);
  });
});
