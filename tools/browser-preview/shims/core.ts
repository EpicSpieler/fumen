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
let previewImportCancel = false;
let previewCompareCancel = false;

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
      // the mods that change the chart come as files of their own (see preview_charts)
      const m = args.mods as { easy?: boolean; hardRock?: boolean; mirror?: boolean } | null | undefined;
      const mods = m ? (m.easy ? "EZ" : "") + (m.hardRock ? "HR" : "") + (m.mirror ? "MR" : "") : "";
      const res = await fetch(`/__fumen/chart/${args.id as string}${mods ? `+${mods}` : ""}`);
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
    case "compare_player": {
      // a made-up strong player on the snapshot's osu!mania charts (half "not in your library");
      // "nobody" isn't found
      const name = String((args as { name: string }).name).trim();
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      previewCompareCancel = false;
      emit("compare-progress", { stage: "player", done: 0, total: 0 });
      await wait(400);
      if (name.toLowerCase() === "nobody") throw { code: "player-not-found", message: `osu! has no player called ${name}.` };
      for (let i = 1; i <= 12; i++) {
        if (previewCompareCancel) throw { code: "cancelled", message: "Cancelled" };
        emit("compare-progress", { stage: "scores", done: i, total: 12 });
        await wait(120);
      }
      const snap = (await fetch("/__fumen/snapshot").then((r) => r.json())) as {
        maps: { id: string; mode: number; cs: number; sr: number; srHt?: number; srDt?: number; shares?: number[]; version: string; set: number; onlineId?: number }[];
        sets: { title: string; artist: string; creator: string; onlineId?: number }[];
      };
      // every eighth of the 640 hardest: a strong player who plays a spread
      const pool = snap.maps
        .filter((m) => m.mode === 3 && m.shares && Math.round(m.cs) === 4)
        .sort((a, b) => b.sr - a.sr)
        .slice(0, 640)
        .filter((_, i) => i % 8 === 0);
      const charts = pool.map((m, i) => {
        const set = snap.sets[m.set];
        return {
          id: `o${1000 + i}`,
          beatmapId: 1000 + i,
          setId: set.onlineId ?? 1225016,
          mode: 3,
          cs: 4,
          sr: m.sr,
          srHt: m.srHt ?? m.sr * 0.8,
          srDt: m.srDt ?? m.sr * 1.4,
          shares: m.shares,
          version: m.version,
          title: set.title,
          artist: set.artist,
          creator: set.creator,
          library: i % 2 ? m.id : undefined,
        };
      });
      for (let i = 1; i <= charts.length; i += 4) {
        if (previewCompareCancel) throw { code: "cancelled", message: "Cancelled" };
        emit("compare-progress", { stage: "charts", done: Math.min(i + 3, charts.length), total: charts.length });
        await wait(40);
      }
      const plays = charts.map((c, i) => ({
        map: c.id,
        beatmapId: c.beatmapId,
        mode: 3,
        date: Date.now() - i * 86_400_000,
        rank: 4,
        acc: 0.99 - (i % 7) * 0.008,
        score: 950_000,
        combo: 1000,
        mods: i % 5 === 0 ? ["DT"] : [],
        rate: i % 5 === 0 ? 1.5 : undefined,
        source: "osu",
        id: 5000 + i,
        top: i + 1,
      }));
      return {
        player: { id: 7, name: name || "Preview Rival", avatar: undefined, country: "KR", rank: 1234, countryRank: 56, pp: 9876.5, accuracy: 0.9812, playCount: 45678 },
        charts,
        plays,
        counts: { top: 80, firsts: 3, recent: 2, mostPlayed: 12 },
        unreadable: 2,
      } as T;
    }
    case "cancel_compare":
      previewCompareCancel = true;
      return undefined as T;
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
      // localStorage "fumen-preview-unfinished": sets an older Fumen left without details
      const unfinished = Number(localStorage.getItem("fumen-preview-unfinished") ?? "0");
      return { ready: !reason, reason, message, version, tested: mode !== "untested", running: mode === "running", testedVersions: [version], unfinished } as T;
    }
    case "repair_lazer_sets": {
      const finished = Number(localStorage.getItem("fumen-preview-unfinished") ?? "0");
      await new Promise((r) => setTimeout(r, 1800));
      localStorage.setItem("fumen-preview-unfinished", "0");
      return { finished, failed: 0 } as T;
    }
    case "cancel_import":
      previewImportCancel = true;
      return null as T;
    case "find_played_sets": {
      // localStorage "fumen-preview-osu" decides the login; real set ids, so covers load
      const ids = [1, 39804, 41823, 320118, 352570, 372245, 413674, 431271, 539697, 553734, 580215, 627629, 654936, 703008, 774965, 853167, 920979, 1010865, 1068436, 1159279];
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let read = 100; read <= 1240; read += 100) {
        emit("played-progress", read);
        await wait(140);
      }
      const missing = Array.from({ length: 214 }, (_, i) => {
        const id = i < ids.length ? ids[i] : 1_200_000 + i * 977;
        return {
          id,
          title: `Preview Song ${i + 1}`,
          artist: ["Camellia", "xi", "LeaF", "Sakuzyo", "nora2r"][i % 5],
          creator: ["Lasse", "Evening", "Shoegazer"][i % 3],
          plays: Math.max(0, 180 - i),
          maps: 1 + (i % 4),
          status: i % 6 ? "ranked" : "loved",
          top: i % 7 === 0,
          inStable: i % 5 === 0,
        };
      });
      return { missing, played: 1031, read: 1240 } as T;
    }
    case "import_beatmaps": {
      // pretend: lines with "fail" (and every 9th set) fail, set 1 is in the library; three
      // downloads at once, lazer imports in batches of 20
      previewImportCancel = false;
      const links = args.links as string[];
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const summary = { imported: 0, skipped: 0, failed: 0, cancelled: 0, stopped: null };
      const queue: [number, string][] = [...links.entries()];
      const ready: [number, number][] = [];
      const idle = (index: number, set: number | null, stage: string, extra: Record<string, unknown> = {}) =>
        emit("import-progress", { index, set, stage, title: null, done: 0, total: 0, message: null, ...extra });
      const downloader = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const [index, link] = next;
          const set = Number(/(\d+)/.exec(link)?.[1] ?? 0);
          if (previewImportCancel) {
            idle(index, set, "skipped", { message: "Cancelled" });
            summary.cancelled++;
            continue;
          }
          if (/\/b(eatmaps)?\//.test(link)) {
            idle(index, null, "resolving");
            await wait(300);
          }
          if (set === 1) {
            idle(index, set, "skipped", { title: "Camellia - Ghost", message: "Already in your library" });
            summary.skipped++;
            continue;
          }
          // every 5th set waits for a rate-limited mirror for a few seconds first
          if (index % 5 === 3) {
            for (let s = 4; s > 0 && !previewImportCancel; s--) {
              idle(index, set, "held", { total: s });
              await wait(1000);
            }
          }
          const total = 4_000_000 + (set % 7) * 1_300_000;
          for (let done = 0; done <= total && !previewImportCancel; done += total / 10) {
            idle(index, set, "downloading", { done: Math.round(done), total });
            await wait(90);
          }
          if (previewImportCancel) {
            idle(index, set, "skipped", { message: "Cancelled" });
            summary.cancelled++;
          } else if (link.includes("fail") || index % 9 === 8) {
            idle(index, set, "error", { message: "No download mirror has this set (osu.direct 404, nekoha.moe 404, catboy.best 404, beatconnect.io 404, sayobot.cn 403, nerinyan.moe 404)" });
            summary.failed++;
          } else {
            idle(index, set, "ready");
            ready.push([index, set]);
          }
        }
      };
      let downloading = true;
      const downloads = Promise.all([downloader(), downloader(), downloader()]).then(() => (downloading = false));
      while (downloading || ready.length) {
        if (previewImportCancel) {
          for (const [index, set] of ready.splice(0)) {
            idle(index, set, "skipped", { message: "Cancelled" });
            summary.cancelled++;
          }
          await wait(100);
          continue;
        }
        if (ready.length >= 20 || (!downloading && ready.length)) {
          const batch = ready.splice(0, 20);
          for (const [index, set] of batch) idle(index, set, "importing");
          await wait(1400);
          for (const [index, set] of batch) {
            idle(index, set, "done");
            summary.imported++;
          }
        } else await wait(100);
      }
      await downloads;
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
