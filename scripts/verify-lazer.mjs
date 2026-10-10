// Tests Fumen's import with the installed osu!lazer and lists its version as tested in
// lazer-compat.json — after a lazer update, Fumen's import stays off until this has run and the
// file is pushed (see src-tauri/src/lazer_import.rs). lazer must be closed.
//
//   npm run verify-lazer              test, and list the version if it passes
//   npm run verify-lazer -- --check   only test
//   npm run verify-lazer -- --push    test, list, then commit and push lazer-compat.json
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compatFile = join(root, "lazer-compat.json");
const check = process.argv.includes("--check");
const push = process.argv.includes("--push");

execFileSync("node", [join(root, "scripts", "build-sidecar.mjs"), "--if-missing"], { stdio: "inherit" });

const test = "lazer_import::tests::verify_installed_lazer";
try {
  execFileSync("cargo", ["test", "--lib", test, "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
    env: { ...process.env, FUMEN_VERIFY_WRITE: check ? "" : "1" },
  });
} catch {
  console.error("\nlazer failed the verification; Fumen's import stays off for this version.");
  process.exit(1);
}
if (check) process.exit(0);

const newest = JSON.parse(readFileSync(compatFile, "utf8")).tested[0];
console.log(`\nlisted: lazer ${newest.version}, schema ${newest.schema}, ${newest.date}`);

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
if (!git("status", "--porcelain", "--", "lazer-compat.json").trim()) {
  console.log("lazer-compat.json already had it; nothing to commit.");
} else if (push) {
  git("add", "--", "lazer-compat.json");
  git("commit", "-m", `lazer ${newest.version.replace(/-lazer$/, "")} tested with the import`, "--", "lazer-compat.json");
  execFileSync("git", ["push"], { cwd: root, stdio: "inherit" });
  console.log("pushed: every Fumen picks it up from GitHub.");
} else {
  console.log("commit and push lazer-compat.json (or rerun with --push) so every Fumen picks it up.");
}
