//! Locating osu! installs.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Where lazer keeps its data unless the user moved it.
pub fn default_lazer_dir() -> Option<PathBuf> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
