/* obs-parts.ts — what Fumen's window tells the OBS pages (docs/OBS.md), part by part: sent with
 * `obs_part` (src-tauri/src/overlay.rs), heard by the pages as server-sent events (src/obs/link.ts).
 * Each part is replaced whole when it changes. */
import type { Attempt } from "./attempts";
import { progress, stopSpot, tally } from "./attempts";
import type { HudPrefs } from "./hud-layout";
import { SESSION_GAP } from "./live";
import type { VisPrefs } from "./types";

export type PartName = "config" | "map" | "tries" | "player" | "session" | "cue";

export interface ObsConfig {
  /** tosu's websocket */
  tosu: string;
  lang: "en" | "de";
  /** Fumen's accent, for a page without a cover */
  accent: string;
  vis: VisPrefs;
  reduceMotion: boolean;
  /** the live overlay's parts, where each sits */
  hud: HudPrefs;
}

/** A best on a map, from the plays Fumen knows. */
export interface ObsBest {
  accuracy: number;
  rank: string | null;
  pp: number | null;
  score: number;
}

/** The difficulty osu! is on. */
export interface ObsMap {
  md5: string;
  /** the library's difficulty, null when it isn't there (then only what tosu says) */
  id: string | null;
  title: string;
  artist: string;
  version: string;
  creator: string;
  /** 0 osu!, 1 taiko, 2 catch, 3 mania */
  mode: number;
  keys: number | null;
  /** the background's file key (served as /obs/art/<width>/<key>) */
  bg: string | null;
  /** the song's file key (/obs/audio/<key>) */
  audio: string | null;
  /** beats and kiai, song ms (lib/vis/beat) */
  beats: number[];
  kiai: number[];
  /** stars at 1×, at 1.5× and at 0.75× */
  sr: number | null;
  srDt: number | null;
  srHt: number | null;
  bpm: number;
  /** ms at 1× */
  length: number;
  /** mania: the dan as a short text ("Dan 7", "Reform 3") */
  dan: string | null;
  /** what the chart is made of, most first */
  patterns: string[];
  best: ObsBest | null;
}

/** Your tries at the map osu! is on (lib/attempts), as the pages show them. */
export interface ObsTries {
  md5: string;
  count: number;
  passes: number;
  fails: number;
  left: number;
  /** where the tries that didn't pass ended, 0–1 of the way through */
  ends: number[];
  /** the furthest any try got, 0–1 (1 once passed); null without tries */
  furthest: number | null;
  /** where most tries ended, song ms, and how many; null without such a place */
  spot: { a: number; b: number; stops: number } | null;
  /** tries since the last pass (all of them when there's none) */
  sincePass: number;
  /** the best pass among them */
  best: ObsBest | null;
}

/** Fumen's own player (followed when osu! isn't playing anything: music in a BRB scene). */
export interface ObsPlayer {
  playing: boolean;
  /** when `pos` was true, unix ms */
  at: number;
  /** seconds of the song */
  pos: number;
  rate: number;
  title: string;
  artist: string;
  version: string;
  bg: string | null;
  audio: string | null;
  beats: number[];
  kiai: number[];
}

/** One try in the session. */
export interface ObsSessionTry {
  md5: string;
  /** unix ms */
  at: number;
  outcome: Attempt["outcome"];
  /** 0–1 how far it got */
  got: number;
}

/** A play worth showing in the session card. */
export interface ObsSessionPlay {
  title: string;
  version: string;
  bg: string | null;
  rank: string | null;
  accuracy: number;
  pp: number | null;
  /** better than everything before it on the map */
  best: boolean;
  fc: boolean;
}

export interface ObsSession {
  /** unix ms */
  start: number;
  tries: number;
  passes: number;
  fails: number;
  left: number;
  /** every try, oldest first (at most the last 400) */
  line: ObsSessionTry[];
  top: ObsSessionPlay[];
  /** the map that took the most tries */
  costly: { title: string; version: string; bg: string | null; tries: number; fails: number; minutes: number; passed: boolean } | null;
  clips: number;
}

/** Something to show right now (a button in Settings): `n` goes up with each. */
export interface ObsCue {
  n: number;
  kind: "card" | "session";
}

export type Parts = {
  config: ObsConfig | null;
  map: ObsMap | null;
  tries: ObsTries | null;
  player: ObsPlayer | null;
  session: ObsSession | null;
  cue: ObsCue | null;
};

/** Your tries at a map as the pages show them (`list` newest first or not, any order). */
export function triesPart(md5: string, list: readonly Attempt[]): ObsTries {
  const tries = [...list].sort((a, b) => a.started - b.started);
  const n = tally(tries);
  const ends = tries
    .filter((a) => a.outcome !== "pass")
    .map((a) => progress(a))
    .filter((p): p is number => p !== null);
  const last = tries.map((a) => a.outcome).lastIndexOf("pass");
  const spot = stopSpot(tries, Math.ceil(Math.max(0, ...tries.map((a) => a.lastObject ?? a.reached)) / 1000) + 1);
  const passes = tries.filter((a) => a.outcome === "pass");
  const top = passes.reduce<Attempt | null>((b, a) => (!b || better(a, b) ? a : b), null);
  return {
    md5,
    count: n.tries,
    passes: n.pass,
    fails: n.fail,
    left: n.left,
    ends,
    furthest: n.furthest,
    spot: spot ? { a: spot.section.a, b: spot.section.b, stops: spot.stops } : null,
    sincePass: last < 0 ? tries.length : tries.length - 1 - last,
    best: top ? { accuracy: top.accuracy, rank: top.rank, pp: top.pp, score: top.score } : null,
  };
}

/** Where the session began: the first try after the last hour without one (as on Home), not
 * before `from` ("New session"). No try for an hour: a new session starts now. */
export function sessionStartOf(tries: readonly Pick<Attempt, "started" | "ended">[], now: number, from = 0): number {
  const list = [...tries].sort((a, b) => b.started - a.started);
  if (!list.length || now - list[0].ended >= SESSION_GAP) return Math.max(now, from);
  let start = list[0].started;
  for (let i = 1; i < list.length; i++) {
    if (start - list[i].ended >= SESSION_GAP) break;
    start = list[i].started;
  }
  return Math.max(start, from);
}

/** `a` beats `b`: more pp when both have them, else the higher score. */
export function better(a: Pick<Attempt, "pp" | "score">, b: Pick<Attempt, "pp" | "score">): boolean {
  if (a.pp !== null && b.pp !== null && a.pp !== b.pp) return a.pp > b.pp;
  return a.score > b.score;
}
