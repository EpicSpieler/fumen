//! osu!taiko charts for the playfield, built the way lazer builds them (MIT, ppy Pty Ltd):
//!
//!   - `TaikoBeatmapConverter`, `Hit`, `DrumRoll`, `Swell`: a note is a centre hit (don), or a rim
//!     hit (kat) when it has a whistle or a clap, and strong with a finish; sliders become drum
//!     rolls (ticks every 1/4 beat, 1/3 at slider tick rate 3), spinners swells (hits needed from
//!     their length and OD);
//!   - `LegacyBeatmapDecoder`: control points, where a green line at a red line's time wins the
//!     scroll speed and kiai;
//!   - `DrawableScrollingRuleset` + `OverlappingScrollAlgorithm`: everything scrolls at the slider
//!     multiplier × the scroll speed (green lines) × 1000 / the beat length of its own time;
//!   - `BarLineGenerator`: a bar line per measure, every `meter`-th one major;
//!   - `TaikoAutoGenerator`: what autoplay presses and when.
//!
//! Only beatmaps made for osu!taiko are read; lazer's conversions of osu! beatmaps aren't.

/// osu!'s slider speed is lower than taiko's; lazer multiplies by this wherever slider lengths or
/// beat lengths turn into taiko speeds (as a float, like lazer's constant).
const VELOCITY_MULTIPLIER: f64 = 1.4f32 as f64;
/// Swells need more hits than spinners need spins.
const SWELL_HIT_MULTIPLIER: f64 = 1.65f32 as f64;
/// `TaikoAutoGenerator`: autoplay hits swells at most every 50 ms.
const SWELL_HIT_SPEED: f64 = 50.0;
/// `DrawableHit.StrongNestedHit.SECOND_HIT_WINDOW`: two hits this close make a strong one.
pub const SECOND_HIT_WINDOW: f64 = 30.0;

/// Keys, as in lazer's `TaikoAction`.
pub const LEFT_CENTRE: u8 = 1;
pub const RIGHT_CENTRE: u8 = 2;
pub const LEFT_RIM: u8 = 4;
pub const RIGHT_RIM: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Centre,
    Rim,
    Roll,
    Swell,
}

impl Kind {
    pub fn code(self) -> u8 {
        match self {
            Kind::Centre => 0,
            Kind::Rim => 1,
            Kind::Roll => 2,
            Kind::Swell => 3,
        }
    }
}

/// What a hit object line says about its sounds (the banks are resolved in hitsounds.rs).
#[derive(Debug, Clone, Default)]
pub struct RawSamples {
    /// the hitSound field: 1 normal, 2 whistle, 4 finish, 8 clap
    pub sound: i64,
    /// `LegacySampleBank` of the normal sound and the additions (0: inherit)
    pub normal_set: i64,
    pub addition_set: i64,
    pub index: i64,
    pub volume: i64,
    pub file: Option<String>,
    /// lazer reads the sample control point at this time
    pub point_time: f64,
}

#[derive(Debug, Clone)]
pub struct Object {
    pub time: f64,
    pub end: f64,
    pub kind: Kind,
    pub strong: bool,
    /// kiai at its start (`HitObject.Kiai`)
    pub kiai: bool,
    /// drum rolls: their ticks
    pub ticks: Vec<f64>,
    /// swells: hits needed
    pub hits: u32,
    pub samples: RawSamples,
}

/// One frame of autoplay: the keys it presses then, for an object.
#[derive(Debug, Clone, Copy)]
pub struct Press {
    pub time: f64,
    /// `LEFT_CENTRE` | `RIGHT_CENTRE` | `LEFT_RIM` | `RIGHT_RIM`
    pub keys: u8,
    pub object: usize,
}

#[derive(Debug, Clone, Default)]
pub struct Chart {
    pub objects: Vec<Object>,
    /// `(time, multiplier)` scroll speed changes; an object scrolls at the one of its own time
    pub scroll: Vec<(f64, f64)>,
    /// `(time, major)` bar lines
    pub bars: Vec<(f64, bool)>,
    pub presses: Vec<Press>,
}

#[derive(Clone, Copy)]
struct TimingPoint {
    time: f64,
    beat_len: f64,
    meter: u32,
    omit_first_bar: bool,
}

/// lazer's difficulty and effect points of one time: slider velocity, scroll speed, kiai.
#[derive(Clone, Copy)]
struct SpeedPoint {
    time: f64,
    sv: f64,
    scroll: f64,
    kiai: bool,
}

