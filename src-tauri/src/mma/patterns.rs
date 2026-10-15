//! ManiaMapAnalyser's pattern report (`js/patterns`, built on Interlude's RC pattern analysis
//! from YAVSRG, with long-note patterns added).
//!
//! 1. The chart becomes rows (one per distinct time) of cells: nothing, note, long-note head,
//!    body or tail.
//! 2. Every row becomes a primitive: how many notes start, how many repeat a column of the row
//!    before (jacks), which way the notes moved, which long notes start, are held or end.
//! 3. From every primitive, matchers look at the next few (at most 8) and name what starts
//!    there: a core pattern (stream, chordstream, jacks, coordination, density, wildcard) and the
//!    specific shapes inside it (rolls, trills, jumpstream, handstream, chordjacks, column lock,
//!    inverse …), with the stretch of time it covers and its speed.
//! 4. Matches are clustered by speed (within 5 ms per beat; "mixed" matches by pattern), each
//!    cluster gets the time it covers and an importance (time × speed × how much the pattern
//!    weighs in this kind of chart), and the most important clusters make the report and the
//!    chart's category.

use serde::Serialize;

use super::notes;
use crate::chart::Chart;

// ── config (patterns/config.js) ─────────────────────────────────────────────

const PATTERN_STABILITY_THRESHOLD: f64 = 5.0;
const BPM_CLUSTER_THRESHOLD: f64 = 5.0;
const JS_HS_SECONDARY_RATIO: f32 = 0.4;
const LN_MODE_LOW_THRESHOLD: f64 = 0.15;
const LN_MODE_HIGH_THRESHOLD: f64 = 0.9;
const HB_ROW_RATIO_THRESHOLD: f64 = 0.1;
const RELEASE_WITH_DW_MULTIPLIER: f64 = 0.8;
const RC_CORE_LN_SCALE: f64 = 0.3;
const RC_LN_CORE_SCALE: f64 = 0.0;
/// ms of non-1× scroll speed from which a chart counts as an SV chart
pub const SV_AMOUNT_THRESHOLD: f64 = 2000.0;
const SV_SPEED_EPS: f64 = 0.05;
const SV_EXTREME_BPM_MIN: f64 = 20.0;
const SV_EXTREME_BPM_MAX: f64 = 450.0;
const SV_EXTREME_BPM_RATIO: f64 = 4.0;
const JACKY_MIN_BPM: f64 = 90.0;
const SHIELD_MAX_BEAT_RATIO: f64 = 0.25;
const INVERSE_GAP_TOLERANCE_MS: f64 = 5.0;
const INVERSE_MIN_FILLED_LANES: usize = 3;
const RELEASE_SCAN_ROWS: usize = 4;
const RELEASE_MIN_TAIL_ROWS: usize = 4;
const RELEASE_FULL_MATCH_ROWS: usize = 5;
const JACKY_CONTEXT_WINDOW: usize = 6;
const JACKY_FALLBACK_MAX_MSPB: f64 = 185.0;
/// matchers read at most this many primitives ahead
const MATCHER_WINDOW: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Core {
    Stream,
    Chordstream,
    Jacks,
    Coordination,
    Density,
    Wildcard,
}

const CORES: [Core; 6] = [Core::Stream, Core::Chordstream, Core::Jacks, Core::Coordination, Core::Density, Core::Wildcard];

impl Core {
    fn rating(self) -> f64 {
        match self {
            Core::Stream => 1.0 / 3.0,
            Core::Chordstream => 0.65,
            Core::Jacks => 0.9,
            Core::Coordination => 0.75,
            Core::Density => 0.9,
            Core::Wildcard => 1.0,
        }
    }

    fn is_ln(self) -> bool {
        matches!(self, Core::Coordination | Core::Density | Core::Wildcard)
    }
}

/// The chart's kind by long notes: rice, long notes, hybrid (notes and heads in the same rows), mixed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Mode {
    RC,
    LN,
    HB,
    Mix,
}

/// How much a specific pattern weighs in a chart of this mode (`SUBTYPE_RATING_MULTIPLIER_BY_MODE`).
fn subtype_rating(mode: Mode, name: &str) -> Option<f64> {
    let rc = match name {
        "Rolls" | "Trills" | "Minitrills" => Some(1.0 / 3.0),
        "Handstream" | "Split Trill" | "Jumptrill" | "Jumpstream" | "Brackets" | "Double Stream" | "Dense Chordstream" | "Light Chordstream"
        | "Chord Rolls" => Some(0.65),
        "Longjacks" | "Quadstream" | "Gluts" | "Chordjacks" | "Minijacks" => Some(0.9),
        _ => None,
    };
    if rc.is_some() {
        return rc;
    }
    let density = matches!(name, "JS Density" | "HS Density" | "DS Density" | "LCS Density" | "DCS Density");
    Some(match (mode, name) {
        (_, "Column Lock") => 1.5,
        (_, "Shield") => 0.8,
        (Mode::RC, "Release") => 0.73,
        (Mode::LN, "Release") => 1.0,
        (_, "Release") => 0.3,
        (Mode::RC, _) if density => 1.0,
        (_, _) if density => 0.9,
        (Mode::RC | Mode::LN, "Inverse") => 1.5,
        (_, "Inverse") => 0.0,
        (Mode::RC, "Jacky WC") => 0.55,
        (Mode::LN, "Jacky WC") => 0.55,
        (Mode::HB, "Jacky WC") => 0.65,
        (Mode::Mix, "Jacky WC") => 0.45,
        (Mode::RC | Mode::LN, "Speedy WC") => 0.8,
        (_, "Speedy WC") => 0.45,
        _ => return None,
    })
}

fn rating_multiplier(core: Core, specific: Option<&str>, mode: Mode) -> f64 {
    let default = core.rating();
    let mut value = specific.and_then(|s| subtype_rating(mode, s)).unwrap_or(default);
    if mode == Mode::RC && core.is_ln() {
        value = specific.and_then(|s| subtype_rating(Mode::Mix, s)).unwrap_or(default) * RC_LN_CORE_SCALE;
    }
    if mode == Mode::LN && !core.is_ln() {
        value *= RC_CORE_LN_SCALE;
    }
    value
}

// ── rows ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cell {
    Nothing,
    Normal,
    Head,
    Body,
    Tail,
}

struct Row {
    time: f64,
    cells: Vec<Cell>,
}

