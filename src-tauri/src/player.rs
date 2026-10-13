//! Another osu! player's osu!mania plays, for comparing skills on the Skills page.
//!
//! Their plays come from osu!'s API with the logged-in player's token: top plays, first places,
//! recent passes, and their best score on their most played difficulties. The charts behind the
//! plays come from the library when it has them, else as single `.osu` files from the mirrors
//! (never from osu!'s servers; kept in Fumen's cache), and are analysed like the library's:
//! pattern shares and Fumen's star ratings at 0.75×, 1.5× and any rate played. The Skills page
//! works the skills out of that the same way as the player's own (lib/skills.ts).
//!
//! osu!'s API is asked politely: one request at a time with a pause between, and only so many
//! most-played difficulties looked up.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};
use crate::osu_auth::{api_get, Endpoints};
use crate::osu_scores::{list, mode_of, mods_of, parse_beatmap, parse_score, ApiBeatmap, ApiScore};

const MANIA: i64 = 3;
/// top plays: osu! keeps 200 (100 a page)
const TOP_PAGES: usize = 2;
/// most played: pages read (100 each, every ruleset mixed), and osu!mania difficulties at most
/// asked for the player's best score (one request each)
const MOST_PLAYED_PAGES: usize = 3;
const MOST_PLAYED_LOOKUPS: usize = 60;
/// between two requests to osu!'s API
const API_GAP: Duration = Duration::from_millis(350);
/// osu! asked to slow down: wait this long, a few times
const BUSY_WAIT: Duration = Duration::from_secs(20);
const BUSY_TRIES: usize = 3;
/// charts fetched and analysed at once (one mirror each to start with)
const CHART_WORKERS: usize = 3;
/// cached chart files older than this are dropped
const CACHE_DAYS: u64 = 60;

/// How far along a comparison is: `stage` "player" (finding them), "scores" (`done` of about
/// `total` requests to osu!), "charts" (`done` of `total` charts read).
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub stage: &'static str,
    pub done: usize,
    pub total: usize,
}

/// What osu! has on the player.
#[derive(Debug, Default)]
pub struct Fetched {
    pub user: Value,
    /// osu!mania scores, each once
    pub scores: Vec<ApiScore>,
    /// the difficulties as osu! described them
    pub beatmaps: HashMap<i64, ApiBeatmap>,
    pub counts: Counts,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub top: usize,
    pub firsts: usize,
    pub recent: usize,
    /// best scores found on most played difficulties
    pub most_played: usize,
}

struct Api<'a> {
    ep: &'a Endpoints,
    token: &'a str,
    cancel: &'a AtomicBool,
    calls: usize,
}

impl Api<'_> {
    fn get(&mut self, path: &str) -> Result<Value> {
        let gap = |d: Duration| if cfg!(test) { Duration::ZERO } else { d };
        let mut tries = 0;
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                return Err(Error::known("cancelled", "Cancelled"));
            }
            if self.calls > 0 {
                std::thread::sleep(gap(API_GAP));
            }
            self.calls += 1;
            match api_get(self.ep, self.token, path) {
                Err(e) if e.code() == "osu-busy" && tries < BUSY_TRIES => {
                    tries += 1;
                    std::thread::sleep(gap(BUSY_WAIT));
                }
                r => return r,
            }
        }
    }
}

