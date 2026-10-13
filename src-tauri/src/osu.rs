//! osu! (standard) charts for the playfield, built the way lazer builds them (MIT, ppy Pty Ltd):
//!
//!   - `LegacyBeatmapDecoder` + `ConvertHitObjectParser`: control points (a green line at a red
//!     line's time wins the slider velocity), the early-version offset, positions (whole numbers
//!     before lazer's own format), slider paths with their implicit segments, combos (a new one
//!     after every break and spinner);
//!   - `SliderPath` + osu-framework's `PathApproximator`: linear, perfect-circle, Catmull and
//!     B-spline / Bézier segments, cut or stretched to the slider's length (Catmull paths thinned
//!     like stable does);
//!   - `Slider` + `SliderEventGenerator`: velocity, ticks, repeats and the tail;
//!   - `OsuHitObject`: approach time and fade-in from AR, circle size from CS, combo numbers and
//!     colour indices (`ComboIndexWithOffsets`);
//!   - `OsuBeatmapProcessor`: stacking, both the current and the pre-v6 algorithm;
//!   - `OsuAutoGenerator`: autoplay's cursor, frame by frame (60 a second), with its eased
//!     moves, slider following, spinning and button alternation.
//!
//! Only beatmaps made for osu! are read; osu!catch (catch.rs) builds on the same objects (`read`).

use std::ops::{Add, Div, Mul, Sub};

/// `OsuBeatmapProcessor.STACK_DISTANCE`
const STACK_DISTANCE: f32 = 3.0;
/// `LegacyBeatmapEncoder.FIRST_LAZER_VERSION`: from here on positions keep their fractions
const FIRST_LAZER_VERSION: i32 = 128;
/// `LegacyBeatmapDecoder.EARLY_VERSION_TIMING_OFFSET`: v4 and older were 24 ms early
const EARLY_VERSION_TIMING_OFFSET: f64 = 24.0;
/// `Parsing.MAX_COORDINATE_VALUE`
const MAX_COORDINATE: f64 = 131_072.0;
/// `OsuPlayfield.BASE_SIZE / 2`, `OsuAutoGeneratorBase.SPIN_RADIUS`
const SPINNER_CENTRE: Vec2 = Vec2 { x: 256.0, y: 192.0 };
const SPIN_RADIUS: f32 = 50.0;
/// `AutoGenerator.KEY_UP_DELAY`
const KEY_UP_DELAY: f64 = 50.0;
/// `OsuAutoGenerator.MIN_FRAME_SEPARATION_FOR_ALTERNATING`
const MIN_FRAME_SEPARATION_FOR_ALTERNATING: f64 = 266.0;
/// `OsuAutoGeneratorBase.GetFrameDelay`: 60 frames a second
const FRAME_DELAY: f64 = 1000.0 / 60.0;
/// `Spinner`: spins after the required ones before bonus spins count
const BONUS_SPINS_GAP: u32 = 2;

/// Autoplay's buttons, as bits.
pub const LEFT: u8 = 1;
pub const RIGHT: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const fn new(x: f32, y: f32) -> Self {
        Vec2 { x, y }
    }
    fn length_sq(self) -> f32 {
        self.x * self.x + self.y * self.y
    }
    pub fn length(self) -> f32 {
        self.length_sq().sqrt()
    }
    fn normalized(self) -> Vec2 {
        let scale = 1.0 / self.length();
        Vec2::new(self.x * scale, self.y * scale)
    }
    fn distance(self, o: Vec2) -> f32 {
        (self - o).length()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x + o.x, self.y + o.y)
    }
}
impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        Vec2::new(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f32> for Vec2 {
    type Output = Vec2;
    fn mul(self, s: f32) -> Vec2 {
        Vec2::new(self.x * s, self.y * s)
    }
}
impl Div<f32> for Vec2 {
    type Output = Vec2;
    fn div(self, s: f32) -> Vec2 {
        Vec2::new(self.x / s, self.y / s)
    }
}

/// `Precision.AlmostEquals` for floats and doubles.
fn almost_f32(a: f32, b: f32) -> bool {
    (a - b).abs() <= 1e-3
}
fn almost_f64(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-7
}

// ── slider paths ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PathType {
    Linear,
    PerfectCurve,
    Catmull,
    /// a B-spline of this degree; `None` is a Bézier curve through all points
    BSpline(Option<i32>),
}

const BEZIER: PathType = PathType::BSpline(None);

#[derive(Debug, Clone, Copy)]
struct ControlPoint {
    pos: Vec2,
    ty: Option<PathType>,
}

mod approx {
    //! osu-framework's `PathApproximator` and `CircularArcProperties`.
    use super::{almost_f32, Vec2};

    const BEZIER_TOLERANCE: f32 = 0.25;
    pub const CATMULL_DETAIL: usize = 50;
    const CIRCULAR_ARC_TOLERANCE: f32 = 0.1;

    pub fn linear(points: &[Vec2]) -> Vec<Vec2> {
        points.to_vec()
    }

    pub fn bezier(points: &[Vec2]) -> Vec<Vec2> {
        bspline(points, (points.len() as i32 - 1).max(1))
    }

    pub fn bspline(points: &[Vec2], degree: i32) -> Vec<Vec2> {
        if points.len() < 2 {
            return points.to_vec();
        }
        let degree = (degree.max(1) as usize).min(points.len() - 1);
        let mut output = Vec::new();
        let point_count = points.len() - 1;
        let mut to_flatten = bspline_to_bezier(points, degree);
        let mut free: Vec<Vec<Vec2>> = Vec::new();
        let mut buf1 = vec![Vec2::default(); degree + 1];
        let mut buf2 = vec![Vec2::default(); degree * 2 + 1];
        let mut left = vec![Vec2::default(); degree * 2 + 1];
        while let Some(mut parent) = to_flatten.pop() {
            if flat_enough(&parent) {
                approximate(&parent, &mut output, &mut buf1, &mut buf2, degree + 1);
                free.push(parent);
                continue;
            }
            let mut right = free.pop().unwrap_or_else(|| vec![Vec2::default(); degree + 1]);
            subdivide(&parent, &mut left, &mut right, &mut buf1, degree + 1);
            parent[..degree + 1].copy_from_slice(&left[..degree + 1]);
            to_flatten.push(right);
            to_flatten.push(parent);
        }
        output.push(points[point_count]);
        output
    }

    /// Bézier pieces of a B-spline, in reverse order (a stack: the first piece pops first).
    fn bspline_to_bezier(points: &[Vec2], degree: usize) -> Vec<Vec<Vec2>> {
        let point_count = points.len() - 1;
        let mut points = points.to_vec();
        if degree == point_count {
            return vec![points];
        }
        let mut result = Vec::new();
        for i in 0..point_count - degree {
            let mut sub = vec![Vec2::default(); degree + 1];
            sub[0] = points[i];
            // insert the knot degree - 1 times (Boehm)
            for j in 0..degree - 1 {
                sub[j + 1] = points[i + 1];
                for k in 1..degree - j {
                    let l = k.min(point_count - degree - i) as f32;
                    points[i + k] = (points[i + k] * l + points[i + k + 1]) / (l + 1.0);
                }
            }
            sub[degree] = points[i + 1];
            result.push(sub);
        }
        result.push(points[point_count - degree..].to_vec());
        result.reverse();
        result
    }

    fn flat_enough(points: &[Vec2]) -> bool {
        points.windows(3).all(|w| (w[0] - w[1] * 2.0 + w[2]).length_sq() <= BEZIER_TOLERANCE * BEZIER_TOLERANCE * 4.0)
    }

    fn subdivide(points: &[Vec2], l: &mut [Vec2], r: &mut [Vec2], mid: &mut [Vec2], count: usize) {
        mid[..count].copy_from_slice(&points[..count]);
        for i in 0..count {
            l[i] = mid[0];
            r[count - i - 1] = mid[count - i - 1];
            for j in 0..count - i - 1 {
                mid[j] = (mid[j] + mid[j + 1]) / 2.0;
            }
        }
    }

