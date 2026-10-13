//! Importing beatmap sets into osu!lazer: the one place Fumen writes to lazer's data.
//!
//! The import itself is lazer's own code: `fumen-import` (sidecar/FumenImport) runs lazer's
//! `BeatmapImporter` on its `client.realm`, on the installed lazer's own .NET runtime. For that,
//! lazer's install folder is hard-linked into Fumen's cache (`lazer-host/<version>/`, no copies,
//! nothing of lazer's touched) with the importer next to it.
//!
//! Safety, in order:
//!   1. only lazer versions listed as tested in `lazer-compat.json` (the copy built into Fumen,
//!      and the one on GitHub once the repo is public; a version blocked in either is off). A
//!      lazer update switches imports off until its version is tested and listed
//!      (`npm run verify-lazer`, see `verify_installed_lazer` below);
//!   2. only while lazer isn't running;
//!   3. a backup of `client.realm` before every import (`lazer-backups/`, the last five);
//!   4. the importer opens the database only at exactly its lazer's schema version — after a
//!      lazer update the database is migrated by lazer's next start, not by Fumen;
//!   5. lazer gets a copy of each archive (it deletes what it imported).
//!
//! What lazer would do online (ranked status, star ratings) it does itself on its next start.
//!
//! Collections go in the same way, with the same checks (`put_collections`): lazer's own
//! `RealmAccess.Write` on its `BeatmapCollection`s.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// The tested-versions list as committed (also the fallback while GitHub can't be reached).
const BUNDLED_COMPAT: &str = include_str!("../../lazer-compat.json");
/// …and where the latest one is read from.
pub const COMPAT_URL: &str = "https://raw.githubusercontent.com/EpicSpieler/fumen/main/lazer-compat.json";

static IMPORTER_DLL: &[u8] = include_bytes!("../binaries/fumen-import/fumen-import.dll");
static IMPORTER_EXE: &[u8] = include_bytes!("../binaries/fumen-import/fumen-import.exe");

/// Lines of the importer meant for Fumen start with this.
const MARK: &str = "@fumen ";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compat {
    #[serde(default)]
    pub tested: Vec<Tested>,
    /// versions switched off after all (wins over `tested`)
    #[serde(default)]
    pub blocked: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tested {
    /// lazer's release, as in its `sq.version` ("2026.1005.0-lazer")
    pub version: String,
    /// lazer's database schema at that version
    pub schema: u32,
    /// when it was verified (YYYY-MM-DD)
    pub date: String,
}

impl Compat {
    pub fn bundled() -> Compat {
        // a development build reads the file itself: a version verified a moment ago counts at once
        #[cfg(debug_assertions)]
        if let Some(c) = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../lazer-compat.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
        {
            return c;
        }
        serde_json::from_str(BUNDLED_COMPAT).unwrap_or_default()
    }

    /// The list on GitHub; None when it can't be read (offline, repo still private, …).
    pub fn remote() -> Option<Compat> {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .user_agent(crate::downloads::USER_AGENT)
            .timeout_global(Some(Duration::from_secs(6)))
            .build()
            .into();
        let mut res = agent.get(COMPAT_URL).call().ok()?;
        let text = res.body_mut().read_to_string().ok()?;
        serde_json::from_str(&text).ok()
    }

    /// Both lists together: tested in either, blocked in either.
    pub fn merge(mut self, other: Option<Compat>) -> Compat {
        if let Some(o) = other {
            for t in o.tested {
                if !self.tested.iter().any(|x| x.version == t.version) {
                    self.tested.push(t);
                }
            }
            for b in o.blocked {
                if !self.blocked.contains(&b) {
                    self.blocked.push(b);
                }
            }
        }
        self
    }

    pub fn allows(&self, version: &str) -> bool {
        !self.blocked.iter().any(|b| b == version) && self.tested.iter().any(|t| t.version == version)
    }
}

// ── the installed lazer ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Installed {
    /// `…\osulazer\current`: lazer's assemblies and runtime
    pub dir: PathBuf,
    pub version: String,
}

/// lazer as installed by its installer (Velopack: `%LOCALAPPDATA%\osulazer\current`).
pub fn installed() -> Option<Installed> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("osulazer").join("current");
    let version = parse_sq_version(&std::fs::read_to_string(dir.join("sq.version")).ok()?)?;
    dir.join("osu.Game.dll").is_file().then_some(Installed { dir, version })
}

