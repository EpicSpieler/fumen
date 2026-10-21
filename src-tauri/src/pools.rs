//! Map pools: what a tournament plays, slot by slot. A pool has kinds of slot (osu!mania's "RC"
//! rice, "LN", "HB" hybrid, "SV", "EX" and "TB"; "NM", "HD", "HR", "DT", "FM" and "TB" elsewhere,
//! or the player's own), each with a number of slots and the mods they're played with; a slot
//! ("RC2", or "TB" when its kind has one) holds one difficulty.
//!
//! Like collections, slots keep difficulties by MD5, so they survive rescans; they keep osu!'s
//! beatmap id too, which exports need (and which maps that aren't in the library have instead).
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

fn known_slot(conn: &Connection, pool: &str, slot: &str) -> Result<i64> {
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
                (SELECT m.id FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = pm.md5 ORDER BY s.source = 'stable' LIMIT 1)
         FROM pool_maps pm WHERE pm.pool_id = ?1",
    )?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, mode, keys, categories, note, created, updated) in rows {
        let categories: Vec<Category> = serde_json::from_str(&categories).unwrap_or_default();
        let order = slot_codes(&categories);
        let mut filled: Vec<Slot> = slots
            .query_map([&id], |r| Ok(Slot { slot: r.get(0)?, md5: r.get(1)?, online_id: r.get(2)?, note: r.get(3)?, map: r.get(4)? }))?
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
        "INSERT OR REPLACE INTO pool_maps (pool_id, slot, md5, online_id, note, added) VALUES (?1, ?2, ?3, ?4, '', ?5)",
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
