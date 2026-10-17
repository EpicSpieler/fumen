//! Collections in the cloud: Fumen's own (lists and smart ones) and lazer's / stable's, kept on
//! fumen.dertesti.dev under the player's osu! login, so another Fumen with the same login gets
//! them. Each difficulty goes up as its MD5 with osu!'s difficulty and set ids, so a PC that
//! doesn't have it can download the set from the mirrors.
//!
//! Getting them back merges by name: a list takes the difficulties it lacks, a smart collection
//! takes the saved search, and lazer's or stable's become Fumen collections unless that PC's
//! lazer / stable already has one of that name. Nothing is ever taken out.
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::downloads::USER_AGENT;
use crate::error::{Error, Result};
use crate::osu_auth::{self, Endpoints};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CloudMap {
    pub md5: String,
    /// osu!'s difficulty id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<i64>,
    /// osu!'s set id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CloudCollection {
    pub name: String,
    /// "fumen", "smart", "lazer" or "stable"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default)]
    pub maps: Vec<CloudMap>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Saved {
    pub collections: Vec<CloudCollection>,
    /// unix ms
    #[serde(default)]
    pub saved: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushSummary {
    pub collections: usize,
    pub saved: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MissingSet {
    pub id: i64,
    /// difficulties of it the collections want
    pub maps: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PullSummary {
    pub collections: usize,
    /// collections made here
    pub created: usize,
    /// difficulties put into collections here
    pub added: usize,
    /// sets the collections want that this library doesn't have (to download)
    pub missing: Vec<MissingSet>,
    /// when they were saved (unix ms)
    pub saved: i64,
}

const ITEMS_FUMEN: &str = "SELECT ci.md5,
    (SELECT m.online_id FROM maps m WHERE m.md5 = ci.md5 AND m.online_id > 0 LIMIT 1),
    (SELECT s.online_id FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = ci.md5 AND s.online_id > 0 LIMIT 1)
  FROM collection_items ci WHERE ci.collection_id = ?1 ORDER BY ci.added, ci.rowid";
const ITEMS_LAZER: &str = "SELECT ci.md5,
    (SELECT m.online_id FROM maps m WHERE m.md5 = ci.md5 AND m.online_id > 0 LIMIT 1),
    (SELECT s.online_id FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.md5 = ci.md5 AND s.online_id > 0 LIMIT 1)
  FROM lazer_collection_items ci WHERE ci.collection_id = ?1 ORDER BY ci.position";

fn items(conn: &Connection, sql: &str, id: &str) -> Result<Vec<CloudMap>> {
    let mut st = conn.prepare_cached(sql)?;
    let rows = st.query_map([id], |r| Ok(CloudMap { md5: r.get(0)?, b: r.get(1)?, s: r.get(2)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Every collection of this library, as it goes up.
pub fn gather(conn: &Connection) -> Result<Vec<CloudCollection>> {
    let mut out = Vec::new();
    let mut st = conn.prepare("SELECT id, name, query FROM collections ORDER BY position, created")?;
    let fumen: Vec<(String, String, Option<String>)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    for (id, name, query) in fumen {
        match query {
            Some(q) => out.push(CloudCollection { name, kind: "smart".into(), query: Some(q), maps: Vec::new() }),
            None => out.push(CloudCollection { name, kind: "fumen".into(), query: None, maps: items(conn, ITEMS_FUMEN, &id)? }),
        }
    }
    let mut st = conn.prepare("SELECT id, name, source FROM lazer_collections ORDER BY source, position")?;
    let lazer: Vec<(String, String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    for (id, name, source) in lazer {
        out.push(CloudCollection { name, kind: source, query: None, maps: items(conn, ITEMS_LAZER, &id)? });
    }
    Ok(out)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(Duration::from_secs(60)))
        .https_only(cfg!(not(test)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn failed(status: u16, body: &str) -> Error {
    let msg = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v["message"].as_str().map(String::from));
    match status {
        401 => Error::known("osu-logged-out", msg.unwrap_or_else(|| "osu! didn't accept the login. Log in again.".into())),
        404 => Error::known("cloud-empty", msg.unwrap_or_else(|| "Nothing saved in the cloud yet.".into())),
        _ => Error::known("cloud-failed", msg.unwrap_or_else(|| format!("Fumen's server answered {status}"))),
    }
}

/// Puts this library's collections into the cloud (replacing what was there).
pub fn push(data_dir: &Path, ep: &Endpoints, collections: Vec<CloudCollection>) -> Result<PushSummary> {
    let body = serde_json::to_string(&serde_json::json!({ "collections": collections }))?;
    osu_auth::with_token(data_dir, ep, |token| {
        let res = agent()
            .put(&format!("{}/api/collections", ep.site))
            .header("Authorization", &format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .send(body.as_str());
        let mut res = res.map_err(|e| Error::known("cloud-failed", format!("Fumen's server didn't answer ({e})")))?;
        let status = res.status().as_u16();
        let text = res.body_mut().read_to_string().unwrap_or_default();
        if status != 200 {
            return Err(failed(status, &text));
        }
        let v: serde_json::Value = serde_json::from_str(&text)?;
        Ok(PushSummary { collections: collections.len(), saved: v["saved"].as_i64().unwrap_or(0) })
    })
}

/// What's in the cloud for this login.
pub fn fetch(data_dir: &Path, ep: &Endpoints) -> Result<Saved> {
    osu_auth::with_token(data_dir, ep, |token| {
        let res = agent().get(&format!("{}/api/collections", ep.site)).header("Authorization", &format!("Bearer {token}")).call();
        let mut res = res.map_err(|e| Error::known("cloud-failed", format!("Fumen's server didn't answer ({e})")))?;
        let status = res.status().as_u16();
        let text = res.body_mut().with_config().limit(16 * 1024 * 1024).read_to_string().unwrap_or_default();
        if status != 200 {
            return Err(failed(status, &text));
        }
        Ok(serde_json::from_str(&text)?)
    })
}

fn by_name(conn: &Connection, name: &str, smart: bool) -> Result<Option<String>> {
    let sql = if smart {
        "SELECT id FROM collections WHERE name = ?1 AND query IS NOT NULL ORDER BY position LIMIT 1"
    } else {
        "SELECT id FROM collections WHERE name = ?1 AND query IS NULL ORDER BY position LIMIT 1"
    };
    Ok(conn.query_row(sql, [name], |r| r.get(0)).optional()?)
}

/// What a sane cloud save holds, at most (far beyond any real library).
const MAX_COLLECTIONS: usize = 2000;
const MAX_MAPS: usize = 200_000;
const MAX_QUERY: usize = 8 * 1024;

/// Only what can be real comes in from the server: known kinds, one-line names of up to 100
/// characters, md5s that are md5s, queries of a sane size, and not more than a library holds. A
/// server (or anyone in between) sending junk can't flood the library or freeze it.
fn clean(saved: &Saved) -> Saved {
    let mut maps_left = MAX_MAPS;
    let collections = saved
        .collections
        .iter()
        .filter(|c| matches!(c.kind.as_str(), "fumen" | "smart" | "lazer" | "stable"))
        .filter_map(|c| {
            let name: String = c.name.chars().map(|ch| if ch.is_control() { ' ' } else { ch }).collect::<String>().trim().chars().take(100).collect();
            if name.is_empty() {
                return None;
            }
            let query = c.query.clone().filter(|q| q.len() <= MAX_QUERY);
            if c.kind == "smart" && query.is_none() {
                return None;
            }
            let maps: Vec<CloudMap> = c
                .maps
                .iter()
                .filter(|m| m.md5.len() == 32 && m.md5.bytes().all(|b| b.is_ascii_hexdigit()))
                .take(maps_left)
                .map(|m| CloudMap { md5: m.md5.to_ascii_lowercase(), b: m.b.filter(|&v| v > 0), s: m.s.filter(|&v| v > 0) })
                .collect();
            maps_left -= maps.len();
            Some(CloudCollection { name, kind: c.kind.clone(), query, maps })
        })
        .take(MAX_COLLECTIONS)
        .collect();
    Saved { collections, saved: saved.saved }
}

/// Merges what was saved into this library's collections (see the top).
pub fn apply(conn: &mut Connection, saved: &Saved) -> Result<PullSummary> {
    let saved = &clean(saved);
    let (mut created, mut added) = (0, 0);
    let tx = conn.transaction()?;
    for c in &saved.collections {
        match c.kind.as_str() {
            "smart" => {
                let Some(q) = &c.query else { continue };
                match by_name(&tx, &c.name, true)? {
                    Some(id) => crate::collections::set_query(&tx, &id, q)?,
                    None => {
                        crate::collections::create_smart(&tx, &c.name, q)?;
                        created += 1;
                    }
                }
            }
            kind => {
                // lazer's / stable's already here stay theirs
                if kind != "fumen" {
                    let here: Option<i64> = tx.query_row("SELECT 1 FROM lazer_collections WHERE name = ?1 AND source = ?2", params![c.name, kind], |r| r.get(0)).optional()?;
                    if here.is_some() {
                        continue;
                    }
                }
                let id = match by_name(&tx, &c.name, false)? {
                    Some(id) => id,
                    None => {
                        created += 1;
                        crate::collections::create_in(&tx, &c.name)?
                    }
                };
                let md5s: Vec<String> = c.maps.iter().map(|m| m.md5.clone()).collect();
                added += crate::collections::insert_md5s(&tx, &id, &md5s)?;
            }
        }
    }
    tx.commit()?;
    // the sets wanted that this library doesn't have
    let mut have = conn.prepare("SELECT 1 FROM maps WHERE md5 = ?1 LIMIT 1")?;
    let mut sets: std::collections::BTreeMap<i64, BTreeSet<String>> = Default::default();
    for c in &saved.collections {
        for m in &c.maps {
            let Some(s) = m.s.filter(|&s| s > 0) else { continue };
            if have.query_row([&m.md5], |_| Ok(())).optional()?.is_none() {
                sets.entry(s).or_default().insert(m.md5.clone());
            }
        }
    }
    let missing = sets.into_iter().map(|(id, maps)| MissingSet { id, maps: maps.len() }).collect();
    Ok(PullSummary { collections: saved.collections.len(), created, added, missing, saved: saved.saved })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_from_the_server_stays_out() {
        let map = |md5: &str| CloudMap { md5: md5.into(), b: Some(-3), s: Some(7) };
        let col = |name: &str, kind: &str, maps: Vec<CloudMap>| CloudCollection { name: name.into(), kind: kind.into(), query: None, maps };
        let saved = Saved {
            collections: vec![
                col("good
name ", "fumen", vec![map("ABCDEF0123456789abcdef0123456789"), map("not an md5"), map(&"a".repeat(5000))]),
                col("   ", "fumen", vec![]),
                col("weird kind", "script", vec![]),
                col("smart without a query", "smart", vec![]),
                col(&"x".repeat(500), "lazer", vec![]),
            ],
            saved: 1,
        };
        let c = clean(&saved);
        assert_eq!(c.collections.len(), 2);
        assert_eq!(c.collections[0].name, "good name");
        assert_eq!(c.collections[0].maps.len(), 1);
        assert_eq!(c.collections[0].maps[0].md5, "abcdef0123456789abcdef0123456789");
        assert_eq!(c.collections[0].maps[0].b, None);
        assert_eq!(c.collections[1].name.chars().count(), 100);
    }

    /// Writes the real library's collections to FUMEN_CLOUD_EXPORT as they'd go up (run by hand).
    #[test]
    #[ignore]
    fn export_real() {
        let data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.fumen.app");
        let conn = crate::db::open(&data.join("library.db")).unwrap();
        let cols = gather(&conn).unwrap();
        let account = osu_auth::account(&data).expect("logged in");
        let out = serde_json::json!({ "version": 1, "user": account.id, "saved": crate::lazer::now_ms(), "collections": cols });
        std::fs::write(std::env::var("FUMEN_CLOUD_EXPORT").unwrap(), out.to_string()).unwrap();
        println!("user {} · {} collections", account.id, cols.len());
    }
}
