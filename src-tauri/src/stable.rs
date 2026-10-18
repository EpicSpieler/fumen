//! osu!stable as a source: its `osu!.db` (every difficulty with its metadata), the files in its
//! Songs folder, its `collection.db` and its `scores.db` (the plays on this computer, into the
//! history as lazer would have them). Read only — Fumen never writes stable's files, except the one opt-in exception in
//! `stable_import.rs` (downloaded sets into the Songs folder).
//!
//! stable's sets go into the same tables as lazer's (`sets.source = 'stable'`). lazer keeps files
//! by content hash; stable keeps them by name, so each file Fumen needs (charts, audio,
//! backgrounds, hit sounds, storyboards) gets a key made from its path, size and modification
//! time (`file_key`) and the key → path table `stable_files`. A changed file gets a new key on the
//! next scan, so keys behave like lazer's hashes: caches by key never go stale.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db;
use crate::error::{Error, Result};
use crate::paths::StableInstall;

/// From this version on, osu!.db entries no longer start with their size.
const NO_ENTRY_SIZE: i32 = 20191106;
/// Before this version, AR/CS/HP/OD are bytes and there are no star ratings.
const SINGLE_DIFFICULTY: i32 = 20140609;

fn bad(what: &str) -> Error {
    Error::known("stable-format", format!("osu!stable's {what} couldn't be read (an unknown version, or damaged)."))
}

// ── reading stable's databases ──────────────────────────────────────────

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
    what: &'static str,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8], what: &'static str) -> Self {
        Reader { b, at: 0, what }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).filter(|e| *e <= self.b.len()).ok_or_else(|| bad(self.what))?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn bool(&mut self) -> Result<bool> {
        Ok(self.u8()? != 0)
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    /// 0x00 (none) or 0x0b, the UTF-8 length as ULEB128, the bytes.
    fn string(&mut self) -> Result<String> {
        match self.u8()? {
            0x00 => Ok(String::new()),
            0x0b => {
                let (mut len, mut shift) = (0usize, 0u32);
                loop {
                    let b = self.u8()?;
                    len |= ((b & 0x7f) as usize).checked_shl(shift).ok_or_else(|| bad(self.what))?;
                    if b & 0x80 == 0 {
                        break;
                    }
                    shift += 7;
                    if shift > 28 {
                        return Err(bad(self.what));
                    }
                }
                Ok(String::from_utf8_lossy(self.take(len)?).into_owned())
            }
            _ => Err(bad(self.what)),
        }
    }

    /// The size of a count-prefixed list, sane for what's left of the file.
    fn count(&mut self, min_item: usize) -> Result<usize> {
        let n = self.i32()?;
        if n < 0 || (n as usize).saturating_mul(min_item) > self.b.len() - self.at {
            return Err(bad(self.what));
        }
        Ok(n as usize)
    }
}

/// .NET ticks (100 ns since 0001-01-01) → Unix ms; None for "never".
fn ticks_ms(ticks: i64) -> Option<i64> {
    const UNIX_TICKS: i64 = 621_355_968_000_000_000;
    (ticks > UNIX_TICKS).then(|| (ticks - UNIX_TICKS) / 10_000)
}

// ── scores.db ───────────────────────────────────────────────────────────

/// From this version on, a score's online id is 8 bytes (4 before).
const LONG_SCORE_ID: i32 = 20140721;

/// One play in stable's scores.db (stable keeps passes only).
#[derive(Debug, Clone, PartialEq)]
pub struct DbScore {
    pub mode: u8,
    pub md5: String,
    pub player: String,
    pub replay_md5: String,
    /// 300, 100, 50, geki, katu, miss
    pub hits: [u16; 6],
    pub score: i32,
    pub combo: u16,
    /// stable's mod bits
    pub mods: i32,
    /// Unix ms
    pub date: Option<i64>,
    pub online_id: i64,
}

pub fn read_scores_db(b: &[u8]) -> Result<Vec<DbScore>> {
    let mut r = Reader::new(b, "scores.db");
    let _version = r.i32()?;
    let maps = r.count(2)?;
    let mut out = Vec::new();
    for _ in 0..maps {
        let _md5 = r.string()?;
        for _ in 0..r.count(40)? {
            let mode = r.u8()?;
            let version = r.i32()?;
            let md5 = r.string()?;
            let player = r.string()?;
            let replay_md5 = r.string()?;
            let mut hits = [0u16; 6];
            for h in &mut hits {
                *h = r.u16()?;
            }
            let score = r.i32()?;
            let combo = r.u16()?;
            let _perfect = r.bool()?;
            let mods = r.i32()?;
            let _life = r.string()?;
            let date = ticks_ms(r.i64()?);
            let _replay_size = r.i32()?;
            let online_id = if version >= LONG_SCORE_ID { r.i64()? } else { r.i32()? as i64 };
            // target practice: how much of the targets were hit
            if mods & (1 << 23) != 0 {
                r.f64()?;
            }
            out.push(DbScore { mode, md5, player, replay_md5, hits, score, combo, mods, date, online_id });
        }
    }
    Ok(out)
}

/// stable's mod bits as lazer names them (NC and PF stand alone, without DT and SD).
const MOD_BITS: [(i32, &str); 31] = [
    (1, "NF"), (2, "EZ"), (4, "TD"), (8, "HD"), (16, "HR"), (32, "SD"), (64, "DT"), (128, "RX"), (256, "HT"),
    (512, "NC"), (1024, "FL"), (2048, "AT"), (4096, "SO"), (8192, "AP"), (16384, "PF"), (1 << 15, "4K"),
    (1 << 16, "5K"), (1 << 17, "6K"), (1 << 18, "7K"), (1 << 19, "8K"), (1 << 20, "FI"), (1 << 21, "RD"),
    (1 << 22, "CN"), (1 << 23, "TP"), (1 << 24, "9K"), (1 << 25, "DS"), (1 << 26, "1K"), (1 << 27, "3K"),
    (1 << 28, "2K"), (1 << 29, "SV2"), (1 << 30, "MR"),
];

impl DbScore {
    /// Fumen's id for it (lazer's are GUIDs: never the same)
    fn id(&self) -> String {
        if self.replay_md5.is_empty() {
            format!("st-{}-{}", self.md5, self.date.unwrap_or(0))
        } else {
            format!("st-{}", self.replay_md5)
        }
    }

    /// Accuracy (0–1) the way stable works it out for the ruleset.
    pub fn accuracy(&self) -> f64 {
        let [n300, n100, n50, geki, katu, miss] = self.hits.map(f64::from);
        let ratio = |hit: f64, all: f64| if all > 0.0 { hit / all } else { 1.0 };
        match self.mode {
            1 => ratio(n300 + 0.5 * n100, n300 + n100 + miss),
            2 => ratio(n300 + n100 + n50, n300 + n100 + n50 + katu + miss),
            3 => ratio(300.0 * (n300 + geki) + 200.0 * katu + 100.0 * n100 + 50.0 * n50, 300.0 * (n300 + geki + katu + n100 + n50 + miss)),
            _ => ratio(300.0 * n300 + 100.0 * n100 + 50.0 * n50, 300.0 * (n300 + n100 + n50 + miss)),
        }
    }

