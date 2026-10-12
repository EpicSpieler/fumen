//! Beatmap hitsounds for the playfield: what every note sounds like, worked out the way lazer
//! does it (MIT, ppy Pty Ltd — `LegacyBeatmapDecoder`, `ConvertHitObjectParser`,
//! `LegacyBeatmapSkin`, `LegacySkin`, `LegacyStoryboardDecoder`):
//!
//!   - a note plays "hitnormal" plus its additions (finish, whistle, clap). The normal sound of a
//!     note that has additions but no Normal flag is "layered", and layered sounds never play in
//!     osu!mania;
//!   - banks (normal / soft / drum), the custom sample index and the volume come from the note's
//!     hit sample, else from the timing point 5 ms after the note (lazer's leniency). Additions
//!     without a bank take the note's normal bank;
//!   - index 1 and up look in the beatmap's own files first (`soft-hitclap2`, `soft-hitclap`,
//!     `hitclap`, as .wav / .mp3 / .ogg), index 0 and anything missing come from the skin;
//!   - a hit sample's file name replaces the normal sound (the additions stay); a file the set
//!     doesn't have stays silent, as in lazer;
//!   - a long note plays its sounds at its head; the tail is silent;
//!   - storyboard samples (the .osu's and the set's .osb) play too, except on the Fail layer
//!     (autoplay never fails).
//!
//! The skin part is resolved in the webview, which knows the skin: a sample here is either a
//! beatmap file (by hash) or a skin sample name ("soft-hitclap").

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::paths;

/// lazer's `SampleStore` looks a name up as itself, then with these extensions.
const EXTENSIONS: [&str; 3] = ["wav", "mp3", "ogg"];

