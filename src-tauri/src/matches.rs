//! A pool's matches: who plays (red and blue: two players, or two teams), when, best of how many,
//! the bans and picks, and the multiplayer room (`mp_id`) whose games osu! keeps. Fumen asks
//! osu!'s API for the room's games ([`fetch`]) and keeps them as [`OsuMatch`]; the scores per map,
//! who won what and the picks it can tell are worked out on the window's side
//! (src/lib/matches.ts), which knows the pool's slots.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::osu_auth::{api_get, Endpoints};

const MAX_NAME: usize = 100;
const MAX_NOTE: usize = 2000;
/// pages of 100 events asked for at most (a long room with chat noise has a few)
const MAX_PAGES: usize = 30;

/// A ban or a pick: whose, and which slot.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Choice {
    /// "red" or "blue"
    pub side: String,
    pub slot: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub id: String,
    pub pool_id: String,
    pub red: String,
    pub blue: String,
    /// when it's on (unix ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<i64>,
    pub best_of: i64,
    /// osu!'s multiplayer room
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mp_id: Option<i64>,
    /// games at the start that don't count
    pub warmups: i64,
    /// "red" or "blue"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_pick: Option<String>,
    pub bans: Vec<Choice>,
    pub picks: Vec<Choice>,
    /// the room as osu! had it when last asked
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<OsuMatch>,
    /// when that was (unix ms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched: Option<i64>,
    pub note: String,
    pub created: i64,
    pub updated: i64,
}

/// What can change about a match; whatever is left out stays. `at` and `mp_id` 0 clear them,
/// `first_pick` "" too.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatchPatch {
    pub red: Option<String>,
    pub blue: Option<String>,
    pub at: Option<i64>,
    pub best_of: Option<i64>,
    pub mp_id: Option<i64>,
    pub warmups: Option<i64>,
    pub first_pick: Option<String>,
    pub bans: Option<Vec<Choice>>,
    pub picks: Option<Vec<Choice>>,
    pub note: Option<String>,
}

// ── osu!'s side ─────────────────────────────────────────────────────────

