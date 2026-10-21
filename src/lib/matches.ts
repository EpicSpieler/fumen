/* matches.ts — a pool's matches (src-tauri/src/matches.rs) and what they come to: each game of
 * the multiplayer room in its pool slot, who won it, the points, the picks it can tell, and each
 * player's strengths by kind of slot over the matches played.
 *
 * Red and blue: two players (osu!'s head-to-head rooms, the players found by name, else in the
 * order they first played) or two teams (team-vs rooms, by the team osu! put them in). A game
 * counts when it ended with scores, after the warm-ups; a map that isn't in the pool counts too
 * (and says so). Picks: the ones set by hand, else every other one from the first pick, the
 * tiebreaker nobody's. */
import { api, asApiError } from "./api";
import { t } from "./i18n";
import { kindOfSlot, poolById, slotChart, slotCodes, poolSlot, type Pool } from "./pools";
import { Emitter, events } from "./store";
import { toast } from "../ui/controls";

export type Side = "red" | "blue";

export interface Choice {
  side: Side;
  slot: string;
}

export interface MatchScore {
  user: number;
  score: number;
  /** 0–1 */
  acc: number;
  combo: number;
  misses: number;
  team: "red" | "blue" | "none";
  passed: boolean;
  mods: string[];
}

export interface MatchGame {
  id: number;
  beatmapId: number;
  setId?: number;
  /** "Artist - Title [Difficulty]" */
  title: string;
  start?: number;
  end?: number;
  mode: number;
  mods: string[];
  scoring: string;
  teamType: string;
  scores: MatchScore[];
}

export interface OsuMatch {
  id: number;
  name: string;
  start?: number;
  end?: number;
  users: { id: number; name: string; country?: string }[];
  games: MatchGame[];
}

export interface Match {
  id: string;
  poolId: string;
  red: string;
  blue: string;
  /** unix ms */
  at?: number;
  bestOf: number;
  mpId?: number;
  warmups: number;
  firstPick?: Side;
  bans: Choice[];
  picks: Choice[];
  result?: OsuMatch;
  fetched?: number;
  note: string;
  created: number;
  updated: number;
}

export interface MatchPatch {
  red?: string;
  blue?: string;
  /** 0: none */
  at?: number;
  bestOf?: number;
  warmups?: number;
  /** "": none */
  firstPick?: Side | "";
  bans?: Choice[];
  picks?: Choice[];
  note?: string;
}

export const other = (s: Side): Side => (s === "red" ? "blue" : "red");

// ── what a match comes to ───────────────────────────────────────────────

export interface PlayedGame {
  game: MatchGame;
  /** the pool's slot with this map (none: not in the pool) */
  slot: string | null;
  /** each side's number the game is decided on (score, accuracy or combo) */
  red: number | null;
  blue: number | null;
  /** each side's best accuracy (0–1) */
  redAcc: number | null;
  blueAcc: number | null;
  winner: Side | null;
  /** who picked it: set by hand, else every other one from the first pick */
  pickedBy: Side | null;
  tiebreaker: boolean;
  /** the 1-based number of the game that counts */
  n: number;
}

export interface MatchState {
  games: PlayedGame[];
  /** the game being played now */
  live: MatchGame | null;
  points: Record<Side, number>;
  /** wins it takes */
  firstTo: number;
  winner: Side | null;
  /** whose pick is next (null: the tiebreaker, or nobody knows) */
  nextPick: Side | null;
  status: "upcoming" | "live" | "done";
  /** osu!'s players on each side (head-to-head: one each, found by name or order) */
  players: Record<Side, { id: number; name: string }[]>;
}

const norm = (s: string) => s.trim().toLowerCase();

/** The pool's slot holding osu!'s difficulty `beatmapId`. */
export function slotOfBeatmap(pool: Pool, beatmapId: number): string | null {
  for (const code of slotCodes(pool.categories)) {
    const s = poolSlot(pool, code);
    if (!s) continue;
    const id = slotChart(s)?.beatmapId ?? s.onlineId;
    if (id === beatmapId) return code;
  }
  return null;
}

/** Who's red and who's blue in a head-to-head room: by name, else in the order they first played. */
function sidesOf(m: Match, room: OsuMatch, games: MatchGame[]): Record<Side, { id: number; name: string }[]> {
  const byName = (name: string) => room.users.find((u) => norm(u.name) === norm(name));
  const order: number[] = [];
  for (const g of games) for (const s of g.scores) if (!order.includes(s.user)) order.push(s.user);
  const named = { red: byName(m.red), blue: byName(m.blue) };
  const user = (id: number) => room.users.find((u) => u.id === id) ?? { id, name: String(id) };
  const left = order.filter((id) => id !== named.red?.id && id !== named.blue?.id);
  const red = named.red ?? (left.length ? user(left.shift()!) : undefined);
  const blue = named.blue ?? (left.length ? user(left.shift()!) : undefined);
  return { red: red ? [{ id: red.id, name: red.name }] : [], blue: blue ? [{ id: blue.id, name: blue.name }] : [] };
}

