/* scan.ts — runs a library import and reports progress in words. */
import { api, asApiError, onScanProgress } from "./api";
import { events, refreshStatus, reloadLibrary, store } from "./store";
import type { ApiError, ScanProgress } from "./types";
import { t } from "./i18n";

const STAGES: Record<string, { label: string; from: number; to: number }> = {
  copy: { label: t("Copying lazer's database"), from: 0, to: 0.06 },
  sets: { label: t("Reading beatmaps"), from: 0.06, to: 0.78 },
  scores: { label: t("Reading scores"), from: 0.78, to: 0.86 },
  collections: { label: t("Reading collections"), from: 0.86, to: 0.9 },
  import: { label: t("Saving"), from: 0.9, to: 0.94 },
  stable: { label: t("Reading osu!stable"), from: 0.94, to: 1 },
};

export function describeScan(p: ScanProgress | null): { label: string; fraction: number } {
  if (!p) return { label: t("Starting"), fraction: 0 };
  const st = STAGES[p.stage] ?? { label: t("Working"), from: 0, to: 1 };
  const inner = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  return { label: st.label, fraction: st.from + (st.to - st.from) * inner };
}

let running: Promise<{ ok: true } | { ok: false; error: ApiError }> | null = null;

/** Imports the lazer library and swaps in the new snapshot. Concurrent calls share one run. */
export function runScan(): Promise<{ ok: true } | { ok: false; error: ApiError }> {
  if (running) return running;
  running = (async () => {
    const stop = await onScanProgress((p) => {
      store.scan = p;
      events.emit("scan", p);
    });
    store.scan = { stage: "copy", done: 0, total: 1 };
    events.emit("scan", store.scan);
    try {
      await api.scanLibrary();
      await reloadLibrary();
      await refreshStatus();
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: asApiError(e) };
    } finally {
      stop();
      store.scan = null;
      events.emit("scan", null);
      running = null;
    }
  })();
  return running;
}

export const isScanning = (): boolean => running !== null;
