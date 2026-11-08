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
  return {
    md5: str(beatmap.checksum).toLowerCase(),
    state: num(obj(m.state).number) ?? -1,
    live,
    rate: rate && rate > 0 ? rate : 1,
    pitch,
    artist: str(beatmap.artist),
    title: str(beatmap.title),
    version: str(beatmap.version),
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
