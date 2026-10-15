/* replay.ts — an osu!mania replay judged the way lazer judges it (MIT, ppy Pty Ltd), for the
 * playfield: which key was down when, every note's and hold's result, the hit errors, the
 * accuracy as it goes.
 *
 *  - Hit windows: ManiaHitWindows. Each window from OD (lazer's DifficultyRange, or the classic
 *    ones with Classic), times the rate (they stay the same in real time) and over 1.4 with
 *    Hard Rock (times it with Easy), floored, plus half a millisecond.
 *  - Notes in a column are judged in order. A press inside the miss window judges the next one
 *    (Perfect … Meh by its distance, Miss when early past Meh); a note left alone past the Meh
 *    window is missed.
 *  - Holds (DrawableHoldNote): the press judges the head and starts holding; a press after a
 *    missed head still holds, until the tail's time. Letting go judges the tail by its distance
 *    from the end over 1.5 (TailNote's release lenience); too early for that it's a hold break,
 *    and the hold can be pressed again. A tail not let go by its Meh window (×1.5) is missed. A
 *    tail after a missed head or a break is Meh at best.
 *  - Accuracy: Perfect 305, Great 300, Good 200, Ok 100, Meh 50, of 305 per head, note and tail.
 */

/** lazer's results, best first; the index is the result */
export const RESULTS = ["perfect", "great", "good", "ok", "meh", "miss"] as const;
export type Result = 0 | 1 | 2 | 3 | 4 | 5;
export const MISS: Result = 5;
const MEH: Result = 4;
const SCORE = [305, 300, 200, 100, 50, 0];
/** TailNote.RELEASE_WINDOW_LENIENCE */
const LENIENCE = 1.5;

const RANGES: [number, number, number][] = [
  [22.4, 19.4, 13.9],
  [64, 49, 34],
  [97, 82, 67],
  [127, 112, 97],
  [151, 136, 121],
  [188, 173, 158],
];

/** IBeatmapDifficultyInfo.DifficultyRange: the value at OD 0, 5 and 10, in between on a line */
function range(od: number, [min, mid, max]: [number, number, number]): number {
  if (od > 5) return mid + ((max - mid) * (od - 5)) / 5;
  if (od < 5) return mid + ((mid - min) * (od - 5)) / 5;
  return mid;
}

/** ManiaHitWindows for an OD and the score's mods (acronyms) at a rate: Perfect … Miss, ms of song. */
export function maniaWindows(od: number, mods: string[], rate: number): number[] {
  const difficulty = mods.includes("HR") ? 1.4 : mods.includes("EZ") ? 1 / 1.4 : 1;
  const total = rate / difficulty;
  const w = (v: number) => Math.floor(v * total) + 0.5;
  if (mods.includes("CL")) {
    const inv = Math.min(10, Math.max(0, 10 - od));
    return [16, 34 + 3 * inv, 67 + 3 * inv, 97 + 3 * inv, 121 + 3 * inv, 158 + 3 * inv].map(w);
  }
  return RANGES.map((r) => w(range(od, r)));
}

/** Mods that change the chart in ways Fumen doesn't replay (column shuffles, other key counts, …). */
const UNREPLAYED = new Set(["RD", "IN", "NR", "CS", "DS", "1K", "2K", "3K", "4K", "5K", "6K", "7K", "8K", "9K", "10K"]);

/** The mods of a score that keep it from being replayed here (empty: it can be). */
export function unreplayed(mods: string[]): string[] {
  return mods.filter((m) => UNREPLAYED.has(m));
}

/** The chart's notes as the score played them: Hold Off (ManiaModHoldOff) turns holds into notes. */
export function playedNotes(notes: ArrayLike<number>, mods: string[]): ArrayLike<number> {
  if (!mods.includes("HO")) return notes;
  const out = Float64Array.from(notes);
  for (let i = 2; i < out.length; i += 3) out[i] = 0;
  return out;
}

/** HitWindows.ResultFor: the best result whose window holds the offset, or -1 */
function resultFor(windows: number[], offset: number): Result | -1 {
  const a = Math.abs(offset);
  for (let r = 0; r < windows.length; r++) if (a <= windows[r]) return r as Result;
  return -1;
}

export interface Judgement {
  /** when it was judged, song ms */
  time: number;
  result: Result;
  /** how early (−) or late (+), ms of song; NaN when nothing was pressed */
  offset: number;
  col: number;
  /** the object (index into the chart's notes / 3) */
  obj: number;
  tail: boolean;
}

/** Something else that counts towards the accuracy (osu!'s slider ticks and ends). */
export interface AccuracyPart {
  time: number;
  score: number;
  max: number;
}

