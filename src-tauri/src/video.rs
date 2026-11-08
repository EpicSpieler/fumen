//! A difficulty's background video (the visualizer plays it in place of the cover): the
//! `Video,<offset>,"<file>"` line of its [Events], and that file among its set's files.

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::Result;
use crate::paths;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    /// the file's key (lazer's hash, or stable's key)
    pub file: String,
    /// song ms the video starts at
    pub offset: f64,
}

/// The video line of a chart: its file (as written, `/` for `\`) and offset, ms.
pub fn video_line(osu: &str) -> Option<(String, f64)> {
    let mut events = false;
    for line in osu.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('[') {
            if events {
                return None;
            }
            events = line == "[Events]";
            continue;
        }
        if !events || line.starts_with("//") {
            continue;
        }
        let mut parts = line.splitn(3, ',');
        let kind = parts.next()?.trim();
        if kind != "Video" && kind != "1" {
            continue;
        }
        let offset = parts.next().and_then(|o| o.trim().parse::<f64>().ok()).unwrap_or(0.0);
        // the name, quoted, maybe followed by x,y
        let rest = parts.next()?.trim();
        let name = match rest.strip_prefix('"') {
            Some(r) => r.split('"').next()?,
            None => rest.split(',').next()?,
        };
        let name = name.trim().replace('\\', "/");
        if name.is_empty() {
            return None;
        }
        return Some((name, offset));
    }
    None
}

/// A library difficulty's video, if its chart names one that's there.
pub fn for_map(conn: &Connection, files: &paths::Files, id: &str) -> Result<Option<Video>> {
    let row: Option<(Option<String>, String, String, Option<String>)> = conn
        .query_row("SELECT m.hash, s.source, s.files, s.folder FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .optional()?;
    let Some((Some(hash), source, set_files, folder)) = row else { return Ok(None) };
    let Some(bytes) = files.read(&hash) else { return Ok(None) };
    let Some((name, offset)) = video_line(&String::from_utf8_lossy(&bytes)) else { return Ok(None) };
    let lower = name.to_lowercase();
    let file = if source == "stable" {
        // stable: the key its scan gave the file in the set's folder
        let Some(folder) = folder else { return Ok(None) };
        let want = format!("{}/{lower}", folder.replace('\\', "/").to_lowercase());
        files.stable.keys.iter().find(|(_, rel)| rel.replace('\\', "/").to_lowercase() == want).map(|(k, _)| k.clone())
    } else {
        // lazer: [name, hash] pairs
        let list: Vec<(String, String)> = serde_json::from_str(&set_files).unwrap_or_default();
        list.into_iter().find(|(n, _)| n.replace('\\', "/").to_lowercase() == lower).map(|(_, h)| h)
    };
    Ok(file.map(|file| Video { file, offset }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_video_line() {
        let osu = "osu file format v14\n\n[Events]\n//Background and Video events\nVideo,-120,\"sb\\bga.mp4\"\n0,0,\"bg.jpg\",0,0\n[TimingPoints]\n";
        assert_eq!(video_line(osu), Some(("sb/bga.mp4".to_string(), -120.0)));
        assert_eq!(video_line("[Events]\n1,500,\"v.avi\",0,0\n"), Some(("v.avi".to_string(), 500.0)));
        assert_eq!(video_line("[Events]\n0,0,\"bg.jpg\",0,0\n[HitObjects]\nVideo,0,\"x.mp4\"\n"), None);
        assert_eq!(video_line("[General]\nAudioFilename: a.mp3\n"), None);
    }
}