    fn approximate(points: &[Vec2], output: &mut Vec<Vec2>, buf1: &mut [Vec2], buf2: &mut [Vec2], count: usize) {
        let mut r = vec![Vec2::default(); count];
        subdivide(points, buf2, &mut r, buf1, count);
        for i in 0..count - 1 {
            buf2[count + i] = r[i + 1];
        }
        output.push(points[0]);
        for i in 1..count - 1 {
            let index = 2 * i;
            output.push((buf2[index - 1] + buf2[index] * 2.0 + buf2[index + 1]) * 0.25);
        }
    }

    pub fn catmull(points: &[Vec2]) -> Vec<Vec2> {
        let mut out = Vec::with_capacity(points.len().saturating_sub(1) * CATMULL_DETAIL * 2);
        for i in 0..points.len().saturating_sub(1) {
            let v1 = if i > 0 { points[i - 1] } else { points[i] };
            let v2 = points[i];
            let v3 = if i < points.len() - 1 { points[i + 1] } else { v2 + v2 - v1 };
            let v4 = if i < points.len() - 2 { points[i + 2] } else { v3 + v3 - v2 };
            for c in 0..CATMULL_DETAIL {
                out.push(catmull_point(v1, v2, v3, v4, c as f32 / CATMULL_DETAIL as f32));
                out.push(catmull_point(v1, v2, v3, v4, (c + 1) as f32 / CATMULL_DETAIL as f32));
            }
        }
        out
    }

    fn catmull_point(v1: Vec2, v2: Vec2, v3: Vec2, v4: Vec2, t: f32) -> Vec2 {
        let t2 = t * t;
        let t3 = t * t2;
        let f = |a: f32, b: f32, c: f32, d: f32| 0.5 * (2.0 * b + (-a + c) * t + (2.0 * a - 5.0 * b + 4.0 * c - d) * t2 + (-a + 3.0 * b - 3.0 * c + d) * t3);
        Vec2::new(f(v1.x, v2.x, v3.x, v4.x), f(v1.y, v2.y, v3.y, v4.y))
    }

    pub struct Arc {
        pub theta_start: f64,
        pub theta_range: f64,
        pub direction: f64,
        pub radius: f32,
        pub centre: Vec2,
    }

    /// `CircularArcProperties`: the circle through three points, `None` when they're (almost) on
    /// a line.
    pub fn arc(points: &[Vec2]) -> Option<Arc> {
        let (a, b, c) = (points[0], points[1], points[2]);
        if almost_f32(0.0, (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y)) {
            return None;
        }
        let d = 2.0 * (a.x * (b - c).y + b.x * (c - a).y + c.x * (a - b).y);
        let (a_sq, b_sq, c_sq) = (a.length_sq(), b.length_sq(), c.length_sq());
        let centre = Vec2::new(
            a_sq * (b - c).y + b_sq * (c - a).y + c_sq * (a - b).y,
            a_sq * (c - b).x + b_sq * (a - c).x + c_sq * (b - a).x,
        ) / d;
        let d_a = a - centre;
        let d_c = c - centre;
        let radius = d_a.length();
        let theta_start = (d_a.y as f64).atan2(d_a.x as f64);
        let mut theta_end = (d_c.y as f64).atan2(d_c.x as f64);
        while theta_end < theta_start {
            theta_end += 2.0 * std::f64::consts::PI;
        }
        let mut direction = 1.0;
        let mut theta_range = theta_end - theta_start;
        // which side of AC is B on
        let ortho = Vec2::new((c - a).y, -(c - a).x);
        if ortho.x * (b - a).x + ortho.y * (b - a).y < 0.0 {
            direction = -direction;
            theta_range = 2.0 * std::f64::consts::PI - theta_range;
        }
        Some(Arc { theta_start, theta_range, direction, radius, centre })
    }

    /// How many points `circular` would use.
    pub fn arc_points(a: &Arc) -> usize {
        if 2.0 * a.radius <= CIRCULAR_ARC_TOLERANCE {
            2
        } else {
            let step = 2.0 * ((1.0 - CIRCULAR_ARC_TOLERANCE / a.radius) as f64).acos();
            ((a.theta_range / step).ceil() as i64).max(2) as usize
        }
    }

    pub fn circular(points: &[Vec2]) -> Vec<Vec2> {
        let Some(a) = arc(points) else { return bezier(points) };
        let n = arc_points(&a);
        (0..n)
            .map(|i| {
                let fract = i as f64 / (n - 1) as f64;
                let theta = a.theta_start + a.direction * fract * a.theta_range;
                a.centre + Vec2::new(theta.cos() as f32, theta.sin() as f32) * a.radius
            })
            .collect()
    }
}

/// `SliderPath` with `OptimiseCatmull` (as osu! sliders have it): the path as straight pieces,
/// fitted to the expected length.
#[derive(Debug, Clone, Default)]
pub struct Path {
    pub points: Vec<Vec2>,
    /// distance along the path at each point
    pub cumulative: Vec<f64>,
}

impl Path {
    fn new(control: &[ControlPoint], expected: Option<f64>) -> Path {
        let mut path = Vec::new();
        let mut optimised = 0.0f64;
        if !control.is_empty() {
            let vertices: Vec<Vec2> = control.iter().map(|c| c.pos).collect();
            let mut start = 0;
            for i in 0..control.len() {
                if control[i].ty.is_none() && i < control.len() - 1 {
                    continue;
                }
                let seg = &vertices[start..=i];
                let ty = control[start].ty.unwrap_or(PathType::Linear);
                if seg.len() == 1 {
                    path.push(seg[0]);
                } else {
                    let sub = sub_path(seg, ty, &mut optimised);
                    let skip = !path.is_empty() && !sub.is_empty() && path.last() == sub.first();
                    path.extend_from_slice(&sub[skip as usize..]);
                }
                start = i;
            }
        }

        // lengths, then cut or stretched to the expected one
        let mut length = optimised;
        let mut cumulative = vec![0.0];
        for w in path.windows(2) {
            length += (w[1] - w[0]).length() as f64;
            cumulative.push(length);
        }
        if let Some(expected) = expected.filter(|&e| e != length) {
            // stable doesn't extend a path whose last two points are the same
            if path.len() >= 2 && path[path.len() - 1] == path[path.len() - 2] && expected > length {
                cumulative.push(length);
                return Path { points: path, cumulative };
            }
            cumulative.pop();
            let mut end = path.len() as isize - 1;
            if length > expected {
                while cumulative.last().is_some_and(|&c| c >= expected) {
                    cumulative.pop();
                    path.remove(end as usize);
                    end -= 1;
                }
            }
            if end <= 0 {
                cumulative.push(0.0);
                return Path { points: path, cumulative };
            }
            let end = end as usize;
            let dir = (path[end] - path[end - 1]).normalized();
            path[end] = path[end - 1] + dir * (expected - cumulative[cumulative.len() - 1]) as f32;
            cumulative.push(expected);
        }
        Path { points: path, cumulative }
    }

    pub fn distance(&self) -> f64 {
        self.cumulative.last().copied().unwrap_or(0.0)
    }

    /// The point at a share of the path's length.
    pub fn position_at(&self, progress: f64) -> Vec2 {
        let d = progress.clamp(0.0, 1.0) * self.distance();
        // List.BinarySearch: an exact match, else the first bigger one
        let i = match self.cumulative.binary_search_by(|c| c.total_cmp(&d)) {
            Ok(i) | Err(i) => i,
        };
        self.interpolate(i, d)
    }

    fn interpolate(&self, i: usize, d: f64) -> Vec2 {
        let p = &self.points;
        if p.is_empty() {
            return Vec2::default();
        }
        if i == 0 {
            return p[0];
        }
        if i >= p.len() {
            return p[p.len() - 1];
        }
        let (d0, d1) = (self.cumulative[i - 1], self.cumulative[i]);
        if almost_f64(d0, d1) {
            return p[i - 1];
        }
        let w = (d - d0) / (d1 - d0);
        p[i - 1] + (p[i] - p[i - 1]) * w as f32
    }
}

