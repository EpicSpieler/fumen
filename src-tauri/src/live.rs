//! Plays as they happen. When a play is passed, lazer saves the score with its replay, and the
//! replay lands in lazer's files/ as an `.osr` (named by its SHA-256). Fumen watches that folder
//! and reads new replays: the difficulty (by MD5), the judgements, the mods with their rate and
//! lazer's rank are all in it. Nothing of the game is touched while it runs: no database, no
//! memory, only a file lazer has written and finished.
//!
//! A new play goes into `live_plays` (so today's session survives a restart) and out to every
//! window as `live-play`. Replays that turn up but weren't just played (an imported or downloaded
//! one) are left alone: a play counts only when its replay is from the last few minutes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::error::Result;
use crate::replay::Header;

/// A replay is a play only when it's at most this old (ms) when it shows up.
const FRESH: i64 = 10 * 60 * 1000;
/// how long a new file has to stay the same size before it's read
const SETTLE: Duration = Duration::from_millis(700);
/// bigger than any replay (hours of play are a few MB)
const MAX_REPLAY: u64 = 64 * 1024 * 1024;

/// A play as Fumen shows it: the score and the difficulty it was on.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LivePlay {
    /// the replay's file name in lazer's files (its SHA-256)
    pub id: String,
    pub md5: String,
    /// 0 osu!, 1 taiko, 2 catch, 3 mania
    pub mode: u8,
    pub player: String,
    /// unix ms
    pub date: i64,
    /// 0–1, as lazer counts it
    pub accuracy: f64,
    /// lazer's rank: XH, X, SH, S, A, B, C, D
    pub rank: Option<String>,
    pub score: i64,
    pub combo: i64,
    pub mods: Vec<String>,
    /// the mods' playback rate, when not 1×
    pub rate: Option<f64>,
    /// lazer's judgement counts by name ("perfect": 120 …)
    pub statistics: Value,
    pub maximum_statistics: Value,
    /// the library difficulty, when Fumen has it
    pub map: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub version: Option<String>,
    /// the set's library id (for its cover)
    pub set: Option<String>,
    /// osu!'s id of the set
    pub set_online: Option<i64>,
    pub stars: Option<f64>,
    /// ms, at 1×
    pub length: Option<f64>,
    /// the best accuracy on this difficulty before this play (lazer's scores and earlier plays)
    pub best_before: Option<f64>,
}

/// What a judgement is worth for accuracy, as lazer weighs it per ruleset
/// (ScoreProcessor.GetBaseScoreForResult and the rulesets' overrides). None: not counted.
fn weight(mode: u8, result: &str) -> Option<f64> {
    Some(match (mode, result) {
        (3, "perfect") => 305.0,
        (_, "perfect") => 315.0,
        (2, "great" | "large_tick_hit" | "small_tick_hit") => 300.0,
        (2, "miss" | "large_tick_miss" | "small_tick_miss") => 0.0,
        (_, "great") => 300.0,
        (_, "good") => 200.0,
        (1, "ok") => 150.0,
        (_, "ok") => 100.0,
        (_, "meh") => 50.0,
        (_, "slider_tail_hit") => 150.0,
        (_, "large_tick_hit") => 30.0,
        (_, "small_tick_hit") => 10.0,
        (_, "miss" | "large_tick_miss" | "small_tick_miss") => 0.0,
        _ => return None,
    })
}

/// lazer's accuracy from a score's judgement counts and the best it could have had.
pub fn accuracy(mode: u8, statistics: &Value, maximum: &Value) -> Option<f64> {
    let sum = |v: &Value| -> f64 {
        v.as_object()
            .map(|o| o.iter().filter_map(|(k, n)| Some(weight(mode, &k.to_ascii_lowercase())? * n.as_f64().unwrap_or(0.0))).sum())
            .unwrap_or(0.0)
    };
    let max = sum(maximum);
    (max > 0.0).then(|| (sum(statistics) / max).clamp(0.0, 1.0))
}

const RANKS: [&str; 9] = ["F", "D", "C", "B", "A", "S", "SH", "X", "XH"];

/// lazer's rank, given as its name or its number (ScoreRank: F = -1 … XH = 7).
fn rank_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if RANKS.contains(&s.as_str()) => Some(s.clone()),
        Value::Number(n) => n.as_i64().and_then(|i| RANKS.get(usize::try_from(i + 1).ok()?)).map(|s| s.to_string()),
        _ => None,
    }
}