/// Rows from notes in time order (`patternOsuParser.convertHitObjects`). A note or head stacked
/// onto a held column is dropped.
fn rows(notes: &[super::Note], keys: usize) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::new();
    let mut holding: Vec<Option<f64>> = vec![None; keys];

    fn new_row(out: &mut Vec<Row>, holding: &[Option<f64>], time: f64) {
        let cells = holding.iter().map(|h| if h.is_some() { Cell::Body } else { Cell::Nothing }).collect();
        out.push(Row { time, cells });
    }
    fn last_time(out: &[Row]) -> f64 {
        out.last().map_or(f64::NEG_INFINITY, |r| r.time)
    }
    fn finish_holds(out: &mut Vec<Row>, holding: &mut [Option<f64>], time: f64) {
        loop {
            let earliest = holding.iter().flatten().copied().fold(f64::INFINITY, f64::min);
            if !(earliest < time) {
                break;
            }
            for k in 0..holding.len() {
                if holding[k] != Some(earliest) {
                    continue;
                }
                if earliest > last_time(out) {
                    new_row(out, holding, earliest);
                }
                let row = out.last_mut().expect("a row");
                if matches!(row.cells[k], Cell::Nothing | Cell::Body) {
                    row.cells[k] = Cell::Tail;
                }
                holding[k] = None;
            }
        }
    }

    for n in notes {
        let col = n.col.min(keys - 1);
        let time = n.start as f64;
        finish_holds(&mut out, &mut holding, time);
        if time > last_time(&out) {
            new_row(&mut out, &holding, time);
        }
        let row = out.last_mut().expect("a row");
        match n.end.filter(|&e| e > n.start) {
            Some(end) => {
                if matches!(row.cells[col], Cell::Nothing | Cell::Normal) {
                    row.cells[col] = Cell::Head;
                    holding[col] = Some(end as f64);
                }
            }
            None => {
                if row.cells[col] == Cell::Nothing {
                    row.cells[col] = Cell::Normal;
                }
            }
        }
    }
    finish_holds(&mut out, &mut holding, f64::INFINITY);
    out
}

// ── timing: BPM and scroll speed (convertTimingPoints / cleanedSv) ───────────

struct Timing {
    /// (time, ms per beat)
    bpm: Vec<(f64, f64)>,
    /// (time, scroll speed relative to the main BPM)
    sv: Vec<(f64, f64)>,
}

fn timing(chart: &Chart, end_time: f64) -> Option<Timing> {
    if chart.timing.is_empty() {
        return Some(Timing { bpm: vec![(0.0, 500.0)], sv: vec![(0.0, 1.0)] });
    }
    let red: Vec<(f64, f64)> = chart.timing.iter().filter(|p| p.uninherited).map(|p| (p.time, p.beat_len.max(0.0))).collect();
    let first = *red.first()?;
    // the BPM the chart spends the most time at
    let mut durations: Vec<(f64, f64)> = Vec::new();
    let mut add = |mspb: f64, d: f64| match durations.iter_mut().find(|e| e.0 == mspb) {
        Some(e) => e.1 += d,
        None => durations.push((mspb, d)),
    };
    let (mut current, mut time) = (first.1, first.0);
    for &(t, mspb) in &red[1..] {
        add(current, t - time);
        time = t;
        current = mspb;
    }
    add(current, (end_time - time).max(0.0));
    durations.sort_by(|a, b| b.1.total_cmp(&a.1));
    let common = durations[0].0;

    let mut bpm = Vec::new();
    let mut sv = Vec::new();
    let mut mult = 1.0;
    for p in &chart.timing {
        if p.uninherited {
            let mspb = p.beat_len.max(0.0);
            bpm.push((p.time, mspb));
            mult = if mspb != 0.0 { common / mspb } else { 1.0 };
            sv.push((p.time, mult));
        } else if p.beat_len != 0.0 {
            sv.push((p.time, mult * (-100.0 / p.beat_len)));
        }
    }
    // the last point at each time wins; then only real changes
    let mut seen = std::collections::HashSet::new();
    let mut dedup: Vec<(f64, f64)> = sv.iter().rev().filter(|s| seen.insert(s.0.to_bits())).copied().collect();
    dedup.reverse();
    let mut cleaned = Vec::new();
    let mut prev = 1.0;
    for s in dedup {
        if (s.1 - prev).abs() > 0.005 {
            cleaned.push(s);
            prev = s.1;
        }
    }
    Some(Timing { bpm, sv: cleaned })
}

// ── primitives ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dir {
    None,
    Left,
    Right,
    Outwards,
    Inwards,
}

#[derive(Debug, Clone)]
struct Prim {
    /// ms from the first row
    time: f64,
    /// four times the gap to the previous row: ms per beat if this were 1/4 notes
    mspb: f64,
    /// the beat length of the timing section
    beat_len: f64,
    notes: usize,
    jacks: usize,
    dir: Dir,
    roll: bool,
    keys: usize,
    left_hand: usize,
    heads: Vec<usize>,
    bodies: Vec<usize>,
    tails: Vec<usize>,
    normal: Vec<usize>,
    /// columns where a note or head starts
    raw: Vec<usize>,
}

fn left_hand_keys(keys: usize) -> usize {
    match keys {
        3 | 4 => 2,
        5 | 6 => 3,
        7 | 8 => 4,
        9 | 10 => 5,
        _ => (keys / 2).max(1),
    }
}

fn detect_direction(prev: &[usize], cur: &[usize]) -> (Dir, bool) {
    let (pl, pr) = (prev[0] as isize, prev[prev.len() - 1] as isize);
    let (cl, cr) = (cur[0] as isize, cur[cur.len() - 1] as isize);
    let (dl, dr) = (cl - pl, cr - pr);
    let dir = if dl > 0 {
        if dr > 0 {
            Dir::Right
        } else {
            Dir::Inwards
        }
    } else if dl < 0 {
        if dr < 0 {
            Dir::Left
        } else {
            Dir::Outwards
        }
    } else if dr < 0 {
        Dir::Inwards
    } else if dr > 0 {
        Dir::Outwards
    } else {
        Dir::None
    };
    (dir, pl > cr || pr < cl)
}

