//! osu!lazer on Linux: where it's installed and whether it runs.
//!
//! lazer comes as `osu.AppImage` (its own release, updated in place by Velopack, kept wherever its
//! user put it), as the Flatpak `sh.ppy.osu`, or unpacked by a distribution's package (the AUR's
//! `osu-lazer-bin`). The importer needs lazer's assemblies as files: a Flatpak's or a package's
//! folder has them; an AppImage is unpacked once per AppImage file (`--appimage-extract`, no FUSE
//! needed) into Fumen's cache, and that copy is what the importer's folder links to.

// plain std, so its tests run on every system; only Linux builds use it
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use crate::lazer_import::{parse_sq_version, Installed};

/// Folders an unpacked lazer is looked for in (a few levels down): Flatpak, distribution packages.
fn unpacked_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/share/flatpak/app/sh.ppy.osu/current/active/files"),
        PathBuf::from("/var/lib/flatpak/app/sh.ppy.osu/current/active/files"),
        PathBuf::from("/opt/osu-lazer"),
        PathBuf::from("/usr/lib/osu-lazer"),
        PathBuf::from("/usr/share/osu-lazer"),
        PathBuf::from("/opt/osu"),
    ]
}

/// Folders an `osu*.AppImage` is looked for in.
fn appimage_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Applications"),
        home.join(".local/bin"),
        home.join("Downloads"),
        home.join("Desktop"),
        home.join("Games"),
        home.to_path_buf(),
        PathBuf::from("/opt"),
        PathBuf::from("/opt/osu-lazer"),
        PathBuf::from("/usr/local/bin"),
    ]
}

/// Whether a file name is lazer's AppImage ("osu.AppImage", "osu-lazer.AppImage", "osu!.AppImage" …).
pub fn is_lazer_appimage(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("osu") && n.ends_with(".appimage")
}

/// The folder under `root` (itself or a few levels down) that holds lazer's assemblies.
fn find_assemblies(root: &Path, depth: u32) -> Option<PathBuf> {
    if root.join("osu.Game.dll").is_file() {
        return Some(root.to_path_buf());
    }
    if depth == 0 {
        return None;
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root).ok()?.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
    dirs.sort();
    dirs.iter().find_map(|d| find_assemblies(d, depth - 1))
}

/// Velopack's `sq.version` next to the assemblies or a level or two up.
fn version_near(dir: &Path) -> Option<String> {
    dir.ancestors().take(3).find_map(|d| parse_sq_version(&std::fs::read_to_string(d.join("sq.version")).ok()?))
}

/// Fumen's cache for unpacked AppImages: `$XDG_CACHE_HOME/dev.fumen.app/lazer-appimage`.
fn appimage_cache(home: &Path) -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".cache"));
    base.join("dev.fumen.app").join("lazer-appimage")
}

/// one unpacking at a time
static UNPACKING: Mutex<()> = Mutex::new(());

/// The newest lazer AppImage's assemblies, unpacked into the cache the first time it's seen
/// (named by its size and time, so an update in place is a new folder; older ones go).
fn from_appimage(home: &Path) -> Option<PathBuf> {
    let newest = appimage_dirs(home)
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|r| r.flatten())
        .filter(|e| is_lazer_appimage(&e.file_name().to_string_lossy()) && e.path().is_file())
        .filter_map(|e| Some((e.metadata().ok()?, e.path())))
        .max_by_key(|(m, _)| m.modified().ok())?;
    let (meta, image) = newest;
    let stamp = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let cache = appimage_cache(home);
    let dir = cache.join(format!("{}-{stamp}", meta.len()));
    let _lock = UNPACKING.lock().unwrap_or_else(|e| e.into_inner());
    let root = dir.join("squashfs-root");
    if !dir.join(".fumen-ready").is_file() {
        if let Ok(entries) = std::fs::read_dir(&cache) {
            for e in entries.flatten() {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
        std::fs::create_dir_all(&dir).ok()?;
        let ok = Command::new(&image)
            .arg("--appimage-extract")
            .current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            let _ = std::fs::remove_dir_all(&dir);
            return None;
        }
        std::fs::write(dir.join(".fumen-ready"), image.to_string_lossy().as_bytes()).ok()?;
    }
    find_assemblies(&root, 3)
}

/// lazer's assemblies and version: an unpacked install first, else the AppImage.
pub fn installed() -> Option<Installed> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let dir = unpacked_roots(&home).iter().find_map(|r| find_assemblies(r, 3)).or_else(|| from_appimage(&home))?;
    let version = version_near(&dir)?;
    Some(Installed { dir, version })
}

/// Whether a process' name (`/proc/<pid>/comm`) is lazer's.
pub fn is_lazer_process(comm: &str) -> bool {
    comm.trim() == "osu!"
}

/// Whether lazer runs: a process named `osu!` (the AppImage's, the Flatpak's and the packages'
/// alike). A process list that can't be read counts as running.
pub fn running() -> bool {
    let Ok(procs) = std::fs::read_dir("/proc") else { return true };
    procs.flatten().filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit())).any(|e| {
        std::fs::read_to_string(e.path().join("comm")).is_ok_and(|c| is_lazer_process(&c))
    })
}

/// lazer's data folder: `$XDG_DATA_HOME/osu` (`~/.local/share/osu`), or the Flatpak's.
pub fn data_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let data = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
    let own = data.join("osu");
    let flatpak = home.join(".var/app/sh.ppy.osu/data/osu");
    let has = |d: &Path| d.join("client.realm").is_file() || d.join("storage.ini").is_file();
    Some(if !has(&own) && has(&flatpak) { flatpak } else { own })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_names() {
        assert!(is_lazer_appimage("osu.AppImage"));
        assert!(is_lazer_appimage("osu-lazer.appimage"));
        assert!(is_lazer_appimage("osu!.AppImage"));
        assert!(!is_lazer_appimage("Fumen.AppImage"));
        assert!(!is_lazer_appimage("osu.zip"));
    }

    #[test]
    fn process_names() {
        assert!(is_lazer_process("osu!\n"));
        assert!(!is_lazer_process("osu-wine\n"));
        assert!(!is_lazer_process("fumen\n"));
    }

    #[test]
    fn finds_assemblies_below() {
        let root = std::env::temp_dir().join(format!("fumen-lazer-find-{}", std::process::id()));
        let bin = root.join("squashfs-root").join("usr").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("osu.Game.dll"), b"").unwrap();
        std::fs::write(bin.join("sq.version"), b"<package><version>2026.1005.0-lazer</version></package>").unwrap();
        let dir = find_assemblies(&root, 3).unwrap();
        assert_eq!(dir, bin);
        assert_eq!(version_near(&dir).as_deref(), Some("2026.1005.0-lazer"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
