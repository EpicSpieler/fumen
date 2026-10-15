//! Your plays: lazer's local scores plus what osu! knows about you (scores from other computers
//! and from stable, pp, top plays, play counts, stats per ruleset).
//!
//! A sync reads osu!'s side into its own tables (`osu_scores`, `osu_beatmaps`, `osu_playcounts`,
//! meta `osu.stats`), which a library rescan never touches. `merge` puts both sides together: a
//! local score osu! also has is one play (same online id; for scores from stable, which lazer
//! keeps without one: same difficulty, ruleset, time and accuracy). osu!stable's own plays
//! (scores.db, ids "st-…") count as local too, unless lazer has the same play (it imports
//! stable's scores when asked): same difficulty and time.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::db;
use crate::error::Result;
use crate::osu_auth::{api_get, Account, Endpoints};

/// osu!'s rulesets, by id
pub const RULESETS: [&str; 4] = ["osu", "taiko", "fruits", "mania"];
/// osu! keeps up to 200 top plays per ruleset and hands them out 100 at a time
const TOP_PAGES: usize = 2;
/// how far apart a local and an online copy of the same play may be dated
const SAME_PLAY_MS: i64 = 120_000;
/// …and lazer's copy of an osu!stable play (lazer keeps the replay's time)
const STABLE_COPY_MS: i64 = 2_000;
/// the judgements a play's hit counts show
const JUDGEMENTS: [&str; 10] =
    ["perfect", "great", "good", "ok", "meh", "miss", "large_tick_hit", "large_tick_miss", "small_tick_hit", "small_tick_miss"];

pub fn mode_of(name: &str) -> Option<i64> {
    RULESETS.iter().position(|r| *r == name).map(|i| i as i64)
}

/// lazer's ScoreRank number for one of osu!'s grade letters
fn rank_of(letter: &str) -> i64 {
    match letter {
        "XH" | "SSH" => 7,
        "X" | "SS" => 6,
        "SH" => 5,
        "S" => 4,
        "A" => 3,
        "B" => 2,
        "C" => 1,
        "D" => 0,
        _ => -1,
    }
}

// ── dates ───────────────────────────────────────────────────────────────

/// Days since 1970-01-01 of a date in the proleptic Gregorian calendar (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix ms of an RFC 3339 time ("2024-05-29T12:34:56Z", "…56.789+02:00").
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        ms = format!("{:0<3}", &frac[..digits.min(3)]).parse().ok()?;
        rest = &frac[digits..];
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hm = rest[1..].replace(':', "");
            if hm.len() != 4 || !hm.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            sign * (hm[..2].parse::<i64>().ok()? * 60 + hm[2..].parse::<i64>().ok()?)
        }
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset * 60;
    Some(secs * 1000 + ms)
}

// ── osu!'s answers ──────────────────────────────────────────────────────

/// A score as osu! has it.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiScore {
    pub id: i64,
    pub beatmap_id: i64,
    pub mode: i64,
    pub total_score: i64,
    pub accuracy: f64,
    pub max_combo: i64,
    pub rank: i64,
    pub pp: Option<f64>,
    pub passed: bool,
    /// unix ms
    pub date: i64,
    /// `[{"acronym":…,"settings":{…}}]`, like lazer's
    pub mods: String,
    pub statistics: String,
    pub legacy_id: Option<i64>,
    /// position in the player's top plays for this ruleset (from 1)
    pub best_pos: Option<i64>,
}

/// A difficulty as osu! describes it.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiBeatmap {
    pub id: i64,
    pub set_id: Option<i64>,
    pub md5: Option<String>,
    pub mode: Option<i64>,
    pub version: String,
    pub sr: Option<f64>,
    /// ms
    pub length: Option<f64>,
    pub title: String,
    pub title_unicode: String,
    pub artist: String,
    pub artist_unicode: String,
    pub creator: String,
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

pub fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}

