//! osu!catch charts for the playfield, built the way lazer builds them (MIT, ppy Pty Ltd):
//!
//!   - `CatchBeatmapConverter`: osu!'s objects (`osu::read`) into fruits, juice streams and banana
//!     showers;
//!   - `JuiceStream`: a fruit at the head, every repeat and the tail, a droplet at every tick and
//!     tiny droplets between them all (`SliderEventGenerator`'s events, its legacy last tick too);
//!   - `BananaShower`: a banana every 100 ms or so;
//!   - `CatchBeatmapProcessor`: osu!stable's random offsets for bananas and tiny droplets
//!     (`LegacyRandom`, seed 1337), the end of every combo, and hyperdashes;
//!   - `CatchAutoGenerator`: where autoplay's catcher goes, walking, dashing or hyperdashing.
//!
//! Only beatmaps made for osu!catch are read (not osu! beatmaps converted).

use crate::osu::{self, Kind as OsuKind, Sounds};

/// `CatchPlayfield.WIDTH`
pub const WIDTH: f32 = 512.0;
/// `Catcher`
const BASE_SIZE: f32 = 106.75;
const ALLOWED_CATCH_RANGE: f32 = 0.8;
const BASE_DASH_SPEED: f64 = 1.0;
const BASE_WALK_SPEED: f64 = 0.5;
/// `CatchBeatmapProcessor.RNG_SEED`
const RNG_SEED: i32 = 1337;
/// `SliderEventGenerator.TAIL_LENIENCY`
const TAIL_LENIENCY: f64 = -36.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Fruit,
    Droplet,
    TinyDroplet,
    Banana,
}

impl Kind {
    pub fn code(self) -> u8 {
        match self {
            Kind::Fruit => 0,
            Kind::Droplet => 1,
            Kind::TinyDroplet => 2,
            Kind::Banana => 3,
        }
    }
}

/// Something to catch.
#[derive(Debug, Clone)]
pub struct Object {
    pub kind: Kind,
    pub time: f64,
    /// `EffectiveX`
    pub x: f32,
    /// `IndexInBeatmap`: the object it came from (its colour, a fruit's look)
    pub index: i32,
    /// the next fruit or droplet is a hyperdash away
    pub hyper: bool,
    /// catching it ends the combo (the plate empties)
    pub last_in_combo: bool,
    /// a banana's number in its shower
    pub banana: i32,
    /// its sounds: a fruit's own; a droplet its juice stream's (as "slidertick"); a banana its
    /// shower's; tiny droplets none
    pub sounds: Option<Sounds>,
}

/// Where autoplay's catcher is at a time (it moves straight between frames).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub time: f64,
    pub x: f32,
    pub dash: bool,
}

#[derive(Debug, Clone)]
pub struct Chart {
    /// `CatchHitObject.Scale` from CS (the catcher is twice that)
    pub scale: f32,
    /// how long objects fall, ms
    pub preempt: f64,
    pub objects: Vec<Object>,
    pub frames: Vec<Frame>,
    /// the beatmap's own combo colours
    pub colours: Vec<[u8; 3]>,
}

/// osu!stable's random numbers (`LegacyRandom`, xorshift).
struct LegacyRandom {
    x: u32,
    y: u32,
    z: u32,
    w: u32,
}

impl LegacyRandom {
    fn new(seed: i32) -> Self {
        LegacyRandom { x: seed as u32, y: 842_502_087, z: 3_579_807_591, w: 273_326_509 }
    }

    fn next_uint(&mut self) -> u32 {
        let t = self.x ^ (self.x << 11);
        self.x = self.y;
        self.y = self.z;
        self.z = self.w;
        self.w = self.w ^ (self.w >> 19) ^ t ^ (t >> 8);
        self.w
    }

    fn next(&mut self) -> i32 {
        (0x7FFF_FFFF & self.next_uint()) as i32
    }

    fn next_double(&mut self) -> f64 {
        (1.0 / (i32::MAX as f64 + 1.0)) * self.next() as f64
    }