/// One [TimingPoints] line.
struct Line {
    time: f64,
    /// NaN is allowed on green lines (no slider ticks)
    beat_len: f64,
    meter: u32,
    red: bool,
    kiai: bool,
    omit_first_bar: bool,
}

#[derive(PartialEq)]
enum Section {
    Other,
    General,
    Difficulty,
    TimingPoints,
    HitObjects,
}

fn num(v: Option<&str>) -> Option<f64> {
    v?.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

fn int(v: &str) -> i64 {
    v.trim().parse::<i64>().ok().or_else(|| v.trim().parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f as i64)).unwrap_or(0)
}

/// `IBeatmapDifficultyInfo.DifficultyRange`
fn difficulty_range(d: f64, min: f64, mid: f64, max: f64) -> f64 {
    if d > 5.0 {
        mid + (max - mid) * (d - 5.0) / 5.0
    } else if d < 5.0 {
        mid - (mid - min) * (5.0 - d) / 5.0
    } else {
        mid
    }
}

/// The control point in effect at `t`: the last one at or before it.
fn at<T: Copy>(points: &[T], t: f64, time: impl Fn(&T) -> f64) -> Option<T> {
    let i = points.partition_point(|p| time(p) <= t);
    (i > 0).then(|| points[i - 1])
}

/// An osu!taiko beatmap as lazer plays it, or `None` for other modes.
pub fn parse(text: &str) -> Option<Chart> {
    let mut mode = 0i64;
    let mut od = 5.0f64;
    let mut slider_multiplier = 1.4f64;
    let mut tick_rate = 1.0f64;
    let mut lines: Vec<Line> = Vec::new();
    let mut raw: Vec<&str> = Vec::new();

    let mut section = Section::Other;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = match name {
                "General" => Section::General,
                "Difficulty" => Section::Difficulty,
                "TimingPoints" => Section::TimingPoints,
                "HitObjects" => Section::HitObjects,
                _ => Section::Other,
            };
            continue;
        }
        match section {
            Section::General | Section::Difficulty => {
                let Some((key, value)) = line.split_once(':') else { continue };
                let value = value.trim();
                match key.trim() {
                    "Mode" => mode = value.parse().unwrap_or(0),
                    "OverallDifficulty" => od = value.parse().unwrap_or(od),
                    // BeatmapDifficulty clamps both
                    "SliderMultiplier" => slider_multiplier = value.parse::<f64>().unwrap_or(slider_multiplier).clamp(0.4, 3.6),
                    "SliderTickRate" => tick_rate = value.parse::<f64>().unwrap_or(tick_rate).clamp(0.5, 8.0),
                    _ => {}
                }
            }
            Section::TimingPoints => {
                let f: Vec<&str> = line.split(',').map(str::trim).collect();
                let Some(time) = num(f.first().copied()) else { continue };
                let Some(beat_len) = f.get(1).and_then(|v| v.parse::<f64>().ok()) else { continue };
                if beat_len.is_infinite() {
                    continue;
                }
                let effects = f.get(7).map_or(0, |v| int(v));
                lines.push(Line {
                    time,
                    beat_len,
                    meter: match f.get(2) {
                        Some(v) if !v.starts_with('0') => (int(v) as u32).max(1),
                        _ => 4,
                    },
                    red: f.get(6).map_or(true, |v| v.starts_with('1')),
                    kiai: effects & 1 != 0,
                    omit_first_bar: effects & 8 != 0,
                });
            }
            Section::HitObjects => raw.push(line),
            Section::Other => {}
        }
    }
    if mode != 1 {
        return None;
    }

    // control points, a group of lines at one time at a time: the first red line is the timing,
    // and the last green line (else that red line) the speed and kiai
    let mut timing: Vec<TimingPoint> = Vec::new();
    let mut speeds: Vec<SpeedPoint> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let mut j = i;
        while j < lines.len() && lines[j].time == lines[i].time {
            j += 1;
        }
        let group = &lines[i..j];
        let red = group.iter().find(|l| l.red && !l.beat_len.is_nan());
        if let Some(r) = red {
            timing.push(TimingPoint { time: r.time, beat_len: r.beat_len.clamp(6.0, 60000.0), meter: r.meter, omit_first_bar: r.omit_first_bar });
        }
        if let Some(l) = group.iter().rev().find(|l| !l.red).or(red) {
            // a red line's speed is 1; NaN (a green line without ticks) too
            let speed = if l.beat_len < 0.0 { 100.0 / -l.beat_len } else { 1.0 };
            speeds.push(SpeedPoint { time: l.time, sv: speed.clamp(0.1, 10.0), scroll: speed.clamp(0.01, 10.0), kiai: l.kiai });
        }
        i = j;
    }
    // before the first red line, the first one counts
    let timing_at = |t: f64| at(&timing, t, |p| p.time).or(timing.first().copied());
    let speed_at = |t: f64| at(&speeds, t, |p| p.time);

    let mut objects: Vec<Object> = raw.iter().filter_map(|line| object(line, od, slider_multiplier, tick_rate, &timing_at, &speed_at)).collect();
    // lazer orders by start time (stable, like OrderBy)
    objects.sort_by(|a, b| a.time.total_cmp(&b.time));

    let scroll = scroll_points(&timing, &speeds, &objects, slider_multiplier);
    let bars = bar_lines(&timing, &objects);
    let presses = autoplay(&objects);
    Some(Chart { objects, scroll, bars, presses })
}