/** A match's games, points and what's next, against its pool's slots (`slotOf`: a map's slot). */
export function matchState(m: Match, slotOf: (beatmapId: number) => string | null, now = Date.now()): MatchState {
  const firstTo = Math.floor(m.bestOf / 2) + 1;
  const room = m.result;
  const ended = (room?.games ?? []).filter((g) => g.end !== undefined && g.scores.length > 0);
  const counted = ended.slice(m.warmups);
  const live = room && !room.end ? ([...(room.games ?? [])].reverse().find((g) => g.end === undefined) ?? null) : null;
  const teams = counted.some((g) => g.teamType.includes("team"));
  const players: MatchState["players"] = room ? (teams ? { red: [], blue: [] } : sidesOf(m, room, counted)) : { red: [], blue: [] };
  if (room && teams) {
    for (const g of counted)
      for (const s of g.scores) {
        if (s.team !== "red" && s.team !== "blue") continue;
        if (!players[s.team].some((p) => p.id === s.user)) players[s.team].push({ id: s.user, name: room.users.find((u) => u.id === s.user)?.name ?? String(s.user) });
      }
  }
  const sideOf = (s: MatchScore): Side | null => {
    if (teams) return s.team === "red" || s.team === "blue" ? s.team : null;
    if (players.red.some((p) => p.id === s.user)) return "red";
    if (players.blue.some((p) => p.id === s.user)) return "blue";
    return null;
  };

  const points: Record<Side, number> = { red: 0, blue: 0 };
  const games: PlayedGame[] = [];
  const manual = new Map(m.picks.map((c) => [c.slot, c.side]));
  for (const [i, g] of counted.entries()) {
    const value = (s: MatchScore) => (g.scoring === "accuracy" ? s.acc : g.scoring === "combo" ? s.combo : s.score);
    const sum: Record<Side, number | null> = { red: null, blue: null };
    const acc: Record<Side, number | null> = { red: null, blue: null };
    for (const s of g.scores) {
      const side = sideOf(s);
      if (!side) continue;
      // a team adds up; accuracy and combo rooms go by the side's best
      sum[side] = sum[side] === null ? value(s) : g.scoring === "accuracy" || g.scoring === "combo" ? Math.max(sum[side]!, value(s)) : sum[side]! + value(s);
      acc[side] = Math.max(acc[side] ?? 0, s.acc);
    }
    const winner = sum.red === null && sum.blue === null ? null : (sum.red ?? -1) > (sum.blue ?? -1) ? "red" : (sum.blue ?? -1) > (sum.red ?? -1) ? "blue" : null;
    const tiebreaker = points.red === firstTo - 1 && points.blue === firstTo - 1;
    const slot = slotOf(g.beatmapId);
    const pickedBy = tiebreaker ? null : ((slot ? manual.get(slot) : undefined) ?? (m.firstPick ? (i % 2 === 0 ? m.firstPick : other(m.firstPick)) : null));
    if (winner) points[winner]++;
    games.push({ game: g, slot, red: sum.red, blue: sum.blue, redAcc: acc.red, blueAcc: acc.blue, winner, pickedBy, tiebreaker, n: i + 1 });
  }
  const winner: Side | null = points.red >= firstTo ? "red" : points.blue >= firstTo ? "blue" : null;
  const atTb = points.red === firstTo - 1 && points.blue === firstTo - 1;
  const nextPick = winner || atTb || !m.firstPick ? null : games.length % 2 === 0 ? m.firstPick : other(m.firstPick);
  const status: MatchState["status"] = winner || room?.end ? "done" : room && (counted.length || live || (m.at ?? Infinity) <= now) ? "live" : "upcoming";
  return { games, live, points, firstTo, winner, nextPick, status, players };
}

// ── strengths by kind ───────────────────────────────────────────────────

export interface Strength {
  played: number;
  won: number;
  /** summed accuracy (0–1) over the games played */
  acc: number;
}

