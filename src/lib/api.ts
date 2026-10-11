/* Typed wrappers around the Tauri commands, plus fumen:// URLs. */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Goal } from "./goals";
import type {
  ApiError,
  ChartData,
  ChartSounds,
  DanRating,
  FumenCollection,
  History,
  ImportProgress,
  ImportSummary,
  LazerImportStatus,
  LazerInstall,
  LibraryStatus,
  OsuAccount,
  ScanProgress,
  Settings,
  SkinList,
  Snapshot,
  SyncSummary,
} from "./types";

export const isTauri = "__TAURI_INTERNALS__" in window;

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings> | Record<string, unknown>) => invoke<Settings>("update_settings", { patch }),
  inspectLazerPath: (path: string) => invoke<LazerInstall | null>("inspect_lazer_path", { path }),
  libraryStatus: () => invoke<LibraryStatus>("library_status"),
  scanLibrary: () => invoke<{ sets: number; maps: number; scores: number; collections: number }>("scan_library"),
  async getLibrary(): Promise<Snapshot> {
    // raw JSON bytes (tauri::ipc::Response) — parse here, it's ~7 MB for a large library
    const raw = await invoke<ArrayBuffer | Snapshot>("get_library");
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as Snapshot;
    return raw;
  },
  async getChart(id: string): Promise<ChartData> {
    const raw = await invoke<ArrayBuffer | ChartData>("get_chart", { id });
    if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(raw)) as ChartData;
    return raw;
  },
  /** an osu!mania difficulty's dan at a clock rate */
  getDan: (id: string, rate: number) => invoke<DanRating | null>("get_dan", { id, rate }),
  /** an osu!mania difficulty's hitsounds */
  getHitsounds: (id: string) => invoke<ChartSounds>("get_hitsounds", { id }),
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
export function onHistoryChanged(cb: (library: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("history-changed", (e) => cb(e.payload));
}

export function onImportProgress(cb: (p: ImportProgress) => void): Promise<UnlistenFn> {
  return listen<ImportProgress>("import-progress", (e) => cb(e.payload));
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