    fn next_range(&mut self, lower: i32, upper: i32) -> i32 {
        (lower as f64 + self.next_double() * (upper - lower) as f64) as i32
    }
}

/// `LegacyRulesetExtensions.CalculateScaleFromCircleSize` (without osu!'s fudge).
fn scale_from_cs(cs: f32) -> f32 {
    (1.0f32 - 0.7f32 * (cs - 5.0) / 5.0) / 2.0
}

/// `Catcher.CalculateCatchWidth`: how wide the catcher catches.
pub fn catch_width(scale: f32) -> f32 {
    BASE_SIZE * (scale * 2.0).abs() * ALLOWED_CATCH_RANGE
}

/// `IBeatmapDifficultyInfo.DifficultyRange`
fn difficulty_range(d: f64, min: f64, mid: f64, max: f64) -> f64 {
    if d > 5.0 {
        mid + (max - mid) * (d - 5.0) / 5.0
    } else if d < 5.0 {
        mid + (mid - min) * (d - 5.0) / 5.0
    } else {
        mid
    }
}

/// One top-level object and what it holds (lazer's nested objects).
struct Parent {
    banana_shower: bool,
    new_combo: bool,
    last_in_combo: bool,
    /// a fruit is its own only object
    children: Vec<Object>,
    /// `OriginalX` per child (before offsets)
    original: Vec<f32>,
}

/// An osu!catch difficulty for the playfield, `None` for other rulesets.
pub fn parse(text: &str) -> Option<Chart> {
    let raw = osu::read(text, 2)?;
    let scale = scale_from_cs(raw.cs);
    let preempt = difficulty_range(raw.ar as f64, 1800.0, 1200.0, 450.0) as i32 as f64;

    let mut parents: Vec<Parent> = Vec::with_capacity(raw.objects.len());
    for o in &raw.objects {
        let x = o.pos.x;
        match o.kind {
            OsuKind::Circle => parents.push(Parent {
                banana_shower: false,
                new_combo: o.new_combo,
                last_in_combo: false,
                children: vec![object(Kind::Fruit, o.time, o.sounds.first().cloned())],
                original: vec![x],
            }),
            OsuKind::Slider => {
                let (children, original) = juice_stream(o, x);
                parents.push(Parent { banana_shower: false, new_combo: o.new_combo, last_in_combo: false, children, original });
            }
            OsuKind::Spinner => {
                let (children, original) = banana_shower(o);
                parents.push(Parent { banana_shower: true, new_combo: o.new_combo, last_in_combo: false, children, original });
            }
        }
    }

    // CatchBeatmapProcessor.PreProcess + CatchHitObject.UpdateComboInformation: a new combo for
    // the first object and the first after a banana shower; starting one ends the last
    for i in 0..parents.len() {
        let after_shower = i == 0 || parents[i - 1].banana_shower;
        if !parents[i].banana_shower && (parents[i].new_combo || after_shower) && i > 0 {
            parents[i - 1].last_in_combo = true;
        }
    }
    for (index, p) in parents.iter_mut().enumerate() {
        for c in &mut p.children {
            c.index = index as i32;
        }
        if p.last_in_combo {
            if let Some(last) = p.children.last_mut() {
                last.last_in_combo = true;
            }
        }
    }

    offsets(&mut parents);
    hyperdash(&mut parents, scale);
    let frames = autoplay(&parents, scale);
    let objects = parents.into_iter().flat_map(|p| p.children).collect();
    Some(Chart { scale, preempt, objects, frames, colours: raw.colours })
}

fn object(kind: Kind, time: f64, sounds: Option<Sounds>) -> Object {
    Object { kind, time, x: 0.0, index: 0, hyper: false, last_in_combo: false, banana: 0, sounds }
}

