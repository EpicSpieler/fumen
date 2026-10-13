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
//!   - index 1 and up look in the beatmap's own files first (index 1: `soft-hitclap`, then
//!     `hitclap`; index 2 and up only `soft-hitclap2`, then `hitclap`, as .wav / .mp3 / .ogg —
//!     a beatmap's numbered samples never fall back to its unnumbered ones), index 0 and anything
//!     missing come from the skin;
//!   - a hit sample's file name replaces the normal sound (the additions stay); a file the set
//!     doesn't have stays silent, as in lazer;
//!   - a long note plays its sounds at its head (with the sample settings of its tail); the tail
//!     is silent;
//!   - osu!taiko notes play nothing themselves: the drum does, for every key autoplay presses
//!     (`DrumSamplePlayer`): "hitnormal" for the centre, "hitclap" for the rim, plus "hitfinish" /
//!     "hitwhistle" when two keys come within 30 ms (a strong hit), with the bank, index and
//!     volume of the note hit; samples are looked up as "taiko-<bank>-<name>" in the beatmap and in
//!     legacy skins, and argon has its own drums;
//!   - osu! plays every note's sounds (layered ones too) at its time: circles, a slider's head,
//!     repeats and tail with their own sounds and sample points, its ticks ("slidertick" in the
//!     slider's normal bank), "sliderslide" (and "sliderwhistle" with a whistle) looping while
//!     it's followed; spinners "spinnerspin" looping, higher the further it's spun, a
//!     "spinnerbonus" for every bonus spin (then "spinnerbonus-max") and their sounds at the end;
//!   - osu!catch plays what's caught: a fruit its own sounds (a juice stream's head, repeats
//!     and tail their node sounds), a droplet its stream's sounds as "slidertick" (every one, in
//!     its bank), a banana "metronomelow" or else "catch-banana", higher for every banana of the
//!     shower; tiny droplets, the streams and
//!     the showers themselves nothing;
//!   - storyboard samples (the .osu's and the set's .osb) play too, except on the Fail layer
//!     (autoplay never fails).
//!
//! The skin part is resolved in the webview, which knows the skin: a sample here is either a
//! beatmap file (by hash) or a skin sample name ("soft-hitclap", or for osu!taiko
//! "taiko:<role>:<bank>-<name>:<argon bank>", see `taiko_sample`; a banana "catch:banana:<its number in the shower>").

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::catch;
use crate::error::{Error, Result};
use crate::osu;
use crate::paths;
use crate::taiko;

/// lazer's `SampleStore` looks a name up as itself, then with these extensions.
const EXTENSIONS: [&str; 3] = ["wav", "mp3", "ogg"];

/// lazer reads a note's sample settings this long after it (`control_point_leniency`).
const CONTROL_POINT_LENIENCY: f64 = 5.0;
/// `DrawableHitObject.MINIMUM_SAMPLE_VOLUME`: hit sounds never go quieter.
const MINIMUM_SAMPLE_VOLUME: i64 = 5;

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
    /// `[start, end, sample index, volume, rate at the start, rate at the ramp's end, ramp end]`
    /// per looping sound (osu!'s slider slides and spinner spins), by start
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub loops: Vec<f64>,
}

/// A looping sound: plays from `start` to `end`, its rate going from `rate.0` to `rate.1` by
/// `rate.2` (and staying there).
struct Loop {
    start: f64,
    end: f64,
    sample: Sample,
    volume: i64,
    rate: (f64, f64, f64),
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
    fn sample(&mut self, sample: Sample) -> i32 {
        let next = self.sounds.samples.len() as i32;
        *self.index.entry(sample.clone()).or_insert_with(|| {
            self.sounds.samples.push(sample);
            next
        })
    }

    fn push(&mut self, time: i32, sample: Sample, volume: i64) {
        let i = self.sample(sample);
        self.sounds.events.extend([time, i, volume.clamp(0, 100) as i32]);
    }