fn parse_sq_version(xml: &str) -> Option<String> {
    let start = xml.find("<version>")? + "<version>".len();
    let end = start + xml[start..].find("</version>")?;
    let v = xml[start..end].trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// Whether lazer is running: an `osu!.exe` from lazer's install folder (osu!stable's exe has the
/// same name and doesn't count). A process whose path can't be read counts as lazer.
#[cfg(windows)]
pub fn lazer_running(install: &Path) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    let lazer_root = install.parent().unwrap_or(install).to_string_lossy().to_lowercase();
    // SAFETY: plain Win32 calls on handles opened and closed here; buffers sized as documented
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return true;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut running = false;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok && !running {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if name.eq_ignore_ascii_case("osu!.exe") {
                let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if proc.is_null() {
                    running = true;
                } else {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    let path = if QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0 {
                        Some(String::from_utf16_lossy(&buf[..size as usize]).to_lowercase())
                    } else {
                        None
                    };
                    CloseHandle(proc);
                    running = path.map_or(true, |p| p.starts_with(&lazer_root));
                }
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
        running
    }
}

#[cfg(not(windows))]
pub fn lazer_running(_install: &Path) -> bool {
    true
}

// ── status ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// imports can run right now
    pub ready: bool,
    /// why not: "not-installed" | "untested" | "running" | "no-library"
    pub reason: Option<&'static str>,
    pub message: Option<String>,
    /// the installed lazer's version
    pub version: Option<String>,
    pub tested: bool,
    pub running: bool,
    /// versions listed as tested, newest first
    pub tested_versions: Vec<String>,
}

pub fn status(storage: Option<&Path>, compat: &Compat) -> Status {
    let mut tested_versions: Vec<String> = compat.tested.iter().map(|t| t.version.clone()).collect();
    tested_versions.sort_by_key(|v| std::cmp::Reverse(version_key(v)));
    let lazer = installed();
    let version = lazer.as_ref().map(|l| l.version.clone());
    let tested = version.as_deref().is_some_and(|v| compat.allows(v));
    let running = lazer.as_ref().is_some_and(|l| lazer_running(&l.dir));
    let (reason, message) = match &lazer {
        None => (Some("not-installed"), Some("osu!lazer's installation wasn't found (it's looked for in %LOCALAPPDATA%\\osulazer).".to_string())),
        Some(_) if storage.map_or(true, |s| !s.join("client.realm").is_file()) => {
            (Some("no-library"), Some("lazer's data folder wasn't found. Pick it in Settings.".to_string()))
        }
        Some(l) if !tested => (
            Some("untested"),
            Some(format!("osu!lazer {} isn't tested with Fumen's import yet; importing stays off until it is.", short_version(&l.version))),
        ),
        Some(_) if running => (Some("running"), Some("osu!lazer is running. Close it to import.".to_string())),
        Some(_) => (None, None),
    };
    Status { ready: reason.is_none(), reason, message, version, tested, running, tested_versions }
}

/// A status reason as one of Fumen's error codes.
pub fn error_code(reason: &str) -> &'static str {
    match reason {
        "running" => "lazer-running",
        "untested" => "lazer-untested",
        "no-library" => "lazer-not-found",
        _ => "lazer-not-installed",
    }
}

/// "2026.1005.0-lazer" → "2026.1005.0"
pub fn short_version(v: &str) -> &str {
    v.strip_suffix("-lazer").unwrap_or(v)
}

/// A version's numbers, for ordering ("2026.926.0" before "2026.1005.0").
fn version_key(v: &str) -> Vec<u64> {
    short_version(v).split(['.', '-']).map(|p| p.parse().unwrap_or(0)).collect()
}

// ── the importer's folder ───────────────────────────────────────────────