/// `JuiceStream.CreateNestedHitObjects`, the children in time order with their original X.
fn juice_stream(o: &osu::Object, x: f32) -> (Vec<Object>, Vec<f32>) {
    let Some(s) = &o.slider else { return (Vec::new(), Vec::new()) };
    let effective = x.clamp(0.0, WIDTH);
    let spans = s.spans.max(1) as usize;
    let start = o.time;
    let at = |progress: f64| effective + s.path.position_at(progress).x;

    // SliderEventGenerator, in its order: the head; each span's ticks and its repeat; the legacy
    // last tick; the tail
    #[derive(Clone, Copy, PartialEq)]
    enum Ev {
        Node,
        Tick,
        LastTick,
    }
    let mut events: Vec<(Ev, f64, f64)> = vec![(Ev::Node, start, 0.0)];
    let per_span = s.ticks.len() / spans;
    for span in 0..spans {
        for &(t, p) in s.ticks.iter().skip(span * per_span).take(per_span) {
            events.push((Ev::Tick, t, p));
        }
        if span < spans - 1 {
            events.push((Ev::Node, start + span as f64 * s.span_duration + s.span_duration, ((span + 1) % 2) as f64));
        }
    }
    let total = spans as f64 * s.span_duration;
    let final_start = start + (spans - 1) as f64 * s.span_duration;
    let last_tick = (start + total / 2.0).max(final_start + s.span_duration + TAIL_LENIENCY);
    let mut last_progress = if s.span_duration > 0.0 { (last_tick - final_start) / s.span_duration } else { 0.0 };
    if spans % 2 == 0 {
        last_progress = 1.0 - last_progress;
    }
    events.push((Ev::LastTick, last_tick, last_progress));
    events.push((Ev::Node, start + total, (spans % 2) as f64));

    let mut out: Vec<(Object, f32)> = Vec::new();
    let mut node = 0;
    let mut last: Option<(f64, f64)> = None;
    for &(ev, time, progress) in &events {
        // tiny droplets since the last event
        if let Some((last_time, last_progress)) = last {
            let since = ((time as i32) - (last_time as i32)) as f64;
            if since > 80.0 {
                let mut between = since;
                while between > 100.0 {
                    between /= 2.0;
                }
                let mut t = between;
                while t < since {
                    let x = at(last_progress + (t / since) * (progress - last_progress));
                    out.push((object(Kind::TinyDroplet, t + last_time, None), x));
                    t += between;
                }
            }
        }
        last = Some((time, progress));
        match ev {
            Ev::Tick => out.push((object(Kind::Droplet, time, Some(s.main.clone())), at(progress))),
            Ev::Node => {
                let sounds = o.sounds.get(node).cloned();
                node += 1;
                out.push((object(Kind::Fruit, time, sounds), at(progress)));
            }
            Ev::LastTick => {}
        }
    }
    // nested objects are kept in time order
    out.sort_by(|a, b| a.0.time.total_cmp(&b.0.time));
    out.into_iter().unzip()
}

/// `BananaShower.createBananas`
fn banana_shower(o: &osu::Object) -> (Vec<Object>, Vec<f32>) {
    let start = o.time as i32;
    let end = o.end as i32;
    let mut spacing = (o.end - o.time) as f32;
    while spacing > 100.0 {
        spacing /= 2.0;
    }
    let mut out = Vec::new();
    if spacing <= 0.0 {
        return (out, Vec::new());
    }
    let mut time = start as f32;
    let mut count = 0;
    while time <= end as f32 && count < 100_000 {
        let mut b = object(Kind::Banana, time as f64, o.sounds.first().cloned());
        b.banana = count;
        out.push(b);
        count += 1;
        time += spacing;
    }
    let n = out.len();
    (out, vec![0.0; n])
}