    fn push_loop(&mut self, l: Loop) {
        let i = self.sample(l.sample) as f64;
        self.sounds.loops.extend([l.start, l.end, i, l.volume.clamp(0, 100) as f64, l.rate.0, l.rate.1, l.rate.2]);
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

/// The hitsounds of a chart of any ruleset (`osu`), with its set's files and storyboard (`osb`).
pub fn resolve(osu: &str, osb: Option<&str>, files: &SetFiles) -> Sounds {
    let version = osu
        .trim_start_matches('\u{feff}')
        .lines()
        .next()
        .and_then(|l| l.trim().strip_prefix("osu file format v"))
        .and_then(|v| v.trim().parse::<i32>().ok())
        .unwrap_or(14);
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
    // later lines win at the same time (a green line over a red one)
    points.sort_by(|a, b| a.time.total_cmp(&b.time));
    // osu! v4 and older: everything 24 ms later (as osu.rs times it)
    if mode == 0 && version < 5 {
        points.iter_mut().for_each(|p| p.time += 24.0);
    }

    let mut out = Out { index: HashMap::new(), sounds: Sounds::default() };
    let mut events: Vec<(i32, Sample, i64)> = Vec::new();
    let mut loops: Vec<Loop> = Vec::new();
    if mode == 1 {
        if let Some(chart) = taiko::parse(osu) {
            drum(&chart, &points, files, &mut events);
        }
    } else if mode == 0 {
        if let Some(chart) = osu::parse(osu) {
            standard(&chart, &points, files, &mut events, &mut loops);
        }
    } else if mode == 2 {
        if let Some(chart) = catch::parse(osu) {
            fruits(&chart, &points, files, &mut events);
        }
    } else {
        for line in objects {
            note(line, &points, files, &mut events);
        }
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
    loops.sort_by(|a, b| a.start.total_cmp(&b.start));
    for l in loops {
        out.push_loop(l);
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
    // a long note takes the sample settings of its end (`GetEndTime()`)
    let end = match f.get(5) {
        Some(v) if ty & 128 != 0 => v.split(':').next().and_then(|e| e.trim().parse::<f64>().ok()).filter(|e| e.is_finite()).unwrap_or(time),
        _ => time,
    };
    let hit = HitSounds {
        time,
        sound,
        normal_set: extras.first().map_or(0, |v| int(v)),
        addition_set: extras.get(1).map_or(0, |v| int(v)),
        index: extras.get(2).map_or(0, |v| int(v)),
        volume: extras.get(3).map_or(0, |v| int(v).max(0)),
        file: extras.get(4).map(|v| v.trim()).filter(|v| !v.is_empty()),
        point_time: end.max(time) + CONTROL_POINT_LENIENCY,
    };
    // the normal sound of a note with additions but no Normal flag is layered: not in mania
    hit.play(points, files, false, out);
}

/// A note's sounds, as the hit object line has them.
struct HitSounds<'a> {
    time: f64,
    /// 1 normal, 2 whistle, 4 finish, 8 clap
    sound: i64,
    normal_set: i64,
    addition_set: i64,
    index: i64,
    volume: i64,
    file: Option<&'a str>,
    /// the sample point that counts
    point_time: f64,
}

impl HitSounds<'_> {
    fn of(s: &osu::Sounds) -> HitSounds<'_> {
        HitSounds {
            time: s.time,
            sound: s.sound,
            normal_set: s.normal_set,
            addition_set: s.addition_set,
            index: s.index,
            volume: s.volume,
            file: s.file.as_deref(),
            point_time: s.point_time,
        }
    }

    /// The banks, index and volume, from the note or else its sample point.
    fn resolve(&self, points: &[SamplePoint]) -> (Bank, Bank, i64, i64) {
        let normal_set = Bank::from_legacy(self.normal_set);
        let addition_set = Bank::from_legacy(self.addition_set).or(normal_set);
        let p = point_at(points, self.point_time);
        let index = if self.index > 0 { self.index } else { p.index };
        let volume = (if self.volume > 0 { self.volume } else { p.volume }).max(MINIMUM_SAMPLE_VOLUME);
        (normal_set.unwrap_or(p.bank), addition_set.unwrap_or(p.bank), index, volume)
    }

    /// "hitnormal" (or the note's sample file) and the additions; `layered`: whether the normal
    /// sound of a note with additions but no Normal flag plays.
    fn play(&self, points: &[SamplePoint], files: &SetFiles, layered: bool, out: &mut Vec<(i32, Sample, i64)>) {
        let (normal_bank, addition_bank, index, volume) = self.resolve(points);
        let t = self.time as i32;
        match self.file {
            Some(name) => {
                if let Some(hash) = files.named(name) {
                    out.push((t, Sample::File(hash.to_string()), volume));
                }
            }
            None if layered || self.sound == 0 || self.sound & 1 != 0 => out.push((t, hit_sample(normal_bank, "hitnormal", index, files), volume)),
            None => {}
        }
        for (bit, name) in [(4, "hitfinish"), (2, "hitwhistle"), (8, "hitclap")] {
            if self.sound & bit != 0 {
                out.push((t, hit_sample(addition_bank, name, index, files), volume));
            }
        }
    }
}

// ── osu! ──────────────────────────────────────────────────────────────────

/// `OsuAutoGenerator` spins at 0.05 rad/ms: a whole spin every 2π / 0.05 ms.
const SPIN_MS: f64 = 2.0 * std::f64::consts::PI / 0.05;
/// `DrawableSpinner`'s spinning sound: its rate from 20000 / 44100, rising 40000 / 44100 per share
/// of the spins needed, up to 100000 / 44100
const SPIN_RATE_BASE: f64 = 20_000.0 / 44_100.0;
const SPIN_RATE_RATIO: f64 = 40_000.0 / 44_100.0;
const SPIN_RATE_MAX: f64 = 100_000.0 / 44_100.0;
/// `Spinner`: spins after the required ones before bonus spins count
const BONUS_SPINS_GAP: u32 = 2;

/// What osu! plays under autoplay (`DrawableHitCircle`, `DrawableSlider` and its nested objects,
/// `DrawableSpinner`).
fn standard(chart: &osu::Chart, points: &[SamplePoint], files: &SetFiles, out: &mut Vec<(i32, Sample, i64)>, loops: &mut Vec<Loop>) {
    for o in &chart.objects {
        if o.kind != osu::Kind::Spinner {
            for s in &o.sounds {
                HitSounds::of(s).play(points, files, true, out);
            }
        }
        if let Some(slider) = &o.slider {
            let (normal_bank, addition_bank, index, volume) = HitSounds::of(&slider.main).resolve(points);
            // ticks: the slider's normal sound as "slidertick"
            for &(t, _) in &slider.ticks {
                out.push((t as i32, hit_sample(normal_bank, "slidertick", index, files), volume));
            }
            if o.end > o.time {
                let slide = |bank, name| Loop { start: o.time, end: o.end, sample: hit_sample(bank, name, index, files), volume, rate: (1.0, 1.0, o.time) };
                loops.push(slide(normal_bank, "sliderslide"));
                if slider.main.sound & 2 != 0 {
                    loops.push(slide(addition_bank, "sliderwhistle"));
                }
            }
        }
        if o.kind == osu::Kind::Spinner {
            let Some(end) = o.sounds.first() else { continue };
            HitSounds::of(end).play(points, files, true, out);
            // autoplay skips spinners that need no spins (they finish themselves)
            if o.spins == 0 || o.end <= o.time {
                continue;
            }
            let (normal_bank, addition_bank, index, volume) = HitSounds::of(end).resolve(points);
            // spinning: the rate by the share of the needed spins done, from the start
            let full = o.time + (SPIN_RATE_MAX - SPIN_RATE_BASE) / SPIN_RATE_RATIO * o.spins as f64 * SPIN_MS;
            let ramp_end = full.min(o.end);
            let rate_end = SPIN_RATE_BASE + (ramp_end - o.time) / SPIN_MS / o.spins as f64 * SPIN_RATE_RATIO;
            loops.push(Loop {
                start: o.time,
                end: o.end,
                sample: hit_sample(normal_bank, "spinnerspin", index, files),
                volume,
                rate: (SPIN_RATE_BASE, rate_end.min(SPIN_RATE_MAX), ramp_end),
            });
            // a bonus sound for every whole spin past the needed ones (and the gap), then the
            // "max" one; in the additions' bank if the spinner has additions
            let bank = if end.sound & (2 | 4 | 8) != 0 { addition_bank } else { normal_bank };
            let first_bonus = o.spins + BONUS_SPINS_GAP;
            let mut spin = first_bonus + 1;
            loop {
                let t = o.time + spin as f64 * SPIN_MS;
                if t > o.end {
                    break;
                }
                let sample = if spin - first_bonus <= o.bonus_spins { hit_sample(bank, "spinnerbonus", index, files) } else { spinner_max(bank, index, files) };
                out.push((t as i32, sample, volume));
                spin += 1;
            }
        }
    }
}

// ── osu!catch ─────────────────────────────────────────────────────────────

/// What the catcher catches under autoplay plays (`DrawableCatchHitObject`: only fruits,
/// droplets and bananas are ever hit).
fn fruits(chart: &catch::Chart, points: &[SamplePoint], files: &SetFiles, out: &mut Vec<(i32, Sample, i64)>) {
    for o in &chart.objects {
        let Some(s) = &o.sounds else { continue };
        let hit = HitSounds::of(s);
        match o.kind {
            catch::Kind::Fruit => hit.play(points, files, true, out),
            // every sound of the stream renamed (`With(@"slidertick")`): the normal one in its
            // bank, each addition in the additions' bank
            catch::Kind::Droplet => {
                let (normal_bank, addition_bank, index, volume) = hit.resolve(points);
                let t = o.time as i32;
                out.push((t, hit_sample(normal_bank, "slidertick", index, files), volume));
                for bit in [4, 2, 8] {
                    if s.sound & bit != 0 {
                        out.push((t, hit_sample(addition_bank, "slidertick", index, files), volume));
                    }
                }
            }
            // `BananaHitSampleInfo`: the skin's, at the shower's volume; its pitch goes with its
            // number (`DrawableBanana.PlaySamples`)
            catch::Kind::Banana => {
                let (_, _, _, volume) = hit.resolve(points);
                out.push((o.time as i32, Sample::Skin(format!("catch:banana:{}", o.banana)), volume));
            }
            catch::Kind::TinyDroplet => {}
        }
    }
}

/// "spinnerbonus-max", looked up as itself and then as "spinnerbonus" (`SpinnerBonusMaxSampleInfo`).
fn spinner_max(bank: Bank, index: i64, files: &SetFiles) -> Sample {
    match beatmap_sample("", bank, "spinnerbonus-max", index, files).or_else(|| beatmap_sample("", bank, "spinnerbonus", index, files)) {
        Some(hash) => Sample::File(hash.to_string()),
        None => Sample::Skin(format!("{}-spinnerbonus-max", bank.name())),
    }
}

/// A bank sample: from the beatmap's files when the index asks for custom samples and the set
/// has one, else the skin's.
fn hit_sample(bank: Bank, name: &str, index: i64, files: &SetFiles) -> Sample {
    match beatmap_sample("", bank, name, index, files) {
        Some(hash) => Sample::File(hash.to_string()),
        None => Sample::Skin(format!("{}-{name}", bank.name())),
    }
}

/// `LegacyBeatmapSkin` (custom sample banks on): with a numbered index only the numbered sample,
/// with index 1 the bank's and the bare one's, then the bare name ("universal" samples). osu!taiko
/// puts "taiko-" in front of every name but the last.
fn beatmap_sample<'a>(prefix: &str, bank: Bank, name: &str, index: i64, files: &'a SetFiles) -> Option<&'a str> {
    if index < 1 {
        return None;
    }
    let bank = bank.name();
    let names = if index >= 2 {
        vec![format!("{prefix}{bank}-{name}{index}"), name.to_string()]
    } else {
        vec![format!("{prefix}{bank}-{name}"), format!("{prefix}{name}"), name.to_string()]
    };
    names.iter().find_map(|n| files.sound(n))
}