fn primitives(rows: &[Row], keys: usize, bpm: &[(f64, f64)]) -> Vec<Prim> {
    let first = rows[0].time;
    let mut previous: Vec<usize> = (0..keys).filter(|&k| matches!(rows[0].cells[k], Cell::Normal | Cell::Head)).collect();
    if previous.is_empty() {
        return Vec::new();
    }
    let beat_at = |t: f64| {
        let mut cur = bpm.first().map_or(500.0, |b| b.1);
        for &(bt, mspb) in bpm {
            if bt > t {
                break;
            }
            cur = mspb;
        }
        cur
    };
    let left_hand = left_hand_keys(keys);
    let mut prev_time = first;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows[1..] {
        let mut p = Prim {
            time: row.time - first,
            mspb: (row.time - prev_time) * 4.0,
            beat_len: beat_at(row.time),
            notes: 0,
            jacks: 0,
            dir: Dir::None,
            roll: false,
            keys,
            left_hand,
            heads: Vec::new(),
            bodies: Vec::new(),
            tails: Vec::new(),
            normal: Vec::new(),
            raw: Vec::new(),
        };
        for (k, c) in row.cells.iter().enumerate() {
            match c {
                Cell::Normal => {
                    p.raw.push(k);
                    p.normal.push(k);
                }
                Cell::Head => {
                    p.raw.push(k);
                    p.heads.push(k);
                }
                Cell::Body => p.bodies.push(k),
                Cell::Tail => p.tails.push(k),
                Cell::Nothing => {}
            }
        }
        if p.raw.is_empty() && p.bodies.is_empty() && p.tails.is_empty() {
            continue;
        }
        if !p.raw.is_empty() {
            (p.dir, p.roll) = detect_direction(&previous, &p.raw);
            p.jacks = p.raw.iter().filter(|c| previous.contains(c)).count();
        }
        p.notes = p.raw.len();
        if !p.raw.is_empty() {
            previous = p.raw.clone();
        }
        prev_time = row.time;
        out.push(p);
    }
    out
}

// ── matchers (patternsDef.js) ───────────────────────────────────────────────

type Matcher = fn(&[Prim]) -> usize;

/// The row as its long-note heads alone (heads as notes).
fn head_rows(xs: &[Prim], n: usize) -> Vec<Prim> {
    let mut out = Vec::with_capacity(n);
    let mut prev: Vec<usize> = Vec::new();
    for row in &xs[..n.min(xs.len())] {
        let heads = row.heads.clone();
        let jacks = if heads.is_empty() { 0 } else { heads.iter().filter(|c| prev.contains(c)).count() };
        let (dir, roll) = if !prev.is_empty() && !heads.is_empty() { detect_direction(&prev, &heads) } else { (Dir::None, false) };
        if !heads.is_empty() {
            prev = heads.clone();
        }
        out.push(Prim { notes: heads.len(), jacks, dir, roll, normal: Vec::new(), raw: heads, ..row.clone() });
    }
    out
}

fn same_hand_adjacent(a: usize, b: usize, split: usize) -> bool {
    a.abs_diff(b) == 1 && (a < split) == (b < split)
}

fn jack_bpm(delta: f64) -> f64 {
    if delta <= 0.0 {
        230.0
    } else {
        (15000.0 / delta).min(230.0)
    }
}

fn head_context(xs: &[Prim]) -> bool {
    xs.first().is_some_and(|x| !x.heads.is_empty())
}

fn ln_context(xs: &[Prim], window: usize) -> bool {
    xs.iter().take(window).any(|r| !r.heads.is_empty() || !r.bodies.is_empty() || !r.tails.is_empty())
}

fn inverse_ready(xs: &[Prim]) -> bool {
    if xs.len() < 5 {
        return false;
    }
    let win = &xs[..5];
    if win.iter().any(|r| !r.normal.is_empty()) {
        return false;
    }
    if win.iter().map(|r| r.bodies.len()).max().unwrap_or(0) < INVERSE_MIN_FILLED_LANES {
        return false;
    }
    let gaps: Vec<f64> = win.windows(2).filter(|w| !w[0].tails.is_empty() && !w[1].heads.is_empty()).map(|w| w[1].time - w[0].time).collect();
    if gaps.len() < 2 {
        return false;
    }
    let max = gaps.iter().copied().fold(f64::MIN, f64::max);
    let min = gaps.iter().copied().fold(f64::MAX, f64::min);
    max - min <= INVERSE_GAP_TOLERANCE_MS
}

fn core_stream(xs: &[Prim]) -> usize {
    if xs.len() < 5 {
        return 0;
    }
    let w = &xs[..5];
    if w.iter().all(|x| x.notes == 1 && x.jacks == 0) && w[0].raw[0] != w[4].raw[0] {
        5
    } else {
        0
    }
}

fn core_jacks(xs: &[Prim]) -> usize {
    usize::from(xs.first().is_some_and(|x| x.jacks > 1 && x.mspb < 2000.0))
}

fn core_chordstream(xs: &[Prim]) -> usize {
    if xs.len() < 4 {
        return 0;
    }
    let w = &xs[..4];
    if w[0].notes > 1 && w.iter().all(|x| x.jacks == 0) && w[1..].iter().any(|x| x.notes > 1) {
        4
    } else {
        0
    }
}

fn core_coordination(xs: &[Prim]) -> usize {
    usize::from(xs.first().is_some_and(|a| !a.heads.is_empty() || !a.bodies.is_empty() || !a.tails.is_empty()))
}

fn core_head(xs: &[Prim]) -> usize {
    usize::from(head_context(xs))
}

fn jacks_chordjacks(xs: &[Prim]) -> usize {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    if a.notes > 2 && b.notes > 1 && b.jacks >= 1 && (b.notes < a.notes || b.jacks < b.notes) {
        2
    } else {
        0
    }
}

fn jacks_minijacks(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && xs[0].jacks > 0 && xs[1].jacks == 0 {
        2
    } else {
        0
    }
}

fn jacks_longjacks(xs: &[Prim]) -> usize {
    if xs.len() < 5 || !xs[..5].iter().all(|x| x.jacks > 0) {
        return 0;
    }
    if xs[0].raw.iter().any(|c| xs[1..5].iter().all(|x| x.raw.contains(c))) {
        5
    } else {
        0
    }
}

fn jacks_4k_quadstream(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && xs[0].notes == 4 && xs[2].jacks == 0 && xs[3].jacks == 0 {
        4
    } else {
        0
    }
}

fn jacks_4k_gluts(xs: &[Prim]) -> usize {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if b.jacks == 1 && c.jacks == 1 {
        if a.raw.iter().any(|x| b.raw.contains(x) && c.raw.contains(x)) {
            return 0;
        }
        return 3;
    }
    0
}

