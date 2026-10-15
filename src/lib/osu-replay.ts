/* osu-replay.ts — an osu! replay judged the way lazer judges it (MIT, ppy Pty Ltd), for the
 * playfield: every circle's, slider head's and spinner's result, when each slider was followed,
 * its ticks and ends, the accuracy as it goes.
 *
 *  - Hit windows: OsuHitWindows. Great, Ok and Meh from OD (lazer's DifficultyRange), each
 *    floored, less half a millisecond; a press up to 400 ms early is a miss. The rate doesn't
 *    change them.
 *  - Buttons (OsuReplayFrame.FromLegacy): M1 / K1 the left button, M2 / K2 the right one.
 *  - A press goes to the earliest circle (or slider head) under the cursor that's still to be
 *    judged (DrawableHitCircle.HitReceptor), the cursor within its radius. Note lock
 *    (StartTimeOrderedHitPolicy): while an earlier circle waits, it's blocked before that circle's
 *    time; a hit misses every earlier circle still waiting. A circle left alone past Meh is missed.
 *  - Sliders (SliderInputManager): followed while a button is down and the cursor within the
 *    ball's radius (2.4× once following); after the head is hit only its button counts, until the
 *    other one has been let go. Ticks and repeats are judged at their time, the tail 36 ms before
 *    the end (after the last tick), all once the head is judged: hit if followed then. A late head
 *    takes the ticks it passed if the cursor was on all of them.
 *  - Spinners (SpinnerRotationTracker, SpinnerSpinHistory): the angle the cursor turns around the
 *    spinner while a button is down, times the rate; spins back undo spins forward. (The game judged
 *    the score from every mouse movement; a replay keeps 60 a second, so a long spinner can come
 *    out a bonus spin or two short here.) Great with all
 *    the spins needed, Ok past 90 %, Meh past 75 %.
 *  - Accuracy: Great 300, Ok 100, Meh 50 per circle, slider head and spinner, with slider ticks
 *    and repeats (30) and slider ends (150).
 */
import { CIRCLE, OBJECT_RADIUS, OsuChart, SLIDER, SPINNER, SpinHistory, type Slider } from "../ui/osu/chart";
import { MISS, Tally, type AccuracyPart, type Judgement, type Result } from "./replay";

/** our results: lazer's Great, Ok, Meh */
const GREAT: Result = 1;
const OK: Result = 3;
const MEH: Result = 4;
const SCORE = [0, 300, 0, 100, 50, 0];
/** OsuHitWindows.MISS_WINDOW */
const MISS_WINDOW = 400;
/** DrawableSliderBall.FOLLOW_AREA */
const FOLLOW_AREA = 2.4;
/** SliderEventGenerator.TAIL_LENIENCY */
const TAIL_LENIENCY = -36;
/** base scores of slider ticks / repeats and slider ends */
const TICK_SCORE = 30;
const TAIL_SCORE = 150;
/** OsuAction, as bits */
const LEFT = 1;
const RIGHT = 2;

/** IBeatmapDifficultyInfo.DifficultyRange */
function range(od: number, min: number, mid: number, max: number): number {
  if (od > 5) return mid + ((max - mid) * (od - 5)) / 5;
  if (od < 5) return mid + ((mid - min) * (od - 5)) / 5;
  return mid;
}

/** The OD a score plays at: Hard Rock ×1.4 up to 10, Easy halved. */
export function osuOd(od: number, mods: string[]): number {
  if (mods.includes("HR")) return Math.min(10, od * 1.4);
  if (mods.includes("EZ")) return od * 0.5;
  return od;
}

/** OsuHitWindows for an OD: [Great, Ok, Meh], ms of song. */
export function osuWindows(od: number): number[] {
  return [range(od, 80, 50, 20), range(od, 140, 100, 60), range(od, 200, 150, 100)].map((v) => Math.floor(v) - 0.5);
}

/** Mods that move things, take over input or change the rules in ways Fumen doesn't replay. */
const UNREPLAYED = new Set(["RD", "RX", "AP", "SO", "CL", "DA", "TP", "MG", "RP", "DP", "TR", "WG", "BR", "SG", "AL", "ST", "AS", "WU", "WD"]);