fn sub_path(seg: &[Vec2], ty: PathType, optimised: &mut f64) -> Vec<Vec2> {
    match ty {
        PathType::Linear => return approx::linear(seg),
        PathType::PerfectCurve if seg.len() == 3 => {
            if let Some(a) = approx::arc(seg) {
                if approx::arc_points(&a) < 1000 {
                    let sub = approx::circular(seg);
                    if !sub.is_empty() {
                        return sub;
                    }
                }
            }
        }
        PathType::Catmull => {
            let sub = approx::catmull(seg);
            // stable keeps only points 6 px apart when drawing; Catmull paths through repeated
            // points bulge without it
            let mut out = Vec::with_capacity(sub.len());
            let mut last_start: Option<Vec2> = None;
            let mut removed = 0.0f64;
            for i in 0..sub.len() {
                let Some(start) = last_start else {
                    out.push(sub[i]);
                    last_start = Some(sub[i]);
                    continue;
                };
                let from_start = start.distance(sub[i]) as f64;
                removed += sub[i - 1].distance(sub[i]) as f64;
                if from_start > 6.0 || (i + 1) % (approx::CATMULL_DETAIL * 2) == 0 || i == sub.len() - 1 {
                    out.push(sub[i]);
                    *optimised += removed - from_start;
                    last_start = None;
                    removed = 0.0;
                }
            }
            return out;
        }
        _ => {}
    }
    let degree = match ty {
        PathType::BSpline(Some(d)) => d,
        _ => seg.len() as i32,
    };
    approx::bspline(seg, degree)
}

// ── beatmap ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Circle,
    Slider,
    Spinner,
}

/// A hit sample line's sounds (the banks are resolved in hitsounds.rs).
#[derive(Debug, Clone, Default)]
pub struct Sounds {
    /// 1 normal, 2 whistle, 4 finish, 8 clap
    pub sound: i64,
    /// `LegacySampleBank` (0: inherit)
    pub normal_set: i64,
    pub addition_set: i64,
    pub index: i64,
    pub volume: i64,
    pub file: Option<String>,
    /// when it plays
    pub time: f64,
    /// lazer reads the sample control point at this time
    pub point_time: f64,
}

#[derive(Debug, Clone)]
pub struct Slider {
    /// relative to the slider's position
    pub path: Path,
    pub spans: u32,
    pub span_duration: f64,
    /// `(time, path progress)` per tick, in time order
    pub ticks: Vec<(f64, f64)>,
    /// the slider's own sounds (ticks and the sliding sound come from these)
    pub main: Sounds,
}

#[derive(Debug, Clone)]
pub struct Object {
    pub kind: Kind,
    pub time: f64,
    pub end: f64,
    /// as written (whole numbers before lazer's format)
    pub pos: Vec2,
    pub stack: i32,
    pub new_combo: bool,
    combo_offset: i32,
    pub combo_index: i32,
    /// the combo colour index (`ComboIndexWithOffsets`)
    pub colour: i32,
    pub index_in_combo: i32,
    pub last_in_combo: bool,
    pub slider: Option<Slider>,
    /// spinners: spins to clear, bonus spins on top
    pub spins: u32,
    pub bonus_spins: u32,
    /// circles: their sounds; sliders: head, repeats, tail; spinners: at their end
    pub sounds: Vec<Sounds>,
}

impl Object {
    pub fn stack_offset(&self, scale: f32) -> Vec2 {
        if self.kind == Kind::Spinner {
            return Vec2::default();
        }
        let o = self.stack as f32 * scale * -6.4;
        Vec2::new(o, o)
    }

    /// `CurvePositionAt`: where on its path a slider is at a share of its duration.
    pub fn curve_at(&self, progress: f64) -> Vec2 {
        let Some(s) = &self.slider else { return Vec2::default() };
        let spans = s.spans as f64;
        let mut p = (progress * spans) % 1.0;
        if ((progress * spans) as i64) % 2 == 1 {
            p = 1.0 - p;
        }
        s.path.position_at(p)
    }

    pub fn end_pos(&self) -> Vec2 {
        if self.slider.is_some() {
            self.pos + self.curve_at(1.0)
        } else {
            self.pos
        }
    }
}

/// One autoplay frame.
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub time: f64,
    pub pos: Vec2,
    /// `LEFT` | `RIGHT`
    pub buttons: u8,
}

#[derive(Debug, Clone, Default)]
pub struct Chart {
    /// `OsuHitObject.Scale` (CS)
    pub scale: f32,
    /// approach time and fade-in, ms (AR)
    pub preempt: f64,
    pub fade_in: f64,
    pub objects: Vec<Object>,
    pub frames: Vec<Frame>,
    /// the beatmap's own combo colours (empty: the skin's)
    pub colours: Vec<[u8; 3]>,
    pub slider_border: Option<[u8; 3]>,
    pub slider_track: Option<[u8; 3]>,
}

#[derive(Clone, Copy)]
struct TimingPoint {
    time: f64,
    beat_len: f64,
}

#[derive(Clone, Copy)]
struct DifficultyPoint {
    time: f64,
    sv: f64,
    ticks: bool,
}

struct Line {
    time: f64,
    beat_len: f64,
    red: bool,
}