/// `<cache>/lazer-host/<version>`: lazer's install folder hard-linked (copied where links don't
/// work), plus the importer with lazer's runtime settings. Built once per lazer version; other
/// versions' folders are removed.
pub fn host_dir(cache: &Path, lazer: &Installed) -> Result<PathBuf> {
    let root = cache.join("lazer-host");
    let dir = root.join(&lazer.version);
    let ready = dir.join(".fumen-ready");
    let fresh = std::fs::read(dir.join("fumen-import.dll")).is_ok_and(|b| b == IMPORTER_DLL)
        && std::fs::read(dir.join("fumen-import.exe")).is_ok_and(|b| b == IMPORTER_EXE)
        && dir.join("fumen-import.deps.json").is_file();
    if ready.is_file() && fresh {
        return Ok(dir);
    }
    if let Ok(entries) = std::fs::read_dir(&root) {
        for e in entries.flatten() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    link_tree(&lazer.dir, &dir)?;
    std::fs::write(dir.join("fumen-import.dll"), IMPORTER_DLL)?;
    std::fs::write(dir.join("fumen-import.exe"), IMPORTER_EXE)?;
    // started like lazer itself: its runtime settings (its .NET, self-contained) and its list of
    // assemblies and native libraries — without the list, .NET doesn't see a self-contained app
    std::fs::copy(lazer.dir.join("osu!.runtimeconfig.json"), dir.join("fumen-import.runtimeconfig.json"))?;
    std::fs::copy(lazer.dir.join("osu!.deps.json"), dir.join("fumen-import.deps.json"))?;
    std::fs::write(&ready, &lazer.version)?;
    Ok(dir)
}

fn link_tree(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if e.file_type()?.is_dir() {
            link_tree(&src, &dst)?;
        } else if std::fs::hard_link(&src, &dst).is_err() {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

fn importer_command(host: &Path) -> Command {
    let mut cmd = Command::new(host.join("fumen-import.exe"));
    cmd.current_dir(host).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs the importer; returns its exit code and the JSON lines meant for Fumen.
fn run(host: &Path, args: &[&std::ffi::OsStr]) -> Result<(i32, Vec<serde_json::Value>)> {
    let out = importer_command(host).args(args).output()?;
    let lines = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix(MARK))
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    Ok((out.status.code().unwrap_or(-1), lines))
}

/// The error the importer reported, as one of Fumen's (`what`: "Importing into lazer").
fn importer_error(code: i32, lines: &[serde_json::Value], what: &str) -> Error {
    let msg = lines
        .iter()
        .rev()
        .find_map(|l| l.get("message").and_then(|m| m.as_str()))
        .unwrap_or("the importer stopped without saying why")
        .to_string();
    match code {
        3 => Error::known("lazer-schema", msg),
        _ => Error::known("import-failed", format!("{what} failed: {msg}")),
    }
}

// ── import ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub file: PathBuf,
    pub ok: bool,
    /// lazer's IDs of the sets it has for the archive afterwards
    pub sets: Vec<String>,
    pub message: Option<String>,
}

/// Imports archives into the lazer library at `storage`, if everything's safe (see the module
/// docs). `backups` is where `client.realm` is saved first.
pub fn import(storage: &Path, cache: &Path, backups: &Path, files: &[PathBuf], compat: &Compat) -> Result<Vec<Imported>> {
    let st = status(Some(storage), compat);
    if let Some(reason) = st.reason {
        return Err(Error::known(error_code(reason), st.message.unwrap_or_default()));
    }
    let lazer = installed().ok_or_else(|| Error::known("lazer-not-installed", "osu!lazer's installation wasn't found."))?;
    let host = host_dir(cache, &lazer)?;
    backup(storage, backups)?;

    let mut args: Vec<&std::ffi::OsStr> = vec!["import".as_ref(), storage.as_os_str()];
    args.extend(files.iter().map(|f| f.as_os_str()));
    let (code, lines) = run(&host, &args)?;
    if code != 0 {
        return Err(importer_error(code, &lines, "Importing into lazer"));
    }
    Ok(lines
        .iter()
        .filter(|l| l.get("file").is_some())
        .map(|l| Imported {
            file: PathBuf::from(l["file"].as_str().unwrap_or_default()),
            ok: l["ok"].as_bool().unwrap_or(false),
            sets: l["sets"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            message: l["message"].as_str().map(str::to_string),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PutCollection {
    /// Fumen's id
    pub key: String,
    /// lazer's
    pub id: String,
    /// made new (else one of lazer's was changed)
    pub created: bool,
}

/// Puts collections into lazer's, with the same checks as an import: each goes into the lazer
/// collection it went into before (`lazer_id`), else the one with its name, else a new one.
pub fn put_collections(
    storage: &Path,
    cache: &Path,
    backups: &Path,
    cols: &[crate::collections::Outgoing],
    compat: &Compat,
) -> Result<Vec<PutCollection>> {
    let st = status(Some(storage), compat);
    if let Some(reason) = st.reason {
        return Err(Error::known(error_code(reason), st.message.unwrap_or_default()));
    }
    let lazer = installed().ok_or_else(|| Error::known("lazer-not-installed", "osu!lazer's installation wasn't found."))?;
    let host = host_dir(cache, &lazer)?;
    backup(storage, backups)?;

    let json = cache.join(format!("collections-{}.json", crate::lazer::now_ms()));
    std::fs::write(&json, serde_json::to_vec(cols)?)?;
    let result = run(&host, &["collections".as_ref(), storage.as_os_str(), json.as_os_str()]);
    let _ = std::fs::remove_file(&json);
    let (code, lines) = result?;
    if code != 0 {
        return Err(importer_error(code, &lines, "Writing lazer's collections"));
    }
    Ok(lines
        .iter()
        .filter_map(|l| {
            Some(PutCollection { key: l.get("key")?.as_str()?.to_string(), id: l.get("id")?.as_str()?.to_string(), created: l["created"].as_bool()? })
        })
        .collect())
}

/// Copies `client.realm` to `backups/client-<unix ms>.realm`, keeping the newest five.
pub fn backup(storage: &Path, backups: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(backups)?;
    let target = backups.join(format!("client-{}.realm", crate::lazer::now_ms()));
    std::fs::copy(storage.join("client.realm"), &target)?;
    let mut old: Vec<PathBuf> = std::fs::read_dir(backups)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("client-") && n.ends_with(".realm")))
        .collect();
    old.sort();
    while old.len() > 5 {
        let _ = std::fs::remove_file(old.remove(0));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sq_version() {
        let xml = "<package><metadata><id>osulazer</id><version>2026.1005.0-lazer</version><channel>win</channel></metadata></package>";
        assert_eq!(parse_sq_version(xml).as_deref(), Some("2026.1005.0-lazer"));
        assert_eq!(parse_sq_version("<version> </version>"), None);
        assert_eq!(parse_sq_version("nothing"), None);
        assert_eq!(short_version("2026.1005.0-lazer"), "2026.1005.0");
        assert!(version_key("2026.926.0-lazer") < version_key("2026.1005.0-lazer"));
        assert!(version_key("2026.1005.0-lazer") < version_key("2026.1005.1-lazer"));
    }

    #[test]
    fn dates() {
        assert_eq!(date_of(0), "1970-01-01");
        assert_eq!(date_of(11016), "2000-02-29");
        assert_eq!(date_of(20737), "2026-10-11");
    }

    /// YYYY-MM-DD of a day since 1970 (UTC), after Howard Hinnant's `civil_from_days`.
    fn date_of(days: i64) -> String {
        let z = days + 719_468;
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
        let y = yoe + z.div_euclid(146_097) * 400 + i64::from(m <= 2);
        format!("{y:04}-{m:02}-{d:02}")
    }

    // ── verifying a lazer version (`npm run verify-lazer`) ──────────────────

    /// Sets the verification imports, the first one not in the library already: small mania sets.
    const TEST_SETS: [u32; 3] = [1225016, 2585470, 2055296];

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn sha256(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        hex(&Sha256::digest(bytes))
    }

    /// The files in a zip archive as (name, sha256) — as much of the format as .osz files need.
    fn zip_entries(path: &Path) -> Vec<(String, String)> {
        use std::io::Read;
        let data = std::fs::read(path).unwrap();
        let u16_at = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]) as usize;
        let u32_at = |i: usize| u32::from_le_bytes(data[i..i + 4].try_into().unwrap()) as usize;
        let end = (0..=data.len() - 22).rev().find(|&i| data[i..i + 4] == *b"PK\x05\x06").expect("zip end record");
        let (count, mut at) = (u16_at(end + 10), u32_at(end + 16));
        let mut out = Vec::new();
        for _ in 0..count {
            assert_eq!(&data[at..at + 4], b"PK\x01\x02", "zip central directory");
            let (method, size, local) = (u16_at(at + 10), u32_at(at + 20), u32_at(at + 42));
            let name_len = u16_at(at + 28);
            let name = String::from_utf8_lossy(&data[at + 46..at + 46 + name_len]).into_owned();
            at += 46 + name_len + u16_at(at + 30) + u16_at(at + 32);
            if name.ends_with('/') {
                continue;
            }
            let start = local + 30 + u16_at(local + 26) + u16_at(local + 28);
            let raw = &data[start..start + size];
            let bytes = match method {
                0 => raw.to_vec(),
                8 => {
                    let mut v = Vec::new();
                    flate2::read::DeflateDecoder::new(raw).read_to_end(&mut v).unwrap();
                    v
                }
                m => panic!("{name}: zip method {m}"),
            };
            out.push((name, sha256(&bytes)));
        }
        out
    }

    /// lazer's database at `realm` read by Fumen's own reader (the fumen-realm sidecar).
    fn export(realm: &Path, out: &Path) -> serde_json::Value {
        let bins = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let reader = std::fs::read_dir(&bins)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("fumen-realm-")))
            .expect("the fumen-realm sidecar (npm run sidecar)");
        let res = Command::new(reader).arg("export").arg(realm).arg(out).output().unwrap();
        assert!(res.status.success(), "export of {}: {}", realm.display(), String::from_utf8_lossy(&res.stderr));
        serde_json::from_slice(&std::fs::read(out).unwrap()).unwrap()
    }

    fn sets_by_id(export: &serde_json::Value) -> std::collections::BTreeMap<String, serde_json::Value> {
        export["sets"].as_array().unwrap().iter().map(|s| (s["id"].as_str().unwrap().to_string(), s.clone())).collect()
    }

    fn importer(host: &Path, args: &[&str]) -> (i32, Vec<serde_json::Value>) {
        let args: Vec<&std::ffi::OsStr> = args.iter().map(|a| a.as_ref()).collect();
        run(host, &args).unwrap()
    }

    /// The import tested against the installed lazer, end to end; on success with
    /// FUMEN_VERIFY_WRITE=1 (only with lazer closed), its version goes into lazer-compat.json.
    /// lazer's data folder: FUMEN_VERIFY_LAZER, or the usual one; a test set is downloaded.
    /// Nothing of lazer's is changed: the imports go into a fresh library and a copy of the real one.
    #[test]
    #[ignore = "tests the installed lazer; run with npm run verify-lazer"]
    fn verify_installed_lazer() {
        let lazer = installed().expect("osu!lazer isn't installed");
        let write = std::env::var_os("FUMEN_VERIFY_WRITE").is_some_and(|v| v == "1");
        // the copy of a database lazer has open may catch it mid-write: fine for a look, not for the list
        if lazer_running(&lazer.dir) {
            assert!(!write, "close osu!lazer first");
            println!("lazer is running: only checking");
        }
        let storage = std::env::var_os("FUMEN_VERIFY_LAZER")
            .map(PathBuf::from)
            .or_else(|| crate::paths::default_lazer_dir().and_then(|d| crate::paths::inspect_lazer(&d)).map(|i| PathBuf::from(i.storage)))
            .expect("lazer's data folder wasn't found; set FUMEN_VERIFY_LAZER");
        let work = std::env::temp_dir().join("fumen-verify-lazer");
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        println!("lazer {} at {}, data at {}", lazer.version, lazer.dir.display(), storage.display());

        // the importer runs on this lazer's runtime and finds its code
        let host = host_dir(&work.join("cache"), &lazer).unwrap();
        let (code, info) = importer(&host, &["info"]);
        assert_eq!(code, 0, "info: {info:?}");
        let schema = info[0]["schema"].as_u64().expect("schema version") as u32;
        println!("importer runs: osu.Game {}, .NET {}, database schema {schema}", info[0]["osuGame"], info[0]["runtime"]);

        // the real database (a copy): at exactly this lazer's schema, and the guard refuses others
        let real = work.join("real");
        std::fs::create_dir_all(real.join("files")).unwrap();
        std::fs::copy(storage.join("client.realm"), real.join("client.realm")).unwrap();
        let realm = real.join("client.realm");
        let realm_arg = realm.to_str().unwrap();
        let (code, out) = importer(&host, &["checkschema", realm_arg, &schema.to_string()]);
        assert_eq!(code, 0, "lazer's database isn't at schema {schema} (start lazer once after updating): {out:?}");
        for other in [schema - 1, schema + 1] {
            let (code, out) = importer(&host, &["checkschema", realm_arg, &other.to_string()]);
            assert_eq!(code, 3, "the schema guard let a database at {schema} pass as {other}: {out:?}");
        }
        println!("schema guard: {schema} passes, {} and {} are refused", schema - 1, schema + 1);

        // a test set the library doesn't have yet
        let before = export(&realm, &work.join("before.json"));
        let owned: Vec<u64> = before["sets"].as_array().unwrap().iter().filter_map(|s| s["onlineId"].as_u64()).collect();
        let set = TEST_SETS.into_iter().find(|s| !owned.contains(&u64::from(*s))).expect("all test sets are in the library");
        let (archive, mirror) = crate::downloads::download_set(set, &work.join("dl"), |_, _| true).unwrap();
        let entries = zip_entries(&archive);
        let charts: Vec<&String> = entries.iter().filter(|(n, _)| n.to_lowercase().ends_with(".osu")).map(|(_, h)| h).collect();
        assert!(!charts.is_empty(), "set {set} has no charts");
        println!("test set {set} from {mirror}: {} files, {} charts", entries.len(), charts.len());

        // the stored files and charts are the archive's, byte for byte
        let check_set = |data: &Path, exported: &serde_json::Value| {
            assert_eq!(exported["onlineId"].as_u64(), Some(u64::from(set)), "set id");
            let maps = exported["maps"].as_array().unwrap();
            assert_eq!(maps.len(), charts.len(), "charts in set {set}");
            for m in maps {
                let hash = m["hash"].as_str().unwrap();
                assert!(charts.iter().any(|c| *c == hash), "chart {hash} isn't one of the archive's");
            }
            for (name, hash) in &entries {
                let file = data.join("files").join(&hash[..1]).join(&hash[..2]).join(hash);
                let bytes = std::fs::read(&file).unwrap_or_else(|_| panic!("{name} wasn't stored ({})", file.display()));
                assert_eq!(&sha256(&bytes), hash, "{name} stored differently");
            }
        };

        // 1. a fresh library, imported into twice: one set
        let fresh = work.join("fresh");
        let (code, out) = importer(&host, &["selftest", fresh.to_str().unwrap(), archive.to_str().unwrap()]);
        assert_eq!(code, 0, "selftest: {out:?}");
        assert_eq!(out[0]["sameSet"], true, "the second import made another set: {out:?}");
        assert_eq!(out[0]["schema"].as_u64(), Some(u64::from(schema)));
        let fresh_sets = sets_by_id(&export(&fresh.join("client.realm"), &work.join("fresh.json")));
        assert_eq!(fresh_sets.len(), 1, "sets in the fresh library");
        check_set(&fresh, fresh_sets.values().next().unwrap());
        println!("fresh library: imported, re-imported, one set with every file intact");

        // 2. the copy of the real library: one set more, nothing else changed
        let (code, out) = importer(&host, &["import", real.to_str().unwrap(), archive.to_str().unwrap()]);
        assert_eq!(code, 0, "import: {out:?}");
        assert_eq!(out[0]["ok"], true, "import: {out:?}");
        let id = out[0]["sets"][0].as_str().expect("the imported set's id").to_string();
        let after = export(&realm, &work.join("after.json"));
        let (old, new) = (sets_by_id(&before), sets_by_id(&after));
        assert_eq!(new.len(), old.len() + 1, "sets after the import");
        for (sid, s) in &old {
            assert_eq!(new.get(sid), Some(s), "set {sid} changed");
        }
        check_set(&real, &new[&id]);
        for part in ["scores", "collections", "skins", "rulesetSettings"] {
            assert_eq!(before[part], after[part], "{part} changed");
        }
        assert!(archive.is_file(), "the downloaded archive was deleted");
        println!("copy of your library ({} sets): one set more, all else unchanged", old.len());

        // 3. …and again: still one set more
        let (code, out) = importer(&host, &["import", real.to_str().unwrap(), archive.to_str().unwrap()]);
        assert_eq!((code, out[0]["sets"][0].as_str()), (0, Some(id.as_str())), "re-import: {out:?}");
        assert_eq!(sets_by_id(&export(&realm, &work.join("again.json"))).len(), new.len(), "sets after importing again");
        println!("importing the same set again: no new set");

        // 4. collections: one new, one of lazer's changed (by id and renamed), the rest untouched
        let base = export(&realm, &work.join("base.json"));
        let md5s: Vec<String> = base["sets"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|s| s["maps"].as_array().unwrap().iter().filter_map(|m| m["md5"].as_str().map(str::to_string)))
            .take(3)
            .collect();
        let mut cols = vec![crate::collections::Outgoing { key: "new".into(), lazer_id: None, name: "Fumen verify".into(), md5s: md5s.clone() }];
        let changed = base["collections"].as_array().unwrap().first().map(|c| c["id"].as_str().unwrap().to_string());
        if let Some(id) = &changed {
            cols.push(crate::collections::Outgoing { key: "old".into(), lazer_id: Some(id.clone()), name: "Fumen verify 2".into(), md5s: md5s[..1].to_vec() });
        }
        let json = work.join("collections.json");
        std::fs::write(&json, serde_json::to_vec(&cols).unwrap()).unwrap();
        let put = |expect_new: bool| {
            let (code, out) = importer(&host, &["collections", real.to_str().unwrap(), json.to_str().unwrap()]);
            assert_eq!(code, 0, "collections: {out:?}");
            assert_eq!(out.len(), cols.len(), "collections: {out:?}");
            assert_eq!(out[0]["created"], expect_new, "collections: {out:?}");
            if changed.is_some() {
                assert_eq!((out[1]["created"].as_bool(), out[1]["id"].as_str()), (Some(false), changed.as_deref()), "collections: {out:?}");
            }
            out[0]["id"].as_str().unwrap().to_string()
        };
        let new_id = put(true);
        let after = export(&realm, &work.join("cols.json"));
        let by_id = |e: &serde_json::Value| -> std::collections::BTreeMap<String, serde_json::Value> {
            e["collections"].as_array().unwrap().iter().map(|c| (c["id"].as_str().unwrap().to_string(), c.clone())).collect()
        };
        let (was, now) = (by_id(&base), by_id(&after));
        assert_eq!(now.len(), was.len() + 1, "collections after writing");
        assert_eq!(now[&new_id]["name"], "Fumen verify");
        assert_eq!(now[&new_id]["md5s"], serde_json::json!(md5s));
        for (cid, c) in &was {
            if Some(cid) == changed.as_ref() {
                assert_eq!((&now[cid]["name"], &now[cid]["md5s"]), (&serde_json::json!("Fumen verify 2"), &serde_json::json!(md5s[..1])));
            } else {
                assert_eq!(now.get(cid), Some(c), "collection {cid} changed");
            }
        }
        for part in ["sets", "scores", "skins", "rulesetSettings"] {
            assert_eq!(base[part], after[part], "{part} changed by writing collections");
        }
        assert_eq!(put(false), new_id, "writing again made another collection");
        assert_eq!(by_id(&export(&realm, &work.join("cols2.json"))).len(), now.len());
        println!("collections: one made, one changed, written again without a copy, nothing else touched");

        let _ = std::fs::remove_dir_all(&work);
        if write {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("lazer-compat.json");
            let file: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let mut compat: Compat = serde_json::from_value(file.clone()).unwrap();
            let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() / 86_400;
            compat.tested.retain(|t| t.version != lazer.version);
            compat.tested.push(Tested { version: lazer.version.clone(), schema, date: date_of(days as i64) });
            compat.tested.sort_by_key(|t| std::cmp::Reverse(version_key(&t.version)));
            let doc = serde_json::json!({ "about": file["about"], "tested": compat.tested, "blocked": compat.blocked });
            std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
            println!("lazer {} listed as tested in {}", lazer.version, path.display());
        }
    }

    #[test]
    fn compat_lists() {
        let t = |v: &str| Tested { version: v.into(), schema: 52, date: "2026-10-11".into() };
        let bundled = Compat { tested: vec![t("a")], blocked: vec![] };
        assert!(bundled.allows("a") && !bundled.allows("b"));
        // the remote list adds versions and can switch one off again
        let remote = Compat { tested: vec![t("b")], blocked: vec!["a".into()] };
        let merged = bundled.merge(Some(remote));
        assert!(!merged.allows("a") && merged.allows("b"));
        // the committed file parses
        let committed = Compat::bundled();
        assert!(committed.tested.iter().all(|t| !t.version.is_empty() && t.schema > 0));
    }

    #[test]
    fn backups_keep_five() {
        let dir = std::env::temp_dir().join(format!("fumen-backup-test-{}", std::process::id()));
        let storage = dir.join("lazer");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&storage).unwrap();
        std::fs::write(storage.join("client.realm"), b"realm").unwrap();
        for _ in 0..7 {
            backup(&storage, &backups).unwrap();
            std::thread::sleep(Duration::from_millis(3));
        }
        let left: Vec<_> = std::fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(left.len(), 5);
        assert!(left.iter().all(|e| std::fs::read(e.path()).unwrap() == b"realm"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