/** The running counts and accuracy of a replay's judgements (sorted by time). */
export class Tally {
  private readonly times: Float64Array;
  private readonly counts: Uint32Array;
  private readonly scores: Float64Array;
  private readonly partTimes: Float64Array;
  private readonly partScores: Float64Array;
  private readonly partMax: Float64Array;

  /** `score`: each result's base score, `max` the best one's; `parts` (sorted by time) count too */
  constructor(
    judgements: readonly Judgement[],
    private readonly score: readonly number[],
    private readonly max: number,
    parts: readonly AccuracyPart[] = [],
  ) {
    this.partTimes = Float64Array.from(parts.map((p) => p.time));
    this.partScores = new Float64Array(parts.length + 1);
    this.partMax = new Float64Array(parts.length + 1);
    parts.forEach((p, i) => {
      this.partScores[i + 1] = this.partScores[i] + p.score;
      this.partMax[i + 1] = this.partMax[i] + p.max;
    });
    this.times = Float64Array.from(judgements.map((j) => j.time));
    this.counts = new Uint32Array((judgements.length + 1) * 6);
    this.scores = new Float64Array(judgements.length + 1);
    judgements.forEach((j, i) => {
      for (let r = 0; r < 6; r++) this.counts[(i + 1) * 6 + r] = this.counts[i * 6 + r];
      this.counts[(i + 1) * 6 + j.result]++;
      this.scores[i + 1] = this.scores[i] + this.score[j.result];
    });
  }

