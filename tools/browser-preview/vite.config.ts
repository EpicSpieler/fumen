/* Browser preview: runs the UI in a normal browser with the Tauri APIs shimmed.
 *
 *   npx vite --config tools/browser-preview/vite.config.ts
 *
 * Library data comes from tools/browser-preview/.cache/snapshot.json (generate with
 * `FUMEN_TEST_EXPORT=<export.json> FUMEN_SNAPSHOT_OUT=<that path> cargo test -- --ignored`; add
 * FUMEN_TEST_STORAGE=<lazer folder> for the chart analysis). Chart panels need
 * .cache/charts/<map id>.json, written by the `preview_charts` test in src-tauri/src/charts.rs.
 * Files are read straight from osu!lazer's store. Thumbnails are the full images (no resizing).
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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
        const chart = /^\/__fumen\/chart\/([0-9a-f-]{36})$/.exec(url);
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
        const path = join(lazer, "files", hash[0], hash.slice(0, 2), hash);
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
    ],
  },
  plugins: [fumenFiles()],
});
