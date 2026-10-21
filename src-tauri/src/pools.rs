//! Map pools: what a tournament plays, slot by slot. A pool has kinds of slot (osu!mania's "RC"
//! rice, "LN", "HB" hybrid, "SV", "EX" and "TB"; "NM", "HD", "HR", "DT", "FM" and "TB" elsewhere,
//! or the player's own), each with a number of slots and the mods they're played with; a slot
//! ("RC2", or "TB" when its kind has one) holds one difficulty.
//!
//! Like collections, slots keep difficulties by MD5, so they survive rescans; they keep osu!'s
//! beatmap id too, which exports need. A difficulty that isn't in the library comes as its chart
//! off the mirrors (never osu!'s servers): the slot keeps what the chart says ([`Online`]), the
//! file stays in Fumen's cache for its pp, and once the set is in the library the slot finds it by
//! its MD5 like any other.
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const MAX_NAME: usize = 100;
const MAX_NOTE: usize = 2000;
const MAX_KINDS: usize = 12;
const MAX_SLOTS: u32 = 16;
/// the mods a kind of slot can be played with (the rest change nothing about the numbers)
const MODS: [&str; 7] = ["EZ", "NF", "HT", "HR", "DT", "HD", "FL"];

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Category {
    /// one to four capital letters: "RC", "NM", "TB"
    pub code: String,
    pub count: u32,
    #[serde(default)]
    pub mods: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub slot: String,
    /// the library difficulty in it, when it's in the library
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online_id: Option<i64>,
    pub note: String,
    /// a difficulty that isn't in the library: what its chart says
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online: Option<Online>,
}

/// A difficulty that isn't in the library, as its slot keeps it (from its chart file).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Online {
    pub beatmap_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_id: Option<i64>,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub title_unicode: String,
    pub artist: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub artist_unicode: String,
    pub creator: String,
    pub version: String,
    pub mode: i64,
    /// osu!mania: the key count
    pub keys: i64,
    /// ms, first note to the end of the last
    pub length: f64,
    pub bpm: f64,
    pub objects: u32,
    /// osu!mania: long notes
    pub holds: u32,
    /// without mods (rosu-pp's, osu!'s within a hair)
    pub sr: f64,
    /// osu!mania: Fumen's pattern category ("Jumpstream", "… SV")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pool {
    pub id: String,
    pub name: String,
    /// the ruleset (0 osu!, 1 osu!taiko, 2 osu!catch, 3 osu!mania)
    pub mode: i64,
    /// osu!mania: the key count
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<i64>,
    pub categories: Vec<Category>,
    pub note: String,
    /// unix ms
    pub created: i64,
    pub updated: i64,
    /// the filled slots
    pub slots: Vec<Slot>,
}

/// What can change about a pool; whatever is left out stays.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PoolPatch {
    pub name: Option<String>,
    pub categories: Option<Vec<Category>>,
    pub note: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).unwrap_or_default();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// One line of text, no control characters, at most `max` characters.
fn one_line(s: &str, max: usize) -> String {
    let s: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    s.trim().chars().take(max).collect()
}

fn clean_name(name: &str) -> Result<String> {
    let name = one_line(name, MAX_NAME);
    if name.is_empty() {
        return Err(Error::known("bad-name", "A pool needs a name."));
    }
    Ok(name)
}

fn clean_note(note: &str) -> String {
    // line breaks are fine in a note
    let note: String = note.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    note.trim().chars().take(MAX_NOTE).collect()
}

