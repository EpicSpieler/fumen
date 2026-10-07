// Builds the fumen-realm sidecar (.NET) and places it where Tauri's `externalBin` expects it:
//   src-tauri/binaries/fumen-realm-<target-triple>.exe
//
//   node scripts/build-sidecar.mjs              always rebuild
//   node scripts/build-sidecar.mjs --if-missing build only if absent or older than its sources
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "sidecar", "FumenRealm");
const outDir = join(root, "sidecar", "out");

const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host:"))
  ?.slice(5)
  .trim();
if (!triple) throw new Error("Could not determine the Rust host target triple");

const ext = triple.includes("windows") ? ".exe" : "";
const target = join(root, "src-tauri", "binaries", `fumen-realm-${triple}${ext}`);

function newestSource() {
  return readdirSync(project)
    .filter((f) => /\.(cs|csproj|xml)$/.test(f))
    .reduce((t, f) => Math.max(t, statSync(join(project, f)).mtimeMs), 0);
}

if (process.argv.includes("--if-missing") && existsSync(target) && statSync(target).mtimeMs >= newestSource()) {
  console.log(`sidecar up to date: ${target}`);
  process.exit(0);
}

console.log("building fumen-realm sidecar…");
execFileSync("dotnet", ["publish", project, "-c", "Release", "-o", outDir, "--nologo"], { stdio: "inherit" });
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(outDir, `fumen-realm${ext}`), target);
console.log(`sidecar → ${target}`);