/// `CatchBeatmapProcessor.ApplyPositionOffsets` (without Hard Rock): bananas anywhere, tiny
/// droplets up to 20 either way; the rest where they are.
fn offsets(parents: &mut [Parent]) {
    let mut rng = LegacyRandom::new(RNG_SEED);
    for p in parents.iter_mut() {
        let Parent { children, original, banana_shower, .. } = p;
        for (c, &ox) in children.iter_mut().zip(original.iter()) {
            let mut offset = 0.0f32;
            if *banana_shower {
                offset = (rng.next_double() * WIDTH as f64) as f32;
                // osu!stable drew a banana's type, rotation and colour
                rng.next();
                rng.next();
                rng.next();
            } else if c.kind == Kind::TinyDroplet {
                offset = (rng.next_range(-20, 20) as f32).clamp(-ox, WIDTH - ox);
            } else if c.kind == Kind::Droplet {
                // a droplet's rotation
                rng.next();
            }
            c.x = (ox + offset).clamp(0.0, WIDTH);
        }
    }
}

/// `CatchBeatmapProcessor.initialiseHyperDash`: a fruit or droplet is a hyperdash when the next
/// one is further than dashing gets in time.
fn hyperdash(parents: &mut [Parent], scale: f32) {
    let mut palpable: Vec<(usize, usize)> = Vec::new();
    for (i, p) in parents.iter().enumerate() {
        for (j, c) in p.children.iter().enumerate() {
            if matches!(c.kind, Kind::Fruit | Kind::Droplet) {
                palpable.push((i, j));
            }
        }
    }
    let mut half = (catch_width(scale) / 2.0) as f64;
    half /= ALLOWED_CATCH_RANGE as f64;
    let mut last_direction = 0;
    let mut last_excess = half;
    for k in 0..palpable.len().saturating_sub(1) {
        let (ci, cj) = palpable[k];
        let (ni, nj) = palpable[k + 1];
        let (cur_x, cur_t) = (parents[ci].children[cj].x, parents[ci].children[cj].time);
        let (next_x, next_t) = (parents[ni].children[nj].x, parents[ni].children[nj].time);
        let direction = if next_x > cur_x { 1 } else { -1 };
        let time_to_next = (next_t as i32 - cur_t as i32) as f64 - (1000.0f32 / 60.0 / 4.0) as f64;
        let distance_to_next = (next_x - cur_x).abs() as f64 - if last_direction == direction { last_excess } else { half };
        let distance_to_hyper = (time_to_next * BASE_DASH_SPEED - distance_to_next) as f32;
        let current = &mut parents[ci].children[cj];
        if distance_to_hyper < 0.0 {
            current.hyper = true;
            last_excess = half;
        } else {
            current.hyper = false;
            last_excess = (distance_to_hyper as f64).clamp(0.0, half);
        }
        last_direction = direction;
    }
}