/// stable's mod bits (for replays without lazer's info)
const LEGACY_MODS: [(i32, &str); 14] = [
    (1, "NF"),
    (2, "EZ"),
    (8, "HD"),
    (16, "HR"),
    (32, "SD"),
    (64, "DT"),
    (256, "HT"),
    (512, "NC"),
    (1024, "FL"),
    (4096, "SO"),
    (16384, "PF"),
    (1048576, "FI"),
    (1073741824, "MR"),
    (128, "RX"),
];

/// The mods and their rate: lazer's own list when the replay has it, else stable's bits.
fn mods_of(h: &Header) -> (Vec<String>, Option<f64>) {
    if let Some(list) = h.lazer.as_ref().and_then(|l| l["mods"].as_array()) {
        let mut rate = None;
        let mut out = Vec::new();
        for m in list {
            let Some(a) = m["acronym"].as_str() else { continue };
            out.push(a.to_string());
            let base = match a {
                "DT" | "NC" => Some(1.5),
                "HT" | "DC" => Some(0.75),
                _ => None,
            };
            if let Some(b) = base {
                rate = Some(m["settings"]["speed_change"].as_f64().unwrap_or(b));
            }
        }
        return (out, rate);
    }
    let mut out: Vec<String> = LEGACY_MODS.iter().filter(|(bit, _)| h.mods & bit != 0).map(|(_, a)| a.to_string()).collect();
    // Nightcore comes with Double Time's bit, Perfect with Sudden Death's
    if out.iter().any(|m| m == "NC") {
        out.retain(|m| m != "DT");
    }
    if out.iter().any(|m| m == "PF") {
        out.retain(|m| m != "SD");
    }
    let rate = if h.mods & (64 | 512) != 0 {
        Some(1.5)
    } else if h.mods & 256 != 0 {
        Some(0.75)
    } else {
        None
    };
    (out, rate)
}

/// The score in a replay (without the library's side).
pub fn play_of(id: &str, h: &Header) -> LivePlay {
    let lazer = h.lazer.as_ref();
    let statistics = lazer.map(|l| l["statistics"].clone()).filter(Value::is_object).unwrap_or_else(|| legacy_statistics(h));
    let maximum_statistics = lazer.map(|l| l["maximum_statistics"].clone()).filter(Value::is_object).unwrap_or(Value::Null);
    let accuracy = accuracy(h.mode, &statistics, &maximum_statistics).unwrap_or_else(|| legacy_accuracy(h));
    let (mods, rate) = mods_of(h);
    LivePlay {
        id: id.to_string(),
        md5: h.beatmap_md5.clone(),
        mode: h.mode,
        player: h.player.clone(),
        date: h.date,
        accuracy,
        rank: lazer.and_then(|l| rank_of(&l["rank"])),
        score: lazer.and_then(|l| l["total_score"].as_i64()).unwrap_or(h.score as i64),
        combo: h.combo as i64,
        mods,
        rate,
        statistics,
        maximum_statistics,
        map: None,
        title: None,
        artist: None,
        version: None,
        set: None,
        set_online: None,
        stars: None,
        length: None,
        best_before: None,
    }
}

/// stable's counts as lazer's names
fn legacy_statistics(h: &Header) -> Value {
    let [c300, c100, c50, geki, katu, miss] = h.counts.map(|c| c as i64);
    match h.mode {
        3 => serde_json::json!({ "perfect": geki, "great": c300, "good": katu, "ok": c100, "meh": c50, "miss": miss }),
        1 => serde_json::json!({ "great": c300, "ok": c100, "miss": miss }),
        2 => serde_json::json!({ "great": c300, "large_tick_hit": c100, "small_tick_hit": c50, "small_tick_miss": katu, "miss": miss }),
        _ => serde_json::json!({ "great": c300, "ok": c100, "meh": c50, "miss": miss }),
    }
}