/// A difficulty from a score's (or a play count's) `beatmap` and `beatmapset`.
pub fn parse_beatmap(b: &Value, set: &Value) -> Option<ApiBeatmap> {
    Some(ApiBeatmap {
        id: b["id"].as_i64()?,
        set_id: b["beatmapset_id"].as_i64().or_else(|| set["id"].as_i64()),
        md5: b["checksum"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        mode: b["mode_int"].as_i64().or_else(|| b["mode"].as_str().and_then(mode_of)),
        version: text(&b["version"]),
        sr: b["difficulty_rating"].as_f64(),
        length: b["total_length"].as_f64().map(|s| s * 1000.0),
        title: text(&set["title"]),
        title_unicode: text(&set["title_unicode"]),
        artist: text(&set["artist"]),
        artist_unicode: text(&set["artist_unicode"]),
        creator: text(&set["creator"]),
    })
}

/// A score from the API (score format 20240529; the older field names are read too). `mode`
/// stands in when the score doesn't name its ruleset.
pub fn parse_score(v: &Value, mode: i64, best_pos: Option<i64>) -> Option<(ApiScore, Option<ApiBeatmap>)> {
    let beatmap = parse_beatmap(&v["beatmap"], &v["beatmapset"]);
    let rank = rank_of(v["rank"].as_str().unwrap_or("F"));
    // lazer's shape: objects with an acronym (the old format had bare acronyms)
    let mods: Vec<Value> = list(&v["mods"])
        .iter()
        .filter_map(|m| match m {
            Value::String(a) => Some(serde_json::json!({ "acronym": a })),
            Value::Object(o) if o.get("acronym").is_some_and(Value::is_string) => Some(m.clone()),
            _ => None,
        })
        .collect();
    let score = ApiScore {
        id: v["id"].as_i64()?,
        beatmap_id: v["beatmap_id"].as_i64().or(beatmap.as_ref().map(|b| b.id))?,
        mode: v["ruleset_id"]
            .as_i64()
            .or_else(|| v["mode_int"].as_i64())
            .or_else(|| v["mode"].as_str().and_then(mode_of))
            .unwrap_or(mode),
        total_score: v["total_score"].as_i64().or_else(|| v["score"].as_i64()).unwrap_or(0),
        accuracy: v["accuracy"].as_f64().unwrap_or(0.0),
        max_combo: v["max_combo"].as_i64().unwrap_or(0),
        rank,
        pp: v["pp"].as_f64(),
        passed: v["passed"].as_bool().unwrap_or(rank >= 0),
        date: v["ended_at"].as_str().or_else(|| v["created_at"].as_str()).and_then(parse_iso)?,
        mods: Value::Array(mods).to_string(),
        statistics: if v["statistics"].is_object() { v["statistics"].to_string() } else { "{}".into() },
        legacy_id: v["legacy_score_id"].as_i64().filter(|id| *id > 0),
        best_pos,
    };
    Some((score, beatmap))
}

/// Mod acronyms and the playback rate they set (None at 1×), from lazer's mods JSON.
pub fn mods_of(json: &str) -> (Vec<String>, Option<f64>) {
    let list: Vec<Value> = serde_json::from_str(json).unwrap_or_default();
    let mut acronyms = Vec::new();
    let mut rate = 1.0;
    for m in &list {
        let Some(a) = m["acronym"].as_str().or_else(|| m.as_str()) else { continue };
        let speed = m["settings"]["speed_change"].as_f64();
        match a {
            "DT" | "NC" => rate = speed.unwrap_or(1.5),
            "HT" | "DC" => rate = speed.unwrap_or(0.75),
            _ => {}
        }
        acronyms.push(a.to_string());
    }
    (acronyms, ((rate - 1.0f64).abs() > 1e-6).then_some(rate))
}

/// The judgement counts a play shows (the ones above zero).
fn hits_of(json: &str) -> Map<String, Value> {
    let v: Value = serde_json::from_str(json).unwrap_or_default();
    JUDGEMENTS
        .iter()
        .filter_map(|k| v[*k].as_i64().filter(|n| *n > 0).map(|n| (k.to_string(), n.into())))
        .collect()
}

/// The parts of osu!'s user (in one ruleset) the history shows.
fn stats_of(user: &Value) -> Value {
    let s = &user["statistics"];
    serde_json::json!({
        "pp": s["pp"],
        "rank": s["global_rank"],
        "countryRank": s["country_rank"],
        // osu! gives it in percent
        "accuracy": s["hit_accuracy"].as_f64().map(|a| a / 100.0),
        "playCount": s["play_count"],
        // seconds
        "playTime": s["play_time"],
        "maxCombo": s["maximum_combo"],
        "grades": s["grade_counts"],
        // global rank over the last 90 days, oldest first (0: unranked that day)
        "rankHistory": user["rank_history"]["data"],
    })
}

// ── syncing ─────────────────────────────────────────────────────────────

/// What a sync brought from osu!.
#[derive(Debug, Default)]
pub struct Fetched {
    pub user_id: i64,
    pub scores: Vec<ApiScore>,
    index: HashMap<i64, usize>,
    pub beatmaps: HashMap<i64, ApiBeatmap>,
    /// (difficulty, plays), most played first
    pub playcounts: Vec<(i64, i64)>,
    /// by ruleset name
    pub stats: Map<String, Value>,
    /// rulesets whose top plays were read (older top positions there are void)
    pub modes: Vec<i64>,
}

impl Fetched {
    fn add(&mut self, v: &Value, mode: i64, best_pos: Option<i64>) {
        let Some((score, beatmap)) = parse_score(v, mode, best_pos) else { return };
        if let Some(b) = beatmap {
            self.beatmaps.insert(b.id, b);
        }
        match self.index.get(&score.id) {
            Some(&i) => self.scores[i].best_pos = self.scores[i].best_pos.or(score.best_pos),
            None => {
                self.index.insert(score.id, self.scores.len());
                self.scores.push(score);
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    /// scores Fumen hadn't seen
    pub added: usize,
    /// osu! scores Fumen knows now
    pub total: i64,
    /// unix ms
    pub at: i64,
}

/// The player's stats, top plays and recent plays (the last 24 hours, fails too) in every ruleset
/// they've played, and their most played difficulties.
pub fn fetch(ep: &Endpoints, token: &str, account: &Account) -> Result<Fetched> {
    let id = account.id;
    let mut f = Fetched { user_id: id as i64, ..Default::default() };
    // the player's main ruleset first
    let mut order = RULESETS.to_vec();
    if let Some(i) = account.mode.as_deref().and_then(|m| order.iter().position(|r| *r == m)) {
        let main = order.remove(i);
        order.insert(0, main);
    }
    for name in order {
        let mode = mode_of(name).unwrap_or(0);
        let stats = stats_of(&api_get(ep, token, &format!("users/{id}/{name}"))?);
        let played = stats["playCount"].as_i64().unwrap_or(0) > 0;
        f.stats.insert(name.into(), stats);
        if !played {
            continue;
        }
        f.modes.push(mode);
        for page in 0..TOP_PAGES {
            let offset = page * 100;
            let top = api_get(ep, token, &format!("users/{id}/scores/best?mode={name}&limit=100&offset={offset}"))?;
            for (i, s) in list(&top).iter().enumerate() {
                f.add(s, mode, Some((offset + i + 1) as i64));
            }
            if list(&top).len() < 100 {
                break;
            }
        }
        let recent = api_get(ep, token, &format!("users/{id}/scores/recent?mode={name}&limit=100&include_fails=1"))?;
        for s in list(&recent) {
            f.add(s, mode, None);
        }
    }
    let played = api_get(ep, token, &format!("users/{id}/beatmapsets/most_played?limit=100"))?;
    for item in list(&played) {
        let Some(beatmap_id) = item["beatmap_id"].as_i64() else { continue };
        if let Some(b) = parse_beatmap(&item["beatmap"], &item["beatmapset"]) {
            // a score's copy of the difficulty says more (md5)
            f.beatmaps.entry(b.id).or_insert(b);
        }
        f.playcounts.push((beatmap_id, item["count"].as_i64().unwrap_or(0)));
    }
    Ok(f)
}

/// A beatmap set the player has played: from osu!'s play counts, top plays (every ruleset) and
/// the scores Fumen has synced (what the Performance view shows).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayedSet {
    pub id: u32,
    pub title: String,
    pub artist: String,
    pub creator: String,
    /// plays over all its difficulties (osu!'s play counts)
    pub plays: i64,
    /// difficulties played
    pub maps: u32,
    /// osu!'s status ("ranked", "loved", "graveyard", …; empty when not known)
    pub status: String,
    /// one of its difficulties is in the player's top plays
    pub top: bool,
}

/// How many play counts are read at most (osu! pages them 100 at a time).
const MAX_PLAY_COUNTS: usize = 100_000;

/// Played sets by id, each difficulty counted once.
#[derive(Default)]
pub struct PlayedSets {
    sets: Vec<PlayedSet>,
    index: HashMap<u32, usize>,
    beatmaps: std::collections::HashSet<i64>,
}

impl PlayedSets {
    /// One difficulty of set `id` (`beatmap`, when known, counts once however often it comes).
    pub fn add(&mut self, id: u32, beatmap: Option<i64>, plays: i64, top: bool, about: impl FnOnce() -> PlayedSet) {
        if id == 0 {
            return;
        }
        let new_map = beatmap.map_or(true, |b| self.beatmaps.insert(b));
        let i = match self.index.get(&id) {
            Some(&i) => i,
            None => {
                self.index.insert(id, self.sets.len());
                self.sets.push(PlayedSet { id, ..about() });
                self.sets.len() - 1
            }
        };
        let s = &mut self.sets[i];
        if new_map {
            s.maps += 1;
            s.plays += plays;
        }
        s.top |= top;
    }

    /// Most played first, top plays before the rest at equal plays.
    pub fn into_sorted(mut self) -> Vec<PlayedSet> {
        self.sets.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.top.cmp(&a.top)).then(a.id.cmp(&b.id)));
        self.sets
    }
}

fn about_set(set: &Value) -> PlayedSet {
    PlayedSet {
        title: text(&set["title"]),
        artist: text(&set["artist"]),
        creator: text(&set["creator"]),
        status: text(&set["status"]),
        ..Default::default()
    }
}

fn set_id(item: &Value) -> u32 {
    item["beatmapset"]["id"]
        .as_u64()
        .or_else(|| item["beatmap"]["beatmapset_id"].as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0)
}

/// Every set the player has ever played (`most_played` goes through all of them, 100 at a time)
/// and the sets of their top plays in every ruleset. `progress` gets the play counts and scores
/// read so far.
pub fn played_sets(ep: &Endpoints, token: &str, user_id: u64, out: &mut PlayedSets, mut progress: impl FnMut(usize)) -> Result<()> {
    let mut read = 0;
    let mut offset = 0;
    loop {
        let page = api_get_patiently(ep, token, &format!("users/{user_id}/beatmapsets/most_played?limit=100&offset={offset}"))?;
        let items = list(&page);
        for item in items {
            let count = item["count"].as_i64().unwrap_or(0);
            let beatmap = item["beatmap_id"].as_i64().or_else(|| item["beatmap"]["id"].as_i64());
            out.add(set_id(item), beatmap, count, false, || about_set(&item["beatmapset"]));
        }
        offset += items.len();
        read += items.len();
        progress(read);
        if items.len() < 100 || offset >= MAX_PLAY_COUNTS {
            break;
        }
    }
    // top plays (a difficulty can be in them without a play count, e.g. a play from long ago)
    for name in RULESETS {
        for page in 0..TOP_PAGES {
            let offset = page * 100;
            let top = api_get_patiently(ep, token, &format!("users/{user_id}/scores/best?mode={name}&limit=100&offset={offset}"))?;
            let items = list(&top);
            for item in items {
                let beatmap = item["beatmap_id"].as_i64().or_else(|| item["beatmap"]["id"].as_i64());
                out.add(set_id(item), beatmap, 0, true, || about_set(&item["beatmapset"]));
            }
            read += items.len();
            progress(read);
            if items.len() < 100 {
                break;
            }
        }
    }
    Ok(())
}

/// The sets of the scores Fumen has synced from osu! for `user_id` (recent plays from earlier
/// syncs included), as the Performance view shows them.
pub fn synced_sets(conn: &Connection, user_id: i64, out: &mut PlayedSets) -> Result<()> {
    let mut st = conn.prepare(
        "SELECT b.set_id, s.beatmap_id, MAX(s.best_pos IS NOT NULL), b.title, b.artist, b.creator
         FROM osu_scores s JOIN osu_beatmaps b ON b.id = s.beatmap_id
         WHERE s.user_id = ?1 AND b.set_id > 0
         GROUP BY s.beatmap_id",
    )?;
    let mut rows = st.query([user_id])?;
    while let Some(r) = rows.next()? {
        let Ok(id) = u32::try_from(r.get::<_, i64>(0)?) else { continue };
        let about = PlayedSet {
            title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            artist: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            creator: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            ..Default::default()
        };
        out.add(id, Some(r.get(1)?), 0, r.get::<_, i64>(2)? != 0, || about);
    }
    Ok(())
}

/// `api_get`, waiting out osu!'s rate limit a few times instead of giving up.
fn api_get_patiently(ep: &Endpoints, token: &str, path: &str) -> Result<Value> {
    let mut tries = 0;
    loop {
        match api_get(ep, token, path) {
            Err(e) if e.code() == "osu-busy" && tries < 3 => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_secs(if cfg!(test) { 0 } else { 20 }));
            }
            r => return r,
        }
    }
}