fn clean_categories(kinds: &[Category]) -> Result<Vec<Category>> {
    let bad = || Error::known("bad-slots", "Those kinds of slot don't work: one to four letters each, all different, up to 16 slots of each.");
    if kinds.is_empty() || kinds.len() > MAX_KINDS {
        return Err(bad());
    }
    let mut out: Vec<Category> = Vec::with_capacity(kinds.len());
    for k in kinds {
        let code = k.code.trim().to_ascii_uppercase();
        if code.is_empty() || code.len() > 4 || !code.bytes().all(|b| b.is_ascii_uppercase()) || out.iter().any(|o| o.code == code) {
            return Err(bad());
        }
        if k.count == 0 || k.count > MAX_SLOTS {
            return Err(bad());
        }
        // known mods once each; of two that don't go together, the one given first
        let mut given: Vec<&str> = Vec::new();
        for m in &k.mods {
            let Some(m) = MODS.iter().copied().find(|x| x.eq_ignore_ascii_case(m)) else { continue };
            let clash = [("EZ", "HR"), ("HT", "DT")].iter().any(|(a, b)| given.iter().any(|g| (*g == *a && m == *b) || (*g == *b && m == *a)));
            if !given.contains(&m) && !clash {
                given.push(m);
            }
        }
        // in lazer's order
        let mods: Vec<String> = MODS.iter().filter(|m| given.contains(m)).map(|m| m.to_string()).collect();
        out.push(Category { code, count: k.count, mods });
    }
    Ok(out)
}

/// The slots of some kinds, in order: "RC1" … "RC4", "TB" (a kind with one slot has no number).
pub fn slot_codes(kinds: &[Category]) -> Vec<String> {
    let mut out = Vec::new();
    for k in kinds {
        if k.count == 1 {
            out.push(k.code.clone());
        } else {
            out.extend((1..=k.count).map(|i| format!("{}{i}", k.code)));
        }
    }
    out
}

fn kinds_of(conn: &Connection, id: &str) -> Result<(i64, Vec<Category>)> {
    let row: Option<(i64, String)> = conn.query_row("SELECT mode, categories FROM pools WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let (mode, json) = row.ok_or_else(|| Error::known("no-pool", "That pool doesn't exist any more."))?;
    Ok((mode, serde_json::from_str(&json).unwrap_or_default()))
}

fn touch(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("UPDATE pools SET updated = ?2 WHERE id = ?1", params![id, now_ms()])?;
    Ok(())
}

/// The pool's ruleset, when it has the slot.
pub fn known_slot(conn: &Connection, pool: &str, slot: &str) -> Result<i64> {
    let (mode, kinds) = kinds_of(conn, pool)?;
    if !slot_codes(&kinds).iter().any(|s| s == slot) {
        return Err(Error::known("no-slot", "That pool has no such slot."));
    }
    Ok(mode)
}

/// All pools, in the order they were made, with their slots' difficulties found in the library.
pub fn list(conn: &Connection) -> Result<Vec<Pool>> {
    let mut st = conn.prepare("SELECT id, name, mode, keys, categories, note, created, updated FROM pools ORDER BY position, created")?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, i64, Option<i64>, String, String, i64, i64)> =
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)))?.collect::<Result<_, _>>()?;
    // a difficulty can sit in two sets (the same .osu imported twice): lazer's first
    let mut slots = conn.prepare(
        "SELECT pm.slot, pm.md5, pm.online_id, pm.note,
                (SELECT m.id FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = pm.md5 ORDER BY s.source = 'stable' LIMIT 1),
                pm.meta
         FROM pool_maps pm WHERE pm.pool_id = ?1",
    )?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, mode, keys, categories, note, created, updated) in rows {
        let categories: Vec<Category> = serde_json::from_str(&categories).unwrap_or_default();
        let order = slot_codes(&categories);
        let mut filled: Vec<Slot> = slots
            .query_map([&id], |r| {
                let map: Option<String> = r.get(4)?;
                // what the chart said, while the library doesn't have it
                let online = if map.is_none() { r.get::<_, Option<String>>(5)?.and_then(|j| serde_json::from_str(&j).ok()) } else { None };
                Ok(Slot { slot: r.get(0)?, md5: r.get(1)?, online_id: r.get(2)?, note: r.get(3)?, map, online })
            })?
            .collect::<Result<_, _>>()?;
        filled.sort_by_key(|s| order.iter().position(|o| *o == s.slot).unwrap_or(usize::MAX));
        out.push(Pool { id, name, mode, keys, categories, note, created, updated, slots: filled });
    }
    Ok(out)
}