/// A multiplayer room as osu! keeps it, cut down to what Fumen shows.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct OsuMatch {
    pub id: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    /// none while the room is open
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    pub users: Vec<MatchUser>,
    pub games: Vec<MatchGame>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatchUser {
    pub id: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatchGame {
    pub id: i64,
    pub beatmap_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_id: Option<i64>,
    /// "Artist - Title [Difficulty]", for a map that isn't in the pool
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    /// none while it's being played
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    pub mode: i64,
    pub mods: Vec<String>,
    /// "score", "accuracy", "combo", "scorev2"
    pub scoring: String,
    /// "head-to-head", "tag-coop", "team-vs", "tag-team-vs"
    pub team_type: String,
    pub scores: Vec<MatchScore>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MatchScore {
    pub user: i64,
    pub score: i64,
    /// 0–1
    pub acc: f64,
    pub combo: i64,
    pub misses: i64,
    /// "red", "blue" or "none"
    pub team: String,
    pub passed: bool,
    pub mods: Vec<String>,
}

fn int(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn date(v: &Value) -> Option<i64> {
    crate::osu_scores::parse_iso(v.as_str()?)
}

/// Mods as acronyms, from either way osu! writes them (["HD"] or [{"acronym":"HD"}]).
fn mods(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|m| m.as_str().or_else(|| m["acronym"].as_str()).map(str::to_string)).collect())
        .unwrap_or_default()
}

fn score(s: &Value) -> Option<MatchScore> {
    let stats = &s["statistics"];
    Some(MatchScore {
        user: int(&s["user_id"])?,
        // a stable room's scores, or lazer's way of writing them
        score: int(&s["score"]).or_else(|| int(&s["legacy_total_score"])).or_else(|| int(&s["total_score"])).unwrap_or(0),
        acc: s["accuracy"].as_f64().unwrap_or(0.0),
        combo: int(&s["max_combo"]).unwrap_or(0),
        misses: int(&stats["count_miss"]).or_else(|| int(&stats["miss"])).unwrap_or(0),
        team: s["match"]["team"].as_str().unwrap_or("none").to_string(),
        passed: s["match"]["pass"].as_bool().or_else(|| s["passed"].as_bool()).unwrap_or(true),
        mods: mods(&s["mods"]),
    })
}

fn game(g: &Value) -> Option<MatchGame> {
    let b = &g["beatmap"];
    let set = &b["beatmapset"];
    let title = match (set["artist"].as_str(), set["title"].as_str(), b["version"].as_str()) {
        (Some(a), Some(t), Some(v)) => format!("{a} - {t} [{v}]"),
        _ => String::new(),
    };
    Some(MatchGame {
        id: int(&g["id"])?,
        beatmap_id: int(&g["beatmap_id"]).or_else(|| int(&b["id"])).unwrap_or(0),
        set_id: int(&b["beatmapset_id"]).filter(|v| *v > 0),
        title,
        start: date(&g["start_time"]),
        end: date(&g["end_time"]),
        mode: int(&g["mode_int"]).unwrap_or(0),
        mods: mods(&g["mods"]),
        scoring: g["scoring_type"].as_str().unwrap_or("score").to_string(),
        team_type: g["team_type"].as_str().unwrap_or("head-to-head").to_string(),
        scores: g["scores"].as_array().map(|a| a.iter().filter_map(score).collect()).unwrap_or_default(),
    })
}

/// The room from pages of osu!'s answer (any order; events once each).
fn parse(pages: &[Value]) -> Result<OsuMatch> {
    let first = pages.first().ok_or_else(|| Error::known("osu-unreachable", "osu!'s answer wasn't readable."))?;
    let m = &first["match"];
    let mut events: Vec<&Value> = pages.iter().flat_map(|p| p["events"].as_array().into_iter().flatten()).collect();
    events.sort_by_key(|e| int(&e["id"]).unwrap_or(0));
    events.dedup_by_key(|e| int(&e["id"]).unwrap_or(0));
    let mut games: Vec<MatchGame> = Vec::new();
    for e in events {
        if let Some(g) = e.get("game").filter(|g| g.is_object()).and_then(game) {
            // the same game again (it was asked for while being played): the later one
            games.retain(|x| x.id != g.id);
            games.push(g);
        }
    }
    let mut users: Vec<MatchUser> = Vec::new();
    for p in pages {
        for u in p["users"].as_array().into_iter().flatten() {
            let Some(id) = int(&u["id"]) else { continue };
            if users.iter().any(|x| x.id == id) {
                continue;
            }
            users.push(MatchUser { id, name: u["username"].as_str().unwrap_or_default().to_string(), country: u["country_code"].as_str().map(str::to_string) });
        }
    }
    Ok(OsuMatch {
        id: int(&m["id"]).unwrap_or(0),
        name: m["name"].as_str().unwrap_or_default().to_string(),
        start: date(&m["start_time"]),
        end: date(&m["end_time"]),
        users,
        games,
    })
}

/// A multiplayer room from osu!'s API: every page of its events, older ones first asked for
/// until the first event is in.
pub fn fetch(ep: &Endpoints, token: &str, mp_id: i64) -> Result<OsuMatch> {
    let mut pages = vec![api_get(ep, token, &format!("matches/{mp_id}?limit=100"))?];
    let first_event = int(&pages[0]["first_event_id"]);
    for _ in 0..MAX_PAGES {
        let oldest = pages.iter().flat_map(|p| p["events"].as_array().into_iter().flatten()).filter_map(|e| int(&e["id"])).min();
        match (oldest, first_event) {
            (Some(o), Some(f)) if o > f => pages.push(api_get(ep, token, &format!("matches/{mp_id}?limit=100&before={o}"))?),
            _ => break,
        }
    }
    parse(&pages)
}

/// The room's number from a link to it (`…/community/matches/123`, `…/mp/123`) or the number.
pub fn mp_of(line: &str) -> Option<i64> {
    let s = line.trim().trim_matches(|c| c == '<' || c == '>');
    if let Ok(id) = s.parse::<i64>() {
        return (id > 0).then_some(id);
    }
    let lower = s.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")).unwrap_or(&lower);
    let rest = rest.strip_prefix("www.").unwrap_or(rest).strip_prefix("osu.ppy.sh/")?;
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let id = match parts.as_slice() {
        ["community", "matches", id, ..] | ["mp", id, ..] | ["matches", id, ..] => id.parse::<i64>().ok()?,
        _ => return None,
    };
    (id > 0).then_some(id)
}

// ── Fumen's side ────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).unwrap_or_default();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn one_line(s: &str, max: usize) -> String {
    let s: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    s.trim().chars().take(max).collect()
}