/// The player's scores osu! keeps on one difficulty, in each of these rulesets.
pub fn fetch_map(ep: &Endpoints, token: &str, user_id: u64, beatmap_id: i64, modes: &[i64]) -> Result<Vec<ApiScore>> {
    let mut out = Vec::new();
    for &mode in modes {
        let Some(name) = usize::try_from(mode).ok().and_then(|i| RULESETS.get(i)) else { continue };
        let v = match api_get(ep, token, &format!("beatmaps/{beatmap_id}/scores/users/{user_id}/all?ruleset={name}")) {
            Err(e) if e.code() == "osu-not-found" => continue,
            r => r?,
        };
        out.extend(
            list(&v["scores"])
                .iter()
                .filter_map(|s| parse_score(s, mode, None))
                .map(|(s, _)| s)
                .filter(|s| s.beatmap_id == beatmap_id),
        );
    }
    Ok(out)
}

/// A score Fumen knows keeps its top position unless a new one comes with it, and its pp if osu!
/// sends none this time.
const UPSERT_SCORE: &str = "INSERT INTO osu_scores (id, user_id, beatmap_id, mode, total_score, accuracy, max_combo,
        rank, pp, passed, date, mods, statistics, legacy_id, best_pos)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(id) DO UPDATE SET total_score = excluded.total_score, accuracy = excluded.accuracy,
        max_combo = excluded.max_combo, rank = excluded.rank, pp = COALESCE(excluded.pp, pp),
        passed = excluded.passed, mods = excluded.mods, statistics = excluded.statistics,
        legacy_id = COALESCE(excluded.legacy_id, legacy_id), best_pos = COALESCE(excluded.best_pos, best_pos)";

fn upsert_scores(conn: &Connection, user_id: i64, scores: &[ApiScore]) -> Result<usize> {
    let mut known = conn.prepare("SELECT 1 FROM osu_scores WHERE id = ?1")?;
    let mut put = conn.prepare(UPSERT_SCORE)?;
    let mut added = 0;
    for s in scores {
        if !known.exists([s.id])? {
            added += 1;
        }
        put.execute(params![
            s.id, user_id, s.beatmap_id, s.mode, s.total_score, s.accuracy, s.max_combo, s.rank, s.pp, s.passed, s.date, s.mods,
            s.statistics, s.legacy_id, s.best_pos
        ])?;
    }
    Ok(added)
}

fn upsert_beatmaps<'a>(conn: &Connection, beatmaps: impl Iterator<Item = &'a ApiBeatmap>) -> Result<()> {
    let mut put = conn.prepare(
        "INSERT INTO osu_beatmaps (id, set_id, md5, mode, version, sr, length, title, title_unicode, artist,
            artist_unicode, creator)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET set_id = COALESCE(excluded.set_id, set_id),
            md5 = COALESCE(excluded.md5, md5), mode = COALESCE(excluded.mode, mode),
            version = COALESCE(NULLIF(excluded.version, ''), version), sr = COALESCE(excluded.sr, sr),
            length = COALESCE(excluded.length, length), title = COALESCE(NULLIF(excluded.title, ''), title),
            title_unicode = COALESCE(NULLIF(excluded.title_unicode, ''), title_unicode),
            artist = COALESCE(NULLIF(excluded.artist, ''), artist),
            artist_unicode = COALESCE(NULLIF(excluded.artist_unicode, ''), artist_unicode),
            creator = COALESCE(NULLIF(excluded.creator, ''), creator)",
    )?;
    for b in beatmaps {
        put.execute(params![
            b.id, b.set_id, b.md5, b.mode, b.version, b.sr, b.length, b.title, b.title_unicode, b.artist, b.artist_unicode, b.creator
        ])?;
    }
    Ok(())
}

/// The account Fumen is logged in with; what Fumen had from another account goes.
pub fn set_user(conn: &Connection, user_id: i64) -> Result<()> {
    let before = db::get_meta(conn, "osu.user")?.and_then(|v| v.parse::<i64>().ok());
    if before.is_some_and(|b| b != user_id) {
        clear(conn)?;
    }
    conn.execute("DELETE FROM osu_scores WHERE user_id != ?1", [user_id])?;
    db::set_meta(conn, "osu.user", &user_id.to_string())
}

/// Forgets everything from osu! (logging out).
pub fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM osu_scores; DELETE FROM osu_beatmaps; DELETE FROM osu_playcounts;
         DELETE FROM meta WHERE key LIKE 'osu.%';",
    )?;
    Ok(())
}

/// Saves a sync: top positions in the synced rulesets are replaced, play counts and stats too.
pub fn store(conn: &mut Connection, f: &Fetched) -> Result<SyncSummary> {
    let tx = conn.transaction()?;
    set_user(&tx, f.user_id)?;
    for mode in &f.modes {
        tx.execute("UPDATE osu_scores SET best_pos = NULL WHERE mode = ?1", [mode])?;
    }
    upsert_beatmaps(&tx, f.beatmaps.values())?;
    let added = upsert_scores(&tx, f.user_id, &f.scores)?;
    tx.execute("DELETE FROM osu_playcounts", [])?;
    {
        let mut put = tx.prepare("INSERT OR IGNORE INTO osu_playcounts (beatmap_id, count, position) VALUES (?1, ?2, ?3)")?;
        for (i, (beatmap, count)) in f.playcounts.iter().enumerate() {
            put.execute(params![beatmap, count, i as i64 + 1])?;
        }
    }
    let at = crate::lazer::now_ms();
    db::set_meta(&tx, "osu.stats", &Value::Object(f.stats.clone()).to_string())?;
    db::set_meta(&tx, "osu.lastSync", &at.to_string())?;
    tx.commit()?;
    let total = conn.query_row("SELECT COUNT(*) FROM osu_scores", [], |r| r.get(0))?;
    Ok(SyncSummary { added, total, at })
}

/// Saves one difficulty's scores (`fetch_map`); how many were new.
pub fn store_map(conn: &mut Connection, user_id: i64, scores: &[ApiScore]) -> Result<usize> {
    let tx = conn.transaction()?;
    set_user(&tx, user_id)?;
    let added = upsert_scores(&tx, user_id, scores)?;
    tx.commit()?;
    Ok(added)
}

pub fn last_sync(conn: &Connection) -> Result<Option<i64>> {
    Ok(db::get_meta(conn, "osu.lastSync")?.and_then(|v| v.parse().ok()))
}

// ── merging ─────────────────────────────────────────────────────────────

/// Whose local scores are "yours": the osu! account Fumen is (or was last) logged in with, else
/// lazer's most frequent player. lazer also keeps other players' scores (replays from the
/// leaderboard).
#[derive(Debug, Clone, PartialEq)]
pub enum Player {
    Id(i64),
    /// a player lazer only knows by name (never logged in)
    Name(String),
    Anyone,
}

impl Player {
    pub fn detect(conn: &Connection) -> Result<Player> {
        if let Some(id) = db::get_meta(conn, "osu.user")?.and_then(|v| v.parse().ok()) {
            return Ok(Player::Id(id));
        }
        let top = conn
            .query_row(
                "SELECT CASE WHEN user_id > 1 THEN user_id END AS uid,
                        CASE WHEN user_id > 1 THEN NULL ELSE user END AS uname, COUNT(*) AS n
                 FROM scores GROUP BY uid, uname ORDER BY n DESC LIMIT 1",
                [],
                |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        Ok(match top {
            Some((Some(id), _)) => Player::Id(id),
            Some((None, Some(name))) if !name.is_empty() => Player::Name(name),
            _ => Player::Anyone,
        })
    }

    /// The condition on `scores` for this player, with `?1` as its parameter.
    fn sql(&self) -> &'static str {
        match self {
            // osu!stable's plays only have the name: the one this account plays under in lazer
            Player::Id(_) => "(user_id = ?1 OR (user_id IS NULL AND id LIKE 'st-%' AND user IN (SELECT user FROM scores WHERE user_id = ?1)))",
            Player::Name(_) => "user = ?1",
            Player::Anyone => "?1 IS NULL",
        }
    }