/// stable's accuracy from its counts (replays without lazer's info)
fn legacy_accuracy(h: &Header) -> f64 {
    let [c300, c100, c50, geki, katu, miss] = h.counts.map(|c| c as f64);
    let (hit, all) = match h.mode {
        3 => ((geki + c300) * 300.0 + katu * 200.0 + c100 * 100.0 + c50 * 50.0, (geki + c300 + katu + c100 + c50 + miss) * 300.0),
        1 => (c300 + c100 * 0.5, c300 + c100 + miss),
        2 => (c300 + c100 + c50, c300 + c100 + c50 + katu + miss),
        _ => (c300 * 300.0 + c100 * 100.0 + c50 * 50.0, (c300 + c100 + c50 + miss) * 300.0),
    };
    if all > 0.0 {
        hit / all
    } else {
        0.0
    }
}

// ── the library's side ──────────────────────────────────────────────────────

/// Fills in the difficulty and the best accuracy on it before this play.
pub fn with_library(conn: &Connection, mut p: LivePlay) -> Result<LivePlay> {
    let found = conn
        .query_row(
            "SELECT m.id, s.title, s.artist, m.version, s.id, s.online_id, m.sr, m.length
             FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = ?1 ORDER BY s.source = 'stable' LIMIT 1",
            [&p.md5],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<f64>>(6)?,
                    r.get::<_, Option<f64>>(7)?,
                ))
            },
        )
        .optional()?;
    if let Some((map, title, artist, version, set, set_online, stars, length)) = found {
        p.map = Some(map);
        p.title = title;
        p.artist = artist;
        p.version = version;
        p.set = Some(set);
        p.set_online = set_online.filter(|&v| v > 0);
        p.stars = stars;
        p.length = length;
    }
    let player = crate::osu_scores::Player::detect(conn)?;
    let lazer_best: Option<f64> = conn
        .query_row(
            &format!("SELECT MAX(accuracy) FROM scores WHERE map_md5 = ?2 AND date < ?3 - 2000 AND {}", player.sql()),
            params![player.param(), p.md5, p.date],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let live_best: Option<f64> = conn
        .query_row("SELECT MAX(accuracy) FROM live_plays WHERE md5 = ?1 AND date < ?2 AND id != ?3", params![p.md5, p.date, p.id], |r| r.get(0))
        .optional()?
        .flatten();
    p.best_before = match (lazer_best, live_best) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    Ok(p)
}

/// Keeps a play (once).
pub fn store(conn: &Connection, p: &LivePlay) -> Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO live_plays (id, md5, mode, player, date, accuracy, rank, score, combo, mods, rate, statistics, maximum_statistics)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            p.id,
            p.md5,
            p.mode,
            p.player,
            p.date,
            p.accuracy,
            p.rank,
            p.score,
            p.combo,
            serde_json::to_string(&p.mods)?,
            p.rate,
            p.statistics.to_string(),
            p.maximum_statistics.to_string()
        ],
    )?;
    Ok(n > 0)
}

