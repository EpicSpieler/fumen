//! `.osu` beatmap files: just enough of the format for chart previews and pattern analysis.
//!
//! lazer stores every difficulty's `.osu` under its SHA-256 (`BeatmapInfo.Hash`), so a map's
//! chart is one file read away. The parser is forgiving: unknown sections, comments and broken
//! lines are skipped instead of failing the whole file.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Circle,
    Slider,
    Spinner,
    /// mania long note
    Hold,
}

#[derive(Debug, Clone, Copy)]
pub struct HitObject {
    /// ms from the start of the audio
    pub time: i32,
    /// end time; equals `time` for circles
    pub end: i32,
    pub x: i32,
    pub kind: Kind,
    /// mania column (0-based); 0 for other modes
    pub lane: u8,
}

#[derive(Debug, Clone, Copy)]
pub struct TimingPoint {
    pub time: f64,
    /// ms per beat for uninherited points; negative inverse slider velocity (×100) otherwise
    pub beat_len: f64,
    pub meter: u32,
    pub uninherited: bool,
    pub kiai: bool,
}

#[derive(Debug, Clone)]
pub struct Chart {
    /// 0 osu, 1 taiko, 2 catch, 3 mania
    pub mode: u8,
    /// mania key count; 0 for other modes
    pub keys: u8,
    /// overall difficulty (osu!'s default 5 when the file has none)
    pub od: f64,
    pub timing: Vec<TimingPoint>,
    /// sorted by time
    pub objects: Vec<HitObject>,
    pub breaks: Vec<(i32, i32)>,
}

#[derive(PartialEq)]
enum Section {
    Other,
    General,
    Difficulty,
    Events,
    TimingPoints,
    HitObjects,
}

pub fn parse(text: &str) -> Chart {
    let mut mode = 0u8;
    let mut circle_size = 4.0f64;
    let mut od = 5.0f64;
    let mut slider_multiplier = 1.4f64;
    let mut timing: Vec<TimingPoint> = Vec::new();
    let mut breaks: Vec<(i32, i32)> = Vec::new();
    // raw hit object lines: parsed after the whole file is read, since slider ends need timing
    let mut raw_objects: Vec<&str> = Vec::new();

    let mut section = Section::Other;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = match &line[1..line.len() - 1] {
                "General" => Section::General,
                "Difficulty" => Section::Difficulty,
                "Events" => Section::Events,
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
                    "CircleSize" => circle_size = value.parse().unwrap_or(circle_size),
                    "OverallDifficulty" => od = value.parse().unwrap_or(od),
                    "SliderMultiplier" => slider_multiplier = value.parse().unwrap_or(slider_multiplier),
                    _ => {}
                }
            }
            Section::Events => {
                let mut f = line.split(',');
                if matches!(f.next().map(str::trim), Some("2" | "Break")) {
                    if let (Some(s), Some(e)) = (num(f.next()), num(f.next())) {
                        if e > s {
                            breaks.push((s as i32, e as i32));
                        }
                    }
                }
            }
            Section::TimingPoints => {
                let f: Vec<&str> = line.split(',').map(str::trim).collect();
                let (Some(time), Some(beat_len)) = (num(f.first().copied()), num(f.get(1).copied())) else { continue };
                if !beat_len.is_finite() {
                    continue;
                }
                timing.push(TimingPoint {
                    time,
                    beat_len,
                    meter: f.get(2).and_then(|v| v.parse().ok()).filter(|m| *m > 0).unwrap_or(4),
                    uninherited: f.get(6).map_or(true, |v| *v != "0"),
                    kiai: f.get(7).and_then(|v| v.parse::<u32>().ok()).is_some_and(|e| e & 1 != 0),
                });
            }
            Section::HitObjects => raw_objects.push(line),
            Section::Other => {}
        }
    }

    timing.sort_by(|a, b| a.time.total_cmp(&b.time));
    let mode = mode.min(3);
    let keys = if mode == 3 { circle_size.round().clamp(1.0, 18.0) as u8 } else { 0 };
    let timeline = Timeline::new(&timing);

    let mut objects: Vec<HitObject> = raw_objects
        .iter()
        .filter_map(|line| parse_object(line, mode, keys, slider_multiplier, &timeline))
        .collect();
    objects.sort_by_key(|o| (o.time, o.lane));
    breaks.sort_unstable();

    Chart { mode, keys, od, timing, objects, breaks }
}

