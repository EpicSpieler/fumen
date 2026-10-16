/* compare.ts — another osu! player's osu!mania skills, next to yours on the Skills page.
 *
 * The backend (src-tauri/src/player.rs) reads their plays from osu! (top plays, firsts, recent
 * passes, their best on their most played difficulties) and analyses the charts behind them, from
 * the library or the mirrors. Their skills are worked out here exactly like yours (lib/skills.ts),
 * on those charts instead of the library's.
 */
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { num } from "./format";
import { Emitter } from "./store";
import type { MapRow, Play } from "./types";
import { t } from "./i18n";

export interface ComparedPlayer {
  id: number;
  name: string;
  avatar?: string;
  country?: string;
  rank?: number;
  countryRank?: number;
  pp?: number;
  /** 0–1 */
  accuracy?: number;
  playCount?: number;
}

/** A difficulty their plays are on, analysed like the library's. */
export interface ComparedChart {
  /** "o<osu!'s id>": what their plays point at */
  id: string;
  beatmapId: number;
  setId?: number;
  mode: number;
  /** keys */
  cs: number;
  sr: number;
  srHt: number;
  srDt: number;
  shares?: number[];
  version: string;
  title: string;
  titleUnicode?: string;
  artist: string;
  artistUnicode?: string;
  creator: string;
  /** the library's difficulty, when you have it */
  library?: string;
}

export interface Comparison {
  player: ComparedPlayer;
  charts: ComparedChart[];
  plays: Play[];
  counts: { top: number; firsts: number; recent: number; mostPlayed: number };
  /** difficulties played that no mirror had */
  unreadable: number;
}

export interface CompareProgress {
  stage: "player" | "scores" | "charts";
  done: number;
  total: number;
}

export type CompareState =
  | { status: "loading"; name: string; progress: CompareProgress | null }
  | { status: "ready"; name: string; data: Comparison; maps: MapRow[]; index: Map<string, number> }
  | { status: "error"; name: string; error: string };

let state: CompareState | null = null;
/** each comparison asked for, so a late answer to an older one is dropped */
let generation = 0;
export const compareEvents = new Emitter<{ compare: CompareState | null }>();

export const compareNow = (): CompareState | null => state;

const RECENT_KEY = "fumen-compare-recent";
const RECENT_MAX = 6;

/** Players compared lately, newest first. */
export function recentPlayers(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is string => typeof n === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(name: string): void {
  try {
    const list = [name, ...recentPlayers().filter((n) => n.toLowerCase() !== name.toLowerCase())].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* only a convenience */
  }
}

function set(s: CompareState | null): void {
  state = s;
  compareEvents.emit("compare", s);
}

/** Their charts as library-like rows, for lib/skills and lib/similar. `set` is no index into the
 * library: it's osu!'s set id negated (a set's difficulties go together), below every one of those
 * when osu! didn't say. */
function asMaps(charts: ComparedChart[]): MapRow[] {
  return charts.map(
    (c, i) =>
      ({
        set: c.setId ? -c.setId : -1_000_000_000 - i,
        id: c.id,
        onlineId: c.beatmapId,
        version: c.version,
        mode: c.mode,
        status: 0,
        sr: c.sr,
        bpm: 0,
        length: 0,
        objects: 0,
        holds: 0,
        hp: 0,
        cs: c.cs,
        od: 0,
        ar: 0,
        srHt: c.srHt,
        srDt: c.srDt,
        shares: c.shares,
      }) satisfies MapRow,
  );
}

/** Compares with the player called `name`. */
export async function compareWith(name: string): Promise<void> {
  const n = name.trim();
  if (!n) return;
  const mine = ++generation;
  set({ status: "loading", name: n, progress: null });
  const stop = await listen<CompareProgress>("compare-progress", (e) => {
    if (mine !== generation || state?.status !== "loading") return;
    set({ ...state, progress: e.payload });
  });
  try {
    const data = await api.comparePlayer(n);
    if (mine !== generation) return;
    const maps = asMaps(data.charts);
    set({ status: "ready", name: data.player.name || n, data, maps, index: new Map(maps.map((m, i) => [m.id, i])) });
    remember(data.player.name || n);
  } catch (e) {
    if (mine !== generation) return;
    const err = e as { code?: string; message?: string };
    if (err.code === "cancelled") return;
    set({ status: "error", name: n, error: err.message ?? String(e) });
  } finally {
    stop();
  }
}

/** Ends the comparison (stopping it if it's still running). */
export function endCompare(): void {
  generation++;
  if (state?.status === "loading") void api.cancelCompare().catch(() => {});
  set(null);
}

/** "Reading their plays · 12 of 70" */
export function progressText(p: CompareProgress | null): string {
  if (!p || p.stage === "player") return t("Finding the player on osu!");
  if (p.stage === "scores") return t("Reading their plays from osu! · {done} of {total}", { done: num(p.done), total: num(p.total) });
  return t("Reading the charts · {done} of {total}", { done: num(p.done), total: num(p.total) });
}

/** 0–1 along the whole comparison: osu! first, then the charts. */
export function progressShare(p: CompareProgress | null): number {
  if (!p || p.stage === "player") return 0.02;
  if (p.stage === "scores") return 0.02 + 0.48 * (p.total ? p.done / p.total : 0);
  return 0.5 + 0.5 * (p.total ? p.done / p.total : 1);
}