    fn param(&self) -> rusqlite::types::Value {
        match self {
            Player::Id(id) => (*id).into(),
            Player::Name(name) => name.clone().into(),
            Player::Anyone => rusqlite::types::Value::Null,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Play {
    /// the library difficulty
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    /// not in the library: index into `History::beatmaps`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beatmap: Option<u32>,
    /// osu!'s id of the difficulty, when osu! knows the play
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beatmap_id: Option<i64>,
    /// 0 osu, 1 taiko, 2 catch, 3 mania, -1 a custom ruleset
    pub mode: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ruleset: Option<String>,
    /// unix ms
    pub date: i64,
    /// lazer ScoreRank: -1 F, 0 D … 4 S, 5 SH, 6 X, 7 XH
    pub rank: i64,
    pub acc: f64,
    pub score: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pp: Option<f64>,
    pub combo: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mods: Vec<String>,
    /// playback rate from the mods, when not 1×
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub hits: Map<String, Value>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
    /// "lazer" (only on this computer), "osu" (only on osu!), "both"
    pub source: &'static str,
    /// played in osu!stable (its scores.db)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stable: bool,
    /// position in osu!'s top plays for its ruleset
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top: Option<i64>,
    /// osu!'s score id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    /// osu!mania at a rate the library snapshot doesn't carry a star rating for: the one at it
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sr: Option<f64>,
    /// the difficulty's md5 (the library snapshot's best scores go by it)
    #[serde(skip)]
    md5: Option<String>,
}

/// A rate (× 100) whose osu!mania star rating the library snapshot doesn't carry (it has 1×,
/// 0.75× and 1.5×).
fn off_grid(rate: Option<f64>) -> Option<u32> {
    let key = (rate? * 100.0).round();
    (key > 0.0 && ![75.0, 100.0, 150.0].contains(&key)).then_some(key as u32)
}

/// A difficulty that isn't in the library, as osu! described it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineMap {
    pub id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_id: Option<i64>,
    pub mode: i64,
    pub version: String,
    pub sr: f64,
    /// ms
    pub length: f64,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title_unicode: String,
    pub artist: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub artist_unicode: String,
    pub creator: String,
    #[serde(skip)]
    md5: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayCount {
    #[serde(skip_serializing_if = "Option::is_none")]
    map: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    beatmap: Option<u32>,
    beatmap_id: i64,
    count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct History {
    #[serde(skip_serializing_if = "Option::is_none")]
    player: Option<PlayerOut>,
    /// the last sync with osu! (unix ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    synced_at: Option<i64>,
    /// newest first
    plays: Vec<Play>,
    /// osu!'s most played difficulties (its top 100), most played first
    most_played: Vec<PlayCount>,
    /// osu!'s stats by ruleset name
    stats: Value,
    beatmaps: Vec<OnlineMap>,
}

/// The library's difficulties, found by md5 or by osu!'s id.
struct Library {
    by_md5: HashMap<String, String>,
    by_online: HashMap<i64, (String, Option<String>)>,
    /// osu!mania difficulties' chart files (difficulty id → file hash)
    mania: HashMap<String, String>,
}

impl Library {
    fn read(conn: &Connection) -> Result<Library> {
        let mut lib = Library { by_md5: HashMap::new(), by_online: HashMap::new(), mania: HashMap::new() };
        // lazer's first: a difficulty in both games is lazer's
        let mut st = conn.prepare(
            "SELECT m.id, m.md5, m.online_id, m.hash, m.ruleset_id FROM maps m JOIN sets s ON s.id = m.set_id
             ORDER BY s.source = 'stable', m.set_id, m.id",
        )?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let md5: Option<String> = r.get(1)?;
            if let (Some(hash), Some(3)) = (r.get::<_, Option<String>>(3)?, r.get::<_, Option<i64>>(4)?) {
                lib.mania.insert(id.clone(), hash);
            }
            if let Some(online) = r.get::<_, Option<i64>>(2)?.filter(|v| *v > 0) {
                lib.by_online.entry(online).or_insert_with(|| (id.clone(), md5.clone()));
            }
            if let Some(h) = md5 {
                lib.by_md5.entry(h).or_insert(id);
            }
        }
        Ok(lib)
    }

    /// The library difficulty for osu!'s difficulty `id` (with this md5, if osu! said): (id, md5)
    fn find(&self, id: i64, md5: Option<&str>) -> Option<(String, Option<String>)> {
        md5.and_then(|h| self.by_md5.get(h).map(|m| (m.clone(), Some(h.to_string())))).or_else(|| self.by_online.get(&id).cloned())
    }
}

/// Difficulties from osu! that aren't in the library, collected as plays point at them.
struct Online {
    known: HashMap<i64, OnlineMap>,
    used: Vec<OnlineMap>,
    index: HashMap<i64, u32>,
}

impl Online {
    fn read(conn: &Connection) -> Result<Online> {
        let mut st = conn.prepare(
            "SELECT id, set_id, md5, mode, version, sr, length, title, title_unicode, artist, artist_unicode, creator
             FROM osu_beatmaps",
        )?;
        let known = st
            .query_map([], |r| {
                Ok(OnlineMap {
                    id: r.get(0)?,
                    set_id: r.get(1)?,
                    md5: r.get(2)?,
                    mode: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    version: r.get(4)?,
                    sr: r.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
                    length: r.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
                    title: r.get(7)?,
                    title_unicode: r.get(8)?,
                    artist: r.get(9)?,
                    artist_unicode: r.get(10)?,
                    creator: r.get(11)?,
                })
            })?
            .map(|m| m.map(|m| (m.id, m)))
            .collect::<rusqlite::Result<_>>()?;
        Ok(Online { known, used: Vec::new(), index: HashMap::new() })
    }

    fn md5(&self, id: i64) -> Option<&str> {
        self.known.get(&id)?.md5.as_deref()
    }

    fn take(&mut self, id: i64) -> Option<u32> {
        if let Some(&i) = self.index.get(&id) {
            return Some(i);
        }
        let map = self.known.get(&id)?.clone();
        let i = self.used.len() as u32;
        self.used.push(map);
        self.index.insert(id, i);
        Some(i)
    }
}

struct Merged {
    player: Player,
    plays: Vec<Play>,
    lib: Library,
    online: Online,
}

/// The player's plays, local and from osu!, newest first.
fn merge(conn: &Connection) -> Result<Merged> {
    let player = Player::detect(conn)?;
    let lib = Library::read(conn)?;
    let mut online = Online::read(conn)?;
    let mut plays: Vec<Play> = Vec::new();
    let mut by_score_id: HashMap<i64, usize> = HashMap::new();
    let mut by_map: HashMap<String, Vec<usize>> = HashMap::new();

    let mut st = conn.prepare(&format!(
        "SELECT map_md5, ruleset, total_score, accuracy, max_combo, rank, pp, date, mods, statistics, online_id, id LIKE 'st-%'
         FROM scores WHERE {} AND NOT (id LIKE 'st-%' AND EXISTS (
             SELECT 1 FROM scores l WHERE l.id NOT LIKE 'st-%' AND l.map_md5 = scores.map_md5 AND ABS(l.date - scores.date) <= {STABLE_COPY_MS}))
         ORDER BY date DESC",
        player.sql()
    ))?;
    let mut rows = st.query([player.param()])?;
    while let Some(r) = rows.next()? {
        let md5: Option<String> = r.get(0)?;
        let ruleset: Option<String> = r.get(1)?;
        let mode = crate::library::ruleset_mode(None, ruleset.as_deref());
        let (mods, rate) = mods_of(&r.get::<_, Option<String>>(8)?.unwrap_or_default());
        let rank = r.get::<_, Option<i64>>(5)?.unwrap_or(-1);
        let map = md5.as_ref().and_then(|h| lib.by_md5.get(h).cloned());
        let i = plays.len();
        if let Some(id) = r.get::<_, Option<i64>>(10)?.filter(|v| *v > 0) {
            by_score_id.insert(id, i);
        }
        if let Some(m) = &map {
            by_map.entry(m.clone()).or_default().push(i);
        }
        plays.push(Play {
            map,
            beatmap: None,
            beatmap_id: None,
            mode,
            ruleset: if mode < 0 { ruleset } else { None },
            date: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            rank,
            acc: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            score: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            pp: r.get(6)?,
            combo: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            mods,
            rate,
            hits: hits_of(&r.get::<_, Option<String>>(9)?.unwrap_or_default()),
            failed: rank < 0,
            source: "lazer",
            stable: r.get(11)?,
            top: None,
            id: None,
            sr: None,
            md5,
        });
    }

    // osu!'s side belongs to the logged-in account
    if let Player::Id(user_id) = player {
        let mut st = conn.prepare(
            "SELECT id, beatmap_id, mode, total_score, accuracy, max_combo, rank, pp, passed, date, mods, statistics, best_pos
             FROM osu_scores WHERE user_id = ?1 ORDER BY date DESC",
        )?;
        let mut rows = st.query([user_id])?;
        while let Some(r) = rows.next()? {
            let id: i64 = r.get(0)?;
            let beatmap_id: i64 = r.get(1)?;
            let mode: i64 = r.get(2)?;
            let acc: f64 = r.get(4)?;
            let date: i64 = r.get(9)?;
            let pp: Option<f64> = r.get(7)?;
            let top: Option<i64> = r.get(12)?;
            let found = lib.find(beatmap_id, online.md5(beatmap_id));
            // the same play, kept by lazer
            let same = by_score_id.get(&id).copied().or_else(|| {
                let (map, _) = found.as_ref()?;
                by_map.get(map)?.iter().copied().find(|&i| {
                    let p = &plays[i];
                    p.source == "lazer" && p.mode == mode && (p.date - date).abs() <= SAME_PLAY_MS && (p.acc - acc).abs() < 0.0005
                })
            });
            if let Some(i) = same {
                let p = &mut plays[i];
                p.source = "both";
                p.pp = pp.or(p.pp);
                p.top = top;
                p.id = Some(id);
                p.beatmap_id = Some(beatmap_id);
                continue;
            }
            let (map, md5) = match found {
                Some((map, md5)) => (Some(map), md5),
                None => (None, online.md5(beatmap_id).map(str::to_string)),
            };
            let (mods, rate) = mods_of(&r.get::<_, String>(10)?);
            let rank: i64 = r.get(6)?;
            plays.push(Play {
                beatmap: if map.is_none() { online.take(beatmap_id) } else { None },
                map,
                beatmap_id: Some(beatmap_id),
                mode,
                ruleset: None,
                date,
                rank,
                acc,
                score: r.get(3)?,
                pp,
                combo: r.get(5)?,
                mods,
                rate,
                hits: hits_of(&r.get::<_, String>(11)?),
                failed: !r.get::<_, bool>(8)? || rank < 0,
                source: "osu",
                stable: false,
                top,
                id: Some(id),
                sr: None,
                md5,
            });
        }
    }
    plays.sort_by(|a, b| b.date.cmp(&a.date));

    // star ratings at the rates played, as far as they're worked out
    let mut st = conn.prepare("SELECT hash, rate, sr FROM rate_stars WHERE version = ?1")?;
    let rated: HashMap<(String, u32), f64> = st
        .query_map([crate::analysis::VERSION], |r| Ok(((r.get::<_, String>(0)?, r.get::<_, u32>(1)?), r.get::<_, f64>(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for p in &mut plays {
        if let Some(key) = rate_key(&lib, p) {
            p.sr = rated.get(&key).copied();
        }
    }
    Ok(Merged { player, plays, lib, online })
}

/// (chart file, rate × 100) of an osu!mania play at a rate the snapshot has no star rating for.
fn rate_key(lib: &Library, p: &Play) -> Option<(String, u32)> {
    if p.mode != 3 {
        return None;
    }
    let rate = off_grid(p.rate)?;
    Some((lib.mania.get(p.map.as_ref()?)?.clone(), rate))
}

/// Works out the star ratings at played rates that aren't known yet (Fumen's calculator, from
/// the library's chart files) and keeps them.
fn rate_missing(conn: &Connection, files: &crate::paths::Files, lib: &Library, plays: &mut [Play]) -> Result<()> {
    let mut done: HashMap<(String, u32), Option<f64>> = HashMap::new();
    let mut charts: HashMap<String, Option<crate::chart::Chart>> = HashMap::new();
    let mut put = conn.prepare("INSERT OR REPLACE INTO rate_stars (hash, rate, version, sr) VALUES (?1, ?2, ?3, ?4)")?;
    for p in plays.iter_mut().filter(|p| p.sr.is_none()) {
        let Some(key) = rate_key(lib, p) else { continue };
        if !done.contains_key(&key) {
            let chart = charts.entry(key.0.clone()).or_insert_with(|| crate::charts::load(files, &key.0).ok());
            let sr = chart
                .as_ref()
                .map(|c| crate::stars::round2(crate::stars::mania(c, key.1 as f64 / 100.0)) as f64)
                .filter(|sr| *sr > 0.0);
            if let Some(sr) = sr {
                put.execute(params![key.0, key.1, crate::analysis::VERSION, sr])?;
            }
            done.insert(key.clone(), sr);
        }
        p.sr = done[&key];
    }
    Ok(())
}

/// A difficulty's best pass (by score) and how often it was played (fails too).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapBest {
    pub rank: i64,
    pub acc: f64,
    pub score: i64,
    pub plays: i64,
    pub last: Option<i64>,
}

/// The player's best per difficulty md5 (difficulties with a pass), local and from osu!.
pub fn best_per_map(conn: &Connection) -> Result<HashMap<String, MapBest>> {
    let plays = merge(conn)?.plays;
    let mut best: HashMap<String, MapBest> = HashMap::new();
    for p in plays.iter().filter(|p| !p.failed) {
        let Some(md5) = &p.md5 else { continue };
        let b = best.entry(md5.clone()).or_insert(MapBest { rank: p.rank, acc: p.acc, score: p.score, plays: 0, last: None });
        if p.score > b.score {
            (b.rank, b.acc, b.score) = (p.rank, p.acc, p.score);
        }
    }
    for p in &plays {
        if let Some(b) = p.md5.as_ref().and_then(|h| best.get_mut(h)) {
            b.plays += 1;
            b.last = b.last.max(Some(p.date));
        }
    }
    Ok(best)
}

/// Everything the history view shows, as JSON. With the chart files at hand, star ratings at
/// played osu!mania rates that aren't known yet are worked out first.
pub fn history_json(conn: &Connection, account: Option<&Account>, files: Option<&crate::paths::Files>) -> Result<Vec<u8>> {
    let Merged { player, mut plays, lib, mut online } = merge(conn)?;
    if let Some(files) = files.filter(|f| !f.is_empty()) {
        rate_missing(conn, files, &lib, &mut plays)?;
    }
    let mut most_played = Vec::new();
    if matches!(player, Player::Id(_)) {
        let mut st = conn.prepare("SELECT beatmap_id, count FROM osu_playcounts ORDER BY position")?;
        let counts: Vec<(i64, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        for (beatmap_id, count) in counts {
            let map = lib.find(beatmap_id, online.md5(beatmap_id)).map(|(m, _)| m);
            let beatmap = if map.is_none() { online.take(beatmap_id) } else { None };
            most_played.push(PlayCount { map, beatmap, beatmap_id, count });
        }
    }
    let player_out = match &player {
        Player::Id(id) => Some(PlayerOut {
            id: Some(*id),
            name: match account.filter(|a| a.id as i64 == *id) {
                Some(a) => Some(a.username.clone()),
                None => conn
                    .query_row("SELECT user FROM scores WHERE user_id = ?1 ORDER BY date DESC LIMIT 1", [id], |r| r.get(0))
                    .optional()?,
            },
        }),
        Player::Name(name) => Some(PlayerOut { id: None, name: Some(name.clone()) }),
        Player::Anyone => None,
    };
    let stats = if matches!(player, Player::Id(_)) {
        db::get_meta(conn, "osu.stats")?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_else(|| Value::Object(Map::new()))
    } else {
        Value::Object(Map::new())
    };
    let mut beatmaps = std::mem::take(&mut online.used);
    // Unicode copies of the romanised names only make the payload bigger
    for b in &mut beatmaps {
        if b.title_unicode == b.title {
            b.title_unicode.clear();
        }
        if b.artist_unicode == b.artist {
            b.artist_unicode.clear();
        }
    }
    Ok(serde_json::to_vec(&History { player: player_out, synced_at: last_sync(conn)?, plays, most_played, stats, beatmaps })?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::mock;
    use std::sync::{Arc, Mutex};

    #[test]
    fn dates() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2024-05-29T12:34:56Z"), Some(1_716_986_096_000));
        assert_eq!(parse_iso("2024-05-29T14:34:56+02:00"), Some(1_716_986_096_000));
        assert_eq!(parse_iso("2024-05-29T07:34:56.5-0500"), Some(1_716_986_096_500));
        assert_eq!(parse_iso("2000-02-29T00:00:00.123456Z"), Some(951_782_400_123));
        assert_eq!(parse_iso("1969-12-31T23:59:59Z"), Some(-1000));
        for bad in ["", "2024-05-29", "2024-13-01T00:00:00Z", "2024-05-29T12:34:56Q", "2024-05-29T12:34:56.Z", "2024-05-29T12:3x:56Z"] {
            assert_eq!(parse_iso(bad), None, "{bad}");
        }
    }

    #[test]
    fn mods_and_hits() {
        assert_eq!(mods_of(""), (vec![], None));
        assert_eq!(mods_of(r#"[{"acronym":"HD"},{"acronym":"DT"}]"#), (vec!["HD".into(), "DT".into()], Some(1.5)));
        assert_eq!(mods_of(r#"[{"acronym":"HT","settings":{"speed_change":0.9}}]"#), (vec!["HT".into()], Some(0.9)));
        assert_eq!(mods_of(r#"[{"acronym":"DT","settings":{"speed_change":1.0}}]"#), (vec!["DT".into()], None));
        assert_eq!(mods_of(r#"["NC","HR"]"#), (vec!["NC".into(), "HR".into()], Some(1.5)));
        let hits = hits_of(r#"{"great":305,"ok":0,"miss":76,"ignore_hit":3,"perfect":396}"#);
        assert_eq!(Value::Object(hits), serde_json::json!({ "perfect": 396, "great": 305, "miss": 76 }));
    }

    fn api_score(id: i64, beatmap: i64, md5: &str, date: &str, extra: &str) -> String {
        format!(
            r#"{{"id":{id},"beatmap_id":{beatmap},"ruleset_id":3,"total_score":912345,"accuracy":0.9712,"max_combo":801,
            "rank":"S","pp":123.4,"passed":true,"ended_at":"{date}","mods":[{{"acronym":"DT","settings":{{"speed_change":1.2}}}}],
            "statistics":{{"perfect":900,"great":80,"miss":2}},"legacy_score_id":null,
            "beatmap":{{"id":{beatmap},"beatmapset_id":{},"checksum":"{md5}","mode":"mania","version":"Insane","difficulty_rating":4.56,"total_length":95}},
            "beatmapset":{{"id":{},"title":"Song","title_unicode":"曲","artist":"Artist","artist_unicode":"Artist","creator":"Mapper"}}{extra}}}"#,
            beatmap / 10,
            beatmap / 10
        )
    }

    #[test]
    fn reads_scores() {
        let v: Value = serde_json::from_str(&api_score(7, 50, "abc", "2024-05-29T12:34:56Z", r#","weight":{"percentage":100}"#)).unwrap();
        let (s, b) = parse_score(&v, 0, Some(1)).unwrap();
        assert_eq!(s.id, 7);
        assert_eq!((s.beatmap_id, s.mode, s.rank, s.best_pos), (50, 3, 4, Some(1)));
        assert_eq!(s.date, 1_716_986_096_000);
        assert_eq!(s.mods, r#"[{"acronym":"DT","settings":{"speed_change":1.2}}]"#);
        let b = b.unwrap();
        assert_eq!((b.id, b.set_id, b.md5.as_deref(), b.mode, b.length), (50, Some(5), Some("abc"), Some(3), Some(95_000.0)));
        assert_eq!((b.title.as_str(), b.title_unicode.as_str()), ("Song", "曲"));

        // the old format: a fail with bare acronyms, "score" and "created_at"
        let old = serde_json::json!({ "id": 8, "beatmap": { "id": 51 }, "score": 1000, "rank": "F", "mods": ["HD"],
            "created_at": "2020-01-01T00:00:00+00:00", "statistics": { "count_300": 1 } });
        let (s, _) = parse_score(&old, 1, None).unwrap();
        assert_eq!((s.mode, s.total_score, s.passed, s.rank), (1, 1000, false, -1));
        assert_eq!(s.mods, r#"[{"acronym":"HD"}]"#);
        // no id or no date: not a score
        assert!(parse_score(&serde_json::json!({ "beatmap_id": 1, "ended_at": "2020-01-01T00:00:00Z" }), 0, None).is_none());
        assert!(parse_score(&serde_json::json!({ "id": 1, "beatmap_id": 1 }), 0, None).is_none());
    }

    fn temp_db(name: &str) -> (std::path::PathBuf, Connection) {
        let dir = std::env::temp_dir().join(format!("fumen-osu-scores-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO sets (id, title) VALUES ('s1', 'Song');
             INSERT INTO maps (id, set_id, online_id, version, ruleset, ruleset_id, md5) VALUES
                ('m1', 's1', 50, 'Insane', 'mania', 3, 'abc'),
                ('m2', 's1', 60, 'Hard', 'mania', 3, 'new-md5');
             INSERT INTO scores (id, map_md5, ruleset, total_score, accuracy, max_combo, rank, date, mods, statistics, online_id, user, user_id) VALUES
                ('l1', 'abc', 'mania', 900000, 0.97, 800, 4, 1716986096000, '', '{\"perfect\":10}', 7, 'Me', 2),
                ('l2', 'abc', 'mania', 950000, 0.98, 810, 4, 1716990000000, '[{\"acronym\":\"HT\"}]', '{}', -1, 'Me', 2),
                ('l3', 'new-md5', 'mania', 700000, 0.91, 300, 3, 1600000000000, '[{\"acronym\":\"CL\"}]', '{}', 0, 'Old name', 2),
                ('l4', 'abc', 'mania', 999999, 1.0, 900, 7, 1716000000000, '', '{}', 99, 'Someone else', 3),
                ('l5', 'gone', 'Touhosu', 1000, 0.5, 10, 0, 1500000000000, '', '{}', -1, 'Me', 2);",
        )
        .unwrap();
        (dir, conn)
    }

    #[test]
    fn merges_local_and_osu() {
        let (dir, mut conn) = temp_db("merge");
        // not logged in: lazer's most frequent player (user id 2), nothing from osu!
        assert_eq!(Player::detect(&conn).unwrap(), Player::Id(2));
        let plays = merge(&conn).unwrap().plays;
        assert_eq!(plays.len(), 4);
        assert!(plays.iter().all(|p| p.source == "lazer"));
        assert_eq!(plays[0].mods, vec!["HT".to_string()]);
        assert_eq!(plays[0].rate, Some(0.75));
        assert_eq!((plays[3].mode, plays[3].ruleset.as_deref(), plays[3].map.as_deref()), (-1, Some("Touhosu"), None));

        let beatmap = |id: i64, md5: Option<&str>| ApiBeatmap {
            id,
            set_id: Some(id / 10),
            md5: md5.map(str::to_string),
            mode: Some(3),
            version: format!("Diff {id}"),
            sr: Some(4.0),
            length: Some(90_000.0),
            title: "Song".into(),
            title_unicode: "Song".into(),
            artist: "Artist".into(),
            artist_unicode: String::new(),
            creator: "Mapper".into(),
        };
        let score = |id: i64, beatmap_id: i64, date: i64, acc: f64, best_pos: Option<i64>| ApiScore {
            id,
            beatmap_id,
            mode: 3,
            total_score: 800_000,
            accuracy: acc,
            max_combo: 500,
            rank: 3,
            pp: Some(100.0 + id as f64),
            passed: true,
            date,
            mods: "[]".into(),
            statistics: r#"{"great":5}"#.into(),
            legacy_id: None,
            best_pos,
        };
        let mut f = Fetched { user_id: 2, ..Default::default() };
        f.modes = vec![3];
        // l1 on osu! (same id): one play, with pp and top position
        f.scores.push(score(7, 50, 1_716_986_096_000, 0.97, Some(1)));
        // l3 came from stable (no online id): same difficulty (osu!'s md5 is older, found by id), time and accuracy
        f.scores.push(score(8, 60, 1_600_000_030_000, 0.91, Some(2)));
        // played on another computer, in the library
        f.scores.push(score(9, 50, 1_700_000_000_000, 0.95, None));
        // not in the library
        f.scores.push(score(10, 70, 1_800_000_000_000, 0.99, Some(3)));
        let mut failed = score(11, 70, 1_800_000_100_000, 0.5, None);
        (failed.passed, failed.rank) = (false, -1);
        f.scores.push(failed);
        for b in [beatmap(50, Some("abc")), beatmap(60, Some("old-md5")), beatmap(70, Some("xyz")), beatmap(80, None)] {
            f.beatmaps.insert(b.id, b);
        }
        f.playcounts = vec![(70, 40), (50, 12), (80, 3)];
        f.stats.insert("mania".into(), serde_json::json!({ "pp": 1234.5 }));
        let summary = store(&mut conn, &f).unwrap();
        assert_eq!((summary.added, summary.total), (5, 5));

        let plays = merge(&conn).unwrap().plays;
        assert_eq!(plays.len(), 7, "{plays:#?}");
        let by_id = |id: i64| plays.iter().find(|p| p.id == Some(id)).unwrap();
        assert_eq!((by_id(7).source, by_id(7).pp, by_id(7).top, by_id(7).map.as_deref()), ("both", Some(107.0), Some(1), Some("m1")));
        assert_eq!((by_id(8).source, by_id(8).top, by_id(8).map.as_deref()), ("both", Some(2), Some("m2")));
        assert_eq!((by_id(9).source, by_id(9).map.as_deref()), ("osu", Some("m1")));
        assert_eq!((by_id(10).source, by_id(10).map.as_deref(), by_id(10).beatmap), ("osu", None, Some(0)));
        assert!(by_id(11).failed);
        assert!(plays.windows(2).all(|w| w[0].date >= w[1].date));

        // the library's best per difficulty: the best pass (other players' scores don't count), every play
        let best = best_per_map(&conn).unwrap();
        assert_eq!(best["abc"], MapBest { rank: 4, acc: 0.98, score: 950_000, plays: 3, last: Some(1_716_990_000_000) });
        assert_eq!(best["new-md5"].plays, 1);
        assert_eq!((best["xyz"].plays, best["xyz"].acc, best["xyz"].last), (2, 0.99, Some(1_800_000_100_000)));

        let h: Value = serde_json::from_slice(&history_json(&conn, None, None).unwrap()).unwrap();
        assert_eq!(h["player"], serde_json::json!({ "id": 2, "name": "Me" }));
        assert_eq!(h["stats"]["mania"]["pp"], 1234.5);
        assert_eq!(h["beatmaps"].as_array().unwrap().len(), 2, "{}", h["beatmaps"]);
        assert_eq!(h["beatmaps"][0]["id"], 70);
        assert!(h["beatmaps"][0].get("artistUnicode").is_none());
        assert_eq!(h["mostPlayed"], serde_json::json!([
            { "beatmap": 0, "beatmapId": 70, "count": 40 },
            { "map": "m1", "beatmapId": 50, "count": 12 },
            { "beatmap": 1, "beatmapId": 80, "count": 3 },
        ]));

        // the next sync: the top plays moved
        let mut again = Fetched { user_id: 2, modes: vec![3], ..Default::default() };
        again.scores.push(score(10, 70, 1_800_000_000_000, 0.99, Some(1)));
        assert_eq!(store(&mut conn, &again).unwrap().added, 0);
        let top: Vec<(i64, Option<i64>)> = conn
            .prepare("SELECT id, best_pos FROM osu_scores ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(top, vec![(7, None), (8, None), (9, None), (10, Some(1)), (11, None)]);
        // one difficulty's scores keep their top position
        store_map(&mut conn, 2, &[score(10, 70, 1_800_000_000_000, 0.99, None)]).unwrap();
        assert_eq!(conn.query_row("SELECT best_pos FROM osu_scores WHERE id = 10", [], |r| r.get::<_, Option<i64>>(0)).unwrap(), Some(1));

        // another account logs in: the old one's osu! data goes
        set_user(&conn, 5).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM osu_scores", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(Player::detect(&conn).unwrap(), Player::Id(5));
        clear(&conn).unwrap();
        assert_eq!(Player::detect(&conn).unwrap(), Player::Id(2));
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stars_at_played_rates() {
        let (dir, conn) = temp_db("rates");
        // a small 4K chart in a lazer-style file store
        let mut osu = String::from("osu file format v14\n[General]\nMode: 3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[TimingPoints]\n0,300,4,1,0,100,1,0\n[HitObjects]\n");
        for i in 0..400 {
            osu.push_str(&format!("{},192,{},1,0,0:0:0:0:\n", 64 + 128 * (i % 4), 1000 + i * 90));
        }
        let hash = "ab".repeat(32);
        let storage = dir.join("storage");
        let file = crate::paths::lazer_file(&storage, &hash).unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, &osu).unwrap();
        conn.execute("UPDATE maps SET hash = ?1 WHERE id = 'm1'", [&hash]).unwrap();
        conn.execute_batch(
            "UPDATE scores SET mods = '[{\"acronym\":\"HT\",\"settings\":{\"speed_change\":0.9}}]' WHERE id = 'l1';
             UPDATE scores SET mods = '[{\"acronym\":\"DT\"}]' WHERE id = 'l2';",
        )
        .unwrap();
        let want = crate::stars::round2(crate::stars::mania(&crate::chart::parse(&osu), 0.9)) as f64;
        assert!(want > 0.0);
        assert_eq!(off_grid(Some(0.9)), Some(90));
        assert_eq!(off_grid(Some(1.5)), None);
        assert_eq!(off_grid(None), None);

        // not worked out yet: nothing
        let sr = |plays: &[Play], rate: f64| plays.iter().find(|p| p.rate == Some(rate)).unwrap().sr;
        assert_eq!(sr(&merge(&conn).unwrap().plays, 0.9), None);
        // worked out for the history, and kept: 0.9× gets one, DT (1.5×, in the snapshot) doesn't
        let h: Value = serde_json::from_slice(&history_json(&conn, None, Some(&crate::paths::Files::lazer(&storage))).unwrap()).unwrap();
        let played = |rate: f64| h["plays"].as_array().unwrap().iter().find(|p| p["rate"] == rate).unwrap().clone();
        assert_eq!(played(0.9)["sr"], want);
        assert!(played(1.5).get("sr").is_none());
        let plays = merge(&conn).unwrap().plays;
        assert_eq!(sr(&plays, 0.9), Some(want));
        assert_eq!(sr(&plays, 1.5), None);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stable_plays_in_the_history() {
        let (dir, conn) = temp_db("stable");
        conn.execute_batch(
            "DELETE FROM scores;
             INSERT INTO scores (id, map_md5, ruleset, accuracy, date, user, user_id) VALUES
                ('lazer-1', 'abc', 'mania', 0.9, 1000000, 'Me', 42),
                -- the same play: lazer imported it from stable
                ('st-r1', 'abc', 'mania', 0.9, 1000500, 'Me', NULL),
                ('st-r2', 'abc', 'mania', 0.8, 5000000, 'Me', NULL),
                -- someone else on this computer
                ('st-r3', 'abc', 'mania', 0.7, 6000000, 'Sibling', NULL);",
        )
        .unwrap();
        let plays = merge(&conn).unwrap().plays;
        assert_eq!(plays.iter().map(|p| (p.acc, p.stable)).collect::<Vec<_>>(), [(0.8, true), (0.9, false)]);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn player_by_name() {
        let (dir, conn) = temp_db("name");
        conn.execute_batch(
            "DELETE FROM scores;
             INSERT INTO scores (id, map_md5, ruleset, date, user, user_id) VALUES
                ('a', 'abc', 'mania', 1, 'Guest player', 1), ('b', 'abc', 'mania', 2, 'Guest player', 1), ('c', 'abc', 'mania', 3, 'Other', 9);",
        )
        .unwrap();
        assert_eq!(Player::detect(&conn).unwrap(), Player::Name("Guest player".into()));
        assert_eq!(merge(&conn).unwrap().plays.len(), 2);
        conn.execute("DELETE FROM scores", []).unwrap();
        assert_eq!(Player::detect(&conn).unwrap(), Player::Anyone);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Syncs Fumen's real library (a copy) with osu! and prints what came back. Uses the stored
    /// login only while its token is fresh: renewing it would rotate the refresh token and log the
    /// real app out. `FUMEN_HISTORY_OUT` / `FUMEN_SNAPSHOT_OUT`: also write the history / library
    /// snapshot JSON there (the browser preview's tools/browser-preview/.cache/history.json and
    /// snapshot.json).
    ///   cargo test --lib osu_scores::tests::real_library -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library() {
        let data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.fumen.app");
        let dir = std::env::temp_dir().join(format!("fumen-real-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["library.db", "library.db-wal", "osu-account.json"] {
            let _ = std::fs::copy(data.join(name), dir.join(name));
        }
        let mut conn = db::open(&dir.join("library.db")).unwrap();
        let stored: Value = serde_json::from_slice(&std::fs::read(dir.join("osu-account.json")).unwrap_or_default()).unwrap_or_default();
        let fresh = stored["tokens"]["expires_at"].as_i64().unwrap_or(0) - crate::lazer::now_ms() > 10 * 60 * 1000;
        if let (true, Some(account)) = (fresh, crate::osu_auth::account(&dir)) {
            let ep = Endpoints::default();
            let token = stored["tokens"]["access"].as_str().unwrap();
            let t = std::time::Instant::now();
            let f = fetch(&ep, token, &account).unwrap();
            println!("fetched in {:?}: {} scores, {} beatmaps, {} play counts, modes {:?}", t.elapsed(), f.scores.len(), f.beatmaps.len(), f.playcounts.len(), f.modes);
            for (name, st) in &f.stats {
                println!("  {name}: pp {} rank {} acc {} plays {} time {}", st["pp"], st["rank"], st["accuracy"], st["playCount"], st["playTime"]);
            }
            for s in f.scores.iter().filter(|s| s.best_pos.is_some()).take(3) {
                println!("  top {:?}: {:?}", s.best_pos, s);
            }
            println!("{:?}", store(&mut conn, &f).unwrap());
        } else {
            println!("no fresh login: local scores only");
        }
        let t = std::time::Instant::now();
        let files = crate::paths::default_lazer_dir().and_then(|d| crate::paths::inspect_lazer(&d)).map(|i| crate::paths::Files::lazer(i.storage));
        let json = history_json(&conn, crate::osu_auth::account(&dir).as_ref(), files.as_ref()).unwrap();
        if let Some(out) = std::env::var_os("FUMEN_HISTORY_OUT") {
            std::fs::write(out, &json).unwrap();
        }
        if let Some(out) = std::env::var_os("FUMEN_SNAPSHOT_OUT") {
            std::fs::write(out, crate::library::snapshot_json(&conn).unwrap()).unwrap();
        }
        let h: Value = serde_json::from_slice(&json).unwrap();
        let plays = h["plays"].as_array().unwrap();
        let count = |src: &str| plays.iter().filter(|p| p["source"] == src).count();
        println!(
            "history in {:?}: {} KB, {} plays (lazer {}, osu {}, both {}), {} not in the library, {} most played, player {}",
            t.elapsed(), json.len() / 1024, plays.len(), count("lazer"), count("osu"), count("both"),
            h["beatmaps"].as_array().unwrap().len(), h["mostPlayed"].as_array().unwrap().len(), h["player"]
        );
        println!("newest: {}", plays.first().unwrap_or(&Value::Null));
        let t = std::time::Instant::now();
        let best = best_per_map(&conn).unwrap();
        println!("best for {} difficulties in {:?}", best.len(), t.elapsed());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn syncs_from_osu() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c = calls.clone();
        let osu = mock(Box::new(move |_, path, auth, _| {
            c.lock().unwrap().push(path.to_string());
            if auth != "Bearer t" {
                return (401, "{}".into());
            }
            let score = |id: i64, beatmap: i64| api_score(id, beatmap, &format!("md5-{beatmap}"), "2024-05-29T12:34:56Z", "");
            let (path, query) = path.split_once('?').unwrap_or((path, ""));
            match path {
                "/api/v2/users/2/mania" => (200, r#"{"statistics":{"play_count":10,"pp":500.5,"hit_accuracy":97.5},"rank_history":{"data":[9,8,7]}}"#.into()),
                "/api/v2/users/2/osu" | "/api/v2/users/2/taiko" | "/api/v2/users/2/fruits" => (200, r#"{"statistics":{"play_count":0}}"#.into()),
                // a full first page of top plays, then the rest
                "/api/v2/users/2/scores/best" if query.contains("offset=0") => {
                    (200, format!("[{}]", (0..100).map(|i| score(100 + i, 1000 + i)).collect::<Vec<_>>().join(",")))
                }
                "/api/v2/users/2/scores/best" => (200, format!("[{}]", score(200, 2000))),
                "/api/v2/users/2/scores/recent" => (200, format!("[{},{}]", score(100, 1000), score(300, 3000))),
                "/api/v2/users/2/beatmapsets/most_played" => (
                    200,
                    r#"[{"beatmap_id":1000,"count":30,"beatmap":{"id":1000,"version":"V"},"beatmapset":{"title":"T"}},{"beatmap_id":4000,"count":2,"beatmap":{"id":4000,"version":"W","beatmapset_id":400},"beatmapset":{"id":400,"title":"U","artist":"A","creator":"C"}}]"#.into(),
                ),
                "/api/v2/beatmaps/1000/scores/users/2/all" => (200, format!(r#"{{"scores":[{}, {}]}}"#, score(100, 1000), score(500, 1000))),
                "/api/v2/beatmaps/9/scores/users/2/all" => (404, "{}".into()),
                _ => (404, "{}".into()),
            }
        }));
        let ep = Endpoints { site: osu.clone(), osu };
        let account = Account {
            id: 2,
            username: "Me".into(),
            avatar: None,
            country: None,
            mode: Some("mania".into()),
            rank: None,
            country_rank: None,
            pp: None,
        };
        let f = fetch(&ep, "t", &account).unwrap();
        // the main ruleset first; rulesets never played get no score requests
        let seen = calls.lock().unwrap().clone();
        assert!(seen[0].starts_with("/api/v2/users/2/mania"), "{seen:?}");
        assert!(!seen.iter().any(|p| p.contains("mode=osu")), "{seen:?}");
        assert!(seen.iter().any(|p| p.contains("include_fails=1")));
        assert_eq!(f.modes, vec![3]);
        assert_eq!(f.scores.len(), 102);
        assert_eq!(f.scores.iter().find(|s| s.id == 100).unwrap().best_pos, Some(1));
        assert_eq!(f.scores.iter().find(|s| s.id == 200).unwrap().best_pos, Some(101));
        assert_eq!(f.scores.iter().find(|s| s.id == 300).unwrap().best_pos, None);
        assert_eq!(f.playcounts, vec![(1000, 30), (4000, 2)]);
        // the score's copy of a difficulty wins over the play count's
        assert_eq!(f.beatmaps[&1000].md5.as_deref(), Some("md5-1000"));
        assert_eq!(f.beatmaps[&4000].title, "U");
        assert_eq!(f.stats["mania"]["accuracy"], 0.975);
        assert_eq!(f.stats["mania"]["rankHistory"], serde_json::json!([9, 8, 7]));
        assert_eq!(f.stats["osu"]["playCount"], 0);

        let one = fetch_map(&ep, "t", 2, 1000, &[3, -1, 7]).unwrap();
        assert_eq!(one.iter().map(|s| s.id).collect::<Vec<_>>(), vec![100, 500]);
        assert!(fetch_map(&ep, "t", 2, 9, &[3]).unwrap().is_empty());
        assert_eq!(fetch(&ep, "expired", &account).unwrap_err().code(), "osu-logged-out");
    }

    #[test]
    fn played_sets_go_through_every_page() {
        let busy = Arc::new(Mutex::new(1));
        let b = busy.clone();
        let osu = mock(Box::new(move |_, path, _, _| {
            let (path, query) = path.split_once('?').unwrap_or((path, ""));
            if path == "/api/v2/users/2/scores/best" {
                // one top play in mania on a set without a play count, one on set 1
                let page = if query.contains("mode=mania") && query.contains("offset=0") {
                    r#"[{"beatmap_id":900,"beatmap":{"id":900,"beatmapset_id":300},"beatmapset":{"id":300,"title":"Top","artist":"A","creator":"C","status":"loved"}},
                        {"beatmap_id":0,"beatmap":{"id":0,"beatmapset_id":1},"beatmapset":{"id":1,"title":"T1","artist":"A","creator":"C","status":"ranked"}}]"#
                } else {
                    "[]"
                };
                return (200, page.into());
            }
            if path != "/api/v2/users/2/beatmapsets/most_played" {
                return (404, "{}".into());
            }
            // one "slow down" on the way
            if query.contains("offset=100") && std::mem::take(&mut *b.lock().unwrap()) == 1 {
                return (429, "{}".into());
            }
            let item = |beatmap: i64, set: i64, count: i64| {
                format!(r#"{{"beatmap_id":{beatmap},"count":{count},"beatmap":{{"id":{beatmap},"beatmapset_id":{set}}},"beatmapset":{{"id":{set},"title":"T{set}","artist":"A","creator":"C","status":"ranked"}}}}"#)
            };
            let page: Vec<String> = if query.contains("offset=0") {
                // a full page: 50 sets with two difficulties each
                (0..100).map(|i| item(i, 1 + i / 2, 1)).collect()
            } else if query.contains("offset=100") {
                vec![item(500, 1, 10), item(501, 99, 3)]
            } else {
                vec![]
            };
            (200, format!("[{}]", page.join(",")))
        }));
        let ep = Endpoints { site: osu.clone(), osu };
        let mut seen = Vec::new();
        let mut all = PlayedSets::default();
        played_sets(&ep, "t", 2, &mut all, |n| seen.push(n)).unwrap();
        // play counts, then the top plays of each ruleset (mania's: 2)
        assert_eq!(seen, vec![100, 102, 102, 102, 102, 104]);

        // a synced score on set 99 (known) and on set 400 (only Fumen has it)
        let dir = std::env::temp_dir().join(format!("fumen-played-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = db::open(&dir.join("t.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO osu_beatmaps (id, set_id, title, artist, creator) VALUES (501, 99, 'T99', 'A', 'C'), (700, 400, 'Old', 'B', 'D');
             INSERT INTO osu_scores (id, user_id, beatmap_id, mode, total_score, accuracy, max_combo, rank, passed, date, mods, statistics, best_pos)
             VALUES (1, 2, 501, 3, 1, 1.0, 1, 1, 1, 0, '[]', '{}', NULL), (2, 2, 700, 3, 1, 1.0, 1, 1, 1, 0, '[]', '{}', 5),
                    (3, 3, 800, 3, 1, 1.0, 1, 1, 1, 0, '[]', '{}', NULL);",
        )
        .unwrap();
        synced_sets(&conn, 2, &mut all).unwrap();
        let sets = all.into_sorted();
        assert_eq!(sets.len(), 53);
        // set 1: two difficulties at 1 play, one more at 10; its top play is on one of them
        assert_eq!((sets[0].id, sets[0].plays, sets[0].maps, sets[0].top), (1, 12, 3, true));
        // set 99: its difficulty counted once though synced too
        assert_eq!((sets[1].id, sets[1].plays, sets[1].maps, sets[1].title.as_str()), (99, 3, 1, "T99"));
        assert_eq!(sets[2].status, "ranked");
        let top = sets.iter().find(|s| s.id == 300).unwrap();
        assert_eq!((top.plays, top.top, top.status.as_str(), top.title.as_str()), (0, true, "loved", "Top"));
        let old = sets.iter().find(|s| s.id == 400).unwrap();
        assert_eq!((old.top, old.title.as_str(), old.status.as_str()), (true, "Old", ""));
    }
}
