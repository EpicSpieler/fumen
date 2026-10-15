/* catch-replay.ts — an osu!catch replay judged the way lazer judges it (MIT, ppy Pty Ltd), for the
 * playfield: what was caught, the accuracy as it goes.
 *
 *  - The catcher (CatchReplayFrame.FromLegacy, CatchFramedReplayInputHandler): the frames' x,
 *    straight between them, dashing on the left button.
 *  - Catching (DrawableCatchHitObject.CheckForResult, Catcher.CanCatch): every fruit, droplet,
 *    tiny droplet and banana is judged at its time: caught if it's within half the catch width
 *    (106.75 × the catcher's scale × 0.8) of the catcher.
 *  - Results: fruits Great or Miss, droplets a large tick, tiny droplets a small one, bananas a
 *    bonus. Misses of fruits and droplets break the combo.
 *  - Accuracy (CatchScoreProcessor): every fruit, droplet and tiny droplet counts the same.
 */
import { BANANA, catchWidth, DROPLET, FRUIT, TINY, upper, WIDTH, type CatchChart } from "../ui/catch/chart";
import { MISS, Tally, type AccuracyPart, type Judgement, type Result } from "./replay";

/** our results: fruits caught are Great; droplets caught Ok (the panel calls it a droplet) */
const GREAT: Result = 1;
const DROP: Result = 3;
const SCORE = [0, 300, 0, 300, 0, 0];

/** Mods that move the catcher or the objects in ways Fumen doesn't replay. */
const UNREPLAYED = new Set(["RX", "AP", "FF", "FR", "MF", "NS", "MG", "WU", "WD", "AS", "DA", "SG"]);

/** The mods of an osu!catch score that keep it from being replayed here (empty: it can be). */
export function catchUnreplayed(mods: string[]): string[] {
  return mods.filter((m) => UNREPLAYED.has(m));
}

/**
 * An osu!catch replay, judged. `chart` is the playfield's chart (the score's mods built in),
 * `frames` the replay's [time, x, y, buttons].
 */
export class CatchReplay {
  /** fruits and droplets: their judgements, by time (tiny droplets count only towards accuracy) */
  readonly judgements: Judgement[];
  readonly results: readonly Result[] = [GREAT, DROP, MISS];
  /** the panel's names for them */
  readonly names: Partial<Record<Result, string>> = { [GREAT]: "Fruits", [DROP]: "Droplets", [MISS]: "Miss" };
  /** the catcher for the playfield: [time, x, dash] */
  readonly frames: number[];
  /** per object (in the chart's order): caught */
  readonly caught: Uint8Array;
  /** lazer's counts */
  readonly great: number;
  readonly miss: number;
  readonly largeTickHit: number;
  readonly largeTickMiss: number;
  readonly smallTickHit: number;
  readonly smallTickMiss: number;
  readonly largeBonus: number;
  private readonly tally: Tally;

  constructor(chart: CatchChart, frames: ArrayLike<number>) {
    const out: number[] = [];
    for (let f = 0; f + 3 < frames.length; f += 4) out.push(frames[f], frames[f + 1], Math.round(frames[f + 3]) & 1 ? 1 : 0);
    this.frames = out;
    const time = Float64Array.from({ length: out.length / 3 }, (_, k) => out[k * 3]);
    const catcherX = (t: number) => {
      const n = time.length;
      if (!n) return WIDTH / 2;
      const k = upper(time, t) - 1;
      const at = (j: number) => out[j * 3 + 1];
      let x: number;
      if (k < 0) x = at(0);
      else if (k >= n - 1) x = at(n - 1);
      else {
        const span = time[k + 1] - time[k];
        x = at(k) + (at(k + 1) - at(k)) * (span > 0 ? (t - time[k]) / span : 1);
      }
      return Math.max(0, Math.min(WIDTH, x));
    };

    const half = catchWidth(chart.catcherScale) / 2;
    const caught = (this.caught = new Uint8Array(chart.n));
    const judgements: Judgement[] = [];
    const parts: AccuracyPart[] = [];
    const counts = { great: 0, miss: 0, lth: 0, ltm: 0, sth: 0, stm: 0, bonus: 0 };
    for (let i = 0; i < chart.n; i++) {
      const t = chart.time[i];
      const hit = Math.abs(chart.x[i] - catcherX(t)) <= half;
      caught[i] = hit ? 1 : 0;
      const k = chart.kind[i];
      if (k === FRUIT) {
        if (hit) counts.great++;
        else counts.miss++;
        judgements.push({ time: t, result: hit ? GREAT : MISS, offset: NaN, col: k, obj: i, tail: false });
      } else if (k === DROPLET) {
        if (hit) counts.lth++;
        else counts.ltm++;
        judgements.push({ time: t, result: hit ? DROP : MISS, offset: NaN, col: k, obj: i, tail: false });
      } else if (k === TINY) {
        if (hit) counts.sth++;
        else counts.stm++;
        parts.push({ time: t, score: hit ? 300 : 0, max: 300 });
      } else if (k === BANANA && hit) counts.bonus++;
    }
    this.judgements = judgements;
    this.great = counts.great;
    this.miss = counts.miss;
    this.largeTickHit = counts.lth;
    this.largeTickMiss = counts.ltm;
    this.smallTickHit = counts.sth;
    this.smallTickMiss = counts.stm;
    this.largeBonus = counts.bonus;
    this.tally = new Tally(judgements, SCORE, 300, parts);
  }

  /** No timing to show: catching is where, not when. */
  barWindows(): [Result, number][] {
    return [];
  }

  /** The counts per result, the accuracy (0–1) and how many were judged, by `t`. */
  stats(t: number): { counts: number[]; accuracy: number; judged: number } {
    return this.tally.stats(t);
  }
}
