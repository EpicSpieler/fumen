/* Typed wrappers around the Tauri commands, plus fumen:// URLs. */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Comparison } from "./compare";
import type { Goal } from "./goals";
import type { ChartMods } from "./mods";
import type {
  CareReport, ApiError,
  ChartData,
  ChartSounds,
  OnlineReplayEntry,
  ReplayData,
  ReplayEntry,
  DanRating,
  CollectionPick, FumenCollection,
  History,
  ImportProgress,
  ImportSummary,
  PlayedFound,
  LazerImportStatus,
  RepairSummary,
  LazerInstall, StableInstall,
  LibraryStatus,
  MirrorPage, MirrorQuery,
  OsuAccount,
  ScanProgress,
  Settings,
  SkinList,
  Snapshot,
  SyncSummary,
} from "./types";

export const isTauri = "__TAURI_INTERNALS__" in window;
/** macOS: the window keeps its own title bar buttons (top left), shortcuts use ⌘ */
export const isMac = navigator.userAgent.includes("Mac OS");

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings> | Record<string, unknown>) => invoke<Settings>("update_settings", { patch }),
  inspectLazerPath: (path: string) => invoke<LazerInstall | null>("inspect_lazer_path", { path }),
  inspectStablePath: (path: string) => invoke<StableInstall | null>("inspect_stable_path", { path }),
  libraryStatus: () => invoke<LibraryStatus>("library_status"),
  libraryCare: () => invoke<CareReport>("library_care"),
  scanLibrary: () => invoke<{ sets: number; maps: number; scores: number; collections: number }>("scan_library"),
  async getLibrary(): Promise<Snapshot> {
    // raw JSON bytes (tauri::ipc::Response) — parse here, it's ~7 MB for a large library
    const raw = await invoke<ArrayBuffer | Snapshot>("get_library");
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as Snapshot;
    return raw;
  },
  /** a difficulty's chart; `mods`: the ones that change the chart itself (lib/mods) */
  async getChart(id: string, mods?: ChartMods): Promise<ChartData> {
    const raw = await invoke<ArrayBuffer | ChartData>("get_chart", { id, mods: mods ?? null });
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as ChartData;
    return raw;
  },
  /** an osu!mania difficulty's dan at a clock rate */
  getDan: (id: string, rate: number) => invoke<DanRating | null>("get_dan", { id, rate }),
  /** an osu!mania difficulty's hitsounds */
  getHitsounds: (id: string) => invoke<ChartSounds>("get_hitsounds", { id }),
  /** lazer's scores on a difficulty that come with a replay, best first */
  replaysForMap: (id: string) => invoke<ReplayEntry[]>("replays_for_map", { id }),
  /** a lazer score's replay frames ([time, x, y, buttons] each) */
  getReplay: (id: string) => invoke<ReplayData>("get_replay", { id }),
  /** the player's scores on osu! for a difficulty (one API request, when asked) */
  onlineReplaysForMap: (id: string) => invoke<OnlineReplayEntry[]>("online_replays_for_map", { id }),
  /** a score's replay from osu!, downloaded once and kept */
  getOnlineReplay: (id: number) => invoke<ReplayData>("get_online_replay", { id }),
  getSkins: () => invoke<SkinList>("get_skins"),
  /** [filename, sha256] per file */
  async getSkinFiles(id: string): Promise<[string, string][]> {
    const raw = await invoke<ArrayBuffer | [string, string][]>("get_skin_files", { id });
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as [string, string][];
    return raw;
  },
  /** whether sets can be imported into osu!lazer right now */
  lazerImportStatus: () => invoke<LazerImportStatus>("lazer_import_status"),
  /** downloads the sets behind osu! links and imports them into lazer (progress: onImportProgress) */
  importBeatmaps: (links: string[]) => invoke<ImportSummary>("import_beatmaps", { links }),
  /** every collection into the cloud (fumen.dertesti.dev), under the osu! login */
  cloudPushCollections: () => invoke<{ collections: number; saved: number }>("cloud_push_collections"),
  /** the cloud's collections merged into this library; the sets they want that it doesn't have */
  cloudPullCollections: () =>
    invoke<{ collections: number; created: number; added: number; missing: { id: number; maps: number }[]; saved: number }>("cloud_pull_collections"),
  /** one page of a beatmap search on the mirrors (never osu!'s servers) */
  searchMirrors: (query: MirrorQuery) => invoke<MirrorPage>("search_mirrors", { query }),
  /** stops the running import after the sets being imported right now */
  cancelImport: () => invoke<void>("cancel_import"),
  repairLazerSets: () => invoke<RepairSummary>("repair_lazer_sets"),
  /** another player's osu!mania plays and charts, for comparing skills (lib/compare.ts) */
  comparePlayer: async (name: string): Promise<Comparison> => {
    const raw = await invoke<ArrayBuffer | Comparison>("compare_player", { name });
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as Comparison;
    return raw;
  },
  cancelCompare: () => invoke<void>("cancel_compare"),
  /** every set the player has played that osu!lazer doesn't have (progress: onPlayedProgress) */
  findPlayedSets: () => invoke<PlayedFound>("find_played_sets"),
  /** the osu! account as last seen (no network) */
  osuAccount: () => invoke<OsuAccount | null>("osu_account"),
  /** logs in through the browser; resolves once it's back */
  osuLogin: () => invoke<OsuAccount>("osu_login"),
  osuLoginCancel: () => invoke<void>("osu_login_cancel"),
  /** the account as osu! has it now; null when not logged in (anymore) */
  osuRefreshAccount: () => invoke<OsuAccount | null>("osu_refresh_account"),
  osuLogout: () => invoke<void>("osu_logout"),
  /** the player's plays, local and from osu! */
  async getHistory(): Promise<History> {
    const raw = await invoke<ArrayBuffer | History>("get_history");
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as History;
    return raw;
  },
  /** reads the player's scores, stats and play counts from osu! */
  syncOsuScores: () => invoke<SyncSummary>("sync_osu_scores"),
  /** reads the player's scores on one difficulty (osu!'s id) from osu!; how many were new */
  syncMapScores: (beatmapId: number, modes: number[]) => invoke<number>("sync_map_scores", { beatmapId, modes }),
  /** Fumen's own collections (lib/collections.ts); maps are library difficulty ids */
  getCollections: () => invoke<FumenCollection[]>("get_collections"),
  createCollection: (name: string, maps: string[] = []) => invoke<string>("create_collection", { name, maps }),
  copyLazerCollection: (id: string, name: string) => invoke<string>("copy_lazer_collection", { id, name }),
  /** a saved search (FilterState as JSON) as a smart collection */
  createSmartCollection: (name: string, query: string) => invoke<string>("create_smart_collection", { name, query }),
  setCollectionQuery: (id: string, query: string) => invoke<void>("set_collection_query", { id, query }),
  /** into lazer's collections (lazer closed, tested version, backup first); then a rescan */
  putCollectionsIntoLazer: (picks: CollectionPick[]) => invoke<{ created: number; updated: number }>("put_collections_into_lazer", { picks }),
  /** lazer's own Delete on these sets (lazer removes them for good when it next starts) */
  deleteSetsInLazer: (ids: string[]) => invoke<{ deleted: number; skipped: number }>("delete_sets_in_lazer", { ids }),
  /** a stable collection.db at `path`; how many collections went in */
  saveCollectionDb: (path: string, picks: CollectionPick[]) => invoke<number>("save_collection_db", { path, picks }),
  renameCollection: (id: string, name: string) => invoke<void>("rename_collection", { id, name }),
  deleteCollection: (id: string) => invoke<void>("delete_collection", { id }),
  /** how many weren't in it yet */
  addToCollection: (id: string, maps: string[]) => invoke<number>("add_to_collection", { id, maps }),
  /** how many were in it */
  removeFromCollection: (id: string, maps: string[]) => invoke<number>("remove_from_collection", { id, maps }),
  /** the player's goals, oldest first (lib/goals.ts) */
  getGoals: () => invoke<Goal[]>("get_goals"),
  putGoal: (goal: Goal) => invoke<void>("put_goal", { goal }),
  deleteGoal: (id: string) => invoke<void>("delete_goal", { id }),
};