/// The plays since `since` (unix ms), newest first, with their difficulties.
pub fn since(conn: &Connection, since: i64) -> Result<Vec<LivePlay>> {
    let mut st = conn.prepare(
        "SELECT id, md5, mode, player, date, accuracy, rank, score, combo, mods, rate, statistics, maximum_statistics
         FROM live_plays WHERE date >= ?1 ORDER BY date DESC LIMIT 500",
    )?;
    let rows: Vec<LivePlay> = st
        .query_map([since], |r| {
            let mods: String = r.get(9)?;
            let stats: String = r.get(11)?;
            let max: String = r.get(12)?;
            Ok(LivePlay {
                id: r.get(0)?,
                md5: r.get(1)?,
                mode: r.get(2)?,
                player: r.get(3)?,
                date: r.get(4)?,
                accuracy: r.get(5)?,
                rank: r.get(6)?,
                score: r.get(7)?,
                combo: r.get(8)?,
                mods: serde_json::from_str(&mods).unwrap_or_default(),
                rate: r.get(10)?,
                statistics: serde_json::from_str(&stats).unwrap_or(Value::Null),
                maximum_statistics: serde_json::from_str(&max).unwrap_or(Value::Null),
                map: None,
                title: None,
                artist: None,
                version: None,
                set: None,
                set_online: None,
                stars: None,
                length: None,
                best_before: None,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter().map(|p| with_library(conn, p)).collect()
}

/// One play by its id.
pub fn get(conn: &Connection, id: &str) -> Result<Option<LivePlay>> {
    let date: Option<i64> = conn.query_row("SELECT date FROM live_plays WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(date) = date else { return Ok(None) };
    Ok(since(conn, date)?.into_iter().find(|p| p.id == id))
}

// ── a pool to work through (the companion window) ───────────────────────────

/// A collection that can be a pool: Fumen's own (not smart ones) and lazer's / stable's.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolChoice {
    /// "f:<id>" for Fumen's, "l:<id>" for lazer's and stable's
    pub id: String,
    pub name: String,
    /// "fumen", "lazer" or "stable"
    pub source: String,
    pub count: i64,
}

/// One difficulty of the pool.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolRow {
    pub md5: String,
    pub map: Option<String>,
    pub title: Option<String>,
    pub version: Option<String>,
    pub stars: Option<f64>,
    /// passed since the session began
    pub plays: i64,
    /// the best accuracy since the session began
    pub best_now: Option<f64>,
    /// the best accuracy ever (lazer's scores and Fumen's plays)
    pub best: Option<f64>,
}

pub fn pool_choices(conn: &Connection) -> Result<Vec<PoolChoice>> {
    let mut out = Vec::new();
    let mut st = conn.prepare(
        "SELECT c.id, c.name, (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id)
         FROM collections c WHERE c.query IS NULL ORDER BY c.position, c.created",
    )?;
    for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
        let (id, name, count) = r?;
        out.push(PoolChoice { id: format!("f:{id}"), name, source: "fumen".into(), count });
    }
    let mut st = conn.prepare(
        "SELECT c.id, c.name, c.source, (SELECT COUNT(*) FROM lazer_collection_items i WHERE i.collection_id = c.id)
         FROM lazer_collections c ORDER BY c.source, c.position",
    )?;
    for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))? {
        let (id, name, source, count) = r?;
        out.push(PoolChoice { id: format!("l:{id}"), name, source, count });
    }
    Ok(out)
}