/** The mods of an osu! score that keep it from being replayed here (empty: it can be). */
export function osuUnreplayed(mods: string[]): string[] {
  return mods.filter((m) => UNREPLAYED.has(m));
}

/** A slider's tick, repeat or end. */
export interface Nested {
  /** 0 tick, 1 repeat, 2 tail */
  kind: 0 | 1 | 2;
  time: number;
  /** where it sits on the path (0–1) */
  progress: number;
  /** when it was judged (NaN until then) and how */
  judgedAt: number;
  hit: boolean;
}

interface SliderState {
  i: number;
  s: Slider;
  nested: Nested[];
  /** the latest tick or repeat (the tail waits for it) */
  lastTick: Nested | null;
  tracking: boolean;
  acceptAnyAfter: number | null;
  lastPressed: number;
  /** the slider's own result (when its end was reached) */
  done: boolean;
}

/**
 * An osu! replay, judged. `chart` is the playfield's chart (the score's mods built in), `frames`
 * the replay's [time, x, y, buttons], `od` the score's (osuOd), `rate` its speed.
 */
export class OsuReplay {
  readonly windows: number[];
  /** every circle's, slider head's and spinner's judgement, by time */
  readonly judgements: Judgement[];
  readonly results: readonly Result[] = [GREAT, OK, MEH, MISS];
  /** the score's rate */
  readonly rate: number;
  /** the cursor for the playfield: [time, x, y, buttons (1 left, 2 right)] */
  readonly frames: number[];
  /** per object: when its circle (or head) was hit / missed (NaN unless), its result, how far off */
  readonly hitAt: Float64Array;
  readonly missAt: Float64Array;
  readonly result: Int8Array;
  readonly offset: Float64Array;
  /** sliders: [from, to] while followed, flat; their ticks, repeats and ends */
  readonly follow = new Map<number, number[]>();
  readonly nested = new Map<number, Nested[]>();
  /** spinners: when judged, and how far they were turned by then (degrees, as lazer counts them) */
  readonly spinnerAt: Float64Array;
  readonly spinTotal: Float64Array;
  /** lazer's other counts: ticks and repeats hit / missed, ends hit, spinner spins and bonus spins */
  readonly largeTickHit: number;
  readonly largeTickMiss: number;
  readonly sliderTailHit: number;
  readonly smallBonus: number;
  readonly largeBonus: number;
  private readonly tally: Tally;

