/* score-review.ts — what a play says when it's looked at afterwards: its replay judged the way
 * lazer judges it (lib/replay and the other rulesets'), where the accuracy went (a loss per second
 * and the worst stretches, with osu!mania's pattern names), and how the timing leaned.
 *
 * The loss of a judgement is what it fell short of the best result, as a share of it (a Great in
 * osu!mania loses 5/305, a Miss everything); a stretch's loss in accuracy points is its losses over
 * all judgements of the play. */
import { maniaWindows, ManiaReplay, MISS, playedNotes, type Judgement } from "./replay";
import { CatchReplay } from "./catch-replay";
import { OsuReplay, osuOd } from "./osu-replay";
import { TaikoReplay, taikoOd } from "./taiko-replay";
import { OsuChart } from "../ui/osu/chart";
import { CatchChart } from "../ui/catch/chart";
import type { ChartData } from "./types";

const OSU = 0;
const TAIKO = 1;
const CATCH = 2;
const MANIA = 3;

/** what each result keeps of the best one, per ruleset (index: the result) */
const KEEP: Record<number, readonly number[]> = {
  [MANIA]: [1, 300 / 305, 200 / 305, 100 / 305, 50 / 305, 0],
  [OSU]: [1, 1, 1, 1 / 3, 1 / 6, 0],
  [TAIKO]: [1, 1, 1, 0.5, 1, 0],
  [CATCH]: [1, 1, 1, 1, 1, 0],
};

/** a worst stretch is at most this long, s */
const STRETCH = 4;
/** a stretch is worth naming when it loses this many times an even share */
const NOTABLE = 2.5;

export type Judged = ManiaReplay | TaikoReplay | OsuReplay | CatchReplay;

export interface LossStretch {
  /** song ms */
  start: number;
  end: number;
  /** accuracy points lost there (0–1 of the play's accuracy) */
  loss: number;
  misses: number;
  /** judgements below the best result */
  slips: number;
  /** osu!mania: what the chart does there */
  pattern: string | null;
}

export interface Timing {
  /** real ms, + late */
  mean: number;
  /** unstable rate (10 × the spread of the hit errors, real ms) */
  ur: number;
  early: number;
  late: number;
}

export interface Review {
  replay: Judged;
  /** counts per result (index: the result) and the play's accuracy, as judged here */
  counts: number[];
  accuracy: number;
  /** song ms of every miss */
  misses: number[];
  /** the accuracy lost in each second of the song (0–1 of the play's accuracy) */
  loss: number[];
  /** the worst stretches, worst first */
  stretches: LossStretch[];
  timing: Timing | null;
}

/** The play's replay judged on its chart (the chart already built with the score's chart mods). */
export function judge(d: ChartData, od: number, mods: string[], rate: number, frames: number[]): Judged | null {
  if (d.mode === MANIA && d.keys > 0) {
    const notes = playedNotes(d.notes, mods);
    return new ManiaReplay(notes, d.keys, frames, maniaWindows(od, mods, rate));
  }
  if (d.mode === TAIKO && d.taiko) return new TaikoReplay(d.taiko, frames, taikoOd(od, mods), mods);
  if (d.mode === OSU && d.osu) return new OsuReplay(new OsuChart(d), frames, osuOd(od, mods), rate);
  if (d.mode === CATCH && d.catch) return new CatchReplay(new CatchChart(d), frames);
  return null;
}

/** Everything the score page shows about where the accuracy went. */
export function review(d: ChartData, replay: Judged, rate: number): Review {
  const js = replay.judgements as readonly Judgement[];
  const stats = replay.stats(Infinity);
  const keep = KEEP[d.mode] ?? KEEP[MANIA];
  const seconds = Math.max(1, Math.ceil((d.analysis.end + 1000) / 1000));
  const loss = new Array<number>(seconds).fill(0);
  const misses: number[] = [];
  const missAt = new Array<number>(seconds).fill(0);
  const slipAt = new Array<number>(seconds).fill(0);
  for (const j of js) {
    const s = Math.min(seconds - 1, Math.max(0, Math.floor(j.time / 1000)));
    const l = 1 - (keep[j.result] ?? 1);
    if (j.result === MISS) {
      misses.push(j.time);
      missAt[s]++;
    } else if (l > 0) slipAt[s]++;
    loss[s] += l;
  }
  const total = js.length || 1;
  for (let i = 0; i < seconds; i++) loss[i] /= total;
  return { replay, counts: stats.counts, accuracy: stats.accuracy, misses, loss, stretches: stretches(d, loss, missAt, slipAt), timing: timing(js, rate) };
}

