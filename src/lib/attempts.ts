/* attempts.ts — every try at a map, out of what tosu shows (lib/tosu, docs/tosu.md): a pass, a
 * fail, a quit or a restart, with how far it got and where the health ran out. lazer only keeps a
 * replay when you pass, so this is the one place fails and quits are seen at all. lib/tosu-follow
 * feeds it and keeps what comes out (src-tauri/src/attempts.rs). */
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
    this.cur = { md5: n.md5, hold, started: now, reached: 0, failedAt: null, prevLive: n.live, maxHits: 0, last: n };
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
