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

/// The sidecar with piped output and (on Windows) no console window.
fn sidecar_command() -> Result<Command> {
    let mut cmd = Command::new(sidecar_path()?);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

/// Runs `fumen-realm export`, forwarding its progress lines.
pub fn run_export(
    storage: &Path,
    out: &Path,
    mut on_progress: impl FnMut(&str, u64, u64),
) -> Result<()> {
    let mut cmd = sidecar_command()?;
    cmd.arg("export").arg(storage.join("client.realm")).arg(out);

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
    Err(sidecar_error(&err_text))
}

/// Runs `fumen-realm skin-resources`: lazer's built-in skin textures from `dll` into `out`.
pub fn run_skin_resources(dll: &Path, out: &Path) -> Result<()> {
    let mut cmd = sidecar_command()?;
    cmd.arg("skin-resources").arg(dll).arg(out);
    let output = cmd.output()?;
    if output.status.success() {
        return Ok(());
    }
    Err(sidecar_error(&String::from_utf8_lossy(&output.stderr)))
}

fn sidecar_error(err_text: &str) -> Error {
    // stderr: "error <code> <message>"
    let line = err_text.lines().find(|l| l.starts_with("error ")).unwrap_or(err_text.trim());
    let mut parts = line.splitn(3, ' ');
    let _ = parts.next();
    let code = parts.next().unwrap_or("");
    let message = parts.next().unwrap_or(line).to_string();
    match code {
        "unsupported-format" => Error::known("lazer-format", message),
        "not-found" => Error::known("lazer-not-found", message),
        _ => Error::known("lazer-read-failed", format!("Reading lazer's database failed: {message}")),
    }
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
    #[serde(default)]
    ruleset_settings: Vec<LSetting>,
    #[serde(default)]
    skins: Vec<LSkin>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LSkin {
    id: String,
    name: Option<String>,
    creator: Option<String>,
    instantiation_info: Option<String>,
    #[serde(default)]
    protected: bool,
    #[serde(default)]
    files: Vec<(String, String)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LSetting {
    ruleset: Option<String>,
    variant: Option<i64>,
    key: Option<String>,
    value: Option<String>,
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
    /// sound files and the storyboard, as [filename, hash]
    #[serde(default)]
    sounds: Vec<(String, String)>,
    /// every file, as [filename, hash]
    #[serde(default)]
    files: Vec<(String, String)>,
    /// lazer's hash of the set's files
    hash: Option<String>,
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
    /// the replay file's hash in lazer's files/
    replay: Option<String>,
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
    pub skins: usize,
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
        "DELETE FROM lazer_collections WHERE source = 'lazer';
         DELETE FROM scores;
         DELETE FROM sets WHERE source = 'lazer';
         DELETE FROM skins;",
    )?;

    {
        let mut ins_set = tx.prepare(
            "INSERT INTO sets (id, source, online_id, status, date_added, date_submitted, date_ranked,
                protected, title, title_unicode, artist, artist_unicode, creator, creator_id,
                source_text, tags, bg, audio, preview_time, sounds, files, hash)
             VALUES (?1, 'lazer', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
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
                serde_json::to_string(&set.sounds)?,
                serde_json::to_string(&set.files)?,
                set.hash,
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
                user, user_id, replay)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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
                s.replay,
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

        let mut ins_skin = tx.prepare(
            "INSERT OR REPLACE INTO skins (id, name, creator, kind, protected, position, files)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (pos, s) in export.skins.iter().enumerate() {
            if s.id.is_empty() {
                continue;
            }
            ins_skin.execute(params![
                s.id,
                s.name.as_deref().unwrap_or(""),
                s.creator.as_deref().unwrap_or(""),
                crate::skins::kind_of(s.instantiation_info.as_deref()),
                s.protected,
                pos as i64,
                serde_json::to_string(&s.files)?,
            ])?;
            counts.skins += 1;
        }
    }

    // osu!mania settings (scroll speed and direction) for the playfield preview
    let mania: serde_json::Map<String, serde_json::Value> = export
        .ruleset_settings
        .iter()
        .filter(|s| s.ruleset.as_deref() == Some("mania") && s.variant.unwrap_or(0) == 0)
        .filter_map(|s| Some((s.key.clone()?, serde_json::Value::String(s.value.clone().unwrap_or_default()))))
        .collect();
    db::set_meta(&tx, "lazer.maniaSettings", &serde_json::Value::Object(mania).to_string())?;

    db::set_meta(&tx, "lazer.skins", &counts.skins.to_string())?;
    db::set_meta(&tx, "lazer.setSounds", "1")?;
    db::set_meta(&tx, "lazer.setFiles", "1")?;
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

        // with lazer's files at hand (FUMEN_TEST_STORAGE), the snapshot carries the chart analysis too
        if let Some(storage) = std::env::var_os("FUMEN_TEST_STORAGE") {
            let hashes = crate::charts::pending(&conn).unwrap();
            let rows = crate::charts::analyse_batch(&crate::paths::Files::lazer(&storage), &hashes);
            crate::charts::store(&mut conn, &rows).unwrap();
            // hitsounds come with the sets' sound files: some chart has its own samples
            let ids: Vec<String> = conn
                .prepare("SELECT m.id FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.ruleset_id = 3 AND s.sounds LIKE '%.wav%' LIMIT 200")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            let own = ids
                .iter()
                .filter_map(|id| crate::hitsounds::for_map(&conn, &crate::paths::Files::lazer(&storage), id).ok())
                .filter(|s| s.samples.iter().any(|x| matches!(x, crate::hitsounds::Sample::File(_))))
                .count();
            eprintln!("hitsounds: {own} of {} charts with .wav files in their set use them", ids.len());
            assert!(own > 0);
        }

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
