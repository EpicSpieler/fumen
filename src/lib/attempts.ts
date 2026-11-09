/* attempts.ts — every try at a map, out of what tosu shows (lib/tosu, docs/tosu.md): a pass, a
 * fail, a quit or a restart, with how far it got and where the health ran out. lazer only keeps a
 * replay when you pass, so this is the one place fails and quits are seen at all. lib/tosu-follow
 * feeds it and keeps what comes out (src-tauri/src/attempts.rs). */
import type { Section } from "./practice";
import { NEAR_START, STATE, StartHold, type TosuNow } from "./tosu";

export type Outcome = "pass" | "fail" | "quit" | "retry";

export interface Attempt {
  id?: number;
  md5: string;
  mode: number;
  client: string;
  /** unix ms: when the map really began (after loading) */
  started: number;
  ended: number;
  outcome: Outcome;
  /** the furthest place in the song, ms */
  reached: number;
  /** where the health ran out, ms */
  failedAt: number | null;
  firstObject: number | null;
  lastObject: number | null;
  /** 0–1 */
  accuracy: number;
  score: number;
  maxCombo: number;
  misses: number;
  /** when each miss came, song ms (up to the fail) */
  missesAt: number[];
  mods: string;
  rate: number;
  pp: number | null;
  scoreId: number | null;
  rank: string | null;
}

/** a restart jumps back at least this far (ms) */
const RESTART_JUMP = 1000;
/** ms a pass waits for the results screen's score */
const RESULTS_WAIT = 3000;
/** misses remembered per try at most */
const MISSES_KEPT = 5000;
/** mods that play by themselves */
const AUTO = new Set(["AT", "CN", "AP"]);

interface Open {
  md5: string;
  /** loading: the menu's music may still run, nothing counts yet */
  hold: StartHold;
  started: number;
  reached: number;
  failedAt: number | null;
  prevLive: number;
  maxHits: number;
  missesAt: number[];
  /** misses counted so far (tosu's number) */
  missCount: number;
  /** the latest message while playing it */
  last: TosuNow;
}

export class AttemptTracker {
  private cur: Open | null = null;
  /** a pass waiting for its score on the results screen */
  private passing: { attempt: Attempt; since: number } | null = null;
  private prev: TosuNow | null = null;

  /** One message from tosu at `now` (unix ms); the tries it finished. */
  feed(n: TosuNow, now: number): Attempt[] {
    const out: Attempt[] = [];
    const before = this.prev;
    this.prev = n;
    if (this.passing) {
      const p = this.passing;
      if (n.state === STATE.resultScreen && n.results && n.md5 === p.attempt.md5) {
        // the first score shown is the new one (lazer then flips through older ones)
        out.push({ ...p.attempt, scoreId: n.results.scoreId, rank: n.results.rank || null, accuracy: clamp01(n.results.accuracy / 100), score: n.results.score, maxCombo: n.results.maxCombo, pp: n.results.pp ?? p.attempt.pp });
        this.passing = null;
      } else if (n.state !== STATE.resultScreen || now - p.since > RESULTS_WAIT) {
        out.push(p.attempt);
        this.passing = null;
      }
    }
    const wasPlaying = before?.state === STATE.play;
    if (n.state === STATE.play) {
      const cur = this.cur;
      if (!wasPlaying || !cur || cur.md5 !== n.md5) {
        if (cur) push(out, this.close(cur, "quit", now));
        this.open(n, before && before.md5 === n.md5 ? before.live : null, now);
      } else this.track(cur, n, now, out);
    } else if (wasPlaying && this.cur) {
      const cur = this.cur;
      this.cur = null;
      if (n.state === STATE.resultScreen && !cur.last.play.failed && cur.failedAt === null) {
        const attempt = this.build(cur, "pass", now);
        if (attempt) {
          this.passing = { attempt, since: now };
          // the score may come with this very message
          if (n.results) out.push(...this.feedResultsNow(n));
        }
      } else push(out, this.close(cur, cur.failedAt !== null ? "fail" : "quit", now));
    }
    return out;
  }

  /** tosu went (or following stopped): a try under way ends as a quit, a pass without its score. */
  end(now: number): Attempt[] {
    const out: Attempt[] = [];
    if (this.passing) out.push(this.passing.attempt);
    this.passing = null;
    if (this.cur) push(out, this.close(this.cur, this.cur.failedAt !== null ? "fail" : "quit", now));
    this.cur = null;
    this.prev = null;
    return out;
  }