/// A name as one piece of a URL path.
fn encode(name: &str) -> String {
    name.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn is_mania(b: &Value) -> bool {
    b["mode_int"].as_i64().or_else(|| b["mode"].as_str().and_then(mode_of)) == Some(MANIA)
}

/// The player called `name` and their osu!mania plays.
pub fn fetch(ep: &Endpoints, token: &str, name: &str, cancel: &AtomicBool, mut progress: impl FnMut(Progress)) -> Result<Fetched> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::known("player-not-found", "Type a player's name."));
    }
    let mut api = Api { ep, token, cancel, calls: 0 };
    progress(Progress { stage: "player", done: 0, total: 0 });
    let user = match api.get(&format!("users/{}/mania?key=username", encode(name))) {
        Err(e) if e.code() == "osu-not-found" => return Err(Error::known("player-not-found", format!("osu! has no player called {name}."))),
        r => r?,
    };
    let id = user["id"].as_i64().ok_or_else(|| Error::known("player-not-found", format!("osu! has no player called {name}.")))?;
    let mut f = Fetched { user, ..Default::default() };
    let mut seen = HashSet::new();
    let mut add = |f: &mut Fetched, v: &Value, best_pos: Option<i64>| -> bool {
        let Some((score, beatmap)) = parse_score(v, MANIA, best_pos) else { return false };
        if score.mode != MANIA || beatmap.as_ref().is_some_and(|b| b.mode.is_some_and(|m| m != MANIA)) || !seen.insert(score.id) {
            return false;
        }
        if let Some(b) = beatmap {
            f.beatmaps.insert(b.id, b);
        }
        f.scores.push(score);
        true
    };
    // requests so far / about how many there'll be (the lookups are counted once known)
    let mut planned = 1 + TOP_PAGES + 2 + MOST_PLAYED_PAGES;
    let mut step = |api: &Api, planned: usize| progress(Progress { stage: "scores", done: api.calls, total: planned.max(api.calls) });

    for page in 0..TOP_PAGES {
        let offset = page * 100;
        let top = api.get(&format!("users/{id}/scores/best?mode=mania&limit=100&offset={offset}"))?;
        for (i, s) in list(&top).iter().enumerate() {
            f.counts.top += add(&mut f, s, Some((offset + i + 1) as i64)) as usize;
        }
        step(&api, planned);
        if list(&top).len() < 100 {
            planned -= TOP_PAGES - page - 1;
            break;
        }
    }
    let firsts = api.get(&format!("users/{id}/scores/firsts?mode=mania&limit=100"))?;
    for s in list(&firsts) {
        f.counts.firsts += add(&mut f, s, None) as usize;
    }
    step(&api, planned);
    let recent = api.get(&format!("users/{id}/scores/recent?mode=mania&limit=100&include_fails=0"))?;
    for s in list(&recent) {
        f.counts.recent += add(&mut f, s, None) as usize;
    }
    step(&api, planned);

    // their most played osu!mania difficulties without a score yet: their best there
    let scored: HashSet<i64> = f.scores.iter().map(|s| s.beatmap_id).collect();
    let mut lookups: Vec<i64> = Vec::new();
    for page in 0..MOST_PLAYED_PAGES {
        let items = api.get(&format!("users/{id}/beatmapsets/most_played?limit=100&offset={}", page * 100))?;
        for item in list(&items) {
            if !is_mania(&item["beatmap"]) {
                continue;
            }
            let Some(b) = parse_beatmap(&item["beatmap"], &item["beatmapset"]) else { continue };
            if !scored.contains(&b.id) && !lookups.contains(&b.id) && lookups.len() < MOST_PLAYED_LOOKUPS {
                lookups.push(b.id);
            }
            f.beatmaps.entry(b.id).or_insert(b);
        }
        let last = list(&items).len() < 100 || lookups.len() >= MOST_PLAYED_LOOKUPS;
        if last {
            planned -= MOST_PLAYED_PAGES - page - 1;
        }
        planned += if last { lookups.len() } else { 0 };
        step(&api, planned);
        if last {
            break;
        }
    }
    for beatmap in lookups {
        match api.get(&format!("beatmaps/{beatmap}/scores/users/{id}?mode=mania")) {
            // no score of theirs osu! keeps there (unranked, or only fails)
            Err(e) if e.code() == "osu-not-found" => {}
            Err(e) => return Err(e),
            Ok(v) => f.counts.most_played += add(&mut f, &v["score"], None) as usize,
        }
        step(&api, planned);
    }
    Ok(f)
}

// ── charts ──────────────────────────────────────────────────────────────