/// Makes an empty pool. Returns its id.
pub fn create(conn: &Connection, name: &str, mode: i64, keys: Option<i64>, kinds: &[Category]) -> Result<String> {
    if !(0..=3).contains(&mode) {
        return Err(Error::known("bad-mode", "A pool is for osu!, osu!taiko, osu!catch or osu!mania."));
    }
    let keys = if mode == 3 { keys.filter(|k| (1..=18).contains(k)) } else { None };
    let (name, kinds) = (clean_name(name)?, clean_categories(kinds)?);
    let id = new_id();
    let at = now_ms();
    let position: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM pools", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO pools (id, name, mode, keys, categories, created, updated, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7)",
        params![id, name, mode, keys, serde_json::to_string(&kinds).unwrap_or_default(), at, position],
    )?;
    Ok(id)
}

/// Renames a pool, changes its kinds of slot or its note. Slots that a change of kinds leaves
/// out go, with the maps in them.
pub fn update(conn: &mut Connection, id: &str, patch: &PoolPatch) -> Result<()> {
    kinds_of(conn, id)?;
    let tx = conn.transaction()?;
    if let Some(name) = &patch.name {
        tx.execute("UPDATE pools SET name = ?2 WHERE id = ?1", params![id, clean_name(name)?])?;
    }
    if let Some(note) = &patch.note {
        tx.execute("UPDATE pools SET note = ?2 WHERE id = ?1", params![id, clean_note(note)])?;
    }
    if let Some(kinds) = &patch.categories {
        let kinds = clean_categories(kinds)?;
        tx.execute("UPDATE pools SET categories = ?2 WHERE id = ?1", params![id, serde_json::to_string(&kinds).unwrap_or_default()])?;
        let keep = slot_codes(&kinds);
        let slots: Vec<String> = {
            let mut st = tx.prepare("SELECT slot FROM pool_maps WHERE pool_id = ?1")?;
            let v = st.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            v
        };
        for s in slots.iter().filter(|s| !keep.contains(s)) {
            tx.execute("DELETE FROM pool_maps WHERE pool_id = ?1 AND slot = ?2", params![id, s])?;
        }
    }
    touch(&tx, id)?;
    tx.commit()?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM pools WHERE id = ?1", [id])?;
    Ok(())
}

