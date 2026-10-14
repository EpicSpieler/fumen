//! Fumen's own collections. Like lazer's and stable's, a collection holds difficulties by their
//! MD5 (the .osu file's hash), so it survives rescans, outlives a map being deleted and goes into
//! either game as it is. The UI works with the library's difficulty ids; this resolves them both ways.
//!
//! A smart collection holds a saved search instead (the UI's filters as JSON, opaque here) and
//! fills itself from the library; nothing is added to or taken out of it by hand.
//!
//! Out of Fumen they go into lazer (lazer_import.rs, which writes them with lazer's own code) or
//! into a stable `collection.db` (written here; stable and Collection Manager read it).
use std::io::Write;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// names are for a sidebar; nobody needs more
const MAX_NAME: usize = 100;
/// a saved search is a handful of filters
const MAX_QUERY: usize = 8 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    /// unix ms
    pub created: i64,
    /// the library's difficulty ids, in the order they were added
    pub maps: Vec<String>,
    /// difficulties not in the library (any more): kept, and counted here
    pub missing: usize,
    /// a smart collection's saved search (then `maps` is empty: the UI fills it)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// the lazer collection it went into or came from
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lazer_id: Option<String>,
}

fn clean_query(query: &str) -> Result<String> {
    if query.len() > MAX_QUERY || serde_json::from_str::<serde_json::Value>(query).map(|v| !v.is_object()).unwrap_or(true) {
        return Err(Error::known("bad-query", "That isn't a search Fumen can keep."));
    }
    Ok(query.to_string())
}

/// Hand-made only: smart collections fill themselves.
fn not_smart(conn: &Connection, id: &str) -> Result<()> {
    let smart: Option<Option<String>> = conn.query_row("SELECT query FROM collections WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    match smart {
        None => Err(Error::known("no-collection", "That collection doesn't exist any more.")),
        Some(Some(_)) => Err(Error::known("smart-collection", "A smart collection fills itself from its search.")),
        Some(None) => Ok(()),
    }
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::known("bad-name", "A collection needs a name."));
    }
    Ok(name.chars().take(MAX_NAME).collect())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A new id: 16 random bytes in hex.
fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).unwrap_or_default();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn exists(conn: &Connection, id: &str) -> Result<()> {
    let found = conn.query_row("SELECT 1 FROM collections WHERE id = ?1", [id], |_| Ok(())).optional()?;
    found.ok_or_else(|| Error::known("no-collection", "That collection doesn't exist any more."))
}

