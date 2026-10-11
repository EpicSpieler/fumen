/* history.ts — the player's plays (lazer's local scores plus osu!'s), loaded when first needed
 * and kept until they change, and the syncs with osu! that feed them. */
import { api, asApiError, onHistoryChanged } from "./api";
import { esc, num } from "./format";
import { Emitter, events, reloadLibrary, store } from "./store";
import type { ApiError, History, MapRow, OnlineMap, Play, Snapshot, SyncSummary } from "./types";

/** a sync at start only when the last one is older than this */
const SYNC_EVERY = 10 * 60 * 1000;

let current: History | null = null;
let loading: Promise<History> | null = null;
let syncing = false;
let byMap: Map<string, Play[]> | null = null;
let mapIndex: { snap: Snapshot; ids: Map<string, number> } | null = null;

export const historyEvents = new Emitter<{
  /** the plays were (re)loaded */
  history: History;
  /** a sync with osu! started or ended */
  sync: boolean;
}>();

export const historyNow = (): History | null => current;
export const isSyncing = (): boolean => syncing;

/** The plays; loaded once, then from memory until they change. */
export function loadHistory(force = false): Promise<History> {
  if (current && !force) return Promise.resolve(current);
  if (loading && !force) return loading;
  const job = api.getHistory().then((h) => {
    if (loading === job) {
      current = h;
      byMap = null;
      historyEvents.emit("history", h);
    }
    return h;
  });
  loading = job;
  void job.finally(() => {
    if (loading === job) loading = null;
  });
  return job;
}

/** A library difficulty's index by its id. */
export function mapIndexOf(id: string | undefined): number | undefined {
  const snap = store.snap;
  if (!snap || id === undefined) return undefined;
  if (mapIndex?.snap !== snap) mapIndex = { snap, ids: new Map(snap.maps.map((m, i) => [m.id, i])) };
  return mapIndex.ids.get(id);
}

/** One library difficulty's plays, newest first. */
export function playsOf(mapId: string): Play[] {
  if (!current) return [];
  if (!byMap) {
    byMap = new Map();
    for (const p of current.plays) {
      if (!p.map) continue;
      const list = byMap.get(p.map);
      if (list) list.push(p);
      else byMap.set(p.map, [p]);
    }
  }
  return byMap.get(mapId) ?? [];
}

/** What a play is on: the library difficulty, else what osu! said about it. */
export function playTarget(p: Play | { map?: string; beatmap?: number }): { map?: MapRow; mapIdx?: number; online?: OnlineMap } {
  const mapIdx = mapIndexOf(p.map);
  if (mapIdx !== undefined) return { map: store.snap!.maps[mapIdx], mapIdx };
  return { online: p.beatmap !== undefined ? current?.beatmaps[p.beatmap] : undefined };
}

export type SyncResult = { ok: true; summary: SyncSummary } | { ok: false; error: ApiError };

/** Reads the player's scores from osu! (once at a time). */
export async function syncHistory(): Promise<SyncResult> {
  if (syncing) return { ok: false, error: { code: "busy", message: "Already reading your scores from osu!." } };
  syncing = true;
  historyEvents.emit("sync", true);
  try {
    return { ok: true, summary: await api.syncOsuScores() };
  } catch (e) {
    return { ok: false, error: asApiError(e) };
  } finally {
    syncing = false;
    historyEvents.emit("sync", false);
  }
}

/** At start: a sync when logged in and the last one is older than 10 minutes. */
export async function syncIfStale(): Promise<void> {
  const account = await api.osuAccount().catch(() => null);
  if (!account) return;
  const h = await loadHistory().catch(() => null);
  if (h?.syncedAt && Date.now() - h.syncedAt < SYNC_EVERY) return;
  const res = await syncHistory();
  if (!res.ok) console.warn("[history] sync:", res.error.message);
}

/** Asks osu! for the player's scores on one difficulty: plays from other computers that the syncs'
 * top and recent plays don't reach. Only ranked, approved, qualified and loved difficulties have
 * scores on osu!; the backend asks at most every 10 minutes per difficulty. */
export function syncMap(map: MapRow): void {
  if (!map.onlineId || map.mode < 0 || map.status < 1 || map.status > 4) return;
  const modes = new Set([map.mode, ...playsOf(map.id).map((p) => p.mode).filter((m) => m >= 0)]);
  api.syncMapScores(map.onlineId, [...modes]).catch((e) => console.warn("[history] map scores:", asApiError(e).message));
}

let started = false;

/** Keeps the plays current: osu!'s side changed (sync, login, logout) or lazer's (a rescan). */
export function initHistory(): void {
  if (started) return;
  started = true;
  void onHistoryChanged((library) => {
    // a new snapshot reloads the plays too (below)
    if (library && store.snap) void reloadLibrary();
    else if (current) void loadHistory(true);
  });
  events.on("library", () => {
    mapIndex = null;
    if (current) void loadHistory(true);
  });
}

// ── words for a play ──────────────────────────────────────────────────────

const RATE_MODS: Record<string, number> = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

/** "HD DT", with the rate when it isn't the mod's usual one ("HT 0.90×"). */
export function modsText(p: Play): string {
  return (p.mods ?? [])
    .map((m) => (m in RATE_MODS && p.rate !== undefined && Math.abs(p.rate - RATE_MODS[m]) > 1e-6 ? `${m} ${p.rate.toFixed(2)}×` : m))
    .join(" ");
}

const HIT_WORDS: [string, string][] = [
  ["perfect", "Perfect"], ["great", "Great"], ["good", "Good"], ["ok", "Ok"], ["meh", "Meh"], ["miss", "Miss"],
];
const CATCH_WORDS: [string, string][] = [
  ["great", "Fruits"], ["large_tick_hit", "Drops"], ["small_tick_hit", "Droplets"], ["miss", "Miss"],
];

/** "900 Perfect, 80 Great, 2 Miss" */
export function hitsText(p: Play): string {
  const hits = p.hits ?? {};
  return (p.mode === 2 ? CATCH_WORDS : HIT_WORDS)
    .filter(([k]) => hits[k])
    .map(([k, word]) => `${num(hits[k])} ${word}`)
    .join(", ");
}

const dtf = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayMonthFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const fullDayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "14:32" */
export const timeOfDay = (ms: number): string => timeFmt.format(new Date(ms));

/** "Today, 14:32", "Yesterday, 21:10", "4 Oct", "4 Oct 2025" */
export function playWhen(ms: number): string {
  const day = (t: number) => new Date(t).toDateString();
  const now = Date.now();
  if (day(ms) === day(now)) return `Today, ${timeOfDay(ms)}`;
  if (day(ms) === day(now - 86_400_000)) return `Yesterday, ${timeOfDay(ms)}`;
  return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayMonthFmt : fullDayFmt).format(new Date(ms));
}

/** Tooltip for when a play was: the time, and where Fumen knows it from. */
export function playWhenTip(p: Play): string {
  const where = p.source === "osu" ? " · from osu!" : p.source === "lazer" ? " · this computer only" : "";
  return esc(`${dtf.format(new Date(p.date))}${where}`);
}

/** Tooltip for a play's grade: score, combo and judgements. */
export function playScoreTip(p: Play): string {
  const hits = hitsText(p);
  return esc([`${num(p.score)} score`, `${num(p.combo)}x combo`, hits].filter(Boolean).join(" · "));
}