/// Puts a library difficulty into a slot. A difficulty is in a pool once: from another slot, it
/// moves.
pub fn set_slot(conn: &mut Connection, pool: &str, slot: &str, map_id: &str) -> Result<()> {
    let mode = known_slot(conn, pool, slot)?;
    let row: Option<(Option<String>, Option<i64>, Option<i64>)> =
        conn.query_row("SELECT md5, online_id, ruleset_id FROM maps WHERE id = ?1", [map_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
    let (md5, online_id, ruleset) = row.ok_or_else(|| Error::known("chart-missing", "This difficulty isn't in the library anymore."))?;
    let md5 = md5.filter(|h| !h.is_empty()).ok_or_else(|| Error::known("no-md5", "This difficulty has no hash to keep it by."))?;
    if ruleset != Some(mode) {
        return Err(Error::known("wrong-ruleset", "This difficulty is for another ruleset than the pool."));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM pool_maps WHERE pool_id = ?1 AND md5 = ?2", params![pool, md5])?;
    tx.execute(
        "INSERT OR REPLACE INTO pool_maps (pool_id, slot, md5, online_id, note, meta, added) VALUES (?1, ?2, ?3, ?4, '', NULL, ?5)",
        params![pool, slot, md5, online_id.filter(|i| *i > 0), now_ms()],
    )?;
    touch(&tx, pool)?;
    tx.commit()?;
    Ok(())
}

pub fn clear_slot(conn: &Connection, pool: &str, slot: &str) -> Result<()> {
    conn.execute("DELETE FROM pool_maps WHERE pool_id = ?1 AND slot = ?2", params![pool, slot])?;
    touch(conn, pool)
}

/// Swaps what two slots hold (either may be empty).
pub fn swap_slots(conn: &mut Connection, pool: &str, a: &str, b: &str) -> Result<()> {
    known_slot(conn, pool, a)?;
    known_slot(conn, pool, b)?;
    if a == b {
        return Ok(());
    }
    let tx = conn.transaction()?;
    tx.execute("UPDATE pool_maps SET slot = '\u{1}' WHERE pool_id = ?1 AND slot = ?2", params![pool, a])?;
    tx.execute("UPDATE pool_maps SET slot = ?3 WHERE pool_id = ?1 AND slot = ?2", params![pool, b, a])?;
    tx.execute("UPDATE pool_maps SET slot = ?2 WHERE pool_id = ?1 AND slot = '\u{1}'", params![pool, b])?;
    touch(&tx, pool)?;
    tx.commit()?;
    Ok(())
}

pub fn set_slot_note(conn: &Connection, pool: &str, slot: &str, note: &str) -> Result<()> {
    if conn.execute("UPDATE pool_maps SET note = ?3 WHERE pool_id = ?1 AND slot = ?2", params![pool, slot, clean_note(note)])? == 0 {
        return Err(Error::known("no-slot", "That pool has no such slot."));
    }
    touch(conn, pool)
}

// ── maps that aren't in the library ─────────────────────────────────────

/// The difficulty a pasted line names: a link to it (`…/beatmapsets/1#mania/2`, `/b/2`,
/// `/beatmaps/2`, `osu://b/2`) or its number. A set link without a difficulty names none.
pub fn beatmap_of(line: &str) -> Option<i64> {
    let s = line.trim().trim_matches(|c| c == '<' || c == '>' || c == '"');
    if let Ok(id) = s.parse::<i64>() {
        return (id > 0).then_some(id);
    }
    // a set link with the difficulty after the #
    if s.to_ascii_lowercase().contains("/beatmapsets/") {
        let id = s.split_once('#')?.1.rsplit('/').next()?.trim().parse::<i64>().ok()?;
        return (id > 0).then_some(id);
    }
    match crate::downloads::parse_link(s)? {
        crate::downloads::Target::Beatmap(id) => Some(id as i64),
        crate::downloads::Target::Set(_) => None,
    }
}

fn md5_of(text: &str) -> String {
    use md5::Digest;
    md5::Md5::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn cache_path(dir: &Path, beatmap: i64) -> PathBuf {
    dir.join(format!("{beatmap}.osu"))
}

/// The chart of osu!'s difficulty `beatmap`: from `dir` (Fumen's cache), else from the mirrors
/// (and kept there). With `md5`, a kept file that isn't that one is fetched again. Returns the
/// text and its MD5.
pub fn online_chart(dir: &Path, beatmap: i64, md5: Option<&str>) -> Result<(String, String)> {
    let path = cache_path(dir, beatmap);
    if let Ok(text) = std::fs::read_to_string(&path) {
        let got = md5_of(&text);
        if md5.is_none_or(|want| want.eq_ignore_ascii_case(&got)) {
            return Ok((text, got));
        }
    }
    let agent = crate::downloads::chart_agent();
    let text = crate::downloads::download_chart(&agent, beatmap, 0)?
        .ok_or_else(|| Error::known("not-on-mirrors", "No mirror has this difficulty. Is the link right?"))?;
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, &text)?;
    let got = md5_of(&text);
    Ok((text, got))
}

/// What a slot keeps of a chart that isn't in the library, and its MD5.
pub fn describe(beatmap: i64, text: &str) -> Result<(String, Online)> {
    let md5 = md5_of(text);
    let chart = crate::chart::parse(text);
    if chart.objects.is_empty() {
        return Err(Error::known("not-a-chart", "That doesn't look like a chart."));
    }
    let meta = crate::player::metadata(text);
    let m = |k: &str| meta.get(k).cloned().unwrap_or_default();
    let first = chart.objects.iter().map(|o| o.time).min().unwrap_or(0);
    let last = chart.objects.iter().map(|o| o.end.max(o.time)).max().unwrap_or(0);
    let points: Vec<(f64, f64)> = chart.timing.iter().filter(|p| p.uninherited).map(|p| (p.beat_len, p.time)).collect();
    let stars = crate::pp::sheet_with(|| Ok(text.as_bytes().to_vec()), &md5, &[], 1.0, &[])?.stars;
    // the pattern analysis on a chart from anywhere: one that breaks it just has no category
    let category = std::panic::catch_unwind(|| crate::mma::patterns::report(&chart))
        .ok()
        .flatten()
        .map(|r| if r.sv() { format!("{} SV", r.category) } else { r.category });
    let online = Online {
        beatmap_id: beatmap,
        set_id: m("BeatmapSetID").parse().ok().filter(|v: &i64| *v > 0),
        title: m("Title"),
        title_unicode: m("TitleUnicode"),
        artist: m("Artist"),
        artist_unicode: m("ArtistUnicode"),
        creator: m("Creator"),
        version: m("Version"),
        mode: chart.mode as i64,
        keys: chart.keys as i64,
        length: (last - first).max(0) as f64,
        bpm: crate::stable::main_bpm(&points, last as f64),
        objects: chart.objects.len() as u32,
        holds: chart.objects.iter().filter(|o| matches!(o.kind, crate::chart::Kind::Hold)).count() as u32,
        sr: (stars * 100.0).round() / 100.0,
        category,
    };
    Ok((md5, online))
}

/// Puts a difficulty that isn't in the library into a slot (`md5` and `online` from
/// [`describe`]); from another slot, it moves.
pub fn set_online(conn: &mut Connection, pool: &str, slot: &str, md5: &str, online: &Online) -> Result<()> {
    let mode = known_slot(conn, pool, slot)?;
    if online.mode != mode {
        return Err(Error::known("wrong-ruleset", "This difficulty is for another ruleset than the pool."));
    }
    let keys: Option<i64> = conn.query_row("SELECT keys FROM pools WHERE id = ?1", [pool], |r| r.get(0))?;
    if mode == 3 && keys.is_some_and(|k| k != online.keys) {
        return Err(Error::known("wrong-keys", "This difficulty has another key count than the pool."));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM pool_maps WHERE pool_id = ?1 AND md5 = ?2", params![pool, md5])?;
    tx.execute(
        "INSERT OR REPLACE INTO pool_maps (pool_id, slot, md5, online_id, note, meta, added) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
        params![pool, slot, md5, online.beatmap_id, serde_json::to_string(online).unwrap_or_default(), now_ms()],
    )?;
    touch(&tx, pool)?;
    tx.commit()?;
    Ok(())
}

/// The MD5 a pool keeps for osu!'s difficulty `beatmap` (which chart file its pp is from).
pub fn online_md5(conn: &Connection, beatmap: i64) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT md5 FROM pool_maps WHERE online_id = ?1 AND meta IS NOT NULL LIMIT 1", [beatmap], |r| r.get(0)).optional()?.flatten())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let path = std::env::temp_dir().join(format!("fumen-pools-{}-{}.db", std::process::id(), new_id()));
        let conn = crate::db::open(&path).unwrap();
        conn.execute_batch(
            "INSERT INTO sets (id) VALUES ('s1');
             INSERT INTO maps (id, set_id, md5, online_id, ruleset_id) VALUES
               ('a', 's1', 'md5a', 101, 3), ('b', 's1', 'md5b', 102, 3), ('c', 's1', 'md5c', NULL, 3), ('o', 's1', 'md5o', 104, 0);",
        )
        .unwrap();
        conn
    }

    fn kinds() -> Vec<Category> {
        vec![
            Category { code: "rc".into(), count: 3, mods: vec![] },
            Category { code: "DT".into(), count: 2, mods: vec!["dt".into(), "HT".into(), "NF".into()] },
            Category { code: "TB".into(), count: 1, mods: vec![] },
        ]
    }

    #[test]
    fn slots_and_moves() {
        let mut conn = db();
        let id = create(&conn, "  RPRO Cup  ", 3, Some(4), &kinds()).unwrap();
        let p = &list(&conn).unwrap()[0];
        assert_eq!((p.name.as_str(), p.keys), ("RPRO Cup", Some(4)));
        assert_eq!(slot_codes(&p.categories), ["RC1", "RC2", "RC3", "DT1", "DT2", "TB"]);
        // HT goes with DT, NF stays
        assert_eq!(p.categories[1].mods, ["NF", "DT"]);

        set_slot(&mut conn, &id, "RC2", "a").unwrap();
        set_slot(&mut conn, &id, "TB", "b").unwrap();
        set_slot(&mut conn, &id, "RC1", "c").unwrap();
        assert!(set_slot(&mut conn, &id, "RC9", "a").is_err());
        assert_eq!(set_slot(&mut conn, &id, "RC3", "o").unwrap_err().code(), "wrong-ruleset");
        // in a pool once: moving it empties RC2
        set_slot(&mut conn, &id, "DT1", "a").unwrap();
        let slots = |conn: &Connection| list(conn).unwrap()[0].slots.iter().map(|s| (s.slot.clone(), s.map.clone(), s.online_id)).collect::<Vec<_>>();
        assert_eq!(
            slots(&conn),
            [("RC1".into(), Some("c".into()), None), ("DT1".into(), Some("a".into()), Some(101)), ("TB".into(), Some("b".into()), Some(102))]
        );
        swap_slots(&mut conn, &id, "RC1", "TB").unwrap();
        swap_slots(&mut conn, &id, "DT1", "RC3").unwrap();
        assert_eq!(slots(&conn).iter().map(|s| (s.0.as_str(), s.1.as_deref().unwrap())).collect::<Vec<_>>(), [("RC1", "b"), ("RC3", "a"), ("TB", "c")]);
        set_slot_note(&conn, &id, "TB", "  warmup? \n").unwrap();
        assert_eq!(list(&conn).unwrap()[0].slots[2].note, "warmup?");

        // fewer slots: RC3 goes, with its map
        update(&mut conn, &id, &PoolPatch { categories: Some(vec![Category { code: "RC".into(), count: 2, mods: vec![] }, kinds()[2].clone()]), ..Default::default() }).unwrap();
        assert_eq!(slots(&conn).iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), ["RC1", "TB"]);
        clear_slot(&conn, &id, "RC1").unwrap();
        assert_eq!(list(&conn).unwrap()[0].slots.len(), 1);

        // the map leaves the library: the slot keeps it, without a library id
        conn.execute("DELETE FROM maps WHERE id = 'c'", []).unwrap();
        let s = &list(&conn).unwrap()[0].slots[0];
        assert_eq!((s.map.as_deref(), s.md5.as_deref()), (None, Some("md5c")));

        delete(&conn, &id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pool_maps", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    /// A 4K chart of 200 notes, every fourth a hold, at 240 BPM.
    fn chart_text(keys: u32) -> String {
        let mut t = format!(
            "osu file format v14\n[General]\nMode: 3\n[Metadata]\nTitle:Song\nTitleUnicode:曲\nArtist:Someone\nCreator:Mapper\nVersion:Hard\nBeatmapID:555\nBeatmapSetID:77\n[Difficulty]\nCircleSize:{keys}\nOverallDifficulty:8\n[TimingPoints]\n0,250,4,1,0,100,1,0\n[HitObjects]\n"
        );
        for i in 0..200 {
            let (x, at) = (64 + (i % 4) * 128, 1000 + i * 125);
            if i % 4 == 0 {
                t += &format!("{x},192,{at},128,0,{}:0:0:0:0:\n", at + 100);
            } else {
                t += &format!("{x},192,{at},1,0,0:0:0:0:\n");
            }
        }
        t
    }

    #[test]
    fn links_to_difficulties() {
        assert_eq!(beatmap_of(" 2547774 "), Some(2547774));
        assert_eq!(beatmap_of("https://osu.ppy.sh/beatmapsets/1210406#mania/2547774"), Some(2547774));
        assert_eq!(beatmap_of("https://osu.ppy.sh/b/2547774"), Some(2547774));
        assert_eq!(beatmap_of("https://osu.ppy.sh/beatmaps/2547774?mode=mania"), Some(2547774));
        assert_eq!(beatmap_of("osu://b/2547774"), Some(2547774));
        // a whole set, or nothing of osu!'s
        assert_eq!(beatmap_of("https://osu.ppy.sh/beatmapsets/1210406"), None);
        assert_eq!(beatmap_of("https://example.com/b/1"), None);
        assert_eq!(beatmap_of("0"), None);
    }

    #[test]
    fn maps_not_in_the_library() {
        let mut conn = db();
        let dir = std::env::temp_dir().join(format!("fumen-pool-charts-{}-{}", std::process::id(), new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = chart_text(4);
        // in the cache already: nothing is downloaded
        std::fs::write(dir.join("555.osu"), &text).unwrap();
        let (got, md5) = online_chart(&dir, 555, None).unwrap();
        assert_eq!(got, text);
        let (md5b, online) = describe(555, &text).unwrap();
        assert_eq!(md5, md5b);
        assert_eq!((online.title.as_str(), online.title_unicode.as_str(), online.version.as_str(), online.set_id), ("Song", "曲", "Hard", Some(77)));
        assert_eq!((online.mode, online.keys, online.objects, online.holds), (3, 4, 200, 50));
        assert_eq!((online.bpm.round(), online.length), (240.0, (199 * 125) as f64));
        assert!(online.sr > 0.5, "{online:?}");

        let id = create(&conn, "Cup", 3, Some(4), &kinds()).unwrap();
        set_online(&mut conn, &id, "RC1", &md5, &online).unwrap();
        // a 7K chart doesn't go into a 4K pool, an osu! one into none for osu!mania
        let (md5_7, seven) = describe(556, &chart_text(7)).unwrap();
        assert_eq!(set_online(&mut conn, &id, "RC2", &md5_7, &seven).unwrap_err().code(), "wrong-keys");
        assert_eq!(set_online(&mut conn, &id, "RC2", &md5, &Online { mode: 0, ..online.clone() }).unwrap_err().code(), "wrong-ruleset");
        let s = &list(&conn).unwrap()[0].slots[0];
        assert_eq!((s.slot.as_str(), s.map.as_deref(), s.online_id), ("RC1", None, Some(555)));
        assert_eq!(s.online.as_ref(), Some(&online));
        assert_eq!(online_md5(&conn, 555).unwrap().as_deref(), Some(md5.as_str()));
        // its pp, from the kept file
        let sheet = crate::pp::sheet_with(|| Ok(text.as_bytes().to_vec()), &md5, &[], 1.5, &[]).unwrap();
        assert!(sheet.stars > online.sr);

        // the set comes into the library: the slot finds it by its MD5
        conn.execute("INSERT INTO maps (id, set_id, md5, online_id, ruleset_id) VALUES ('n', 's1', ?1, 555, 3)", [&md5]).unwrap();
        let s = &list(&conn).unwrap()[0].slots[0];
        assert_eq!((s.map.as_deref(), s.online.as_ref()), (Some("n"), None));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bad_input() {
        let conn = db();
        assert!(create(&conn, " ", 3, None, &kinds()).is_err());
        assert!(create(&conn, "x", 5, None, &kinds()).is_err());
        assert!(create(&conn, "x", 3, None, &[]).is_err());
        let twice = vec![Category { code: "RC".into(), count: 1, mods: vec![] }, Category { code: "rc".into(), count: 1, mods: vec![] }];
        assert!(create(&conn, "x", 3, None, &twice).is_err());
        assert!(create(&conn, "x", 3, None, &[Category { code: "R1".into(), count: 1, mods: vec![] }]).is_err());
        assert!(create(&conn, "x", 3, None, &[Category { code: "RC".into(), count: 17, mods: vec![] }]).is_err());
        // keys only for osu!mania
        let id = create(&conn, "x", 0, Some(4), &kinds()).unwrap();
        assert_eq!(list(&conn).unwrap()[0].keys, None);
        assert_eq!(list(&conn).unwrap()[0].id, id);
    }
}