fn side(s: &str) -> Option<String> {
    matches!(s, "red" | "blue").then(|| s.to_string())
}

/// Bans and picks with a side each, a slot like "RC2" once each.
fn clean_choices(list: &[Choice]) -> Result<Vec<Choice>> {
    let mut out: Vec<Choice> = Vec::new();
    for c in list {
        let slot = c.slot.trim().to_ascii_uppercase();
        let ok = side(&c.side).is_some() && (1..=8).contains(&slot.len()) && slot.bytes().all(|b| b.is_ascii_alphanumeric());
        if !ok {
            return Err(Error::known("bad-choice", "That ban or pick doesn't work."));
        }
        if !out.iter().any(|o| o.slot == slot) {
            out.push(Choice { side: c.side.clone(), slot });
        }
    }
    Ok(out)
}

const COLUMNS: &str = "id, pool_id, red, blue, at, best_of, mp_id, warmups, first_pick, bans, picks, result, fetched, note, created, updated";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Match> {
    let list = |i: usize| -> rusqlite::Result<Vec<Choice>> { Ok(serde_json::from_str(&r.get::<_, String>(i)?).unwrap_or_default()) };
    Ok(Match {
        id: r.get(0)?,
        pool_id: r.get(1)?,
        red: r.get(2)?,
        blue: r.get(3)?,
        at: r.get(4)?,
        best_of: r.get(5)?,
        mp_id: r.get(6)?,
        warmups: r.get(7)?,
        first_pick: r.get(8)?,
        bans: list(9)?,
        picks: list(10)?,
        result: r.get::<_, Option<String>>(11)?.and_then(|j| serde_json::from_str(&j).ok()),
        fetched: r.get(12)?,
        note: r.get(13)?,
        created: r.get(14)?,
        updated: r.get(15)?,
    })
}

/// Every match, the ones with a time first, by it.
pub fn list(conn: &Connection) -> Result<Vec<Match>> {
    let mut st = conn.prepare(&format!("SELECT {COLUMNS} FROM pool_matches ORDER BY at IS NULL, at, created"))?;
    let out = st.query_map([], row)?.collect::<Result<_, _>>()?;
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> Result<Match> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM pool_matches WHERE id = ?1"), [id], row)
        .optional()?
        .ok_or_else(|| Error::known("no-match", "That match doesn't exist any more."))
}

/// A new match in a pool. Returns its id.
pub fn create(conn: &Connection, pool: &str, patch: &MatchPatch) -> Result<String> {
    let known: Option<String> = conn.query_row("SELECT id FROM pools WHERE id = ?1", [pool], |r| r.get(0)).optional()?;
    known.ok_or_else(|| Error::known("no-pool", "That pool doesn't exist any more."))?;
    let id = new_id();
    let at = now_ms();
    conn.execute("INSERT INTO pool_matches (id, pool_id, created, updated) VALUES (?1, ?2, ?3, ?3)", params![id, pool, at])?;
    update(conn, &id, patch)?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, p: &MatchPatch) -> Result<()> {
    get(conn, id)?;
    let set = |col: &str, v: &dyn rusqlite::ToSql| conn.execute(&format!("UPDATE pool_matches SET {col} = ?2 WHERE id = ?1"), params![id, v]);
    if let Some(v) = &p.red {
        set("red", &one_line(v, MAX_NAME))?;
    }
    if let Some(v) = &p.blue {
        set("blue", &one_line(v, MAX_NAME))?;
    }
    if let Some(v) = p.at {
        set("at", &(v > 0).then_some(v))?;
    }
    if let Some(v) = p.best_of {
        // odd, one to 21
        if !(1..=21).contains(&v) || v % 2 == 0 {
            return Err(Error::known("bad-best-of", "A match is best of an odd number, up to 21."));
        }
        set("best_of", &v)?;
    }
    if let Some(v) = p.mp_id {
        let v = (v > 0).then_some(v);
        // another room: what was kept of the last one goes
        conn.execute("UPDATE pool_matches SET result = NULL, fetched = NULL WHERE id = ?1 AND mp_id IS NOT ?2", params![id, v])?;
        set("mp_id", &v)?;
    }
    if let Some(v) = p.warmups {
        set("warmups", &v.clamp(0, 10))?;
    }
    if let Some(v) = &p.first_pick {
        set("first_pick", &side(v))?;
    }
    if let Some(v) = &p.bans {
        set("bans", &serde_json::to_string(&clean_choices(v)?).unwrap_or_default())?;
    }
    if let Some(v) = &p.picks {
        set("picks", &serde_json::to_string(&clean_choices(v)?).unwrap_or_default())?;
    }
    if let Some(v) = &p.note {
        let note: String = v.chars().filter(|c| !c.is_control() || *c == '\n').collect();
        set("note", &note.trim().chars().take(MAX_NOTE).collect::<String>())?;
    }
    set("updated", &now_ms())?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM pool_matches WHERE id = ?1", [id])?;
    Ok(())
}