  private feedResultsNow(n: TosuNow): Attempt[] {
    const p = this.passing!;
    this.passing = null;
    const r = n.results!;
    return [{ ...p.attempt, scoreId: r.scoreId, rank: r.rank || null, accuracy: clamp01(r.accuracy / 100), score: r.score, maxCombo: r.maxCombo, pp: r.pp ?? p.attempt.pp }];
  }

  private open(n: TosuNow, before: number | null, now: number): void {
    const hold = new StartHold();
    hold.begin(n.live, before, now);
    this.cur = { md5: n.md5, hold, started: now, reached: 0, failedAt: null, prevLive: n.live, maxHits: 0, missesAt: [], missCount: 0, last: n };
  }

  private track(cur: Open, n: TosuNow, now: number, out: Attempt[]): void {
    if (cur.hold.on) {
      cur.hold.update(n.live, now);
      cur.prevLive = n.live;
      if (!cur.hold.on) cur.started = now;
      return;
    }
    // a restart: the judgements start again, or the time jumps back to the beginning
    const restart = (n.play.hits < cur.maxHits && n.play.hits <= 1) || (n.live < cur.prevLive - RESTART_JUMP && n.live < NEAR_START);
    if (restart) {
      push(out, this.close(cur, cur.failedAt !== null ? "fail" : "retry", now));
      this.open(n, cur.prevLive, now);
      return;
    }
    // new misses since the message before: they came about now (tosu says every ~150 ms)
    if (n.play.misses > cur.missCount) {
      if (cur.failedAt === null) for (let i = cur.missCount; i < n.play.misses && cur.missesAt.length < MISSES_KEPT; i++) cur.missesAt.push(Math.max(0, Math.round(n.live)));
      cur.missCount = n.play.misses;
    }
    if (n.play.failed && cur.failedAt === null) cur.failedAt = Math.max(0, n.live);
    // after a fail the time creeps on behind the fail screen: that isn't played
    if (cur.failedAt === null) cur.reached = Math.max(cur.reached, n.live);
    cur.maxHits = Math.max(cur.maxHits, n.play.hits);
    cur.prevLive = n.live;
    cur.last = n;
  }

  private close(cur: Open, outcome: Outcome, now: number): Attempt | null {
    if (this.cur === cur) this.cur = null;
    return this.build(cur, outcome, now);
  }

