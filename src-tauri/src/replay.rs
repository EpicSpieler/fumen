//! Replays for the playfield: the lazer scores of a difficulty that come with a replay, and a
//! replay's frames read from its `.osr` (in lazer's files/, by hash).
//!
//! `.osr` is osu!'s legacy replay format, which lazer writes too: a header (ruleset, beatmap MD5,
//! player, counts, mods …) and the frames as LZMA-compressed text, `delta|x|y|buttons,` each.
//! Frames are read the way lazer's LegacyScoreDecoder reads them (MIT, ppy Pty Ltd): the seed
//! frame (`-12345`) and stable's two lead-in frames at (256, -500) are dropped, and so are
//! frames that go back in time. osu!mania keeps its keys in x (bit n: column n down).
use std::io::Cursor;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayEntry {
    /// lazer's score id
    pub id: String,
    pub user: Option<String>,
    /// unix ms
    pub date: Option<i64>,
    pub accuracy: Option<f64>,
    pub score: Option<i64>,
    pub rank: Option<i64>,
    pub combo: Option<i64>,
    pub mods: Vec<String>,
    /// playback rate from the mods, when not 1×
    pub rate: Option<f64>,
    /// lazer's judgement counts (perfect, great, … miss)
    pub statistics: Option<String>,
}