/// All collections, in the order they were made, with their difficulties resolved.
pub fn list(conn: &Connection) -> Result<Vec<Collection>> {
    let mut st = conn.prepare("SELECT id, name, created, query, lazer_id FROM collections ORDER BY position, created")?;
    let cols: Vec<(String, String, i64, Option<String>, Option<String>)> =
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?.collect::<Result<_, _>>()?;
    // a difficulty can sit in two sets (the same .osu imported twice): any of them will do
    let mut items = conn.prepare(
        "SELECT (SELECT m.id FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = ci.md5 ORDER BY s.source = 'stable' LIMIT 1)
         FROM collection_items ci WHERE ci.collection_id = ?1 ORDER BY ci.added, ci.rowid",
    )?;
    let mut out = Vec::with_capacity(cols.len());
    for (id, name, created, query, lazer_id) in cols {
        if query.is_some() {
            out.push(Collection { id, name, created, maps: Vec::new(), missing: 0, query, lazer_id });
            continue;
        }
        let ids: Vec<Option<String>> = items.query_map([&id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let missing = ids.iter().filter(|m| m.is_none()).count();
        out.push(Collection { id, name, created, maps: ids.into_iter().flatten().collect(), missing, query: None, lazer_id });
    }
    Ok(out)
}

/// The MD5s of library difficulties (unknown ids and ones without a hash are left out).
fn md5s_of(conn: &Connection, map_ids: &[String]) -> Result<Vec<String>> {
    let mut st = conn.prepare("SELECT md5 FROM maps WHERE id = ?1 AND md5 IS NOT NULL AND md5 != ''")?;
    let mut out = Vec::with_capacity(map_ids.len());
    for id in map_ids {
        if let Some(h) = st.query_row([id], |r| r.get::<_, String>(0)).optional()? {
            out.push(h);
        }
    }
    Ok(out)
}

pub(crate) fn insert_md5s(conn: &Connection, id: &str, md5s: &[String]) -> Result<usize> {
    let at = now_ms();
    let mut st = conn.prepare("INSERT OR IGNORE INTO collection_items (collection_id, md5, added) VALUES (?1, ?2, ?3)")?;
    let mut added = 0;
    for h in md5s {
        added += st.execute(params![id, h, at])?;
    }
    Ok(added)
}

/// Makes an empty collection inside a transaction that's already open. Returns its id.
pub(crate) fn create_in(conn: &Connection, name: &str) -> Result<String> {
    let name = clean_name(name)?;
    let id = new_id();
    let position: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM collections", [], |r| r.get(0))?;
    conn.execute("INSERT INTO collections (id, name, created, position) VALUES (?1, ?2, ?3, ?4)", params![id, name, now_ms(), position])?;
    Ok(id)
}

/// Makes a collection, with difficulties (library ids) in it already if given. Returns its id.
pub fn create(conn: &mut Connection, name: &str, map_ids: &[String]) -> Result<String> {
    let name = clean_name(name)?;
    let id = new_id();
    let tx = conn.transaction()?;
    let position: i64 = tx.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM collections", [], |r| r.get(0))?;
    tx.execute("INSERT INTO collections (id, name, created, position) VALUES (?1, ?2, ?3, ?4)", params![id, name, now_ms(), position])?;
    let md5s = md5s_of(&tx, map_ids)?;
    insert_md5s(&tx, &id, &md5s)?;
    tx.commit()?;
    Ok(id)
}

/// Saves a search as a smart collection. Returns its id.
pub fn create_smart(conn: &Connection, name: &str, query: &str) -> Result<String> {
    let (name, query) = (clean_name(name)?, clean_query(query)?);
    let id = new_id();
    let position: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM collections", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO collections (id, name, created, position, query) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, now_ms(), position, query],
    )?;
    Ok(id)
}

/// A smart collection's search, changed.
pub fn set_query(conn: &Connection, id: &str, query: &str) -> Result<()> {
    let query = clean_query(query)?;
    if conn.execute("UPDATE collections SET query = ?2 WHERE id = ?1 AND query IS NOT NULL", params![id, query])? == 0 {
        return Err(Error::known("no-collection", "That smart collection doesn't exist any more."));
    }
    Ok(())
}

/// A Fumen copy of one of lazer's collections, missing difficulties included.
pub fn copy_lazer(conn: &mut Connection, lazer_id: &str, name: &str) -> Result<String> {
    let tx = conn.transaction()?;
    let md5s: Vec<String> = {
        let mut st = tx.prepare("SELECT md5 FROM lazer_collection_items WHERE collection_id = ?1 ORDER BY position")?;
        let v = st.query_map([lazer_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        v
    };
    let id = new_id();
    let position: i64 = tx.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM collections", [], |r| r.get(0))?;
    // stable's collections (st-col-…) have no lazer collection to go back to
    let back = (!lazer_id.starts_with("st-")).then_some(lazer_id);
    tx.execute(
        "INSERT INTO collections (id, name, created, position, lazer_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, clean_name(name)?, now_ms(), position, back],
    )?;
    insert_md5s(&tx, &id, &md5s)?;
    tx.commit()?;
    Ok(id)
}

pub fn rename(conn: &Connection, id: &str, name: &str) -> Result<()> {
    exists(conn, id)?;
    conn.execute("UPDATE collections SET name = ?2 WHERE id = ?1", params![id, clean_name(name)?])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<()> {
    // items go with it (ON DELETE CASCADE)
    conn.execute("DELETE FROM collections WHERE id = ?1", [id])?;
    Ok(())
}

/// Adds difficulties (library ids); returns how many weren't in it yet.
pub fn add(conn: &mut Connection, id: &str, map_ids: &[String]) -> Result<usize> {
    not_smart(conn, id)?;
    let tx = conn.transaction()?;
    let md5s = md5s_of(&tx, map_ids)?;
    let added = insert_md5s(&tx, id, &md5s)?;
    tx.commit()?;
    Ok(added)
}

/// Takes difficulties (library ids) out; returns how many were in it.
pub fn remove(conn: &mut Connection, id: &str, map_ids: &[String]) -> Result<usize> {
    not_smart(conn, id)?;
    let tx = conn.transaction()?;
    let md5s = md5s_of(&tx, map_ids)?;
    let mut removed = 0;
    {
        let mut st = tx.prepare("DELETE FROM collection_items WHERE collection_id = ?1 AND md5 = ?2")?;
        for h in &md5s {
            removed += st.execute(params![id, h])?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

// ── out of Fumen ────────────────────────────────────────────────────────

/// A collection the UI wants out of Fumen; a smart one comes with its members (library ids).
#[derive(Deserialize, Debug)]
pub struct Pick {
    pub id: String,
    pub maps: Option<Vec<String>>,
}

/// A collection as it goes into a game: its name and difficulties by MD5.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
    /// Fumen's id
    pub key: String,
    pub lazer_id: Option<String>,
    pub name: String,
    pub md5s: Vec<String>,
}

/// The picked collections with their difficulties: a hand-made one's as kept (ones not in the
/// library included), a smart one's as it matches now.
pub fn outgoing(conn: &Connection, picks: &[Pick]) -> Result<Vec<Outgoing>> {
    let mut items = conn.prepare("SELECT md5 FROM collection_items WHERE collection_id = ?1 ORDER BY added, rowid")?;
    let mut out = Vec::with_capacity(picks.len());
    for p in picks {
        let row: Option<(String, Option<String>, Option<String>)> = conn
            .query_row("SELECT name, lazer_id, query FROM collections WHERE id = ?1", [&p.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()?;
        let (name, lazer_id, query) = row.ok_or_else(|| Error::known("no-collection", "That collection doesn't exist any more."))?;
        let md5s = if query.is_some() {
            let mut v = md5s_of(conn, p.maps.as_deref().unwrap_or_default())?;
            let mut seen = std::collections::HashSet::new();
            v.retain(|h| seen.insert(h.clone()));
            v
        } else {
            items.query_map([&p.id], |r| r.get(0))?.collect::<Result<_, _>>()?
        };
        out.push(Outgoing { key: p.id.clone(), lazer_id, name, md5s });
    }
    Ok(out)
}

/// Remembers which lazer collection a Fumen one went into.
pub fn set_lazer_id(conn: &Connection, id: &str, lazer_id: &str) -> Result<()> {
    conn.execute("UPDATE collections SET lazer_id = ?2 WHERE id = ?1", params![id, lazer_id])?;
    Ok(())
}

/// what stable writes as its version; any recent one reads the same format
const STABLE_DB_VERSION: i32 = 20240820;

/// stable's string: 0x0b, the UTF-8 length as ULEB128, the bytes
fn put_str(out: &mut Vec<u8>, s: &str) {
    out.push(0x0b);
    let mut n = s.len();
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
    out.extend_from_slice(s.as_bytes());
}

/// A stable `collection.db`: version, count, then per collection its name and MD5s.
pub fn collection_db(cols: &[Outgoing]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&STABLE_DB_VERSION.to_le_bytes());
    out.extend_from_slice(&(cols.len() as i32).to_le_bytes());
    for c in cols {
        put_str(&mut out, &c.name);
        out.extend_from_slice(&(c.md5s.len() as i32).to_le_bytes());
        for h in &c.md5s {
            put_str(&mut out, h);
        }
    }
    out
}

/// Writes `collection.db` at `path` (via a temporary file next to it, so a failed write leaves
/// whatever was there).
pub fn save_collection_db(path: &Path, cols: &[Outgoing]) -> Result<()> {
    let tmp = path.with_extension("db.fumen-tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&collection_db(cols))?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE sets (id TEXT PRIMARY KEY, source TEXT NOT NULL);
             CREATE TABLE maps (id TEXT PRIMARY KEY, md5 TEXT, set_id TEXT NOT NULL DEFAULT 'L');
             INSERT INTO sets VALUES ('L', 'lazer'), ('S', 'stable');
             CREATE TABLE lazer_collection_items (collection_id TEXT, md5 TEXT, position INTEGER);
             CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, position INTEGER NOT NULL, query TEXT, lazer_id TEXT);
             CREATE TABLE collection_items (
                 collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                 md5 TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (collection_id, md5));
             INSERT INTO maps (id, md5) VALUES ('a', 'ha'), ('b', 'hb'), ('c', 'hc'), ('nohash', NULL);
             INSERT INTO lazer_collection_items VALUES ('L', 'hb', 0), ('L', 'gone', 1), ('L', 'ha', 2);",
        )
        .unwrap();
        c
    }

    #[test]
    fn makes_fills_and_empties() {
        let mut c = conn();
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let id = create(&mut c, "  Jack practice ", &ids(&["a", "unknown", "nohash"])).unwrap();
        assert_eq!(add(&mut c, &id, &ids(&["b", "a"])).unwrap(), 1);
        let all = list(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Jack practice");
        assert_eq!(all[0].maps, ["a", "b"]);
        assert_eq!(all[0].missing, 0);
        assert_eq!(remove(&mut c, &id, &ids(&["a", "c"])).unwrap(), 1);
        assert_eq!(list(&c).unwrap()[0].maps, ["b"]);
        rename(&c, &id, "Jacks").unwrap();
        assert_eq!(list(&c).unwrap()[0].name, "Jacks");
        assert!(rename(&c, &id, "   ").is_err());
        assert!(add(&mut c, "nope", &ids(&["a"])).is_err());
        delete(&c, &id).unwrap();
        assert!(list(&c).unwrap().is_empty());
        let left: i64 = c.query_row("SELECT COUNT(*) FROM collection_items", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn keeps_searches() {
        let mut c = conn();
        let id = create_smart(&c, "4K jacks", r#"{"text":"pattern=jacks","keys":[4]}"#).unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all[0].query.as_deref(), Some(r#"{"text":"pattern=jacks","keys":[4]}"#));
        assert!(all[0].maps.is_empty());
        // filled by its search, not by hand
        assert!(add(&mut c, &id, &["a".to_string()]).is_err());
        assert!(remove(&mut c, &id, &["a".to_string()]).is_err());
        set_query(&c, &id, r#"{"text":"pattern=jacks","keys":[7]}"#).unwrap();
        assert!(list(&c).unwrap()[0].query.as_deref().unwrap().contains("[7]"));
        assert!(set_query(&c, &id, "not json").is_err());
        assert!(set_query(&c, &id, "[1]").is_err());
        assert!(create_smart(&c, "x", "").is_err());
        // a hand-made collection doesn't turn smart
        let plain = create(&mut c, "plain", &[]).unwrap();
        assert!(set_query(&c, &plain, "{}").is_err());
    }

    #[test]
    fn copies_lazers_with_what_is_missing() {
        let mut c = conn();
        let id = copy_lazer(&mut c, "L", "fav (copy)").unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all[0].id, id);
        assert_eq!(all[0].maps, ["b", "a"]);
        assert_eq!(all[0].missing, 1);
        // the missing one comes back when the map does
        c.execute("INSERT INTO maps VALUES ('g', 'gone', 'L')", []).unwrap();
        assert_eq!(list(&c).unwrap()[0].maps, ["b", "g", "a"]);
        // a difficulty in both games is lazer's
        c.execute("INSERT INTO maps VALUES ('0-stable', 'hb', 'S')", []).unwrap();
        assert_eq!(list(&c).unwrap()[0].maps, ["b", "g", "a"]);
        // …and it remembers where it came from, to go back there
        assert_eq!(list(&c).unwrap()[0].lazer_id.as_deref(), Some("L"));
    }

    #[test]
    fn goes_out_as_it_is() {
        let mut c = conn();
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let plain = copy_lazer(&mut c, "L", "fav").unwrap();
        let smart = create_smart(&c, "smart", "{}").unwrap();
        let picks = [Pick { id: plain.clone(), maps: None }, Pick { id: smart.clone(), maps: Some(s(&["c", "a", "c", "nohash"])) }];
        let out = outgoing(&c, &picks).unwrap();
        // a copy keeps what's not in the library; a smart one is what matches, once each
        assert_eq!(out[0], Outgoing { key: plain.clone(), lazer_id: Some("L".into()), name: "fav".into(), md5s: s(&["hb", "gone", "ha"]) });
        assert_eq!(out[1].md5s, s(&["hc", "ha"]));
        assert_eq!(out[1].lazer_id, None);
        set_lazer_id(&c, &smart, "L2").unwrap();
        assert_eq!(outgoing(&c, &picks).unwrap()[1].lazer_id.as_deref(), Some("L2"));
        assert!(outgoing(&c, &[Pick { id: "nope".into(), maps: None }]).is_err());
    }

    /// Reads a collection.db back the way stable does.
    fn read_db(b: &[u8]) -> (i32, Vec<(String, Vec<String>)>) {
        let int = |at: &mut usize| {
            let v = i32::from_le_bytes(b[*at..*at + 4].try_into().unwrap());
            *at += 4;
            v
        };
        let string = |at: &mut usize| {
            assert_eq!(b[*at], 0x0b);
            *at += 1;
            let (mut len, mut shift) = (0usize, 0);
            loop {
                let x = b[*at];
                *at += 1;
                len |= ((x & 0x7f) as usize) << shift;
                shift += 7;
                if x & 0x80 == 0 {
                    break;
                }
            }
            let s = String::from_utf8(b[*at..*at + len].to_vec()).unwrap();
            *at += len;
            s
        };
        let mut at = 0;
        let (version, n) = (int(&mut at), int(&mut at));
        let mut cols = Vec::new();
        for _ in 0..n {
            let name = string(&mut at);
            let count = int(&mut at);
            cols.push((name, (0..count).map(|_| string(&mut at)).collect()));
        }
        assert_eq!(at, b.len());
        (version, cols)
    }

    #[test]
    fn writes_stables_collection_db() {
        let long = "ä".repeat(100); // 200 bytes: a two-byte length
        let cols = [
            Outgoing { key: "1".into(), lazer_id: None, name: "Jacks ★".into(), md5s: vec!["a".repeat(32), "b".repeat(32)] },
            Outgoing { key: "2".into(), lazer_id: None, name: long.clone(), md5s: vec![] },
        ];
        let (version, read) = read_db(&collection_db(&cols));
        assert_eq!(version, STABLE_DB_VERSION);
        assert_eq!(read, vec![("Jacks ★".to_string(), vec!["a".repeat(32), "b".repeat(32)]), (long, vec![])]);
        let dir = std::env::temp_dir().join(format!("fumen-coldb-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("collection.db");
        std::fs::write(&path, b"old").unwrap();
        save_collection_db(&path, &cols).unwrap();
        assert_eq!(read_db(&std::fs::read(&path).unwrap()).1.len(), 2);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "the temporary file is gone");
        let _ = std::fs::remove_dir_all(dir);
    }
}
