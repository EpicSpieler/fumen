//! Beatmap search on the mirrors (never osu!'s servers): the sets matching a search, a page at a
//! time, with each difficulty marked when it's one the search asks for.
//!
//! osu.direct searches an index of osu!'s sets (Meilisearch: a text query plus filters on the
//! difficulties' fields, sortable by date, plays, favourites, star rating). Its filters hold when
//! *some* difficulty of a set passes each one, so the difficulties are checked again here and sets
//! without one that passes them all are left out. When osu.direct can't answer (rate limit,
//! outage), catboy.best's search takes the page: text, ruleset and status only, so its results are
//! filtered here alone and come in its own order.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

use crate::downloads::USER_AGENT;
use crate::error::{Error, Result};

/// sets asked for per page
pub const PAGE: u32 = 50;

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Sort {
    /// best match first (without text: newest ranked)
    #[default]
    Relevance,
    Ranked,
    Plays,
    Favourites,
    /// easiest first
    Stars,
    /// last submitted / updated
    Newest,
}

/// What to look for. Unset ranges and empty lists mean "any".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub text: String,
    /// 0 osu!, 1 taiko, 2 catch, 3 mania
    pub mode: Option<u8>,
    /// osu!mania key counts
    pub keys: Vec<u8>,
    pub sr_min: Option<f64>,
    pub sr_max: Option<f64>,
    /// osu!'s numbers: -2 graveyard, -1 WIP, 0 pending, 1 ranked, 2 approved, 3 qualified, 4 loved
    pub status: Vec<i8>,
    pub sort: Sort,
    /// from 0
    pub page: u32,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundMap {
    pub id: u32,
    pub mode: u8,
    pub version: String,
    pub sr: f64,
    pub cs: f64,
    pub ar: f64,
    pub od: f64,
    pub bpm: f64,
    /// seconds
    pub length: u32,
    /// notes and, in osu!mania, long notes (0 and 0: the mirror didn't say)
    pub circles: u32,
    pub sliders: u32,
    /// one the search asks for
    pub matches: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FoundSet {
    pub id: u32,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_unicode: Option<String>,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist_unicode: Option<String>,
    pub creator: String,
    pub status: i8,
    /// unix ms
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranked: Option<i64>,
    pub plays: u64,
    pub favourites: u64,
    pub video: bool,
    /// the ruleset's difficulties (all of them without one), easiest first
    pub maps: Vec<FoundMap>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub sets: Vec<FoundSet>,
    /// the mirror had more
    pub more: bool,
    /// the mirror that answered
    pub mirror: &'static str,
    /// that mirror can't sort or filter on its side: the order is its own
    pub plain: bool,
}

/// The mirrors' search endpoints (tests point them elsewhere).
pub struct Endpoints {
    pub direct: String,
    pub catboy: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints { direct: "https://osu.direct/api/v2/search".into(), catboy: "https://catboy.best/api/v2/search".into() }
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(Duration::from_secs(20)))
        .https_only(cfg!(not(test)))
        .max_redirects(5)
        .http_status_as_error(false)
        .build()
        .into()
}

/// osu.direct's filter: Meilisearch syntax on the difficulties' fields, in brackets after the text.
fn direct_filter(q: &Query) -> String {
    let mut parts = Vec::new();
    if !q.keys.is_empty() && q.mode.is_none_or(|m| m == 3) {
        let keys: Vec<String> = q.keys.iter().map(|k| format!("beatmaps.cs = {k}")).collect();
        parts.push(if keys.len() == 1 { keys[0].clone() } else { format!("({})", keys.join(" OR ")) });
    }
    if let Some(v) = q.sr_min {
        parts.push(format!("beatmaps.difficulty_rating >= {v}"));
    }
    if let Some(v) = q.sr_max {
        parts.push(format!("beatmaps.difficulty_rating <= {v}"));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("[{}]", parts.join(" AND "))
}

fn direct_sort(q: &Query) -> Option<&'static str> {
    match q.sort {
        Sort::Relevance if !q.text.trim().is_empty() => None,
        Sort::Relevance | Sort::Ranked => Some("ranked_date:desc"),
        Sort::Plays => Some("play_count:desc"),
        Sort::Favourites => Some("favourite_count:desc"),
        Sort::Stars => Some("beatmaps.difficulty_rating:asc"),
        Sort::Newest => Some("last_updated:desc"),
    }
}

