// Releases Fumen: builds the signed Windows installer, tags it, puts it on GitHub (a release in the
// repo) and then on fumen.dertesti.dev/updates, where every installed Fumen finds it.
//
//   node scripts/release.mjs 0.4.1                  that version
//   node scripts/release.mjs patch|minor            the next one
//   node scripts/release.mjs patch --notes "…"      notes (else the commits since the last release)
//
// Needs a clean, pushed main; the updater's private key in ~/.tauri/fumen-updater.key (or
// TAURI_SIGNING_PRIVATE_KEY, with TAURI_SIGNING_PRIVATE_KEY_PASSWORD if it has one); gh logged in;
// SSH to the VPS as for deploy-site.mjs ("vps", or VPS_HOST). Lose the key and installed copies
// can't update any more: keep a copy of it somewhere safe.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = process.env.VPS_HOST ?? "vps";
const updatesDir = "fumen-web/updates"; // in the home folder of the SSH user, next to the site
const origin = "https://fumen.dertesti.dev";
const gh = process.env.GH ?? (existsSync("C:\\Program Files\\GitHub CLI\\gh.exe") ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "gh");

const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// ── what to release ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const notesAt = args.indexOf("--notes");
const givenNotes = notesAt >= 0 ? args[notesAt + 1] : undefined;
const which = args.find((a, i) => !a.startsWith("--") && (notesAt < 0 || i !== notesAt + 1));
if (!which) fail("Which version? node scripts/release.mjs <x.y.z | patch | minor>");

const confPath = join(root, "src-tauri", "tauri.conf.json");
const current = JSON.parse(readFileSync(confPath, "utf8")).version;
const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
const [maj, min, pat] = parse(current) ?? fail(`tauri.conf.json has an odd version: ${current}`);
const version = which === "patch" ? `${maj}.${min}.${pat + 1}` : which === "minor" ? `${maj}.${min + 1}.0` : which;
const next = parse(version) ?? fail(`Not a version: ${version}`);
const newer = next[0] - maj || next[1] - min || next[2] - pat;
if (newer <= 0) fail(`${version} isn't newer than ${current}`);

// ── a clean, pushed main ─────────────────────────────────────────────────
if (out("git", ["status", "--porcelain"])) fail("Commit or stash your changes first.");
if (out("git", ["branch", "--show-current"]) !== "main") fail("Release from main.");
run("git", ["fetch", "-q", "origin"]);
if (out("git", ["rev-parse", "HEAD"]) !== out("git", ["rev-parse", "origin/main"])) fail("main and origin/main differ: push (or pull) first.");
if (out("git", ["tag", "--list", `v${version}`])) fail(`v${version} is already tagged.`);

// ── the signing key ──────────────────────────────────────────────────────
const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = join(homedir(), ".tauri", "fumen-updater.key");
  if (!existsSync(keyFile)) fail(`No signing key: ${keyFile} (or TAURI_SIGNING_PRIVATE_KEY).`);
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

// ── notes: the commits since the last release ────────────────────────────
const lastTag = (() => {
  try {
    return out("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"]);
  } catch {
    return null;
  }
})();
const notes =
  givenNotes ??
  (lastTag
    ? out("git", ["log", "--format=%s", `${lastTag}..HEAD`])
        .split("\n")
        .filter((s) => s && !/^(README|Release |PLAN|CI\b)/.test(s))
        .map((s) => `- ${s}`)
        .join("\n") || "Small fixes."
    : "First release.");

// ── version everywhere, then the build ───────────────────────────────────
console.log(`→ Fumen ${current} → ${version}`);
const bumped = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"];
const setJson = (file, fn) => {
  const p = join(root, file);
  const v = JSON.parse(readFileSync(p, "utf8"));
  fn(v);
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
};
const replaceIn = (file, from, to) => {
  const p = join(root, file);
  const s = readFileSync(p, "utf8");
  if (!from.test(s)) fail(`No version in ${file}`);
  writeFileSync(p, s.replace(from, to));
};
setJson("package.json", (v) => (v.version = version));
setJson("package-lock.json", (v) => {
  v.version = version;
  if (v.packages?.[""]) v.packages[""].version = version;
});
replaceIn("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`);
// tauri.conf.json keeps its hand formatting: only the version line changes
replaceIn("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`);

try {
  run("node", ["scripts/build-sidecar.mjs", "--if-missing"]);
  run("npx", ["tauri", "build"], { env, shell: true });
} catch {
  run("git", ["checkout", "--", ...bumped, "src-tauri/Cargo.lock"]);
  fail("The build failed; the version is back to " + current);
}

const bundle = join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `Fumen_${version}_x64-setup.exe`;
const installerPath = join(bundle, installer);
const sigPath = `${installerPath}.sig`;
if (!existsSync(installerPath) || !existsSync(sigPath)) fail(`The build left no ${installer} (+ .sig) in ${bundle}`);

// ── tag it ───────────────────────────────────────────────────────────────
run("git", ["add", ...bumped, "src-tauri/Cargo.lock"]);
run("git", ["commit", "-q", "-m", `Release ${version}`]);
run("git", ["tag", "-a", `v${version}`, "-m", `Fumen ${version}`]);
run("git", ["push", "-q", "origin", "main", `v${version}`]);

// ── what the updater reads ───────────────────────────────────────────────
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: readFileSync(sigPath, "utf8").trim(), url: `${origin}/updates/${installer}` },
  },
};
const scratch = mkdtempSync(join(tmpdir(), "fumen-release-"));
const latestPath = join(scratch, "latest.json");
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");

// ── GitHub: a release in the repo ────────────────────────────────────────
console.log("→ GitHub release");
run(gh, ["release", "create", `v${version}`, installerPath, sigPath, latestPath, "--title", `Fumen ${version}`, "--notes", notes, "--verify-tag"]);

// ── the update server: installer first, latest.json last (that's what makes it live) ──
console.log(`→ ${host}:~/${updatesDir}`);
run("ssh", [host, `mkdir -p ~/${updatesDir}`]);
run("scp", ["-q", installerPath, sigPath, `${host}:${updatesDir}/`]);
run("scp", ["-q", latestPath, `${host}:${updatesDir}/latest.json.tmp`]);
run("ssh", [
  host,
  [
    `cd ~/${updatesDir}`,
    "mv latest.json.tmp latest.json",
    // the three newest installers stay
    "ls -t Fumen_*-setup.exe | tail -n +4 | while read -r f; do rm -f -- \"$f\" \"$f.sig\"; done",
  ].join(" && "),
]);
rmSync(scratch, { recursive: true, force: true });

const live = await fetch(`${origin}/updates/latest.json`, { cache: "no-store" })
  .then((r) => r.json())
  .catch(() => null);
if (live?.version !== version) fail(`${origin}/updates/latest.json doesn't show ${version} yet (${live?.version ?? "unreachable"}).`);
const head = await fetch(latest.platforms["windows-x86_64"].url, { method: "HEAD" }).catch(() => null);
if (!head?.ok) fail(`The installer isn't reachable at ${latest.platforms["windows-x86_64"].url}`);
console.log(`✓ Fumen ${version} is out: ${latest.platforms["windows-x86_64"].url}`);