/// `CatchAutoGenerator`: to every fruit, droplet and banana in turn.
fn autoplay(parents: &[Parent], scale: f32) -> Vec<Frame> {
    let half = catch_width(scale) * 0.5;
    let mut frames: Vec<Frame> = Vec::new();
    let mut last_x = WIDTH / 2.0;
    let mut last_time = 0.0f64;
    let mut add = |time: f64, x: f32, dash: bool| frames.push(Frame { time, x, dash });
    for h in parents.iter().flat_map(|p| p.children.iter()) {
        let change = (last_x - h.x).abs();
        let available = h.time - last_time;
        if available < 0.0 {
            continue;
        }
        let speed = if change == 0.0 { 0.0 } else { change as f64 / available };
        let dash_required = speed > BASE_WALK_SPEED;
        let impossible = speed > BASE_DASH_SPEED;
        if last_x - half < h.x && last_x + half > h.x {
            last_time = h.time;
            add(h.time, last_x, false);
            continue;
        }
        if impossible {
            add(h.time, h.x, false);
        } else if h.hyper {
            add(h.time - available, last_x, false);
            add(h.time, h.x, false);
        } else if dash_required {
            let at_normal = change as f64 / BASE_WALK_SPEED;
            let save = at_normal - available;
            let at_dash = save / 2.0;
            let mid = last_x + (h.x - last_x) * (at_dash / available) as f32;
            add(h.time - available + 1.0, last_x, true);
            add(h.time - available + at_dash, mid, false);
            add(h.time, h.x, false);
        } else {
            let before = change as f64 / BASE_WALK_SPEED;
            add(h.time - before, last_x, false);
            add(h.time, h.x, false);
        }
        last_time = h.time;
        last_x = h.x;
    }
    frames.sort_by(|a, b| a.time.total_cmp(&b.time));
    frames
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "osu file format v14\n\n[General]\nMode: 2\n\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:8\nApproachRate:8\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,500,4,2,0,100,1,0\n\n[HitObjects]\n";

    #[test]
    fn legacy_random_matches_stable() {
        // System.Random-compatible xorshift: the first numbers for seed 1337
        let mut r = LegacyRandom::new(1337);
        let a = r.next_uint();
        let b = r.next_uint();
        assert_ne!(a, b);
        let mut r2 = LegacyRandom::new(1337);
        assert_eq!(r2.next_uint(), a);
        // doubles stay in [0, 1)
        for _ in 0..1000 {
            let d = r.next_double();
            assert!((0.0..1.0).contains(&d));
        }
    }

    #[test]
    fn fruits_streams_and_showers() {
        let text = format!("{HEAD}256,192,1000,5,0,0:0:0:0:\n100,192,2000,2,0,L|300:192,1,200\n256,192,4000,12,0,5000,0:0:0:0:\n400,192,6000,1,0,0:0:0:0:\n");
        let c = parse(&text).unwrap();
        let kinds: Vec<Kind> = c.objects.iter().map(|o| o.kind).collect();
        // a fruit; the stream's head fruit, droplets at its ticks, tiny droplets, its tail fruit;
        // bananas
        assert_eq!(kinds[0], Kind::Fruit);
        assert_eq!(c.objects[0].x, 256.0);
        let stream: Vec<&Object> = c.objects.iter().filter(|o| o.index == 1).collect();
        assert_eq!(stream.first().unwrap().kind, Kind::Fruit);
        assert_eq!(stream.last().unwrap().kind, Kind::Fruit);
        assert_eq!(stream.first().unwrap().x, 100.0);
        assert!((stream.last().unwrap().x - 300.0).abs() < 0.01);
        assert!(stream.iter().any(|o| o.kind == Kind::Droplet));
        assert!(stream.iter().any(|o| o.kind == Kind::TinyDroplet));
        // velocity 1.4 * 100 / 500 = 0.28 px/ms: 200 px take ~714 ms
        assert!((stream.last().unwrap().time - (2000.0 + 200.0 / 0.28)).abs() < 1.0);
        let bananas = c.objects.iter().filter(|o| o.kind == Kind::Banana).count();
        assert!(bananas >= 10, "{bananas}");
        // in time order within the stream, and a shower always ends its combo
        assert!(stream.windows(2).all(|w| w[0].time <= w[1].time));
        assert!(c.objects.iter().rev().find(|o| o.kind == Kind::Banana).unwrap().last_in_combo);
        // autoplay ends on the last fruit
        let last = c.frames.last().unwrap();
        assert_eq!(last.time, 6000.0);
        assert!((last.x - 400.0).abs() < catch_width(c.scale) / 2.0);
    }

    #[test]
    fn hyperdashes_on_long_jumps() {
        // edge to edge in 100 ms is beyond dashing
        let text = format!("{HEAD}0,192,1000,5,0,0:0:0:0:\n512,192,1100,1,0,0:0:0:0:\n512,192,3000,1,0,0:0:0:0:\n");
        let c = parse(&text).unwrap();
        assert!(c.objects[0].hyper);
        assert!(!c.objects[1].hyper);
        // the catcher moves straight from one to the other
        assert!(c.frames.iter().any(|f| f.time == 1000.0 && f.x == 0.0));
        assert!(c.frames.iter().any(|f| f.time == 1100.0 && f.x == 512.0));
    }

    #[test]
    fn other_rulesets_are_not_read() {
        assert!(parse("osu file format v14\n\n[General]\nMode: 0\n\n[HitObjects]\n256,192,1000,1,0\n").is_none());
    }
}