/// One hit object line: `x,y,time,type,hitSound,…`.
fn object(
    line: &str,
    od: f64,
    slider_multiplier: f64,
    tick_rate: f64,
    timing_at: &impl Fn(f64) -> Option<TimingPoint>,
    speed_at: &impl Fn(f64) -> Option<SpeedPoint>,
) -> Option<Object> {
    let f: Vec<&str> = line.split(',').collect();
    let time = num(f.get(2).copied())?;
    let ty = int(f.get(3)?);
    let sound = f.get(4).map_or(0, |v| int(v));
    let strong = sound & 4 != 0;
    let kiai = speed_at(time + 1.0).is_some_and(|p| p.kiai);
    let beat_len = timing_at(time).map_or(1000.0, |p| p.beat_len);

    let (kind, end, ticks, hits, extras, point_time) = if ty & 2 != 0 {
        // x,y,time,type,hitSound,curve,slides,length,edgeSounds,edgeSets,hitSample
        let spans = (int(f.get(6).copied().unwrap_or("1")) - 1).max(0) as f64 + 1.0;
        let length = num(f.get(7).copied()).unwrap_or(0.0).max(0.0);
        // TaikoBeatmapConverter.shouldConvertSliderToHits: "do not change or refactor" — the
        // float steps are stable's
        let distance = length * VELOCITY_MULTIPLIER * spans;
        let sv = speed_at(time).map_or(1.0, |p| p.sv);
        // LegacyRulesetExtensions.GetPrecisionAdjustedBeatLength
        let sv_beat_len = -100.0 / sv;
        let bpm_multiplier = if sv_beat_len < 0.0 { ((-sv_beat_len) as f32).clamp(10.0, 10000.0) as f64 / 100.0 } else { 1.0 };
        let roll_beat_len = beat_len * bpm_multiplier;
        let scoring_distance = 100.0 * (slider_multiplier * VELOCITY_MULTIPLIER) / tick_rate;
        let velocity = scoring_distance * tick_rate;
        let duration = (distance / velocity * roll_beat_len) as i32 as f64;
        let end = time + duration;
        // DrumRoll: ticks from its start, every 1/4 beat (1/3 at tick rate 3)
        let spacing = beat_len / if tick_rate == 3.0 { 3.0 } else { 4.0 };
        let mut ticks = Vec::new();
        if spacing > 0.0 {
            let mut t = time;
            while t < end + spacing / 2.0 && ticks.len() < 20_000 {
                ticks.push(t);
                t += spacing;
            }
        }
        (Kind::Roll, end, ticks, 0, f.get(10).copied(), time + 6.0)
    } else if ty & 8 != 0 {
        // x,y,time,type,hitSound,endTime,hitSample
        let end = num(f.get(5).copied()).unwrap_or(time).max(time);
        let per_second = difficulty_range(od, 3.0, 5.0, 7.5) * SWELL_HIT_MULTIPLIER;
        let hits = ((end - time) / 1000.0 * per_second).max(1.0) as u32;
        (Kind::Swell, end, Vec::new(), hits, f.get(6).copied(), end + 5.0)
    } else {
        let kind = if sound & (2 | 8) != 0 { Kind::Rim } else { Kind::Centre };
        (kind, time, Vec::new(), 0, f.get(5).copied(), time + 5.0)
    };

    // normalSet:additionSet:index:volume:filename
    let e: Vec<&str> = extras.map(|v| v.split(':').collect()).unwrap_or_default();
    let samples = RawSamples {
        sound,
        normal_set: e.first().map_or(0, |v| int(v)),
        addition_set: e.get(1).map_or(0, |v| int(v)),
        index: e.get(2).map_or(0, |v| int(v)),
        volume: e.get(3).map_or(0, |v| int(v).max(0)),
        file: e.get(4).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()),
        point_time,
    };
    Some(Object { time, end, kind, strong, kiai, ticks, hits, samples })
}

