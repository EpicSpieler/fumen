//! What a chart asks of you: note density over time and, for osu!mania, the patterns.
//!
//! The pattern read is deliberately simple and explainable: the chart is cut into one-second
//! windows, each window is labelled by its dominant shape (stream, jumpstream, handstream,
//! chordjack, jacks, long notes), and a pattern's share is the share of windows it wins.
//! Windows with fewer than four rows of notes are "light" and don't count for any pattern.

use serde::Serialize;

use crate::chart::{Chart, Kind};

/// Bump when the analysis changes, so cached results are recomputed.
/// 2: osu!mania star ratings at HT and DT joined the cached summary.
pub const VERSION: i64 = 2;

const WINDOW: i32 = 1000;
/// rows per window below which a window counts as light
const LIGHT_ROWS: usize = 4;
/// a pattern needs this share of the chart to become a tag
const TAG_SHARE: f32 = 0.15;
/// unbroken dense play for this long earns the "stamina" tag
const STAMINA_MS: i32 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Pattern {
    Stream,
    Jumpstream,
    Handstream,
    Chordjack,
    Jacks,
    Ln,
}

impl Pattern {
    const ALL: [Pattern; 6] = [Pattern::Stream, Pattern::Jumpstream, Pattern::Handstream, Pattern::Chordjack, Pattern::Jacks, Pattern::Ln];