#[derive(PartialEq)]
enum Section {
    Other,
    General,
    Difficulty,
    Events,
    TimingPoints,
    Colours,
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

fn at<T: Copy>(points: &[T], t: f64, time: impl Fn(&T) -> f64) -> Option<T> {
    let i = points.partition_point(|p| time(p) <= t);
    (i > 0).then(|| points[i - 1])
}

fn colour(v: &str) -> Option<[u8; 3]> {
    let c: Vec<u8> = v.split(',').map(|p| p.trim().parse::<i64>().ok().map(|n| n.clamp(0, 255) as u8)).collect::<Option<_>>()?;
    (c.len() >= 3).then(|| [c[0], c[1], c[2]])
}

/// What a beatmap's objects are before osu!'s own steps (combo numbers, stacking, autoplay), for
/// the rulesets that start from them (osu!catch).
pub(crate) struct Raw {
    pub version: i32,
    pub cs: f32,
    pub od: f32,
    pub ar: f32,
    pub stack_leniency: f32,
    /// by time, a new combo after every break
    pub objects: Vec<Object>,
    pub colours: Vec<[u8; 3]>,
    pub slider_border: Option<[u8; 3]>,
    pub slider_track: Option<[u8; 3]>,
}

/// An osu! difficulty for the playfield, `None` for other rulesets.
pub fn parse(text: &str) -> Option<Chart> {
    let Raw { version, cs, od, ar, stack_leniency, mut objects, colours, slider_border, slider_track } = read(text, 0)?;
    let scale = ((1.0f32 - 0.7f32 * ((cs as f64 - 5.0) / 5.0) as f32) / 2.0) * 1.00041;
    let preempt = difficulty_range(ar as f64, 1800.0, 1200.0, 450.0) as i32 as f64;
    let fade_in = 400.0 * (preempt / 450.0).min(1.0);

    // spinners: spins to clear, bonus spins (Spinner.ApplyDefaultsToSelf)
    for o in objects.iter_mut().filter(|o| o.kind == Kind::Spinner) {
        let min_rps = difficulty_range(od as f64, 90.0, 150.0, 225.0) / 60.0;
        let max_rps = difficulty_range(od as f64, 250.0, 380.0, 430.0) / 60.0;
        let seconds = (o.end - o.time) / 1000.0;
        o.spins = (min_rps * seconds + 0.0001) as u32;
        o.bonus_spins = (((max_rps * seconds + 0.0001) as i64) - o.spins as i64 - BONUS_SPINS_GAP as i64).max(0) as u32;
    }

    combos(&mut objects);
    stacking(&mut objects, version, preempt, stack_leniency);
    let frames = autoplay(&objects, scale, preempt);
    Some(Chart { scale, preempt, fade_in, objects, frames, colours, slider_border, slider_track })
}

/// A beatmap made for ruleset `want` (0 osu!, 2 osu!catch) read into osu!'s objects.
pub(crate) fn read(text: &str, want: i64) -> Option<Raw> {
    let text = text.trim_start_matches('\u{feff}');
    let version = text
        .lines()
        .next()
        .and_then(|l| l.trim().strip_prefix("osu file format v"))
        .and_then(|v| v.trim().parse::<i32>().ok())
        .unwrap_or(14);
    let offset = if version < 5 { EARLY_VERSION_TIMING_OFFSET } else { 0.0 };
    let mut mode = 0i64;
    let mut stack_leniency = 0.7f32;
    let mut cs = 5.0f32;
    let mut od = 5.0f32;
    let mut ar: Option<f32> = None;
    let mut slider_multiplier = 1.4f64;
    let mut tick_rate = 1.0f64;
    let mut lines: Vec<Line> = Vec::new();
    let mut breaks: Vec<(f64, f64)> = Vec::new();
    let mut colours: Vec<[u8; 3]> = Vec::new();
    let mut slider_border = None;
    let mut slider_track = None;
    let mut raw: Vec<&str> = Vec::new();

    let mut section = Section::Other;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("//") {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = match name {
                "General" => Section::General,
                "Difficulty" => Section::Difficulty,
                "Events" => Section::Events,
                "TimingPoints" => Section::TimingPoints,
                "Colours" => Section::Colours,
                "HitObjects" => Section::HitObjects,
                _ => Section::Other,
            };
            continue;
        }
        match section {
            Section::General | Section::Difficulty | Section::Colours => {
                let Some((key, value)) = line.split_once(':') else { continue };
                let (key, value) = (key.trim(), value.trim());
                match (&section, key) {
                    (Section::General, "Mode") => mode = value.parse().unwrap_or(0),
                    (Section::General, "StackLeniency") => stack_leniency = value.parse().unwrap_or(stack_leniency),
                    (Section::Difficulty, "CircleSize") => cs = value.parse().unwrap_or(cs),
                    (Section::Difficulty, "OverallDifficulty") => od = value.parse().unwrap_or(od),
                    (Section::Difficulty, "ApproachRate") => ar = value.parse().ok(),
                    (Section::Difficulty, "SliderMultiplier") => slider_multiplier = value.parse().unwrap_or(slider_multiplier),
                    (Section::Difficulty, "SliderTickRate") => tick_rate = value.parse().unwrap_or(tick_rate),
                    (Section::Colours, "SliderBorder") => slider_border = colour(value),
                    (Section::Colours, "SliderTrackOverride") => slider_track = colour(value),
                    (Section::Colours, k) => {
                        // Combo1 … Combo8, in the file's order
                        if k.strip_prefix("Combo").and_then(|n| n.parse::<u32>().ok()).is_some_and(|n| (1..=8).contains(&n)) {
                            if let Some(c) = colour(value) {
                                colours.push(c);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Section::Events => {
                let mut f = line.split(',');
                if matches!(f.next().map(str::trim), Some("2" | "Break")) {
                    if let (Some(s), Some(e)) = (num(f.next()), num(f.next())) {
                        breaks.push((s + offset, e + offset));
                    }
                }
            }
            Section::TimingPoints => {
                let f: Vec<&str> = line.split(',').map(str::trim).collect();
                let Some(time) = num(f.first().copied()) else { continue };
                let Some(beat_len) = f.get(1).and_then(|v| v.parse::<f64>().ok()) else { continue };
                if beat_len.is_infinite() {
                    continue;
                }
                let red = f.get(6).map_or(true, |v| v.starts_with('1'));
                if red && beat_len.is_nan() {
                    continue;
                }
                lines.push(Line { time: time + offset, beat_len, red });
            }
            Section::HitObjects => raw.push(line),
            Section::Other => {}
        }
    }
    if mode != want {
        return None;
    }
    // LegacyBeatmapDecoder.applyDifficultyRestrictions
    let cs = cs.clamp(0.0, 10.0);
    let od = od.clamp(0.0, 10.0);
    let ar = ar.unwrap_or(od).clamp(0.0, 10.0);
    let slider_multiplier = slider_multiplier.clamp(0.4, 3.6);
    let tick_rate = tick_rate.clamp(0.5, 8.0);
    breaks.sort_by(|a, b| a.0.total_cmp(&b.0));

    // control points, a time at a time: the first red line is the timing, the last green line
    // (else that red line) the velocity
    let mut timing: Vec<TimingPoint> = Vec::new();
    let mut difficulty: Vec<DifficultyPoint> = Vec::new();
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));
    let mut i = 0;
    while i < lines.len() {
        let mut j = i;
        while j < lines.len() && lines[j].time == lines[i].time {
            j += 1;
        }
        let group = &lines[i..j];
        let red = group.iter().find(|l| l.red);
        if let Some(r) = red {
            timing.push(TimingPoint { time: r.time, beat_len: r.beat_len.clamp(6.0, 60000.0) });
        }
        if let Some(l) = group.iter().rev().find(|l| !l.red).or(red) {
            let sv = if l.beat_len < 0.0 { 100.0 / -l.beat_len } else { 1.0 };
            difficulty.push(DifficultyPoint { time: l.time, sv: sv.clamp(0.1, 10.0), ticks: !l.beat_len.is_nan() });
        }
        i = j;
    }
    let timing_at = |t: f64| at(&timing, t, |p| p.time).or(timing.first().copied()).map_or(1000.0, |p| p.beat_len);
    let difficulty_at = |t: f64| at(&difficulty, t, |p| p.time).unwrap_or(DifficultyPoint { time: 0.0, sv: 1.0, ticks: true });

    // hit objects, then ordered by time (stable, like OrderBy)
    let mut objects: Vec<Object> = Vec::new();
    let mut last_spinner = false;
    for line in raw {
        let first = objects.is_empty();
        if let Some(o) = object(line, version, offset, first, last_spinner, slider_multiplier, tick_rate, &timing_at, &difficulty_at) {
            last_spinner = o.kind == Kind::Spinner;
            objects.push(o);
        }
    }
    objects.sort_by(|a, b| a.time.total_cmp(&b.time));

    // a new combo after every break (postProcessBreaks)
    let mut b = 0;
    for o in objects.iter_mut() {
        let mut force = false;
        while b < breaks.len() && breaks[b].1 < o.time {
            force = true;
            b += 1;
        }
        o.new_combo |= force;
    }

    Some(Raw { version, cs, od, ar, stack_leniency, objects, colours, slider_border, slider_track })
}

/// Parses `normalSet:additionSet:index:volume:filename` into `s` (`ConvertHitObjectParser.readCustomSampleBanks`).
fn read_banks(v: &str, s: &mut Sounds, banks_only: bool) {
    if v.is_empty() {
        return;
    }
    let f: Vec<&str> = v.split(':').collect();
    s.normal_set = f.first().map_or(0, |v| int(v));
    s.addition_set = f.get(1).map_or(0, |v| int(v));
    if banks_only {
        return;
    }
    if let Some(v) = f.get(2) {
        s.index = int(v);
    }
    if let Some(v) = f.get(3) {
        s.volume = int(v).max(0);
    }
    s.file = f.get(4).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
}

#[allow(clippy::too_many_arguments)]
fn object(
    line: &str,
    version: i32,
    offset: f64,
    first: bool,
    after_spinner: bool,
    slider_multiplier: f64,
    tick_rate: f64,
    timing_at: &impl Fn(f64) -> f64,
    difficulty_at: &impl Fn(f64) -> DifficultyPoint,
) -> Option<Object> {
    let f: Vec<&str> = line.split(',').collect();
    let coord = |v: Option<&str>| -> Option<f32> {
        let n = v?.trim().parse::<f64>().ok().filter(|n| n.is_finite() && n.abs() <= MAX_COORDINATE)?;
        Some(n as f32)
    };
    let (x, y) = (coord(f.first().copied())?.clamp(0.0, 512.0), coord(f.get(1).copied())?.clamp(0.0, 512.0));
    let pos = if version >= FIRST_LAZER_VERSION { Vec2::new(x, y) } else { Vec2::new(x.trunc(), y.trunc()) };
    let time = num(f.get(2).copied())? + offset;
    let ty = int(f.get(3)?);
    let combo_offset = ((ty & 112) >> 4) as i32;
    let new_combo_flag = ty & 4 != 0;
    let sound = f.get(4).map_or(0, |v| int(v));
    let mut base = Sounds { sound, ..Sounds::default() };

    let mut o = Object {
        kind: Kind::Circle,
        time,
        end: time,
        pos,
        stack: 0,
        new_combo: first || after_spinner || new_combo_flag,
        combo_offset: if new_combo_flag { combo_offset } else { 0 },
        combo_index: 0,
        colour: 0,
        index_in_combo: 0,
        last_in_combo: false,
        slider: None,
        spins: 0,
        bonus_spins: 0,
        sounds: Vec::new(),
    };

    if ty & 1 != 0 {
        if let Some(v) = f.get(5) {
            read_banks(v, &mut base, false);
        }
        base.time = time;
        base.point_time = time + 5.0;
        o.sounds.push(base);
    } else if ty & 2 != 0 {
        let repeats = f.get(6).map_or(0, |v| int(v));
        if repeats > 9000 {
            return None;
        }
        let mut repeats = (repeats - 1).max(0) as u32;
        let length = num(f.get(7).copied()).map(|l| l.max(0.0)).filter(|&l| l != 0.0 && l <= MAX_COORDINATE);
        if let Some(v) = f.get(10) {
            read_banks(v, &mut base, true);
        }
        let control = path_points(f.get(5)?, pos, version)?;
        let path = Path::new(&control, length);

        // per-node sounds: edgeSounds and edgeSets, else the slider's own
        let mut nodes = (repeats + 2) as usize;
        let sets: Vec<&str> = f.get(9).filter(|v| !v.is_empty()).map(|v| v.split('|').collect()).unwrap_or_default();
        let adds: Vec<&str> = f.get(8).filter(|v| !v.is_empty()).map(|v| v.split('|').collect()).unwrap_or_default();
        let mut node_sounds: Vec<Sounds> = (0..nodes)
            .map(|i| {
                let mut s = base.clone();
                if let Some(v) = sets.get(i) {
                    read_banks(v, &mut s, false);
                }
                if let Some(v) = adds.get(i) {
                    s.sound = v.trim().parse::<i64>().unwrap_or(0);
                }
                s
            })
            .collect();
        // zero-length sliders with repeats lose them (lazer's guard against a stable exploit)
        if almost_f64(path.distance(), 0.0) {
            repeats = 0;
            let last = node_sounds.pop().unwrap_or_default();
            node_sounds.truncate(1);
            node_sounds.push(last);
            nodes = 2;
        }
        let spans = repeats + 1;

        // Slider.ApplyDefaultsToSelf
        let beat_len = timing_at(time);
        let d = difficulty_at(time);
        let sv_beat_len = -100.0 / d.sv;
        let bpm_multiplier = if sv_beat_len < 0.0 { ((-sv_beat_len) as f32).clamp(10.0, 1000.0) as f64 / 100.0 } else { 1.0 };
        let velocity = 100.0 * slider_multiplier / (beat_len * bpm_multiplier);
        let scoring_distance = velocity * beat_len;
        // before v8, a faster slider velocity doesn't spread its ticks further apart
        let tick_multiplier = if version < 8 { 1.0 / d.sv } else { 1.0 };
        let tick_distance = if d.ticks { scoring_distance / tick_rate * tick_multiplier } else { f64::INFINITY };
        let distance = path.distance();
        let end = time + spans as f64 * distance / velocity;
        let span_duration = (end - time) / spans as f64;

        // SliderEventGenerator: ticks (repeat spans' in time order)
        let mut ticks = Vec::new();
        let length = distance.min(100_000.0);
        let tick_distance = tick_distance.clamp(0.0, length);
        let min_from_end = velocity * 10.0;
        if tick_distance != 0.0 {
            for span in 0..spans {
                let span_start = time + span as f64 * span_duration;
                let reversed = span % 2 == 1;
                let mut span_ticks = Vec::new();
                let mut dist = tick_distance;
                while dist <= length && span_ticks.len() < 10_000 {
                    if dist >= length - min_from_end {
                        break;
                    }
                    let progress = dist / length;
                    let time_progress = if reversed { 1.0 - progress } else { progress };
                    span_ticks.push((span_start + time_progress * span_duration, progress));
                    dist += tick_distance;
                }
                if reversed {
                    span_ticks.reverse();
                }
                ticks.extend(span_ticks);
            }
        }

        // node sounds: at the head, every repeat and the tail, each with the sample point of
        // its own time
        for (i, s) in node_sounds.iter_mut().enumerate() {
            s.time = if i + 1 == nodes { end } else { time + i as f64 * span_duration };
            s.point_time = time + i as f64 * (end - time) / spans as f64 + 5.0;
        }
        base.time = time;
        base.point_time = time + 6.0;

        o.kind = Kind::Slider;
        o.end = end;
        o.sounds = node_sounds;
        o.slider = Some(Slider { path, spans, span_duration, ticks, main: base });
    } else if ty & 8 != 0 {
        let end = num(f.get(5).copied()).map_or(time, |e| e + offset).max(time);
        if let Some(v) = f.get(6) {
            read_banks(v, &mut base, false);
        }
        base.time = end;
        base.point_time = end + 5.0;
        o.kind = Kind::Spinner;
        o.end = end;
        o.pos = SPINNER_CENTRE;
        o.new_combo = new_combo_flag;
        o.combo_offset = 0;
        o.sounds.push(base);
    } else {
        return None;
    }
    Some(o)
}

/// `ConvertHitObjectParser.convertPathString`: control points relative to the slider's position.
fn path_points(text: &str, pos: Vec2, version: i32) -> Option<Vec<ControlPoint>> {
    let mut points: Vec<Vec2> = Vec::new();
    let mut segments: Vec<(PathType, usize)> = Vec::new();
    for s in text.split('|') {
        let first = s.chars().next()?;
        if first.is_alphabetic() {
            let ty = match first {
                'B' => match s[first.len_utf8()..].parse::<i32>() {
                    Ok(d) if d > 0 => PathType::BSpline(Some(d)),
                    _ => BEZIER,
                },
                'L' => PathType::Linear,
                'P' => PathType::PerfectCurve,
                _ => PathType::Catmull,
            };
            segments.push((ty, points.len()));
            // the first segment starts at the slider's own position
            if points.is_empty() {
                points.push(Vec2::default());
            }
        } else {
            let mut v = s.split(':');
            let mut coord = || -> Option<f32> {
                let n = v.next()?.trim().parse::<f64>().ok().filter(|n| n.is_finite() && n.abs() <= MAX_COORDINATE)? as f32;
                Some(if version >= FIRST_LAZER_VERSION { n } else { n.trunc() })
            };
            let p = Vec2::new(coord()?, coord()?);
            points.push(p - pos);
        }
    }
    let mut out = Vec::new();
    for (i, &(ty, start)) in segments.iter().enumerate() {
        let (slice, end_point) = match segments.get(i + 1) {
            Some(&(_, next)) => (points.get(start..next)?, points.get(next).copied()),
            None => (points.get(start..)?, None),
        };
        convert_points(ty, slice, end_point, version, &mut out)?;
    }
    Some(out)
}

/// `ConvertHitObjectParser.convertPoints`: a segment's points, split where a point repeats
/// (an implicit new segment of the same type).
fn convert_points(mut ty: PathType, points: &[Vec2], end_point: Option<Vec2>, version: i32, out: &mut Vec<ControlPoint>) -> Option<()> {
    let mut v: Vec<ControlPoint> = points.iter().map(|&pos| ControlPoint { pos, ty: None }).collect();
    if v.is_empty() {
        return None;
    }
    if ty == PathType::PerfectCurve {
        let with_end = v.len() + end_point.is_some() as usize;
        if version < FIRST_LAZER_VERSION {
            if with_end != 3 {
                ty = BEZIER;
            } else {
                let (p0, p1, p2) = (points[0], points[1], end_point.unwrap_or_else(|| points[2]));
                // stable drew straight "perfect curves" as lines
                if almost_f32(0.0, (p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y)) {
                    ty = PathType::Linear;
                }
            }
        } else if with_end > 3 {
            ty = BEZIER;
        }
    }
    v[0].ty = Some(ty);
    let mut start = 0;
    let mut end = 0;
    loop {
        end += 1;
        if end >= v.len() {
            break;
        }
        if v[end].pos != v[end - 1].pos {
            continue;
        }
        // old Catmull sliders are one segment
        if ty == PathType::Catmull && end > 1 && version < FIRST_LAZER_VERSION {
            continue;
        }
        if end == v.len() - 1 {
            continue;
        }
        v[end - 1].ty = Some(ty);
        out.extend_from_slice(&v[start..end]);
        start = end + 1;
    }
    if start < end {
        out.extend_from_slice(&v[start..end]);
    }
    Some(())
}

/// `BeatmapProcessor.PreProcess` + `OsuHitObject.UpdateComboInformation`.
fn combos(objects: &mut [Object]) {
    let mut last: Option<usize> = None;
    // the first object and the first after a spinner start a combo
    for i in 0..objects.len() {
        if objects[i].kind != Kind::Spinner && last.map_or(true, |l| objects[l].kind == Kind::Spinner) {
            objects[i].new_combo = true;
        }
        last = Some(i);
    }
    let mut last: Option<usize> = None;
    for i in 0..objects.len() {
        let (mut index, mut with_offsets, mut in_combo) = match last {
            Some(l) => (objects[l].combo_index, objects[l].colour, objects[l].index_in_combo + 1),
            None => (0, 0, 0),
        };
        let o = &objects[i];
        if o.kind != Kind::Spinner && (o.new_combo || last.map_or(true, |l| objects[l].kind == Kind::Spinner)) {
            in_combo = 0;
            index += 1;
            with_offsets += o.combo_offset + 1;
            if let Some(l) = last {
                objects[l].last_in_combo = true;
            }
        }
        let o = &mut objects[i];
        o.combo_index = index;
        o.colour = with_offsets;
        o.index_in_combo = in_combo;
        last = Some(i);
    }
}

/// `OsuBeatmapProcessor.ApplyStacking`
fn stacking(objects: &mut [Object], version: i32, preempt: f64, leniency: f32) {
    if objects.is_empty() {
        return;
    }
    let threshold = (preempt as i32) as f32 * leniency;
    if version >= 6 {
        stacking_new(objects, threshold);
    } else {
        stacking_old(objects, threshold);
    }
}

fn stacking_new(h: &mut [Object], threshold: f32) {
    let threshold = threshold as f64;
    let end_index = h.len() - 1;
    // (the extension of the range to later objects only matters when updating part of a map)
    for i in (1..=end_index).rev() {
        let mut n = i;
        if h[i].stack != 0 || h[i].kind == Kind::Spinner {
            continue;
        }
        let mut obj_i = i;
        if h[i].kind == Kind::Circle {
            while n > 0 {
                n -= 1;
                if h[n].kind == Kind::Spinner {
                    continue;
                }
                // whole milliseconds, as stable
                if (h[obj_i].time as i64 - h[n].end as i64) as f64 > threshold {
                    break;
                }
                // a slider under the circles: they stack down and right from its end
                if h[n].kind == Kind::Slider && h[n].end_pos().distance(h[obj_i].pos) < STACK_DISTANCE {
                    let offset = h[obj_i].stack - h[n].stack + 1;
                    let end = h[n].end_pos();
                    for j in n + 1..=i {
                        if end.distance(h[j].pos) < STACK_DISTANCE {
                            h[j].stack -= offset;
                        }
                    }
                    break;
                }
                if h[n].pos.distance(h[obj_i].pos) < STACK_DISTANCE {
                    h[n].stack = h[obj_i].stack + 1;
                    obj_i = n;
                }
            }
        } else if h[i].kind == Kind::Slider {
            while n > 0 {
                n -= 1;
                if h[n].kind == Kind::Spinner {
                    continue;
                }
                if h[obj_i].time - h[n].time > threshold {
                    break;
                }
                if h[n].end_pos().distance(h[obj_i].pos) < STACK_DISTANCE {
                    h[n].stack = h[obj_i].stack + 1;
                    obj_i = n;
                }
            }
        }
    }
}

fn stacking_old(h: &mut [Object], threshold: f32) {
    let threshold = threshold as f64;
    for i in 0..h.len() {
        if h[i].stack != 0 && h[i].kind != Kind::Slider {
            continue;
        }
        let mut start = h[i].end;
        let mut slider_stack = 0;
        for j in i + 1..h.len() {
            if h[j].time - threshold > start {
                break;
            }
            // the end of a slider's path, whatever its repeats
            let end = match &h[i].slider {
                Some(s) => h[i].pos + s.path.position_at(1.0),
                None => h[i].pos,
            };
            if h[j].pos.distance(h[i].pos) < STACK_DISTANCE {
                h[i].stack += 1;
                start = h[j].time;
            } else if h[j].pos.distance(end) < STACK_DISTANCE {
                slider_stack += 1;
                h[j].stack -= slider_stack;
                start = h[j].time;
            }
        }
    }
}

// ── autoplay ───────────────────────────────────────────────────────────────

/// A replay frame while it's built: its buttons are a list it may share with other frames (as
/// lazer's do, which matters when a later object changes them).
#[derive(Clone, Copy)]
struct Building {
    time: f64,
    pos: Vec2,
    list: usize,
    key_up: bool,
}

struct Replay {
    frames: Vec<Building>,
    lists: Vec<u8>,
}

impl Replay {
    fn list(&mut self, buttons: u8) -> usize {
        self.lists.push(buttons);
        self.lists.len() - 1
    }
    /// `FindInsertionIndex`: after every frame at the same time.
    fn insertion(&self, time: f64) -> usize {
        self.frames.partition_point(|f| f.time <= time)
    }
    fn add(&mut self, f: Building) {
        let i = self.insertion(f.time);
        self.frames.insert(i, f);
    }
}

/// `Interpolation.ValueAt` for positions, with lazer's Out / In easings.
fn ease(time: f64, a: Vec2, b: Vec2, start: f64, end: f64, ease_in: bool) -> Vec2 {
    let current = (time - start) as f32;
    let duration = (end - start) as f32;
    if duration == 0.0 || current == 0.0 {
        return a;
    }
    let t = (current / duration) as f64;
    let t = if ease_in { t * t } else { t * (2.0 - t) } as f32;
    a + (b - a) * t
}

/// `OsuAutoGenerator.Generate` (no mods).
fn autoplay(objects: &[Object], scale: f32, preempt: f64) -> Vec<Frame> {
    let mut r = Replay { frames: Vec::new(), lists: Vec::new() };
    let Some(first) = objects.first() else { return Vec::new() };
    let l = r.list(0);
    r.add(Building { time: first.time - 1500.0, pos: Vec2::new(256.0, 500.0), list: l, key_up: false });
    let mut button = 0u32;
    for h in objects {
        let stacked = h.pos + h.stack_offset(scale);
        let mut start_pos = stacked;
        let mut ease_in = false;
        let mut direction = -1.0f32;
        if h.kind == Kind::Spinner {
            // spinners with nothing to spin finish themselves
            if h.spins == 0 {
                continue;
            }
            let prev = r.frames.last().map_or(SPINNER_CENTRE, |f| f.pos);
            (start_pos, direction) = spinner_start(prev);
            if (SPINNER_CENTRE - prev).length() > SPIN_RADIUS {
                ease_in = true;
            }
        }
        move_to(&mut r, h, start_pos, ease_in, preempt, &mut button);
        click(&mut r, h, start_pos, direction, button, scale);
    }
    r.frames.iter().map(|f| Frame { time: f.time, pos: f.pos, buttons: r.lists[f.list] }).collect()
}

/// `calcSpinnerStartPosAndDirection`
fn spinner_start(prev: Vec2) -> (Vec2, f32) {
    let mut offset = SPINNER_CENTRE - prev;
    let dist = offset.length();
    let to_tangent = (dist * dist - SPIN_RADIUS * SPIN_RADIUS).sqrt();
    if dist > SPIN_RADIUS {
        let angle = (SPIN_RADIUS / dist).asin();
        let direction = if angle > 0.0 { -1.0 } else { 1.0 };
        // rotated so it's parallel to the tangent (Y uses the new X, as lazer's does)
        offset.x = offset.x * angle.cos() - offset.y * angle.sin();
        offset.y = offset.x * angle.sin() + offset.y * angle.cos();
        offset = offset.normalized() * to_tangent;
        (prev + offset, direction)
    } else if offset.length() > 0.0 {
        (SPINNER_CENTRE - offset * (SPIN_RADIUS / offset.length()), 1.0)
    } else {
        (SPINNER_CENTRE + Vec2::new(0.0, -SPIN_RADIUS), 1.0)
    }
}

/// `moveToHitObject`
fn move_to(r: &mut Replay, h: &Object, target: Vec2, ease_in: bool, preempt: f64, button: &mut u32) {
    let n = r.frames.len();
    let mut last = r.frames[n - 1];
    // react 100 ms after it appears
    let wait = h.time - (preempt - 100.0).max(0.0);
    let mut waited = false;
    if wait > last.time {
        last = Building { time: wait, pos: last.pos, list: last.list, key_up: false };
        waited = true;
        r.add(last);
    }
    let difference = h.time - last.time;
    if difference >= 0.0 {
        if !waited && last.key_up && n >= 2 {
            // start moving right away from where the eased move would be by now
            let ll = r.frames[n - 2];
            last.pos = ease(last.time, last.pos, target, ll.time, h.time, ease_in);
            r.frames[n - 1].pos = last.pos;
        }
        let from = last.pos;
        let mut time = last.time + FRAME_DELAY;
        while time < h.time {
            let pos = ease(time, from, target, last.time, h.time, ease_in);
            r.add(Building { time: (time as i64) as f64, pos, list: last.list, key_up: false });
            time += FRAME_DELAY;
        }
    }
    // alternate once objects come faster than ~225 BPM
    if difference >= 0.0 && difference < MIN_FRAME_SEPARATION_FOR_ALTERNATING {
        *button += 1;
    } else {
        *button = 0;
    }
}

/// `addHitObjectClickFrames`
fn click(r: &mut Replay, h: &Object, start_pos: Vec2, direction: f32, button: u32, scale: f32) {
    let mut action = if button % 2 == 0 { LEFT } else { RIGHT };
    let start_list = r.list(action);
    let start = Building { time: h.time, pos: start_pos, list: start_list, key_up: false };
    let stacked_end = h.end_pos() + h.stack_offset(scale);
    let end_delay = if h.kind == Kind::Spinner { 1.0 } else { 0.0 };
    let end_list = r.list(0);
    let mut end = Building { time: h.end + KEY_UP_DELAY + end_delay, pos: stacked_end, list: end_list, key_up: true };

    let index = r.insertion(start.time) as isize - 1;
    if index >= 0 {
        let index = index as usize;
        let previous_list = r.frames[index].list;
        let previous = r.lists[previous_list];
        if previous != 0 {
            // a button is held: use the other one
            if previous & action != 0 {
                action = if action == LEFT { RIGHT } else { LEFT };
                r.lists[start_list] = action;
            }
            // follow the newest slider / spinner: drop what the older one had until this ends
            let end_index = r.insertion(end.time);
            if index < r.frames.len() - 1 {
                let to = end_index.max(index + 1).min(r.frames.len());
                r.frames.drain(index + 1..to);
            }
            let count = r.frames.len();
            for j in index + 1..count {
                let list = r.frames[j].list;
                // (compared with the held frame's buttons as they are now: frames share lists)
                if j < count - 1 || r.lists[list] == r.lists[previous_list] {
                    r.lists[list] = action;
                }
            }
        }
    }
    r.add(start);

    match h.kind {
        Kind::Spinner => {
            // 0.05 rad/ms (about 477 RPM), as stable
            let spin_rpm = 0.05f32 / (2.0 * std::f32::consts::PI) * 60000.0;
            let rads_per_ms = (spin_rpm * 360.0).to_radians() / 60000.0;
            let diff = start_pos - SPINNER_CENTRE;
            let radius = diff.length();
            let mut angle = if radius == 0.0 { 0.0 } else { diff.y.atan2(diff.x) };
            let mut previous = h.time;
            let mut next = h.time + FRAME_DELAY;
            while next < h.end {
                let t = (next - previous) * direction as f64;
                angle += t as f32 * rads_per_ms;
                let pos = SPINNER_CENTRE + circle(angle as f64, SPIN_RADIUS as f64);
                let list = r.list(action);
                r.add(Building { time: (next as i64) as f64, pos, list, key_up: false });
                previous = next;
                next += FRAME_DELAY;
            }
            let t = (h.end - previous) * direction as f64;
            angle += t as f32 * rads_per_ms;
            let pos = SPINNER_CENTRE + circle(angle as f64, SPIN_RADIUS as f64);
            let list = r.list(action);
            r.add(Building { time: h.end, pos, list, key_up: false });
            end.pos = pos;
        }
        Kind::Slider => {
            let duration = h.end - h.time;
            let stacked = h.pos + h.stack_offset(scale);
            let mut j = FRAME_DELAY;
            while j < duration {
                let pos = stacked + h.curve_at(j / duration);
                let list = r.list(action);
                r.add(Building { time: h.time + j, pos, list, key_up: false });
                j += FRAME_DELAY;
            }
            let list = r.list(action);
            r.add(Building { time: h.end, pos: stacked_end, list, key_up: false });
        }
        Kind::Circle => {}
    }
    // let go only if nothing later is still going on
    if r.frames.last().is_some_and(|f| f.time <= end.time) {
        r.add(end);
    }
}

fn circle(t: f64, radius: f64) -> Vec2 {
    Vec2::new((t.cos() * radius) as f32, (t.sin() * radius) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "osu file format v14\n[General]\nMode: 0\nStackLeniency: 0.7\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\nApproachRate:9\nSliderMultiplier:1.4\nSliderTickRate:1\n";

    fn close(a: Vec2, b: (f32, f32)) -> bool {
        (a.x - b.0).abs() < 0.01 && (a.y - b.1).abs() < 0.01
    }

    #[test]
    fn linear_slider_length_ticks_and_end() {
        let text = format!("{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,100,1000,2,0,L|300:100,2,280\n");
        let c = parse(&text).unwrap();
        let o = &c.objects[0];
        let s = o.slider.as_ref().unwrap();
        // 200 px drawn, stretched to 280 along its direction
        assert_eq!(s.path.distance(), 280.0);
        assert!(close(o.end_pos(), (100.0, 100.0)), "two spans end at the head: {:?}", o.end_pos());
        assert!(close(o.pos + s.path.position_at(1.0), (380.0, 100.0)));
        // 280 px at 140 px a beat = 2 beats a span
        assert_eq!(s.span_duration, 1000.0);
        assert_eq!(o.end, 3000.0);
        // a tick per beat, not within 10 ms of the end; the reversed span's in time order
        assert_eq!(s.ticks, vec![(1500.0, 0.5), (2500.0, 0.5)]);
        assert_eq!(o.sounds.iter().map(|s| s.time).collect::<Vec<_>>(), vec![1000.0, 2000.0, 3000.0]);
    }

    #[test]
    fn perfect_circle_and_bezier_paths() {
        // a half circle from (0,0) over (100,100) to (200,0), relative: radius 100
        let text = format!("{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,200,0,2,0,P|200:300|300:200,1,314.159\n100,200,2000,2,0,B|200:100|300:200,1,0\n");
        let c = parse(&text).unwrap();
        let arc = &c.objects[0];
        let mid = arc.pos + arc.slider.as_ref().unwrap().path.position_at(0.5);
        // (the arc's chords sit up to 0.1 px inside it, and the length given is a bit longer)
        assert!((mid.x - 200.0).abs() < 0.1 && (mid.y - 300.0).abs() < 0.2, "{mid:?}");
        // a Bézier with no length given: its own; symmetric, so its middle is the apex at y=150
        let bez = &c.objects[1];
        let p = bez.slider.as_ref().unwrap();
        assert!((p.path.distance() - 229.5).abs() < 1.0, "{}", p.path.distance());
        let mid = bez.pos + p.path.position_at(0.5);
        assert!(close(mid, (200.0, 150.0)), "{mid:?}");
    }

    #[test]
    fn implicit_segments_and_old_perfect_curves() {
        // a repeated point starts a new segment; v13 "perfect curves" through a line are lines
        let text = "osu file format v13\n[General]\nMode: 0\n[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n0,0,0,2,0,B|100:0|100:0|100:100,1,200\n0,0,1000,2,0,P|50:0|100:0,1,100\n";
        let c = parse(text).unwrap();
        let s = c.objects[0].slider.as_ref().unwrap();
        assert!(close(s.path.position_at(0.5), (100.0, 0.0)));
        assert!(close(s.path.position_at(1.0), (100.0, 100.0)));
        let s = c.objects[1].slider.as_ref().unwrap();
        assert!(close(s.path.position_at(0.5), (50.0, 0.0)));
    }

    #[test]
    fn combos_and_colours() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n\
             10,10,0,1,0\n20,20,100,1,0\n30,30,200,5,0\n40,40,300,37,0\n256,192,400,12,0,800\n50,50,1000,1,0\n60,60,1100,1,0\n"
        );
        let c = parse(&text).unwrap();
        let got: Vec<(i32, i32, i32)> = c.objects.iter().map(|o| (o.combo_index, o.colour, o.index_in_combo)).collect();
        assert_eq!(
            got,
            vec![
                // the first object starts a combo (colour index 1: lazer starts at the second colour)
                (1, 1, 0),
                (1, 1, 1),
                (2, 2, 0),
                // new combo skipping 2 colours: +3
                (3, 5, 0),
                // spinners keep the combo
                (3, 5, 1),
                // after a spinner: a new combo
                (4, 6, 0),
                (4, 6, 1),
            ]
        );
        assert!(c.objects[2].new_combo && !c.objects[1].new_combo && c.objects[1].last_in_combo);
    }

    #[test]
    fn stacking_new_and_old() {
        let body = "[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n100,100,0,1,0\n100,100,100,1,0\n100,100,200,1,0\n300,300,5000,1,0\n";
        let c = parse(&format!("{HEAD}{body}")).unwrap();
        assert_eq!(c.objects.iter().map(|o| o.stack).collect::<Vec<_>>(), vec![2, 1, 0, 0]);
        let old = format!("osu file format v5\n[General]\nMode: 0\n{body}");
        let c = parse(&old).unwrap();
        assert_eq!(c.objects.iter().map(|o| o.stack).collect::<Vec<_>>(), vec![2, 1, 0, 0]);
        // offset by 6.4 px × scale per level, up and left
        let off = c.objects[0].stack_offset(c.scale);
        assert!((off.x - (-12.8 * c.scale)).abs() < 1e-4);
    }

    #[test]
    fn approach_and_size() {
        let c = parse(&format!("{HEAD}[HitObjects]\n0,0,0,1,0\n")).unwrap();
        // AR 9: 1200 - 750 × 0.8; CS 4: 0.57
        assert_eq!(c.preempt, 600.0);
        assert_eq!(c.fade_in, 400.0);
        assert!((c.scale - 0.57 * 1.00041).abs() < 1e-5);
        // AR defaults to OD
        let c = parse("osu file format v14\n[General]\nMode: 0\n[Difficulty]\nOverallDifficulty:10\n[HitObjects]\n0,0,0,1,0\n").unwrap();
        assert_eq!(c.preempt, 450.0);
    }

    #[test]
    fn autoplay_clicks_follows_and_alternates() {
        let text = format!(
            "{HEAD}[TimingPoints]\n0,500,4,1,0,100,1,0\n[HitObjects]\n\
             100,100,1000,1,0\n200,100,1100,1,0\n300,100,1200,1,0\n100,300,3000,2,0,L|300:300,1,140\n256,192,6000,12,0,8000\n"
        );
        let c = parse(&text).unwrap();
        let pos_at = |t: f64| {
            let i = c.frames.partition_point(|f| f.time <= t) - 1;
            c.frames[i]
        };
        // presses on every circle, alternating under 266 ms apart
        assert_eq!((pos_at(1000.0).buttons, pos_at(1100.0).buttons, pos_at(1200.0).buttons), (LEFT, RIGHT, LEFT));
        assert!(close(pos_at(1000.0).pos, (100.0, 100.0)) && close(pos_at(1200.0).pos, (300.0, 100.0)));
        // released 50 ms after
        assert_eq!(pos_at(1260.0).buttons, 0);
        // the slider: held, the cursor halfway at half its length
        let half = pos_at(3250.0);
        assert_eq!(half.buttons, LEFT);
        assert!((half.pos.x - 168.0).abs() < 4.0 && (half.pos.y - 300.0).abs() < 0.01, "{:?}", half.pos);
        // the spinner: round the centre at 50 px
        let spin = pos_at(7000.0);
        assert!(((spin.pos - SPINNER_CENTRE).length() - 50.0).abs() < 0.01 && spin.buttons != 0);
        assert!(c.frames.windows(2).all(|w| w[0].time <= w[1].time));
        // OD 8: 195 RPM to clear, 410 for every bonus spin, over 2 s
        assert_eq!((c.objects[4].spins, c.objects[4].bonus_spins), (6, 5));
    }

    #[test]
    fn colours_and_other_modes() {
        let c = parse(&format!("{HEAD}[Colours]\nCombo2 : 10,20,30\nCombo1 : 1,2,3\nSliderBorder : 0,0,0\n[HitObjects]\n0,0,0,1,0\n")).unwrap();
        assert_eq!(c.colours, vec![[10, 20, 30], [1, 2, 3]]);
        assert_eq!(c.slider_border, Some([0, 0, 0]));
        assert!(parse("[General]\nMode: 3\n[HitObjects]\n64,192,100,1,0\n").is_none());
    }

    /// Every osu! difficulty of the library Fumen has imported: no panics, sane output.
    #[test]
    #[ignore = "reads the installed lazer's files and Fumen's library (read-only)"]
    fn real_library() {
        let Some(lazer) = crate::paths::default_lazer_dir() else { return };
        let storage = crate::paths::resolve_lazer_storage(&lazer);
        let db = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.fumen.app").join("library.db");
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = conn.prepare("SELECT hash FROM maps WHERE ruleset_id = 0 AND hash IS NOT NULL").unwrap();
        let hashes: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        let started = std::time::Instant::now();
        let (mut charts, mut objects, mut sliders, mut frames, mut points) = (0, 0, 0, 0, 0);
        for h in &hashes {
            let Some(text) = crate::paths::lazer_file(&storage, h).and_then(|p| std::fs::read(p).ok()) else { continue };
            let Some(c) = parse(&String::from_utf8_lossy(&text)) else { continue };
            charts += 1;
            objects += c.objects.len();
            sliders += c.objects.iter().filter(|o| o.slider.is_some()).count();
            points += c.objects.iter().filter_map(|o| o.slider.as_ref()).map(|s| s.path.points.len()).sum::<usize>();
            frames += c.frames.len();
            assert!(c.objects.windows(2).all(|w| w[0].time <= w[1].time));
            assert!(c.objects.iter().all(|o| o.end >= o.time && o.pos.x.is_finite()));
            assert!(c.frames.windows(2).all(|w| w[0].time <= w[1].time), "{h}");
            assert!(c.frames.iter().all(|f| f.pos.x.is_finite() && f.pos.y.is_finite()), "{h}");
        }
        eprintln!("{charts} charts: {objects} objects ({sliders} sliders, {points} path points), {frames} frames, in {:?}", started.elapsed());
    }
}