/// A pool's difficulties, in the collection's order, with how they went since `since` (unix ms).
pub fn pool(conn: &Connection, id: &str, since: i64) -> Result<Vec<PoolRow>> {
    let md5s: Vec<String> = if let Some(id) = id.strip_prefix("f:") {
        let mut st = conn.prepare("SELECT md5 FROM collection_items WHERE collection_id = ?1 ORDER BY added, rowid")?;
        let v = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        v
    } else if let Some(id) = id.strip_prefix("l:") {
        let mut st = conn.prepare("SELECT md5 FROM lazer_collection_items WHERE collection_id = ?1 ORDER BY position")?;
        let v = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        v
    } else {
        Vec::new()
    };
    let player = crate::osu_scores::Player::detect(conn)?;
    let mut map = conn.prepare(
        "SELECT m.id, s.title, m.version, m.sr FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = ?1 ORDER BY s.source = 'stable' LIMIT 1",
    )?;
    let mut lazer = conn.prepare(&format!(
        "SELECT MAX(accuracy), SUM(date >= ?3), MAX(CASE WHEN date >= ?3 THEN accuracy END) FROM scores WHERE map_md5 = ?2 AND {}",
        player.sql()
    ))?;
    let mut live = conn.prepare("SELECT MAX(accuracy), SUM(date >= ?2), MAX(CASE WHEN date >= ?2 THEN accuracy END) FROM live_plays WHERE md5 = ?1")?;
    let mut out = Vec::with_capacity(md5s.len());
    for md5 in md5s {
        let found = map
            .query_row([&md5], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<f64>>(3)?)))
            .optional()?;
        let (lb, ln, lnow): (Option<f64>, Option<i64>, Option<f64>) = lazer.query_row(params![player.param(), md5, since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let (vb, vn, vnow): (Option<f64>, Option<i64>, Option<f64>) = live.query_row(params![md5, since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let max = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        // a play Fumen saw is in lazer's scores too after the next import: the bigger count of the two
        let plays = ln.unwrap_or(0).max(vn.unwrap_or(0));
        let (map, title, version, stars) = match found {
            Some((m, t, v, s)) => (Some(m), t, v, s),
            None => (None, None, None, None),
        };
        out.push(PoolRow { md5, map, title, version, stars, plays, best_now: max(lnow, vnow), best: max(lb, vb) });
    }
    Ok(out)
}

// ── watching lazer's files ──────────────────────────────────────────────────

/// Whether a path in lazer's files/ is a finished file (named by its SHA-256, no extension).
fn is_lazer_file(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether the first bytes look like an `.osr`: a ruleset, a version from osu!'s years, a string.
fn looks_like_osr(head: &[u8]) -> bool {
    if head.len() < 6 || head[0] > 3 {
        return false;
    }
    let version = i32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    (20_000_000..40_000_000).contains(&version) && (head[5] == 0x0b || head[5] == 0)
}

/// Reads a file that just appeared in lazer's files/: the play, when it's a fresh replay.
pub fn read_new(path: &Path, now: i64) -> Option<LivePlay> {
    use std::io::Read;
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_REPLAY || meta.len() < 64 {
        return None;
    }
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 6];
    f.read_exact(&mut head).ok()?;
    if !looks_like_osr(&head) {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let h = crate::replay::header(&bytes).ok()?;
    if (now - h.date).abs() > FRESH {
        return None;
    }
    let id = path.file_name()?.to_str()?.to_ascii_lowercase();
    Some(play_of(&id, &h))
}

/// Watches lazer's files/ until the returned watcher is dropped; `found` gets every fresh play.
pub fn watch(storage: &Path, found: impl Fn(LivePlay) + Send + 'static) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let files = storage.join("files");
    if !files.is_dir() {
        return None;
    }
    let (tx, rx) = mpsc::channel::<PathBuf>();
    let mut watcher = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        if let Ok(ev) = ev {
            if matches!(ev.kind, notify::EventKind::Create(_) | notify::EventKind::Modify(_)) {
                for p in ev.paths {
                    if is_lazer_file(&p) {
                        let _ = tx.send(p);
                    }
                }
            }
        }
    })
    .ok()?;
    watcher.watch(&files, RecursiveMode::Recursive).ok()?;
    std::thread::spawn(move || {
        // path → (last seen size, since when)
        let mut waiting: HashMap<PathBuf, (u64, Instant)> = HashMap::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(p) => {
                    let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                    waiting.insert(p, (size, Instant::now()));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // the watcher is gone
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            let ready: Vec<PathBuf> = waiting.iter().filter(|(_, (_, at))| at.elapsed() >= SETTLE).map(|(p, _)| p.clone()).collect();
            for p in ready {
                let size = waiting.remove(&p).map(|(s, _)| s).unwrap_or(0);
                let now_size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                if now_size != size {
                    // still being written
                    waiting.insert(p, (now_size, Instant::now()));
                    continue;
                }
                if let Some(play) = read_new(&p, crate::lazer::now_ms()) {
                    found(play);
                }
            }
            if waiting.len() > 10_000 {
                waiting.clear();
            }
        }
    });
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accuracy_like_lazer() {
        // osu!mania: Perfect 305, Great 300 … out of 305 each
        let a = accuracy(3, &json!({ "perfect": 8, "great": 2, "miss": 0 }), &json!({ "perfect": 10 })).unwrap();
        assert!((a - (8.0 * 305.0 + 2.0 * 300.0) / 3050.0).abs() < 1e-9);
        // osu!taiko: an Ok is half a Great
        assert_eq!(accuracy(1, &json!({ "great": 1, "ok": 1 }), &json!({ "great": 2 })), Some(0.75));
        // osu!catch: everything caught counts the same
        assert_eq!(accuracy(2, &json!({ "great": 1, "large_tick_hit": 1, "small_tick_miss": 2 }), &json!({ "great": 1, "large_tick_hit": 1, "small_tick_hit": 2 })), Some(0.5));
        // bonus doesn't count
        assert_eq!(accuracy(0, &json!({ "great": 2, "large_bonus": 5 }), &json!({ "great": 2, "large_bonus": 5 })), Some(1.0));
    }

    #[test]
    fn ranks_and_mods() {
        assert_eq!(rank_of(&json!("SH")), Some("SH".into()));
        assert_eq!(rank_of(&json!(5)), Some("SH".into()));
        assert_eq!(rank_of(&json!(-1)), Some("F".into()));
        assert_eq!(rank_of(&json!("nope")), None);
        let mut h = Header { mode: 3, version: 20240101, beatmap_md5: String::new(), player: String::new(), counts: [0; 6], score: 0, combo: 0, mods: 64 | 512 | 8, date: 0, lazer: None };
        assert_eq!(mods_of(&h), (vec!["HD".to_string(), "NC".to_string()], Some(1.5)));
        h.lazer = Some(json!({ "mods": [{ "acronym": "HT", "settings": { "speed_change": 0.8 } }, { "acronym": "MR" }] }));
        assert_eq!(mods_of(&h), (vec!["HT".to_string(), "MR".to_string()], Some(0.8)));
    }

    /// a lazer replay (.osr) with lazer's score info, played `date` (unix ms)
    pub(crate) fn osr(md5: &str, date: i64, stats: &Value, max: &Value) -> Vec<u8> {
        use std::io::Cursor;
        let pack = |b: &[u8]| {
            let mut out = Vec::new();
            lzma_rs::lzma_compress(&mut Cursor::new(b), &mut out).unwrap();
            out
        };
        let s = |b: &mut Vec<u8>, v: &str| {
            b.push(0x0b);
            b.push(v.len() as u8);
            b.extend(v.as_bytes());
        };
        let mut b = vec![3u8];
        b.extend(30000016i32.to_le_bytes());
        s(&mut b, md5);
        s(&mut b, "Someone");
        b.push(0);
        b.extend([0u8; 12]);
        b.extend(900_000i32.to_le_bytes());
        b.extend(321u16.to_le_bytes());
        b.push(0);
        b.extend(0i32.to_le_bytes());
        b.push(0);
        b.extend((date * 10_000 + 621_355_968_000_000_000).to_le_bytes());
        let frames = pack(b"0|0|0|0,10|1|0|0,");
        b.extend((frames.len() as i32).to_le_bytes());
        b.extend(&frames);
        b.extend(0i64.to_le_bytes());
        let info = pack(json!({ "mods": [{ "acronym": "DT", "settings": { "speed_change": 1.2 } }], "statistics": stats, "maximum_statistics": max, "rank": "S" }).to_string().as_bytes());
        b.extend((info.len() as i32).to_le_bytes());
        b.extend(&info);
        b
    }

    #[test]
    fn reads_a_lazer_replay() {
        let now = 1_790_000_000_000;
        let b = osr("abc", now, &json!({ "perfect": 9, "great": 1 }), &json!({ "perfect": 10 }));
        let h = crate::replay::header(&b).unwrap();
        assert_eq!(h.date, now);
        let p = play_of("f00d", &h);
        assert_eq!((p.md5.as_str(), p.rank.as_deref(), p.rate, p.combo), ("abc", Some("S"), Some(1.2), 321));
        assert!((p.accuracy - (9.0 * 305.0 + 300.0) / 3050.0).abs() < 1e-9);
        assert_eq!(crate::replay::parse(&b).unwrap().frames, vec![0.0, 0.0, 0.0, 0.0, 10.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn plays_pools_and_bests() {
        let dir = std::env::temp_dir().join(format!("fumen-live-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO sets (id, source, title, artist) VALUES ('s1', 'lazer', 'Song', 'Band');
             INSERT INTO maps (id, set_id, md5, version, sr, length) VALUES ('m1', 's1', 'aaa', 'Hard', 4.5, 120000), ('m2', 's1', 'bbb', 'Easy', 2.0, 90000);
             INSERT INTO scores (id, map_md5, accuracy, date, user_id) VALUES ('x', 'aaa', 0.95, 1000, 7);
             INSERT INTO meta (key, value) VALUES ('osu.user', '7');
             INSERT INTO collections (id, name, created, position) VALUES ('c1', 'Pool', 1, 0);
             INSERT INTO collection_items (collection_id, md5, added) VALUES ('c1', 'aaa', 1), ('c1', 'bbb', 2), ('c1', 'zzz', 3);",
        )
        .unwrap();
        let h = crate::replay::header(&osr("aaa", 5000, &json!({ "perfect": 10 }), &json!({ "perfect": 10 }))).unwrap();
        let p = play_of("p1", &h);
        assert!(store(&conn, &p).unwrap());
        assert!(!store(&conn, &p).unwrap(), "once");
        let got = since(&conn, 0).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].map.as_deref(), got[0].title.as_deref(), got[0].version.as_deref(), got[0].best_before), (Some("m1"), Some("Song"), Some("Hard"), Some(0.95)));
        let choices = pool_choices(&conn).unwrap();
        assert_eq!((choices[0].id.as_str(), choices[0].count), ("f:c1", 3));
        let rows = pool(&conn, "f:c1", 4000).unwrap();
        assert_eq!(rows.iter().map(|r| (r.md5.as_str(), r.plays, r.best_now, r.best)).collect::<Vec<_>>(), vec![
            ("aaa", 1, Some(1.0), Some(1.0)),
            ("bbb", 0, None, None),
            ("zzz", 0, None, None),
        ]);
        assert_eq!(rows[2].map, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_replay_in_lazers_files_is_a_play() {
        let dir = std::env::temp_dir().join(format!("fumen-live-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("files").join("a").join("ab")).unwrap();
        let (tx, rx) = mpsc::channel();
        let _w = watch(&dir, move |p| {
            let _ = tx.send(p);
        })
        .unwrap();
        let now = crate::lazer::now_ms();
        let name = |c: char| std::iter::repeat_n(c, 64).collect::<String>();
        // an old replay (downloaded, say), a png, then a play: only the play counts
        std::fs::write(dir.join("files/a/ab").join(name('a')), osr("old", now - 3_600_000, &json!({}), &json!({}))).unwrap();
        std::fs::write(dir.join("files/a/ab").join(name('b')), [&[0x89u8, b'P', b'N', b'G'][..], &[0u8; 80][..]].concat()).unwrap();
        std::fs::write(dir.join("files/a/ab").join(name('c')), osr("new", now, &json!({ "perfect": 1 }), &json!({ "perfect": 1 }))).unwrap();
        let p = rx.recv_timeout(Duration::from_secs(10)).expect("the play");
        assert_eq!((p.md5.as_str(), p.id.as_str()), ("new", name('c').as_str()));
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err(), "nothing else");
        drop(_w);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_osr_files_are_read() {
        assert!(looks_like_osr(&[3, 0x31, 0xd4, 0xcb, 0x01, 0x0b]));
        assert!(!looks_like_osr(b"\x89PNG\r\n"));
        assert!(!looks_like_osr(b"osu fi"));
        assert!(is_lazer_file(Path::new("files/a/ab/abababababababababababababababababababababababababababababababab")));
        assert!(!is_lazer_file(Path::new("files/a/ab/abab.__safe")));
    }
}

#[cfg(test)]
mod real {
    use super::*;

    /// lazer's own accuracy and rank of the newest scores (a sidecar export: FUMEN_LIVE_EXPORT)
    /// against Fumen's, from their replays in lazer's files (read only). Run by hand:
    ///   cargo test --lib live::real -- --ignored --nocapture
    #[test]
    #[ignore]
    fn accuracy_matches_lazers() {
        let storage = PathBuf::from(std::env::var("APPDATA").unwrap()).join("osu");
        let export: Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("FUMEN_LIVE_EXPORT").unwrap()).unwrap()).unwrap();
        let mut scores: Vec<&Value> = export["scores"].as_array().unwrap().iter().filter(|s| s["replay"].is_string()).collect();
        scores.sort_by_key(|s| -s["date"].as_i64().unwrap_or(0));
        let (mut ok, mut off, mut lazer, mut ranks, mut dates) = (0, 0, 0, 0, 0);
        for s in scores.iter().take(600) {
            let Some(path) = crate::paths::lazer_file(&storage, s["replay"].as_str().unwrap()) else { continue };
            let Ok(bytes) = std::fs::read(path) else { continue };
            let Ok(h) = crate::replay::header(&bytes) else { continue };
            if h.lazer.is_some() {
                lazer += 1;
                if lazer == 1 {
                    println!("lazer info: {}", h.lazer.as_ref().unwrap());
                }
            }
            let p = play_of("x", &h);
            let acc = s["accuracy"].as_f64().unwrap_or(-1.0);
            if (p.accuracy - acc).abs() < 0.00005 {
                ok += 1;
            } else {
                off += 1;
                if off <= 8 {
                    println!("{}: lazer {acc:.5} here {:.5} {} / {}", s["ruleset"], p.accuracy, p.statistics, p.maximum_statistics);
                }
            }
            if s["rank"].as_i64().and_then(|r| RANKS.get((r + 1) as usize)).copied() == p.rank.as_deref() {
                ranks += 1;
            }
            if (s["date"].as_i64().unwrap_or(0) - p.date).abs() < 120_000 {
                dates += 1;
            }
        }
        println!("{ok} match, {off} off, {lazer} with lazer's info, {ranks} ranks match, {dates} dates within 2 min");
    }
}
