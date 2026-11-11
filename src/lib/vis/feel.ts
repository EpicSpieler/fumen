/* feel.ts — how the play in osu! is going, for the visualizer to answer it (views/vis). What tosu
 * says through Follow osu! (lib/tosu-follow) becomes a few values that glide (how far the combo has
 * built the stage up, the sting after a combo break, the danger of low health, the breath held
 * after the last note) and moments (the start, a miss, a combo break, a combo milestone, a full
 * combo, a pass, a fail).
 *
 * Times are seconds on one clock (performance.now() / 1000 in the app; tests bring their own).
 * tosu says something about every 150 ms, so a moment comes up to that late: soon enough to feel
 * like an answer to the play. */
import { NEAR_START, STATE, StartHold, type TosuNow } from "../tosu";

export type FeelEvent =
  /** the map really started (after loading), or started again (`retry`) */
  | { kind: "start"; retry: boolean }
  /** `n` misses since the last message, at `combo` */
  | { kind: "miss"; n: number; combo: number }
  /** a combo of `lost` gone; `size` 0–1 says how much that hurts */
  | { kind: "break"; lost: number; size: number }
  | { kind: "milestone"; combo: number; big: boolean }
  | { kind: "fc" | "pass"; rank: string; accuracy: number; combo: number }
  | { kind: "fail"; progress: number | null };

export interface FeelEnd {
  kind: "fc" | "pass" | "fail";
  /** seconds since */
  t: number;
  /** 1 while it's on, gliding to 0 once osu! has left it */
  k: number;
  rank: string;
  /** 0–1 */
  accuracy: number;
  combo: number;
  /** how far through the map, 0–1 (a fail's), null without the map's length */
  progress: number | null;
}

export interface FeelFrame {
  /** loading the map, playing it, on its end (fail screen, results), or out of it */
  phase: "hold" | "play" | "end" | "idle";
  /** the ruleset (0 osu!, 1 taiko, 2 catch, 3 mania) */
  mode: number;
  combo: number;
  maxCombo: number;
  misses: number;
  /** 0–1 */
  accuracy: number;
  pp: number | null;
  rank: string;
  /** 0–1, null when tosu doesn't say */
  health: number | null;
  /** how far the combo has built the stage up, 0–1 */
  energy: number;
  /** the sting of a combo break, 0–1: it stays a moment, then fades */
  grief: number;
  /** low health, 0–1 */
  danger: number;
  /** after the last note, no combo lost: the breath before the full combo, 0–1 */
  breath: number;
  /** in one of the map's breaks, 0–1 */
  rest: number;
  /** seconds since the last miss and the last combo break (Infinity: none in this try) */
  sinceMiss: number;
  sinceBreak: number;
  /** how big the last combo break was, 0–1 */
  breakSize: number;
  end: FeelEnd | null;
  /** the moments since the last frame, oldest first */
  events: FeelEvent[];
}

/** the combos that get a moment; after the last one every 500 */
const MILESTONES = [100, 250, 500, 750, 1000];
/** a combo lost smaller than this is just a miss */
const BREAK_MIN = 20;
/** a jump back in osu!'s time bigger than this (ms) is a restart */
const RESTART_JUMP = 1000;
/** ms past the last note before the breath is held (its hit window has gone by) */
const LAST_NOTE_AFTER = 200;
/** seconds the moments nobody drew are kept (the visualizer closed, hidden or slow): a late miss
 * or milestone means nothing any more, a late start, break or end still does */
const EVENT_KEEP = 0.5;
const EVENT_KEEP_LONG = 2.5;
/** seconds a combo break's sting stays before it fades */
const GRIEF_HOLD = 0.35;

export function nextMilestone(combo: number): number {
  for (const m of MILESTONES) if (m > combo) return m;
  return (Math.floor(combo / 500) + 1) * 500;
}

/** How much losing a combo of `lost` hurts, 0–1: 20 a little, 100 well, 1000 all of it. */
export function breakSize(lost: number): number {
  return Math.min(1, Math.max(0, Math.log10(Math.max(1, lost)) / 3.1));
}

/** How far a combo builds the stage up, 0–1, against the difficulty's whole combo: a third of a
 * long map's (600 at most, 80 at least) gets it most of the way. */
export function comboEnergy(combo: number, mapCombo: number | null): number {
  const scale = Math.min(600, Math.max(80, (mapCombo ?? 1000) * 0.3));
  return 1 - Math.exp((-1.6 * Math.max(0, combo)) / scale);
}

