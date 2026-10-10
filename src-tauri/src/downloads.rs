//! Beatmap sets from the internet: links to set IDs, and `.osz` downloads from mirrors.
//!
//! osu!'s own API doesn't let third-party apps download sets (that route is lazer's alone), so
//! sets come from mirrors, tried in order until one delivers a real archive. Beatmap links
//! (`/b/<id>`, `/beatmaps/<id>`) are turned into their set by asking osu.ppy.sh where they
//! redirect to — no login needed.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{Error, Result};

pub const USER_AGENT: &str = concat!("Fumen/", env!("CARGO_PKG_VERSION"), " (osu! library manager; https://github.com/EpicSpieler/fumen)");

/// Mirrors in the order they're tried, with their download URL for a set (without video).
pub const MIRRORS: [(&str, fn(u32) -> String); 3] = [
    ("osu.direct", |id| format!("https://osu.direct/api/d/{id}")),
    ("catboy.best", |id| format!("https://catboy.best/d/{id}n")),
    ("nerinyan.moe", |id| format!("https://api.nerinyan.moe/d/{id}?nv=1")),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Set(u32),
    Beatmap(u32),
}

/// What a pasted line points at: osu! set and beatmap links in their forms, `osu://s/…` /
/// `osu://b/…`, or a bare number (taken as a set ID, like the mirrors use).
pub fn parse_link(line: &str) -> Option<Target> {
    let s = line.trim().trim_matches(|c| c == '<' || c == '>' || c == '"');
    if s.is_empty() {
        return None;
    }
    if let Ok(id) = s.parse::<u32>() {
        return (id > 0).then_some(Target::Set(id));
    }
    let lower = s.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .map(|r| r.trim_start_matches("www.").strip_prefix("osu.ppy.sh"))
        .unwrap_or_else(|| lower.strip_prefix("osu:/"))?;
    let path = rest.split('#').next().unwrap_or(rest);
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    let num = |p: Option<&&str>| p.and_then(|v| v.parse::<u32>().ok()).filter(|&v| v > 0);
    match parts.as_slice() {
        // a set link with a difficulty in the fragment still means the set
        ["beatmapsets", id, ..] | ["s", id, ..] => num(Some(id)).map(Target::Set),
        ["beatmaps", id, ..] | ["b", id, ..] => num(Some(id)).map(Target::Beatmap),
        ["p", "beatmap"] => query
            .split('&')
            .find_map(|kv| kv.strip_prefix("b="))
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| v > 0)
            .map(Target::Beatmap),
        ["dl", id] => num(Some(id)).map(Target::Set),
        _ => None,
    }
}

fn agent(timeout: Duration, follow_redirects: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(timeout))
        .max_redirects(if follow_redirects { 10 } else { 0 })
        .http_status_as_error(false)
        .build()
        .into()
}

/// The set a beatmap belongs to, from where osu.ppy.sh/b/<id> redirects.
pub fn set_of_beatmap(beatmap: u32) -> Result<u32> {
    let res = agent(Duration::from_secs(15), false)
        .get(&format!("https://osu.ppy.sh/b/{beatmap}"))
        .call()
        .map_err(|e| Error::known("download-failed", format!("osu.ppy.sh didn't answer: {e}")))?;
    let location = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("");
    set_from_location(location).ok_or_else(|| Error::known("not-found", format!("Beatmap {beatmap} wasn't found on osu!")))
}

fn set_from_location(location: &str) -> Option<u32> {
    let after = location.split("/beatmapsets/").nth(1)?;
    after.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok().filter(|&v| v > 0)
}

/// Downloads a set into `dir` as `<id>.osz`, trying the mirrors in turn. `progress` gets
/// (bytes so far, total if known). Returns the file and the mirror that delivered it.
pub fn download_set(set: u32, dir: &Path, mut progress: impl FnMut(u64, Option<u64>)) -> Result<(PathBuf, &'static str)> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(format!("{set}.osz"));
    let part = dir.join(format!("{set}.osz.part"));
    let agent = agent(Duration::from_secs(300), true);
    let mut failures = Vec::new();
    for (name, url) in MIRRORS {
        match fetch(&agent, &url(set), &part, &mut progress) {
            Ok(()) => {
                std::fs::rename(&part, &target)?;
                return Ok((target, name));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                failures.push(format!("{name} {}", e.trim_start_matches("HTTP ")));
            }
        }
    }
    Err(Error::known("download-failed", format!("No download mirror has this set ({})", failures.join(", "))))
}

fn fetch(agent: &ureq::Agent, url: &str, out: &Path, progress: &mut impl FnMut(u64, Option<u64>)) -> std::result::Result<(), String> {
    let mut res = agent.get(url).call().map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if status != 200 {
        return Err(format!("HTTP {status}"));
    }
    let total = res.body().content_length();
    let mut reader = res.body_mut().as_reader();
    let mut file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut head = [0u8; 4];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if done < 4 {
            let take = (4 - done as usize).min(n);
            head[done as usize..done as usize + take].copy_from_slice(&buf[..take]);
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        progress(done, total);
    }
    file.flush().map_err(|e| e.to_string())?;
    // mirrors answer "not found" with JSON or HTML now and then, even with 200
    if &head != b"PK\x03\x04" || done < 1024 {
        return Err("not a beatmap archive".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        use Target::*;
        let cases = [
            ("https://osu.ppy.sh/beatmapsets/1225016#mania/2549232", Some(Set(1225016))),
            ("https://osu.ppy.sh/beatmapsets/1225016", Some(Set(1225016))),
            ("http://osu.ppy.sh/s/39804", Some(Set(39804))),
            ("https://osu.ppy.sh/b/75", Some(Beatmap(75))),
            ("https://osu.ppy.sh/beatmaps/2549232?mode=mania", Some(Beatmap(2549232))),
            ("https://osu.ppy.sh/p/beatmap?b=75&m=0", Some(Beatmap(75))),
            ("osu://s/39804", Some(Set(39804))),
            ("osu://b/75", Some(Beatmap(75))),
            ("osu://dl/39804", Some(Set(39804))),
            ("  1225016  ", Some(Set(1225016))),
            ("<https://www.osu.ppy.sh/beatmapsets/7>", Some(Set(7))),
            ("https://example.com/beatmapsets/1", None),
            ("https://osu.ppy.sh.example.com/beatmapsets/1", None),
            ("https://osu.ppy.sh/users/2", None),
            ("https://osu.ppy.sh/p/beatmap?b=0", None),
            ("0", None),
            ("hello", None),
            ("", None),
        ];
        for (line, want) in cases {
            assert_eq!(parse_link(line), want, "{line}");
        }
    }

    #[test]
    fn redirects() {
        assert_eq!(set_from_location("https://osu.ppy.sh/beatmapsets/1#osu/75"), Some(1));
        assert_eq!(set_from_location("/beatmapsets/1225016#mania/2549232"), Some(1225016));
        assert_eq!(set_from_location("https://osu.ppy.sh/home"), None);
    }
}