    /// stable's grade, as lazer's ScoreRank (0 D … 4 S, 5 S silver, 6 SS, 7 SS silver).
    pub fn rank(&self) -> i64 {
        let acc = self.accuracy();
        let [n300, n100, n50, _, _, miss] = self.hits.map(f64::from);
        let by_acc = |s: f64, a: f64, b: f64, c: f64| if acc >= 1.0 { 6 } else if acc > s { 4 } else if acc > a { 3 } else if acc > b { 2 } else if acc > c { 1 } else { 0 };
        let grade = match self.mode {
            2 => by_acc(0.98, 0.94, 0.90, 0.85),
            3 => by_acc(0.95, 0.90, 0.80, 0.70),
            _ => {
                let all = n300 + n100 + n50 + miss;
                let (r300, r50) = if all > 0.0 { (n300 / all, n50 / all) } else { (1.0, 0.0) };
                if r300 >= 1.0 {
                    6
                } else if r300 > 0.9 && r50 <= 0.01 && miss == 0.0 {
                    4
                } else if (r300 > 0.8 && miss == 0.0) || r300 > 0.9 {
                    3
                } else if (r300 > 0.7 && miss == 0.0) || r300 > 0.8 {
                    2
                } else if r300 > 0.6 {
                    1
                } else {
                    0
                }
            }
        };
        let silver = self.mods & (8 | 1024) != 0 || (self.mode == 3 && self.mods & (1 << 20) != 0);
        if silver && (grade == 4 || grade == 6) { grade + 1 } else { grade }
    }

    /// The judgement counts as lazer keeps them for the ruleset (lazer's legacy score import).
    pub fn statistics(&self) -> serde_json::Value {
        let [n300, n100, n50, geki, katu, miss] = self.hits;
        let pairs: Vec<(&str, u16)> = match self.mode {
            1 => vec![("great", n300), ("ok", n100), ("miss", miss)],
            2 => vec![("great", n300), ("large_tick_hit", n100), ("small_tick_hit", n50), ("small_tick_miss", katu), ("miss", miss)],
            3 => vec![("perfect", geki), ("great", n300), ("good", katu), ("ok", n100), ("meh", n50), ("miss", miss)],
            _ => vec![("great", n300), ("ok", n100), ("meh", n50), ("miss", miss)],
        };
        serde_json::Value::Object(pairs.into_iter().filter(|(_, n)| *n > 0).map(|(k, n)| (k.to_string(), n.into())).collect())
    }

    /// The mods as lazer's JSON; like lazer's import of stable's scores, with Classic.
    pub fn mods_json(&self) -> serde_json::Value {
        let m = self.mods;
        let mut list: Vec<serde_json::Value> = MOD_BITS
            .iter()
            .filter(|(bit, a)| m & bit != 0 && !(*a == "DT" && m & 512 != 0) && !(*a == "SD" && m & 16384 != 0))
            .map(|(_, a)| serde_json::json!({ "acronym": a }))
            .collect();
        list.push(serde_json::json!({ "acronym": "CL" }));
        serde_json::Value::Array(list)
    }
}

/// What tells a changed scores.db: its size and modification time ("" without one).
fn scores_db_stamp(install: &StableInstall) -> String {
    std::fs::metadata(Path::new(&install.path).join("scores.db")).map_or(String::new(), |m| format!("{}:{}", m.len(), modified_ns(&m)))
}

/// One difficulty in osu!.db.
#[derive(Debug, Clone, PartialEq)]
pub struct DbMap {
    pub artist: String,
    pub artist_unicode: String,
    pub title: String,
    pub title_unicode: String,
    pub creator: String,
    pub version: String,
    pub audio: String,
    pub md5: String,
    pub file: String,
    /// stable's: 0 unknown, 1 unsubmitted, 2 pending / WIP / graveyard, 4 ranked, 5 approved,
    /// 6 qualified, 7 loved
    pub status: u8,
    pub circles: u16,
    pub sliders: u16,
    pub spinners: u16,
    /// Unix ms
    pub modified: Option<i64>,
    pub ar: f32,
    pub cs: f32,
    pub hp: f32,
    pub od: f32,
    /// no-mod star rating in the difficulty's own mode
    pub stars: Option<f64>,
    /// ms
    pub total_time: i32,
    pub preview: i32,
    /// beats per minute (the beat length that lasts longest, as lazer counts it)
    pub bpm: f64,
    pub map_id: i32,
    pub set_id: i32,
    pub mode: u8,
    pub source: String,
    pub tags: String,
    /// Unix ms
    pub last_played: Option<i64>,
    pub folder: String,
}

#[allow(dead_code)] // version and player: for diagnostics
pub struct OsuDb {
    pub version: i32,
    pub player: String,
    pub maps: Vec<DbMap>,
}

/// The beat length that lasts longest (to the next uninherited point, the last one to `end`).
fn main_bpm(points: &[(f64, f64)], end: f64) -> f64 {
    let mut lengths: Vec<(f64, f64)> = Vec::new();
    for (i, &(beat, start)) in points.iter().enumerate() {
        if !(beat.is_finite() && beat > 0.0) {
            continue;
        }
        let until = points.get(i + 1).map_or(end, |p| p.1).max(start);
        let len = (beat * 1000.0).round() / 1000.0;
        match lengths.iter_mut().find(|(b, _)| *b == len) {
            Some((_, d)) => *d += until - start,
            None => lengths.push((len, until - start)),
        }
    }
    let best = lengths.iter().fold(None::<(f64, f64)>, |acc, &(b, d)| match acc {
        Some((_, bd)) if bd >= d => acc,
        _ => Some((b, d)),
    });
    best.map_or(0.0, |(b, _)| 60_000.0 / b)
}

pub fn read_osu_db(bytes: &[u8]) -> Result<OsuDb> {
    let mut r = Reader::new(bytes, "osu!.db");
    let version = r.i32()?;
    let _folders = r.i32()?;
    let _unlocked = r.bool()?;
    let _unlock_date = r.i64()?;
    let player = r.string()?;
    let n = r.count(40)?;
    let mut maps = Vec::with_capacity(n);
    for _ in 0..n {
        let start = r.at;
        let size = if version < NO_ENTRY_SIZE { Some(r.i32()? as usize) } else { None };
        let entry = r.at;
        let m = read_map(&mut r, version)?;
        if let Some(size) = size {
            // trust the size over the fields: what's left of an entry is skipped
            if r.at > entry + size {
                return Err(bad("osu!.db"));
            }
            r.at = entry + size;
        }
        debug_assert!(r.at > start);
        maps.push(m);
    }
    Ok(OsuDb { version, player, maps })
}

