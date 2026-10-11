//! Fumen's own collections. Like lazer's and stable's, a collection holds difficulties by their
//! MD5 (the .osu file's hash), so it survives rescans, outlives a map being deleted and goes into
//! either game as it is. The UI works with the library's difficulty ids; this resolves them both ways.
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{Error, Result};

/// names are for a sidebar; nobody needs more
const MAX_NAME: usize = 100;

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
    let mut st = conn.prepare("SELECT id, name, created FROM collections ORDER BY position, created")?;
    let cols: Vec<(String, String, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
    // a difficulty can sit in two sets (the same .osu imported twice): any of them will do
    let mut items = conn.prepare(
        "SELECT (SELECT m.id FROM maps m WHERE m.md5 = ci.md5 LIMIT 1)
         FROM collection_items ci WHERE ci.collection_id = ?1 ORDER BY ci.added, ci.rowid",
    )?;
    let mut out = Vec::with_capacity(cols.len());
    for (id, name, created) in cols {
        let ids: Vec<Option<String>> = items.query_map([&id], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let missing = ids.iter().filter(|m| m.is_none()).count();
        out.push(Collection { id, name, created, maps: ids.into_iter().flatten().collect(), missing });
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

fn insert_md5s(conn: &Connection, id: &str, md5s: &[String]) -> Result<usize> {
    let at = now_ms();
    let mut st = conn.prepare("INSERT OR IGNORE INTO collection_items (collection_id, md5, added) VALUES (?1, ?2, ?3)")?;
    let mut added = 0;
    for h in md5s {
        added += st.execute(params![id, h, at])?;
    }
    Ok(added)
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
    tx.execute("INSERT INTO collections (id, name, created, position) VALUES (?1, ?2, ?3, ?4)", params![id, clean_name(name)?, now_ms(), position])?;
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
    exists(conn, id)?;
    let tx = conn.transaction()?;
    let md5s = md5s_of(&tx, map_ids)?;
    let added = insert_md5s(&tx, id, &md5s)?;
    tx.commit()?;
    Ok(added)
}

/// Takes difficulties (library ids) out; returns how many were in it.
pub fn remove(conn: &mut Connection, id: &str, map_ids: &[String]) -> Result<usize> {
    exists(conn, id)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE maps (id TEXT PRIMARY KEY, md5 TEXT);
             CREATE TABLE lazer_collection_items (collection_id TEXT, md5 TEXT, position INTEGER);
             CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, position INTEGER NOT NULL, query TEXT);
             CREATE TABLE collection_items (
                 collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
                 md5 TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (collection_id, md5));
             INSERT INTO maps VALUES ('a', 'ha'), ('b', 'hb'), ('c', 'hc'), ('nohash', NULL);
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
    fn copies_lazers_with_what_is_missing() {
        let mut c = conn();
        let id = copy_lazer(&mut c, "L", "fav (copy)").unwrap();
        let all = list(&c).unwrap();
        assert_eq!(all[0].id, id);
        assert_eq!(all[0].maps, ["b", "a"]);
        assert_eq!(all[0].missing, 1);
        // the missing one comes back when the map does
        c.execute("INSERT INTO maps VALUES ('g', 'gone')", []).unwrap();
        assert_eq!(list(&c).unwrap()[0].maps, ["b", "g", "a"]);
    }
}