  /** The try as it's kept; null for one that doesn't count (never began, nothing hit, autoplay,
   * someone else's play). */
  private build(cur: Open, outcome: Outcome, now: number): Attempt | null {
    const n = cur.last;
    const p = n.play;
    if (cur.hold.on) return null;
    if (cur.maxHits === 0 && cur.failedAt === null) return null;
    if (p.modList.some((m) => AUTO.has(m))) return null;
    if (p.player && p.me && p.player !== p.me) return null;
    if (!/^[0-9a-f]{32}$/.test(cur.md5)) return null;
    return {
      md5: cur.md5,
      mode: Math.min(3, Math.max(0, Math.round(n.mode))),
      client: n.client,
      started: cur.started,
      ended: Math.max(now, cur.started),
      outcome,
      reached: Math.max(0, Math.round(cur.failedAt ?? cur.reached)),
      failedAt: cur.failedAt === null ? null : Math.round(cur.failedAt),
      firstObject: n.firstObject,
      lastObject: n.lastObject,
      accuracy: clamp01(p.accuracy / 100),
      score: Math.round(p.score),
      maxCombo: Math.round(p.maxCombo),
      misses: Math.round(p.misses),
      missesAt: cur.missesAt,
      mods: p.mods,
      rate: n.rate,
      pp: p.pp,
      scoreId: null,
      rank: null,
    };
  }
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function push(out: Attempt[], a: Attempt | null): void {
  if (a) out.push(a);
}

/** How far a try got through the map, 0–1 (from its first note to its last). */
export function progress(a: Pick<Attempt, "reached" | "firstObject" | "lastObject">): number | null {
  if (a.lastObject === null || a.lastObject <= 0) return null;
  const start = a.firstObject ?? 0;
  const span = a.lastObject - start;
  if (span <= 0) return null;
  return clamp01((a.reached - start) / span);
}

// ── where tries go wrong ────────────────────────────────────────────────

/** misses closer together than this (ms) are one run */
const RUN_GAP = 3000;
/** song ms shown before the run of misses, and after where the try ended */
const SPOT_BEFORE = 1000;
const SPOT_AFTER = 1500;
/** a spot to practise is at least / at most this long (song ms) */
const SPOT_MIN = 6000;
const SPOT_MAX = 20000;

/** Where a try went wrong, song ms: the run of misses that led up to where it ended (the fail, or
 * where it was left), with a moment before and after. null for a pass. */
export function troubleSpot(a: Pick<Attempt, "outcome" | "failedAt" | "reached" | "missesAt">): Section | null {
  if (a.outcome === "pass") return null;
  return spotBefore(a.failedAt ?? a.reached, a.missesAt);
}

function spotBefore(end: number, missesAt: readonly number[]): Section {
  const ms = missesAt.filter((t) => t <= end + 200).sort((x, y) => x - y);
  let from = end;
  for (let i = ms.length - 1; i >= 0 && from - ms[i] <= RUN_GAP; i--) from = Math.min(from, ms[i]);
  const b = end + SPOT_AFTER;
  let a = from - SPOT_BEFORE;
  if (b - a < SPOT_MIN) a = b - SPOT_MIN;
  if (b - a > SPOT_MAX) a = b - SPOT_MAX;
  return { a: Math.max(0, Math.round(a)), b: Math.round(b) };
}

/** tries ending this close (seconds) to where most end count as ending there */
const SAME_PLACE = 3;
/** how much an ending counts: a fail fully; leaving early (often right after a slip) a bit less */
const STOP_WEIGHT: Record<Outcome, number> = { fail: 1, quit: 0.6, retry: 0.6, pass: 0 };
/** a stop counts for the seconds around it too, most for the ones just before (where it went wrong) */
const SPREAD: [number, number][] = [
  [-3, 0.25],
  [-2, 0.5],
  [-1, 0.8],
  [0, 1],
  [1, 0.4],
];

/** Where tries end, per second of the song: 0–1, the second most of them end around is 1. */
export function stopHeat(tries: readonly Attempt[], seconds: number): number[] {
  const raw = stopsPerSecond(tries, seconds);
  const heat = raw.map((_, i) => SPREAD.reduce((sum, [d, w]) => sum + (raw[i - d] ?? 0) * w, 0));
  const top = Math.max(0, ...heat);
  return top > 0 ? heat.map((h) => h / top) : heat;
}

function stopsPerSecond(tries: readonly Attempt[], seconds: number): number[] {
  const raw = new Array<number>(Math.max(0, seconds)).fill(0);
  for (const a of tries) {
    const w = STOP_WEIGHT[a.outcome];
    const s = Math.floor((a.failedAt ?? a.reached) / 1000);
    if (w && s >= 0 && s < raw.length) raw[s] += w;
  }
  return raw;
}

/** The spot most tries end at: around the second they end at most, the part their misses point
 * to. null until at least two tries ended there. */
export function stopSpot(tries: readonly Attempt[], seconds: number): { section: Section; stops: number } | null {
  const heat = stopHeat(tries, seconds);
  const peak = heat.indexOf(1);
  if (peak < 0) return null;
  // the tries that ended there, give or take a few seconds
  const there = tries.filter((a) => a.outcome !== "pass" && Math.abs((a.failedAt ?? a.reached) / 1000 - (peak + 0.5)) <= SAME_PLACE);
  if (there.length < 2) return null;
  const spots = there.map((a) => troubleSpot(a)!).filter(Boolean);
  return { section: { a: median(spots.map((s) => s.a)), b: median(spots.map((s) => s.b)) }, stops: there.length };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

/** The tries counted by how they ended, and the furthest one got (0–1, without a length null). */
export function tally(tries: readonly Attempt[]): { tries: number; pass: number; fail: number; left: number; furthest: number | null } {
  const n = (o: Outcome) => tries.filter((a) => a.outcome === o).length;
  const ps = tries.map((a) => (a.outcome === "pass" ? 1 : progress(a))).filter((p): p is number => p !== null);
  return { tries: tries.length, pass: n("pass"), fail: n("fail"), left: n("quit") + n("retry"), furthest: ps.length ? Math.max(...ps) : null };
}