export function onScanProgress(cb: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan-progress", (e) => cb(e.payload));
}

/** The plays changed (sync, login, logout); `library`: the library's best scores may have too. */
export function onCareProgress(cb: (p: { done: number; total: number }) => void): Promise<UnlistenFn> {
  return listen<{ done: number; total: number }>("care-progress", (e) => cb(e.payload));
}

export function onHistoryChanged(cb: (library: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("history-changed", (e) => cb(e.payload));
}

export function onImportProgress(cb: (p: ImportProgress) => void): Promise<UnlistenFn> {
  return listen<ImportProgress>("import-progress", (e) => cb(e.payload));
}

/** finding played sets: play counts and scores read from osu! so far */
export function onPlayedProgress(cb: (read: number) => void): Promise<UnlistenFn> {
  return listen<number>("played-progress", (e) => cb(e.payload));
}

/** Background chart analysis of the whole library (after imports and on start). */
export function onAnalysis(progress: (p: ScanProgress) => void, done: () => void): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<ScanProgress>("analysis-progress", (e) => progress(e.payload)),
    listen("analysis-done", () => done()),
  ]);
}

export function asApiError(e: unknown): ApiError {
  if (e && typeof e === "object" && "message" in e) {
    const o = e as { code?: unknown; message?: unknown };
    return { code: String(o.code ?? "unknown"), message: String(o.message) };
  }
  return { code: "unknown", message: String(e) };
}

// ── fumen:// ───────────────────────────────────────────────────────────────
// WebView2 (Windows) serves custom schemes as http://<scheme>.localhost. The browser preview
// (tools/browser-preview) points this at its own dev-server routes.
const BASE =
  (window as { __FUMEN_BASE__?: string }).__FUMEN_BASE__ ??
  (navigator.userAgent.includes("Windows") ? "http://fumen.localhost/" : "fumen://localhost/");

export const fileUrl = (hash: string): string => `${BASE}file/${hash}`;
export const thumbUrl = (hash: string, width: number): string => `${BASE}thumb/${width}/${hash}`;
/** lazer's built-in skin files: classic / retro textures, hit sounds of all of them */
export type BuiltinSkin = "classic" | "retro" | "triangles" | "argon" | "argon-pro";
export const builtinSkinUrl = (skin: BuiltinSkin, name: string): string => `${BASE}skin/${skin}/${encodeURIComponent(name)}`;

export const osuSetUrl = (onlineId: number): string => `https://osu.ppy.sh/beatmapsets/${onlineId}`;
export const osuMapUrl = (setId: number, mapId: number, mode: number): string =>
  `https://osu.ppy.sh/beatmapsets/${setId}#${["osu", "taiko", "fruits", "mania"][mode] ?? "osu"}/${mapId}`;
export const osuScoreUrl = (id: number): string => `https://osu.ppy.sh/scores/${id}`;
/** a set's cover on osu! (list: 150×150, @2x: 300×300) */
export const osuCoverUrl = (setId: number): string => `https://assets.ppy.sh/beatmaps/${setId}/covers/list@2x.jpg`;
