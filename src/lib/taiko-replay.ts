/* taiko-replay.ts — an osu!taiko replay judged the way lazer judges it (MIT, ppy Pty Ltd), for the
 * playfield: when each drum key was hit, every note's result, the drum roll ticks and swell hits
 * it got, the accuracy as it goes.
 *
 *  - Hit windows: TaikoHitWindows. Great, Ok and Miss from OD (lazer's DifficultyRange), each
 *    floored, less half a millisecond; the rate doesn't change them.
 *  - Keys (TaikoReplayFrame.FromLegacy): Right1 left rim, Right2 right rim, Left1 left centre,
 *    Left2 right centre, pressed in that order within a frame.
 *  - A press goes to the objects in order, earliest first, until one takes it (lazer's input
 *    queue): a note inside its miss window takes it, Great / Ok by distance, Miss when early
 *    past Ok or with the wrong colour (DrawableHit). A note left alone past Ok is missed. A
 *    note already pressed in this frame takes any other press of the frame, so two keys at once
 *    judge one note.
 *  - Strong notes: a second key of the same colour within 30 ms of the first, while that one is
 *    still down, is a strong hit (StrongNestedHit).
 *  - Drum rolls: each tick is hit by any press within half the tick spacing (DrawableDrumRollTick).
 *  - Swells: from their start, each press alternating centre and rim counts once per frame;
 *    enough of them by the end clears it (DrawableSwell).
 *  - Relax: any key hits any note, and swells don't need alternating.
 *  - Accuracy: Great 300, Ok 150, of 300 per note.
 */
import type { TaikoChartData } from "./types";
import { MISS, Tally, type Judgement, type Result } from "./replay";

const CENTRE = 0;
const RIM = 1;
const ROLL = 2;
const SWELL = 3;
/** our results: lazer's Great and Ok */
const GREAT: Result = 1;
const OK: Result = 3;
const SCORE = [0, 300, 0, 150, 0, 0];
/** DrawableHit.StrongNestedHit.SECOND_HIT_WINDOW */
const SECOND_HIT_WINDOW = 30;

/** lazer's TaikoAction, as bits (as in ui/taiko/chart.ts) */
const LEFT_CENTRE = 1;
const RIGHT_CENTRE = 2;
const LEFT_RIM = 4;
const RIGHT_RIM = 8;
const KEYS = [LEFT_CENTRE, RIGHT_CENTRE, LEFT_RIM, RIGHT_RIM];
/** legacy buttons → actions, in FromLegacy's order: [button bit, action] */
const LEGACY: [number, number][] = [
  [2, LEFT_RIM],
  [8, RIGHT_RIM],
  [1, LEFT_CENTRE],
  [4, RIGHT_CENTRE],
];
/** further ahead than any window: objects past this are left alone */
const REACH = 2000;

/** IBeatmapDifficultyInfo.DifficultyRange */
function range(od: number, min: number, mid: number, max: number): number {
  if (od > 5) return mid + ((max - mid) * (od - 5)) / 5;
  if (od < 5) return mid + ((mid - min) * (od - 5)) / 5;
  return mid;
}

/** The OD a score plays at: Hard Rock ×1.4 up to 10, Easy halved. */
export function taikoOd(od: number, mods: string[]): number {
  if (mods.includes("HR")) return Math.min(10, od * 1.4);
  if (mods.includes("EZ")) return od * 0.5;
  return od;
}

/** TaikoHitWindows for an OD: [Great, Ok, Miss], ms of song. */
export function taikoWindows(od: number): number[] {
  return [range(od, 50, 35, 20), range(od, 120, 80, 50), range(od, 135, 95, 70)].map((v) => Math.floor(v) - 0.5);
}

/** Mods that change the chart (or the input) in ways Fumen doesn't replay. */
const UNREPLAYED = new Set(["RD", "SW", "SR", "SG"]);

/** The mods of an osu!taiko score that keep it from being replayed here (empty: it can be). */
export function taikoUnreplayed(mods: string[]): string[] {
  return mods.filter((m) => UNREPLAYED.has(m));
}

/**
 * An osu!taiko replay, judged. `chart` is the chart as Fumen builds it (src-tauri/src/taiko.rs),
 * `frames` the replay's [time, x, y, buttons], `od` the score's (taikoOd).
 */