/// A difficulty the plays are on, analysed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartOut {
    /// "o<osu!'s id>"; the plays point at it
    id: String,
    beatmap_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    set_id: Option<i64>,
    mode: i64,
    /// keys
    cs: f64,
    /// lazer's star rating (osu!'s), Fumen's where osu! gave none
    sr: f64,
    sr_ht: f64,
    sr_dt: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    shares: Option<[u8; 6]>,
    version: String,
    title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    title_unicode: String,
    artist: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    artist_unicode: String,
    creator: String,
    /// the library's difficulty, when it has this one
    #[serde(skip_serializing_if = "Option::is_none")]
    library: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayOut {
    map: String,
    beatmap_id: i64,
    mode: i64,
    date: i64,
    rank: i64,
    acc: f64,
    score: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pp: Option<f64>,
    combo: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rate: Option<f64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    failed: bool,
    /// the star rating at a rate other than 0.75×, 1× and 1.5×
    #[serde(skip_serializing_if = "Option::is_none")]
    sr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    top: Option<i64>,
    id: i64,
    source: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerOut {
    id: i64,
    name: String,
    avatar: Option<String>,
    country: Option<String>,
    rank: Option<i64>,
    country_rank: Option<i64>,
    pp: Option<f64>,
    accuracy: Option<f64>,
    play_count: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    player: PlayerOut,
    charts: Vec<ChartOut>,
    plays: Vec<PlayOut>,
    counts: Counts,
    /// difficulties played whose chart no mirror had
    unreadable: usize,
}

/// The library's osu!mania difficulties: by md5 and by osu!'s id → (difficulty id, chart key).
struct Library {
    by_md5: HashMap<String, (String, String)>,
    by_online: HashMap<i64, (String, String)>,
}

impl Library {
    fn read(conn: &Connection) -> Result<Library> {
        let mut lib = Library { by_md5: HashMap::new(), by_online: HashMap::new() };
        // lazer's first, like everywhere
        let mut st = conn.prepare(
            "SELECT m.id, m.md5, m.online_id, m.hash FROM maps m JOIN sets s ON s.id = m.set_id
             WHERE m.ruleset_id = 3 AND m.hash IS NOT NULL ORDER BY s.source = 'stable'",
        )?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let entry = (r.get::<_, String>(0)?, r.get::<_, String>(3)?);
            if let Some(online) = r.get::<_, Option<i64>>(2)?.filter(|v| *v > 0) {
                lib.by_online.entry(online).or_insert_with(|| entry.clone());
            }
            if let Some(md5) = r.get::<_, Option<String>>(1)? {
                lib.by_md5.entry(md5).or_insert(entry);
            }
        }
        Ok(lib)
    }

    fn find(&self, beatmap: i64, md5: Option<&str>) -> Option<&(String, String)> {
        md5.and_then(|h| self.by_md5.get(h)).or_else(|| self.by_online.get(&beatmap))
    }
}

