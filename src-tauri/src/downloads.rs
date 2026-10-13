//! Beatmap sets from the internet: links to set IDs, and `.osz` downloads from mirrors.
//!
//! osu!'s own API doesn't let third-party apps download sets (that route is lazer's alone), and
//! nothing here ever fetches a file from osu!'s servers: sets come from community mirrors.
//! Downloads share a [`Mirrors`] pool that spreads them over the mirrors, so no single one sees
//! a whole import, and that pauses a mirror when it says "too many requests" (for as long as its
//! `Retry-After` asks) instead of failing sets. Beatmap links (`/b/<id>`, `/beatmaps/<id>`) are
//! turned into their set by the mirrors' beatmap lookups too.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

/// Mirrors want a user agent that names the app (catboy.best turns away ones with a URL in it).
pub const USER_AGENT: &str = concat!("Fumen/", env!("CARGO_PKG_VERSION"), " (osu! library manager)");

pub struct Mirror {
    pub name: &'static str,
    /// the download URL for a set, without video where the mirror has that
    url: fn(u32) -> String,
}

/// The mirrors, best first: when all of them are equally busy, the first ones get the next set.
pub const MIRRORS: [Mirror; 6] = [
    Mirror { name: "osu.direct", url: |id| format!("https://osu.direct/api/d/{id}") },
    Mirror { name: "nekoha.moe", url: |id| format!("https://mirror.nekoha.moe/api4/download/{id}") },
    Mirror { name: "catboy.best", url: |id| format!("https://catboy.best/d/{id}n") },
    Mirror { name: "beatconnect.io", url: |id| format!("https://beatconnect.io/b/{id}/") },
    Mirror { name: "sayobot.cn", url: |id| format!("https://dl.sayobot.cn/beatmaps/download/novideo/{id}") },
    Mirror { name: "nerinyan.moe", url: |id| format!("https://api.nerinyan.moe/d/{id}?nv=1") },
];

/// Beatmap lookups (beatmap ID → set) that answer osu!-API-style JSON with `beatmapset_id`.
const LOOKUPS: [(&str, fn(u32) -> String); 3] = [
    ("osu.direct", |id| format!("https://osu.direct/api/v2/b/{id}")),
    ("nekoha.moe", |id| format!("https://mirror.nekoha.moe/api4/beatmap/{id}")),
    ("catboy.best", |id| format!("https://catboy.best/api/v2/b/{id}")),
];

/// Downloads from one mirror at once, at most.
const PER_MIRROR: u32 = 2;
/// Tries per set on a mirror that failed for other reasons than not having it.
const TRIES: u32 = 2;
/// A mirror that refuses or breaks rests this long, doubled per failure in a row.
const REST_AFTER_ERROR: Duration = Duration::from_secs(20);
const MAX_REST: Duration = Duration::from_secs(60 * 60);
/// "Too many requests" without a `Retry-After`: this long.
const REST_AFTER_429: Duration = Duration::from_secs(60);
/// A set waits this long at most for a resting mirror; longer and it fails (and can be tried
/// again later).
const MAX_WAIT: Duration = Duration::from_secs(20 * 60);
/// Refusals (403) in a row that make a mirror rest: a single one is "not here" (sayobot answers
/// a set it doesn't have like that).
const REFUSALS_TO_REST: u32 = 3;

#[derive(Default, Clone)]
struct MirrorState {
    rest_until: Option<Instant>,
    active: u32,
    /// downloads started (for spreading the sets)
    started: u32,
    errors_in_a_row: u32,
    refusals_in_a_row: u32,
}

/// The mirrors' state, shared by the downloads of an import.
pub struct Mirrors {
    state: Mutex<Vec<MirrorState>>,
}

impl Default for Mirrors {
    fn default() -> Self {
        Mirrors { state: Mutex::new(vec![MirrorState::default(); MIRRORS.len()]) }
    }
}

/// How a download goes along.
pub enum Progress {
    Bytes { done: u64, total: Option<u64> },
    /// every mirror that may have the set is busy with other sets, or resting after a rate limit
    /// until about then
    Waiting { until: Instant },
}

#[derive(Debug, PartialEq)]
enum Outcome {
    /// not on this mirror (404, refused once, or not an archive)
    Missing(String),
    /// "too many requests": the mirror rests this long
    Limited(Duration),
    /// broken connection, server error, …
    Failed(String),
    Cancelled,
}

#[derive(Clone, Copy, PartialEq)]
enum Tried {
    No,
    Missing,
    Failed(u32),
}