/// `DrawableScrollingRuleset`: one multiplier per control point time (up to the last object).
fn scroll_points(timing: &[TimingPoint], speeds: &[SpeedPoint], objects: &[Object], slider_multiplier: f64) -> Vec<(f64, f64)> {
    let last = objects.iter().map(|o| o.end).fold(f64::NEG_INFINITY, f64::max);
    let last = if objects.is_empty() { f64::MAX } else { last };
    let mut times: Vec<f64> = timing.iter().map(|p| p.time).chain(speeds.iter().map(|p| p.time)).filter(|t| *t <= last).collect();
    times.sort_by(f64::total_cmp);
    times.dedup();
    // before the first point of each kind, lazer's defaults: 1000 ms beats, scroll speed 1
    let mut out: Vec<(f64, f64)> = times
        .into_iter()
        .map(|t| {
            let beat = at(timing, t, |p| p.time).map_or(1000.0, |p| p.beat_len);
            let scroll = at(speeds, t, |p| p.time).map_or(1.0, |p| p.scroll);
            (t, slider_multiplier * scroll * 1000.0 / beat)
        })
        .collect();
    if out.is_empty() {
        out.push((0.0, slider_multiplier));
    }
    out
}

/// `BarLineGenerator`
fn bar_lines(timing: &[TimingPoint], objects: &[Object]) -> Vec<(f64, bool)> {
    let mut out = Vec::new();
    let Some(first) = objects.first() else { return out };
    let last = 1.0 + objects.iter().map(|o| o.end).fold(f64::NEG_INFINITY, f64::max);
    let start_limit = first.time.min(0.0);
    for (i, p) in timing.iter().enumerate() {
        let bar = p.beat_len * p.meter as f64;
        let end = timing.get(i + 1).map_or(last + bar, |n| n.time);
        let mut t = if p.time > start_limit { p.time } else { p.time + ((start_limit - p.time) / bar).ceil() * bar };
        if p.omit_first_bar {
            t += bar;
        }
        let mut n = 0u32;
        // Precision.AlmostBigger(end, t)
        while end > t - 1e-7 && out.len() < 100_000 {
            let r = t.round();
            if (t - r).abs() <= 1e-7 {
                t = r;
            }
            out.push((t, n % p.meter == 0));
            t += bar;
            n += 1;
        }
    }
    out
}

