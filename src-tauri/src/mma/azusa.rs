//! Azusa, ManiaMapAnalyser's 4K rice dan estimator (`azusaEstimator.js`, documented in its
//! `docs/azusa_algorithm.md`).
//!
//! It follows five skills over the chart (speed, stamina, chords, tech, jacks) through decaying
//! strain, reads their peaks and sustained levels into a number on the dan scale, blends that
//! with the Daniel and Sunny star ratings (each mapped onto the same scale), and calibrates the
//! blend against the dans of rated charts. The scale: Intro 1–3 = −2…0, Reform 1–10 = 1…10,
//! Alpha = 11 … Kappa = 20.

use super::{daniel, sunny, Note};

const LN_RATIO_LIMIT: f64 = 0.18;
const MIN_NOTES: usize = 80;
const ROW_TOLERANCE_MS: f64 = 2.0;
const DECAY_WINDOWS_MS: [f64; 4] = [140.0, 280.0, 560.0, 980.0];
const DECAY_WEIGHTS: [f64; 4] = [0.34, 0.30, 0.22, 0.14];
const LENGTH_REF_NOTES: f64 = 600.0;
const LENGTH_EXPONENT: f64 = 0.22;
const LENGTH_CAP: f64 = 3.5;

const CALIBRATION_LOW_BLOCKS: [[f64; 3]; 17] = [
    [1.9220, 1.9220, 1.0000],
    [2.3660, 2.7684, 1.6667],
    [2.8394, 2.8394, 2.0000],
    [2.8584, 3.7162, 2.3333],
    [3.7798, 3.7798, 3.0000],
    [3.8667, 3.8667, 3.0000],
    [4.2067, 5.2039, 4.3333],
    [5.2506, 5.7713, 5.0667],
    [5.8603, 6.1512, 5.3333],
    [6.3292, 6.8785, 6.0000],
    [7.1715, 7.3617, 6.2000],
    [7.4079, 7.8734, 7.2000],
    [8.0160, 8.4003, 8.2500],
    [8.4133, 8.4133, 9.0000],
    [8.9031, 9.4775, 9.5667],
    [9.6488, 9.6488, 10.0000],
    [9.8301, 9.8301, 10.3000],
];

const CALIBRATION_HIGH_BLOCKS: [[f64; 3]; 43] = [
    [11.4336, 11.4336, 10.4000],
    [11.4436, 11.4436, 10.5000],
    [11.6012, 11.6665, 10.6500],
    [11.6696, 12.2317, 11.5000],
    [12.3295, 12.3919, 11.7500],
    [12.5238, 12.5238, 12.0000],
    [12.5318, 12.8329, 12.1400],
    [12.8605, 12.9781, 12.2800],
    [12.9868, 13.1170, 12.7800],
    [13.2003, 13.4418, 12.7857],
    [13.4660, 13.5829, 12.9250],
    [13.6044, 13.9924, 13.3667],
    [14.0583, 14.0583, 13.4000],
    [14.0795, 14.2266, 13.4600],
    [14.2346, 14.2346, 13.6000],
    [14.2414, 14.2414, 13.7000],
    [14.2903, 14.2903, 14.0000],
    [14.3258, 14.4760, 14.1200],
    [14.5365, 14.6006, 14.1333],
    [14.7269, 14.8716, 14.1333],
    [15.0048, 15.0048, 14.4000],
    [15.0521, 15.0521, 14.4000],
    [15.0521, 15.0521, 14.4000],
    [15.0950, 15.0950, 14.4000],
    [15.2335, 15.2335, 14.4000],
    [15.2388, 15.5821, 14.7385],
    [15.6977, 15.7002, 14.8500],
    [15.7535, 16.1593, 15.0667],
    [16.2009, 16.2958, 15.1000],
    [16.3172, 16.4748, 15.7600],
    [16.5620, 16.9083, 15.9833],
    [16.9485, 16.9485, 16.0000],
    [17.0216, 17.3799, 16.1000],
    [17.4616, 17.4616, 16.4000],
    [17.5167, 17.5167, 16.4000],
    [17.5306, 17.9077, 16.6400],
    [18.1973, 18.1973, 17.2000],
    [18.2026, 18.2026, 17.2000],
    [18.4562, 19.3477, 17.9500],
    [19.3477, 20.5000, 18.2000],
    [20.5000, 22.0000, 18.6000],
    [22.0000, 24.0000, 19.2000],
    [24.0000, 27.0000, 20.0000],
];

