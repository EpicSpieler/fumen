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
let previewLoginCancelled = false;

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
        stable: {
          install: { path: String.raw`C:\Users\Preview\AppData\Local\osu!`, songs: String.raw`C:\Users\Preview\AppData\Local\osu!\Songs`, dbSize: 130784, dbModified: Date.now() - 86_400_000 },
          defaultPath: String.raw`C:\Users\Preview\AppData\Local\osu!`,
          enabled: true,
          scannedAt: scanned ? Date.now() - 120_000 : null,
          counts: scanned ? { sets: 14, maps: 183, collections: 0 } : null,
        },
      } as T;
    case "inspect_stable_path":
      return { path: String(args.path), songs: String(args.path) + String.raw`\Songs`, dbSize: 1, dbModified: Date.now() } as T;
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
    case "get_hitsounds": {
      // preview chart files carry their hitsounds (see preview_charts)
      const res = await fetch(`/__fumen/chart/${args.id as string}`);
      if (!res.ok) throw { code: "chart-missing", message: "This chart wasn't exported for the browser preview." };
      const chart = (await res.json()) as { hitsounds?: unknown };
      return (chart.hitsounds ?? { samples: [], events: [] }) as T;
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
    case "osu_account":
    case "osu_refresh_account":
      return JSON.parse(localStorage.getItem("fumen-preview-osu") ?? "null") as T;
    case "osu_login": {
      previewLoginCancelled = false;
      for (let i = 0; i < 25 && !previewLoginCancelled; i++) await new Promise((r) => setTimeout(r, 100));
      if (previewLoginCancelled) throw { code: "login-cancelled", message: "The login was cancelled." };
      const account = { id: 2, username: "Preview Player", avatar: null, country: "DE", mode: "mania", rank: 12345, countryRank: 678, pp: 7890.4 };
      localStorage.setItem("fumen-preview-osu", JSON.stringify(account));
      return account as T;
    }
    case "osu_login_cancel":
      previewLoginCancelled = true;
      return undefined as T;
    case "osu_logout":
      localStorage.removeItem("fumen-preview-osu");
      emit("history-changed", true);
      return undefined as T;
    case "get_history": {
      const res = await fetch("/__fumen/history");
      const history = (await res.json()) as { syncedAt?: number };
      // a sync in this preview moves the time on
      const synced = Number(localStorage.getItem("fumen-preview-synced") ?? 0);
      if (synced) history.syncedAt = synced;
      return history as T;
    }
    case "sync_osu_scores": {
      if (!localStorage.getItem("fumen-preview-osu")) throw { code: "osu-logged-out", message: "You're not logged in to osu!." };
      await new Promise((r) => setTimeout(r, 1500));
      const at = Date.now();
      localStorage.setItem("fumen-preview-synced", String(at));
      emit("history-changed", false);
      return { added: 0, total: 567, at } as T;
    }
    // Fumen's collections live in localStorage here (by library id; the app keeps MD5s)
    case "get_collections":
      return cols() as T;
    case "create_collection":
    case "copy_lazer_collection": {
      const a = args as { name: string; maps?: string[]; id?: string };
      const id = Math.random().toString(16).slice(2);
      const lazer = cmd === "copy_lazer_collection" ? await lazerCollectionIds(a.id!) : [];
      saveCols([...cols(), { id, name: a.name.trim(), created: Date.now(), maps: [...new Set(a.maps ?? lazer)], missing: 0 }]);
      return id as T;
    }
    case "create_smart_collection": {
      const id = Math.random().toString(16).slice(2);
      saveCols([...cols(), { id, name: String(args.name).trim(), created: Date.now(), maps: [], missing: 0, query: String(args.query) }]);
      return id as T;
    }
    case "set_collection_query":
      saveCols(cols().map((c) => (c.id === args.id && c.query !== undefined ? { ...c, query: String(args.query) } : c)));
      return null as T;
    case "put_collections_into_lazer": {
      // nothing is written here: the collections just remember a lazer id
      const picks = args.picks as { id: string }[];
      let created = 0;
      saveCols(cols().map((c) => (picks.some((p) => p.id === c.id) ? (c.lazerId ? c : (created++, { ...c, lazerId: crypto.randomUUID() })) : c)));
      await new Promise((r) => setTimeout(r, 600));
      return { created, updated: picks.length - created } as T;
    }
    case "save_collection_db":
      return (args.picks as unknown[]).length as T;
    case "rename_collection":
      saveCols(cols().map((c) => (c.id === args.id ? { ...c, name: String(args.name).trim() } : c)));
      return null as T;
    case "delete_collection":
      saveCols(cols().filter((c) => c.id !== args.id));
      return null as T;
    case "add_to_collection":
    case "remove_from_collection": {
      const maps = args.maps as string[];
      let n = 0;
      saveCols(
        cols().map((c) => {
          if (c.id !== args.id) return c;
          if (cmd === "add_to_collection") {
            const fresh = maps.filter((m) => !c.maps.includes(m));
            n = fresh.length;
            return { ...c, maps: [...c.maps, ...fresh] };
          }
          n = c.maps.filter((m) => maps.includes(m)).length;
          return { ...c, maps: c.maps.filter((m) => !maps.includes(m)) };
        }),
      );
      return n as T;
    }
    // goals live in localStorage here
    case "get_goals":
      return JSON.parse(localStorage.getItem("fumen-preview-goals") ?? "[]") as T;
    case "put_goal": {
      const goal = (args as { goal: { id: string } }).goal;
      const all = JSON.parse(localStorage.getItem("fumen-preview-goals") ?? "[]") as { id: string }[];
      const i = all.findIndex((g) => g.id === goal.id);
      if (i >= 0) all[i] = goal;
      else all.push(goal);
      localStorage.setItem("fumen-preview-goals", JSON.stringify(all));
      return null as T;
    }
    case "delete_goal": {
      const all = JSON.parse(localStorage.getItem("fumen-preview-goals") ?? "[]") as { id: string }[];
      localStorage.setItem("fumen-preview-goals", JSON.stringify(all.filter((g) => g.id !== (args as { id: string }).id)));
      return null as T;
    }
    case "sync_map_scores":
      return 0 as T;
    case "lazer_import_status": {
      // localStorage "fumen-preview-lazer": ready (default) | running | untested
      const mode = localStorage.getItem("fumen-preview-lazer") ?? "ready";
      const version = "2026.1005.0-lazer";
      const reasons: Record<string, [string, string]> = {
        running: ["running", "osu!lazer is running. Close it to import."],
        untested: ["untested", "osu!lazer 2026.1012.0 isn't tested with Fumen's import yet; importing stays off until it is."],
      };
      const [reason, message] = reasons[mode] ?? [null, null];
      return { ready: !reason, reason, message, version, tested: mode !== "untested", running: mode === "running", testedVersions: [version] } as T;
    }
    case "import_beatmaps": {
      // pretend: lines with "fail" fail, set 1 is in the library, everything else downloads
      const links = args.links as string[];
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const summary = { imported: 0, skipped: 0, failed: 0 };
      const ok: [number, number][] = [];
      for (const [index, link] of links.entries()) {
        const set = Number(/(\d+)/.exec(link)?.[1] ?? 0);
        const base = { index, set, title: null, done: 0, total: 0, message: null };
        if (/\/b(eatmaps)?\//.test(link)) {
          emit("import-progress", { ...base, set: null, stage: "resolving" });
          await wait(300);
        }
        if (set === 1) {
          emit("import-progress", { ...base, stage: "skipped", title: "Camellia - Ghost", message: "Already in your library" });
          summary.skipped++;
          continue;
        }
        const total = 4_000_000 + (set % 7) * 1_300_000;
        for (let done = 0; done <= total; done += total / 12) {
          emit("import-progress", { ...base, stage: "downloading", done: Math.round(done), total });
          await wait(70);
        }
        if (link.includes("fail")) {
          emit("import-progress", { ...base, stage: "error", message: "No download mirror has this set (osu.direct 404, catboy.best 403, nerinyan.moe 404)" });
          summary.failed++;
        } else ok.push([index, set]);
      }
      for (const [index, set] of ok) emit("import-progress", { index, set, stage: "importing", title: null, done: 0, total: 0, message: null });
      await wait(900);
      for (const [index, set] of ok) {
        emit("import-progress", { index, set, stage: "done", title: `Preview Artist - Song ${set}`, done: 0, total: 0, message: null });
        summary.imported++;
      }
      return summary as T;
    }
    default:
      throw { code: "preview", message: `${cmd} isn't available in the browser preview` };
  }
}

type PreviewCollection = { id: string; name: string; created: number; maps: string[]; missing: number; query?: string; lazerId?: string };
const cols = (): PreviewCollection[] => JSON.parse(localStorage.getItem("fumen-preview-collections") ?? "[]");
const saveCols = (c: PreviewCollection[]) => localStorage.setItem("fumen-preview-collections", JSON.stringify(c));
/** a lazer collection's difficulties, by library id, from the snapshot */
async function lazerCollectionIds(id: string): Promise<string[]> {
  const snap = await fetch("/__fumen/snapshot").then((r) => r.json());
  const c = snap.collections.find((x: { id: string }) => x.id === id);
  return c ? c.maps.map((i: number) => snap.maps[i].id) : [];
}
