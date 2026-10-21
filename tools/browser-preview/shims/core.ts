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

export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}, options?: { headers?: Record<string, string> }): Promise<T> {
  switch (cmd) {
    case "save_file": {
      // the browser's download in place of the save dialog
      const name = decodeURIComponent(options?.headers?.["x-fumen-name"] ?? "fumen");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([args as unknown as Uint8Array<ArrayBuffer>]));
      a.download = name;
      a.click();
      return name as T;
    }
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
    case "get_matches":
    case "create_match":
    case "update_match":
    case "delete_match":
    case "set_match_room":
    case "refresh_match":
      return previewMatches(cmd, args) as T;
    case "overlay_port":
    case "overlay_stop":
    case "overlay_state":
      return null as T;
    case "overlay_start":
      return 24180 as T;
    case "get_pools":
    case "create_pool":
    case "update_pool":
    case "delete_pool":
    case "set_pool_slot":
    case "set_pool_slot_online":
    case "clear_pool_slot":
    case "swap_pool_slots":
    case "set_pool_slot_note":
      return previewPools(cmd, args) as T;
    case "get_pp": {
      // osu!mania's pp formula on Fumen's star ratings (no Rust here); the other rulesets get a
      // made-up curve, enough to see the panel
      const res = await fetch(`/__fumen/chart/${args.id as string}`);
      if (!res.ok) throw { code: "chart-missing", message: "This chart wasn't exported for the browser preview." };
      const chart = (await res.json()) as { mode: number; stars: number[]; analysis: { notes: number; holds: number } };
      const rate = args.rate as number;
      const mods = args.mods as string[];
      const mania = chart.mode === 3;
      const sr = chart.stars[Math.round((rate - 0.5) / 0.05)] ?? 3;
      const total = mania ? chart.analysis.notes + chart.analysis.holds : chart.analysis.notes;
      const mult = (mods.includes("NF") ? 0.75 : 1) * (mods.includes("EZ") ? 0.5 : 1);
      type Hits = { great?: number; good?: number; ok?: number; meh?: number; miss?: number; tinyMiss?: number; acc?: number };
      const price = (h: Hits) => {
        const acc =
          h.acc !== undefined
            ? h.acc / 100
            : 1 - ((h.great ?? 0) * 20 + (h.good ?? 0) * 120 + (h.ok ?? 0) * 220 + (h.meh ?? 0) * 270 + (h.miss ?? 0) * 320) / (320 * Math.max(1, total));
        const pp = mania
          ? 8 * Math.max(sr - 0.15, 0.05) ** 2.2 * Math.max(0, 5 * acc - 4) * (1 + 0.1 * Math.min(1, total / 1500))
          : 20 * (chart.mode === 1 ? 4.5 : 5) ** 2.4 * acc ** 6 * 0.96 ** (h.miss ?? 0);
        return { pp: pp * mult, acc: Math.max(0, acc) };
      };
      return { mode: chart.mode, stars: sr, max: price({}).pp, maxCombo: total, total, tiny: chart.mode === 2 ? 200 : 0, plays: (args.plays as Hits[]).map(price) } as T;
    }
    case "get_hitsounds": {
      // preview chart files carry their hitsounds (see preview_charts)
      const res = await fetch(`/__fumen/chart/${args.id as string}`);
      if (!res.ok) throw { code: "chart-missing", message: "This chart wasn't exported for the browser preview." };
      const chart = (await res.json()) as { hitsounds?: unknown };
      return (chart.hitsounds ?? { samples: [], events: [] }) as T;
    }
    case "replays_for_map": {
      const r = (await (await fetch(`/__fumen/replays/${args.id as string}`)).json()) as { entries: unknown[] };
      return r.entries as T;
    }
    case "get_replay": {
      // every cached replay, by score id
      const all = (await (await fetch("/__fumen/replay-index")).json()) as Record<string, unknown>;
      const r = all[args.id as string];
      if (!r) throw { code: "replay-missing", message: "Not in the preview cache." };
      return r as T;
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
    case "library_care": {
      // measuring the files, the first time
      const first = !sessionStorage.getItem("fumen-preview-care");
      if (first) {
        for (let i = 0; i <= 10; i++) {
          emit("care-progress", { done: i * 9800, total: 98000 });
          await new Promise((r) => setTimeout(r, 120));
        }
        sessionStorage.setItem("fumen-preview-care", "1");
      }
      return (await (await fetch("/__fumen/care")).json()) as T;
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
    case "delete_sets_in_lazer": {
      // nothing is deleted here
      await new Promise((r) => setTimeout(r, 600));
      return { deleted: (args.ids as unknown[]).length, skipped: 0 } as T;
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
    case "search_mirrors": {
      // the real osu.direct search, from the page (it allows that); filtered like mirror_search.rs
      const q = args.query as { text: string; mode: number | null; keys: number[]; srMin: number | null; srMax: number | null; status: number[]; sort: string; page: number };
      const filters = [
        ...(q.keys.length && (q.mode === null || q.mode === 3) ? [`(${q.keys.map((k) => `beatmaps.cs = ${k}`).join(" OR ")})`] : []),
        ...(q.srMin !== null ? [`beatmaps.difficulty_rating >= ${q.srMin}`] : []),
        ...(q.srMax !== null ? [`beatmaps.difficulty_rating <= ${q.srMax}`] : []),
      ];
      const sorts: Record<string, string> = { ranked: "ranked_date:desc", plays: "play_count:desc", favourites: "favourite_count:desc", stars: "beatmaps.difficulty_rating:asc", newest: "last_updated:desc" };
      const sort = q.sort === "relevance" ? (q.text ? "" : sorts.ranked) : sorts[q.sort];
      const p = new URLSearchParams({ q: [q.text, filters.length ? `[${filters.join(" AND ")}]` : ""].filter(Boolean).join(" "), amount: "50", offset: String(q.page * 50) });
      if (q.mode !== null) p.set("mode", String(q.mode));
      if (q.status.length) p.set("status", q.status.join(","));
      if (sort) p.set("sort", sort);
      // localStorage "fumen-preview-mirrors" = "down": no mirror answers
      if (localStorage.getItem("fumen-preview-mirrors") === "down") throw { code: "search-failed", message: "The mirrors couldn't search right now (osu.direct HTTP 503, catboy.best HTTP 503)" };
      const res = await fetch(`https://osu.direct/api/v2/search?${p}`);
      if (!res.ok) throw { code: "search-failed", message: `The mirrors couldn't search right now (osu.direct HTTP ${res.status})` };
      const raw = (await res.json()) as Record<string, any>[];
      const statuses: Record<string, number> = { graveyard: -2, wip: -1, pending: 0, ranked: 1, approved: 2, qualified: 3, loved: 4 };
      const keysApply = q.keys.length > 0 && (q.mode === null || q.mode === 3);
      const sets = raw.flatMap((s) => {
        const status = statuses[s.status] ?? 0;
        if (q.status.length && !q.status.includes(status)) return [];
        const maps = (s.beatmaps as Record<string, any>[])
          .filter((b) => q.mode === null || b.mode_int === q.mode)
          .map((b) => ({ id: b.id, mode: b.mode_int, version: b.version, sr: b.difficulty_rating, cs: b.cs, ar: b.ar, od: b.accuracy, bpm: b.bpm, length: b.total_length, circles: b.count_circles ?? 0, sliders: b.count_sliders ?? 0,
            matches: (!keysApply || (b.mode_int === 3 && q.keys.includes(Math.round(b.cs)))) && (q.srMin === null || b.difficulty_rating >= q.srMin - 0.005) && (q.srMax === null || b.difficulty_rating <= q.srMax + 0.005) }))
          .sort((x, y) => x.mode - y.mode || x.sr - y.sr);
        if (!maps.some((m) => m.matches)) return [];
        return [{ id: s.id, title: s.title, titleUnicode: s.title_unicode !== s.title ? s.title_unicode : undefined, artist: s.artist, artistUnicode: s.artist_unicode !== s.artist ? s.artist_unicode : undefined,
          creator: s.creator, status, ranked: s.ranked_date ? Date.parse(s.ranked_date) : undefined, plays: s.play_count ?? 0, favourites: s.favourite_count ?? 0, video: !!s.video, maps }];
      });
      return { sets, more: raw.length >= 50, mirror: "osu.direct", plain: false } as T;
    }
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
    case "live_plays":
      return (await previewPlays()) as T;
    case "live_play":
      return ((await previewPlays()).find((p) => p.id === args.id) ?? null) as T;
    case "live_replay": {
      const all = (await (await fetch("/__fumen/replay-index")).json()) as Record<string, unknown>;
      const r = all[args.id as string];
      if (!r) throw { code: "replay-missing", message: "Not in the preview cache." };
      return r as T;
    }
    case "pool_choices": {
      const snap = await fetch("/__fumen/snapshot").then((r) => r.json());
      return [
        ...cols().filter((c) => !c.query).map((c) => ({ id: `f:${c.id}`, name: c.name, source: "fumen", count: c.maps.length })),
        ...snap.collections.map((c: { id: string; name: string; maps: number[]; source?: string }) => ({ id: `l:${c.id}`, name: c.name, source: c.source ?? "lazer", count: c.maps.length })),
      ] as T;
    }
    case "pool_rows": {
      const snap = await fetch("/__fumen/snapshot").then((r) => r.json());
      const id = String(args.id);
      const ids: string[] = id.startsWith("f:") ? (cols().find((c) => c.id === id.slice(2))?.maps ?? []) : await lazerCollectionIds(id.slice(2));
      const plays = await previewPlays();
      return ids.slice(0, 12).map((mid) => {
        const m = snap.maps.find((x: { id: string }) => x.id === mid);
        const s = m ? snap.sets[m.set] : null;
        const p = plays.find((x) => x.map === mid);
        return { md5: mid, map: m ? mid : null, title: s?.title ?? null, version: m?.version ?? null, stars: m?.sr ?? null, plays: p ? 1 : 0, bestNow: p?.accuracy ?? null, best: m?.best?.acc ?? null };
      }) as T;
    }
    case "open_companion":
      window.open("/companion.html", "fumen-companion", "width=300,height=440");
      return undefined as T;
    case "close_companion":
    case "fit_companion":
    case "show_main":
      return undefined as T;
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

type PreviewPlay = { id: string; map: string | null; accuracy: number } & Record<string, unknown>;
/** the cached replays as plays of the last few minutes, newest first */
async function previewPlays(): Promise<PreviewPlay[]> {
  const [live, snap] = await Promise.all([fetch("/__fumen/live").then((r) => r.json()), fetch("/__fumen/snapshot").then((r) => r.json())]);
  const now = Date.now();
  return (live as { mapId: string; entry: Record<string, unknown> }[]).map(({ mapId, entry }, i) => {
    const m = snap.maps.find((x: { id: string }) => x.id === mapId);
    const s = m ? snap.sets[m.set] : null;
    const acc = entry.accuracy as number;
    return {
      id: entry.id as string,
      md5: mapId,
      mode: m?.mode ?? 3,
      player: (entry.user as string) ?? "Someone",
      date: now - 60_000 - i * 5 * 60_000,
      accuracy: acc,
      rank: acc >= 0.95 ? "S" : acc >= 0.9 ? "A" : "B",
      score: (entry.score as number) ?? 0,
      combo: (entry.combo as number) ?? 0,
      mods: (entry.mods as string[]) ?? [],
      rate: (entry.rate as number) ?? null,
      statistics: JSON.parse((entry.statistics as string) ?? "{}"),
      maximumStatistics: {},
      map: m ? mapId : null,
      title: s?.title ?? null,
      artist: s?.artist ?? null,
      version: m?.version ?? null,
      set: s?.id ?? null,
      setOnline: s?.onlineId ?? null,
      stars: m?.sr ?? null,
      length: m?.length ?? null,
      bestBefore: i === 0 ? acc - 0.0042 : acc + 0.012,
    };
  });
}

// ── pools (src-tauri/src/pools.rs, kept in localStorage here) ──────────────────

interface PreviewKind {
  code: string;
  count: number;
  mods: string[];
}
interface PreviewPool {
  id: string;
  name: string;
  mode: number;
  keys?: number;
  categories: PreviewKind[];
  note: string;
  created: number;
  updated: number;
  slots: { slot: string; map?: string; md5?: string; onlineId?: number; note: string; online?: Record<string, unknown> }[];
}

const POOLS_KEY = "fumen-preview-pools";
const slotCodes = (kinds: PreviewKind[]) => kinds.flatMap((k) => (k.count === 1 ? [k.code] : Array.from({ length: k.count }, (_, i) => `${k.code}${i + 1}`)));

async function previewPools(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const all = JSON.parse(localStorage.getItem(POOLS_KEY) ?? "[]") as PreviewPool[];
  const save = () => localStorage.setItem(POOLS_KEY, JSON.stringify(all));
  const pool = all.find((p) => p.id === args.id);
  const order = (p: PreviewPool) => p.slots.sort((a, b) => slotCodes(p.categories).indexOf(a.slot) - slotCodes(p.categories).indexOf(b.slot));
  const fail = (message: string) => {
    throw { code: "preview", message };
  };
  switch (cmd) {
    case "get_pools":
      return all;
    case "create_pool": {
      const id = Math.random().toString(16).slice(2);
      const kinds = (args.categories as PreviewKind[]).map((k) => ({ ...k, code: k.code.toUpperCase() }));
      all.push({ id, name: String(args.name).trim(), mode: args.mode as number, keys: (args.keys as number) ?? undefined, categories: kinds, note: "", created: Date.now(), updated: Date.now(), slots: [] });
      save();
      return id;
    }
    case "update_pool": {
      if (!pool) return fail("That pool doesn't exist any more.");
      const patch = args.patch as Partial<PreviewPool>;
      if (patch.name) pool.name = patch.name;
      if (patch.categories) {
        pool.categories = patch.categories;
        const keep = slotCodes(pool.categories);
        pool.slots = pool.slots.filter((s) => keep.includes(s.slot));
      }
      save();
      return null;
    }
    case "delete_pool":
      all.splice(all.indexOf(pool!), 1);
      save();
      return null;
    case "set_pool_slot": {
      if (!pool) return fail("That pool doesn't exist any more.");
      const snap = (await (await fetch("/__fumen/snapshot")).json()) as { maps: { id: string; onlineId?: number }[] };
      const m = snap.maps.find((x) => x.id === args.map);
      pool.slots = pool.slots.filter((s) => s.map !== args.map && s.slot !== args.slot);
      pool.slots.push({ slot: String(args.slot), map: String(args.map), md5: String(args.map), onlineId: m?.onlineId, note: "" });
      order(pool);
      save();
      return null;
    }
    case "set_pool_slot_online": {
      // osu.direct's beatmap lookup from the page, in place of the chart off the mirrors
      if (!pool) return fail("That pool doesn't exist any more.");
      const link = String(args.link).trim();
      const id = Number(/^\d+$/.test(link) ? link : (/#\w+\/(\d+)/.exec(link) ?? /\/(?:b|beatmaps)\/(\d+)/.exec(link))?.[1]);
      if (!id) return fail("That isn't a link to a difficulty on osu!, or its number.");
      const res = await fetch(`https://osu.direct/api/v2/b/${id}`);
      if (!res.ok) return fail("No mirror has this difficulty. Is the link right?");
      const b = (await res.json()) as Record<string, any>;
      const set = (b.beatmapset ?? (await fetch(`https://osu.direct/api/v2/s/${b.beatmapset_id}`).then((r) => (r.ok ? r.json() : {})))) as Record<string, any>;
      if (b.mode_int !== pool.mode) return fail("This difficulty is for another ruleset than the pool.");
      if (pool.mode === 3 && pool.keys && Math.round(b.cs) !== pool.keys) return fail("This difficulty has another key count than the pool.");
      const online = { beatmapId: id, setId: b.beatmapset_id, title: set.title ?? "?", artist: set.artist ?? "?", creator: set.creator ?? "?", version: b.version, mode: b.mode_int,
        keys: Math.round(b.cs), length: (b.total_length ?? 0) * 1000, bpm: b.bpm ?? 0, objects: (b.count_circles ?? 0) + (b.count_sliders ?? 0), holds: b.count_sliders ?? 0, sr: b.difficulty_rating ?? 0 };
      pool.slots = pool.slots.filter((s) => s.onlineId !== id && s.slot !== args.slot);
      pool.slots.push({ slot: String(args.slot), md5: b.checksum, onlineId: id, note: "", online });
      order(pool);
      save();
      return null;
    }
    case "clear_pool_slot":
      pool!.slots = pool!.slots.filter((s) => s.slot !== args.slot);
      save();
      return null;
    case "swap_pool_slots":
      for (const s of pool!.slots) s.slot = s.slot === args.a ? String(args.b) : s.slot === args.b ? String(args.a) : s.slot;
      order(pool!);
      save();
      return null;
    case "set_pool_slot_note": {
      const s = pool?.slots.find((x) => x.slot === args.slot);
      if (s) s.note = String(args.note);
      save();
      return null;
    }
  }
  return null;
}

// ── matches (localStorage "fumen-preview-matches"); a room's games made up from the pool's slots ──

const MATCHES_KEY = "fumen-preview-matches";

async function previewMatches(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const all = JSON.parse(localStorage.getItem(MATCHES_KEY) ?? "[]") as Record<string, any>[];
  const save = () => localStorage.setItem(MATCHES_KEY, JSON.stringify(all));
  const m = all.find((x) => x.id === args.id);
  const patch = (x: Record<string, any>, p: Record<string, any>) => {
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || v === null) continue;
      if (k === "at") x.at = (v as number) > 0 ? v : undefined;
      else if (k === "firstPick") x.firstPick = v || undefined;
      else x[k] = v;
    }
    x.updated = Date.now();
  };
  switch (cmd) {
    case "get_matches":
      return all.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    case "create_match": {
      const x = { id: Math.random().toString(16).slice(2), poolId: args.pool, red: "", blue: "", bestOf: 7, warmups: 0, bans: [], picks: [], note: "", created: Date.now(), updated: Date.now() };
      patch(x, args.patch as Record<string, any>);
      all.push(x);
      save();
      return x.id;
    }
    case "update_match":
      patch(m!, args.patch as Record<string, any>);
      save();
      return null;
    case "delete_match":
      all.splice(all.indexOf(m!), 1);
      save();
      return null;
    case "set_match_room": {
      const id = Number(/(\d+)\s*$/.exec(String(args.link))?.[1] ?? 0);
      if (String(args.link).trim() && !id) throw { code: "bad-room", message: "That isn't a link to a multiplayer room on osu!, or its number." };
      if (m!.mpId !== id) m!.result = undefined;
      m!.mpId = id || undefined;
      save();
      return null;
    }
    case "refresh_match": {
      // a made-up room: the pool's maps in order, red winning the odd ones
      const pools = JSON.parse(localStorage.getItem(POOLS_KEY) ?? "[]") as PreviewPool[];
      const pool = pools.find((p) => p.id === m!.poolId);
      const played = (localStorage.getItem("fumen-preview-played") ?? "4").split(",").map(Number)[0];
      const ids = (pool?.slots ?? []).map((sl) => sl.onlineId).filter((x): x is number => !!x).slice(0, played + 1);
      const t0 = Date.parse("2026-08-01T18:00:00Z");
      const games = ids.map((b, i) => ({
        id: 1000 + i, beatmapId: b, title: "", start: t0 + i * 300_000, end: i < played ? t0 + i * 300_000 + 200_000 : undefined, mode: 3, mods: [], scoring: "scorev2", teamType: "head-to-head",
        scores: i < played ? [
          { user: 1, score: 900_000 - (i % 2) * 120_000 + i * 3000, acc: 0.985 - (i % 2) * 0.02, combo: 1000, misses: i, team: "none", passed: true, mods: [] },
          { user: 2, score: 860_000 + (i % 2) * 90_000, acc: 0.975 + (i % 2) * 0.01, combo: 900, misses: 2, team: "none", passed: true, mods: [] },
        ] : [],
      }));
      m!.result = { id: m!.mpId, name: `RPRO: (${m!.red}) vs (${m!.blue})`, start: t0, users: [{ id: 1, name: m!.red || "Player 1" }, { id: 2, name: m!.blue || "Player 2" }], games };
      m!.fetched = Date.now();
      save();
      return m;
    }
  }
  return null;
}