/// lazer reads a note's sample settings this long after it (`control_point_leniency`).
const CONTROL_POINT_LENIENCY: f64 = 5.0;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sample {
    /// a file of the beatmap set, by hash
    File(String),
    /// a skin's sample, "<bank>-<name>" (the skin falls back to the bare name)
    Skin(String),
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sounds {
    pub samples: Vec<Sample>,
    /// `[time, sample index, volume 0–100]` per sound, by time
    pub events: Vec<i32>,
}

/// A set's files by lowercased name (forward slashes), for lookups that ignore case like lazer's.
pub struct SetFiles(HashMap<String, String>);

impl SetFiles {
    pub fn new(pairs: impl IntoIterator<Item = (String, String)>) -> Self {
        SetFiles(pairs.into_iter().map(|(name, hash)| (normalise(&name), hash)).collect())
    }

    /// The storyboard file (lazer takes the first `.osb` of the set).
    pub fn storyboard(&self) -> Option<&str> {
        let mut names: Vec<&String> = self.0.keys().filter(|n| n.ends_with(".osb")).collect();
        names.sort();
        names.first().map(|n| self.0[*n].as_str())
    }

    /// `SampleStore`: the name, then the name with each extension.
    fn sound(&self, name: &str) -> Option<&str> {
        let name = normalise(name);
        if name.is_empty() {
            return None;
        }
        if let Some(h) = self.0.get(&name) {
            return Some(h);
        }
        EXTENSIONS.iter().find_map(|ext| self.0.get(&format!("{name}.{ext}"))).map(String::as_str)
    }

    /// A sample file named in the chart (`FileHitSampleInfo`, storyboard samples): the name, then
    /// the name without its extension.
    fn named(&self, name: &str) -> Option<&str> {
        self.sound(name).or_else(|| {
            let n = normalise(name);
            let slash = n.rfind('/').map_or(0, |i| i + 1);
            let dot = n[slash..].rfind('.').map(|i| slash + i)?;
            self.sound(&n[..dot])
        })
    }
}

fn normalise(name: &str) -> String {
    name.trim().trim_matches('"').replace('\\', "/").trim_start_matches("./").to_lowercase()
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Bank {
    Normal,
    Soft,
    Drum,
}

impl Bank {
    fn name(self) -> &'static str {
        match self {
            Bank::Normal => "normal",
            Bank::Soft => "soft",
            Bank::Drum => "drum",
        }
    }

    /// `LegacySampleBank`: 0 is "none" (inherit), unknown values count as normal.
    fn from_legacy(v: i64) -> Option<Bank> {
        match v {
            0 => None,
            2 => Some(Bank::Soft),
            3 => Some(Bank::Drum),
            _ => Some(Bank::Normal),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct SamplePoint {
    time: f64,
    bank: Bank,
    index: i64,
    volume: i64,
}

impl Default for SamplePoint {
    fn default() -> Self {
        SamplePoint { time: f64::NEG_INFINITY, bank: Bank::Normal, index: 0, volume: 100 }
    }
}

#[derive(PartialEq)]
enum Section {
    Other,
    General,
    Events,
    TimingPoints,
    HitObjects,
}

/// Collects distinct samples and the events that play them.
struct Out {
    index: HashMap<Sample, i32>,
    sounds: Sounds,
}

impl Out {
    fn push(&mut self, time: i32, sample: Sample, volume: i64) {
        let next = self.sounds.samples.len() as i32;
        let i = *self.index.entry(sample.clone()).or_insert_with(|| {
            self.sounds.samples.push(sample);
            next
        });
        self.sounds.events.extend([time, i, volume.clamp(0, 100) as i32]);
    }
}

/// A library difficulty's hitsounds: its .osu and its set's sound files and storyboard, read
/// from lazer's store or stable's Songs folder.
pub fn for_map(conn: &Connection, files: &paths::Files, id: &str) -> Result<Sounds> {
    let row: Option<(Option<String>, String)> = conn
        .query_row("SELECT m.hash, s.sounds FROM maps m JOIN sets s ON s.id = m.set_id WHERE m.id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    let (hash, sounds) = row.ok_or_else(|| Error::known("chart-missing", "This difficulty isn't in the library anymore."))?;
    let hash = hash.ok_or_else(|| Error::known("chart-missing", "This difficulty has no chart file."))?;
    let read = |hash: &str| -> Option<String> {
        // old files can be in a legacy code page; what's read here is ASCII in practice
        let bytes = files.read(hash)?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    };
    let osu = read(&hash).ok_or_else(|| Error::known("chart-missing", "This difficulty's .osu file is missing."))?;
    let files = SetFiles::new(serde_json::from_str::<Vec<(String, String)>>(&sounds).unwrap_or_default());
    let osb = files.storyboard().and_then(read);
    Ok(resolve(&osu, osb.as_deref(), &files))
}

/// The hitsounds of an osu!mania chart (`osu`), with its set's files and storyboard (`osb`).
/// Other modes get none: the playfield is osu!mania only.
pub fn resolve(osu: &str, osb: Option<&str>, files: &SetFiles) -> Sounds {
    let mut mode = 0i64;
    let mut default_bank = Bank::Normal;
    let mut default_volume = 100i64;
    let mut points: Vec<SamplePoint> = Vec::new();
    let mut objects: Vec<&str> = Vec::new();
    let mut storyboard: Vec<&str> = Vec::new();

    let mut section = Section::Other;
    for line in osu.trim_start_matches('\u{feff}').lines() {
        let line = line.trim_end();
        if line.trim().is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(name) = line.trim().strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = match name {
                "General" => Section::General,
                "Events" => Section::Events,
                "TimingPoints" => Section::TimingPoints,
                "HitObjects" => Section::HitObjects,
                _ => Section::Other,
            };
            continue;
        }
        match section {
            Section::General => {
                let Some((key, value)) = line.split_once(':') else { continue };
                let value = value.trim();
                match key.trim() {
                    "Mode" => mode = value.parse().unwrap_or(0),
                    // LegacySampleBank by name; "None" means normal here too
                    "SampleSet" => {
                        default_bank = match value.to_ascii_lowercase().as_str() {
                            "soft" => Bank::Soft,
                            "drum" => Bank::Drum,
                            _ => Bank::Normal,
                        }
                    }
                    "SampleVolume" => default_volume = value.parse().unwrap_or(default_volume),
                    _ => {}
                }
            }
            Section::Events => storyboard.push(line),
            Section::TimingPoints => {
                let f: Vec<&str> = line.split(',').map(str::trim).collect();
                let Some(time) = f.first().and_then(|v| v.parse::<f64>().ok()).filter(|t| t.is_finite()) else { continue };
                if f.len() < 2 {
                    continue;
                }
                // a point's sample set "none" plays the normal bank (not the [General] one)
                let bank = match f.get(3) {
                    Some(v) => Bank::from_legacy(int(v)).unwrap_or(Bank::Normal),
                    None => default_bank,
                };
                points.push(SamplePoint {
                    time,
                    bank,
                    index: f.get(4).map_or(0, |v| int(v)),
                    volume: f.get(5).map_or(default_volume, |v| int(v)),
                });
            }
            Section::HitObjects => objects.push(line.trim()),
            Section::Other => {}
        }
    }
    if mode != 3 {
        return Sounds::default();
    }
    // later lines win at the same time (a green line over a red one)
    points.sort_by(|a, b| a.time.total_cmp(&b.time));

    let mut out = Out { index: HashMap::new(), sounds: Sounds::default() };
    let mut events: Vec<(i32, Sample, i64)> = Vec::new();
    for line in objects {
        note(line, &points, files, &mut events);
    }
    for line in storyboard.iter().copied().chain(osb.map(str::lines).into_iter().flatten()) {
        if let Some(e) = storyboard_sample(line, files) {
            events.push(e);
        }
    }
    // stable: by time, notes before storyboard samples at the same time
    events.sort_by_key(|e| e.0);
    for (time, sample, volume) in events {
        out.push(time, sample, volume);
    }
    out.sounds
}

fn int(v: &str) -> i64 {
    // osu! writes these as integers, but some editors left decimals behind
    v.trim().parse::<i64>().ok().or_else(|| v.trim().parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f as i64)).unwrap_or(0)
}

/// The sample point in effect at `t`: the last one at or before it, else the first one.
fn point_at(points: &[SamplePoint], t: f64) -> SamplePoint {
    let i = points.partition_point(|p| p.time <= t);
    if i > 0 {
        points[i - 1]
    } else {
        points.first().copied().unwrap_or_default()
    }
}

/// One hit object line: `x,y,time,type,hitSound,<extras>` where extras are
/// `normalSet:additionSet:index:volume:filename` (notes) or `endTime:` + those (long notes).
fn note(line: &str, points: &[SamplePoint], files: &SetFiles, out: &mut Vec<(i32, Sample, i64)>) {
    let f: Vec<&str> = line.split(',').collect();
    let (Some(time), Some(ty)) = (f.get(2).and_then(|v| v.trim().parse::<f64>().ok()), f.get(3)) else { return };
    if !time.is_finite() {
        return;
    }
    let ty = int(ty);
    let sound = f.get(4).map_or(0, |v| int(v));
    let extras: Vec<&str> = match f.get(5) {
        Some(v) if ty & 128 != 0 => v.split(':').skip(1).collect(),
        Some(v) => v.split(':').collect(),
        None => Vec::new(),
    };
    let normal_set = extras.first().and_then(|v| Bank::from_legacy(int(v)));
    let addition_set = extras.get(1).and_then(|v| Bank::from_legacy(int(v))).or(normal_set);
    let own_index = extras.get(2).map_or(0, |v| int(v));
    let own_volume = extras.get(3).map_or(0, |v| int(v).max(0));
    let filename = extras.get(4).map(|v| v.trim()).filter(|v| !v.is_empty());

    let p = point_at(points, time + CONTROL_POINT_LENIENCY);
    let normal_bank = normal_set.unwrap_or(p.bank);
    let addition_bank = addition_set.unwrap_or(p.bank);
    let index = if own_index > 0 { own_index } else { p.index };
    let volume = if own_volume > 0 { own_volume } else { p.volume };
    let t = time as i32;

    match filename {
        Some(name) => {
            if let Some(hash) = files.named(name) {
                out.push((t, Sample::File(hash.to_string()), volume));
            }
        }
        // the normal sound of a note with additions but no Normal flag is layered: not in mania
        None if sound == 0 || sound & 1 != 0 => out.push((t, hit_sample(normal_bank, "hitnormal", index, files), volume)),
        None => {}
    }
    for (bit, name) in [(4, "hitfinish"), (2, "hitwhistle"), (8, "hitclap")] {
        if sound & bit != 0 {
            out.push((t, hit_sample(addition_bank, name, index, files), volume));
        }
    }
}

/// A bank sample: from the beatmap's files when the index asks for custom samples and the set
/// has one, else the skin's.
fn hit_sample(bank: Bank, name: &str, index: i64, files: &SetFiles) -> Sample {
    let plain = format!("{}-{name}", bank.name());
    if index >= 1 {
        let numbered = if index >= 2 { format!("{plain}{index}") } else { plain.clone() };
        for candidate in [numbered.as_str(), plain.as_str(), name] {
            if let Some(hash) = files.sound(candidate) {
                return Sample::File(hash.to_string());
            }
        }
    }
    Sample::Skin(plain)
}

/// `Sample,time,layer,"path",volume` (or `5,…`) from a storyboard's [Events].
fn storyboard_sample(line: &str, files: &SetFiles) -> Option<(i32, Sample, i64)> {
    // commands of sprites are indented; samples aren't
    if line.starts_with([' ', '_']) {
        return None;
    }
    let f: Vec<&str> = line.split(',').map(str::trim).collect();
    if !matches!(f.first().copied(), Some("Sample" | "5")) {
        return None;
    }
    let time: f64 = f.get(1)?.parse().ok().filter(|t: &f64| t.is_finite())?;
    // layers: 0 Background, 1 Fail, 2 Pass, 3 Foreground
    if matches!(f.get(2).copied(), Some("1" | "Fail")) {
        return None;
    }
    let hash = files.named(f.get(3)?)?;
    let volume = f.get(4).map_or(100, |v| int(v));
    Some((time as i32, Sample::File(hash.to_string()), volume))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(names: &[&str]) -> SetFiles {
        SetFiles::new(names.iter().map(|n| (n.to_string(), format!("h:{}", n.to_lowercase()))))
    }

    /// (time, sample, volume) per event, samples written as "file:<name>" / "skin:<name>"
    fn events(s: &Sounds) -> Vec<(i32, String, i32)> {
        s.events
            .chunks(3)
            .map(|e| {
                let name = match &s.samples[e[1] as usize] {
                    Sample::File(h) => format!("file:{}", h.trim_start_matches("h:")),
                    Sample::Skin(n) => format!("skin:{n}"),
                };
                (e[0], name, e[2])
            })
            .collect()
    }

    const HEAD: &str = "osu file format v14\n[General]\nMode: 3\nSampleSet: Soft\n[Difficulty]\nCircleSize:4\n";

    #[test]
    fn banks_additions_and_layering() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,2,0,70,1,0\n995,-100,4,3,0,40,0,0\n[HitObjects]\n\
             64,192,100,1,0,0:0:0:0:\n\
             64,192,200,1,10,0:0:0:0:\n\
             64,192,300,1,11,1:0:0:0:\n\
             64,192,400,1,8,2:3:0:90:\n\
             64,192,990,1,0,0:0:0:0:\n"
        );
        let s = resolve(&text, None, &files(&[]));
        assert_eq!(
            events(&s),
            vec![
                (100, "skin:soft-hitnormal".into(), 70),
                // whistle + clap without the Normal flag: the layered normal doesn't play
                (200, "skin:soft-hitwhistle".into(), 70),
                (200, "skin:soft-hitclap".into(), 70),
                // normal set 1 for both, additions inherit it
                (300, "skin:normal-hitnormal".into(), 70),
                (300, "skin:normal-hitwhistle".into(), 70),
                (300, "skin:normal-hitclap".into(), 70),
                (400, "skin:drum-hitclap".into(), 90),
                // the green line 5 ms later already counts
                (990, "skin:drum-hitnormal".into(), 40),
            ]
        );
        // samples are shared between events
        assert_eq!(s.samples.len(), 8);
    }

    #[test]
    fn custom_indexes_and_files() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,1,2,100,1,0\n[HitObjects]\n\
             64,192,100,1,0,0:0:0:0:\n\
             64,192,200,1,9,0:0:3:0:\n\
             64,192,300,1,9,0:0:1:0:\n\
             64,192,400,1,2,0:0:0:0:Kick.WAV\n\
             64,192,500,1,0,0:0:0:0:missing.wav\n\
             64,192,600,1,0,0:0:0:0:snare.wav\n\
             64,192,700,1,0,0:0:0:0\n"
        );
        let f = files(&["normal-hitnormal2.wav", "normal-hitclap.ogg", "kick.wav", "SB/snare.ogg", "snare.ogg"]);
        let s = resolve(&text, None, &f);
        assert_eq!(
            events(&s),
            vec![
                // the timing point's index 2: the beatmap's normal-hitnormal2
                (100, "file:normal-hitnormal2.wav".into(), 100),
                // index 3: no normal-hitnormal3 nor normal-hitnormal in the set → the skin's;
                // the clap falls back to the set's plain normal-hitclap
                (200, "skin:normal-hitnormal".into(), 100),
                (200, "file:normal-hitclap.ogg".into(), 100),
                (300, "skin:normal-hitnormal".into(), 100),
                (300, "file:normal-hitclap.ogg".into(), 100),
                // a file replaces the normal sound, case-insensitively; additions stay
                (400, "file:kick.wav".into(), 100),
                (400, "skin:normal-hitwhistle".into(), 100),
                // a missing file is silent; "snare.wav" falls back to the name without its
                // extension: snare.ogg
                (600, "file:snare.ogg".into(), 100),
                (700, "file:normal-hitnormal2.wav".into(), 100),
            ]
        );
    }

    #[test]
    fn long_notes_play_at_the_head() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-100,4,2,0,30,0,0\n[HitObjects]\n\
             64,192,100,128,3,1200:0:0:0:0:\n\
             64,192,1300,128,0,1500:3:0:0:55:hold.wav\n"
        );
        let s = resolve(&text, None, &files(&["hold.wav"]));
        assert_eq!(
            events(&s),
            vec![(100, "skin:normal-hitnormal".into(), 100), (100, "skin:normal-hitwhistle".into(), 100), (1300, "file:hold.wav".into(), 55)]
        );
    }

    #[test]
    fn storyboard_samples() {
        let text = format!(
            "{HEAD}[Events]\n//Storyboard Sound Samples\nSample,50,0,\"sb\\bgm.ogg\",60\n5,80,1,\"fail.wav\"\nSample,90,3,\"nope.wav\",100\nSprite,Foreground,Centre,\"x.png\",320,240\n F,0,0,100,0,1\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n64,192,100,1,0,0:0:0:0:\n"
        );
        let osb = "[Events]\nSample,120,2,\"pass.wav\"\n";
        let s = resolve(&text, Some(osb), &files(&["SB/bgm.ogg", "fail.wav", "pass.wav"]));
        assert_eq!(
            events(&s),
            vec![(50, "file:sb/bgm.ogg".into(), 60), (100, "skin:normal-hitnormal".into(), 100), (120, "file:pass.wav".into(), 100)]
        );
    }

    #[test]
    fn defaults_and_other_modes() {
        // no timing points: normal bank, full volume; [General] SampleSet only applies to points
        // that don't say
        let s = resolve(&format!("{HEAD}[TimingPoints]\n0,500\n[HitObjects]\n64,192,100,1,0\n"), None, &files(&[]));
        assert_eq!(events(&s), vec![(100, "skin:soft-hitnormal".into(), 100)]);
        let s = resolve(&format!("{HEAD}[HitObjects]\n64,192,100,1,0\n"), None, &files(&[]));
        assert_eq!(events(&s), vec![(100, "skin:normal-hitnormal".into(), 100)]);
        let s = resolve("[General]\nMode: 0\n[HitObjects]\n64,192,100,1,0\n", None, &files(&[]));
        assert!(s.events.is_empty());
    }

    /// Every osu!mania chart of a real library: no panics, and how much comes from the sets.
    #[test]
    #[ignore = "needs FUMEN_TEST_STORAGE and FUMEN_TEST_EXPORT (a fumen-realm export)"]
    fn library() {
        let (Some(storage), Some(export)) = (std::env::var_os("FUMEN_TEST_STORAGE"), std::env::var_os("FUMEN_TEST_EXPORT")) else { return };
        let storage = std::path::PathBuf::from(storage);
        let export: serde_json::Value = serde_json::from_slice(&std::fs::read(export).unwrap()).unwrap();
        let read = |hash: &str| crate::paths::lazer_file(&storage, hash).and_then(|p| std::fs::read(p).ok()).map(|b| String::from_utf8_lossy(&b).into_owned());
        let started = std::time::Instant::now();
        let (mut charts, mut events, mut from_set, mut keysounded) = (0usize, 0usize, 0usize, 0usize);
        for set in export["sets"].as_array().unwrap() {
            let sounds: Vec<(String, String)> = serde_json::from_value(set["sounds"].clone()).unwrap_or_default();
            let files = SetFiles::new(sounds);
            let osb = files.storyboard().and_then(read);
            for m in set["maps"].as_array().unwrap() {
                if m["rulesetId"].as_i64() != Some(3) {
                    continue;
                }
                let Some(osu) = m["hash"].as_str().and_then(read) else { continue };
                let s = resolve(&osu, osb.as_deref(), &files);
                charts += 1;
                events += s.events.len() / 3;
                let own = s.events.chunks(3).filter(|e| matches!(s.samples[e[1] as usize], Sample::File(_))).count();
                from_set += own;
                if own > 0 && s.samples.len() > 20 {
                    keysounded += 1;
                }
                assert!(s.events.chunks(3).all(|e| (e[1] as usize) < s.samples.len() && (0..=100).contains(&e[2])));
                assert!(s.events.chunks(3).zip(s.events.chunks(3).skip(1)).all(|(a, b)| a[0] <= b[0]));
            }
        }
        eprintln!(
            "{charts} charts, {events} sounds ({from_set} from the sets), {keysounded} with 20+ samples, in {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn storyboard_file_pick() {
        let f = files(&["b.osb", "A.osb", "x.wav"]);
        assert_eq!(f.storyboard(), Some("h:a.osb"));
        assert_eq!(files(&["x.wav"]).storyboard(), None);
    }
}