  constructor(chart: OsuChart, frames: ArrayLike<number>, od: number, rate: number) {
    const W = (this.windows = osuWindows(od));
    this.rate = rate;
    const n = chart.n;
    const radius = OBJECT_RADIUS * chart.scale;
    const preempt = chart.preempt;
    const time = chart.time;
    const kind = chart.kind;
    const hitAt = (this.hitAt = new Float64Array(n).fill(NaN));
    const missAt = (this.missAt = new Float64Array(n).fill(NaN));
    const result = (this.result = new Int8Array(n).fill(-1));
    const offsets = (this.offset = new Float64Array(n).fill(NaN));
    const spinnerAt = (this.spinnerAt = new Float64Array(n).fill(NaN));
    const spinTotal = (this.spinTotal = new Float64Array(n));
    const judgements: Judgement[] = [];
    const parts: AccuracyPart[] = [];
    let tickHit = 0;
    let tickMiss = 0;
    let tailHit = 0;
    let small = 0;
    let large = 0;

    // circles and slider heads, by time: what presses can hit
    const clickable: number[] = [];
    for (let i = 0; i < n; i++) if (kind[i] === CIRCLE || kind[i] === SLIDER) clickable.push(i);
    const headAction = new Uint8Array(n);

    const judge = (i: number, at: number, r: Result, offset: number) => {
      result[i] = r;
      offsets[i] = offset;
      judgements.push({ time: at, result: r, offset, col: kind[i], obj: i, tail: false });
      if (r === MISS) missAt[i] = at;
      else hitAt[i] = at;
    };

    // sliders: their ticks, repeats and end, in time order
    const sliders = new Map<number, SliderState>();
    for (let i = 0; i < n; i++) {
      if (kind[i] !== SLIDER) continue;
      const s = chart.slider(i);
      const nested: Nested[] = [];
      for (let k = 0; k < s.tickTime.length; k++) nested.push({ kind: 0, time: s.tickTime[k], progress: s.tickProgress[k], judgedAt: NaN, hit: false });
      for (let k = 0; k < s.spans - 1; k++) nested.push({ kind: 1, time: time[i] + (k + 1) * s.spanDuration, progress: (k + 1) % 2, judgedAt: NaN, hit: false });
      nested.push({ kind: 2, time: chart.end[i], progress: s.spans % 2, judgedAt: NaN, hit: false });
      nested.sort((a, b) => a.time - b.time || a.kind - b.kind);
      let lastTick: Nested | null = null;
      for (const x of nested) if (x.kind !== 2 && (!lastTick || x.time >= lastTick.time)) lastTick = x;
      sliders.set(i, { i, s, nested, lastTick, tracking: false, acceptAnyAfter: null, lastPressed: 0, done: false });
      this.nested.set(i, nested);
      this.follow.set(i, []);
    }
    const judgeNested = (x: Nested, at: number, hit: boolean) => {
      x.judgedAt = at;
      x.hit = hit;
      if (x.kind === 2) {
        parts.push({ time: at, score: hit ? TAIL_SCORE : 0, max: TAIL_SCORE });
        if (hit) tailHit++;
      } else {
        parts.push({ time: at, score: hit ? TICK_SCORE : 0, max: TICK_SCORE });
        if (hit) tickHit++;
        else tickMiss++;
      }
    };

    // the cursor
    let mx = NaN;
    let my = NaN;
    let pressed = 0;
    const hovers = (i: number) => Math.hypot(mx - chart.x[i], my - chart.y[i]) <= radius;
    const ballAt = (st: SliderState, t: number) => {
      const duration = chart.end[st.i] - time[st.i];
      const completion = duration > 0 ? Math.max(0, Math.min(1, (t - time[st.i]) / duration)) : 1;
      return chart.positionAt(st.s, chart.progressAt(st.s, completion));
    };
    const inFollowArea = (st: SliderState, t: number, expanded: boolean) => {
      if (Number.isNaN(mx)) return false;
      const r = radius * (expanded ? FOLLOW_AREA : 1);
      const [bx, by] = ballAt(st, t);
      return (mx - bx) ** 2 + (my - by) ** 2 <= r * r;
    };
    const allJudged = (st: SliderState) => st.done;
    const updateTracking = (st: SliderState, t: number, validPosition: boolean) => {
      const was = st.tracking;
      const head = headAction[st.i];
      if (!head) st.acceptAnyAfter = null;
      if (head && st.acceptAnyAfter === null) {
        const other = head === RIGHT ? LEFT : RIGHT;
        if (!(st.lastPressed & other)) st.acceptAnyAfter = t;
      }
      const valid = (a: number) => (head && (st.acceptAnyAfter === null || t <= st.acceptAnyAfter) ? a === head : true);
      const validAction = (pressed & LEFT && valid(LEFT)) || (pressed & RIGHT && valid(RIGHT));
      st.lastPressed = pressed;
      st.tracking = (!allJudged(st) || t <= chart.end[st.i]) && validPosition && !!validAction;
      if (st.tracking !== was) this.follow.get(st.i)!.push(t);
    };
    /** SliderInputManager.PostProcessHeadJudgement: a late head takes the ticks it passed */
    const afterHead = (st: SliderState, t: number) => {
      if (!inFollowArea(st, t, true)) return;
      const r = radius * FOLLOW_AREA;
      let all = true;
      for (const x of st.nested) {
        if (!Number.isNaN(x.judgedAt)) continue;
        if (x.time > t) break;
        const [px, py] = chart.positionAt(st.s, x.progress);
        if ((px - mx) ** 2 + (py - my) ** 2 > r * r) {
          all = false;
          break;
        }
      }
      for (const x of st.nested) {
        if (!Number.isNaN(x.judgedAt)) continue;
        if (x.time > t) break;
        judgeNested(x, t, all);
      }
      updateTracking(st, t, all || inFollowArea(st, t, false));
    };
    /** StartTimeOrderedHitPolicy.HandleHit: earlier circles still waiting are missed */
    const missEarlier = (i: number, at: number) => {
      for (const j of clickable) {
        if (time[j] >= time[i]) break;
        if (result[j] < 0) judge(j, at, MISS, NaN);
      }
    };
    /** circles left alone past Meh, before `t` */
    let firstOpen = 0;
    const settleCircles = (t: number) => {
      while (firstOpen < clickable.length && result[clickable[firstOpen]] >= 0) firstOpen++;
      for (let k = firstOpen; k < clickable.length; k++) {
        const i = clickable[k];
        if (!(t - time[i] > W[2])) break;
        if (result[i] < 0) judge(i, time[i] + W[2], MISS, NaN);
      }
    };
    const press = (t: number, action: number) => {
      for (let k = firstOpen; k < clickable.length; k++) {
        const i = clickable[k];
        if (time[i] - preempt > t) break;
        if (result[i] >= 0 || !hovers(i)) continue;
        // it takes the press, hit or not
        const offset = t - time[i];
        const a = Math.abs(offset);
        const r: Result | -1 = a <= W[0] ? GREAT : a <= W[1] ? OK : a <= W[2] ? MEH : a <= MISS_WINDOW ? MISS : -1;
        let blocking = -1;
        for (let b = 0; b < k; b++) blocking = clickable[b];
        const locked = blocking >= 0 && result[blocking] < 0 && t < time[blocking];
        if (r >= 0 && !locked) {
          judge(i, t, r as Result, offset);
          missEarlier(i, t);
          const st = sliders.get(i);
          if (st && r !== MISS) afterHead(st, t);
        }
        if (kind[i] === SLIDER && !headAction[i]) headAction[i] = action;
        return;
      }
    };

    // spinners
    const spinners: { i: number; history: SpinHistory; lastAngle: number; ticks: number; done: boolean }[] = [];
    for (let i = 0; i < n; i++) if (kind[i] === SPINNER) spinners.push({ i, history: new SpinHistory(), lastAngle: NaN, ticks: 0, done: false });

    const update = (t: number) => {
      settleCircles(t + 1e-9);
      for (const st of sliders.values()) {
        const i = st.i;
        if (st.done || time[i] - preempt > t) continue;
        updateTracking(st, t, inFollowArea(st, t, st.tracking));
        // ticks, then repeats, then the end
        const headJudged = result[i] >= 0;
        for (const k of [0, 1, 2] as const) {
          for (const x of st.nested) {
            if (x.kind !== k || !Number.isNaN(x.judgedAt)) continue;
            const offset = t - x.time;
            if (k === 2 ? offset < TAIL_LENIENCY : offset < 0) continue;
            if (k === 2 && st.lastTick && Number.isNaN(st.lastTick.judgedAt)) continue;
            if (!headJudged) continue;
            if (st.tracking) judgeNested(x, t, true);
            else if (offset >= 0) judgeNested(x, t, false);
          }
        }
        const tail = st.nested[st.nested.length - 1];
        if (!Number.isNaN(tail.judgedAt) && t >= chart.end[i] && st.nested.every((x) => !Number.isNaN(x.judgedAt))) {
          st.done = true;
          if (st.tracking) this.follow.get(i)!.push(t);
          st.tracking = false;
        }
      }
      for (const sp of spinners) {
        const i = sp.i;
        if (sp.done || time[i] - preempt > t) continue;
        const spinnable = time[i] <= t && chart.end[i] > t;
        const tracking = spinnable && !!pressed;
        if (!Number.isNaN(mx)) {
          const angle = (-Math.atan2(mx - chart.x[i], my - chart.y[i]) * 180) / Math.PI;
          let delta = Number.isNaN(sp.lastAngle) ? 0 : angle - sp.lastAngle;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          if (tracking) sp.history.report(delta * rate);
          sp.lastAngle = angle;
        }
        // a tick per full spin: spins, then bonus spins
        const spins = Math.floor(sp.history.total / 360);
        const needed = chart.a[i];
        const ticks = needed + 2 + chart.b[i];
        while (sp.ticks < spins && sp.ticks < ticks) {
          if (sp.ticks < needed + 2) small++;
          else large++;
          sp.ticks++;
        }
        if (t >= chart.end[i]) {
          sp.done = true;
          const progress = needed <= 0 ? 1 : sp.history.total / 360 / needed;
          judge(i, t, progress >= 1 ? GREAT : progress > 0.9 ? OK : progress > 0.75 ? MEH : MISS, NaN);
          spinnerAt[i] = t;
          spinTotal[i] = sp.history.total;
        }
      }
    };

    // lazer updates far more often than replays keep frames: at the moments that count (ticks,
    // repeats, slider and spinner ends) it updates too, the cursor moving straight between frames
    const marks: number[] = [];
    for (const st of sliders.values()) {
      for (const x of st.nested) marks.push(x.kind === 2 ? x.time + TAIL_LENIENCY : x.time);
      marks.push(chart.end[st.i]);
    }
    // a spinner turns until just before its end, and is judged at it
    for (const sp of spinners) marks.push(chart.end[sp.i] - 1e-3, chart.end[sp.i]);
    marks.sort((a, b) => a - b);
    let mark = 0;

    // the replay, frame by frame: the cursor moves, new presses land, then everything updates
    const out: number[] = [];
    let prevT = -Infinity;
    for (let f = 0; f < frames.length; f += 4) {
      const t = frames[f];
      const buttons = Math.max(0, Math.round(frames[f + 3]));
      const now = (buttons & 5 ? LEFT : 0) | (buttons & 10 ? RIGHT : 0);
      while (mark < marks.length && marks[mark] < t) {
        const at = marks[mark++];
        if (!(at > prevT) || Number.isNaN(mx)) continue;
        const w = (at - prevT) / (t - prevT);
        const px = mx;
        const py = my;
        mx = px + (frames[f + 1] - px) * w;
        my = py + (frames[f + 2] - py) * w;
        update(at);
        mx = px;
        my = py;
      }
      prevT = t;
      mx = frames[f + 1];
      my = frames[f + 2];
      out.push(t, mx, my, now);
      settleCircles(t);
      const down = now & ~pressed;
      pressed = now;
      if (down & LEFT) press(t, LEFT);
      if (down & RIGHT) press(t, RIGHT);
      update(t);
    }
    // whatever's left once the replay ends
    const last = frames.length ? frames[frames.length - 4] : 0;
    pressed = 0;
    let after = last;
    for (let i = 0; i < n; i++) after = Math.max(after, chart.end[i] + MISS_WINDOW);
    update(after);
    for (const st of sliders.values()) {
      for (const x of st.nested) if (Number.isNaN(x.judgedAt)) judgeNested(x, Math.max(x.time, last), false);
    }
    judgements.sort((a, b) => a.time - b.time || a.obj - b.obj);
    parts.sort((a, b) => a.time - b.time);

    this.frames = out;
    this.judgements = judgements;
    this.largeTickHit = tickHit;
    this.largeTickMiss = tickMiss;
    this.sliderTailHit = tailHit;
    this.smallBonus = small;
    this.largeBonus = large;
    this.tally = new Tally(judgements, SCORE, 300, parts);
  }

  /** The windows on the error bar, widest first: [result, window]. */
  barWindows(): [Result, number][] {
    return [
      [MEH, this.windows[2]],
      [OK, this.windows[1]],
      [GREAT, this.windows[0]],
    ];
  }

  /** Whether a slider is followed at `t`. */
  following(i: number, t: number): boolean {
    const f = this.follow.get(i);
    if (!f) return false;
    let on = false;
    for (let k = 0; k < f.length && f[k] <= t; k++) on = !on;
    return on;
  }

  /** The counts per result, the accuracy (0–1) and how many were judged, by `t`. */
  stats(t: number): { counts: number[]; accuracy: number; judged: number } {
    return this.tally.stats(t);
  }
}
