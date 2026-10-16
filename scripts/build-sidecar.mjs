// Builds the .NET helpers and places them where the app expects them:
//   src-tauri/binaries/fumen-realm-<target-triple>.exe      lazer reader, Tauri's `externalBin`
//   src-tauri/binaries/fumen-import/fumen-import.dll + its launcher (fumen-import.exe on
//                                                           Windows, fumen-import on macOS): lazer
//                                                           importer, embedded into the app (it runs
//                                                           on lazer's own runtime, see
//                                                           src-tauri/src/lazer_import.rs)
//
//   node scripts/build-sidecar.mjs                  always rebuild
//   node scripts/build-sidecar.mjs --if-missing     build only what's absent or older than its sources
//   node scripts/build-sidecar.mjs --target <triple> for another target than this machine's (the
//                                                   macOS builds: x86_64-apple-darwin on Apple Silicon)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "sidecar", "FumenRealm");
const importProject = join(root, "sidecar", "FumenImport");
const outDir = join(root, "sidecar", "out");
const importOut = join(root, "src-tauri", "binaries", "fumen-import");

const targetArg = process.argv.indexOf("--target");
const triple =
  targetArg > 0
    ? process.argv[targetArg + 1]
    : execFileSync("rustc", ["-vV"], { encoding: "utf8" })
        .split("\n")
        .find((l) => l.startsWith("host:"))
        ?.slice(5)
        .trim();
if (!triple) throw new Error("Could not determine the Rust host target triple");

// .NET's name for the same target
const RIDS = {
  "x86_64-pc-windows-msvc": "win-x64",
  "aarch64-apple-darwin": "osx-arm64",
  "x86_64-apple-darwin": "osx-x64",
};
const rid = RIDS[triple];
if (!rid) throw new Error(`No .NET runtime identifier known for ${triple}`);

const ext = triple.includes("windows") ? ".exe" : "";
const target = join(root, "src-tauri", "binaries", `fumen-realm-${triple}${ext}`);

function newestSource(dir) {
  return readdirSync(dir)
    .filter((f) => /\.(cs|csproj|xml)$/.test(f))
    .reduce((t, f) => Math.max(t, statSync(join(dir, f)).mtimeMs), 0);
}

const upToDate = (file, dir) => existsSync(file) && statSync(file).mtimeMs >= newestSource(dir);
const ifMissing = process.argv.includes("--if-missing");

if (ifMissing && upToDate(target, project)) {
  console.log(`sidecar up to date: ${target}`);
} else {
  console.log("building fumen-realm sidecar…");
  execFileSync("dotnet", ["publish", project, "-c", "Release", "-r", rid, "-o", outDir, "--nologo"], { stdio: "inherit" });
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(outDir, `fumen-realm${ext}`), target);
  console.log(`sidecar → ${target}`);
}

const importDll = join(importOut, "fumen-import.dll");
if (ifMissing && upToDate(importDll, importProject)) {
  console.log(`importer up to date: ${importOut}`);
} else {
  console.log("building fumen-import…");
  const built = join(importProject, "bin", "Release", "net8.0", rid);
  execFileSync("dotnet", ["build", importProject, "-c", "Release", "-r", rid, "--nologo", "-v", "q"], { stdio: "inherit" });
  mkdirSync(importOut, { recursive: true });
  for (const f of ["fumen-import.dll", `fumen-import${ext}`]) copyFileSync(join(built, f), join(importOut, f));
  console.log(`importer → ${importOut}`);
}