/** The worst stretches of up to STRETCH seconds, apart from each other, worst first. */
export function stretches(d: ChartData, loss: number[], missAt: number[], slipAt: number[], max = 3): LossStretch[] {
  const sum = (a: number[], i: number) => a.slice(i, i + STRETCH).reduce((x, y) => x + y, 0);
  const taken = new Array<boolean>(loss.length).fill(false);
  const out: LossStretch[] = [];
  const all = loss.reduce((a, b) => a + b, 0);
  // what a stretch would lose if the losses were spread evenly over the song
  const even = (all * STRETCH) / Math.max(1, loss.filter((_, i) => i * 1000 >= d.analysis.start - 1000).length);
  while (out.length < max) {
    let best = -1;
    let bestLoss = 0;
    for (let i = 0; i + 1 <= loss.length; i++) {
      if (taken.slice(i, i + STRETCH).some(Boolean)) continue;
      const l = sum(loss, i);
      if (l > bestLoss + 1e-12) {
        best = i;
        bestLoss = l;
      }
    }
    // nothing left worth naming: not well above an even spread of the losses, or under 0.1 points
    if (best < 0 || bestLoss < Math.max(NOTABLE * even, 0.001)) break;
    // trim seconds without losses at both ends
    let a = best;
    let b = Math.min(loss.length, best + STRETCH) - 1;
    while (a < b && loss[a] === 0) a++;
    while (b > a && loss[b] === 0) b--;
    for (let i = Math.max(0, a - STRETCH + 1); i <= b; i++) taken[i] = true;
    out.push({
      start: a * 1000,
      end: (b + 1) * 1000,
      loss: bestLoss,
      misses: missAt.slice(a, b + 1).reduce((x, y) => x + y, 0),
      slips: slipAt.slice(a, b + 1).reduce((x, y) => x + y, 0),
      pattern: patternAt(d, a * 1000, (b + 1) * 1000),
    });
  }
  return out;
}

/** osu!mania: the pattern most of a stretch is (ManiaMapAnalyser's seconds), else the analysis' windows. */
export function patternAt(d: ChartData, start: number, end: number): string | null {
  const rep = d.report;
  const count = new Map<string, number>();
  if (rep?.seconds && rep.labels) {
    const from = rep.start ?? d.analysis.start;
    for (let t = start; t < end; t += 1000) {
      const i = rep.seconds[Math.floor((t - from) / 1000)] ?? -1;
      if (i >= 0 && rep.labels[i]) count.set(rep.labels[i], (count.get(rep.labels[i]) ?? 0) + 1);
    }
  } else if (d.analysis.windows) {
    for (let t = start; t < end; t += 1000) {
      const w = d.analysis.windows[Math.floor((t - d.analysis.start) / 1000)];
      if (w) count.set(w, (count.get(w) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of count) if (v > n) [best, n] = [k, v];
  return best;
}

/** How the hits leaned: the mean error and the unstable rate, in real ms. */
export function timing(js: readonly Judgement[], rate: number): Timing | null {
  const off = js.filter((j) => !j.tail && j.result !== MISS && Number.isFinite(j.offset)).map((j) => j.offset / rate);
  if (off.length < 10) return null;
  const mean = off.reduce((a, b) => a + b, 0) / off.length;
  const sd = Math.sqrt(off.reduce((a, b) => a + (b - mean) ** 2, 0) / off.length);
  return { mean, ur: sd * 10, early: off.filter((o) => o < 0).length, late: off.filter((o) => o > 0).length };
}

/** A rate worth trying next, from how the play went: faster when it was nearly perfect, slower to
 * practise when it was rough (osu!mania; null for the rest or when the play was fine). */
export function rateHint(mode: number, accuracy: number, rate: number): number | null {
  if (mode !== MANIA) return null;
  const r = (v: number) => Math.round(v * 20) / 20;
  if (accuracy >= 0.985 && rate < 2) return r(rate + 0.1);
  if (accuracy < 0.93 && rate > 0.5) return r(rate - 0.1);
  return null;
}