const ISOTONIC_POINTS: [[f64; 2]; 84] = [
    [1.3868, 1.0000],
    [1.4574, 1.0000],
    [1.5361, 1.0000],
    [1.6320, 1.5000],
    [1.9833, 2.5800],
    [2.2465, 2.6000],
    [2.3344, 2.8000],
    [2.5779, 3.4500],
    [3.8277, 3.6000],
    [4.2824, 4.3429],
    [4.5665, 4.6250],
    [4.8016, 4.6750],
    [4.9529, 5.1500],
    [5.1029, 5.4000],
    [5.2475, 5.4750],
    [5.5039, 5.9000],
    [5.6951, 6.0143],
    [5.9213, 6.4000],
    [6.0093, 6.9000],
    [6.1337, 7.2000],
    [6.7092, 7.4400],
    [7.2846, 7.5000],
    [7.4233, 7.8000],
    [7.9790, 8.6000],
    [8.2927, 8.6143],
    [9.0829, 9.5000],
    [9.4639, 9.6154],
    [9.8115, 10.0000],
    [9.8344, 10.4000],
    [10.0013, 10.4000],
    [10.0778, 10.5000],
    [10.1054, 10.5000],
    [10.1435, 10.6000],
    [10.4782, 10.6462],
    [10.8866, 10.8000],
    [11.0934, 11.1727],
    [11.3266, 11.2867],
    [11.4970, 11.4000],
    [11.6024, 11.4750],
    [11.6947, 11.6000],
    [11.8932, 12.0636],
    [12.0076, 12.3000],
    [12.2947, 12.4150],
    [12.7583, 12.4500],
    [12.8756, 12.9000],
    [12.9268, 12.9000],
    [13.0042, 13.2000],
    [13.2387, 13.2694],
    [13.4620, 13.4400],
    [13.5467, 13.5000],
    [13.6016, 13.7375],
    [13.9609, 13.9500],
    [14.1414, 14.0250],
    [14.2226, 14.0762],
    [14.3178, 14.1273],
    [14.3786, 14.1643],
    [14.4421, 14.2182],
    [14.4825, 14.3000],
    [14.5063, 14.3750],
    [14.5452, 14.4778],
    [14.6359, 14.5850],
    [14.7301, 14.6389],
    [14.8846, 14.7906],
    [15.0424, 14.9263],
    [15.2159, 15.0944],
    [15.3942, 15.1875],
    [15.5380, 15.3300],
    [15.8096, 15.5320],
    [16.0262, 16.1000],
    [16.0702, 16.1000],
    [16.2738, 16.1267],
    [16.4723, 16.3579],
    [16.7156, 16.8000],
    [17.1446, 17.0600],
    [17.5478, 17.2000],
    [17.6403, 17.2000],
    [17.7603, 17.2000],
    [17.8264, 17.6000],
    [18.1258, 17.9750],
    [18.5000, 18.2000],
    [19.2000, 18.7000],
    [20.0000, 19.2000],
    [21.2000, 19.8000],
    [22.5000, 20.0000],
];