impl Mirrors {
    /// The mirror for the next try: of those not resting and not too busy that may still have the
    /// set, the least busy one, then the one that's had fewest sets, then the best.
    fn pick(&self, tried: &[Tried]) -> Option<usize> {
        let now = Instant::now();
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let best = (0..MIRRORS.len())
            .filter(|&i| matches!(tried[i], Tried::No) || matches!(tried[i], Tried::Failed(n) if n < TRIES))
            .filter(|&i| state[i].rest_until.map_or(true, |t| t <= now) && state[i].active < PER_MIRROR)
            .min_by_key(|&i| (matches!(tried[i], Tried::Failed(_)), state[i].active, state[i].started, i))?;
        state[best].active += 1;
        state[best].started += 1;
        Some(best)
    }

    fn finished(&self, i: usize, outcome: Option<&Outcome>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let m = &mut state[i];
        m.active -= 1;
        let rest = |m: &mut MirrorState, d: Duration| {
            let until = Instant::now() + d.min(MAX_REST);
            m.rest_until = Some(m.rest_until.map_or(until, |t| t.max(until)));
        };
        match outcome {
            // delivered
            None => {
                m.errors_in_a_row = 0;
                m.refusals_in_a_row = 0;
            }
            Some(Outcome::Limited(d)) => rest(m, *d),
            Some(Outcome::Failed(_)) => {
                m.errors_in_a_row += 1;
                let d = REST_AFTER_ERROR * 2u32.pow(m.errors_in_a_row.min(8) - 1);
                rest(m, d);
            }
            Some(Outcome::Missing(why)) if why.starts_with("HTTP 403") => {
                m.refusals_in_a_row += 1;
                if m.refusals_in_a_row >= REFUSALS_TO_REST {
                    m.refusals_in_a_row = 0;
                    rest(m, REST_AFTER_ERROR * 15);
                }
            }
            Some(Outcome::Missing(_)) => m.refusals_in_a_row = 0,
            Some(Outcome::Cancelled) => {}
        }
    }

    /// When the first mirror that may still have the set is free again (None: none may).
    fn next_free(&self, tried: &[Tried]) -> Option<Instant> {
        let now = Instant::now();
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        (0..MIRRORS.len())
            .filter(|&i| matches!(tried[i], Tried::No) || matches!(tried[i], Tried::Failed(n) if n < TRIES))
            .map(|i| match state[i].rest_until {
                Some(t) if t > now => t,
                // busy with other sets: soon
                _ => now,
            })
            .min()
    }
}

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

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .user_agent(USER_AGENT)
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into()
}