// ── osu!taiko ─────────────────────────────────────────────────────────────

/// What the drum plays under autoplay. Two keys of the same colour within 30 ms make a strong
/// hit, which stops what that colour was playing and plays the hit's sound and its strong one.
fn drum(chart: &taiko::Chart, points: &[SamplePoint], files: &SetFiles, out: &mut Vec<(i32, Sample, i64)>) {
    use taiko::{LEFT_CENTRE, LEFT_RIM, RIGHT_CENTRE, RIGHT_RIM};
    let flourish = flourishes(chart);
    let opposite = |k: u8| match k {
        LEFT_CENTRE => RIGHT_CENTRE,
        RIGHT_CENTRE => LEFT_CENTRE,
        LEFT_RIM => RIGHT_RIM,
        _ => LEFT_RIM,
    };
    let mut last: Option<(u8, f64)> = None;
    // where the previous key's sounds start in `out`, and whether it was the rim
    let mut previous: Option<(usize, bool)> = None;
    for p in &chart.presses {
        for key in [LEFT_CENTRE, RIGHT_CENTRE, LEFT_RIM, RIGHT_RIM] {
            if p.keys & key == 0 {
                continue;
            }
            let rim = key & (LEFT_RIM | RIGHT_RIM) != 0;
            let strong = last.is_some_and(|(k, t)| k == opposite(key) && (0.0..=taiko::SECOND_HIT_WINDOW).contains(&(p.time - t)));
            if strong {
                // the drum stops the sounds of that colour (in practice the first key's)
                if let Some((from, _)) = previous.filter(|&(_, r)| r == rim) {
                    out.truncate(from);
                }
            }
            let start = out.len();
            let o = &chart.objects[p.object];
            let t = p.time as i32;
            let (base, volume) = taiko_sample(o, if rim { "hitclap" } else { "hitnormal" }, 'b', strong, points, files);
            let from_beatmap = matches!(base, Sample::File(_));
            out.push((t, base, volume));
            if strong {
                let role = if from_beatmap { 'S' } else { 's' };
                let (extra, volume) = taiko_sample(o, if rim { "hitwhistle" } else { "hitfinish" }, role, strong, points, files);
                out.push((t, extra, volume));
                if rim && !from_beatmap && flourish.contains(&p.object) {
                    let (f, volume) = taiko_sample(o, "hitflourish", 'f', strong, points, files);
                    out.push((t, f, volume));
                }
            }
            previous = Some((start, rim));
            last = Some((key, p.time));
        }
    }
}