  /** How many judgements happened by `t`. */
  upTo(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The counts per result, the accuracy (0–1) and how many were judged, by `t`. */
  stats(t: number): { counts: number[]; accuracy: number; judged: number } {
    const i = this.upTo(t);
    const counts = Array.from(this.counts.subarray(i * 6, i * 6 + 6));
    const k = upperOf(this.partTimes, t);
    const max = i * this.max + this.partMax[k];
    return { counts, accuracy: max ? (this.scores[i] + this.partScores[k]) / max : 1, judged: i };
  }
}

/** First index whose value is > t in a sorted array. */
function upperOf(a: Float64Array, t: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A mania replay, judged: the timeline the playfield draws (keys, hits, what's gone) and the
 * judgements. `notes` is the chart's [time, column, length] per object; `frames` the replay's
 * [time, x, y, buttons] (x: the keys down, bit n for column n).
 */
export class ManiaReplay {
  /** per column: [press, release, …] */
  readonly presses: Float64Array[];
  /** per column: times of judged hits (not misses), sorted */
  readonly hits: Float64Array[];
  readonly allHits: Float64Array;
  /** every judgement, by time */
  readonly judgements: Judgement[];
  /** the results it judges with, best first */
  readonly results: readonly Result[] = [0, 1, 2, 3, 4, 5];
  private readonly tally: Tally;
  /** per object: when it's gone (hit), Infinity when it scrolls on (missed) */
  private readonly goneAt: Float64Array;
  /** per object: [from, to] while held, flat */
  private readonly holding: Map<number, number[]>;

  constructor(
    notes: ArrayLike<number>,
    keys: number,
    frames: ArrayLike<number>,
    readonly windows: number[],
  ) {
    const n = notes.length / 3;
    // the keys: presses and releases per column
    const presses: number[][] = Array.from({ length: keys }, () => []);
    let down = 0;
    for (let i = 0; i < frames.length; i += 4) {
      const t = frames[i];
      const now = Math.max(0, Math.round(frames[i + 1])) & ((1 << keys) - 1);
      const changed = now ^ down;
      for (let c = 0; c < keys; c++) if (changed & (1 << c)) presses[c].push(t);
      down = now;
    }
    for (const p of presses) if (p.length % 2) p.push(Infinity);

    const goneAt = new Float64Array(n).fill(Infinity);
    const holding = new Map<number, number[]>();
    const judgements: Judgement[] = [];
    const judge = (time: number, result: Result, offset: number, col: number, obj: number, tail: boolean) => {
      judgements.push({ time, result, offset, col, obj, tail });
      if (result !== MISS) goneAt[obj] = time;
    };

    for (let col = 0; col < keys; col++) {
      const objs: number[] = [];
      for (let o = 0; o < n; o++) if (notes[o * 3 + 1] === col) objs.push(o);
      objs.sort((a, b) => notes[a * 3] - notes[b * 3]);
      // the one being judged, and its state
      let k = 0;
      let headDone = false;
      let headMissed = false;
      let broke = false;
      let held = -1;
      const W = this.windows;
      const start = (o: number) => notes[o * 3];
      const end = (o: number) => notes[o * 3] + notes[o * 3 + 2];
      const isHold = (o: number) => notes[o * 3 + 2] > 0;
      const next = () => {
        k++;
        headDone = headMissed = broke = false;
        held = -1;
      };
      const stopHolding = (o: number, at: number) => {
        if (held < 0) return;
        const list = holding.get(o) ?? [];
        list.push(held, at);
        holding.set(o, list);
        held = -1;
      };
      /** judges what's left alone until `until` */
      const settle = (until: number) => {
        while (k < objs.length) {
          const o = objs[k];
          if (!headDone) {
            const due = start(o) + W[MEH];
            if (!(due < until)) return;
            judge(due, MISS, NaN, col, o, false);
            headDone = headMissed = true;
            if (!isHold(o)) next();
            continue;
          }
          const due = end(o) + W[MEH] * LENIENCE;
          if (!(due < until)) return;
          stopHolding(o, due);
          judge(due, MISS, NaN, col, o, true);
          next();
        }
      };
      const p = presses[col];
      for (let i = 0; i < p.length; i += 2) {
        // press
        const at = p[i];
        settle(at);
        if (k < objs.length) {
          const o = objs[k];
          if (!headDone) {
            const r = resultFor(W, at - start(o));
            if (r >= 0) {
              headDone = true;
              headMissed = r === MISS;
              if (isHold(o)) {
                judgements.push({ time: at, result: r as Result, offset: at - start(o), col, obj: o, tail: false });
                held = at;
              } else {
                judge(at, r as Result, at - start(o), col, o, false);
                next();
              }
            }
          } else if (isHold(o) && !(at > end(o) && resultFor(W, (at - end(o)) / LENIENCE) < 0)) held = at;
        }
        // release
        const up = p[i + 1];
        if (!Number.isFinite(up)) continue;
        settle(up);
        if (k < objs.length && held >= 0) {
          const o = objs[k];
          stopHolding(o, up);
          let r = resultFor(W, (up - end(o)) / LENIENCE);
          if (r >= 0) {
            if (r !== MISS && (headMissed || broke)) r = MEH;
            judge(up, r as Result, up - end(o), col, o, true);
            next();
          } else broke = true;
        }
      }
      settle(Infinity);
    }
    judgements.sort((a, b) => a.time - b.time || a.obj - b.obj);

    this.presses = presses.map((x) => Float64Array.from(x));
    const hits: number[][] = Array.from({ length: keys }, () => []);
    for (const j of judgements) if (j.result !== MISS) hits[j.col].push(j.time);
    this.hits = hits.map((h) => Float64Array.from(h));
    this.allHits = Float64Array.from(judgements.filter((j) => j.result !== MISS).map((j) => j.time));
    this.judgements = judgements;
    this.goneAt = goneAt;
    this.holding = holding;
    this.tally = new Tally(judgements, SCORE, SCORE[0]);
  }

  /** The windows on the error bar, widest first: [result, window]. */
  barWindows(): [Result, number][] {
    return ([4, 3, 2, 1, 0] as Result[]).map((r) => [r, this.windows[r]]);
  }

  /** The column's key at `t`: down or not, and when it last went down / up. */
  key(col: number, t: number): { down: boolean; pressed: number; released: number } {
    const p = this.presses[col];
    let lo = 0;
    let hi = p.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid * 2] <= t) lo = mid + 1;
      else hi = mid;
    }
    const k = lo - 1;
    if (k < 0) return { down: false, pressed: -Infinity, released: -Infinity };
    const pressed = p[k * 2];
    const released = p[k * 2 + 1];
    return t < released ? { down: true, pressed, released: k > 0 ? p[k * 2 - 1] : -Infinity } : { down: false, pressed, released };
  }

  lastHit(t: number): number {
    const j = this.judgement(t);
    return j ? j.time : -Infinity;
  }

  /** The latest judgement at or before `t`. */
  judgement(t: number): { time: number; result: Result } | null {
    const i = this.tally.upTo(t);
    return i > 0 ? this.judgements[i - 1] : null;
  }

  /** When the object is gone from the playfield (hit), Infinity while it scrolls on. */
  gone(obj: number): number {
    return this.goneAt[obj];
  }

  /** Whether a hold is held at `t`. */
  held(obj: number, t: number): boolean {
    const h = this.holding.get(obj);
    if (!h) return false;
    for (let i = 0; i < h.length; i += 2) if (t >= h[i] && t < h[i + 1]) return true;
    return false;
  }

  /** The counts per result, the accuracy (0–1) and how many were judged, by `t`. */
  stats(t: number): { counts: number[]; accuracy: number; judged: number } {
    return this.tally.stats(t);
  }
}
