/* Browser preview: runs the UI in a normal browser with the Tauri APIs shimmed.
 *
 *   npx vite --config tools/browser-preview/vite.config.ts
 *
 * Library data comes from tools/browser-preview/.cache/snapshot.json (generate with
 * `FUMEN_TEST_EXPORT=<export.json> FUMEN_SNAPSHOT_OUT=<that path> cargo test -- --ignored`; add
 * FUMEN_TEST_STORAGE=<lazer folder> for the chart analysis). Chart panels need
 * .cache/charts/<map id>.json, written by the `preview_charts` test in src-tauri/src/charts.rs.
 * Skins: .cache/skins.json ({ skins: [{ id, name, creator, kind, protected, files }], selected }) and
 * lazer's built-in textures and hit sounds in .cache/lazer-skins/<skin>/ (`fumen-realm skin-resources`).
 * Plays: .cache/history.json (the `real_library` test in src-tauri/src/osu_scores.rs with
 * FUMEN_HISTORY_OUT); without it the preview has none.
 * Files are read straight from osu!lazer's store, and stable's by .cache/stable-files.json (key → file,
 * from the `preview_library` test in src-tauri/src/stable.rs). Thumbnails are the full images.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const lazer = process.env.FUMEN_LAZER ?? join(process.env.APPDATA ?? "", "osu");

function sniff(path: string): string {
  const fd = readFileSync(path, { flag: "r" }).subarray(0, 12);
  if (fd[0] === 0xff && fd[1] === 0xd8) return "image/jpeg";
  if (fd[0] === 0x89 && fd[1] === 0x50) return "image/png";
  if (fd.toString("latin1", 0, 3) === "ID3" || (fd[0] === 0xff && (fd[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (fd.toString("latin1", 0, 4) === "OggS") return "audio/ogg";
  if (fd.toString("latin1", 8, 12) === "WAVE") return "audio/wav";
  return "application/octet-stream";
}

function fumenFiles(): Plugin {
  return {
    name: "fumen-preview-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (url === "/__fumen/snapshot") {
          const p = join(here, ".cache", "snapshot.json");
          if (!existsSync(p)) {
            res.statusCode = 404;
            return res.end("no snapshot; see tools/browser-preview/vite.config.ts");
          }
          res.setHeader("Content-Type", "application/json");
          return createReadStream(p).pipe(res);
        }
        if (url === "/__fumen/history") {
          const p = join(here, ".cache", "history.json");
          res.setHeader("Content-Type", "application/json");
          if (!existsSync(p)) return res.end(JSON.stringify({ plays: [], mostPlayed: [], stats: {}, beatmaps: [] }));
          return createReadStream(p).pipe(res);
        }
        if (url === "/__fumen/skins") {
          const p = join(here, ".cache", "skins.json");
          const list = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { skins: [], selected: null };
          for (const [skin, field] of [["classic", "classic"], ["retro", "retro"], ["triangles", "triangles"], ["argon", "argon"], ["argon-pro", "argonPro"]]) {
            const dir = join(here, ".cache", "lazer-skins", skin);
            list[field] = existsSync(dir) ? readdirSync(dir).sort() : [];
          }
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify(list));
        }
        const builtin = /^\/__fumen\/skin\/(classic|retro|triangles|argon|argon-pro)\/([\w.@%-]+)$/.exec(url);
        if (builtin) {
          const name = decodeURIComponent(builtin[2]);
          const p = join(here, ".cache", "lazer-skins", builtin[1], name);
          if (name.includes("/") || name.includes("\\") || name.startsWith(".") || !existsSync(p)) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("Content-Type", sniff(p));
          return createReadStream(p).pipe(res);
        }
        if (url === "/__fumen/replay-index") {
          const dir = join(here, ".cache", "replays");
          const all: Record<string, unknown> = {};
          if (existsSync(dir)) for (const f of readdirSync(dir)) Object.assign(all, JSON.parse(readFileSync(join(dir, f), "utf8")).replays);
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify(all));
        }
        // lazer's replays of a difficulty: { entries, replays } (export_real_replays in src-tauri/src/replay.rs)
        const replays = /^\/__fumen\/replays\/([0-9a-f-]{36})$/.exec(url);
        if (replays) {
          const p = join(here, ".cache", "replays", `${replays[1]}.json`);
          res.setHeader("Content-Type", "application/json");
          if (!existsSync(p)) return res.end(JSON.stringify({ entries: [], replays: {} }));
          return createReadStream(p).pipe(res);
        }
        // a chart, or (+EZ, +HRMR …) the chart with the mods that change it
        const chart = /^\/__fumen\/chart\/([0-9a-f-]{36}(?:\+[A-Z]+)?)$/.exec(url);
        if (chart) {
          const p = join(here, ".cache", "charts", `${chart[1]}.json`);
          if (!existsSync(p)) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("Content-Type", "application/json");
          return createReadStream(p).pipe(res);
        }
        const m = /^\/__fumen\/(?:file|thumb\/\d+)\/([0-9a-f]{64})$/.exec(url);
        if (!m) return next();
        const hash = m[1];
        const stableFiles = join(here, ".cache", "stable-files.json");
        const stable: Record<string, string> = existsSync(stableFiles) ? JSON.parse(readFileSync(stableFiles, "utf8")) : {};
        const path = stable[hash] ?? join(lazer, "files", hash[0], hash.slice(0, 2), hash);
        if (!existsSync(path)) {
          res.statusCode = 404;
          return res.end();
        }
        const size = statSync(path).size;
        res.setHeader("Content-Type", sniff(path));
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "max-age=3600");
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
        if (range) {
          const start = range[1] ? +range[1] : size - +range[2];
          const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          return createReadStream(path, { start, end }).pipe(res);
        }
        res.setHeader("Content-Length", String(size));
        createReadStream(path).pipe(res);
      });
    },
    transformIndexHtml(html) {
      return html.replace("<head>", `<head><script>window.__FUMEN_BASE__ = "/__fumen/";</script>`);
    },
  };
}

const shim = (name: string) => join(here, "shims", name);

export default defineConfig({
  root,
  clearScreen: false,
  server: { port: 1431, strictPort: true },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: shim("core.ts") },
      { find: "@tauri-apps/api/event", replacement: shim("event.ts") },
      { find: "@tauri-apps/api/window", replacement: shim("window.ts") },
      { find: "@tauri-apps/api/app", replacement: shim("app.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: shim("dialog.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: shim("opener.ts") },
      { find: "@tauri-apps/plugin-updater", replacement: shim("updater.ts") },
    ],
  },
  plugins: [fumenFiles()],
});