/// The set a beatmap belongs to, asked of the mirrors' beatmap lookups in turn.
pub fn set_of_beatmap(beatmap: u32) -> Result<u32> {
    let agent = agent(Duration::from_secs(15));
    let mut failures = Vec::new();
    for (name, url) in LOOKUPS {
        let answer = agent.get(&url(beatmap)).call();
        match answer {
            Ok(mut res) if res.status() == 200 => {
                let set = res
                    .body_mut()
                    .read_to_string()
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                    .and_then(|v| v["beatmapset_id"].as_u64())
                    .and_then(|v| u32::try_from(v).ok())
                    .filter(|&v| v > 0);
                match set {
                    Some(set) => return Ok(set),
                    None => failures.push(format!("{name} answered something else")),
                }
            }
            Ok(res) if res.status() == 404 => failures.push(format!("{name} 404")),
            Ok(res) => failures.push(format!("{name} {}", res.status().as_u16())),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    if failures.iter().all(|f| f.ends_with(" 404")) {
        return Err(Error::known("not-found", format!("Beatmap {beatmap} wasn't found on the mirrors")));
    }
    Err(Error::known("download-failed", format!("Couldn't find beatmap {beatmap}'s set ({})", failures.join(", "))))
}

/// Downloads a set into `dir` as `<id>.osz` from whichever mirror has it, sharing `mirrors` with
/// the other downloads running. `progress` hears how it goes and says whether to go on (false:
/// the download stops with a "cancelled" error). Returns the file and the mirror that delivered
/// it.
pub fn download_set(set: u32, dir: &Path, mirrors: &Mirrors, mut progress: impl FnMut(Progress) -> bool) -> Result<(PathBuf, &'static str)> {
    std::fs::create_dir_all(dir)?;
    let target = dir.join(format!("{set}.osz"));
    let part = dir.join(format!("{set}.osz.part"));
    let agent = agent(Duration::from_secs(300));
    let mut tried = [Tried::No; MIRRORS.len()];
    let mut why: Vec<String> = vec![String::new(); MIRRORS.len()];
    let mut waited_since: Option<Instant> = None;
    loop {
        let Some(i) = mirrors.pick(&tried) else {
            // every mirror said no, or the ones left are resting or busy
            let Some(free) = mirrors.next_free(&tried) else { break };
            let since = *waited_since.get_or_insert_with(Instant::now);
            if free.saturating_duration_since(since) > MAX_WAIT {
                return Err(Error::known(
                    "rate-limited",
                    format!("The mirrors are busy for a while (rate limits); try this set again later ({})", reasons(&why)),
                ));
            }
            if !progress(Progress::Waiting { until: free }) {
                return Err(Error::known("cancelled", "Cancelled"));
            }
            std::thread::sleep(Duration::from_millis(250));
            continue;
        };
        waited_since = None;
        let mirror = &MIRRORS[i];
        let outcome = fetch(&agent, &(mirror.url)(set), &part, &mut progress);
        match outcome {
            Ok(()) => {
                mirrors.finished(i, None);
                std::fs::rename(&part, &target)?;
                return Ok((target, mirror.name));
            }
            Err(outcome) => {
                let _ = std::fs::remove_file(&part);
                mirrors.finished(i, Some(&outcome));
                match outcome {
                    Outcome::Cancelled => return Err(Error::known("cancelled", "Cancelled")),
                    Outcome::Missing(w) => {
                        tried[i] = Tried::Missing;
                        why[i] = w;
                    }
                    Outcome::Limited(_) => why[i] = "429".into(),
                    Outcome::Failed(w) => {
                        tried[i] = Tried::Failed(match tried[i] {
                            Tried::Failed(n) => n + 1,
                            _ => 1,
                        });
                        why[i] = w;
                    }
                }
            }
        }
    }
    if tried.iter().all(|t| *t == Tried::Missing) && why.iter().all(|w| w.starts_with("HTTP 404") || w.starts_with("HTTP 403") || w == NOT_ARCHIVE) {
        return Err(Error::known("not-found", format!("No download mirror has this set ({})", reasons(&why))));
    }
    Err(Error::known("download-failed", format!("No download mirror could deliver this set ({})", reasons(&why))))
}

/// Mirrors that serve a single difficulty's `.osu` file by osu!'s difficulty ID.
const CHART_MIRRORS: [(&str, fn(i64) -> String); 3] = [
    ("osu.direct", |id| format!("https://osu.direct/api/osu/{id}")),
    ("nekoha.moe", |id| format!("https://mirror.nekoha.moe/api4/osu/{id}")),
    ("catboy.best", |id| format!("https://catboy.best/osu/{id}")),
];

/// A difficulty's `.osu` file from the mirrors (never osu!'s servers), starting with mirror
/// `first` so parallel callers spread over them. Ok(None): no mirror has it.
pub fn download_chart(agent: &ureq::Agent, beatmap: i64, first: usize) -> Result<Option<String>> {
    let mut failures = Vec::new();
    let mut missing = 0;
    for k in 0..CHART_MIRRORS.len() {
        let (name, url) = CHART_MIRRORS[(first + k) % CHART_MIRRORS.len()];
        match agent.get(&url(beatmap)).call() {
            Ok(mut res) if res.status() == 200 => {
                let text = res.body_mut().with_config().limit(32 * 1024 * 1024).read_to_string().unwrap_or_default();
                if text.trim_start_matches('\u{feff}').trim_start().starts_with("osu file format") {
                    return Ok(Some(text));
                }
                missing += 1;
            }
            Ok(res) if matches!(res.status().as_u16(), 404 | 410) => missing += 1,
            Ok(res) => failures.push(format!("{name} {}", res.status().as_u16())),
            Err(e) => failures.push(format!("{name}: {e}")),
        }
    }
    if missing == CHART_MIRRORS.len() || failures.is_empty() {
        return Ok(None);
    }
    Err(Error::known("download-failed", format!("Couldn't get difficulty {beatmap} ({})", failures.join(", "))))
}

/// An agent for many small requests to the mirrors.
pub fn chart_agent() -> ureq::Agent {
    agent(Duration::from_secs(30))
}

fn reasons(why: &[String]) -> String {
    MIRRORS
        .iter()
        .zip(why)
        .filter(|(_, w)| !w.is_empty())
        .map(|(m, w)| format!("{} {}", m.name, w.trim_start_matches("HTTP ")))
        .collect::<Vec<_>>()
        .join(", ")
}

const NOT_ARCHIVE: &str = "not a beatmap archive";

/// How long a "too many requests" answer asks to wait.
fn retry_after(res: &ureq::http::Response<ureq::Body>) -> Duration {
    let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    // seconds (an HTTP date is rare here; then the default)
    header("retry-after")
        .and_then(|v| v.parse::<u64>().ok())
        .or_else(|| header("x-ratelimit-reset").and_then(|v| v.parse::<u64>().ok()).filter(|&s| s <= 3600))
        .map(|s| Duration::from_secs(s.max(1)))
        .unwrap_or(REST_AFTER_429)
}

fn fetch(agent: &ureq::Agent, url: &str, out: &Path, progress: &mut impl FnMut(Progress) -> bool) -> std::result::Result<(), Outcome> {
    let mut res = agent.get(url).call().map_err(|e| Outcome::Failed(e.to_string()))?;
    let status = res.status().as_u16();
    match status {
        200 => {}
        429 => return Err(Outcome::Limited(retry_after(&res))),
        404 | 403 | 410 | 451 => return Err(Outcome::Missing(format!("HTTP {status}"))),
        _ => return Err(Outcome::Failed(format!("HTTP {status}"))),
    }
    let total = res.body().content_length();
    let mut reader = res.body_mut().as_reader();
    let mut file = std::fs::File::create(out).map_err(|e| Outcome::Failed(e.to_string()))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    let mut head = [0u8; 4];
    loop {
        let n = reader.read(&mut buf).map_err(|e| Outcome::Failed(e.to_string()))?;
        if n == 0 {
            break;
        }
        if done < 4 {
            let take = (4 - done as usize).min(n);
            head[done as usize..done as usize + take].copy_from_slice(&buf[..take]);
        }
        file.write_all(&buf[..n]).map_err(|e| Outcome::Failed(e.to_string()))?;
        done += n as u64;
        if !progress(Progress::Bytes { done, total }) {
            return Err(Outcome::Cancelled);
        }
    }
    file.flush().map_err(|e| Outcome::Failed(e.to_string()))?;
    if total.is_some_and(|t| t != done) {
        return Err(Outcome::Failed(format!("cut off after {done} of {} bytes", total.unwrap_or(0))));
    }
    // mirrors answer "not found" with JSON or HTML now and then, even with 200
    if &head != b"PK\x03\x04" || done < 1024 {
        return Err(Outcome::Missing(NOT_ARCHIVE.into()));
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
    fn spreads_over_mirrors_and_rests_them() {
        let m = Mirrors::default();
        let fresh = [Tried::No; MIRRORS.len()];
        // three downloads at once go to three mirrors, best first
        let a = m.pick(&fresh).unwrap();
        let b = m.pick(&fresh).unwrap();
        let c = m.pick(&fresh).unwrap();
        assert_eq!((a, b, c), (0, 1, 2));
        m.finished(a, None);
        // the next set goes where fewest sets went
        assert_eq!(m.pick(&fresh), Some(3));
        // a rate limit rests the mirror; sets go elsewhere meanwhile
        m.finished(b, Some(&Outcome::Limited(Duration::from_secs(30))));
        let mut seen = Vec::new();
        while let Some(i) = m.pick(&fresh) {
            seen.push(i);
        }
        assert!(!seen.contains(&1), "{seen:?}");
        // all busy: the next one is free about now; with the others ruled out, when mirror 1 rests
        // until
        assert!(m.next_free(&fresh).unwrap() <= Instant::now());
        let mut only_1 = [Tried::Missing; MIRRORS.len()];
        only_1[1] = Tried::No;
        let free = m.next_free(&only_1).unwrap();
        assert!(free > Instant::now() + Duration::from_secs(25));
        assert_eq!(m.next_free(&[Tried::Missing; MIRRORS.len()]), None);
        // a mirror that failed for a set twice isn't tried for it again
        let mut failed = [Tried::Missing; MIRRORS.len()];
        failed[0] = Tried::Failed(TRIES);
        assert_eq!(m.next_free(&failed), None);
    }

    #[test]
    fn refusals_rest_a_mirror_after_a_few() {
        let m = Mirrors::default();
        let only_0 = {
            let mut t = [Tried::Missing; MIRRORS.len()];
            t[0] = Tried::No;
            t
        };
        for _ in 0..REFUSALS_TO_REST - 1 {
            let i = m.pick(&only_0).unwrap();
            m.finished(i, Some(&Outcome::Missing("HTTP 403".into())));
        }
        assert_eq!(m.pick(&only_0), Some(0));
        m.finished(0, Some(&Outcome::Missing("HTTP 403".into())));
        assert_eq!(m.pick(&only_0), None, "three refusals in a row rest the mirror");
    }

    #[test]
    fn user_agent_names_the_app_without_a_url() {
        assert!(USER_AGENT.starts_with("Fumen/"));
        assert!(!USER_AGENT.contains("http") && !USER_AGENT.contains(".com"));
    }

    /// The mirrors and lookups answer with this user agent (needs the internet).
    #[test]
    #[ignore]
    fn mirrors_answer() {
        assert_eq!(set_of_beatmap(75).unwrap(), 1);
        let dir = std::env::temp_dir().join(format!("fumen-mirrors-{}", std::process::id()));
        let agent = agent(Duration::from_secs(120));
        for mirror in &MIRRORS {
            let out = dir.join(format!("{}.part", mirror.name));
            std::fs::create_dir_all(&dir).unwrap();
            let r = fetch(&agent, &(mirror.url)(1), &out, &mut |_| true);
            println!("{}: {r:?}", mirror.name);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
