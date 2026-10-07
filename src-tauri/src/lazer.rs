//! osu!lazer import: run the `fumen-realm` sidecar, then load its JSON into SQLite.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::{Error, Result};
use crate::paths::LazerInstall;

/// JSON shape version the sidecar writes (`format` field). Must match FumenRealm/Program.cs.
const EXPORT_FORMAT: u32 = 1;

// ── Sidecar ─────────────────────────────────────────────────────────────────

/// Tauri copies `externalBin` next to the main executable (dev and bundle alike), with the
/// target-triple suffix stripped.
fn sidecar_path() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| Error::known("sidecar-missing", "No executable dir"))?;
    let path = dir.join(if cfg!(windows) { "fumen-realm.exe" } else { "fumen-realm" });
    if path.is_file() {
        Ok(path)
    } else {
        Err(Error::known(
            "sidecar-missing",
            format!("The lazer reader is missing ({}). Run `npm run sidecar`.", path.display()),
        ))
    }
}

/// Runs `fumen-realm export`, forwarding its progress lines.
pub fn run_export(
    storage: &Path,
    out: &Path,
    mut on_progress: impl FnMut(&str, u64, u64),
) -> Result<()> {
    let mut cmd = Command::new(sidecar_path()?);
    cmd.arg("export")
        .arg(storage.join("client.realm"))
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    for line in BufReader::new(stdout).lines() {
        let line = line?;
        let mut parts = line.split_whitespace();
        if parts.next() == Some("progress") {
            if let (Some(stage), Some(done), Some(total)) = (parts.next(), parts.next(), parts.next()) {
                on_progress(stage, done.parse().unwrap_or(0), total.parse().unwrap_or(0));
            }
        }
    }

    let status = child.wait()?;
    let err_text = err_reader.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    // stderr: "error <code> <message>"
    let line = err_text.lines().find(|l| l.starts_with("error ")).unwrap_or(err_text.trim());
    let mut parts = line.splitn(3, ' ');
    let _ = parts.next();
    let code = parts.next().unwrap_or("");
    let message = parts.next().unwrap_or(line).to_string();
    Err(match code {
        "unsupported-format" => Error::known("lazer-format", message),
        "not-found" => Error::known("lazer-not-found", message),
        _ => Error::known("lazer-read-failed", format!("Reading lazer's database failed: {message}")),
    })
}