/// The lazer scores on a library difficulty (by its id) that have a replay, best first.
pub fn list(conn: &Connection, map_id: &str) -> Result<Vec<ReplayEntry>> {
    let mut st = conn.prepare(
        "SELECT id, user, date, accuracy, total_score, rank, max_combo, mods, statistics FROM scores
         WHERE map_md5 = (SELECT md5 FROM maps WHERE id = ?1) AND replay IS NOT NULL ORDER BY total_score DESC LIMIT 100",
    )?;
    let rows = st.query_map([map_id], |r| {
        let mods: Option<String> = r.get(7)?;
        let (mods, rate) = crate::osu_scores::mods_of(mods.as_deref().unwrap_or(""));
        Ok(ReplayEntry {
            id: r.get(0)?,
            user: r.get(1)?,
            date: r.get(2)?,
            accuracy: r.get(3)?,
            score: r.get(4)?,
            rank: r.get(5)?,
            combo: r.get(6)?,
            mods,
            rate,
            statistics: r.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    /// 0 osu!, 1 taiko, 2 catch, 3 mania
    pub mode: u8,
    pub player: String,
    pub beatmap_md5: String,
    /// [time, x, y, buttons] per frame, song ms
    pub frames: Vec<f64>,
}

/// A lazer score's replay, read from lazer's files.
pub fn load(conn: &Connection, storage: &Path, score_id: &str) -> Result<Replay> {
    let hash: Option<String> = conn
        .query_row("SELECT replay FROM scores WHERE id = ?1", [score_id], |r| r.get(0))
        .optional()?
        .flatten();
    let hash = hash.ok_or_else(|| Error::known("replay-missing", "lazer has no replay for this score."))?;
    let path = crate::paths::lazer_file(storage, &hash).ok_or_else(|| Error::known("replay-missing", "lazer has no replay for this score."))?;
    let bytes = std::fs::read(&path).map_err(|_| Error::known("replay-missing", "The replay file isn't in lazer's files any more. Update the library."))?;
    parse(&bytes)
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8]> {
        let end = self.i.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(bad)?;
        let s = &self.b[self.i..end];
        self.i = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    /// 0x00, or 0x0b and a ULEB128 length and UTF-8
    fn string(&mut self) -> Result<String> {
        match self.u8()? {
            0 => Ok(String::new()),
            0x0b => {
                let mut len = 0usize;
                let mut shift = 0;
                loop {
                    let b = self.u8()?;
                    len |= ((b & 0x7f) as usize) << shift;
                    if b & 0x80 == 0 {
                        break;
                    }
                    shift += 7;
                    if shift > 28 {
                        return Err(bad());
                    }
                }
                Ok(String::from_utf8_lossy(self.take(len)?).into_owned())
            }
            _ => Err(bad()),
        }
    }
}

fn bad() -> Error {
    Error::known("replay-unreadable", "The replay file couldn't be read.")
}

pub fn parse(bytes: &[u8]) -> Result<Replay> {
    let mut r = Reader { b: bytes, i: 0 };
    let mode = r.u8()?;
    let _version = r.i32()?;
    let beatmap_md5 = r.string()?;
    let player = r.string()?;
    let _replay_md5 = r.string()?;
    for _ in 0..6 {
        r.u16()?;
    }
    let _score = r.i32()?;
    let _combo = r.u16()?;
    let _perfect = r.u8()?;
    let _mods = r.i32()?;
    let _life = r.string()?;
    let _timestamp = r.i64()?;
    let len = r.i32()?;
    if len <= 0 {
        return Err(bad());
    }
    let data = r.take(len as usize)?;
    let mut text = Vec::new();
    lzma_rs::lzma_decompress(&mut Cursor::new(data), &mut text).map_err(|_| bad())?;
    let text = String::from_utf8_lossy(&text);
    Ok(Replay { mode, player, beatmap_md5, frames: frames(&text) })
}

/// The frames, as lazer's LegacyScoreDecoder reads them.
fn frames(text: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let mut last = 0.0f64;
    for (i, frame) in text.split(',').enumerate() {
        let p: Vec<&str> = frame.split('|').collect();
        if p.len() < 4 {
            continue;
        }
        if p[0] == "-12345" {
            continue;
        }
        let num = |s: &str| s.trim().parse::<f64>().ok();
        let (Some(diff), Some(x), Some(y)) = (num(p[0]), num(p[1]), num(p[2])) else { continue };
        let buttons = num(p[3]).unwrap_or(0.0);
        last += diff;
        // stable's two lead-in frames
        if i < 2 && x == 256.0 && y == -500.0 {
            continue;
        }
        // like lazer: frames going back in time are skipped
        if diff < 0.0 {
            continue;
        }
        out.extend([last, x, y, buttons]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_frames_like_lazer() {
        let f = frames("0|256|-500|0,-1|256|-500|0,100|1|0|0,20|0|0|0,-5|3|0|0,10|2|0|0,-12345|0|0|7,");
        // the lead-ins go; the frame going back is dropped but its time still counts
        assert_eq!(f, vec![99.0, 1.0, 0.0, 0.0, 119.0, 0.0, 0.0, 0.0, 124.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn reads_an_osr() {
        // a small .osr built by hand: header, then "0|256|-500|0,-1|256|-500|0,50|5|0|0,30|0|0|0," in LZMA
        let text = b"0|256|-500|0,-1|256|-500|0,50|5|0|0,30|0|0|0,";
        let mut packed = Vec::new();
        lzma_rs::lzma_compress(&mut Cursor::new(&text[..]), &mut packed).unwrap();
        let mut b = vec![3u8];
        b.extend(20240101i32.to_le_bytes());
        let s = |b: &mut Vec<u8>, v: &str| {
            b.push(0x0b);
            b.push(v.len() as u8);
            b.extend(v.as_bytes());
        };
        s(&mut b, "abc");
        s(&mut b, "player");
        b.push(0);
        b.extend([0u8; 12]);
        b.extend(1000i32.to_le_bytes());
        b.extend(5u16.to_le_bytes());
        b.push(1);
        b.extend(0i32.to_le_bytes());
        b.push(0);
        b.extend(0i64.to_le_bytes());
        b.extend((packed.len() as i32).to_le_bytes());
        b.extend(&packed);
        b.extend(0i64.to_le_bytes());
        let r = parse(&b).unwrap();
        assert_eq!(r.mode, 3);
        assert_eq!(r.player, "player");
        assert_eq!(r.beatmap_md5, "abc");
        assert_eq!(r.frames, vec![49.0, 5.0, 0.0, 0.0, 79.0, 0.0, 0.0, 0.0]);
    }
}

#[cfg(test)]
mod real {
    use super::*;

    /// Writes the chart, replay and lazer's counts of the newest osu!mania scores in a sidecar
    /// export (FUMEN_REPLAY_SCORES) to FUMEN_REPLAY_EXPORT (a folder), for the judging test. Run by
    /// hand; reads lazer's files and the library read-only.
    #[test]
    #[ignore]
    fn export_real_replays() {
        let data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap());
        let out = std::path::PathBuf::from(std::env::var("FUMEN_REPLAY_EXPORT").unwrap());
        let export: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(std::env::var("FUMEN_REPLAY_SCORES").unwrap()).unwrap()).unwrap();
        let storage = data.join("osu");
        let conn = Connection::open_with_flags(data.join("dev.fumen.app").join("library.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let files = crate::paths::Files::lazer(&storage);
        let mut scores: Vec<&serde_json::Value> = export["scores"].as_array().unwrap().iter().filter(|s| s["ruleset"] == "mania" && s["replay"].is_string()).collect();
        scores.sort_by_key(|s| -s["date"].as_i64().unwrap_or(0));
        let mut n = 0;
        for s in scores {
            let limit: usize = std::env::var("FUMEN_REPLAY_LIMIT").ok().and_then(|v| v.parse().ok()).unwrap_or(16);
            if n >= limit {
                break;
            }
            let Some((hash, od, map_id)) = conn
                .query_row("SELECT hash, od, id FROM maps WHERE md5 = ?1", [s["mapMd5"].as_str().unwrap_or("")], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, String>(2)?)))
                .optional()
                .unwrap()
            else {
                continue;
            };
            let (acronyms, rate) = crate::osu_scores::mods_of(s["mods"].as_str().unwrap_or(""));
            let mut m = crate::mods::Mods::default();
            m.mirror = acronyms.iter().any(|a| a == "MR");
            let Ok(chart) = crate::charts::load_with(&files, &hash, m) else { continue };
            let chart = serde_json::from_slice::<serde_json::Value>(&crate::charts::chart_json(&chart, m).unwrap()).unwrap();
            let Some(path) = crate::paths::lazer_file(&storage, s["replay"].as_str().unwrap()) else { continue };
            let Ok(replay) = parse(&std::fs::read(path).unwrap()) else { continue };
            let case = serde_json::json!({
                "id": s["id"], "mapId": map_id, "user": s["user"], "date": s["date"], "rawMods": s["mods"], "mods": acronyms, "rate": rate.unwrap_or(1.0), "od": od, "accuracy": s["accuracy"],
                "statistics": s["statistics"].as_str().and_then(|v| serde_json::from_str::<serde_json::Value>(v).ok()),
                "notes": chart["notes"], "keys": chart["keys"], "frames": replay.frames,
            });
            std::fs::write(out.join(format!("{n}.json")), case.to_string()).unwrap();
            n += 1;
        }
        println!("{n} replays");
    }
}
