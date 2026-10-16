// Builds the macOS app on GitHub's Macs (.github/workflows/mac.yml: Apple Silicon and Intel, the
// Apple Silicon one tested against osu!lazer's macOS release) and puts the two disk images on
// fumen.dertesti.dev/updates for downloading. Builds what's pushed to main, so push first.
//
//   node scripts/mac-build.mjs
//
// Not signed by Apple: the first start needs right-click → Open (or System Settings → Privacy &
// Security → Open Anyway). No self-update on macOS yet. Needs gh logged in and SSH to the VPS as
// for release.mjs ("vps", or VPS_HOST).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.VPS_HOST ?? "vps";
const updatesDir = "fumen-web/updates";
const origin = "https://fumen.dertesti.dev";
const gh = process.env.GH ?? (existsSync("C:\\Program Files\\GitHub CLI\\gh.exe") ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "gh");

const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const head = out("git", ["rev-parse", "HEAD"]);
if (out("git", ["rev-parse", "origin/main"]) !== head) fail("Push main first: the build takes what's on GitHub.");

// ── build ────────────────────────────────────────────────────────────────
console.log(`→ macOS build of ${version} (${head.slice(0, 7)})`);
const latestRun = () => JSON.parse(out(gh, ["run", "list", "--workflow", "mac.yml", "--limit", "1", "--json", "databaseId,headSha,createdAt"]))[0];
const before = latestRun()?.databaseId;
run(gh, ["workflow", "run", "mac.yml", "--ref", "main"]);
let id;
for (let i = 0; i < 30 && !id; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const r = latestRun();
  if (r && r.databaseId !== before && r.headSha === head) id = r.databaseId;
}
if (!id) fail("The build didn't show up on GitHub.");
try {
  run(gh, ["run", "watch", String(id), "--exit-status", "--interval", "30"]);
} catch {
  fail(`The macOS build failed: gh run view ${id} --log-failed`);
}

// ── the disk images, onto the server ─────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "fumen-mac-"));
run(gh, ["run", "download", String(id), "--dir", scratch]);
const dmgs = readdirSync(scratch, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".dmg"))
  .map((f) => join(scratch, f));
if (!dmgs.length) fail("The build left no disk images.");
console.log(`→ ${host}:~/${updatesDir}`);
run("ssh", [host, `mkdir -p ~/${updatesDir}`]);
// the commit in the name: a rebuild of the same version is a new file (they're cached for good)
const named = dmgs.map((f) => [f, f.split(/[\\/]/).pop().replace(/_(aarch64|x64)\.dmg$/, `_${head.slice(0, 7)}_$1.dmg`)]);
for (const [f, name] of named) run("scp", ["-q", f, `${host}:${updatesDir}/${name}`]);
// the two newest of each kind stay
run("ssh", [
  host,
  `cd ~/${updatesDir} && for a in aarch64 x64; do ls -t Fumen_*_$a.dmg 2>/dev/null | tail -n +3 | while read -r f; do rm -f -- "$f"; done; done`,
]);
rmSync(scratch, { recursive: true, force: true });

for (const [, name] of named) console.log(`✓ ${origin}/updates/${name}`);