fn cs_4k_handstream(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && xs[0].notes == 3 && xs[..4].iter().all(|x| x.jacks == 0) {
        4
    } else {
        0
    }
}

fn cs_4k_jumpstream(xs: &[Prim]) -> usize {
    if xs.len() < 4 {
        return 0;
    }
    let w = &xs[..4];
    if w[0].notes == 2 && w[1].notes == 1 && w.iter().all(|x| x.jacks == 0) && w[2].notes < 3 && w[3].notes < 3 {
        4
    } else {
        0
    }
}

fn cs_4k_jumptrill(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && xs[..4].iter().all(|x| x.notes == 2) && xs[1].roll && xs[2].roll && xs[3].roll {
        4
    } else {
        0
    }
}

fn cs_4k_splittrill(xs: &[Prim]) -> usize {
    if xs.len() >= 3 && xs[..3].iter().all(|x| x.notes == 2) && xs[1].jacks == 0 && xs[2].jacks == 0 && !xs[1].roll && !xs[2].roll {
        3
    } else {
        0
    }
}

fn stream_4k_roll(xs: &[Prim]) -> usize {
    if xs.len() < 3 || !xs[..3].iter().all(|x| x.notes == 1) {
        return 0;
    }
    let all = |d: Dir| xs[..3].iter().all(|x| x.dir == d);
    if all(Dir::Left) || all(Dir::Right) {
        3
    } else {
        0
    }
}

fn stream_4k_trill(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && xs[1..4].iter().all(|x| x.jacks == 0) && xs[0].raw == xs[2].raw && xs[1].raw == xs[3].raw {
        4
    } else {
        0
    }
}

fn stream_4k_minitrill(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && xs[1].jacks == 0 && xs[2].jacks == 0 && xs[0].raw == xs[2].raw && xs[1].raw != xs[3].raw {
        4
    } else {
        0
    }
}

fn cs_7k_double_streams(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && xs[0].notes == 2 && xs[1].notes == 2 && xs[1].jacks == 0 && !xs[1].roll {
        2
    } else {
        0
    }
}

fn cs_7k_dense_chordstream(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && xs[0].notes > 1 && xs[1].notes > 1 && xs[1].jacks == 0 {
        2
    } else {
        0
    }
}

fn cs_7k_light_chordstream(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && xs[0].notes > 1 && xs[1].notes == 1 && xs[1].jacks == 0 {
        2
    } else {
        0
    }
}

fn cs_7k_chord_roll(xs: &[Prim]) -> usize {
    if xs.len() < 3 || !xs[..3].iter().all(|x| x.notes > 1) || !xs[1].roll || !xs[2].roll {
        return 0;
    }
    let (b, c) = (xs[1].dir, xs[2].dir);
    if (b == Dir::Left && c == Dir::Left) || (b == Dir::Right && c == Dir::Right) {
        3
    } else {
        0
    }
}

fn cs_7k_brackets(xs: &[Prim]) -> usize {
    if xs.len() < 3 {
        return 0;
    }
    let (a, b, c) = (&xs[0], &xs[1], &xs[2]);
    if a.notes > 2 && b.notes > 2 && c.notes > 2 && !b.roll && !c.roll && b.jacks == 0 && c.jacks == 0 && a.notes + b.notes + c.notes > 9 {
        3
    } else {
        0
    }
}

fn coord_column_lock(xs: &[Prim]) -> usize {
    if xs.len() < 3 {
        return 0;
    }
    let split = xs[0].left_hand;
    let Some(&ln_col) = xs[0].heads.first() else { return 0 };
    let keys = xs[0].keys;
    let adj = [ln_col.checked_sub(1), Some(ln_col + 1)];
    for adj in adj.into_iter().flatten().filter(|&c| c < keys && same_hand_adjacent(ln_col, c, split)) {
        let hits: Vec<f64> = xs.iter().take(8).filter(|r| r.bodies.contains(&ln_col) && r.normal.contains(&adj)).map(|r| r.time).collect();
        if hits.len() < 3 {
            continue;
        }
        if hits.windows(2).map(|w| jack_bpm(w[1] - w[0])).fold(f64::MIN, f64::max) >= JACKY_MIN_BPM {
            return 3;
        }
    }
    0
}

fn coord_shield(xs: &[Prim]) -> usize {
    if xs.len() < 2 {
        return 0;
    }
    let (a, b) = (&xs[0], &xs[1]);
    let dt = b.time - a.time;
    if dt < 0.0 || dt > b.beat_len * SHIELD_MAX_BEAT_RATIO {
        return 0;
    }
    if a.normal.iter().any(|c| b.heads.contains(c)) || a.tails.iter().any(|c| b.normal.contains(c)) {
        2
    } else {
        0
    }
}

fn coord_release(xs: &[Prim]) -> usize {
    if xs.len() < RELEASE_MIN_TAIL_ROWS || coord_shield(xs) != 0 || inverse_ready(xs) || wildcard_jack(xs) != 0 {
        return 0;
    }
    let picked: Vec<&Prim> = xs.iter().take(RELEASE_SCAN_ROWS).filter(|r| r.tails.len() == 1).collect();
    if picked.len() < RELEASE_MIN_TAIL_ROWS {
        return 0;
    }
    let use_rows = RELEASE_FULL_MATCH_ROWS.min(picked.len());
    // the tails as a one-note-per-row stream: the first two after the first must move
    let eff: Vec<(usize, f64)> = picked[1..use_rows].iter().map(|r| (r.tails[0], r.time)).collect();
    if eff.len() < 2 {
        return 0;
    }
    let (a, b) = (eff[0], eff[1]);
    if a.0 != b.0 && b.1 - a.1 > 0.0 {
        if use_rows >= RELEASE_FULL_MATCH_ROWS {
            5
        } else {
            4
        }
    } else {
        0
    }
}

fn density_4k_jumpstream(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && head_context(xs) && cs_4k_jumpstream(&head_rows(xs, 4)) != 0 {
        4
    } else {
        0
    }
}

fn density_4k_handstream(xs: &[Prim]) -> usize {
    if xs.len() >= 4 && head_context(xs) && cs_4k_handstream(&head_rows(xs, 4)) != 0 {
        4
    } else {
        0
    }
}

fn density_inverse(xs: &[Prim]) -> usize {
    if inverse_ready(xs) {
        5
    } else {
        0
    }
}