/// One drum sound of a note (`HitObject.CreateHitSampleInfo`): "hitnormal" in the note's normal
/// bank, anything else in its additions' bank when it has additions. A note with a sample file
/// plays the drum anyway (the taiko lookup drops the file name), in the normal bank with the
/// beatmap's samples allowed. Skin samples are `taiko:<role>:<bank>-<name>:<argon bank>`, roles:
/// `b` the hit's sound, `s` a strong hit's second sound, `S` the same after a sound from the
/// beatmap (argon then plays it like any skin), `f` argon's flourish.
fn taiko_sample(o: &taiko::Object, name: &str, role: char, strong: bool, points: &[SamplePoint], files: &SetFiles) -> (Sample, i64) {
    let s = &o.samples;
    let p = point_at(points, s.point_time);
    let normal_set = Bank::from_legacy(s.normal_set);
    let normal_bank = normal_set.unwrap_or(p.bank);
    let addition_bank = Bank::from_legacy(s.addition_set).or(normal_set).unwrap_or(p.bank);
    let index = if s.index > 0 { s.index } else { p.index };
    let volume = if s.volume > 0 { s.volume } else { p.volume };
    let has_addition = s.sound & (2 | 4 | 8) != 0;
    let (bank, index) = if name != "hitnormal" && has_addition {
        (addition_bank, index)
    } else if s.file.is_some() {
        (Bank::Normal, 1)
    } else {
        (normal_bank, index)
    };
    if role != 'f' {
        if let Some(hash) = beatmap_sample("taiko-", bank, name, index, files) {
            return (Sample::File(hash.to_string()), volume.max(MINIMUM_SAMPLE_VOLUME));
        }
    }
    // argon's VolumeAwareHitSampleInfo: strong hits get their own bank, the rest one by volume
    let strong = role == 'f' || (role == 'b' && strong);
    let argon = match volume {
        _ if strong => "strong",
        v if v >= 90 => "drum",
        v if v >= 60 => "normal",
        _ => "soft",
    };
    (Sample::Skin(format!("taiko:{role}:{}-{name}:{argon}", bank.name())), volume.max(MINIMUM_SAMPLE_VOLUME))
}