fn join<T: ToString>(v: &[T]) -> String {
    v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")
}

enum Asked {
    Sets(Vec<Value>),
    /// the mirror couldn't answer (why)
    Failed(String),
}

fn ask(req: ureq::RequestBuilder<ureq::typestate::WithoutBody>) -> Asked {
    match req.call() {
        Ok(mut res) if res.status() == 200 => {
            let body = res.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string();
            match body.map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
                Ok(Value::Array(sets)) => Asked::Sets(sets),
                Ok(_) => Asked::Failed("answered something else".into()),
                Err(e) => Asked::Failed(e),
            }
        }
        Ok(res) => Asked::Failed(format!("HTTP {}", res.status().as_u16())),
        Err(e) => Asked::Failed(e.to_string()),
    }
}

/// One page of sets for the search: osu.direct's, else catboy.best's.
pub fn search(ep: &Endpoints, q: &Query) -> Result<Page> {
    let agent = agent();
    let offset = (q.page * PAGE).to_string();
    let text = q.text.trim();
    let filter = direct_filter(q);
    let mut req = agent
        .get(&ep.direct)
        .query("q", format!("{text}{}{filter}", if text.is_empty() || filter.is_empty() { "" } else { " " }))
        .query("amount", PAGE.to_string())
        .query("offset", &offset);
    if let Some(m) = q.mode {
        req = req.query("mode", m.to_string());
    }
    if !q.status.is_empty() {
        req = req.query("status", join(&q.status));
    }
    if let Some(s) = direct_sort(q) {
        req = req.query("sort", s);
    }
    let direct = match ask(req) {
        Asked::Sets(sets) => return Ok(page(sets, q, "osu.direct", false)),
        Asked::Failed(why) => why,
    };
    // catboy.best: one status at a time, so with several it's left to the filter here
    let mut req = agent.get(&ep.catboy).query("query", text).query("limit", PAGE.to_string()).query("offset", &offset);
    if let Some(m) = q.mode {
        req = req.query("mode", m.to_string());
    }
    if let [s] = q.status.as_slice() {
        req = req.query("status", s.to_string());
    }
    match ask(req) {
        Asked::Sets(sets) => Ok(page(sets, q, "catboy.best", true)),
        Asked::Failed(why) => Err(Error::known("search-failed", format!("The mirrors couldn't search right now (osu.direct {direct}, catboy.best {why})"))),
    }
}

fn page(sets: Vec<Value>, q: &Query, mirror: &'static str, plain: bool) -> Page {
    let more = sets.len() as u32 >= PAGE;
    let sets = sets.iter().filter_map(|s| found(s, q)).collect();
    Page { sets, more, mirror, plain }
}