fn num(v: Option<&str>) -> Option<f64> {
    v?.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

fn parse_object(line: &str, mode: u8, keys: u8, slider_multiplier: f64, timeline: &Timeline) -> Option<HitObject> {
    let f: Vec<&str> = line.split(',').collect();
    let x = num(f.first().copied())? as i32;
    let time = num(f.get(2).copied())? as i32;
    let ty: u32 = f.get(3)?.trim().parse().ok()?;
    let lane = if mode == 3 && keys > 0 {
        ((x.clamp(0, 511) as f64) * keys as f64 / 512.0).floor().clamp(0.0, keys as f64 - 1.0) as u8
    } else {
        0
    };

    let (kind, end) = if ty & 128 != 0 && mode == 3 {
        // x,y,time,type,hitSound,endTime:hitSample
        let end = f.get(5).and_then(|v| num(v.split(':').next())).map_or(time, |e| e as i32);
        (Kind::Hold, end)
    } else if ty & 8 != 0 {
        // x,y,time,type,hitSound,endTime,hitSample
        (Kind::Spinner, num(f.get(5).copied()).map_or(time, |e| e as i32))
    } else if ty & 2 != 0 {
        // x,y,time,type,hitSound,curve,slides,length,…
        let slides = num(f.get(6).copied()).unwrap_or(1.0).max(1.0);
        let length = num(f.get(7).copied()).unwrap_or(0.0).max(0.0);
        let (beat_len, sv) = timeline.at(time as f64);
        let per_beat = slider_multiplier * 100.0 * sv;
        let dur = if per_beat > 0.0 { length / per_beat * beat_len * slides } else { 0.0 };
        (Kind::Slider, time + dur.round() as i32)
    } else {
        (Kind::Circle, time)
    };
    Some(HitObject { time, end: end.max(time), x, kind, lane })
}

/// Beat length and slider velocity at a point in time.
struct Timeline {
    /// (time, beat length) of uninherited points
    beats: Vec<(f64, f64)>,
    /// (time, velocity multiplier) of inherited points
    velocity: Vec<(f64, f64)>,
}

impl Timeline {
    fn new(points: &[TimingPoint]) -> Self {
        let mut beats = Vec::new();
        let mut velocity = Vec::new();
        for p in points {
            if p.uninherited {
                if p.beat_len > 0.0 {
                    beats.push((p.time, p.beat_len));
                    // a new red line resets the velocity
                    velocity.push((p.time, 1.0));
                }
            } else if p.beat_len < 0.0 {
                velocity.push((p.time, (-100.0 / p.beat_len).clamp(0.1, 10.0)));
            }
        }
        Timeline { beats, velocity }
    }

    fn at(&self, t: f64) -> (f64, f64) {
        fn last_before(v: &[(f64, f64)], t: f64, default: f64) -> f64 {
            // osu! applies a point from its time on; before the first one, the first one counts
            let i = v.partition_point(|p| p.0 <= t);
            v.get(i.saturating_sub(1)).map_or(default, |p| p.1)
        }
        (last_before(&self.beats, t, 500.0), last_before(&self.velocity, t, 1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIA: &str = "\u{feff}osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 3

[Difficulty]
HPDrainRate:8
CircleSize:4
SliderMultiplier:1.4

[Events]
//Break Periods
2,5000,9000

[TimingPoints]
0,500,4,2,0,40,1,0
2000,-50,4,2,0,40,0,1

[HitObjects]
64,192,1000,1,0,0:0:0:0:
448,192,1000,1,0,0:0:0:0:
192,192,1500,128,0,2500:0:0:0:0:
320,192,800,5,0,0:0:0:0:
broken line
";

    #[test]
    fn mania_lanes_holds_and_order() {
        let c = parse(MANIA);
        assert_eq!((c.mode, c.keys), (3, 4));
        let got: Vec<(i32, u8, i32, Kind)> = c.objects.iter().map(|o| (o.time, o.lane, o.end, o.kind)).collect();
        assert_eq!(
            got,
            vec![(800, 2, 800, Kind::Circle), (1000, 0, 1000, Kind::Circle), (1000, 3, 1000, Kind::Circle), (1500, 1, 2500, Kind::Hold)]
        );
        assert_eq!(c.breaks, vec![(5000, 9000)]);
        assert_eq!(c.timing.len(), 2);
        assert!(!c.timing[1].uninherited && c.timing[1].kiai);
    }

    #[test]
    fn slider_ends_follow_velocity() {
        let text = "[General]\nMode: 0\n[Difficulty]\nSliderMultiplier:1.4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-50,4,1,0,100,0,0\n[HitObjects]\n0,0,0,2,0,L|100:0,1,140\n0,0,1000,2,0,L|100:0,2,140\n100,100,3000,12,0,4000\n";
        let c = parse(text);
        // 140 px at 1.4×100 px/beat = 1 beat = 500 ms
        assert_eq!(c.objects[0].end, 500);
        // doubled velocity, two slides: 0.5 beat × 2 = 500 ms
        assert_eq!(c.objects[1].end, 1500);
        assert_eq!((c.objects[2].kind, c.objects[2].end), (Kind::Spinner, 4000));
        assert_eq!(c.keys, 0);
    }

    #[test]
    fn tolerates_old_and_odd_files() {
        // v3-style timing (two fields), CRLF, decimals, missing sections
        let c = parse("[TimingPoints]\r\n120.5,333.33\r\n[HitObjects]\r\n10,10,99.7,1,0\r\n");
        assert_eq!(c.timing.len(), 1);
        assert!(c.timing[0].uninherited);
        assert_eq!(c.objects[0].time, 99);
        assert!(parse("").objects.is_empty());
    }
}