// ── Export document ─────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    format: u32,
    sets: Vec<LSet>,
    #[serde(default)]
    scores: Vec<LScore>,
    #[serde(default)]
    collections: Vec<LCollection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LSet {
    id: String,
    online_id: Option<i64>,
    status: Option<i64>,
    date_added: Option<i64>,
    date_submitted: Option<i64>,
    date_ranked: Option<i64>,
    #[serde(default)]
    protected: bool,
    #[serde(default)]
    maps: Vec<LMap>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LMap {
    id: String,
    online_id: Option<i64>,
    version: Option<String>,
    ruleset: Option<String>,
    ruleset_id: Option<i64>,
    status: Option<i64>,
    hash: Option<String>,
    md5: Option<String>,
    sr: Option<f64>,
    bpm: Option<f64>,
    length: Option<f64>,
    objects: Option<i64>,
    end_objects: Option<i64>,
    last_played: Option<i64>,
    last_update: Option<i64>,
    #[serde(default)]
    hidden: bool,
    hp: Option<f64>,
    cs: Option<f64>,
    od: Option<f64>,
    ar: Option<f64>,
    title: Option<String>,
    title_unicode: Option<String>,
    artist: Option<String>,
    artist_unicode: Option<String>,
    creator: Option<String>,
    creator_id: Option<i64>,
    source: Option<String>,
    tags: Option<String>,
    preview_time: Option<i64>,
    audio: Option<String>,
    bg: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LScore {
    id: String,
    map_id: Option<String>,
    map_md5: Option<String>,
    ruleset: Option<String>,
    total_score: Option<i64>,
    accuracy: Option<f64>,
    max_combo: Option<i64>,
    rank: Option<i64>,
    pp: Option<f64>,
    date: Option<i64>,
    mods: Option<String>,
    statistics: Option<String>,
    maximum_statistics: Option<String>,
    online_id: Option<i64>,
    #[serde(default)]
    legacy: bool,
    user: Option<String>,
    user_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LCollection {
    id: String,
    name: Option<String>,
    modified: Option<i64>,
    #[serde(default)]
    md5s: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub sets: usize,
    pub maps: usize,
    pub scores: usize,
    pub collections: usize,
}

// ── Import ──────────────────────────────────────────────────────────────────

/// Replaces the cached lazer library with the export at `json`, atomically.
pub fn import(conn: &mut Connection, json: &Path, install: &LazerInstall) -> Result<ImportCounts> {
    let bytes = std::fs::read(json)?;
    let export: Export = serde_json::from_slice(&bytes)?;
    drop(bytes);
    if export.format != EXPORT_FORMAT {
        return Err(Error::known(
            "lazer-read-failed",
            format!("Unexpected export format {} (expected {EXPORT_FORMAT})", export.format),
        ));
    }

    let mut counts = ImportCounts::default();
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DELETE FROM lazer_collection_items;
         DELETE FROM lazer_collections;
         DELETE FROM scores;
         DELETE FROM maps;
         DELETE FROM sets WHERE source = 'lazer';",
    )?;

    {
        let mut ins_set = tx.prepare(
            "INSERT INTO sets (id, source, online_id, status, date_added, date_submitted, date_ranked,
                protected, title, title_unicode, artist, artist_unicode, creator, creator_id,
                source_text, tags, bg, audio, preview_time)
             VALUES (?1, 'lazer', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        )?;
        let mut ins_map = tx.prepare(
            "INSERT INTO maps (id, set_id, online_id, version, ruleset, ruleset_id, status, hash, md5,
                sr, bpm, length, objects, end_objects, last_played, last_update, hidden,
                hp, cs, od, ar, bg, audio, preview_time)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        )?;

        for set in &export.sets {
            if set.maps.is_empty() || set.id.is_empty() {
                continue;
            }
            let rep = representative(&set.maps);
            let bg = most_common(set.maps.iter().map(|m| m.bg.as_deref()));
            let audio = most_common(set.maps.iter().map(|m| m.audio.as_deref()));
            let preview = set
                .maps
                .iter()
                .find(|m| m.audio.as_deref() == audio)
                .and_then(|m| m.preview_time)
                .or(rep.preview_time);

            ins_set.execute(params![
                set.id,
                set.online_id,
                set.status,
                set.date_added,
                set.date_submitted,
                set.date_ranked,
                set.protected,
                rep.title.as_deref().unwrap_or(""),
                rep.title_unicode.as_deref().unwrap_or(""),
                rep.artist.as_deref().unwrap_or(""),
                rep.artist_unicode.as_deref().unwrap_or(""),
                rep.creator.as_deref().unwrap_or(""),
                rep.creator_id,
                rep.source.as_deref().unwrap_or(""),
                rep.tags.as_deref().unwrap_or(""),
                bg,
                audio,
                preview,
            ])?;
            counts.sets += 1;

            for m in &set.maps {
                ins_map.execute(params![
                    m.id,
                    set.id,
                    m.online_id,
                    m.version.as_deref().unwrap_or(""),
                    m.ruleset,
                    m.ruleset_id,
                    m.status,
                    m.hash,
                    m.md5,
                    m.sr,
                    m.bpm,
                    m.length,
                    m.objects,
                    m.end_objects,
                    m.last_played,
                    m.last_update,
                    m.hidden,
                    m.hp,
                    m.cs,
                    m.od,
                    m.ar,
                    m.bg,
                    m.audio,
                    m.preview_time,
                ])?;
                counts.maps += 1;
            }
        }

        let mut ins_score = tx.prepare(
            "INSERT OR REPLACE INTO scores (id, map_id, map_md5, ruleset, total_score, accuracy,
                max_combo, rank, pp, date, mods, statistics, maximum_statistics, online_id, legacy,
                user, user_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        )?;
        for s in &export.scores {
            ins_score.execute(params![
                s.id,
                s.map_id,
                s.map_md5,
                s.ruleset,
                s.total_score,
                s.accuracy,
                s.max_combo,
                s.rank,
                s.pp,
                s.date,
                s.mods,
                s.statistics,
                s.maximum_statistics,
                s.online_id,
                s.legacy,
                s.user,
                s.user_id,
            ])?;
            counts.scores += 1;
        }

        let mut ins_col = tx.prepare(
            "INSERT INTO lazer_collections (id, name, modified, position) VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut ins_item = tx.prepare(
            "INSERT INTO lazer_collection_items (collection_id, md5, position) VALUES (?1, ?2, ?3)",
        )?;
        for (pos, c) in export.collections.iter().enumerate() {
            ins_col.execute(params![c.id, c.name.as_deref().unwrap_or("Collection"), c.modified, pos as i64])?;
            for (i, md5) in c.md5s.iter().enumerate() {
                ins_item.execute(params![c.id, md5, i as i64])?;
            }
            counts.collections += 1;
        }
    }

    db::set_meta(&tx, "lazer.storage", &install.storage)?;
    db::set_meta(&tx, "lazer.realmSize", &install.realm_size.to_string())?;
    db::set_meta(&tx, "lazer.realmModified", &install.realm_modified.to_string())?;
    db::set_meta(&tx, "lazer.lastScan", &now_ms().to_string())?;
    db::set_meta(&tx, "lazer.counts", &serde_json::to_string(&counts)?)?;
    tx.commit()?;
    Ok(counts)
}

/// Set-level metadata comes from the first visible difficulty that has a title.
fn representative(maps: &[LMap]) -> &LMap {
    maps.iter()
        .find(|m| !m.hidden && m.title.as_deref().is_some_and(|t| !t.is_empty()))
        .or_else(|| maps.iter().find(|m| m.title.as_deref().is_some_and(|t| !t.is_empty())))
        .unwrap_or(&maps[0])
}

fn most_common<'a>(values: impl Iterator<Item = Option<&'a str>>) -> Option<&'a str> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut order: Vec<&str> = Vec::new();
    for v in values.flatten() {
        let c = counts.entry(v).or_insert(0);
        if *c == 0 {
            order.push(v);
        }
        *c += 1;
    }
    // ties → first seen, so the result is stable across scans
    order.into_iter().max_by(|a, b| counts[a].cmp(&counts[b]).then(std::cmp::Ordering::Greater))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn most_common_prefers_count_then_first_seen() {
        let v = [Some("a"), Some("b"), Some("b"), None, Some("a"), Some("c")];
        assert_eq!(most_common(v.into_iter()), Some("a"));
        let v = [Some("x"), Some("y"), Some("y")];
        assert_eq!(most_common(v.into_iter()), Some("y"));
        let v: [Option<&str>; 2] = [None, None];
        assert_eq!(most_common(v.into_iter()), None);
    }

    /// End-to-end on a real export: `FUMEN_TEST_EXPORT=<json> cargo test -- --ignored`.
    #[test]
    #[ignore = "needs FUMEN_TEST_EXPORT pointing at a fumen-realm export"]
    fn import_real_export() {
        let Some(json) = std::env::var_os("FUMEN_TEST_EXPORT") else { return };
        let dir = std::env::temp_dir().join(format!("fumen-import-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut conn = db::open(&dir.join("t.db")).unwrap();
        let install = LazerInstall { path: "x".into(), storage: "x".into(), realm_size: 1, realm_modified: 1 };

        let t = std::time::Instant::now();
        let counts = import(&mut conn, Path::new(&json), &install).unwrap();
        eprintln!("import: {counts:?} in {:?}", t.elapsed());
        // importing twice must replace, not duplicate
        let again = import(&mut conn, Path::new(&json), &install).unwrap();
        assert_eq!(counts.maps, again.maps);

        let t = std::time::Instant::now();
        let snap = crate::library::snapshot_json(&conn).unwrap();
        eprintln!("snapshot: {} KiB in {:?}", snap.len() / 1024, t.elapsed());
        let v: serde_json::Value = serde_json::from_slice(&snap).unwrap();
        assert_eq!(v["sets"].as_array().unwrap().len(), counts.sets);
        assert_eq!(v["maps"].as_array().unwrap().len(), counts.maps);
        assert_eq!(v["collections"].as_array().unwrap().len(), counts.collections);
        // feeds the browser preview (tools/browser-preview)
        if let Some(out) = std::env::var_os("FUMEN_SNAPSHOT_OUT") {
            std::fs::write(out, &snap).unwrap();
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
