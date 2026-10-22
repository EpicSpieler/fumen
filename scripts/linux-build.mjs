// Builds the Linux app on GitHub's Ubuntu machines (.github/workflows/linux.yml: AppImage and .deb,
// the import tested against osu!lazer's AppImage) and puts both on fumen.dertesti.dev/updates for
// downloading (/download/linux, /download/linux-deb), with a PKGBUILD for Arch that installs the
// .deb on the system's own libraries (/download/linux-arch, arch-pkgbuild.mjs). Builds what's
// pushed to main, so push first.
//
//   node scripts/linux-build.mjs
//
// No self-update on Linux yet: a new version is downloaded again. Needs gh logged in and SSH to the
// VPS as for release.mjs ("vps", or VPS_HOST).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archPkgbuild } from "./arch-pkgbuild.mjs";

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
console.log(`→ Linux build of ${version} (${head.slice(0, 7)})`);
const latestRun = () => JSON.parse(out(gh, ["run", "list", "--workflow", "linux.yml", "--limit", "1", "--json", "databaseId,headSha,createdAt"]))[0];
const before = latestRun()?.databaseId;
run(gh, ["workflow", "run", "linux.yml", "--ref", "main"]);
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
  fail(`The Linux build failed: gh run view ${id} --log-failed`);
}

// ── the packages, onto the server ────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "fumen-linux-"));
run(gh, ["run", "download", String(id), "--dir", scratch]);
const files = readdirSync(scratch, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith(".AppImage") || f.endsWith(".deb"))
  .map((f) => join(scratch, f));
if (!files.length) fail("The build left no packages.");
console.log(`→ ${host}:~/${updatesDir}`);
run("ssh", [host, `mkdir -p ~/${updatesDir}`]);
// one naming for both (Fumen_<version>_<commit>_amd64.<ext>): a rebuild of the same version is a
// new file (they're cached for good)
const named = files.map((f) => {
  const ext = f.endsWith(".deb") ? "deb" : "AppImage";
  return [f, `Fumen_${version}_${head.slice(0, 7)}_amd64.${ext}`];
});
// Arch: the .deb's files on the system's own WebKitGTK
const [deb, debName] = named.find(([, n]) => n.endsWith(".deb")) ?? [];
if (deb) {
  const sha = createHash("sha256").update(readFileSync(deb)).digest("hex");
  const pkgbuild = join(scratch, "PKGBUILD");
  writeFileSync(pkgbuild, archPkgbuild(version, debName, sha));
  named.push([pkgbuild, debName.replace(/\.deb$/, ".PKGBUILD")]);
}
for (const [f, name] of named) run("scp", ["-q", f, `${host}:${updatesDir}/${name}`]);
// the two newest of each kind stay
run("ssh", [
  host,
  `cd ~/${updatesDir} && for e in AppImage deb PKGBUILD; do ls -t Fumen_*_amd64.$e 2>/dev/null | tail -n +3 | while read -r f; do rm -f -- "$f"; done; done`,
]);
rmSync(scratch, { recursive: true, force: true });

for (const [, name] of named) console.log(`✓ ${origin}/updates/${name}`);
console.log(`✓ ${origin}/download/linux (AppImage) · ${origin}/download/linux-deb · ${origin}/download/linux-arch (PKGBUILD)`);