const smooth = (lo: number, hi: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/** glides `v` toward `to` with time constant `tau` (s) */
const glide = (v: number, to: number, dt: number, tau: number): number => v + (to - v) * (1 - Math.exp(-dt / tau));

export class Feel {
  private phase: FeelFrame["phase"] = "idle";
  private hold = new StartHold();
  private retrying = false;
  private md5 = "";
  /** the message before */
  private prev: TosuNow | null = null;
  /** the latest message of the play (its numbers stay on the results) */
  private last: TosuNow | null = null;
  private prevLive = 0;
  private maxHits = 0;
  private combo = 0;
  private misses = 0;
  /** no combo lost in this try */
  private clean = true;
  private failed = false;
  private next = MILESTONES[0];
  private missAt = -Infinity;
  private breakAt = -Infinity;
  private lastBreak = 0;
  private ending: Omit<FeelEnd, "t" | "k"> & { at: number } | null = null;
  private endK = 0;
  private anticipating = false;
  private queue: (FeelEvent & { at: number })[] = [];
  private energy = 0;
  private grief = 0;
  private danger = 0;
  private breath = 0;
  private rest = 0;

  /** One message from tosu at `now` (s). */
  feed(n: TosuNow, now: number): void {
    const before = this.prev;
    this.prev = n;
    if (n.state === STATE.play) {
      const fresh = before?.state !== STATE.play || n.md5 !== this.md5 || this.phase === "idle" || this.phase === "end";
      if (fresh) return this.begin(n, before && before.md5 === n.md5 ? before.live : null, now, false);
      if (this.phase === "hold") {
        this.hold.update(n.live, now * 1000);
        this.prevLive = n.live;
        this.last = n;
        if (!this.hold.on) {
          this.phase = "play";
          // what was there when it began (joined late, say) isn't a moment
          this.combo = n.play.combo;
          this.misses = n.play.misses;
          this.next = nextMilestone(this.combo);
          this.push({ kind: "start", retry: this.retrying }, now);
        }
        return;
      }
      return this.track(n, now);
    }
    if (before?.state === STATE.play && this.phase === "play" && n.state === STATE.resultScreen && !this.failed) return this.finish(n, now);
    // out of the map (a quit, the fail screen left, the results left)
    if (this.phase !== "idle" && !(this.phase === "end" && n.state === STATE.resultScreen)) this.phase = "idle";
  }

  /** tosu went (or following stopped): out of whatever was on. */
  stop(): void {
    this.prev = null;
    this.phase = "idle";
    this.anticipating = false;
  }

  private begin(n: TosuNow, before: number | null, now: number, retry: boolean): void {
    this.md5 = n.md5;
    this.phase = "hold";
    this.hold.begin(n.live, before, now * 1000);
    this.retrying = retry;
    this.prevLive = n.live;
    this.maxHits = 0;
    this.combo = 0;
    this.misses = 0;
    this.clean = true;
    this.failed = false;
    this.next = nextMilestone(n.play.combo);
    this.missAt = -Infinity;
    this.breakAt = -Infinity;
    this.lastBreak = 0;
    this.ending = null;
    this.endK = 0;
    this.anticipating = false;
    this.last = n;
  }

  private track(n: TosuNow, now: number): void {
    const p = n.play;
    // a restart: the judgements start again, or the time jumps back to the beginning
    if ((p.hits < this.maxHits && p.hits <= 1) || (n.live < this.prevLive - RESTART_JUMP && n.live < NEAR_START)) return this.begin(n, this.prevLive, now, true);
    this.prevLive = n.live;
    this.maxHits = Math.max(this.maxHits, p.hits);
    this.last = n;
    if (this.failed) return;
    if (p.failed) {
      this.failed = true;
      this.anticipating = false;
      const prog = progressAt(n);
      this.ending = { kind: "fail", at: now, rank: p.rank, accuracy: p.accuracy / 100, combo: p.maxCombo, progress: prog };
      this.endK = 1;
      return this.push({ kind: "fail", progress: prog }, now);
    }
    if (p.misses > this.misses) {
      this.push({ kind: "miss", n: p.misses - this.misses, combo: this.combo }, now);
      this.missAt = now;
      this.clean = false;
    }
    this.misses = p.misses;
    if (p.breaks > 0) this.clean = false;
    if (p.combo < this.combo) {
      const lost = this.combo;
      this.clean = false;
      if (lost >= BREAK_MIN) {
        const size = breakSize(lost);
        this.push({ kind: "break", lost, size }, now);
        this.breakAt = now;
        this.lastBreak = size;
        this.grief = Math.max(this.grief, size);
      }
      this.next = nextMilestone(p.combo);
    }
    while (p.combo >= this.next) {
      this.push({ kind: "milestone", combo: this.next, big: this.next >= 500 }, now);
      this.next = nextMilestone(this.next);
    }
    this.combo = p.combo;
    this.anticipating = this.clean && n.lastObject !== null && n.lastObject > 0 && n.live >= n.lastObject + LAST_NOTE_AFTER;
  }

  private finish(n: TosuNow, now: number): void {
    const p = (this.last ?? n).play;
    const r = n.results;
    const kind = this.clean && p.misses === 0 && p.breaks === 0 ? "fc" : "pass";
    const rank = r?.rank || p.rank;
    const accuracy = (r ? r.accuracy : p.accuracy) / 100;
    const combo = r?.maxCombo || p.maxCombo;
    this.phase = "end";
    this.anticipating = false;
    this.ending = { kind, at: now, rank, accuracy, combo, progress: 1 };
    this.endK = 1;
    this.push({ kind, rank, accuracy, combo }, now);
  }

  private push(e: FeelEvent, now: number): void {
    this.queue.push({ ...e, at: now });
    if (this.queue.length > 64) this.queue.shift();
  }

  /** The play as it is at `now` (s), `dt` after the frame before; null when there's nothing to
   * answer (out of a map, everything settled). */
  frame(dt: number, now: number): FeelFrame | null {
    const n = this.last;
    const p = n?.play;
    const playing = this.phase === "play" && !this.failed;
    // the stage builds up with the combo, goes dark on a fail, stays lit for a pass
    const goal = playing ? comboEnergy(this.combo, n?.mapCombo ?? null) : this.phase === "end" ? this.energy : 0;
    this.energy = glide(this.energy, goal, dt, goal > this.energy ? 1.1 : this.failed ? 1 : 0.3);
    if (now - this.breakAt > GRIEF_HOLD) this.grief = glide(this.grief, 0, dt, 1.4);
    // health drains in every ruleset but taiko, where it fills up from nothing
    const health = p?.health ?? null;
    const risk = playing && health !== null && n!.mode !== 1 ? smooth(0.5, 0.15, health / 100) : 0;
    this.danger = glide(this.danger, risk, dt, risk > this.danger ? 0.35 : 0.8);
    this.breath = glide(this.breath, this.anticipating ? 1 : 0, dt, this.anticipating ? 0.45 : 0.2);
    this.rest = glide(this.rest, playing && n!.inBreak ? 1 : 0, dt, 0.8);
    if (this.ending && this.phase === "idle") this.endK = Math.max(0, this.endK - dt / 0.8);
    if (this.ending && this.endK <= 0) this.ending = null;
    const events = this.queue.filter((e) => now - e.at <= (e.kind === "miss" || e.kind === "milestone" ? EVENT_KEEP : EVENT_KEEP_LONG)).map(({ at: _, ...e }) => e as FeelEvent);
    this.queue = [];
    const quiet = this.energy < 0.003 && this.grief < 0.003 && this.danger < 0.003 && this.breath < 0.003 && this.rest < 0.003;
    if (this.phase === "idle" && quiet && !this.ending && !events.length) return null;
    return {
      phase: this.phase,
      mode: n?.mode ?? 0,
      combo: this.combo,
      maxCombo: p?.maxCombo ?? 0,
      misses: this.misses,
      accuracy: (p?.accuracy ?? 100) / 100,
      pp: p?.pp ?? null,
      rank: p?.rank ?? "",
      health: health === null ? null : health / 100,
      energy: this.energy,
      grief: this.grief,
      danger: this.danger,
      breath: this.breath,
      rest: this.rest,
      sinceMiss: now - this.missAt,
      sinceBreak: now - this.breakAt,
      breakSize: this.lastBreak,
      end: this.ending ? { kind: this.ending.kind, t: now - this.ending.at, k: this.endK, rank: this.ending.rank, accuracy: this.ending.accuracy, combo: this.ending.combo, progress: this.ending.progress } : null,
      events,
    };
  }
}

/** How far through the map osu!'s time is, 0–1; null without the map's length. */
function progressAt(n: TosuNow): number | null {
  if (n.lastObject === null || n.lastObject <= 0) return null;
  const start = n.firstObject ?? 0;
  const span = n.lastObject - start;
  return span > 0 ? Math.min(1, Math.max(0, (n.live - start) / span)) : null;
}