/// Where a difficulty's file from the mirrors is kept: by id and md5, so an updated difficulty is
/// fetched again.
fn cache_file(dir: &Path, beatmap: i64, md5: Option<&str>) -> PathBuf {
    dir.join(format!("{beatmap}-{}.osu", md5.filter(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or("x")))
}

/// Drops cached chart files nobody has needed for a while.
fn tidy_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let old = Duration::from_secs(CACHE_DAYS * 86_400);
    for e in entries.flatten() {
        if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().is_ok_and(|age| age > old)) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The `[Metadata]` lines of a chart file.
fn metadata(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut inside = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            inside = line == "[Metadata]";
            continue;
        }
        if inside {
            if let Some((k, v)) = line.split_once(':') {
                out.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    out
}

fn off_grid(rate: Option<f64>) -> Option<u32> {
    let key = (rate? * 100.0).round();
    (key > 0.0 && ![75.0, 100.0, 150.0].contains(&key)).then_some(key as u32)
}

/// One chart analysed: the chart's row and its star ratings at the rates (× 100) played.
fn analyse(beatmap: i64, text: &str, api: Option<&ApiBeatmap>, rates: &[u32], library: Option<String>) -> Option<(ChartOut, HashMap<u32, f64>)> {
    let chart = crate::chart::parse(text);
    if chart.mode != 3 || chart.keys == 0 {
        return None;
    }
    let a = crate::analysis::analyse(&chart);
    let shares = serde_json::to_string(&a.patterns).ok().and_then(|j| crate::analysis::shares_percent(&j));
    let rated = |rate: f64| crate::stars::round2(crate::stars::mania(&chart, rate)) as f64;
    let meta = metadata(text);
    let m = |k: &str| meta.get(k).cloned().unwrap_or_default();
    let pick = |api: Option<&String>, k: &str| api.filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| m(k));
    let out = ChartOut {
        id: format!("o{beatmap}"),
        beatmap_id: beatmap,
        set_id: api.and_then(|b| b.set_id).or_else(|| m("BeatmapSetID").parse().ok().filter(|v: &i64| *v > 0)),
        mode: MANIA,
        cs: chart.keys as f64,
        sr: api.and_then(|b| b.sr).filter(|v| *v > 0.0).unwrap_or_else(|| rated(1.0)),
        sr_ht: rated(0.75),
        sr_dt: rated(1.5),
        shares,
        version: pick(api.map(|b| &b.version), "Version"),
        title: pick(api.map(|b| &b.title), "Title"),
        title_unicode: pick(api.map(|b| &b.title_unicode), "TitleUnicode"),
        artist: pick(api.map(|b| &b.artist), "Artist"),
        artist_unicode: pick(api.map(|b| &b.artist_unicode), "ArtistUnicode"),
        creator: pick(api.map(|b| &b.creator), "Creator"),
        library,
    };
    let at = rates.iter().map(|&r| (r, rated(r as f64 / 100.0))).collect();
    Some((out, at))
}

/// The comparison as JSON for the Skills page: the player, the charts analysed, their plays.
/// `files` reads the library's charts; `cache` keeps the ones from the mirrors.
pub fn build(
    conn: &Connection,
    files: &crate::paths::Files,
    cache: &Path,
    f: Fetched,
    cancel: &AtomicBool,
    progress: impl Fn(Progress) + Sync,
) -> Result<Vec<u8>> {
    let lib = Library::read(conn)?;
    std::fs::create_dir_all(cache)?;
    tidy_cache(cache);

    // each difficulty once, with the rates it was played at
    let mut rates: HashMap<i64, Vec<u32>> = HashMap::new();
    for s in &f.scores {
        let entry = rates.entry(s.beatmap_id).or_default();
        if let Some(r) = off_grid(mods_of(&s.mods).1) {
            if !entry.contains(&r) {
                entry.push(r);
            }
        }
    }
    let jobs: Vec<i64> = {
        let mut ids: Vec<i64> = rates.keys().copied().collect();
        ids.sort_unstable();
        ids
    };
    let total = jobs.len();
    let queue = Mutex::new(VecDeque::from(jobs));
    let done = AtomicUsize::new(0);
    let unreadable = AtomicUsize::new(0);
    let results: Mutex<Vec<(ChartOut, HashMap<u32, f64>)>> = Mutex::new(Vec::new());
    progress(Progress { stage: "charts", done: 0, total });
    std::thread::scope(|scope| {
        for worker in 0..CHART_WORKERS.min(total) {
            let (queue, done, unreadable, results, rates, lib, f, progress) = (&queue, &done, &unreadable, &results, &rates, &lib, &f, &progress);
            scope.spawn(move || {
                let agent = crate::downloads::chart_agent();
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    let Some(beatmap) = queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() else { break };
                    let api = f.beatmaps.get(&beatmap);
                    let md5 = api.and_then(|b| b.md5.as_deref());
                    let found = lib.find(beatmap, md5);
                    // the library's file, the cached one, or the mirrors'
                    let text = found.and_then(|(_, key)| crate::charts::read(files, key).ok()).or_else(|| {
                        let file = cache_file(cache, beatmap, md5);
                        if let Ok(t) = std::fs::read_to_string(&file) {
                            return Some(t);
                        }
                        match crate::downloads::download_chart(&agent, beatmap, worker) {
                            Ok(Some(t)) => {
                                let _ = std::fs::write(&file, &t);
                                Some(t)
                            }
                            Ok(None) => None,
                            Err(e) => {
                                eprintln!("[player] {e}");
                                None
                            }
                        }
                    });
                    let analysed = text.and_then(|t| analyse(beatmap, &t, api, &rates[&beatmap], found.map(|(id, _)| id.clone())));
                    match analysed {
                        Some(r) => results.lock().unwrap_or_else(|e| e.into_inner()).push(r),
                        None => {
                            unreadable.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                    progress(Progress { stage: "charts", done: n, total });
                }
            });
        }
    });
    if cancel.load(Ordering::SeqCst) {
        return Err(Error::known("cancelled", "Cancelled"));
    }
    let mut charts = results.into_inner().unwrap_or_else(|e| e.into_inner());
    charts.sort_by_key(|(c, _)| c.beatmap_id);
    let by_id: HashMap<i64, &HashMap<u32, f64>> = charts.iter().map(|(c, r)| (c.beatmap_id, r)).collect();

    let mut plays: Vec<PlayOut> = f
        .scores
        .iter()
        .filter_map(|s| {
            let at = by_id.get(&s.beatmap_id)?;
            let (mods, rate) = mods_of(&s.mods);
            Some(PlayOut {
                map: format!("o{}", s.beatmap_id),
                beatmap_id: s.beatmap_id,
                mode: MANIA,
                date: s.date,
                rank: s.rank,
                acc: s.accuracy,
                score: s.total_score,
                pp: s.pp,
                combo: s.max_combo,
                sr: off_grid(rate).and_then(|r| at.get(&r).copied()),
                mods,
                rate,
                failed: !s.passed || s.rank < 0,
                top: s.best_pos,
                id: s.id,
                source: "osu",
            })
        })
        .collect();
    plays.sort_by(|a, b| b.date.cmp(&a.date));

    let u = &f.user;
    let s = &u["statistics"];
    let out = Out {
        player: PlayerOut {
            id: u["id"].as_i64().unwrap_or(0),
            name: u["username"].as_str().unwrap_or_default().to_string(),
            avatar: u["avatar_url"].as_str().map(str::to_string),
            country: u["country_code"].as_str().map(str::to_string),
            rank: s["global_rank"].as_i64(),
            country_rank: s["country_rank"].as_i64(),
            pp: s["pp"].as_f64(),
            accuracy: s["hit_accuracy"].as_f64().map(|a| a / 100.0),
            play_count: s["play_count"].as_i64(),
        },
        charts: charts.into_iter().map(|(c, _)| c).collect(),
        plays,
        counts: f.counts.clone(),
        unreadable: unreadable.into_inner(),
    };
    Ok(serde_json::to_vec(&out)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 4K chart: a stream, then jacks.
    fn chart(title: &str) -> String {
        let mut s = format!(
            "osu file format v14\n[General]\nMode: 3\n[Metadata]\nTitle:{title}\nArtist:Someone\nCreator:Mapper\nVersion:Hard\nBeatmapSetID:77\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[TimingPoints]\n0,250,4,1,0,100,1,0\n[HitObjects]\n"
        );
        let x = [64, 192, 320, 448];
        for i in 0..400 {
            let col = if i < 200 { [0, 2, 1, 3][i % 4] } else { (i / 2) % 4 };
            s += &format!("{},192,{},1,0,0:0:0:0:\n", x[col], 1000 + i * 125);
        }
        s
    }

    fn score(id: i64, beatmap: i64, acc: f64, mods: &str, mode: &str) -> Value {
        serde_json::json!({
            "id": id, "beatmap_id": beatmap, "ruleset_id": if mode == "mania" { 3 } else { 0 },
            "accuracy": acc, "total_score": 900_000, "max_combo": 400, "rank": "S", "pp": 300.0, "passed": true,
            "ended_at": "2026-10-01T12:00:00Z", "mods": serde_json::from_str::<Value>(mods).unwrap(),
            "beatmap": { "id": beatmap, "mode": mode, "checksum": format!("{beatmap:032x}"), "version": "Hard", "difficulty_rating": 4.5, "beatmapset_id": 77 },
            "beatmapset": { "id": 77, "title": "Song", "artist": "Someone", "creator": "Mapper" },
        })
    }

    #[test]
    fn fetch_reads_every_kind_of_play_once() {
        let calls = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = calls.clone();
        let base = crate::test_http::mock(Box::new(move |_, path, auth, _| {
            seen.lock().unwrap().push(path.to_string());
            assert_eq!(auth, "Bearer t");
            let body = match path.split('?').next().unwrap() {
                "/api/v2/users/Some%20One/mania" => serde_json::json!({ "id": 9, "username": "Some One", "statistics": { "pp": 5000.0, "global_rank": 120, "hit_accuracy": 97.5 } }),
                "/api/v2/users/9/scores/best" if path.contains("offset=0") => {
                    serde_json::json!([score(1, 100, 0.98, "[]", "mania"), score(2, 101, 0.95, r#"[{"acronym":"DT","settings":{"speed_change":1.2}}]"#, "mania"), score(3, 102, 0.9, "[]", "osu")])
                }
                "/api/v2/users/9/scores/firsts" => serde_json::json!([score(1, 100, 0.98, "[]", "mania")]),
                "/api/v2/users/9/scores/recent" => serde_json::json!([score(4, 103, 0.93, "[]", "mania")]),
                "/api/v2/users/9/beatmapsets/most_played" => serde_json::json!([
                    { "beatmap_id": 100, "count": 50, "beatmap": { "id": 100, "mode": "mania" }, "beatmapset": { "id": 77 } },
                    { "beatmap_id": 104, "count": 40, "beatmap": { "id": 104, "mode": "mania", "version": "Insane" }, "beatmapset": { "id": 78, "title": "Other" } },
                    { "beatmap_id": 105, "count": 30, "beatmap": { "id": 105, "mode": "mania" }, "beatmapset": { "id": 79 } },
                    { "beatmap_id": 106, "count": 20, "beatmap": { "id": 106, "mode": "osu" }, "beatmapset": { "id": 80 } },
                ]),
                "/api/v2/beatmaps/104/scores/users/9" => serde_json::json!({ "position": 3, "score": score(5, 104, 0.97, "[]", "mania") }),
                "/api/v2/beatmaps/105/scores/users/9" => return (404, r#"{"error":null}"#.into()),
                _ => return (200, "[]".into()),
            };
            (200, body.to_string())
        }));
        let ep = Endpoints { site: base.clone(), osu: base };
        let mut steps = Vec::new();
        let f = fetch(&ep, "t", " Some One ", &AtomicBool::new(false), |p| steps.push(p)).unwrap();
        let ids: Vec<i64> = f.scores.iter().map(|s| s.id).collect();
        // the osu! play is left out, the first place counted once, the most played looked up
        assert_eq!(ids, vec![1, 2, 4, 5]);
        assert_eq!((f.counts.top, f.counts.firsts, f.counts.recent, f.counts.most_played), (2, 0, 1, 1));
        assert_eq!(f.scores[0].best_pos, Some(1));
        // the score's copy of the difficulty (with its md5) wins over the play count's
        assert!(f.beatmaps[&104].md5.is_some());
        assert_eq!(f.beatmaps[&105].version, "");
        let calls = calls.lock().unwrap();
        // one page of top plays (fewer than 100), one of most played, lookups only for osu!mania
        // difficulties without a score
        assert!(calls.iter().any(|c| c.contains("/beatmaps/104/")) && calls.iter().any(|c| c.contains("/beatmaps/105/")));
        assert!(!calls.iter().any(|c| c.contains("/beatmaps/100/") || c.contains("/beatmaps/106/")), "{calls:?}");
        assert_eq!(calls.len(), 1 + 1 + 1 + 1 + 1 + 2, "{calls:?}");
        let last = steps.last().unwrap();
        assert_eq!((last.stage, last.done, last.total), ("scores", 7, 7));

        let none = fetch(&ep, "t", "", &AtomicBool::new(false), |_| {}).unwrap_err();
        assert_eq!(none.code(), "player-not-found");
    }

    #[test]
    fn build_analyses_cached_charts() {
        let dir = std::env::temp_dir().join(format!("fumen-player-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("library.db")).unwrap();
        let cache = dir.join("charts");
        std::fs::create_dir_all(&cache).unwrap();
        // two charts already in the cache (nothing is downloaded)
        for b in [100i64, 101] {
            std::fs::write(cache_file(&cache, b, Some(&format!("{b:032x}"))), chart(&format!("Song {b}"))).unwrap();
        }
        let mut f = Fetched { user: serde_json::json!({ "id": 9, "username": "Some One", "statistics": { "hit_accuracy": 97.5 } }), ..Default::default() };
        for v in [score(1, 100, 0.98, "[]", "mania"), score(2, 101, 0.95, r#"[{"acronym":"DT","settings":{"speed_change":1.2}}]"#, "mania")] {
            let (s, b) = parse_score(&v, MANIA, Some(1)).unwrap();
            f.beatmaps.insert(b.as_ref().unwrap().id, b.unwrap());
            f.scores.push(s);
        }
        let out: Value = serde_json::from_slice(&build(&conn, &crate::paths::Files { lazer: None, stable: Default::default() }, &cache, f, &AtomicBool::new(false), |_| {}).unwrap()).unwrap();
        assert_eq!(out["player"]["name"], "Some One");
        assert_eq!(out["player"]["accuracy"], 0.975);
        let charts = out["charts"].as_array().unwrap();
        assert_eq!(charts.len(), 2);
        let c = &charts[0];
        assert_eq!((c["id"].as_str(), c["cs"].as_f64(), c["sr"].as_f64(), c["setId"].as_i64()), (Some("o100"), Some(4.0), Some(4.5), Some(77)));
        assert!(c["srHt"].as_f64().unwrap() < c["srDt"].as_f64().unwrap());
        let shares: Vec<u64> = c["shares"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
        assert!(shares[0] > 0 && shares[4] > 0, "stream and jacks: {shares:?}");
        let plays = out["plays"].as_array().unwrap();
        assert_eq!(plays.len(), 2);
        let dt = plays.iter().find(|p| p["id"] == 2).unwrap();
        assert_eq!(dt["rate"], 1.2);
        assert!(dt["sr"].as_f64().unwrap() > charts[1]["srHt"].as_f64().unwrap(), "the star rating at 1.2×: {dt}");
        assert_eq!(out["unreadable"], 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_in_urls() {
        assert_eq!(encode("Some One"), "Some%20One");
        assert_eq!(encode("[Ryuk]"), "%5BRyuk%5D");
        assert_eq!(encode("abc-_.~9"), "abc-_.~9");
    }

    /// Single chart files from the mirrors (needs the internet).
    #[test]
    #[ignore]
    fn mirrors_have_chart_files() {
        let agent = crate::downloads::chart_agent();
        for first in 0..3 {
            let text = crate::downloads::download_chart(&agent, 2547774, first).unwrap().expect("a chart");
            assert!(text.contains("[HitObjects]"));
        }
        assert_eq!(crate::downloads::download_chart(&agent, 999_999_999, 0).unwrap(), None);
    }
}