fn read_map(r: &mut Reader, version: i32) -> Result<DbMap> {
    let (artist, artist_unicode, title, title_unicode) = (r.string()?, r.string()?, r.string()?, r.string()?);
    let (creator, diff, audio, md5, file) = (r.string()?, r.string()?, r.string()?, r.string()?, r.string()?);
    let status = r.u8()?;
    let (circles, sliders, spinners) = (r.u16()?, r.u16()?, r.u16()?);
    let modified = ticks_ms(r.i64()?);
    let mut stat = || -> Result<f32> { if version < SINGLE_DIFFICULTY { Ok(r.u8()? as f32) } else { r.f32() } };
    let (ar, cs, hp, od) = (stat()?, stat()?, stat()?, stat()?);
    let _slider_velocity = r.f64()?;
    let mut stars_by_mode: [Option<f64>; 4] = [None; 4];
    if version >= SINGLE_DIFFICULTY {
        for mode_stars in &mut stars_by_mode {
            let pairs = r.count(10)?;
            for _ in 0..pairs {
                if r.u8()? != 0x08 {
                    return Err(bad("osu!.db"));
                }
                let mods = r.i32()?;
                // floats since 20250107, doubles before: each pair says which
                let sr = match r.u8()? {
                    0x0c => r.f32()? as f64,
                    0x0d => r.f64()?,
                    _ => return Err(bad("osu!.db")),
                };
                if mods == 0 {
                    *mode_stars = Some(sr);
                }
            }
        }
    }
    let _drain = r.i32()?;
    let total_time = r.i32()?;
    let preview = r.i32()?;
    let points = r.count(17)?;
    let mut uninherited = Vec::new();
    for _ in 0..points {
        let (beat, offset, real) = (r.f64()?, r.f64()?, r.bool()?);
        if real {
            uninherited.push((beat, offset));
        }
    }
    let map_id = r.i32()?;
    let set_id = r.i32()?;
    let _thread = r.i32()?;
    r.take(4)?; // grades per mode
    let _local_offset = r.u16()?;
    let _stack_leniency = r.f32()?;
    let mode = r.u8()?;
    let source = r.string()?;
    let tags = r.string()?;
    let _online_offset = r.u16()?;
    let _font = r.string()?;
    let unplayed = r.bool()?;
    let last_played = ticks_ms(r.i64()?).filter(|_| !unplayed);
    let _osz2 = r.bool()?;
    let folder = r.string()?;
    let _checked = r.i64()?;
    r.take(5)?; // ignore sound / skin, disable storyboard / video, visual override
    if version < SINGLE_DIFFICULTY {
        r.take(2)?;
    }
    let _last_modification = r.i32()?;
    let _mania_scroll = r.u8()?;
    let bpm = main_bpm(&uninherited, total_time as f64);
    Ok(DbMap {
        artist,
        artist_unicode,
        title,
        title_unicode,
        creator,
        version: diff,
        audio,
        md5,
        file,
        status,
        circles,
        sliders,
        spinners,
        modified,
        ar,
        cs,
        hp,
        od,
        stars: stars_by_mode.get(mode as usize).copied().flatten(),
        total_time,
        preview,
        bpm,
        map_id,
        set_id,
        mode,
        source,
        tags,
        last_played,
        folder,
    })
}

/// stable's collection.db: (name, MD5s) per collection.
pub fn read_collection_db(bytes: &[u8]) -> Result<Vec<(String, Vec<String>)>> {
    let mut r = Reader::new(bytes, "collection.db");
    let _version = r.i32()?;
    let n = r.count(5)?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let name = r.string()?;
        let count = r.count(1)?;
        let md5s = (0..count).map(|_| r.string()).collect::<Result<Vec<_>>>()?;
        out.push((name, md5s));
    }
    Ok(out)
}

/// stable's ranked status as lazer's (-3 none, -2 graveyard, 0 pending, 1 ranked, 2 approved,
/// 3 qualified, 4 loved).
fn status(stable: u8) -> i64 {
    match stable {
        2 => 0,
        4 => 1,
        5 => 2,
        6 => 3,
        7 => 4,
        _ => -3,
    }
}

const RULESETS: [&str; 4] = ["osu", "taiko", "fruits", "mania"];

// ── files ───────────────────────────────────────────────────────────────

/// A file's key: 64 hex digits from its path in the Songs folder, size and modification time.
pub fn file_key(rel: &str, len: u64, modified_ns: u128) -> String {
    let data = format!("stable\0{}\0{len}\0{modified_ns}", rel.to_lowercase());
    (0u64..4)
        .map(|lane| {
            // FNV-1a, four lanes with their own starting points
            let mut h = 0xcbf2_9ce4_8422_2325u64 ^ lane.wrapping_mul(0x9e37_79b9_7f4a_7c15);
            for b in data.bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
            format!("{h:016x}")
        })
        .collect()
}

/// A path inside a set's folder as written in a chart: forward slashes, no way out of the folder.
fn clean_rel(name: &str) -> Option<String> {
    let name = name.trim().trim_matches('"').replace('\\', "/");
    let p = Path::new(&name);
    if name.is_empty() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(name)
}

/// The background named in a chart's [Events] (`0,0,"bg.jpg",0,0`), read only as far as needed.
fn background_of(osu: &Path) -> Option<String> {
    let file = std::fs::File::open(osu).ok()?;
    let mut in_events = false;
    for line in BufReader::new(file).split(b'\n').map_while(|l| l.ok()) {
        let line = String::from_utf8_lossy(&line);
        let line = line.trim();
        if line.starts_with('[') {
            if in_events {
                return None;
            }
            in_events = line.eq_ignore_ascii_case("[Events]");
            if !in_events && (line.eq_ignore_ascii_case("[TimingPoints]") || line.eq_ignore_ascii_case("[HitObjects]")) {
                return None;
            }
            continue;
        }
        if in_events {
            let mut parts = line.splitn(4, ',');
            let (kind, _start, file) = (parts.next()?.trim(), parts.next(), parts.next());
            if kind == "0" || kind.eq_ignore_ascii_case("Background") {
                return file.and_then(clean_rel);
            }
        }
    }
    None
}

const SOUND_EXTENSIONS: [&str; 5] = ["wav", "ogg", "mp3", "flac", "osb"];

/// What a set's folder holds that Fumen uses.
#[derive(Default)]
struct Folder {
    /// key → path in the Songs folder
    files: Vec<(String, String)>,
    /// sound files and storyboards: [name in the folder, key], like lazer's
    sounds: Vec<(String, String)>,
    /// per difficulty (in the set's order): the chart's key, its background's key, its audio's key
    maps: Vec<(Option<String>, Option<String>, Option<String>)>,
    /// per difficulty: the background its chart names, found or not
    bg_names: Vec<Option<String>>,
    /// Unix ms the folder was made
    created: Option<i64>,
}

