/* Browser-preview stand-in for @tauri-apps/api/core. */
import { emit } from "./event";

const SETTINGS_KEY = "fumen-preview-settings";

function settings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "") as Record<string, unknown>;
  } catch {
    return { lazerPath: null, autoRescan: true, ui: {} };
  }
}

const install = { path: "C:\\Users\\you\\AppData\\Roaming\\osu", storage: "C:\\Users\\you\\AppData\\Roaming\\osu", realmSize: 31457280, realmModified: Date.now() - 86_400_000 };
let scanned = localStorage.getItem("fumen-preview-scanned") !== "0";

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  switch (cmd) {
    case "get_settings":
      return settings() as T;
    case "update_settings": {
      const cur = settings();
      const patch = args.patch as Record<string, unknown>;
      const next = { ...cur, ...patch, ui: { ...(cur.ui as object), ...((patch.ui as object) ?? {}) } };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return next as T;
    }
    case "inspect_lazer_path":
      return install as T;
    case "library_status":
      return {
        install,
        defaultPath: install.path,
        scannedAt: scanned ? Date.now() - 120_000 : null,
        counts: scanned ? { sets: 4505, maps: 21756, scores: 1430, collections: 5 } : null,
        changed: false,
        scanning: false,
      } as T;
    case "get_library": {
      const res = await fetch("/__fumen/snapshot");
      return (await res.arrayBuffer()) as T;
    }
    case "get_chart": {
      const res = await fetch(`/__fumen/chart/${args.id as string}`);
      if (!res.ok) throw { code: "chart-missing", message: "This chart wasn't exported for the browser preview (see preview_charts)." };
      return (await res.arrayBuffer()) as T;
    }
    case "get_dan": {
      // preview chart files carry the dan at every rate the panel offers (see preview_charts)
      const res = await fetch(`/__fumen/chart/${args.id as string}`);
      if (!res.ok) throw { code: "chart-missing", message: "This chart wasn't exported for the browser preview." };
      const chart = (await res.json()) as { dans?: Record<string, unknown> };
      return (chart.dans?.[(args.rate as number).toFixed(2)] ?? null) as T;
    }
    case "get_skins": {
      const list = (await (await fetch("/__fumen/skins")).json()) as { skins: { files?: unknown }[] };
      return { ...list, skins: list.skins.map(({ files: _files, ...s }) => s) } as T;
    }
    case "get_skin_files": {
      const list = (await (await fetch("/__fumen/skins")).json()) as { skins: { id: string; files: [string, string][] }[] };
      const skin = list.skins.find((s) => s.id === args.id);
      if (!skin) throw { code: "skin-missing", message: "This skin isn't in the preview data." };
      return skin.files as T;
    }
    case "scan_library": {
      const stages: [string, number][] = [["copy", 1], ["sets", 4505], ["scores", 1430], ["collections", 5], ["import", 1]];
      for (const [stage, total] of stages) {
        for (let i = 0; i <= 4; i++) {
          emit("scan-progress", { stage, done: Math.round((total * i) / 4), total });
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      scanned = true;
      localStorage.setItem("fumen-preview-scanned", "1");
      return { sets: 4505, maps: 21756, scores: 1430, collections: 5 } as T;
    }
    default:
      throw { code: "preview", message: `${cmd} isn't available in the browser preview` };
  }
}
