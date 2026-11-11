/* demo.ts — a made-up try for arranging the live overlay in Fumen (views/hud-editor.ts): what tosu
 * would say through a pass with a combo break and a stretch of low health, or through a fail, so
 * every part has something to show and every moment can be seen where it lands. */
import { STATE, type TosuNow } from "../lib/tosu";

export const DEMO_MD5 = "00000000000000000000000000de3000";
export type DemoKind = "pass" | "fail";
export type Moment = "play" | "break" | "low" | "pass" | "fail";

/** the last note, song ms */
export const DEMO_LAST = 32_000;
/** judgements a second */
const PER_S = 16;
/** seconds in song select, then of lead-in, before the song's first second */
const SELECT = 1;
const LEAD_IN = 1.2;
/** song seconds a note was missed at */
const MISSES: Record<DemoKind, number[]> = { pass: [10.5], fail: [7, 10.4, 12.1, 13.5, 14.6] };
/** the fail, song seconds */
const FAIL_AT = 15.6;
/** seconds on the results (or the fail screen) before it begins again */
const AFTER = 6;

export interface DemoMap {
  title: string;
  artist: string;
  version: string;
  mode: number;
}

/** Each moment: which try, and the song seconds it runs from and to (then holds there). */
export const MOMENTS: Record<Moment, { kind: DemoKind; from: number; to: number }> = {
  play: { kind: "pass", from: 5.5, to: 8 },
  break: { kind: "pass", from: 8.6, to: 12.2 },
  low: { kind: "pass", from: 17.4, to: 20.6 },
  pass: { kind: "pass", from: 29.5, to: 37.5 },
  fail: { kind: "fail", from: 12.6, to: 19.5 },
};

/** song seconds as demo seconds */
export const demoSeconds = (song: number): number => song + SELECT + LEAD_IN;

const rankOf = (acc: number): string => (acc >= 100 ? "SS" : acc >= 95 ? "S" : acc >= 90 ? "A" : acc >= 80 ? "B" : acc >= 70 ? "C" : "D");

/** What tosu says `s` seconds into the demo; null once it's over. */
export function demoAt(kind: DemoKind, s: number, map: DemoMap): TosuNow | null {
  const make = (state: number, live: number, play: Partial<TosuNow["play"]> = {}, extra: Partial<TosuNow> = {}): TosuNow => ({
    md5: DEMO_MD5,
    state,
    live: Math.round(live),
    rate: 1,
    pitch: false,
    artist: map.artist,
    title: map.title,
    version: map.version,
    paused: false,
    client: "lazer",
    mode: map.mode,
    play: { failed: false, accuracy: 100, score: 0, maxCombo: 0, combo: 0, misses: 0, breaks: 0, hits: 0, health: 100, rank: "SS", pp: 0, mods: "", modList: [], player: "", me: "", ...play },
    firstObject: 0,
    lastObject: DEMO_LAST,
    mapCombo: Math.round((DEMO_LAST / 1000) * PER_S),
    inBreak: false,
    results: null,
    ...extra,
  });
  if (s < SELECT) return make(STATE.selectPlay, 40_000 + s * 1000);
  const t = s - SELECT - LEAD_IN;
  const end = kind === "fail" ? FAIL_AT : DEMO_LAST / 1000;
  const at = Math.max(0, Math.min(t, end));
  const missed = MISSES[kind].filter((m) => m <= at);
  const notes = Math.floor(at * PER_S);
  let maxCombo = 0;
  let from = 0;
  for (const m of missed) {
    maxCombo = Math.max(maxCombo, Math.floor(m * PER_S) - Math.floor(from * PER_S));
    from = m;
  }
  const combo = notes - Math.floor(from * PER_S);
  maxCombo = Math.max(maxCombo, combo);
  const health =
    kind === "fail"
      ? at < 7.5
        ? 96
        : Math.max(0, 96 * (1 - (at - 7.5) / (FAIL_AT - 7.5)))
      : at > 17 && at < 24
        ? 100 - 86 * Math.sin((Math.PI * (at - 17)) / 7)
        : 96 + 3 * Math.sin(at * 0.9);
  const accuracy = Math.max(0, 99.4 - missed.length * 0.9 - at * 0.025);
  const play = {
    accuracy,
    score: notes * 1953 - missed.length * 5000,
    maxCombo,
    combo,
    misses: missed.length,
    hits: notes + missed.length,
    health,
    rank: rankOf(accuracy),
    pp: Math.max(0, Math.round(notes * 0.41) - missed.length * 8),
  };
  if (kind === "fail" && t >= FAIL_AT) {
    // the fail screen: paused, its time creeping on
    if (t > FAIL_AT + AFTER) return null;
    return make(STATE.play, FAIL_AT * 1000 + (t - FAIL_AT) * 150, { ...play, health: 0, failed: true }, { paused: true });
  }
  if (kind === "pass" && t > end + 1) {
    if (t > end + 1 + AFTER) return null;
    return make(STATE.resultScreen, t * 1000, play, {
      results: { scoreId: 1, rank: play.rank, accuracy: play.accuracy, score: play.score, maxCombo: play.maxCombo, pp: play.pp },
    });
  }
  return make(STATE.play, t * 1000, play);
}

/** The demo running: round and round, or held at a moment. Fed to the page's tosu line (./live). */
export class Demo {
  kind: DemoKind = "pass";
  /** seconds into the try */
  s = 0;
  running = true;
  private until = Infinity;
  private last = 0;
  private timer = 0;
  /** a jump: one message from the lead-in first, so the try is seen to start where tries start */
  private lead = false;

  constructor(
    private readonly map: () => DemoMap,
    private readonly feed: (now: TosuNow | null) => void,
  ) {}

  start(): void {
    clearInterval(this.timer);
    this.last = performance.now();
    this.timer = window.setInterval(() => this.step(), 50);
  }

  /** Round and round from here. */
  play(): void {
    this.until = Infinity;
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  /** Jumps to a moment, runs through it and holds there. */
  moment(m: Moment): void {
    const o = MOMENTS[m];
    this.kind = o.kind;
    this.s = demoSeconds(o.from);
    this.until = demoSeconds(o.to);
    this.running = true;
    // a jump: as if tosu came again, so the try starts clean
    this.feed(null);
    this.lead = true;
  }

  private step(): void {
    const t = performance.now();
    const dt = Math.min(0.2, (t - this.last) / 1000);
    this.last = t;
    if (this.lead) {
      this.lead = false;
      const start = demoAt(this.kind, demoSeconds(-0.8), this.map());
      if (start) return this.feed(start);
    }
    if (this.running) {
      this.s += dt;
      if (this.s >= this.until) {
        this.s = this.until;
        this.running = false;
        this.until = Infinity;
      }
    }
    let now = demoAt(this.kind, this.s, this.map());
    if (!now) {
      // over: again, a pass this time
      this.kind = "pass";
      this.s = 0;
      now = demoAt(this.kind, 0, this.map());
    }
    this.feed(now);
  }
}
