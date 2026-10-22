//! Locating osu! installs, and the files behind the library's file keys.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

/// Where lazer keeps its data unless the user moved it.
pub fn default_lazer_dir() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        return std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Application Support").join("osu"));
    }
    if cfg!(target_os = "linux") {
        return crate::lazer_linux::data_dir();
    }
    std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("osu"))
}

/// lazer can move its data elsewhere ("Change folder location" in settings). The original folder
/// then keeps a `storage.ini` with `FullPath = <new location>`.
pub fn resolve_lazer_storage(dir: &Path) -> PathBuf {
    let ini = dir.join("storage.ini");
    if let Ok(text) = std::fs::read_to_string(ini) {
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.trim().eq_ignore_ascii_case("FullPath") {
                let moved = PathBuf::from(value.trim());
                if moved.join("client.realm").is_file() {
                    return moved;
                }
            }
        }
    }
    dir.to_path_buf()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazerInstall {
    /// Folder the user picked / we detected.
    pub path: String,
    /// Folder that actually holds client.realm and files/ (differs if storage was moved).
    pub storage: String,
    pub realm_size: u64,
    /// Unix ms.
    pub realm_modified: i64,
}

pub fn inspect_lazer(dir: &Path) -> Option<LazerInstall> {
    let storage = resolve_lazer_storage(dir);
    let meta = std::fs::metadata(storage.join("client.realm")).ok()?;
    if !storage.join("files").is_dir() {
        return None;
    }
    Some(LazerInstall {
        path: dir.to_string_lossy().into_owned(),
        storage: storage.to_string_lossy().into_owned(),
        realm_size: meta.len(),
        realm_modified: modified_ms(&meta),
    })
}

pub fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `files/a/ab/abcdef…` — lazer's content-addressed layout. `None` for anything that isn't a
/// lowercase SHA-256 hex string, which also rules out path traversal.
pub fn lazer_file(storage: &Path, hash: &str) -> Option<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    Some(storage.join("files").join(&hash[..1]).join(&hash[..2]).join(hash))
}

// ── osu!stable ──────────────────────────────────────────────────────────

/// Where stable is installed unless the user put it elsewhere. Windows only: stable has no build
/// for other systems (a folder picked by hand still works).
pub fn default_stable_dir() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    std::env::var_os("LOCALAPPDATA").map(|local| PathBuf::from(local).join("osu!"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StableInstall {
    /// stable's folder (holds osu!.db)
    pub path: String,
    /// its Songs folder (`BeatmapDirectory` in the player's osu!.<name>.cfg, else Songs)
    pub songs: String,
    pub db_size: u64,
    /// Unix ms.
    pub db_modified: i64,
}

pub fn inspect_stable(dir: &Path) -> Option<StableInstall> {
    let meta = std::fs::metadata(dir.join("osu!.db")).ok()?;
    let songs = songs_dir(dir);
    if !songs.is_dir() {
        return None;
    }
    Some(StableInstall {
        path: dir.to_string_lossy().into_owned(),
        songs: songs.to_string_lossy().into_owned(),
        db_size: meta.len(),
        db_modified: modified_ms(&meta),
    })
}

/// stable can keep its songs elsewhere: `BeatmapDirectory = …` in `osu!.<user>.cfg`, absolute or
/// relative to stable's folder.
fn songs_dir(dir: &Path) -> PathBuf {
    let cfgs = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| {
        p.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
            let n = n.to_lowercase();
            n.starts_with("osu!.") && n.ends_with(".cfg") && n != "osu!.cfg"
        })
    });
    for cfg in cfgs {
        let Ok(text) = std::fs::read_to_string(&cfg) else { continue };
        for line in text.lines() {
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.trim().eq_ignore_ascii_case("BeatmapDirectory") && !value.trim().is_empty() {
                let p = PathBuf::from(value.trim());
                return if p.is_absolute() { p } else { dir.join(p) };
            }
        }
    }
    dir.join("Songs")
}

/// stable's files by key: a key stands for a file in its Songs folder as it was when scanned
/// (see `stable::file_key`), so like lazer's hashes it never points at changed content.
#[derive(Debug, Default)]
pub struct StableFiles {
    pub songs: PathBuf,
    /// key → path inside the Songs folder
    pub keys: HashMap<String, String>,
}

/// Where the library's file keys point: lazer's store, or stable's Songs folder.
#[derive(Clone)]
pub struct Files {
    pub lazer: Option<PathBuf>,
    pub stable: Arc<StableFiles>,
}

impl Files {
    /// lazer's store only.
    #[cfg(test)]
    pub fn lazer(storage: impl Into<PathBuf>) -> Files {
        Files { lazer: Some(storage.into()), stable: Arc::default() }
    }

    pub fn path(&self, key: &str) -> Option<PathBuf> {
        if let Some(rel) = self.stable.keys.get(key) {
            return Some(self.stable.songs.join(rel));
        }
        lazer_file(self.lazer.as_deref()?, key)
    }

    /// The file behind a key, read whole.
    pub fn read(&self, key: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path(key)?).ok()
    }

    pub fn is_empty(&self) -> bool {
        self.lazer.is_none() && self.stable.keys.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_resolve_both_sources() {
        let h = "260131dd1bb53eff86f8eade66a28a7d0611935258c1e27c69c54fde44bb340c";
        let mut keys = HashMap::new();
        keys.insert("k1".to_string(), "Set/a.osu".to_string());
        let files = Files { lazer: Some(PathBuf::from("L")), stable: Arc::new(StableFiles { songs: PathBuf::from("S"), keys }) };
        assert_eq!(files.path("k1"), Some(Path::new("S").join("Set/a.osu")));
        assert_eq!(files.path(h), lazer_file(Path::new("L"), h));
        assert_eq!(files.path("k2"), None);
        let none = Files { lazer: None, stable: Arc::default() };
        assert_eq!(none.path(h), None);
        assert!(none.is_empty());
    }

    #[test]
    fn stable_songs_folder() {
        let dir = std::env::temp_dir().join(format!("fumen-stable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Songs")).unwrap();
        std::fs::write(dir.join("osu!.db"), b"x").unwrap();
        assert_eq!(PathBuf::from(inspect_stable(&dir).unwrap().songs), dir.join("Songs"));
        std::fs::create_dir_all(dir.join("Elsewhere")).unwrap();
        std::fs::write(dir.join("osu!.cfg"), "BeatmapDirectory = Nope\n").unwrap();
        std::fs::write(dir.join("osu!.Player.cfg"), "# osu! configuration\nBeatmapDirectory = Elsewhere\n").unwrap();
        assert_eq!(PathBuf::from(inspect_stable(&dir).unwrap().songs), dir.join("Elsewhere"));
        assert!(inspect_stable(&dir.join("Songs")).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lazer_file_layout() {
        let h = "260131dd1bb53eff86f8eade66a28a7d0611935258c1e27c69c54fde44bb340c";
        let p = lazer_file(Path::new("X"), h).unwrap();
        assert_eq!(p, Path::new("X").join("files").join("2").join("26").join(h));
    }

    #[test]
    fn lazer_file_rejects_junk() {
        assert!(lazer_file(Path::new("X"), "../../etc/passwd").is_none());
        assert!(lazer_file(Path::new("X"), &"A".repeat(64)).is_none());
        assert!(lazer_file(Path::new("X"), "abc").is_none());
    }
}
