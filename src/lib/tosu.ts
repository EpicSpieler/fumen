/* tosu.ts — what osu! is playing, as tosu tells it (github.com/tosuapp/tosu, a separate app that
 * reads stable and lazer and serves it on ws://127.0.0.1:24050/websocket/v2). Fumen reads nothing
 * of the game itself. This file is the reading and the clock; lib/tosu-follow plays along. */

/** tosu's game states (its GameState enum, by position) */
export const STATE = { menu: 0, edit: 1, play: 2, selectEdit: 4, selectPlay: 5, resultScreen: 7 } as const;

export interface TosuNow {
  /** the difficulty's MD5 ("" when there's none) */
  md5: string;
  state: number;
  /** where the song is, ms (osu!'s own clock) */
  live: number;
  /** playback rate from the mods (DT 1.5, HT 0.75, or a custom one) */
  rate: number;
  /** the pitch goes with the rate (NC, DC, or "adjust pitch") */
  pitch: boolean;
  artist: string;
  title: string;
  version: string;
  /** osu! is paused: the pause menu, the fail screen (and moments while loading) */
  paused: boolean;
  /** "lazer" or "stable" */
  client: string;
  /** the ruleset played (0 osu!, 1 taiko, 2 catch, 3 mania) */
  mode: number;
  /** osu!mania: how many keys (columns) the map is played with; null elsewhere or when not said */
  keys: number | null;
  /** the play right now (in a map; zeros elsewhere) */
  play: TosuPlay;
  /** where the first and last notes are, ms */
  firstObject: number | null;
  lastObject: number | null;
  /** the most combo the difficulty gives (as tosu counts it) */
  mapCombo: number | null;
  /** in one of the map's breaks */
  inBreak: boolean;
  /** the results screen's score, once it shows one */
  results: TosuResults | null;
}

export interface TosuPlay {
  failed: boolean;
  /** 0–100 */
  accuracy: number;
  score: number;
  maxCombo: number;
  combo: number;
  misses: number;
  /** slider breaks (osu!): the combo goes without a miss */
  breaks: number;
  /** judgements so far (a restart starts again at 0) */
  hits: number;
  /** the judgements one by one, as tosu counts them (osu!mania: geki is MAX, katu 200) */
  judges: Judges;
  /** 0–100; null when tosu doesn't say (taiko's fills up from 0 instead of draining) */
  health: number | null;
  /** the grade it's on now ("SS", "S", "A" …) */
  rank: string;
  pp: number | null;
  /** the mods by name, "HDDT" */
  mods: string;
  /** the mods, one by one ("AT" and "CN" are autoplay and cinema) */
  modList: string[];
  /** whose play it is (a replay or spectating shows someone else, or yourself from before) */
  player: string;
  /** who is logged in to osu! */
  me: string;
}

/** tosu's hit counts by judgement */
export interface Judges {
  geki: number;
  n300: number;
  katu: number;
  n100: number;
  n50: number;
  miss: number;
}