fn modified_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())
}

fn scan_folder(songs: &Path, folder: &str, maps: &[&DbMap]) -> Option<Folder> {
    let folder = clean_rel(folder)?;
    let dir = songs.join(&folder);
    let meta = std::fs::metadata(&dir).ok().filter(|m| m.is_dir())?;
    let mut out = Folder {
        created: meta.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
        ..Folder::default()
    };
    let mut by_name: HashMap<String, String> = HashMap::new();
    let mut key_of = |rel_in_folder: &str, out: &mut Folder| -> Option<String> {
        let lower = rel_in_folder.to_lowercase();
        if let Some(k) = by_name.get(&lower) {
            return Some(k.clone());
        }
        let rel = format!("{folder}/{rel_in_folder}");
        let meta = std::fs::metadata(songs.join(&rel)).ok().filter(|m| m.is_file())?;
        let key = file_key(&rel, meta.len(), modified_ns(&meta));
        out.files.push((key.clone(), rel));
        by_name.insert(lower, key.clone());
        Some(key)
    };
    for e in std::fs::read_dir(&dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let ext = name.rsplit_once('.').map(|(_, x)| x.to_lowercase()).unwrap_or_default();
        if SOUND_EXTENSIONS.contains(&ext.as_str()) {
            if let Some(k) = key_of(&name, &mut out) {
                out.sounds.push((name, k));
            }
        }
    }
    for m in maps {
        let chart = clean_rel(&m.file).and_then(|f| key_of(&f, &mut out));
        let bg_name = clean_rel(&m.file).and_then(|f| background_of(&dir.join(f)));
        let bg = bg_name.as_deref().and_then(|b| key_of(b, &mut out));
        let audio = clean_rel(&m.audio).and_then(|a| key_of(&a, &mut out));
        out.maps.push((chart, bg, audio));
        out.bg_names.push(bg_name);
    }
    Some(out)
}

// ── import ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StableCounts {
    pub sets: usize,
    pub maps: usize,
    pub collections: usize,
    #[serde(default)]
    pub scores: usize,
}

/// Replaces the cached stable library with what's in `install` now, atomically. `progress`
/// gets (folders done, folders).
pub fn import(conn: &mut Connection, install: &StableInstall, progress: impl Fn(u64, u64) + Sync) -> Result<StableCounts> {
    let dir = Path::new(&install.path);
    let songs = Path::new(&install.songs);
    let osu_db = read_osu_db(&std::fs::read(dir.join("osu!.db"))?)?;

    // difficulties by folder, in osu!.db's order
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&DbMap>> = HashMap::new();
    for m in osu_db.maps.iter().filter(|m| !m.md5.is_empty() && !m.folder.is_empty()) {
        let key = m.folder.to_lowercase();
        groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Vec::new()
        });
        groups.get_mut(&key).unwrap().push(m);
    }

    // the folders, read in parallel (the disk is the bottleneck, not the parsing)
    let total = order.len() as u64;
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8);
    let mut folders: Vec<Option<Folder>> = (0..order.len()).map(|_| None).collect();
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(key) = order.get(i) else { break };
                        let maps = &groups[key];
                        out.push((i, scan_folder(songs, &maps[0].folder, maps)));
                        let d = done.fetch_add(1, Ordering::Relaxed) as u64 + 1;
                        if d % 50 == 0 || d == total {
                            progress(d, total);
                        }
                    }
                    out
                })
            })
            .collect();
        for h in handles {
            for (i, f) in h.join().unwrap_or_default() {
                folders[i] = f;
            }
        }
    });

    let collections = std::fs::read(dir.join("collection.db")).ok().map(|b| read_collection_db(&b)).transpose()?.unwrap_or_default();
    let scores = std::fs::read(dir.join("scores.db")).ok().map(|b| read_scores_db(&b)).transpose()?.unwrap_or_default();

    let mut counts = StableCounts::default();
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DELETE FROM sets WHERE source = 'stable';
         DELETE FROM lazer_collections WHERE source = 'stable';
         DELETE FROM stable_files;
         DELETE FROM scores WHERE id LIKE 'st-%';",
    )?;
    {
        let mut ins_set = tx.prepare(
            "INSERT OR IGNORE INTO sets (id, source, online_id, status, date_added, title, title_unicode, artist,
                artist_unicode, creator, source_text, tags, bg, audio, preview_time, sounds, folder)
             VALUES (?1, 'stable', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )?;
        let mut ins_map = tx.prepare(
            "INSERT OR IGNORE INTO maps (id, set_id, online_id, version, ruleset, ruleset_id, status, hash, md5,
                sr, bpm, length, objects, end_objects, last_played, last_update, hidden,
                hp, cs, od, ar, bg, audio, preview_time, audio_file, bg_file)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0,
                ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        )?;
        let mut ins_file = tx.prepare("INSERT OR IGNORE INTO stable_files (key, path) VALUES (?1, ?2)")?;

        for (key, folder) in order.iter().zip(&folders) {
            let Some(folder) = folder else { continue };
            let maps = &groups[key];
            let rep = maps.iter().find(|m| !m.title.is_empty()).unwrap_or(&maps[0]);
            let set_id = format!("st-{}", &file_key(key, 0, 0)[..32]);
            let most_common = |pick: fn(&(Option<String>, Option<String>, Option<String>)) -> &Option<String>| {
                let mut seen: Vec<(&String, usize)> = Vec::new();
                for v in folder.maps.iter().filter_map(|m| pick(m).as_ref()) {
                    match seen.iter_mut().find(|(k, _)| *k == v) {
                        Some((_, n)) => *n += 1,
                        None => seen.push((v, 1)),
                    }
                }
                seen.iter().fold(None::<(&String, usize)>, |acc, &(k, n)| match acc {
                    Some((_, an)) if an >= n => acc,
                    _ => Some((k, n)),
                })
                .map(|(k, _)| k.clone())
            };
            let bg = most_common(|m| &m.1);
            let audio = most_common(|m| &m.2);
            let preview = maps
                .iter()
                .zip(&folder.maps)
                .find(|(_, f)| f.2 == audio)
                .map(|(m, _)| m.preview)
                .filter(|p| *p >= 0);
            let added = folder.created.or_else(|| maps.iter().filter_map(|m| m.modified).min());
            ins_set.execute(params![
                set_id,
                Some(rep.set_id as i64).filter(|v| *v > 0),
                status(rep.status),
                added,
                rep.title,
                rep.title_unicode,
                rep.artist,
                rep.artist_unicode,
                rep.creator,
                rep.source,
                rep.tags,
                bg,
                audio,
                preview,
                serde_json::to_string(&folder.sounds)?,
                clean_rel(&maps[0].folder),
            ])?;
            counts.sets += 1;
            for (i, (m, (chart, mbg, maudio))) in maps.iter().zip(&folder.maps).enumerate() {
                let mode = m.mode.min(3) as usize;
                counts.maps += ins_map.execute(params![
                    format!("st-{}", m.md5),
                    set_id,
                    Some(m.map_id as i64).filter(|v| *v > 0),
                    m.version,
                    RULESETS[mode],
                    mode as i64,
                    status(m.status),
                    chart,
                    m.md5,
                    m.stars,
                    m.bpm,
                    m.total_time as f64,
                    m.circles as i64 + m.sliders as i64 + m.spinners as i64,
                    m.sliders as i64 + m.spinners as i64,
                    m.last_played,
                    m.modified,
                    m.hp,
                    m.cs,
                    m.od,
                    m.ar,
                    mbg,
                    maudio,
                    Some(m.preview as i64).filter(|p| *p >= 0),
                    Some(m.audio.trim().trim_matches('"')).filter(|s| !s.is_empty()),
                    folder.bg_names.get(i).cloned().flatten(),
                ])?;
            }
            for (k, rel) in &folder.files {
                ins_file.execute(params![k, rel])?;
            }
        }

        // the plays, as lazer keeps its own (copies lazer imported itself are left out when read)
        let mut ins_score = tx.prepare(
            "INSERT OR IGNORE INTO scores (id, map_md5, ruleset, total_score, accuracy, max_combo, rank, date, mods,
                statistics, online_id, legacy, user)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12)",
        )?;
        for s in scores.iter().filter(|s| !s.md5.is_empty() && s.mode < 4) {
            counts.scores += ins_score.execute(params![
                s.id(),
                s.md5,
                RULESETS[s.mode as usize],
                s.score as i64,
                s.accuracy(),
                s.combo as i64,
                s.rank(),
                s.date,
                s.mods_json().to_string(),
                s.statistics().to_string(),
                Some(s.online_id).filter(|v| *v > 0),
                Some(s.player.as_str()).filter(|p| !p.is_empty()),
            ])?;
        }

        let mut ins_col = tx.prepare("INSERT INTO lazer_collections (id, name, modified, position, source) VALUES (?1, ?2, NULL, ?3, 'stable')")?;
        let mut ins_item = tx.prepare("INSERT INTO lazer_collection_items (collection_id, md5, position) VALUES (?1, ?2, ?3)")?;
        for (pos, (name, md5s)) in collections.iter().enumerate() {
            let id = format!("st-col-{pos}");
            ins_col.execute(params![id, if name.is_empty() { "Collection" } else { name }, pos as i64])?;
            for (i, h) in md5s.iter().enumerate() {
                ins_item.execute(params![id, h, i as i64])?;
            }
            counts.collections += 1;
        }
    }
    db::set_meta(&tx, "stable.path", &install.path)?;
    db::set_meta(&tx, "stable.songs", &install.songs)?;
    db::set_meta(&tx, "stable.dbSize", &install.db_size.to_string())?;
    db::set_meta(&tx, "stable.dbModified", &install.db_modified.to_string())?;
    db::set_meta(&tx, "stable.lastScan", &crate::lazer::now_ms().to_string())?;
    db::set_meta(&tx, "stable.counts", &serde_json::to_string(&counts)?)?;
    db::set_meta(&tx, "stable.folders", "1")?;
    db::set_meta(&tx, "stable.mapFiles", "1")?;
    db::set_meta(&tx, "stable.scoresDb", &scores_db_stamp(install))?;
    tx.commit()?;
    Ok(counts)
}

