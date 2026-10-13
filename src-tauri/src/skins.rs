//! lazer's skins, for the playfield preview.
//!
//! The skins themselves come with the library import (the sidecar exports every skin with its
//! files). Two more things live outside the database:
//!   - which skin is selected: `Skin = <id>` in lazer's `game.ini`, read fresh each time;
//!   - the built-in "classic" and "retro" textures and the argon / triangles hit sounds, embedded
//!     in the installed lazer's `osu.Game.Resources.dll`. The sidecar extracts them into Fumen's
//!     cache once per lazer version; they're served as `fumen://localhost/skin/<skin>/<file>`.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::lazer;
use crate::paths::LazerInstall;

/// What a skin renders like, from its lazer type (`InstantiationInfo`), mirroring
/// `SkinInfo.CreateInstance`: no type means a legacy skin imported before types were stored, and
/// the old name of the triangles skin was `DefaultSkin`.
pub fn kind_of(instantiation: Option<&str>) -> &'static str {
    let Some(info) = instantiation.filter(|s| !s.trim().is_empty()) else { return "legacy" };
    let ty = info.split(',').next().unwrap_or("").trim();
    let name = ty.rsplit('.').next().unwrap_or(ty);
    match name {
        "DefaultLegacySkin" => "classic",
        "RetroSkin" => "retro",
        "LegacySkin" => "legacy",
        "TrianglesSkin" | "DefaultSkin" => "triangles",
        "ArgonProSkin" => "argon-pro",
        "ArgonSkin" => "argon",
        _ => "legacy",
    }
}

/// The skin lazer has selected (`Skin = <guid>` in `game.ini`), lowercased.
pub fn selected(install: &LazerInstall) -> Option<String> {
    // game.ini moves with the rest of lazer's data; look where the data is first
    [&install.storage, &install.path].iter().find_map(|dir| {
        let text = std::fs::read_to_string(Path::new(dir).join("game.ini")).ok()?;
        parse_selected(&text)
    })
}

fn parse_selected(ini: &str) -> Option<String> {
    ini.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        let value = value.trim();
        (key.trim() == "Skin" && !value.is_empty()).then(|| value.to_ascii_lowercase())
    })
}

// ── Built-in textures and sounds ────────────────────────────────────────────

/// Folders of the extraction: classic / retro textures (and classic's sounds), the hit sounds of
/// lazer's other built-in skins.
const BUILTIN: [&str; 5] = ["classic", "retro", "triangles", "argon", "argon-pro"];

/// Bumped when the extraction takes more out of the resources (2: hit sounds, 3: osu!taiko's
/// default drum and argon's taiko drums, 4: osu! and osu!catch textures, the cursor trail, spinner
/// and banana sounds).
const EXTRACT_VERSION: u32 = 4;

/// The installed lazer's resources assembly (Velopack install, the default).
fn resources_dll() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let dll = PathBuf::from(local).join("osulazer").join("current").join("osu.Game.Resources.dll");
    dll.is_file().then_some(dll)
}

pub fn builtin_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join("lazer-skins")
}

/// Extracts the built-in skin textures if lazer's resources changed since the last time (or were
/// never extracted). Errors leave the previous extraction in place.
pub fn refresh_builtin(cache_dir: &Path) -> Result<()> {
    // the import and the skin list may both ask at once
    static BUSY: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    let Some(dll) = resources_dll() else { return Ok(()) };
    let meta = std::fs::metadata(&dll)?;
    let stamp = format!("v{EXTRACT_VERSION} {} {}", meta.len(), crate::paths::modified_ms(&meta));
    let dir = builtin_dir(cache_dir);
    if std::fs::read_to_string(dir.join("stamp")).ok().as_deref() == Some(stamp.as_str()) {
        return Ok(());
    }
    let tmp = cache_dir.join("lazer-skins.part");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    lazer::run_skin_resources(&dll, &tmp)?;
    std::fs::write(tmp.join("stamp"), &stamp)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::rename(&tmp, &dir)?;
    Ok(())
}