/// `ArgonFlourishTriggerSource`: strong rim hits at least 2 s apart, picked from the latest one on
/// screen backwards (on screen: within 16:9's scroll time ahead).
fn flourishes(chart: &taiko::Chart) -> std::collections::HashSet<usize> {
    let strong: Vec<usize> = (0..chart.objects.len()).filter(|&i| chart.objects[i].kind == taiko::Kind::Rim && chart.objects[i].strong).collect();
    // TaikoPlayfieldAdjustmentContainer.ComputeTimeRange at 16:9
    let time_range = ((16.0 / 9.0) * 480.0 - 160.0) / 100.0 * 1000.0 / 1.4;
    let mut out = std::collections::HashSet::new();
    for (n, &i) in strong.iter().enumerate() {
        let t = chart.objects[i].time;
        let at = chart.scroll.partition_point(|s| s.0 <= t);
        let multiplier = chart.scroll.get(at.saturating_sub(1)).map_or(1.4, |s| s.1);
        let ahead = t + time_range / multiplier;
        let top = strong.partition_point(|&j| chart.objects[j].time <= ahead);
        let mut last: Option<f64> = None;
        for &j in strong[n..top.max(n + 1)].iter().rev() {
            let h = chart.objects[j].time;
            let can = last.map_or(true, |l| l - h >= 2000.0);
            if can {
                last = Some(h);
            }
            if j == i && can {
                out.insert(i);
            }
        }
    }
    out
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
                // index 3: no normal-hitnormal3 nor hitnormal in the set → the skin's; the set's
                // unnumbered normal-hitclap doesn't count for a numbered index
                (200, "skin:normal-hitnormal".into(), 100),
                (200, "skin:normal-hitclap".into(), 100),
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
        // the first one ends after the green line: its bank and volume
        assert_eq!(
            events(&s),
            vec![(100, "skin:soft-hitnormal".into(), 30), (100, "skin:soft-hitwhistle".into(), 30), (1300, "file:hold.wav".into(), 55)]
        );
    }

    const TAIKO: &str = "osu file format v14\n[General]\nMode: 1\n[Difficulty]\nOverallDifficulty:5\nSliderMultiplier:1.4\n";

    #[test]
    fn taiko_drum() {
        let text = format!(
            "{TAIKO}[TimingPoints]\n0,500,4,2,0,70,1,0\n1900,-100,4,1,0,95,0,0\n[HitObjects]\n\
             256,192,100,1,0,0:0:0:0:\n\
             256,192,200,1,8,0:0:0:0:\n\
             256,192,300,1,4,0:3:0:0:\n\
             256,192,400,1,12,0:0:0:0:\n\
             256,192,2000,1,0,0:0:0:0:\n"
        );
        let s = resolve(&text, None, &files(&[]));
        assert_eq!(
            events(&s),
            vec![
                (100, "skin:taiko:b:soft-hitnormal:normal".into(), 70),
                (200, "skin:taiko:b:soft-hitclap:normal".into(), 70),
                // strong: both keys, the first key's sound stopped by the second; the finish in
                // the additions' bank
                (300, "skin:taiko:b:soft-hitnormal:strong".into(), 70),
                (300, "skin:taiko:s:drum-hitfinish:normal".into(), 70),
                // a strong rim hit, its clap and whistle in the additions' bank; argon's flourish
                (400, "skin:taiko:b:soft-hitclap:strong".into(), 70),
                (400, "skin:taiko:s:soft-hitwhistle:normal".into(), 70),
                (400, "skin:taiko:f:soft-hitflourish:strong".into(), 70),
                // argon's bank follows the volume
                (2000, "skin:taiko:b:normal-hitnormal:drum".into(), 95),
            ]
        );
    }

    #[test]
    fn taiko_beatmap_samples() {
        let text = format!(
            "{TAIKO}[TimingPoints]\n0,500,4,1,1,100,1,0\n[HitObjects]\n\
             256,192,100,1,0,0:0:0:0:\n\
             256,192,200,1,2,0:0:2:0:\n\
             256,192,300,1,0,0:0:0:0:kick.wav\n"
        );
        let f = files(&["taiko-normal-hitnormal.wav", "normal-hitclap2.wav", "hitwhistle.ogg", "kick.wav"]);
        let s = resolve(&text, None, &f);
        assert_eq!(
            events(&s),
            vec![
                // index 1: the beatmap's taiko sample
                (100, "file:taiko-normal-hitnormal.wav".into(), 100),
                // index 2: only taiko-normal-hitclap2 or the bare hitclap, neither is there
                (200, "skin:taiko:b:normal-hitclap:drum".into(), 100),
                // a sample file doesn't play in taiko: the drum's own lookup (index 1) does
                (300, "file:taiko-normal-hitnormal.wav".into(), 100),
            ]
        );
    }

    const OSU: &str = "osu file format v14\n[General]\nMode: 0\n[Difficulty]\nOverallDifficulty:5\nSliderMultiplier:1.4\nSliderTickRate:1\n";

    #[test]
    fn osu_circles_sliders_spinners() {
        let text = format!(
            "{OSU}[TimingPoints]\n0,500,4,2,0,60,1,0\n1990,-100,4,1,0,80,0,0\n[HitObjects]\n\
             100,100,100,1,10,0:0:0:0:\n\
             100,100,1000,2,2,L|380:100,2,280,2|0|8,0:0|0:3|1:0\n\
             256,192,5000,12,4,7000,0:0:0:0:\n"
        );
        let s = resolve(&text, None, &files(&[]));
        let ev = events(&s);
        let before: Vec<_> = ev.iter().filter(|e| e.0 < 5000).cloned().collect();
        assert_eq!(
            before,
            vec![
                // whistle + clap without the Normal flag: the layered normal plays in osu!
                (100, "skin:soft-hitnormal".into(), 60),
                (100, "skin:soft-hitwhistle".into(), 60),
                (100, "skin:soft-hitclap".into(), 60),
                // the head, with its own edge sound
                (1000, "skin:soft-hitnormal".into(), 60),
                (1000, "skin:soft-hitwhistle".into(), 60),
                // ticks in the slider's own bank and volume
                (1500, "skin:soft-slidertick".into(), 60),
                // the repeat after the green line, at its own sample point
                (2000, "skin:normal-hitnormal".into(), 80),
                (2500, "skin:soft-slidertick".into(), 60),
                // the tail: normal set 1, a clap
                (3000, "skin:normal-hitnormal".into(), 80),
                (3000, "skin:normal-hitclap".into(), 80),
            ]
        );
        // the spinner: OD 5 needs 5 spins; bonus spins from the 8th (one every 125.7 ms), 5 of
        // them, then "max"; its own sounds at the end
        let bonus: Vec<_> = ev.iter().filter(|e| e.1.contains("spinnerbonus")).map(|e| (e.0, e.1.as_str())).collect();
        assert_eq!(bonus.len(), 8);
        assert_eq!(bonus[0], (6005, "skin:normal-spinnerbonus"));
        assert_eq!(bonus[5], (6633, "skin:normal-spinnerbonus-max"));
        assert_eq!(&ev[ev.len() - 2..], &[(7000, "skin:normal-hitnormal".into(), 80), (7000, "skin:normal-hitfinish".into(), 80)]);
        // loops: the slide (and the whistle's), the spin rising to its top rate by 10 spins in
        let loops: Vec<(f64, f64, String, f64)> = s
            .loops
            .chunks(7)
            .map(|l| (l[0], l[1], match &s.samples[l[2] as usize] { Sample::Skin(n) => n.clone(), Sample::File(f) => f.clone() }, l[3]))
            .collect();
        assert_eq!(
            loops,
            vec![
                (1000.0, 3000.0, "soft-sliderslide".into(), 60.0),
                (1000.0, 3000.0, "soft-sliderwhistle".into(), 60.0),
                (5000.0, 7000.0, "normal-spinnerspin".into(), 80.0),
            ]
        );
        let spin = &s.loops[14..];
        assert!((spin[4] - 20_000.0 / 44_100.0).abs() < 1e-9 && (spin[5] - 100_000.0 / 44_100.0).abs() < 1e-9);
        assert!((spin[6] - (5000.0 + 10.0 * SPIN_MS)).abs() < 1e-6);
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
    }

    #[test]
    fn catch_fruits_droplets_bananas() {
        let text = "osu file format v14\n[General]\nMode: 2\n[Difficulty]\nSliderMultiplier:1.4\nSliderTickRate:1\n\
                    [TimingPoints]\n0,500,4,2,0,60,1,0\n[HitObjects]\n\
                    100,192,100,1,2,0:0:0:0:\n\
                    100,192,1000,2,2,L|380:192,1,280,8|0,0:0|0:0,0:0:0:0:\n\
                    256,192,3000,12,0,3200,0:0:0:0:\n";
        let ev = events(&resolve(text, None, &files(&[])));
        let at = |t: i32| ev.iter().filter(|e| e.0 == t).map(|e| e.1.as_str()).collect::<Vec<_>>();
        // a fruit: its sounds, the layered normal too
        assert_eq!(at(100), ["skin:soft-hitnormal", "skin:soft-hitwhistle"]);
        // the stream's head with its edge sound, its droplet a whistle stream's two ticks, its tail
        assert_eq!(at(1000), ["skin:soft-hitnormal", "skin:soft-hitclap"]);
        assert_eq!(at(1500), ["skin:soft-slidertick", "skin:soft-slidertick"]);
        assert_eq!(at(2000), ["skin:soft-hitnormal"]);
        // bananas, nothing for tiny droplets or the shower
        assert_eq!(at(3000), ["skin:catch:banana:0"]);
        assert_eq!(at(3200), ["skin:catch:banana:2"]);
        assert_eq!(ev.iter().filter(|e| e.1.starts_with("skin:catch:banana")).count(), 3);
        assert_eq!(ev.len(), 2 + 2 + 2 + 1 + 3);
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