export class TaikoReplay {
  readonly windows: number[];
  /** every note's judgement, by time (col: 0 centre, 1 rim) */
  readonly judgements: Judgement[];
  readonly results: readonly Result[] = [GREAT, OK, MISS];
  /** per key (KEYS order): press times */
  readonly keyPresses: Float64Array[];
  /** per object: when it was hit (NaN unless it was) */
  readonly hitAt: Float64Array;
  /** per object: when it was missed (NaN unless it was) */
  readonly missAt: Float64Array;
  /** per object: its result (Great / Ok / Miss), -1 before it's judged or for rolls and swells */
  readonly result: Int8Array;
  /** per strong note: when the second key landed (NaN if it didn't) */
  readonly strongAt: Float64Array;
  /** per drum roll tick: when it was hit (NaN if it wasn't), when it was missed, and whether a rim key hit it */
  readonly tickAt: Float64Array;
  readonly tickMissAt: Float64Array;
  readonly tickRim: Uint8Array;
  /** per swell: when it was cleared or missed, and whether it was cleared */
  readonly swellAt: Float64Array;
  readonly cleared: Uint8Array;
  /** lazer's bonus counts: strong hits, strong ticks and cleared swells; drum roll ticks */
  readonly largeBonus: number;
  readonly smallBonus: number;
  private readonly swellPresses = new Map<number, number[]>();
  private readonly tally: Tally;

