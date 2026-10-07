/* Typed wrappers around the Tauri commands, plus fumen:// URLs. */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ApiError, LazerInstall, LibraryStatus, ScanProgress, Settings, Snapshot } from "./types";

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
};

export function onScanProgress(cb: (p: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan-progress", (e) => cb(e.payload));
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

export const osuSetUrl = (onlineId: number): string => `https://osu.ppy.sh/beatmapsets/${onlineId}`;
export const osuMapUrl = (setId: number, mapId: number, mode: number): string =>
  `https://osu.ppy.sh/beatmapsets/${setId}#${["osu", "taiko", "fruits", "mania"][mode] ?? "osu"}/${mapId}`;