/// Whether the library holds stable as it is now (osu!.db unchanged since the last scan, same
/// folders): then there's nothing to read again.
pub fn is_current(conn: &Connection, install: &StableInstall) -> Result<bool> {
    let meta = |k: &str| db::get_meta(conn, k);
    Ok(meta("stable.lastScan")?.is_some()
        && meta("stable.dbModified")?.as_deref() == Some(install.db_modified.to_string().as_str())
        && meta("stable.dbSize")?.as_deref() == Some(install.db_size.to_string().as_str())
        && meta("stable.path")?.as_deref() == Some(install.path.as_str())
        && meta("stable.songs")?.as_deref() == Some(install.songs.as_str())
        // imported before Fumen kept the sets' folders (library care)
        && meta("stable.folders")?.is_some()
        // …and the song and background each difficulty names
        && meta("stable.mapFiles")?.is_some()
        // plays since (stable writes osu!.db when it closes, scores.db after each play)
        && meta("stable.scoresDb")?.as_deref() == Some(scores_db_stamp(install).as_str()))
}

/// What the last scan found.
pub fn last_counts(conn: &Connection) -> Result<StableCounts> {
    let raw = db::get_meta(conn, "stable.counts")?.unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    let n = |k: &str| v[k].as_u64().unwrap_or(0) as usize;
    Ok(StableCounts { sets: n("sets"), maps: n("maps"), collections: n("collections"), scores: n("scores") })
}

/// Takes stable's sets out of the library (stable switched off or gone).
pub fn clear(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DELETE FROM sets WHERE source = 'stable';
         DELETE FROM lazer_collections WHERE source = 'stable';
         DELETE FROM stable_files;
         DELETE FROM scores WHERE id LIKE 'st-%';
         DELETE FROM meta WHERE key LIKE 'stable.%';",
    )?;
    tx.commit()?;
    Ok(())
}