fn density_double_streams(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && head_context(xs) && cs_7k_double_streams(&head_rows(xs, 2)) != 0 {
        2
    } else {
        0
    }
}

fn density_dense_chordstream(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && head_context(xs) && cs_7k_dense_chordstream(&head_rows(xs, 2)) != 0 {
        2
    } else {
        0
    }
}

fn density_light_chordstream(xs: &[Prim]) -> usize {
    if xs.len() >= 2 && head_context(xs) && cs_7k_light_chordstream(&head_rows(xs, 2)) != 0 {
        2
    } else {
        0
    }
}

fn wildcard_jack(xs: &[Prim]) -> usize {
    if xs.len() < 2 || !ln_context(xs, JACKY_CONTEXT_WINDOW) {
        return 0;
    }
    let rows: Vec<Prim> = xs.iter().take(JACKY_CONTEXT_WINDOW.max(4)).filter(|r| r.notes > 0).cloned().collect();
    if rows.len() < 2 {
        return 0;
    }
    if jacks_chordjacks(&rows) != 0 || jacks_minijacks(&rows) != 0 {
        return 4;
    }
    let check = &rows[..rows.len().min(4)];
    let jack_rows = check.iter().filter(|r| r.jacks > 0).count();
    if jack_rows >= 2 && check.iter().any(|r| r.notes >= 2) {
        return 3;
    }
    let fastest = check.iter().map(|r| r.mspb).fold(f64::INFINITY, f64::min);
    if jack_rows >= 2 && fastest <= JACKY_FALLBACK_MAX_MSPB {
        return 3;
    }
    0
}

fn wildcard_speed(xs: &[Prim]) -> usize {
    if xs.len() < 2 || !ln_context(xs, 4) {
        return 0;
    }
    let rows = head_rows(xs, xs.len().min(4));
    let lr = |d: Dir| matches!(d, Dir::Left | Dir::Right);
    if xs[0].keys == 4 {
        if rows.len() >= 3 && stream_4k_roll(&rows[..3]) != 0 {
            return 3;
        }
        if rows.len() >= 2 {
            let same = lr(rows[0].dir) && rows[0].dir == rows[1].dir;
            if same || rows[0].mspb <= 180.0 {
                return 3;
            }
        }
    } else {
        if rows.len() >= 3 && cs_7k_chord_roll(&rows[..3]) != 0 {
            return 3;
        }
        if rows.len() >= 2 {
            let cond = rows[0].notes >= 2 && rows[1].notes >= 2 && rows[0].dir == rows[1].dir && lr(rows[0].dir);
            if cond || rows[0].mspb <= 170.0 {
                return 3;
            }
        }
    }
    0
}