/// Keeps what osu! said about a match's room.
pub fn store_result(conn: &Connection, id: &str, result: &OsuMatch) -> Result<()> {
    conn.execute(
        "UPDATE pool_matches SET result = ?2, fetched = ?3 WHERE id = ?1",
        params![id, serde_json::to_string(result).unwrap_or_default(), now_ms()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_http::mock;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn game_event(id: i64, game: i64, beatmap: i64, scores: Value, end: Option<&str>) -> Value {
        json!({ "id": id, "detail": { "type": "other" }, "timestamp": "2026-08-01T18:00:00+00:00", "game": {
            "id": game, "beatmap_id": beatmap, "start_time": "2026-08-01T18:00:00+00:00", "end_time": end, "mode": "mania", "mode_int": 3,
            "scoring_type": "scorev2", "team_type": "head-to-head", "mods": ["NF"],
            "beatmap": { "id": beatmap, "beatmapset_id": 77, "version": "Hard", "beatmapset": { "artist": "Someone", "title": "Song" } },
            "scores": scores } })
    }

    fn s(user: i64, score: i64) -> Value {
        json!({ "user_id": user, "score": score, "accuracy": 0.97, "max_combo": 900, "mods": ["NF"], "passed": true,
            "statistics": { "count_miss": 3 }, "match": { "slot": 0, "team": "none", "pass": true } })
    }

    #[test]
    fn rooms_page_by_page() {
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let base = mock(Box::new(move |_, path, auth, _| {
            log.lock().unwrap().push(path.to_string());
            assert_eq!(auth, "Bearer t");
            let users = json!([{ "id": 1, "username": "Red Player", "country_code": "DE" }, { "id": 2, "username": "blue" }]);
            let body = if path.contains("before=10") {
                json!({ "match": { "id": 5 }, "events": [
                    { "id": 1, "detail": { "type": "match-created" } },
                    game_event(4, 100, 9001, json!([s(1, 900_000), s(2, 800_000)]), Some("2026-08-01T18:03:00+00:00")),
                ], "users": users, "first_event_id": 1, "latest_event_id": 12 })
            } else {
                json!({ "match": { "id": 5, "name": "RPRO: (Red Player) vs (blue)", "start_time": "2026-08-01T17:55:00+00:00", "end_time": null }, "events": [
                    game_event(10, 101, 9002, json!([s(1, 700_000), { "user_id": 2, "legacy_total_score": 750_000, "accuracy": 0.95, "max_combo": 10, "mods": [{ "acronym": "NF" }], "statistics": { "miss": 7 }, "match": { "team": "none", "pass": false } }]), Some("2026-08-01T18:08:00+00:00")),
                    // being played: no end yet, no scores
                    game_event(12, 102, 9003, json!([]), None),
                ], "users": users, "first_event_id": 1, "latest_event_id": 12 })
            };
            (200, body.to_string())
        }));
        let ep = Endpoints { site: base.clone(), osu: base };
        let m = fetch(&ep, "t", 5).unwrap();
        assert_eq!(seen.lock().unwrap().as_slice(), ["/api/v2/matches/5?limit=100", "/api/v2/matches/5?limit=100&before=10"]);
        assert_eq!((m.id, m.name.as_str(), m.end), (5, "RPRO: (Red Player) vs (blue)", None));
        assert_eq!(m.users.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["Red Player", "blue"]);
        assert_eq!(m.games.iter().map(|g| (g.id, g.beatmap_id)).collect::<Vec<_>>(), [(100, 9001), (101, 9002), (102, 9003)]);
        let g = &m.games[1];
        assert_eq!((g.title.as_str(), g.mods.as_slice(), g.mode, g.set_id), ("Someone - Song [Hard]", ["NF".to_string()].as_slice(), 3, Some(77)));
        // lazer's way of writing a score reads the same
        let b = &g.scores[1];
        assert_eq!((b.user, b.score, b.misses, b.passed, b.mods.as_slice()), (2, 750_000, 7, false, ["NF".to_string()].as_slice()));
        assert!(m.games[2].end.is_none() && m.games[2].scores.is_empty());
    }

    #[test]
    fn room_links() {
        assert_eq!(mp_of("https://osu.ppy.sh/community/matches/112233"), Some(112233));
        assert_eq!(mp_of("osu.ppy.sh/mp/112233"), Some(112233));
        assert_eq!(mp_of(" 112233 "), Some(112233));
        assert_eq!(mp_of("https://osu.ppy.sh/beatmapsets/1"), None);
        assert_eq!(mp_of("https://example.com/mp/1"), None);
    }

    #[test]
    fn matches_keep_what_they_are_given() {
        let path = std::env::temp_dir().join(format!("fumen-matches-{}-{}.db", std::process::id(), new_id()));
        let conn = crate::db::open(&path).unwrap();
        let pool = crate::pools::create(&conn, "Cup", 3, Some(4), &[crate::pools::Category { code: "RC".into(), count: 2, mods: vec![] }]).unwrap();
        assert_eq!(create(&conn, "nope", &MatchPatch::default()).unwrap_err().code(), "no-pool");
        let id = create(&conn, &pool, &MatchPatch { red: Some("  Red\n".into()), blue: Some("Blue".into()), at: Some(5_000), ..Default::default() }).unwrap();
        let m = get(&conn, &id).unwrap();
        assert_eq!((m.red.as_str(), m.blue.as_str(), m.at, m.best_of), ("Red", "Blue", Some(5_000), 7));

        let ban = |side: &str, slot: &str| Choice { side: side.into(), slot: slot.into() };
        update(&conn, &id, &MatchPatch { bans: Some(vec![ban("red", "rc1"), ban("blue", "RC1")]), first_pick: Some("blue".into()), mp_id: Some(9), ..Default::default() }).unwrap();
        let m = get(&conn, &id).unwrap();
        // a slot once, the first word on it stays
        assert_eq!((m.bans, m.first_pick.as_deref(), m.mp_id), (vec![ban("red", "RC1")], Some("blue"), Some(9)));
        assert_eq!(update(&conn, &id, &MatchPatch { best_of: Some(4), ..Default::default() }).unwrap_err().code(), "bad-best-of");
        assert_eq!(update(&conn, &id, &MatchPatch { picks: Some(vec![ban("green", "RC1")]), ..Default::default() }).unwrap_err().code(), "bad-choice");

        store_result(&conn, &id, &OsuMatch { id: 9, name: "room".into(), ..Default::default() }).unwrap();
        assert_eq!(get(&conn, &id).unwrap().result.map(|r| r.name), Some("room".into()));
        // the same room: kept; another one: gone
        update(&conn, &id, &MatchPatch { mp_id: Some(9), ..Default::default() }).unwrap();
        assert!(get(&conn, &id).unwrap().result.is_some());
        update(&conn, &id, &MatchPatch { mp_id: Some(10), at: Some(0), ..Default::default() }).unwrap();
        let m = get(&conn, &id).unwrap();
        assert!(m.result.is_none() && m.at.is_none());

        // the pool goes: its matches too
        crate::pools::delete(&conn, &pool).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}