/** Each player's games by kind of slot over some matches: name → kind → strength. */
export function strengths(list: { match: Match; pool: Pool; state: MatchState }[]): Map<string, Map<string, Strength>> {
  const out = new Map<string, Map<string, Strength>>();
  for (const { match, pool, state } of list) {
    for (const g of state.games) {
      if (!g.slot) continue;
      const kind = kindOfSlot(pool, g.slot)?.code;
      if (!kind) continue;
      for (const side of ["red", "blue"] as const) {
        const own = g[side];
        if (own === null) continue;
        const names = state.players[side].length ? state.players[side].map((p) => p.name) : [side === "red" ? match.red : match.blue].filter(Boolean);
        for (const name of names) {
          const key = name;
          const kinds = out.get(key) ?? new Map<string, Strength>();
          const s = kinds.get(kind) ?? { played: 0, won: 0, acc: 0 };
          s.played++;
          if (g.winner === side) s.won++;
          s.acc += (side === "red" ? g.redAcc : g.blueAcc) ?? 0;
          kinds.set(kind, s);
          out.set(key, kinds);
        }
      }
    }
  }
  return out;
}

// ── the list ────────────────────────────────────────────────────────────

export const matchEvents = new Emitter<{ matches: Match[] }>();

let list: Match[] = [];
let loaded = false;
let started = false;

export const matches = (): Match[] => list;
export const matchById = (id: string): Match | undefined => list.find((m) => m.id === id);
export const matchesOf = (poolId: string): Match[] => list.filter((m) => m.poolId === poolId);
export const matchesLoaded = (): boolean => loaded;

export function initMatches(): void {
  if (started) return;
  started = true;
  void loadMatches();
  // a pool that goes takes its matches along
  events.on("library", () => void loadMatches());
}

export async function loadMatches(): Promise<void> {
  try {
    list = await api.getMatches();
    loaded = true;
    matchEvents.emit("matches", list);
  } catch (e) {
    console.warn("[matches]", asApiError(e).message);
  }
}

async function change<T>(run: () => Promise<T>, fail: string): Promise<T | undefined> {
  try {
    const out = await run();
    await loadMatches();
    return out;
  } catch (e) {
    toast(`${fail} ${asApiError(e).message}`, { kind: "danger" });
    await loadMatches();
    return undefined;
  }
}

export const createMatch = (pool: string, patch: MatchPatch) => change(() => api.createMatch(pool, patch), t("Couldn't make the match."));
export const updateMatch = (id: string, patch: MatchPatch) => change(() => api.updateMatch(id, patch), t("Couldn't change the match."));
export const deleteMatch = (id: string) => change(() => api.deleteMatch(id), t("Couldn't delete the match."));
/** Throws (the field says why). */
export async function setMatchRoom(id: string, link: string): Promise<void> {
  try {
    await api.setMatchRoom(id, link);
  } finally {
    await loadMatches();
  }
}

/** why osu! couldn't be asked about a match, the last time */
const problems = new Map<string, string>();
export const matchProblem = (id: string): string => problems.get(id) ?? "";
const asking = new Set<string>();

/** Asks osu! for the match's room again; the error's words when it can't. */
export async function refreshMatch(id: string): Promise<string | null> {
  if (asking.has(id)) return problems.get(id) ?? null;
  asking.add(id);
  try {
    const m = await api.refreshMatch(id);
    problems.delete(id);
    list = list.map((x) => (x.id === id ? m : x));
    return null;
  } catch (e) {
    const why = asApiError(e).message;
    problems.set(id, why);
    return why;
  } finally {
    asking.delete(id);
    matchEvents.emit("matches", list);
  }
}

// ── matches that are on: asked about every few seconds ──────────────────

/** how often a match that's on asks osu! again */
const WATCH_MS = 15_000;
const watching = new Map<string, number>();
let watchTimer = 0;

function watchTick(): void {
  if (document.hidden) return;
  for (const id of watching.keys()) {
    const m = matchById(id);
    const pool = m && poolById(m.poolId);
    if (!m?.mpId || !pool) continue;
    if (matchState(m, (b) => slotOfBeatmap(pool, b)).status === "done" && m.result?.end) continue;
    void refreshMatch(id);
  }
}

/** Keeps a match's games coming in while it's on (a page shows it, or it's on stream); returns
 * the stop. Asks at once when what's kept is a minute old. */
export function watchMatch(id: string): () => void {
  watching.set(id, (watching.get(id) ?? 0) + 1);
  const m = matchById(id);
  if (m?.mpId && (!m.fetched || Date.now() - m.fetched > 60_000)) void refreshMatch(id);
  if (!watchTimer) watchTimer = window.setInterval(watchTick, WATCH_MS);
  return () => {
    const n = (watching.get(id) ?? 1) - 1;
    if (n > 0) watching.set(id, n);
    else watching.delete(id);
    if (!watching.size) {
      clearInterval(watchTimer);
      watchTimer = 0;
    }
  };
}