/// The specific patterns per core pattern for a key count, in matching order.
fn specifics(keys: usize) -> [(Core, Matcher, Vec<(&'static str, Matcher)>); 6] {
    let coordination: Vec<(&'static str, Matcher)> = vec![("Column Lock", coord_column_lock), ("Shield", coord_shield), ("Release", coord_release)];
    let wildcard: Vec<(&'static str, Matcher)> = vec![("Speedy WC", wildcard_speed), ("Jacky WC", wildcard_jack)];
    let (stream, chordstream, jacks, density): (Vec<(&'static str, Matcher)>, Vec<(&'static str, Matcher)>, Vec<(&'static str, Matcher)>, Vec<(&'static str, Matcher)>) =
        if keys == 4 {
            (
                vec![("Rolls", stream_4k_roll), ("Trills", stream_4k_trill), ("Minitrills", stream_4k_minitrill)],
                vec![("Handstream", cs_4k_handstream), ("Split Trill", cs_4k_splittrill), ("Jumptrill", cs_4k_jumptrill), ("Jumpstream", cs_4k_jumpstream)],
                vec![
                    ("Longjacks", jacks_longjacks),
                    ("Quadstream", jacks_4k_quadstream),
                    ("Gluts", jacks_4k_gluts),
                    ("Chordjacks", jacks_chordjacks),
                    ("Minijacks", jacks_minijacks),
                ],
                vec![("Inverse", density_inverse), ("JS Density", density_4k_jumpstream), ("HS Density", density_4k_handstream)],
            )
        } else {
            let first: (&'static str, Matcher) = if keys == 7 { ("Brackets", cs_7k_brackets) } else { ("Chord Rolls", cs_7k_chord_roll) };
            (
                Vec::new(),
                vec![first, ("Double Stream", cs_7k_double_streams), ("Dense Chordstream", cs_7k_dense_chordstream), ("Light Chordstream", cs_7k_light_chordstream)],
                vec![("Longjacks", jacks_longjacks), ("Chordjacks", jacks_chordjacks), ("Minijacks", jacks_minijacks)],
                vec![
                    ("Inverse", density_inverse),
                    ("DS Density", density_double_streams),
                    ("DCS Density", density_dense_chordstream),
                    ("LCS Density", density_light_chordstream),
                ],
            )
        };
    [
        (Core::Stream, core_stream, stream),
        (Core::Chordstream, core_chordstream, chordstream),
        (Core::Jacks, core_jacks, jacks),
        (Core::Coordination, core_coordination, coordination),
        (Core::Density, core_head, density),
        (Core::Wildcard, core_head, wildcard),
    ]
}

// ── finding and clustering ──────────────────────────────────────────────────

struct Found {
    core: Core,
    specific: Option<&'static str>,
    mixed: bool,
    start: f64,
    end: f64,
    mspb: f64,
}

fn find(prims: &[Prim], keys: usize, last_note: f64) -> Vec<Found> {
    let table = specifics(keys);
    let mut out = Vec::new();
    let push = |out: &mut Vec<Found>, core: Core, specific: Option<&'static str>, n: usize, rem: &[Prim]| {
        let d = &rem[..n.min(rem.len())];
        let mean = d.iter().map(|x| x.mspb).sum::<f64>() / d.len() as f64;
        let mixed = !d.iter().all(|x| (x.mspb - mean).abs() < PATTERN_STABILITY_THRESHOLD);
        let start = rem[0].time;
        let candidate = rem.get(n).map_or(last_note, |r| r.time);
        let end = if core == Core::Jacks { (rem[0].time + rem[0].mspb * 0.5).max(candidate) } else { candidate };
        let mspb = if core == Core::Density && specific == Some("Inverse") { 0.0 } else { mean };
        out.push(Found { core, specific, mixed, start, end, mspb });
    };
    for start in 0..prims.len() {
        let rem = &prims[start..(start + MATCHER_WINDOW).min(prims.len())];
        for (core, core_fn, list) in &table {
            let n = core_fn(rem);
            if n == 0 {
                continue;
            }
            let matched: Vec<(usize, &'static str)> = list.iter().map(|(name, f)| (f(rem), *name)).filter(|(m, _)| *m != 0).collect();
            if matched.is_empty() {
                push(&mut out, *core, None, n, rem);
            }
            for (m, name) in matched {
                push(&mut out, *core, Some(name), n.max(m), rem);
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cluster {
    pub pattern: Core,
    /// the specific patterns inside, with their share of the cluster's matches, biggest first
    pub specific: Vec<(&'static str, f32)>,
    /// the speed, as the BPM of 1/4 notes at it (0 for patterns without one)
    pub bpm: u32,
    /// its matches don't hold one speed
    pub mixed: bool,
    /// chart time it covers, ms (overlapping matches can count twice)
    pub amount: f32,
    #[serde(skip)]
    rating: f64,
}

impl Cluster {
    fn importance(&self) -> f64 {
        self.amount as f64 * self.rating * self.bpm as f64
    }
}

/// Time covered by sorted intervals, the analyser's way.
fn pattern_amount(spans: &[(f64, f64)]) -> f64 {
    let (mut total, (mut cs, mut ce)) = (0.0, spans[0]);
    for &(s, e) in spans {
        if ce < e {
            total += ce - cs;
            cs = s;
            ce = e;
        } else {
            ce = ce.max(e);
        }
    }
    total + ce - cs
}

fn clusters(found: &[Found], mode: Mode) -> Vec<Cluster> {
    // speed clusters: one per pattern for mixed matches, shared by speed for the rest
    struct Speed {
        original: f64,
        sum: f64,
        count: usize,
    }
    let mut steady: Vec<Speed> = Vec::new();
    let mut mixed: Vec<(Core, Speed)> = Vec::new();
    let assigned: Vec<(bool, usize)> = found
        .iter()
        .map(|p| {
            if p.mixed {
                match mixed.iter().position(|(c, _)| *c == p.core) {
                    Some(i) => {
                        mixed[i].1.sum += p.mspb;
                        mixed[i].1.count += 1;
                        (true, i)
                    }
                    None => {
                        mixed.push((p.core, Speed { original: p.mspb, sum: p.mspb, count: 1 }));
                        (true, mixed.len() - 1)
                    }
                }
            } else {
                match steady.iter().position(|c| (c.original - p.mspb).abs() < BPM_CLUSTER_THRESHOLD) {
                    Some(i) => {
                        steady[i].sum += p.mspb;
                        steady[i].count += 1;
                        (false, i)
                    }
                    None => {
                        steady.push(Speed { original: p.mspb, sum: p.mspb, count: 1 });
                        (false, steady.len() - 1)
                    }
                }
            }
        })
        .collect();
    let bpm_of = |s: &Speed| {
        let avg = s.sum / s.count as f64;
        if avg <= 0.0 {
            0
        } else {
            (60000.0 / avg).round() as u32
        }
    };
    let steady_bpm: Vec<u32> = steady.iter().map(bpm_of).collect();
    let mixed_bpm: Vec<u32> = mixed.iter().map(|(_, s)| bpm_of(s)).collect();

    struct Group<'a> {
        core: Core,
        mixed: bool,
        bpm: u32,
        data: Vec<&'a Found>,
    }
    let mut groups: Vec<Group> = Vec::new();
    let mut index: std::collections::HashMap<(Core, bool, u32), usize> = Default::default();
    for (p, &(is_mixed, i)) in found.iter().zip(&assigned) {
        let bpm = if is_mixed { mixed_bpm[i] } else { steady_bpm[i] };
        let gi = *index.entry((p.core, p.mixed, bpm)).or_insert_with(|| {
            groups.push(Group { core: p.core, mixed: p.mixed, bpm, data: Vec::new() });
            groups.len() - 1
        });
        groups[gi].data.push(p);
    }

    let mut out: Vec<Cluster> = groups
        .iter()
        .map(|g| {
            let mut spans: Vec<(f64, f64)> = g.data.iter().map(|m| (m.start, m.end)).collect();
            spans.sort_by(|a, b| a.0.total_cmp(&b.0));
            let mut counter: Vec<(&'static str, usize)> = Vec::new();
            for m in &g.data {
                if let Some(s) = m.specific {
                    match counter.iter_mut().find(|e| e.0 == s) {
                        Some(e) => e.1 += 1,
                        None => counter.push((s, 1)),
                    }
                }
            }
            let n = g.data.len() as f64;
            let mut specific: Vec<(&'static str, f64)> = counter.into_iter().map(|(s, c)| (s, c as f64 / n)).collect();
            specific.sort_by(|a, b| b.1.total_cmp(&a.1));
            Cluster {
                pattern: g.core,
                rating: rating_multiplier(g.core, specific.first().map(|s| s.0), mode),
                specific: specific.into_iter().map(|(s, r)| (s, r as f32)).collect(),
                bpm: g.bpm,
                mixed: g.mixed,
                amount: if spans.is_empty() { 0.0 } else { pattern_amount(&spans) as f32 },
            }
        })
        .collect();
    if out.iter().any(|c| matches!(c.pattern, Core::Density | Core::Wildcard)) {
        for c in &mut out {
            if c.specific.iter().any(|&(s, r)| s == "Release" && r > 0.0) {
                c.rating *= RELEASE_WITH_DW_MULTIPLIER;
            }
        }
    }
    out
}

// ── report ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// what the chart is mostly, e.g. "Jumpstream", "Chordjacks Tech", "Column Lock"
    pub category: String,
    pub mode: Mode,
    /// long-note heads among all notes
    pub ln_ratio: f32,
    /// ms of the chart at a scroll speed away from 1× (by the analyser's measure)
    pub sv_amount: f32,
    /// up to three clusters per core pattern, most important first
    pub clusters: Vec<Cluster>,
    /// what each second from `start` is (an index into `labels`, -1 for nothing)
    pub seconds: Vec<i16>,
    /// the names in `seconds`: a specific pattern ("Jumpstream") or a core pattern ("Stream")
    pub labels: Vec<String>,
    /// the first row's time, ms
    pub start: f32,
}

impl Report {
    /// Scroll speed changes enough to call it an SV chart.
    pub fn sv(&self) -> bool {
        self.sv_amount as f64 >= SV_AMOUNT_THRESHOLD
    }
}

/// The pattern report of an osu!mania chart; `None` for other modes and empty charts.
pub fn report(chart: &Chart) -> Option<Report> {
    if chart.mode != 3 || chart.keys == 0 {
        return None;
    }
    let keys = chart.keys as usize;
    let (notes, _) = notes(chart);
    let rows = rows(&notes, keys);
    let (first, last) = (rows.first()?.time, rows.last()?.time);
    let timing = timing(chart, last)?;

    let (mut heads, mut all) = (0usize, 0usize);
    let mut hb_rows = 0usize;
    for r in &rows {
        let h = r.cells.iter().filter(|&&c| c == Cell::Head).count();
        let n = r.cells.iter().filter(|&&c| c == Cell::Normal).count();
        heads += h;
        all += h + n;
        if h > 0 && n > 0 {
            hb_rows += 1;
        }
    }
    let ln_ratio = if all > 0 { heads as f64 / all as f64 } else { 0.0 };
    let hb_ratio = hb_rows as f64 / rows.len() as f64;
    let mode = if ln_ratio <= LN_MODE_LOW_THRESHOLD {
        Mode::RC
    } else if ln_ratio >= LN_MODE_HIGH_THRESHOLD {
        Mode::LN
    } else if hb_ratio >= HB_ROW_RATIO_THRESHOLD {
        Mode::HB
    } else {
        Mode::Mix
    };

    let prims = primitives(&rows, keys, &timing.bpm);
    let mut found = find(&prims, keys, last - first);
    if mode == Mode::RC {
        found.retain(|p| !p.core.is_ln());
    }
    let mut cl: Vec<Cluster> = clusters(&found, mode).into_iter().filter(|c| c.bpm > 25 || c.bpm == 0).collect();
    cl.sort_by(|a, b| b.amount.total_cmp(&a.amount));
    let pruned = |c: &Cluster| cl.iter().any(|o| o.pattern == c.pattern && o.amount * 0.5 > c.amount && o.bpm > c.bpm);
    let kept: Vec<&Cluster> = cl.iter().filter(|c| !pruned(c)).collect();
    let mut top: Vec<Cluster> = CORES.iter().flat_map(|&core| kept.iter().filter(move |c| c.pattern == core).take(3).map(|c| (*c).clone())).collect();
    top.sort_by(|a, b| b.importance().total_cmp(&a.importance()));

    let (labels, seconds) = timeline(&found, mode, first, last);
    Some(Report {
        category: categorise(&top),
        mode,
        ln_ratio: ln_ratio as f32,
        sv_amount: sv_time(&timing, first, last) as f32,
        clusters: top,
        seconds,
        labels,
        start: first as f32,
    })
}

/// What each second of the chart is, from the same matches as the report: per second, every
/// match counts with the time it covers there, weighted the way the report weighs clusters
/// (the pattern's rating in this kind of chart, times its speed); the heaviest name wins.
fn timeline(found: &[Found], mode: Mode, first: f64, last: f64) -> (Vec<String>, Vec<i16>) {
    let n = ((last - first) / 1000.0).floor().max(0.0) as usize + 1;
    let mut labels: Vec<String> = Vec::new();
    let mut weight: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for p in found {
        let name = p.specific.map(str::to_owned).unwrap_or_else(|| format!("{:?}", p.core));
        let li = match labels.iter().position(|l| *l == name) {
            Some(i) => i,
            None => {
                labels.push(name);
                labels.len() - 1
            }
        };
        let speed = if p.mspb > 0.0 { 60000.0 / p.mspb } else { 100.0 };
        let w = rating_multiplier(p.core, p.specific, mode) * speed;
        let (s, e) = (p.start - first, (p.end - first).max(p.start - first));
        let (i0, i1) = ((s / 1000.0).floor().max(0.0) as usize, ((e / 1000.0).floor().max(0.0) as usize).min(n - 1));
        for (i, bin) in weight.iter_mut().enumerate().take(i1 + 1).skip(i0) {
            let (b0, b1) = (i as f64 * 1000.0, i as f64 * 1000.0 + 1000.0);
            // a match without length counts as one ms
            let cover = (e.min(b1) - s.max(b0)).max(if e <= s { 1.0 } else { 0.0 });
            if cover <= 0.0 {
                continue;
            }
            match bin.iter_mut().find(|(l, _)| *l == li) {
                Some(x) => x.1 += cover * w,
                None => bin.push((li, cover * w)),
            }
        }
    }
    let seconds = weight
        .iter()
        .map(|bin| bin.iter().filter(|x| x.1 > 0.0).max_by(|a, b| a.1.total_cmp(&b.1)).map_or(-1, |x| x.0 as i16))
        .collect();
    (labels, seconds)
}

fn categorise(clusters: &[Cluster]) -> String {
    // the analyser names the chart after the most important cluster (the first of those within
    // half its importance, i.e. itself)
    let Some(c) = clusters.first() else { return "Uncategorised".into() };
    let name = match c.specific.as_slice() {
        [(s, r), ..] if *r > 0.05 => (*s).to_owned(),
        [("Jumpstream", a1), ("Handstream", a2), ..] if a2 / a1 > JS_HS_SECONDARY_RATIO => "Jumpstream/Handstream".to_owned(),
        _ => format!("{:?}", c.pattern),
    };
    if c.mixed {
        format!("{name} Tech")
    } else {
        name
    }
}

/// Time spent at a scroll speed away from 1× (`svTime`). Charts with a single SV section don't
/// count; wild BPM changes always do.
fn sv_time(t: &Timing, first: f64, last: f64) -> f64 {
    if t.sv.is_empty() {
        return 0.0;
    }
    let off = |v: f64| !v.is_finite() || (v - 1.0).abs() > SV_SPEED_EPS;
    let (mut total, mut time, mut vel) = (0.0, first, 1.0);
    let (mut sections, mut inside) = (0usize, false);
    for &(st, v) in &t.sv {
        if off(vel) {
            total += st - time;
        }
        if off(v) && !inside {
            sections += 1;
            inside = true;
        } else if !off(v) {
            inside = false;
        }
        vel = v;
        time = st;
    }
    if off(vel) {
        total += last - time;
    }
    if sections <= 1 {
        return 0.0;
    }
    let mut prev: Option<f64> = None;
    for &(_, mspb) in &t.bpm {
        let bpm = 60000.0 / mspb;
        let wild = !(mspb.is_finite() && mspb > 0.0)
            || bpm <= SV_EXTREME_BPM_MIN
            || bpm >= SV_EXTREME_BPM_MAX
            || prev.is_some_and(|p| p > 0.0 && (p / mspb).max(mspb / p) >= SV_EXTREME_BPM_RATIO);
        if wild {
            return total.max(SV_AMOUNT_THRESHOLD + 1.0);
        }
        prev = Some(mspb);
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::parse;

    /// A 4K chart from rows of columns, one row every `gap` ms; `holds` turns notes into long notes.
    fn chart(pattern: &[&[usize]], gap: i32, count: usize, hold: Option<i32>) -> Chart {
        let mut s = String::from("[General]\nMode: 3\n[Difficulty]\nCircleSize:4\nOverallDifficulty:8\n[TimingPoints]\n0,500,4,2,0,40,1,0\n[HitObjects]\n");
        for i in 0..count {
            let t = 1000 + i as i32 * gap;
            for &c in pattern[i % pattern.len()] {
                let x = c * 128 + 64;
                match hold {
                    Some(len) => s.push_str(&format!("{x},192,{t},128,0,{}:0:0:0:0:\n", t + len)),
                    None => s.push_str(&format!("{x},192,{t},1,0,0:0:0:0:\n")),
                }
            }
        }
        parse(&s)
    }

    fn top(c: &Chart) -> Report {
        report(c).expect("a report")
    }

    #[test]
    fn jumpstream_at_its_speed() {
        // 1/4 notes at 180 BPM: 83 ms apart
        let r = top(&chart(&[&[0, 1], &[2], &[3], &[0, 2], &[1], &[3], &[1, 2], &[0], &[3]], 83, 400, None));
        assert_eq!(r.mode, Mode::RC);
        let c = &r.clusters[0];
        assert_eq!(c.pattern, Core::Chordstream);
        assert_eq!(c.specific[0].0, "Jumpstream");
        assert!((c.bpm as i32 - 181).abs() <= 1, "{}", c.bpm);
        assert_eq!(r.category, "Jumpstream");
    }

    #[test]
    fn rolls_are_streams() {
        // (a 4-note cycle never counts as a stream: its first and fifth notes share a column)
        let r = top(&chart(&[&[0], &[1], &[2], &[3], &[1], &[2]], 100, 300, None));
        assert_eq!(r.clusters[0].pattern, Core::Stream);
        assert!(r.clusters[0].specific.iter().any(|s| s.0 == "Rolls"), "{:?}", r.clusters[0]);
        assert_eq!(r.clusters[0].bpm, 150);
    }

    #[test]
    fn chordjacks() {
        // (no column takes part in every row: that would be longjacks)
        let r = top(&chart(&[&[0, 1, 2], &[1, 2], &[0, 3], &[0, 1, 3]], 120, 300, None));
        assert_eq!(r.clusters[0].pattern, Core::Jacks);
        assert_eq!(r.category, "Chordjacks");
    }

    #[test]
    fn long_note_charts() {
        let r = top(&chart(&[&[0], &[1], &[2], &[3]], 150, 300, Some(400)));
        assert_eq!(r.mode, Mode::LN);
        assert!((r.ln_ratio - 1.0).abs() < 1e-6);
        // rice patterns weigh little in LN charts: LN patterns lead
        assert!(r.clusters[0].pattern.is_ln(), "{:?}", r.clusters[0]);
        assert!(!r.sv());
    }

    #[test]
    fn rows_stack_and_hold() {
        // jumps of long notes, 100 ms apart, each held for 50 ms
        let c = chart(&[&[0, 1]], 100, 3, Some(50));
        let (notes, _) = notes(&c);
        let rows = rows(&notes, 4);
        let cells: Vec<(f64, [Cell; 2])> = rows.iter().map(|r| (r.time, [r.cells[0], r.cells[1]])).collect();
        assert_eq!(cells[0], (1000.0, [Cell::Head, Cell::Head]));
        assert_eq!(cells[1], (1050.0, [Cell::Tail, Cell::Tail]));
        assert_eq!(cells[2], (1100.0, [Cell::Head, Cell::Head]));
        assert_eq!(rows.len(), 6);
        // a note stacked inside a held column is dropped instead of failing
        let s = "[General]\nMode: 3\n[Difficulty]\nCircleSize:4\n[HitObjects]\n64,192,1000,128,0,2000:0:0:0:0:\n64,192,1500,1,0,0:0:0:0:\n";
        let r = report(&parse(s));
        assert!(r.is_some());
    }

    #[test]
    fn sv_needs_two_sections() {
        let mut t = Timing { bpm: vec![(0.0, 500.0)], sv: vec![(1000.0, 0.5), (3000.0, 1.0)] };
        assert_eq!(sv_time(&t, 0.0, 10_000.0), 0.0);
        t.sv.extend([(5000.0, 2.0), (8000.0, 1.0)]);
        assert_eq!(sv_time(&t, 0.0, 10_000.0), 5000.0);
    }
}

#[cfg(test)]
mod timeline_real {
    /// Prints the report's category next to how its seconds are named, for some real charts
    /// (run by hand; reads the library and lazer's files only).
    #[test]
    #[ignore]
    fn timeline_on_real_charts() {
        let data = std::path::PathBuf::from(std::env::var("APPDATA").unwrap());
        let conn = rusqlite::Connection::open_with_flags(data.join("dev.fumen.app").join("library.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let files = crate::paths::Files::lazer(data.join("osu"));
        let mut st = conn.prepare("SELECT hash, version FROM maps WHERE ruleset_id = 3 AND hash IS NOT NULL ORDER BY random() LIMIT 14").unwrap();
        let rows: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        for (hash, version) in rows {
            let Ok(chart) = crate::charts::load(&files, &hash) else { continue };
            let Some(r) = super::report(&chart) else { continue };
            let mut count = vec![0usize; r.labels.len()];
            let mut none = 0;
            for &s in &r.seconds {
                if s < 0 { none += 1 } else { count[s as usize] += 1 }
            }
            let mut named: Vec<(String, usize)> = r.labels.iter().cloned().zip(count).filter(|x| x.1 > 0).collect();
            named.sort_by(|a, b| b.1.cmp(&a.1));
            println!("{version:30} | {:28} | none {none:3} | {:?}", r.category, &named[..named.len().min(4)]);
        }
    }
}