export interface TosuResults {
  scoreId: number;
  rank: string;
  /** 0–100 */
  accuracy: number;
  score: number;
  maxCombo: number;
  pp: number | null;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** One v2 message, or null when it isn't one. */
export function readTosu(msg: unknown): TosuNow | null {
  const m = obj(msg);
  const beatmap = obj(m.beatmap);
  const live = num(obj(beatmap.time).live);
  if (live === null) return null;
  const mods = obj(obj(m.play).mods);
  const rate = num(mods.rate);
  const list = Array.isArray(mods.array) ? mods.array.map(obj) : [];
  const pitch = list.some((x) => x.acronym === "NC" || x.acronym === "DC" || obj(x.settings).adjust_pitch === true);
  const play = obj(m.play);
  const hits = obj(play.hits);
  const judged = ["0", "50", "100", "300", "geki", "katu"].reduce((n, k) => n + (num(hits[k]) ?? 0), 0);
  const res = obj(m.resultsScreen);
  const scoreId = num(res.scoreId) ?? 0;
  const time = obj(beatmap.time);
  const mode = num(obj(play.mode).number) ?? num(obj(beatmap.mode).number) ?? 0;
  const cs = obj(obj(beatmap.stats).cs);
  const keys = num(cs.converted) ?? num(cs.original);
  return {
    md5: str(beatmap.checksum).toLowerCase(),
    state: num(obj(m.state).number) ?? -1,
    live,
    rate: rate && rate > 0 ? rate : 1,
    pitch,
    artist: str(beatmap.artist),
    title: str(beatmap.title),
    version: str(beatmap.version),
    paused: obj(m.game).paused === true,
    client: str(m.client),
    mode,
    keys: mode === 3 && keys !== null && keys >= 1 && keys <= 20 ? Math.round(keys) : null,
    play: {
      failed: play.failed === true,
      accuracy: num(play.accuracy) ?? 0,
      score: num(play.score) ?? 0,
      maxCombo: num(obj(play.combo).max) ?? 0,
      combo: num(obj(play.combo).current) ?? 0,
      misses: num(hits["0"]) ?? 0,
      breaks: num(hits.sliderBreaks) ?? 0,
      hits: judged,
      judges: {
        geki: num(hits.geki) ?? 0,
        n300: num(hits["300"]) ?? 0,
        katu: num(hits.katu) ?? 0,
        n100: num(hits["100"]) ?? 0,
        n50: num(hits["50"]) ?? 0,
        miss: num(hits["0"]) ?? 0,
      },
      health: num(obj(play.healthBar).normal),
      rank: str(obj(play.rank).current),
      pp: num(obj(play.pp).current),
      mods: str(mods.name),
      modList: list.map((x) => str(x.acronym)).filter(Boolean),
      player: str(play.playerName),
      me: str(obj(m.profile).name),
    },
    firstObject: num(time.firstObject),
    lastObject: num(time.lastObject),
    mapCombo: num(obj(beatmap.stats).maxCombo),
    inBreak: beatmap.isBreak === true,
    results:
      scoreId > 0
        ? {
            scoreId,
            rank: str(res.rank),
            accuracy: num(res.accuracy) ?? 0,
            score: num(res.score) ?? 0,
            maxCombo: num(res.maxCombo) ?? 0,
            pp: num(obj(res.pp).current),
          }
        : null,
  };
}

/** a song whose time hasn't moved for this long (ms) is paused */
export const STALL = 400;

/**
 * osu!'s song clock between tosu's messages: where it was when it last moved, and whether it still
 * moves (paused, in a menu without music, or tosu stuck: it doesn't).
 */
export class TosuClock {
  private live = Number.NaN;
  /** when `live` last changed, performance.now() ms */
  private movedAt = Number.NEGATIVE_INFINITY;
  private rate = 1;

  update(live: number, rate: number, now: number): void {
    if (live !== this.live) {
      // the first reading says where, not that it moves
      if (!Number.isNaN(this.live)) this.movedAt = now;
      this.live = live;
    }
    this.rate = rate;
  }

  /** a new song: nothing known about it yet */
  reset(): void {
    this.live = Number.NaN;
    this.movedAt = Number.NEGATIVE_INFINITY;
  }

  running(now: number): boolean {
    return now - this.movedAt < STALL;
  }

  /** Where the song is now, ms; NaN before the first reading. */
  at(now: number): number {
    if (!this.running(now)) return this.live;
    return this.live + Math.min(now - this.movedAt, STALL) * this.rate;
  }
}

/** a jump back in osu!'s time bigger than this (ms) is a new start, not a wobble */
const JUMP = 300;
/** a map starts this close to the song's beginning (ms; lazer starts there, with a skip button) */
export const NEAR_START = 3000;
/** ms after which waiting for the start gives up and follows anyway */
export const HOLD_MAX = 10_000;

/**
 * Starting a map: the menu's music runs on into the loading screen for a second or two, so osu!'s
 * time still says the middle of the song. Fumen waits at the beginning until osu! jumps back to it
 * ("menu" → "start") and its time moves from there (done).
 */
export class StartHold {
  private phase: "menu" | "start" | null = null;
  private prev = 0;
  private since = 0;

  get on(): boolean {
    return this.phase !== null;
  }

  /** A map was started at `live`; `before` is osu!'s time just before (same song), if known. */
  begin(live: number, before: number | null, now: number): void {
    this.since = now;
    this.prev = live;
    // without a time from before, near the beginning already counts as back there
    const back = before === null ? live < NEAR_START : this.isStart(live, before);
    this.phase = back ? "start" : "menu";
  }

  update(live: number, now: number): void {
    if (!this.phase) return;
    if (now - this.since > HOLD_MAX) {
      this.phase = null;
      return;
    }
    if (this.phase === "menu") {
      if (this.isStart(live, this.prev)) this.phase = "start";
    } else if (live > this.prev) {
      this.phase = null;
      return;
    }
    this.prev = live;
  }

  clear(): void {
    this.phase = null;
  }

  private isStart(live: number, before: number): boolean {
    return live < 0 || (live < before - JUMP && live < NEAR_START);
  }
}