fn safe_div(a: f64, b: f64, fallback: f64) -> f64 {
    if !a.is_finite() || !b.is_finite() || b.abs() < 1e-9 {
        fallback
    } else {
        a / b
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn piecewise_linear(v: f64, knots: &[[f64; 2]]) -> f64 {
    if !v.is_finite() || knots.is_empty() {
        return v;
    }
    let last = knots.len() - 1;
    if v <= knots[0][0] {
        return knots[0][1];
    }
    if v >= knots[last][0] {
        return knots[last][1];
    }
    for w in knots.windows(2) {
        let ([x0, y0], [x1, y1]) = (w[0], w[1]);
        if v >= x0 && v <= x1 {
            return y0 + safe_div((v - x0) * (y1 - y0), x1 - x0, 0.0);
        }
    }
    v
}

fn piecewise_block(v: f64, blocks: &[[f64; 3]]) -> f64 {
    if !v.is_finite() || blocks.is_empty() {
        return v;
    }
    if v <= blocks[0][0] {
        return blocks[0][2];
    }
    let last = blocks.len() - 1;
    for i in 0..blocks.len() {
        let [x0, x1, y] = blocks[i];
        if v >= x0 && v <= x1 {
            return y;
        }
        if i < last && v > x1 && v < blocks[i + 1][0] {
            let t = safe_div(v - x1, blocks[i + 1][0] - x1, 0.0);
            return y * (1.0 - t) + blocks[i + 1][2] * t;
        }
    }
    blocks[last][2]
}

fn quantile_sorted(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let t = q.clamp(0.0, 1.0) * (sorted.len() - 1) as f64;
    let left = t.floor() as usize;
    let right = (left + 1).min(sorted.len() - 1);
    let w = t - left as f64;
    sorted[left] * (1.0 - w) + sorted[right] * w
}

fn power_mean(values: &[f64], p: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let acc: f64 = values.iter().map(|v| v.max(0.0).powf(p)).sum();
    (acc / values.len() as f64).powf(1.0 / p)
}

struct Tap {
    t: f64,
    c: usize,
    hand: usize,
    row: usize,
}

/// The five skill series over the chart, and what Azusa's corrections read from it.
struct Curve {
    /// speed, stamina, chord, tech, jack (the analyser also blends them per note, but only
    /// checks that blend for emptiness)
    skills: [Vec<f64>; 5],
    times: Vec<f64>,
    density250: Vec<f64>,
    density500: Vec<f64>,
    jack_raw: Vec<f64>,
    column_counts: [usize; 4],
    chord_notes: usize,
}

fn difficulty_curve(taps: &[Tap]) -> Curve {
    let mut states = [[0.0f64; 4]; 5];
    let mut last_col = [-1e9f64; 4];
    let mut last_hand = [-1e9f64; 2];
    let mut c = Curve {
        skills: Default::default(),
        times: Vec::with_capacity(taps.len()),
        density250: Vec::with_capacity(taps.len()),
        density500: Vec::with_capacity(taps.len()),
        jack_raw: Vec::with_capacity(taps.len()),
        column_counts: [0; 4],
        chord_notes: 0,
    };
    let (mut cur250, mut cur500) = (0usize, 0usize);
    let mut prev_time = taps.first().map_or(0.0, |t| t.t);
    let (mut prev_any1, mut prev_any2) = (-1e9f64, -1e9f64);
    let mut prev_col = 0usize;
    for (i, n) in taps.iter().enumerate() {
        let t = n.t;
        c.column_counts[n.c] += 1;
        if n.row >= 2 {
            c.chord_notes += 1;
        }
        let dt_global = if i == 0 { 0.0 } else { (t - prev_time).max(0.0) };
        let dt_same = (t - last_col[n.c]).max(0.0);
        let dt_hand = (t - last_hand[n.hand]).max(0.0);
        let dt_any = (t - prev_any1).max(0.0);
        while cur250 < i && t - taps[cur250].t > 250.0 {
            cur250 += 1;
        }
        while cur500 < i && t - taps[cur500].t > 500.0 {
            cur500 += 1;
        }
        let d250 = (i - cur250 + 1) as f64 / 0.25;
        let d500 = (i - cur500 + 1) as f64 / 0.5;
        c.density250.push(d250);
        c.density500.push(d500);

        let jack = (190.0 / (dt_same + 35.0)).powf(1.16);
        c.jack_raw.push(jack);
        let stream = (170.0 / (dt_any + 30.0)).powf(1.07);
        let hand_stream = (185.0 / (dt_hand + 42.0)).powf(1.08);
        let movement = (n.c as f64 - prev_col as f64).abs() / 3.0;
        let rhythm_ratio = safe_div(dt_any.max(1.0), (t - prev_any2).max(1.0), 1.0);
        let rhythm_chaos = rhythm_ratio.clamp(0.2, 5.0).log2().abs();
        let row_chord = n.row.saturating_sub(1) as f64;
        let chord = (row_chord + 1.0).powf(1.22) - 1.0;

        let inputs = [
            0.60 * stream + 0.30 * hand_stream + 0.10 * jack,
            0.48 * (d500 / 11.0) + 0.27 * (d250 / 15.0) + 0.25 * stream,
            chord * (1.0 + 0.10 * stream.min(1.5)),
            0.45 * rhythm_chaos + 0.30 * movement + 0.25 * (if row_chord > 0.0 { 1.0 + 0.3 * row_chord } else { 0.0 }),
            jack * (1.0 + 0.15 * chord),
        ];
        for (j, &tau) in DECAY_WINDOWS_MS.iter().enumerate() {
            let decay = if dt_global <= 0.0 { 1.0 } else { (-dt_global / tau).exp() };
            for s in 0..5 {
                states[s][j] = states[s][j] * decay + inputs[s];
            }
        }
        for s in 0..5 {
            c.skills[s].push(states[s].iter().zip(DECAY_WEIGHTS).map(|(v, w)| v * w).sum());
        }
        c.times.push(t);
        prev_any2 = prev_any1;
        prev_any1 = t;
        prev_time = t;
        prev_col = n.c;
        last_col[n.c] = t;
        last_hand[n.hand] = t;
    }
    c
}

struct Summary {
    q97: f64,
    q90: f64,
    q75: f64,
    q50: f64,
    tail_mean: f64,
}

fn summarize(values: &[f64]) -> Summary {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let tail = 8.max((sorted.len() as f64 * 0.04).floor() as usize).min(sorted.len());
    let tail_slice = &sorted[sorted.len() - tail..];
    Summary {
        q97: quantile_sorted(&sorted, 0.97),
        q90: quantile_sorted(&sorted, 0.90),
        q75: quantile_sorted(&sorted, 0.75),
        q50: quantile_sorted(&sorted, 0.50),
        tail_mean: tail_slice.iter().sum::<f64>() / tail_slice.len().max(1) as f64,
    }
}

/// Chord and jack shape of the chart, read by the blend's corrections.
struct Hints {
    anchor_imbalance: f64,
    chord_rate: f64,
    jack_q95: f64,
}

fn hints(curve: &Curve, notes: usize) -> Hints {
    let max_col = *curve.column_counts.iter().max().unwrap_or(&0) as f64;
    let n = notes.max(1) as f64;
    let mut jack = curve.jack_raw.clone();
    jack.sort_by(f64::total_cmp);
    Hints {
        anchor_imbalance: safe_div(max_col / n - 0.25, 0.75, 0.0),
        chord_rate: safe_div(curve.chord_notes as f64, n, 0.0),
        jack_q95: quantile_sorted(&jack, 0.95),
    }
}

/// Azusa's own reading of the skill curve, on the dan scale.
fn primary_numeric(curve: &Curve, notes: usize, h: &Hints) -> f64 {
    if curve.times.is_empty() {
        return 0.0;
    }
    let [speed, stamina, chord, tech, jack] = [0, 1, 2, 3, 4].map(|i| summarize(&curve.skills[i]));
    let d250 = power_mean(&curve.density250, 1.18);
    let d500 = power_mean(&curve.density500, 1.12);
    let length = LENGTH_CAP.min((notes.max(1) as f64 / LENGTH_REF_NOTES).powf(LENGTH_EXPONENT));

    let peak = 0.26 * speed.q97 + 0.22 * stamina.q97 + 0.10 * chord.q97 + 0.10 * tech.q97 + 0.10 * jack.q97
        + 0.06 * speed.q90
        + 0.04 * stamina.q90
        + 0.02 * chord.q90
        + 0.02 * tech.q90
        + 0.02 * jack.q90;
    let sustain = 0.18 * speed.q75 + 0.16 * stamina.q75 + 0.08 * chord.q75 + 0.06 * tech.q75 + 0.08 * jack.q75
        + 0.10 * speed.tail_mean
        + 0.08 * stamina.tail_mean
        + 0.04 * chord.tail_mean
        + 0.04 * tech.tail_mean
        + 0.04 * jack.tail_mean;
    let density = 0.14 * d250.ln_1p() + 0.22 * d500.ln_1p();
    let mid = 0.16 * speed.q50 + 0.13 * stamina.q50 + 0.06 * chord.q50 + 0.06 * tech.q50 + 0.06 * jack.q50;
    let raw = 0.52 * peak + 0.26 * sustain + 0.10 * density + 0.08 * mid + 0.04 * length;
    let scaled = 0.82 + 0.43 * raw;

    // chordjack: chord density and jack density together
    let chordjack = (2.5
        * ((h.chord_rate - 0.40) * 3.5).clamp(0.0, 1.0)
        * ((h.jack_q95 - 1.25) * 2.8).clamp(0.0, 1.0)
        * (1.0 - h.anchor_imbalance * 8.0).clamp(0.0, 1.0))
    .clamp(0.0, 2.2);
    let seconds = ((curve.times[curve.times.len() - 1] - curve.times[0]) / 1000.0).max(1.0);
    let nps = notes as f64 / seconds;
    let mid_speed = ((nps - 9.0) * 0.04).clamp(0.0, 0.35) * ((19.0 - nps) * 0.25).clamp(0.0, 1.0);
    (scaled + chordjack + mid_speed).clamp(-2.0, 20.0)
}

struct Blend {
    value: Option<f64>,
    low_gate: Option<f64>,
    high_gate: Option<f64>,
}

fn blend(primary: Option<f64>, daniel: Option<f64>, sunny: Option<f64>, h: &Hints) -> Blend {
    if daniel.is_none() && primary.is_none() && sunny.is_none() {
        return Blend { value: None, low_gate: None, high_gate: None };
    }
    let gate_source = daniel.or(sunny).or(primary).unwrap_or(0.0);
    let low_gate = ((9.61 - gate_source) / 4.94).clamp(0.0, 1.0);
    let high_gate = 1.0 - low_gate;

    let low_base = sunny.map(|s| {
        let mut v = -8.317 + 1.536 * s;
        if let Some(p) = primary {
            v += 0.011 * p;
        }
        if let Some(d) = daniel {
            v += 0.049 * d;
        }
        if low_gate > 0.0 {
            let primary_part = primary.map_or(0.0, |p| (p - 10.4).max(0.0));
            let sunny_part = (s - 9.84).max(0.0);
            let convex = (7.935 - s).max(0.0).powi(2);
            v += low_gate * (0.442 * sunny_part + 0.016 * primary_part + 0.235 * convex);
        }
        v
    });
    let high_base = daniel.or(sunny).or(primary).map(|d| {
        let p = primary.unwrap_or(d);
        let s = sunny.unwrap_or(d);
        let mut v = 0.809 * d + 0.057 * p + 0.165 * s + 0.183;
        let mask = ((gate_source - 14.83) / 2.667).clamp(0.0, 1.0);
        if mask > 0.0 {
            v += mask * (-0.154 * (p - d).max(0.0) + 0.081 * (s - d).max(0.0));
        }
        v + (0.20 * (h.jack_q95 - 2.08).max(0.0) * (0.24 - h.chord_rate).max(0.0) * (h.anchor_imbalance - 0.10).max(0.0)).clamp(0.0, 0.25)
    });
    let low_lift = (9.889 - gate_source).max(0.0) * 0.257;
    let value = match (low_base, high_base) {
        (None, None) => None,
        (None, Some(hb)) => Some(hb),
        (Some(lb), None) => Some(lb + low_lift),
        (Some(lb), Some(hb)) => Some(lb * low_gate + (hb + low_lift) * high_gate),
    };
    Blend { value, low_gate: Some(low_gate), high_gate: Some(high_gate) }
}

fn calibrate(v: f64, low_gate: Option<f64>, high_gate: Option<f64>) -> f64 {
    if !v.is_finite() {
        return v;
    }
    let low = piecewise_block(v, &CALIBRATION_LOW_BLOCKS);
    let high = piecewise_block(v, &CALIBRATION_HIGH_BLOCKS);
    let lg = low_gate.map(|g| g.clamp(0.0, 1.0));
    let hg = high_gate.map(|g| g.clamp(0.0, 1.0));
    if lg.is_none() && hg.is_none() {
        return if v < 11.0 { low } else { high };
    }
    let lw = lg.unwrap_or_else(|| (1.0 - hg.unwrap_or(0.0)).max(0.0));
    let hw = hg.unwrap_or((1.0 - lw).max(0.0));
    let ws = lw + hw;
    if ws <= 1e-6 {
        return if v < 11.0 { low } else { high };
    }
    (lw * low + hw * high) / ws
}

fn curve_gap_residual(x: f64, high_gate: f64, h: &Hints, primary: f64, sunny: Option<f64>, daniel: Option<f64>) -> f64 {
    let hg = high_gate.clamp(0.0, 1.0);
    let sunny = sunny.unwrap_or(x);
    let daniel = daniel.unwrap_or(x);
    let ds = daniel - sunny;
    let sp = sunny - primary;
    let (ai, cr, jq) = (h.anchor_imbalance, h.chord_rate, h.jack_q95);
    let r = 4.335282 - 0.170459 * x - 1.622303 * (11.0 - x).max(0.0) + 1.328125 * (12.5 - x).max(0.0) - 0.042829 * (14.0 - x).max(0.0)
        - 0.834997 * hg
        + 3.060352 * hg * (11.0 - x).max(0.0)
        - 1.744638 * hg * (12.5 - x).max(0.0)
        + 0.409922 * ds
        + 0.041072 * sp
        - 0.388231 * hg * ds
        - 0.170185 * hg * sp
        + 3.466868 * ai
        - 1.743778 * cr
        - 0.094758 * jq
        + 2.626366 * ai * jq
        + 1.836357 * cr * jq
        - 2.612648 * hg * ai
        - 2.493596 * hg * cr;
    r.clamp(-1.2, 1.2)
}

fn reference_correction(x: f64, daniel: Option<f64>, sunny: Option<f64>) -> f64 {
    if !x.is_finite() || !(10.0..=17.5).contains(&x) {
        return 0.0;
    }
    let (gate, cd, cs) = if x < 11.5 {
        (((x - 10.0) / 1.5).clamp(0.0, 1.0), 0.10, 0.06)
    } else if x < 12.5 {
        (1.0, 0.20, 0.13)
    } else if x < 16.0 {
        (1.0, 0.40, 0.25)
    } else {
        (((17.5 - x) / 1.5).clamp(0.0, 1.0), 0.28, 0.17)
    };
    let mut c = 0.0;
    if let Some(d) = daniel {
        c += cd * (d - x);
    }
    if let Some(s) = sunny {
        c += cs * (s - x);
    }
    (c * gate).clamp(-1.2, 1.2)
}

/// Daniel's star rating on the dan scale: its own tier reading where it has one, else a curve
/// through its star rating. The flag says whether it was the tier reading.
fn daniel_numeric(star: f64) -> (f64, bool) {
    if let Some(n) = daniel::dan_numeric(star) {
        return (n, true);
    }
    if star >= 6.56 {
        return (round2(11.0 + ((star - 6.56) / 0.58).clamp(0.0, 9.99)), false);
    }
    (round2(-2.0 + 13.0 * (star / 6.56).clamp(0.0, 1.0).powf(1.72)), false)
}

/// The Azusa dan number of a 4K rice chart at a clock rate; `None` outside its scope (other key
/// counts, more than 18 % long notes, fewer than 80 notes). `sunny_taps`: the Sunny star rating
/// with long notes as taps, when the caller has it already (the plain one, for charts without
/// long notes).
pub fn numeric(notes: &[Note], keys: usize, od: f64, ln_ratio: f64, rate: f64, sunny_taps: Option<f64>) -> Option<f64> {
    if keys != 4 || ln_ratio > LN_RATIO_LIMIT || notes.len() < MIN_NOTES {
        return None;
    }
    let rate = if rate.is_finite() && rate > 0.0 { rate } else { 1.0 };
    let scale = 1.0 / rate;
    let mut taps: Vec<Tap> = notes.iter().map(|n| Tap { t: n.start as f64, c: n.col.min(3), hand: usize::from(n.col >= 2), row: 1 }).collect();
    taps.sort_by(|a, b| a.t.total_cmp(&b.t).then(a.c.cmp(&b.c)));
    for t in &mut taps {
        t.t *= scale;
    }
    // rows: notes within the tolerance of a row's first note
    let tol = ROW_TOLERANCE_MS * scale;
    let mut start = 0;
    for i in 1..=taps.len() {
        if i == taps.len() || (taps[i].t - taps[start].t).abs() > tol {
            for t in &mut taps[start..i] {
                t.row = i - start;
            }
            start = i;
        }
    }

    let curve = difficulty_curve(&taps);
    let h = hints(&curve, taps.len());
    let primary = primary_numeric(&curve, taps.len(), &h);

    let (mut daniel, native) = match daniel::star(notes, keys, rate) {
        Some(s) => {
            let (n, native) = daniel_numeric(s);
            (Some(n), native)
        }
        None => (None, false),
    };
    // the Sunny reference counts long notes as taps ("HO")
    let sunny = sunny_taps.or_else(|| sunny::star(notes, keys, od, rate, true)).map(|s| round2((2.85 + 1.33 * s).clamp(-2.0, 20.0)));

    // outside Daniel's tiers its curve only speaks up at clock rates away from 1×
    if let Some(d) = daniel.filter(|_| !native) {
        let high = primary.max(sunny.unwrap_or(f64::NEG_INFINITY)).max(d);
        if high < 14.0 {
            let delta = rate - 1.0;
            let scale = if delta < 0.0 { (-delta * 0.43).clamp(0.0, 1.0) } else { (delta * 0.35).clamp(0.0, 1.0) };
            daniel = Some(d * scale);
        }
    }

    let b = blend(Some(primary), daniel, sunny, &h);
    let calibrated = calibrate(b.value?, b.low_gate, b.high_gate);
    let residual = curve_gap_residual(calibrated, b.high_gate.unwrap_or(0.0), &h, primary, sunny, daniel);
    let pre = (calibrated + residual).clamp(-2.0, 20.0);
    let out = piecewise_linear(pre, &ISOTONIC_POINTS);
    let fin = (out + reference_correction(out, daniel, sunny)).clamp(-2.0, 20.0);
    fin.is_finite().then_some(fin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_tables_interpolate() {
        // inside a block: its value; between blocks: linear
        assert_eq!(piecewise_block(3.0, &CALIBRATION_LOW_BLOCKS), 2.3333);
        let mid = piecewise_block((3.7162 + 3.7798) / 2.0, &CALIBRATION_LOW_BLOCKS);
        assert!((mid - (2.3333 + 3.0) / 2.0).abs() < 1e-9);
        assert_eq!(piecewise_linear(0.0, &ISOTONIC_POINTS), 1.0);
        assert_eq!(piecewise_linear(30.0, &ISOTONIC_POINTS), 20.0);
        assert_eq!(quantile_sorted(&[0.0, 10.0], 0.25), 2.5);
    }

    #[test]
    fn daniel_scale() {
        // Alpha's mean sits in the middle of Alpha
        let (n, native) = daniel_numeric(6.562);
        assert!(native && (n - 11.5).abs() < 0.05, "{n}");
        assert_eq!(daniel_numeric(3.0).1, false);
    }
}