/// A built-in texture's or sound's path, or `None` for names that could leave the folder.
pub fn builtin_file(cache_dir: &Path, skin: &str, name: &str) -> Option<PathBuf> {
    if !BUILTIN.contains(&skin) {
        return None;
    }
    let ok = !name.is_empty()
        && name != "stamp"
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b'@'));
    ok.then(|| builtin_dir(cache_dir).join(skin).join(name))
}

fn builtin_names(cache_dir: &Path, skin: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(builtin_dir(cache_dir).join(skin)) else { return Vec::new() };
    let mut names: Vec<String> = entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect();
    names.sort();
    names
}

// ── For the UI ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinInfo {
    id: String,
    name: String,
    creator: String,
    kind: String,
    protected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinList {
    skins: Vec<SkinInfo>,
    /// lazer's selected skin
    selected: Option<String>,
    /// file names of the built-in classic / retro textures (empty without a lazer install)
    classic: Vec<String>,
    retro: Vec<String>,
    /// file names of the built-in hit sounds of triangles, argon and argon pro
    triangles: Vec<String>,
    argon: Vec<String>,
    argon_pro: Vec<String>,
}

pub fn list(conn: &Connection, install: Option<&LazerInstall>, cache_dir: &Path) -> Result<SkinList> {
    let mut stmt = conn.prepare("SELECT id, name, creator, kind, protected FROM skins ORDER BY position")?;
    let skins = stmt
        .query_map([], |r| {
            Ok(SkinInfo { id: r.get(0)?, name: r.get(1)?, creator: r.get(2)?, kind: r.get(3)?, protected: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SkinList {
        skins,
        selected: install.and_then(selected),
        classic: builtin_names(cache_dir, "classic"),
        retro: builtin_names(cache_dir, "retro"),
        triangles: builtin_names(cache_dir, "triangles"),
        argon: builtin_names(cache_dir, "argon"),
        argon_pro: builtin_names(cache_dir, "argon-pro"),
    })
}

/// One skin's files as stored (JSON `[[filename, sha256], …]`).
pub fn files(conn: &Connection, id: &str) -> Result<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn.query_row("SELECT files FROM skins WHERE id = ?1", [id], |r| r.get(0)).optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(Some("osu.Game.Skinning.LegacySkin, osu.Game")), "legacy");
        assert_eq!(kind_of(Some("osu.Game.Skinning.DefaultLegacySkin, osu.Game")), "classic");
        assert_eq!(kind_of(Some("osu.Game.Skinning.ArgonProSkin, osu.Game")), "argon-pro");
        assert_eq!(kind_of(Some("osu.Game.Skinning.ArgonSkin, osu.Game")), "argon");
        assert_eq!(kind_of(Some("osu.Game.Skinning.TrianglesSkin, osu.Game")), "triangles");
        assert_eq!(kind_of(Some("osu.Game.Skinning.DefaultSkin, osu.Game")), "triangles");
        assert_eq!(kind_of(Some("osu.Game.Skinning.RetroSkin, osu.Game")), "retro");
        assert_eq!(kind_of(None), "legacy");
        assert_eq!(kind_of(Some("  ")), "legacy");
    }

    #[test]
    fn game_ini() {
        let ini = "Ruleset = mania\r\nSkin = 92F313AE-a16f-4629-9d98-1302fdec6ba8\r\nSkinEditor = 1\r\n";
        assert_eq!(parse_selected(ini).as_deref(), Some("92f313ae-a16f-4629-9d98-1302fdec6ba8"));
        assert_eq!(parse_selected("Skin =\n"), None);
        assert_eq!(parse_selected("Volume = 1\n"), None);
    }

    #[test]
    fn builtin_names_stay_inside() {
        let c = Path::new("C");
        assert!(builtin_file(c, "classic", "mania-key1@2x.png").is_some());
        assert!(builtin_file(c, "classic", "../x.png").is_none());
        assert!(builtin_file(c, "classic", "a/b.png").is_none());
        assert!(builtin_file(c, "classic", "stamp").is_none());
        assert!(builtin_file(c, "argon-pro", "soft-hitclap.wav").is_some());
        assert!(builtin_file(c, "other", "a.png").is_none());
    }
}