  constructor(chart: TaikoChartData, frames: ArrayLike<number>, od: number, mods: string[]) {
    const W = (this.windows = taikoWindows(od));
    const relax = mods.includes("RX");
    const o = chart.objects;
    const n = o.length / 5;
    const time = (i: number) => o[i * 5];
    const kind = (i: number) => o[i * 5 + 1];
    const end = (i: number) => o[i * 5 + 2];
    const strong = (i: number) => (o[i * 5 + 3] & 1) === 1;
    const ticks = chart.ticks;
    // each roll's ticks and window (half the spacing)
    const tickFrom = new Uint32Array(n);
    const tickTo = new Uint32Array(n);
    const tickWindow = new Float64Array(n);
    const rolls: number[] = [];
    for (let i = 0; i < n; i++) if (kind(i) === ROLL) rolls.push(i);
    rolls.forEach((r, k) => {
      tickFrom[r] = o[r * 5 + 4];
      tickTo[r] = k + 1 < rolls.length ? o[rolls[k + 1] * 5 + 4] : ticks.length;
      const spacing = chart.spacing?.[k] ?? (tickTo[r] - tickFrom[r] > 1 ? ticks[tickFrom[r] + 1] - ticks[tickFrom[r]] : 2 * (end(r) - time(r)));
      tickWindow[r] = spacing / 2;
    });

    const hitAt = (this.hitAt = new Float64Array(n).fill(NaN));
    const missAt = (this.missAt = new Float64Array(n).fill(NaN));
    const result = (this.result = new Int8Array(n).fill(-1));
    const strongAt = (this.strongAt = new Float64Array(n).fill(NaN));
    const tickAt = (this.tickAt = new Float64Array(ticks.length).fill(NaN));
    const tickMissAt = (this.tickMissAt = new Float64Array(ticks.length).fill(NaN));
    const tickRim = (this.tickRim = new Uint8Array(ticks.length));
    const swellAt = (this.swellAt = new Float64Array(n).fill(NaN));
    const cleared = (this.cleared = new Uint8Array(n));
    const judgements: Judgement[] = [];
    // the state lazer's drawables keep
    const lastPress = new Float64Array(n).fill(NaN);
    const hitAction = new Int8Array(n);
    /** strong notes hit, still open to a second key */
    let waiting: number[] = [];
    /** strong notes: 0 waiting, 1 hit, 2 missed */
    const strongState = new Uint8Array(n);
    const tickDone = new Uint8Array(ticks.length);
    const swellHits = new Uint32Array(n);
    /** swells: the last counted press was a centre (1), a rim (2), none yet (0) */
    const lastWasCentre = new Uint8Array(n);
    let large = 0;
    let small = 0;

    const judge = (i: number, at: number, r: Result, offset: number) => {
      result[i] = r;
      judgements.push({ time: at, result: r, offset, col: kind(i), obj: i, tail: false });
      if (r === MISS) missAt[i] = at;
      else hitAt[i] = at;
    };
    /** what lazer's updates judged on their own before `t` */
    const settle = (i: number, t: number) => {
      const k = kind(i);
      if (k <= RIM) {
        if (result[i] < 0 && t - time(i) > W[1]) judge(i, time(i) + W[1], MISS, NaN);
        if (strong(i) && result[i] >= 0 && strongState[i] === 0 && (result[i] === MISS || t - hitAt[i] > SECOND_HIT_WINDOW)) strongState[i] = 2;
      } else if (k === ROLL) {
        for (let j = tickFrom[i]; j < tickTo[i]; j++) {
          if (tickDone[j] || !(t - ticks[j] > tickWindow[i])) continue;
          tickDone[j] = 1;
          tickMissAt[j] = ticks[j] + tickWindow[i];
        }
      } else if (k === SWELL && Number.isNaN(swellAt[i]) && t > end(i)) {
        swellAt[i] = end(i);
        // a press at the end itself still counted
        cleared[i] = swellHits[i] >= o[i * 5 + 4] ? 1 : 0;
        if (cleared[i]) large++;
      }
    };
    const hits = (i: number, action: number) =>
      relax || (kind(i) === CENTRE ? action === LEFT_CENTRE || action === RIGHT_CENTRE : action === LEFT_RIM || action === RIGHT_RIM);

    // objects before `lo` are over (judged and long gone)
    let lo = 0;
    const press = (t: number, action: number) => {
      while (lo < n && Math.max(end(lo), time(lo)) + REACH < t) lo++;
      for (let i = lo; i < n && time(i) <= t + REACH; i++) {
        settle(i, t);
        const k = kind(i);
        if (k <= RIM) {
          // its strong hit takes the press before the note does
          if (strong(i) && strongState[i] === 0 && result[i] >= 0 && result[i] !== MISS && hitAction[i] && hits(i, action) && Math.abs(t - hitAt[i]) <= SECOND_HIT_WINDOW) {
            strongState[i] = 1;
            strongAt[i] = t;
            large++;
            return;
          }
          if (lastPress[i] === t) return;
          if (result[i] >= 0) continue;
          const offset = t - time(i);
          const a = Math.abs(offset);
          lastPress[i] = t;
          if (a > W[2]) continue;
          if (!hits(i, action)) judge(i, t, MISS, offset);
          else {
            judge(i, t, a <= W[0] ? GREAT : a <= W[1] ? OK : MISS, offset);
            if (result[i] !== MISS) {
              hitAction[i] = action;
              if (strong(i)) waiting.push(i);
            }
          }
          return;
        }
        if (k === ROLL) {
          // later ticks are asked first
          for (let j = tickTo[i] - 1; j >= tickFrom[i]; j--) {
            if (tickDone[j] || Math.abs(t - ticks[j]) > tickWindow[i]) continue;
            tickDone[j] = 1;
            tickAt[j] = t;
            tickRim[j] = action === LEFT_RIM || action === RIGHT_RIM ? 1 : 0;
            small++;
            if (strong(i)) large++;
            return;
          }
          continue;
        }
        if (k === SWELL) {
          if (t < time(i) || !Number.isNaN(swellAt[i])) continue;
          const centre = action === LEFT_CENTRE || action === RIGHT_CENTRE ? 1 : 2;
          if (!relax && lastWasCentre[i] === centre) continue;
          if (lastPress[i] === t) return;
          lastWasCentre[i] = centre;
          lastPress[i] = t;
          swellHits[i]++;
          let list = this.swellPresses.get(i);
          if (!list) this.swellPresses.set(i, (list = []));
          list.push(t);
          if (swellHits[i] >= o[i * 5 + 4]) {
            swellAt[i] = t;
            cleared[i] = 1;
            large++;
          }
          return;
        }
      }
    };
    const release = (action: number) => {
      waiting = waiting.filter((i) => strongState[i] === 0);
      for (const i of waiting) if (hitAction[i] === action) hitAction[i] = 0;
    };

    const keyPresses: number[][] = [[], [], [], []];
    let down = 0;
    for (let f = 0; f < frames.length; f += 4) {
      const t = frames[f];
      const buttons = Math.max(0, Math.round(frames[f + 3]));
      let now = 0;
      for (const [bit, action] of LEGACY) if (buttons & bit) now |= action;
      for (const [, action] of LEGACY) if (down & action && !(now & action)) release(action);
      for (const [, action] of LEGACY) {
        if (!(now & action) || down & action) continue;
        keyPresses[KEYS.indexOf(action)].push(t);
        press(t, action);
      }
      down = now;
    }
    for (let i = 0; i < n; i++) settle(i, Infinity);
    judgements.sort((a, b) => a.time - b.time || a.obj - b.obj);

    this.judgements = judgements;
    this.keyPresses = keyPresses.map((k) => Float64Array.from(k));
    this.largeBonus = large;
    this.smallBonus = small;
    this.tally = new Tally(judgements, SCORE, 300);
  }

  /** The windows on the error bar, widest first: [result, window]. */
  barWindows(): [Result, number][] {
    return [
      [OK, this.windows[1]],
      [GREAT, this.windows[0]],
    ];
  }

  /** The swell's counted presses. */
  swellPressTimes(i: number): number[] {
    return this.swellPresses.get(i) ?? [];
  }

  /** The counts per result, the accuracy (0–1) and how many were judged, by `t`. */
  stats(t: number): { counts: number[]; accuracy: number; judged: number } {
    return this.tally.stats(t);
  }
}
