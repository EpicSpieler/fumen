//! The library snapshot the UI works on.
//!
//! The whole library (~5k sets / ~22k difficulties for a big install) is sent once as compact
//! JSON; the UI filters and sorts it in memory, so typing in the search box never waits on IPC.
//! Sets and maps reference each other by array index.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::db;
use crate::error::Result;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    source: &'static str,
    scanned_at: Option<i64>,
    sets: Vec<SetOut>,
    maps: Vec<MapOut>,
    collections: Vec<CollectionOut>,
    /// The player these local scores belong to (most frequent score owner).
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<UserOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserOut {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetOut {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    online_id: Option<i64>,
    status: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ranked: Option<i64>,
    title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    title_unicode: String,
    artist: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    artist_unicode: String,
    creator: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    source: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    tags: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    protected: bool,
    maps: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MapOut {
    set: u32,
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    online_id: Option<i64>,
    version: String,
    /// 0 osu, 1 taiko, 2 catch, 3 mania, -1 custom ruleset.
    mode: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ruleset: Option<String>,
    status: i64,
    sr: f64,
    bpm: f64,
    /// Drain-inclusive length in ms.
    length: f64,
    objects: i64,
    /// Objects with an end time: long notes in mania, sliders+spinners elsewhere.
    holds: i64,
    hp: f64,
    cs: f64,
    od: f64,
    ar: f64,
    // per-difficulty overrides, only when different from the set's
    #[serde(skip_serializing_if = "Option::is_none")]
    bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    played: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    best: Option<Best>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Best {
    /// lazer ScoreRank: -1 F, 0 D, 1 C, 2 B, 3 A, 4 S, 5 SH, 6 X (SS), 7 XH.
    rank: i64,
    acc: f64,
    score: i64,
    plays: i64,
    last: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CollectionOut {
    id: String,
    name: String,
    maps: Vec<u32>,
    /// Entries whose difficulty isn't in the library (deleted / never downloaded).
    missing: usize,
}

fn ruleset_mode(id: Option<i64>, name: Option<&str>) -> i64 {
    match (id, name) {
        (Some(i @ 0..=3), _) => i,
        (_, Some("osu")) => 0,
        (_, Some("taiko")) => 1,
        (_, Some("fruits")) => 2,
        (_, Some("mania")) => 3,
        _ => -1,
    }
}

pub fn snapshot_json(conn: &Connection) -> Result<Vec<u8>> {
    let scanned_at = db::get_meta(conn, "lazer.lastScan")?.and_then(|v| v.parse().ok());

    // best local score per difficulty (by total score), plus play count
    let mut best: HashMap<String, Best> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT map_md5, rank, accuracy, MAX(total_score), COUNT(*), MAX(date)
             FROM scores WHERE map_md5 IS NOT NULL GROUP BY map_md5",
        )?;
        let rows = st.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Best {
                    rank: r.get::<_, Option<i64>>(1)?.unwrap_or(-1),
                    acc: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    score: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    plays: r.get(4)?,
                    last: r.get(5)?,
                },
            ))
        })?;
        for row in rows {
            let (md5, b) = row?;
            best.insert(md5, b);
        }
    }

    let mut sets: Vec<SetOut> = Vec::new();
    let mut set_index: HashMap<String, u32> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT id, online_id, status, date_added, date_ranked, title, title_unicode, artist,
                    artist_unicode, creator, source_text, tags, bg, audio, preview_time, protected
             FROM sets ORDER BY date_added DESC, id",
        )?;
        let rows = st.query_map([], |r| {
            Ok(SetOut {
                id: r.get(0)?,
                online_id: r.get::<_, Option<i64>>(1)?.filter(|v| *v > 0),
                status: r.get::<_, Option<i64>>(2)?.unwrap_or(-3),
                added: r.get(3)?,
                ranked: r.get(4)?,
                title: r.get(5)?,
                title_unicode: r.get(6)?,
                artist: r.get(7)?,
                artist_unicode: r.get(8)?,
                creator: r.get(9)?,
                source: r.get(10)?,
                tags: r.get(11)?,
                bg: r.get(12)?,
                audio: r.get(13)?,
                preview: r.get(14)?,
                protected: r.get(15)?,
                maps: Vec::new(),
            })
        })?;
        for row in rows {
            let mut set = row?;
            // drop Unicode duplicates of the romanised field to keep the payload small
            if set.title_unicode == set.title {
                set.title_unicode.clear();
            }
            if set.artist_unicode == set.artist {
                set.artist_unicode.clear();
            }
            set_index.insert(set.id.clone(), sets.len() as u32);
            sets.push(set);
        }
    }

    let mut maps: Vec<MapOut> = Vec::new();
    let mut md5_index: HashMap<String, u32> = HashMap::new();
    {
        let mut st = conn.prepare(
            "SELECT set_id, id, online_id, version, ruleset, ruleset_id, status, sr, bpm, length,
                    objects, end_objects, hp, cs, od, ar, md5, bg, audio, preview_time,
                    last_played, hidden
             FROM maps ORDER BY set_id, ruleset_id, sr",
        )?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let set_id: String = r.get(0)?;
            let Some(&si) = set_index.get(&set_id) else { continue };
            let set = &sets[si as usize];
            let ruleset: Option<String> = r.get(4)?;
            let mode = ruleset_mode(r.get(5)?, ruleset.as_deref());
            let md5: Option<String> = r.get(16)?;
            let bg: Option<String> = r.get(17)?;
            let audio: Option<String> = r.get(18)?;
            let preview: Option<i64> = r.get(19)?;
            let differs_audio = audio.is_some() && audio != set.audio;
            let map = MapOut {
                set: si,
                id: r.get(1)?,
                online_id: r.get::<_, Option<i64>>(2)?.filter(|v| *v > 0),
                version: r.get(3)?,
                mode,
                ruleset: if mode < 0 { ruleset } else { None },
                status: r.get::<_, Option<i64>>(6)?.unwrap_or(-3),
                sr: r.get::<_, Option<f64>>(7)?.unwrap_or(0.0),
                bpm: r.get::<_, Option<f64>>(8)?.unwrap_or(0.0),
                length: r.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                objects: r.get::<_, Option<i64>>(10)?.unwrap_or(0),
                holds: r.get::<_, Option<i64>>(11)?.unwrap_or(0),
                hp: r.get::<_, Option<f64>>(12)?.unwrap_or(0.0),
                cs: r.get::<_, Option<f64>>(13)?.unwrap_or(0.0),
                od: r.get::<_, Option<f64>>(14)?.unwrap_or(0.0),
                ar: r.get::<_, Option<f64>>(15)?.unwrap_or(0.0),
                best: md5.as_ref().and_then(|h| best.get(h).cloned()),
                bg: if bg.is_some() && bg != set.bg { bg } else { None },
                preview: if differs_audio || (preview.is_some() && preview != set.preview) { preview } else { None },
                audio: if differs_audio { audio } else { None },
                played: r.get(20)?,
                hidden: r.get(21)?,
            };
            let mi = maps.len() as u32;
            if let Some(h) = md5 {
                md5_index.entry(h).or_insert(mi);
            }
            sets[si as usize].maps.push(mi);
            maps.push(map);
        }
    }
    // sets without difficulties are useless in the UI
    // (indices must stay stable, so they stay in the array with an empty map list)

    let mut collections: Vec<CollectionOut> = Vec::new();
    {
        let mut st = conn.prepare("SELECT id, name FROM lazer_collections ORDER BY position")?;
        let cols: Vec<(String, String)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        let mut items = conn.prepare(
            "SELECT md5 FROM lazer_collection_items WHERE collection_id = ?1 ORDER BY position",
        )?;
        for (id, name) in cols {
            let md5s: Vec<String> =
                items.query_map([&id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            let mut out = CollectionOut { id, name, maps: Vec::new(), missing: 0 };
            for h in md5s {
                match md5_index.get(&h) {
                    Some(&mi) => out.maps.push(mi),
                    None => out.missing += 1,
                }
            }
            collections.push(out);
        }
    }

    let user = conn
        .query_row(
            "SELECT user, MAX(user_id), COUNT(*) AS n FROM scores
             WHERE user IS NOT NULL AND user != '' GROUP BY user ORDER BY n DESC LIMIT 1",
            [],
            |r| Ok(UserOut { name: r.get(0)?, id: r.get::<_, Option<i64>>(1)?.filter(|v| *v > 1) }),
        )
        .optional()?;

    Ok(serde_json::to_vec(&Snapshot { source: "lazer", scanned_at, sets, maps, collections, user })?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes() {
        assert_eq!(ruleset_mode(Some(3), Some("mania")), 3);
        assert_eq!(ruleset_mode(None, Some("taiko")), 1);
        assert_eq!(ruleset_mode(Some(42), Some("rush")), -1);
    }
}