/// `TaikoAutoGenerator`: alternating hands, both for strong hits, every tick of a roll, swells
/// round the drum (centre, rim, centre, rim) as fast as needed.
fn autoplay(objects: &[Object]) -> Vec<Press> {
    let mut out = Vec::new();
    let mut hand = true;
    for (i, o) in objects.iter().enumerate() {
        match o.kind {
            Kind::Swell => {
                const ROUND: [u8; 4] = [LEFT_CENTRE, LEFT_RIM, RIGHT_CENTRE, RIGHT_RIM];
                let rate = SWELL_HIT_SPEED.min((o.end - o.time) / o.hits as f64);
                let mut t = o.time;
                let mut n = 0;
                while t < o.end && rate > 0.0 {
                    out.push(Press { time: t, keys: ROUND[n % 4], object: i });
                    n += 1;
                    if n as u32 == o.hits {
                        break;
                    }
                    t += rate;
                }
            }
            Kind::Roll => {
                for &t in &o.ticks {
                    out.push(Press { time: t, keys: if hand { LEFT_CENTRE } else { RIGHT_CENTRE }, object: i });
                    hand = !hand;
                }
            }
            Kind::Centre | Kind::Rim => {
                let (left, right) = if o.kind == Kind::Centre { (LEFT_CENTRE, RIGHT_CENTRE) } else { (LEFT_RIM, RIGHT_RIM) };
                let keys = if o.strong { left | right } else if hand { left } else { right };
                out.push(Press { time: o.time, keys, object: i });
            }
        }
        hand = !hand;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "osu file format v14\n[General]\nMode: 1\n[Difficulty]\nOverallDifficulty:5\nSliderMultiplier:1.4\nSliderTickRate:1\n";

    #[test]
    fn hits_rolls_and_swells() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n2000,-50,4,1,0,100,0,1\n[HitObjects]\n\
             256,192,1000,1,0,0:0:0:0:\n\
             256,192,1500,1,2,0:0:0:0:\n\
             256,192,1750,1,12,0:0:0:0:\n\
             256,192,2500,2,0,L|300:192,1,140\n\
             256,192,4000,12,0,6000,0:0:0:0:\n"
        );
        let c = parse(&text).unwrap();
        let k: Vec<(f64, Kind, bool)> = c.objects.iter().map(|o| (o.time, o.kind, o.strong)).collect();
        assert_eq!(
            k,
            vec![
                (1000.0, Kind::Centre, false),
                (1500.0, Kind::Rim, false),
                (1750.0, Kind::Rim, true),
                (2500.0, Kind::Roll, false),
                (4000.0, Kind::Swell, false)
            ]
        );
        // 140 px at 1.4 × 100 px per beat and SV 2: half a beat
        let roll = &c.objects[3];
        assert_eq!(roll.end, 2750.0);
        // ticks every 1/4 beat while t < end + half a tick
        assert_eq!(roll.ticks, vec![2500.0, 2625.0, 2750.0]);
        assert!(roll.kiai && !c.objects[0].kiai);
        // OD 5: 5 hits a second × 1.65, 2 s
        assert_eq!(c.objects[4].hits, 16);
    }

    #[test]
    fn scroll_speed_follows_bpm_and_green_lines() {
        let text = format!("{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-50,4,1,0,100,0,0\n1000,250,4,1,0,100,1,0\n[HitObjects]\n256,192,500,1,0\n256,192,2000,1,0\n");
        let c = parse(&text).unwrap();
        // 1.4 × 1000 / 500; at 1000 the green line (×2) wins over the red one's 1
        assert_eq!(c.scroll, vec![(0.0, 2.8), (1000.0, 1.4 * 2.0 * 1000.0 / 250.0)]);
    }

    #[test]
    fn bars_and_autoplay() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n256,192,0,1,0\n256,192,500,1,0\n256,192,1000,1,4\n256,192,1500,1,8\n256,192,2000,12,0,2100\n"
        );
        let c = parse(&text).unwrap();
        let bars: Vec<(f64, bool)> = c.bars.iter().copied().take(5).collect();
        assert_eq!(bars, vec![(0.0, true), (2000.0, false), (4000.0, false)]);
        let p: Vec<(f64, u8)> = c.presses.iter().map(|p| (p.time, p.keys)).collect();
        assert_eq!(
            &p[..4],
            &[(0.0, LEFT_CENTRE), (500.0, RIGHT_CENTRE), (1000.0, LEFT_CENTRE | RIGHT_CENTRE), (1500.0, RIGHT_RIM)]
        );
        // a 100 ms swell at OD 5 needs 1 hit
        assert_eq!(&p[4..], &[(2000.0, LEFT_CENTRE)]);
    }

    /// Every osu!taiko difficulty of the library Fumen has imported: no panics, sane output.
    #[test]
    #[ignore = "reads the installed lazer's files and Fumen's library (read-only)"]
    fn real_library() {
        let Some(lazer) = crate::paths::default_lazer_dir() else { return };
        let storage = crate::paths::resolve_lazer_storage(&lazer);
        let db = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.fumen.app").join("library.db");
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = conn.prepare("SELECT hash FROM maps WHERE ruleset_id = 1 AND hash IS NOT NULL").unwrap();
        let hashes: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        let started = std::time::Instant::now();
        let (mut charts, mut objects, mut rolls, mut swells, mut strong, mut presses) = (0, 0, 0, 0, 0, 0);
        for h in &hashes {
            let Some(text) = crate::paths::lazer_file(&storage, h).and_then(|p| std::fs::read(p).ok()) else { continue };
            let Some(c) = parse(&String::from_utf8_lossy(&text)) else { eprintln!("not taiko: {h} {:?}", String::from_utf8_lossy(&text).lines().find(|l| l.trim_start().starts_with("Mode"))); continue };
            charts += 1;
            objects += c.objects.len();
            rolls += c.objects.iter().filter(|o| o.kind == Kind::Roll).count();
            swells += c.objects.iter().filter(|o| o.kind == Kind::Swell).count();
            strong += c.objects.iter().filter(|o| o.strong).count();
            presses += c.presses.len();
            assert!(c.objects.windows(2).all(|w| w[0].time <= w[1].time));
            assert!(c.objects.iter().all(|o| o.end >= o.time));
            assert!(c.scroll.iter().all(|s| s.1.is_finite() && s.1 > 0.0));
            assert!(c.presses.iter().all(|p| p.object < c.objects.len() && p.keys != 0));
        }
        eprintln!(
            "{charts} charts: {objects} objects ({rolls} rolls, {swells} swells, {strong} strong), {presses} presses, in {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn other_modes_are_none() {
        assert!(parse("[General]\nMode: 3\n[HitObjects]\n64,192,100,1,0\n").is_none());
        assert!(parse("").is_none());
    }
}