    pub fn name(self) -> &'static str {
        match self {
            Pattern::Stream => "stream",
            Pattern::Jumpstream => "jumpstream",
            Pattern::Handstream => "handstream",
            Pattern::Chordjack => "chordjack",
            Pattern::Jacks => "jacks",
            Pattern::Ln => "ln",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Share {
    pub pattern: Pattern,
    pub share: f32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// first object, ms
    pub start: i32,
    /// end of the last object, ms
    pub end: i32,
    /// playable time (first to last object, minus breaks), ms
    pub drain: i32,
    pub notes: u32,
    pub holds: u32,
    pub nps_avg: f32,
    /// densest two seconds, in notes per second
    pub nps_peak: f32,
    /// notes per second, one value per second from `start`
    pub density: Vec<f32>,
    /// longest stretch of dense play without a light second, ms
    pub longest_burst: i32,
    // ── osu!mania only ──
    /// notes per column
    pub lanes: Vec<u32>,
    /// rows of 1, 2, 3 and 4+ notes
    pub chords: [u32; 4],
    /// share of rows that repeat a column of the row before
    pub jack_ratio: f32,
    /// share of playable time with a long note held
    pub ln_time: f32,
    /// share of one-second windows per pattern, biggest first
    pub patterns: Vec<Share>,
    /// the pattern of every one-second window from `start` (null = light or empty)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<Option<Pattern>>,
    pub tags: Vec<&'static str>,
}

/// Notes that start together, as a column bitmask.
struct Row {
    time: i32,
    mask: u32,
    size: u32,
}

pub fn analyse(chart: &Chart) -> Analysis {
    let objs = &chart.objects;
    let Some(first) = objs.first() else { return Analysis::default() };
    let start = first.time;
    let end = objs.iter().map(|o| o.end).max().unwrap_or(start);
    let span = (end - start).max(1);
    let break_ms: i32 = chart.breaks.iter().map(|&(s, e)| (e.min(end) - s.max(start)).max(0)).sum();
    let drain = (span - break_ms).max(1);
    let notes = objs.len() as u32;
    let holds = objs.iter().filter(|o| matches!(o.kind, Kind::Hold | Kind::Slider | Kind::Spinner)).count() as u32;

    // density: heads per second
    let seconds = (span / 1000 + 1) as usize;
    let mut density = vec![0f32; seconds];
    for o in objs {
        density[((o.time - start) / 1000) as usize] += 1.0;
    }

    // peak: densest 2 s window (two pointers over sorted start times)
    let mut peak = 0usize;
    let mut lo = 0usize;
    for hi in 0..objs.len() {
        while objs[hi].time - objs[lo].time >= 2000 {
            lo += 1;
        }
        peak = peak.max(hi - lo + 1);
    }

    let mut a = Analysis {
        start,
        end,
        drain,
        notes,
        holds,
        nps_avg: notes as f32 / (drain as f32 / 1000.0),
        nps_peak: peak as f32 / 2.0,
        density,
        ..Default::default()
    };
    if chart.mode == 3 && chart.keys > 0 {
        mania(chart, &mut a);
    } else {
        // without patterns, "burst" is the longest run of seconds with ≥ LIGHT_ROWS objects
        a.longest_burst = longest_run(a.density.iter().map(|&n| n as usize >= LIGHT_ROWS)) * WINDOW;
    }
    a
}

fn mania(chart: &Chart, a: &mut Analysis) {
    let keys = chart.keys as usize;
    let objs = &chart.objects;
    a.lanes = vec![0; keys];
    for o in objs {
        a.lanes[(o.lane as usize).min(keys - 1)] += 1;
    }

    // rows (chords): objects are sorted by (time, lane); allow 1 ms of jitter
    let mut rows: Vec<Row> = Vec::new();
    for o in objs {
        let bit = 1u32 << o.lane.min(31);
        match rows.last_mut() {
            Some(r) if o.time - r.time <= 1 => {
                if r.mask & bit == 0 {
                    r.mask |= bit;
                    r.size += 1;
                }
            }
            _ => rows.push(Row { time: o.time, mask: bit, size: 1 }),
        }
    }
    for r in &rows {
        a.chords[(r.size.clamp(1, 4) - 1) as usize] += 1;
    }
    let jack = |i: usize| i > 0 && rows[i].mask & rows[i - 1].mask != 0;
    a.jack_ratio = (1..rows.len()).filter(|&i| jack(i)).count() as f32 / rows.len().max(1) as f32;

    // long-note coverage: merged hold intervals
    let mut spans: Vec<(i32, i32)> = objs.iter().filter(|o| o.kind == Kind::Hold && o.end > o.time).map(|o| (o.time, o.end)).collect();
    spans.sort_unstable();
    let mut merged: Vec<(i32, i32)> = Vec::new();
    for (s, e) in spans {
        match merged.last_mut() {
            Some(m) if s <= m.1 => m.1 = m.1.max(e),
            _ => merged.push((s, e)),
        }
    }
    a.ln_time = (merged.iter().map(|(s, e)| e - s).sum::<i32>() as f32 / a.drain as f32).min(1.0);

    // one-second windows
    let windows = ((a.end - a.start) / WINDOW + 1) as usize;
    let in_break = |t: i32| chart.breaks.iter().any(|&(s, e)| t >= s && t < e);
    let mut counts = [0usize; 6];
    let mut considered = 0usize;
    let mut dense: Vec<bool> = Vec::with_capacity(windows);
    let mut labels: Vec<Option<Pattern>> = Vec::with_capacity(windows);
    let mut ri = 0usize;
    let mut mi = 0usize;
    for w in 0..windows {
        let w0 = a.start + w as i32 * WINDOW;
        let w1 = w0 + WINDOW;
        let first = ri;
        while ri < rows.len() && rows[ri].time < w1 {
            ri += 1;
        }
        let in_window = first..ri;
        // long-note time inside this window
        while mi < merged.len() && merged[mi].1 <= w0 {
            mi += 1;
        }
        let ln: i32 = merged[mi..].iter().take_while(|m| m.0 < w1).map(|&(s, e)| e.min(w1) - s.max(w0)).sum();

        if in_window.is_empty() && ln == 0 {
            labels.push(None);
            if !in_break(w0) {
                dense.push(false);
            }
            continue;
        }
        considered += 1;
        let pattern = classify(&rows, in_window, ln as f32 / WINDOW as f32, &jack);
        dense.push(pattern.is_some());
        labels.push(pattern);
        if let Some(p) = pattern {
            counts[Pattern::ALL.iter().position(|x| *x == p).unwrap()] += 1;
        }
    }

    let mut patterns: Vec<Share> = Pattern::ALL
        .iter()
        .zip(counts)
        .filter(|(_, n)| *n > 0)
        .map(|(&pattern, n)| Share { pattern, share: n as f32 / considered.max(1) as f32 })
        .collect();
    patterns.sort_by(|x, y| y.share.total_cmp(&x.share));
    a.longest_burst = longest_run(dense.into_iter()) * WINDOW;
    a.tags = patterns.iter().filter(|s| s.share >= TAG_SHARE).take(3).map(|s| s.pattern.name()).collect();
    if a.longest_burst >= STAMINA_MS {
        a.tags.push("stamina");
    }
    a.patterns = patterns;
    a.windows = labels;
}

/// The dominant shape of one window, or `None` if it's light.
fn classify(rows: &[Row], range: std::ops::Range<usize>, ln_share: f32, jack: &impl Fn(usize) -> bool) -> Option<Pattern> {
    if ln_share >= 0.5 {
        return Some(Pattern::Ln);
    }
    let n = range.len();
    if n < LIGHT_ROWS {
        return None;
    }
    let share = |f: &dyn Fn(usize) -> bool| range.clone().filter(|&i| f(i)).count() as f32 / n as f32;
    let jacks = share(&|i| jack(i));
    let multi = share(&|i| rows[i].size >= 2);
    let big = share(&|i| rows[i].size >= 3);
    Some(if jacks >= 0.4 {
        if multi >= 0.5 { Pattern::Chordjack } else { Pattern::Jacks }
    } else if big >= 0.25 {
        Pattern::Handstream
    } else if multi >= 0.2 {
        Pattern::Jumpstream
    } else {
        Pattern::Stream
    })
}

fn longest_run(it: impl Iterator<Item = bool>) -> i32 {
    let (mut best, mut cur) = (0, 0);
    for on in it {
        cur = if on { cur + 1 } else { 0 };
        best = best.max(cur);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::{HitObject, Kind};

    /// 4K chart from rows of columns, one row every `gap` ms for `secs` seconds.
    fn chart(pattern: &[&[u8]], gap: i32, secs: i32) -> Chart {
        let mut objects = Vec::new();
        let mut t = 0;
        let mut i = 0;
        while t < secs * 1000 {
            for &lane in pattern[i % pattern.len()] {
                objects.push(HitObject { time: t, end: t, x: 0, kind: Kind::Circle, lane });
            }
            t += gap;
            i += 1;
        }
        Chart { mode: 3, keys: 4, timing: vec![], objects, breaks: vec![] }
    }

    fn top(c: &Chart) -> Pattern {
        analyse(c).patterns[0].pattern
    }

    #[test]
    fn recognises_basic_shapes() {
        assert_eq!(top(&chart(&[&[0], &[1], &[2], &[3]], 100, 10)), Pattern::Stream);
        assert_eq!(top(&chart(&[&[0, 1], &[2], &[3], &[0, 2], &[1], &[3]], 100, 10)), Pattern::Jumpstream);
        assert_eq!(top(&chart(&[&[0, 1, 2], &[3], &[0, 1, 2], &[3], &[1], &[0, 2, 3], &[1], &[3]], 100, 10)), Pattern::Handstream);
        assert_eq!(top(&chart(&[&[0, 1], &[1, 2], &[2, 3], &[0, 3]], 120, 10)), Pattern::Chordjack);
        assert_eq!(top(&chart(&[&[0], &[0], &[0], &[1]], 120, 10)), Pattern::Jacks);
    }

    #[test]
    fn light_charts_get_no_tags() {
        let a = analyse(&chart(&[&[0], &[2]], 500, 30));
        assert!(a.patterns.is_empty());
        assert!(a.tags.is_empty());
        assert_eq!(a.longest_burst, 0);
    }

    #[test]
    fn long_notes_and_stats() {
        let mut c = chart(&[&[0], &[1], &[2], &[3]], 250, 20);
        for o in c.objects.iter_mut() {
            o.kind = Kind::Hold;
            o.end = o.time + 600;
        }
        let a = analyse(&c);
        assert_eq!(a.patterns[0].pattern, Pattern::Ln);
        assert!(a.ln_time > 0.9);
        assert_eq!(a.lanes, vec![20, 20, 20, 20]);
        assert_eq!(a.chords, [80, 0, 0, 0]);
        assert_eq!(a.tags, vec!["ln"]);
    }

    #[test]
    fn density_peak_and_stamina() {
        let a = analyse(&chart(&[&[0], &[1], &[2], &[3]], 100, 70));
        assert_eq!(a.density.len(), 70);
        assert!((a.density[5] - 10.0).abs() < 1e-6);
        assert!((a.nps_peak - 10.0).abs() < 1e-6);
        assert!(a.longest_burst >= 69_000);
        assert!(a.tags.contains(&"stamina"));
    }

    #[test]
    fn breaks_are_not_light_seconds() {
        let mut c = chart(&[&[0], &[1], &[2], &[3]], 100, 10);
        let tail: Vec<HitObject> = c.objects.iter().map(|o| HitObject { time: o.time + 20_000, end: o.end + 20_000, ..*o }).collect();
        c.objects.extend(tail);
        c.breaks = vec![(10_500, 19_500)];
        let a = analyse(&c);
        assert_eq!(a.patterns[0].pattern, Pattern::Stream);
        // the gap is a break, so both halves count as one burst minus the uncovered edges
        assert!(a.drain < 22_000);
    }

    #[test]
    fn every_second_has_a_label() {
        let mut c = chart(&[&[0], &[1], &[2], &[3]], 100, 10);
        let tail: Vec<HitObject> = c.objects.iter().map(|o| HitObject { time: o.time + 20_000, end: o.end + 20_000, ..*o }).collect();
        c.objects.extend(tail);
        let a = analyse(&c);
        assert_eq!(a.windows.len(), a.density.len());
        assert_eq!(a.windows[3], Some(Pattern::Stream));
        // the empty stretch between the halves has no pattern
        assert_eq!(a.windows[15], None);
        assert_eq!(a.windows[25], Some(Pattern::Stream));
    }
}