/// The key → path table, for the file resolver.
pub fn load_files(conn: &Connection) -> Result<crate::paths::StableFiles> {
    let songs = db::get_meta(conn, "stable.songs")?.unwrap_or_default();
    let mut st = conn.prepare("SELECT key, path FROM stable_files")?;
    let keys = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<HashMap<String, String>>>()?;
    Ok(crate::paths::StableFiles { songs: songs.into(), keys })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes osu!.db entries the way stable does (enough of them to read them back).
    struct W(Vec<u8>);
    impl W {
        fn s(&mut self, s: &str) {
            self.0.push(0x0b);
            let mut n = s.len();
            loop {
                let b = (n & 0x7f) as u8;
                n >>= 7;
                self.0.push(if n == 0 { b } else { b | 0x80 });
                if n == 0 {
                    break;
                }
            }
            self.0.extend_from_slice(s.as_bytes());
        }
        fn b(&mut self, b: &[u8]) {
            self.0.extend_from_slice(b);
        }
    }

    /// A scores.db the way stable writes it: one difficulty, these plays.
    fn scores_db(md5: &str, plays: &[DbScore]) -> Vec<u8> {
        let mut w = W(Vec::new());
        w.b(&20250107i32.to_le_bytes());
        w.b(&1i32.to_le_bytes());
        w.s(md5);
        w.b(&(plays.len() as i32).to_le_bytes());
        for p in plays {
            w.b(&[p.mode]);
            w.b(&20250107i32.to_le_bytes());
            w.s(&p.md5);
            w.s(&p.player);
            w.s(&p.replay_md5);
            for h in p.hits {
                w.b(&h.to_le_bytes());
            }
            w.b(&p.score.to_le_bytes());
            w.b(&p.combo.to_le_bytes());
            w.b(&[0]);
            w.b(&p.mods.to_le_bytes());
            w.b(&[0]);
            w.b(&(p.date.unwrap() * 10_000 + 621_355_968_000_000_000).to_le_bytes());
            w.b(&(-1i32).to_le_bytes());
            w.b(&p.online_id.to_le_bytes());
            if p.mods & (1 << 23) != 0 {
                w.b(&0.5f64.to_le_bytes());
            }
        }
        w.0
    }

    fn play(mode: u8, hits: [u16; 6], mods: i32) -> DbScore {
        DbScore {
            mode,
            md5: "m".repeat(32),
            player: "Player".into(),
            replay_md5: format!("{mode}{mods}").repeat(4),
            hits,
            score: 123_456,
            combo: 300,
            mods,
            date: Some(1_700_000_000_000),
            online_id: 0,
        }
    }

    #[test]
    fn reads_scores_db() {
        let plays = [play(0, [300, 10, 0, 50, 5, 0], 8 | 64), play(3, [500, 20, 3, 900, 40, 2], 1 << 23), DbScore { online_id: 4_000_000_000, ..play(1, [1, 0, 0, 0, 0, 0], 0) }];
        assert_eq!(read_scores_db(&scores_db(&"m".repeat(32), &plays)).unwrap(), plays);
        assert!(read_scores_db(&scores_db(&"m".repeat(32), &plays)[..60]).is_err());
    }

    #[test]
    fn scores_as_lazer_has_them() {
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        // osu!: 300s 100s 50s geki katu miss
        let p = play(0, [300, 10, 0, 50, 5, 0], 8 | 64);
        assert!(close(p.accuracy(), (300.0 * 300.0 + 100.0 * 10.0) / (300.0 * 310.0)));
        // 96.8% 300s, no 50s, no miss, HD: silver S
        assert_eq!(p.rank(), 5);
        assert_eq!(p.statistics(), serde_json::json!({ "great": 300, "ok": 10 }));
        assert_eq!(p.mods_json(), serde_json::json!([{ "acronym": "HD" }, { "acronym": "DT" }, { "acronym": "CL" }]));
        // NC carries DT's bit, PF SD's
        assert_eq!(play(0, [1, 0, 0, 0, 0, 0], 64 | 512 | 32 | 16384).mods_json(), serde_json::json!([{ "acronym": "NC" }, { "acronym": "PF" }, { "acronym": "CL" }]));
        assert_eq!(play(0, [10, 0, 0, 0, 0, 0], 0).rank(), 6);
        assert_eq!(play(0, [10, 0, 0, 0, 0, 0], 1024).rank(), 7);
        assert_eq!(play(0, [95, 5, 0, 0, 0, 1], 0).rank(), 3);
        assert_eq!(play(0, [50, 50, 0, 0, 0, 0], 0).rank(), 0);
        // taiko: a good counts half
        let t = play(1, [90, 10, 0, 0, 0, 0], 0);
        assert!(close(t.accuracy(), 0.95));
        assert_eq!(t.rank(), 3);
        assert_eq!(t.statistics(), serde_json::json!({ "great": 90, "ok": 10 }));
        // catch: fruits, drops and droplets all count the same; katu are missed droplets
        let c = play(2, [100, 20, 75, 0, 5, 0], 0);
        assert!(close(c.accuracy(), 195.0 / 200.0));
        assert_eq!(c.rank(), 3);
        assert_eq!(c.statistics(), serde_json::json!({ "great": 100, "large_tick_hit": 20, "small_tick_hit": 75, "small_tick_miss": 5 }));
        // mania: geki (MAX) and 300 count full, katu 200
        let m = play(3, [100, 0, 0, 900, 0, 0], 1 << 20);
        assert!(close(m.accuracy(), 1.0));
        assert_eq!(m.rank(), 7);
        let m = play(3, [500, 20, 3, 900, 40, 2], 0);
        assert!(close(m.accuracy(), (300.0 * 1400.0 + 200.0 * 40.0 + 100.0 * 20.0 + 50.0 * 3.0) / (300.0 * 1465.0)));
        assert_eq!(m.rank(), 4);
        assert_eq!(m.statistics(), serde_json::json!({ "perfect": 900, "great": 500, "good": 40, "ok": 20, "meh": 3, "miss": 2 }));
    }

    /// The real scores.db, read only: FUMEN_TEST_STABLE=<osu!stable's folder>
    #[test]
    #[ignore = "reads a real osu!stable"]
    fn real_scores_db() {
        let Some(dir) = std::env::var_os("FUMEN_TEST_STABLE") else { return };
        let scores = read_scores_db(&std::fs::read(Path::new(&dir).join("scores.db")).unwrap()).unwrap();
        for s in &scores {
            println!(
                "{} {} {:?} {:.2}% rank {} {} mods {} {:?}",
                RULESETS[s.mode as usize],
                s.player,
                s.hits,
                s.accuracy() * 100.0,
                s.rank(),
                s.statistics(),
                s.mods_json(),
                s.date
            );
        }
        assert!(!scores.is_empty());
    }

    const FLOAT_STARS: i32 = 20250107;
    const TICKS_2024: i64 = 638_400_000_000_000_000; // 2024-01-01-ish

    fn entry(version: i32, md5: &str, folder: &str, mode: u8) -> Vec<u8> {
        let mut w = W(Vec::new());
        for s in ["Artist", "", "Title", "タイトル", "Mapper", "Hard", "audio.mp3", md5, "Artist - Title (Mapper) [Hard].osu"] {
            w.s(s);
        }
        w.b(&[4]); // ranked
        w.b(&100u16.to_le_bytes());
        w.b(&20u16.to_le_bytes());
        w.b(&1u16.to_le_bytes());
        w.b(&TICKS_2024.to_le_bytes());
        for v in [9.0f32, 4.0, 7.0, 8.0] {
            w.b(&v.to_le_bytes());
        }
        w.b(&1.4f64.to_le_bytes());
        for m in 0..4u8 {
            w.b(&2i32.to_le_bytes());
            for (mods, sr) in [(64, 9.9), (0, 4.25 + m as f64)] {
                w.b(&[0x08]);
                w.b(&(mods as i32).to_le_bytes());
                if version >= FLOAT_STARS {
                    w.b(&[0x0c]);
                    w.b(&(sr as f32).to_le_bytes());
                } else {
                    w.b(&[0x0d]);
                    w.b(&sr.to_le_bytes());
                }
            }
        }
        w.b(&90i32.to_le_bytes());
        w.b(&95_000i32.to_le_bytes());
        w.b(&30_000i32.to_le_bytes());
        // 200 BPM for most of it, 100 BPM briefly, an inherited point in between
        w.b(&3i32.to_le_bytes());
        for (beat, at, real) in [(300.0f64, 0.0f64, true), (-50.0, 1000.0, false), (600.0, 90_000.0, true)] {
            w.b(&beat.to_le_bytes());
            w.b(&at.to_le_bytes());
            w.b(&[real as u8]);
        }
        w.b(&1234i32.to_le_bytes());
        w.b(&567i32.to_le_bytes());
        w.b(&0i32.to_le_bytes());
        w.b(&[9, 9, 9, 9]);
        w.b(&0u16.to_le_bytes());
        w.b(&0.7f32.to_le_bytes());
        w.b(&[mode]);
        w.s("Source");
        w.s("tag1 tag2");
        w.b(&0u16.to_le_bytes());
        w.0.push(0); // no font
        w.b(&[0]); // played
        w.b(&(TICKS_2024 + 10_000_000).to_le_bytes());
        w.b(&[0]);
        w.s(folder);
        w.b(&0i64.to_le_bytes());
        w.b(&[0, 0, 0, 0, 0]);
        w.b(&0i32.to_le_bytes());
        w.b(&[0]);
        w.0
    }

    fn db(version: i32, entries: &[Vec<u8>]) -> Vec<u8> {
        let mut w = W(Vec::new());
        w.b(&version.to_le_bytes());
        w.b(&1i32.to_le_bytes());
        w.b(&[1]);
        w.b(&0i64.to_le_bytes());
        w.s("Player");
        w.b(&(entries.len() as i32).to_le_bytes());
        for e in entries {
            if version < NO_ENTRY_SIZE {
                w.b(&(e.len() as i32).to_le_bytes());
            }
            w.b(e);
        }
        w.b(&0i32.to_le_bytes());
        w.0
    }

    #[test]
    fn reads_osu_db_old_and_new() {
        for version in [20191105, 20240101, 20260101] {
            let bytes = db(version, &[entry(version, &"a".repeat(32), "1 Artist - Title", 3), entry(version, &"b".repeat(32), "1 Artist - Title", 0)]);
            let d = read_osu_db(&bytes).unwrap_or_else(|e| panic!("{version}: {e}"));
            assert_eq!((d.version, d.player.as_str(), d.maps.len()), (version, "Player", 2));
            let m = &d.maps[0];
            assert_eq!((m.title.as_str(), m.title_unicode.as_str(), m.version.as_str(), m.md5.len()), ("Title", "タイトル", "Hard", 32));
            assert_eq!((m.circles, m.sliders, m.spinners, m.status, m.mode), (100, 20, 1, 4, 3));
            assert_eq!((m.ar, m.cs, m.hp, m.od), (9.0, 4.0, 7.0, 8.0));
            // the no-mod rating of the difficulty's own mode
            assert!((m.stars.unwrap() - 7.25).abs() < 1e-5, "{version}: {:?}", m.stars);
            assert!((d.maps[1].stars.unwrap() - 4.25).abs() < 1e-5);
            assert_eq!((m.total_time, m.preview, m.map_id, m.set_id), (95_000, 30_000, 1234, 567));
            assert_eq!(m.bpm, 200.0);
            assert_eq!((m.source.as_str(), m.tags.as_str(), m.folder.as_str()), ("Source", "tag1 tag2", "1 Artist - Title"));
            assert_eq!(m.modified, ticks_ms(TICKS_2024));
            assert_eq!(m.last_played, ticks_ms(TICKS_2024 + 10_000_000));
        }
        assert!(read_osu_db(&db(20260101, &[entry(20260101, "x", "f", 0)])[..60]).is_err());
        assert!(read_osu_db(b"").is_err());
    }

    #[test]
    fn reads_collection_db() {
        let cols = [crate::collections::Outgoing { key: "k".into(), lazer_id: None, name: "Jacks".into(), md5s: vec!["a".repeat(32)] }];
        let read = read_collection_db(&crate::collections::collection_db(&cols)).unwrap();
        assert_eq!(read, vec![("Jacks".to_string(), vec!["a".repeat(32)])]);
        assert!(read_collection_db(&[1, 0, 0, 0, 5, 0, 0, 0]).is_err());
    }

    #[test]
    fn keys_and_names() {
        let k = file_key("Set/a.osu", 10, 5);
        assert_eq!(k.len(), 64);
        assert!(k.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(k, file_key("set/A.osu", 10, 5));
        assert_ne!(k, file_key("Set/a.osu", 11, 5));
        assert_ne!(k, file_key("Set/a.osu", 10, 6));
        assert_eq!(clean_rel("\"bg\\back.jpg\""), Some("bg/back.jpg".into()));
        assert_eq!(clean_rel("../x.jpg"), None);
        assert_eq!(clean_rel("C:/x.jpg"), None);
        assert_eq!(status(4), 1);
        assert_eq!(status(2), 0);
        assert_eq!(status(0), -3);
    }

    #[test]
    fn bpm_that_lasts_longest() {
        assert_eq!(main_bpm(&[(500.0, 0.0), (250.0, 1000.0)], 10_000.0), 240.0);
        assert_eq!(main_bpm(&[(500.0, 0.0), (250.0, 9000.0)], 10_000.0), 120.0);
        assert_eq!(main_bpm(&[], 10_000.0), 0.0);
    }

    #[test]
    fn imports_a_stable_folder() {
        let root = std::env::temp_dir().join(format!("fumen-stable-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let set = root.join("Songs").join("1 Artist - Title");
        std::fs::create_dir_all(set.join("bg")).unwrap();
        let version = 20260101;
        let md5 = "c".repeat(32);
        std::fs::write(root.join("osu!.db"), db(version, &[entry(version, &md5, "1 Artist - Title", 3)])).unwrap();
        std::fs::write(
            set.join("Artist - Title (Mapper) [Hard].osu"),
            "osu file format v14\n\n[General]\nAudioFilename: audio.mp3\n\n[Events]\n//Background and Video events\n0,0,\"bg\\back.jpg\",0,0\n\n[TimingPoints]\n0,300,4,1,0,100,1,0\n",
        )
        .unwrap();
        std::fs::write(set.join("audio.mp3"), b"ID3").unwrap();
        std::fs::write(set.join("bg").join("back.jpg"), b"\xFF\xD8\xFF").unwrap();
        std::fs::write(set.join("soft-hitclap.wav"), b"RIFF").unwrap();
        std::fs::write(set.join("Artist - Title (Mapper).osb"), b"[Events]").unwrap();
        std::fs::write(set.join("cover.png"), b"x").unwrap();
        let cols = [crate::collections::Outgoing { key: "k".into(), lazer_id: None, name: "Mine".into(), md5s: vec![md5.clone(), "gone".into()] }];
        std::fs::write(root.join("collection.db"), crate::collections::collection_db(&cols)).unwrap();

        let mut conn = crate::db::open(&root.join("fumen.db")).unwrap();
        let install = crate::paths::inspect_stable(&root).unwrap();
        let counts = import(&mut conn, &install, |_, _| {}).unwrap();
        assert_eq!((counts.sets, counts.maps, counts.collections), (1, 1, 1));

        let files = load_files(&conn).unwrap();
        let resolve = |k: &str| files.songs.join(&files.keys[k]);
        let (hash, bg, audio, sr, mode): (String, String, String, f64, i64) = conn
            .query_row("SELECT hash, bg, audio, sr, ruleset_id FROM maps WHERE id = ?1", [format!("st-{md5}")], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap();
        assert!(resolve(&hash).ends_with("Artist - Title (Mapper) [Hard].osu"));
        assert_eq!(std::fs::read(resolve(&bg)).unwrap(), b"\xFF\xD8\xFF");
        assert_eq!(std::fs::read(resolve(&audio)).unwrap(), b"ID3");
        assert_eq!((mode, (sr * 100.0).round()), (3, 725.0));
        // the chart panel and the playfield's hit sounds read through the same keys
        let all = crate::paths::Files { lazer: None, stable: std::sync::Arc::new(load_files(&conn).unwrap()) };
        assert_eq!(crate::charts::load(&all, &hash).unwrap().mode, 0);
        assert!(crate::hitsounds::for_map(&conn, &all, &format!("st-{md5}")).is_ok());
        let (source, sounds, set_bg): (String, String, String) =
            conn.query_row("SELECT source, sounds, bg FROM sets", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((source.as_str(), set_bg), ("stable", bg));
        let sounds: Vec<(String, String)> = serde_json::from_str(&sounds).unwrap();
        let mut names: Vec<&str> = sounds.iter().map(|(n, _)| n.as_str()).collect();
        names.sort();
        assert_eq!(names, ["Artist - Title (Mapper).osb", "audio.mp3", "soft-hitclap.wav"]);
        let items: i64 = conn.query_row("SELECT COUNT(*) FROM lazer_collection_items WHERE collection_id = 'st-col-0'", [], |r| r.get(0)).unwrap();
        assert_eq!(items, 2);

        assert!(is_current(&conn, &install).unwrap());
        assert_eq!(last_counts(&conn).unwrap().maps, 1);
        // a rescan replaces, never doubles; switching stable off takes it all out
        import(&mut conn, &install, |_, _| {}).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM maps", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        clear(&mut conn).unwrap();
        assert!(!is_current(&conn, &install).unwrap());
        let left: i64 = conn.query_row("SELECT (SELECT COUNT(*) FROM maps) + (SELECT COUNT(*) FROM stable_files) + (SELECT COUNT(*) FROM lazer_collections)", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }

    /// Fumen's real library (a copy) with the installed stable added, analysed; with
    /// FUMEN_SNAPSHOT_OUT / FUMEN_STABLE_FILES_OUT it writes the browser preview's snapshot.json and
    /// stable-files.json (key → file).
    ///   cargo test --lib stable::tests::preview_library -- --ignored --nocapture
    #[test]
    #[ignore = "reads Fumen's library and the installed osu!stable"]
    fn preview_library() {
        let data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.fumen.app");
        let dir = std::env::temp_dir().join(format!("fumen-stable-preview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["library.db", "library.db-wal"] {
            let _ = std::fs::copy(data.join(name), dir.join(name));
        }
        let mut conn = crate::db::open(&dir.join("library.db")).unwrap();
        let install = crate::paths::inspect_stable(&crate::paths::default_stable_dir().unwrap()).expect("osu!stable isn't installed");
        println!("{:?}", import(&mut conn, &install, |_, _| {}).unwrap());
        let files = crate::paths::Files { lazer: None, stable: std::sync::Arc::new(load_files(&conn).unwrap()) };
        let pending: Vec<String> = crate::charts::pending(&conn).unwrap().into_iter().filter(|h| files.stable.keys.contains_key(h)).collect();
        let rows = crate::charts::analyse_batch(&files, &pending);
        crate::charts::store(&mut conn, &rows).unwrap();
        println!("analysed {} of stable's charts", rows.len());
        let snap = crate::library::snapshot_json(&conn).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&snap).unwrap();
        let stable_sets = v["sets"].as_array().unwrap().iter().filter(|s| s["from"] == "stable").count();
        println!("snapshot: {} sets, {stable_sets} of them stable's (the rest lazer has too)", v["sets"].as_array().unwrap().len());
        if let Some(out) = std::env::var_os("FUMEN_SNAPSHOT_OUT") {
            std::fs::write(out, &snap).unwrap();
        }
        if let Some(out) = std::env::var_os("FUMEN_STABLE_FILES_OUT") {
            let map: serde_json::Map<String, serde_json::Value> =
                files.stable.keys.iter().map(|(k, rel)| (k.clone(), files.stable.songs.join(rel).to_string_lossy().into_owned().into())).collect();
            std::fs::write(out, serde_json::to_vec(&map).unwrap()).unwrap();
        }
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The installed stable's osu!.db, read whole (nothing is written).
    #[test]
    #[ignore = "reads the installed osu!stable"]
    fn reads_installed_stable() {
        let dir = crate::paths::default_stable_dir().unwrap();
        let install = crate::paths::inspect_stable(&dir).expect("osu!stable isn't installed");
        let d = read_osu_db(&std::fs::read(dir.join("osu!.db")).unwrap()).unwrap();
        println!("osu!.db {} of {}: {} difficulties", d.version, d.player, d.maps.len());
        for m in d.maps.iter().take(5) {
            println!("  {} - {} [{}] mode {} {:?}★ {:.0} BPM in {}", m.artist, m.title, m.version, m.mode, m.stars, m.bpm, m.folder);
        }
        let path = std::env::temp_dir().join("fumen-stable-real.db");
        let _ = std::fs::remove_file(&path);
        let mut conn = crate::db::open(&path).unwrap();
        let t = std::time::Instant::now();
        let counts = import(&mut conn, &install, |_, _| {}).unwrap();
        println!("imported {counts:?} in {:?}", t.elapsed());
        let without: i64 = conn.query_row("SELECT COUNT(*) FROM maps WHERE hash IS NULL", [], |r| r.get(0)).unwrap();
        let no_bg: i64 = conn.query_row("SELECT COUNT(*) FROM sets WHERE bg IS NULL", [], |r| r.get(0)).unwrap();
        println!("difficulties without a chart file: {without}; sets without a background: {no_bg}");
    }
}