/// osu!'s status names as numbers.
fn status_of(v: &Value) -> i8 {
    match v.as_str() {
        Some("graveyard") => -2,
        Some("wip") => -1,
        Some("pending") => 0,
        Some("ranked") => 1,
        Some("approved") => 2,
        Some("qualified") => 3,
        Some("loved") => 4,
        _ => v.as_i64().map_or(0, |n| n.clamp(-2, 4) as i8),
    }
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// osu!'s "2026-10-13T12:00:00+00:00" as unix ms.
fn date(v: &Value) -> Option<i64> {
    crate::osu_scores::parse_iso(v.as_str()?)
}

/// A set as the search shows it, or None when none of its difficulties is one it asks for.
fn found(s: &Value, q: &Query) -> Option<FoundSet> {
    let id = u32::try_from(s["id"].as_u64()?).ok()?;
    let status = status_of(&s["status"]);
    if !q.status.is_empty() && !q.status.contains(&status) {
        return None;
    }
    let mut maps: Vec<FoundMap> = s["beatmaps"]
        .as_array()?
        .iter()
        .filter_map(|b| {
            let mode = b["mode_int"].as_u64().map(|m| m as u8).or_else(|| match b["mode"].as_str()? {
                "osu" => Some(0),
                "taiko" => Some(1),
                "fruits" => Some(2),
                "mania" => Some(3),
                _ => None,
            })?;
            Some(FoundMap {
                id: u32::try_from(b["id"].as_u64()?).ok()?,
                mode,
                version: b["version"].as_str().unwrap_or_default().to_string(),
                sr: b["difficulty_rating"].as_f64().unwrap_or(0.0),
                cs: b["cs"].as_f64().unwrap_or(0.0),
                ar: b["ar"].as_f64().unwrap_or(0.0),
                od: b["accuracy"].as_f64().unwrap_or(0.0),
                bpm: b["bpm"].as_f64().unwrap_or(0.0),
                length: b["total_length"].as_u64().unwrap_or(0) as u32,
                circles: b["count_circles"].as_u64().unwrap_or(0) as u32,
                sliders: b["count_sliders"].as_u64().unwrap_or(0) as u32,
                matches: false,
            })
        })
        // the ruleset's own difficulties only (osu.direct lists every one of a set)
        .filter(|m| q.mode.is_none_or(|mode| m.mode == mode))
        .collect();
    // key counts only mean something in osu!mania; asked for without a ruleset, they mean it
    let keys_apply = !q.keys.is_empty() && q.mode.is_none_or(|mode| mode == 3);
    let mut any = false;
    for m in &mut maps {
        m.matches = (!keys_apply || (m.mode == 3 && q.keys.contains(&(m.cs.round() as u8))))
            && q.sr_min.is_none_or(|v| m.sr >= v - 0.005)
            && q.sr_max.is_none_or(|v| m.sr <= v + 0.005);
        any |= m.matches;
    }
    if !any {
        return None;
    }
    maps.sort_by(|a, b| a.mode.cmp(&b.mode).then(a.sr.total_cmp(&b.sr)));
    Some(FoundSet {
        id,
        title: s["title"].as_str().unwrap_or_default().to_string(),
        title_unicode: text(&s["title_unicode"]).filter(|t| Some(t.as_str()) != s["title"].as_str()),
        artist: s["artist"].as_str().unwrap_or_default().to_string(),
        artist_unicode: text(&s["artist_unicode"]).filter(|t| Some(t.as_str()) != s["artist"].as_str()),
        creator: s["creator"].as_str().unwrap_or_default().to_string(),
        status,
        ranked: date(&s["ranked_date"]),
        plays: s["play_count"].as_u64().unwrap_or(0),
        favourites: s["favourite_count"].as_u64().unwrap_or(0),
        video: s["video"].as_bool().unwrap_or(false),
        maps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::mock;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn set(id: u64, status: &str, maps: Value) -> Value {
        json!({ "id": id, "title": "Song", "title_unicode": "Song", "artist": "Artist", "artist_unicode": "アーティスト",
            "creator": "Mapper", "status": status, "ranked_date": "2026-10-13T12:00:00+00:00", "play_count": 12,
            "favourite_count": 3, "video": false, "beatmaps": maps })
    }
    fn map(id: u64, mode: u64, cs: f64, sr: f64) -> Value {
        json!({ "id": id, "mode_int": mode, "version": format!("v{id}"), "difficulty_rating": sr, "cs": cs, "ar": 9, "accuracy": 8,
            "bpm": 180, "total_length": 120 })
    }

    #[test]
    fn asks_osu_direct_with_filters_and_sort() {
        let q = Query { text: "camellia".into(), mode: Some(3), keys: vec![4, 7], sr_min: Some(4.5), sr_max: None, status: vec![1, 4], sort: Sort::Plays, page: 2 };
        assert_eq!(direct_filter(&q), "[(beatmaps.cs = 4 OR beatmaps.cs = 7) AND beatmaps.difficulty_rating >= 4.5]");
        assert_eq!(direct_sort(&q), Some("play_count:desc"));
        // without text, "best match" is the newest ranked
        assert_eq!(direct_sort(&Query::default()), Some("ranked_date:desc"));
        assert_eq!(direct_filter(&Query::default()), "");
        // keys mean nothing outside osu!mania
        assert_eq!(direct_filter(&Query { mode: Some(0), keys: vec![4], ..Query::default() }), "");

        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let base = mock(Box::new(move |_, path, _, _| {
            log.lock().unwrap().push(path.to_string());
            (200, json!([set(1, "ranked", json!([map(10, 3, 4.0, 5.0), map(11, 3, 7.0, 3.0), map(12, 0, 4.0, 6.0)]))]).to_string())
        }));
        let ep = Endpoints { direct: format!("{base}/direct"), catboy: format!("{base}/catboy") };
        let page = search(&ep, &q).unwrap();
        let path = seen.lock().unwrap()[0].clone();
        assert!(path.starts_with("/direct?"), "{path}");
        for part in ["amount=50", "offset=100", "mode=3", "status=1%2C4", "sort=play_count%3Adesc", "q=camellia%20%5B(beatmaps.cs%20%3D%204%20OR"] {
            assert!(path.contains(part), "{part} in {path}");
        }
        assert_eq!(page.mirror, "osu.direct");
        assert!(!page.more);
        // the osu! difficulty is left out, the 7K one is too easy
        let s = &page.sets[0];
        assert_eq!(s.maps.iter().map(|m| (m.id, m.matches)).collect::<Vec<_>>(), vec![(11, false), (10, true)]);
        assert_eq!(s.title_unicode, None);
        assert_eq!(s.artist_unicode.as_deref(), Some("アーティスト"));
        assert_eq!(s.ranked, Some(1_791_892_800_000));
    }

    #[test]
    fn leaves_out_sets_without_a_difficulty_that_fits_every_filter() {
        // osu.direct's filters hold when some difficulty passes each: 7K easy + 4K hard isn't "7K hard"
        let q = Query { mode: Some(3), keys: vec![7], sr_min: Some(5.0), ..Query::default() };
        let s = set(1, "ranked", json!([map(10, 3, 7.0, 2.0), map(11, 3, 4.0, 6.0)]));
        assert_eq!(found(&s, &q), None);
        // and a status it didn't ask for
        let q = Query { status: vec![1], ..Query::default() };
        assert_eq!(found(&set(2, "loved", json!([map(10, 3, 7.0, 2.0)])), &q), None);
        assert!(found(&set(3, "ranked", json!([map(10, 3, 7.0, 2.0)])), &q).is_some());
    }

    #[test]
    fn falls_back_to_catboy_when_osu_direct_cannot_answer() {
        let base = mock(Box::new(move |_, path, _, _| {
            if path.starts_with("/direct") {
                return (429, json!({ "code": 429, "message": "slow down" }).to_string());
            }
            assert!(path.contains("query=freedom%20dive") && path.contains("status=1") && path.contains("limit=50"), "{path}");
            let maps: Vec<Value> = (0..3).map(|i| map(10 + i, 0, 4.0, 5.0 + i as f64)).collect();
            (200, Value::Array((0..50).map(|i| set(100 + i, "ranked", Value::Array(maps.clone()))).collect()).to_string())
        }));
        let ep = Endpoints { direct: format!("{base}/direct"), catboy: format!("{base}/catboy") };
        let page = search(&ep, &Query { text: "freedom dive".into(), status: vec![1], ..Query::default() }).unwrap();
        assert_eq!(page.mirror, "catboy.best");
        assert!(page.plain && page.more);
        assert_eq!(page.sets.len(), 50);
    }

    #[test]
    fn says_so_when_no_mirror_answers() {
        let base = mock(Box::new(|_, _, _, _| (503, "{}".into())));
        let ep = Endpoints { direct: format!("{base}/direct"), catboy: format!("{base}/catboy") };
        let e = search(&ep, &Query::default()).unwrap_err();
        assert_eq!(e.code(), "search-failed");
        assert!(e.to_string().contains("osu.direct HTTP 503"), "{e}");
    }

    /// The real mirrors (run by hand: they're on the internet).
    #[test]
    #[ignore]
    fn real_mirrors() {
        let q = Query { mode: Some(3), keys: vec![4], sr_min: Some(4.0), sr_max: Some(5.0), status: vec![1], ..Query::default() };
        let page = search(&Endpoints::default(), &q).unwrap();
        assert!(!page.sets.is_empty());
        for s in &page.sets {
            assert!(s.maps.iter().any(|m| m.matches && m.cs == 4.0 && (4.0..=5.0).contains(&m.sr)), "{}", s.id);
        }
        println!("{} sets from {}", page.sets.len(), page.mirror);
    }
}
