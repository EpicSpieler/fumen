//! Sunny's osu!mania star rating rework (Star-Rating-Rebirth by sunnyxxy), as ManiaMapAnalyser
//! runs it (`sunnyAlgorithm.js`, synced with its C# port).
//!
//! The chart is sampled at "corners" (every head and tail, and points 0.5 s / 1 s around them).
//! At each corner it measures jack speed per column (J), cross-column movement (X), overall
//! pressure including long-note bodies (P), how unevenly columns move (A), release density (R),
//! note count (C) and the number of active keys (Ks), combines them into a difficulty D, and
//! rates the chart by D's weighted upper percentiles and power mean.

use super::core::{
    aggregate, bisect_left, bisect_right, corners, gaps, hit_leniency, interp_values, jack_nerfer, merge_by_head, rescale_high,
    smooth_on_corners, step_interp, union, Smooth, CROSS_MATRIX,
};
use super::Note;

#[derive(Clone, Copy)]
struct N {
    k: usize,
    h: f64,
    /// tail, or −1 for a tap
    t: f64,
}

/// The Sunny star rating at a clock rate. With `hold_off`, long notes count as taps (the
/// "HO" conversion Azusa uses for its reference). `None` for charts it can't rate.
pub fn star(notes: &[Note], keys: usize, od: f64, rate: f64, hold_off: bool) -> Option<f64> {
    if keys == 0 || keys > 32 {
        return None;
    }
    let scale = if rate != 0.0 { 1.0 / rate } else { 1.0 };
    let mut seq: Vec<N> = notes
        .iter()
        .map(|n| N {
            k: n.col.min(keys - 1),
            h: (n.start as f64 * scale).floor(),
            t: match n.end {
                Some(e) if !hold_off && e >= 0 => (e as f64 * scale).floor(),
                _ => -1.0,
            },
        })
        .collect();
    seq.sort_by(|a, b| a.h.total_cmp(&b.h).then(a.k.cmp(&b.k)));
    // the earliest note only starts the clock (ManiaDifficultyCalculator starts at 1)
    if seq.is_empty() {
        return None;
    }
    seq.remove(0);
    if seq.is_empty() {
        return None;
    }
    let x = hit_leniency(od);
    let kk = keys;

    let mut by_col: Vec<Vec<N>> = vec![Vec::new(); kk];
    for n in &seq {
        by_col[n.k].push(*n);
    }
    let ln_seq: Vec<N> = seq.iter().filter(|n| n.t >= 0.0).copied().collect();
    let mut tail_seq = ln_seq.clone();
    tail_seq.sort_by(|a, b| a.t.total_cmp(&b.t));

    let max_head = seq.iter().map(|n| n.h).fold(f64::MIN, f64::max);
    let max_tail = seq.iter().map(|n| n.t).fold(f64::MIN, f64::max);
    let t_end = max_head.max(max_tail) as i64 + 1;
    let te = t_end as f64;

    // ── corners ──
    let mut points: Vec<i64> = Vec::with_capacity(seq.len() * 2);
    for n in &seq {
        points.push(n.h as i64);
        if n.t >= 0.0 {
            points.push(n.t as i64);
        }
    }
    points.sort_unstable();
    points.dedup();
    let mut b = points.clone();
    let mut a = points.clone();
    for &s in &points {
        b.extend([s + 501, s - 499, s + 1]);
        a.extend([s + 1000, s - 1000]);
    }
    let base = corners(b, t_end);
    let a_corners = corners(a, t_end);
    let all = union(&base, &a_corners);
    let nb = base.len();

    // ── key usage: which columns are in play around each corner ──
    let mut active = vec![0u32; nb];
    for n in &seq {
        let start = (n.h - 150.0).max(0.0);
        let end = if n.t < 0.0 { n.h + 150.0 } else { (n.t + 150.0).min(te - 1.0) };
        let (l, r) = (bisect_left(&base, start), bisect_left(&base, end));
        for m in &mut active[l..r.max(l)] {
            *m |= 1 << n.k;
        }
    }
    let cols_of = |m: u32| (0..kk).filter(move |k| m & (1 << k) != 0);

    let mut usage400 = vec![vec![0.0f64; nb]; kk];
    let coeff = 3.75 / 400f64.powi(2);
    for n in &seq {
        let start = n.h.max(0.0);
        let end = if n.t < 0.0 { n.h } else { n.t.min(te - 1.0) };
        let l400 = bisect_left(&base, start - 400.0);
        let l = bisect_left(&base, start);
        let r = bisect_left(&base, end);
        let r400 = bisect_left(&base, end + 400.0);
        let ramp = 3.75 + (end - start).min(1500.0) / 150.0;
        let u = &mut usage400[n.k];
        for idx in l..r {
            u[idx] += ramp;
        }
        for idx in l400..l {
            u[idx] += 3.75 - coeff * (base[idx] - start).powi(2);
        }
        for idx in r..r400 {
            u[idx] += 3.75 - coeff * (base[idx] - end).abs().powi(2);
        }
    }

    // ── anchor: how unevenly the busy columns share the notes ──
    let mut anchor = vec![0.0f64; nb];
    let mut counts = vec![0.0f64; kk];
    for idx in 0..nb {
        for k in 0..kk {
            counts[k] = usage400[k][idx];
        }
        counts.sort_by(|a, b| b.total_cmp(a));
        // usage is never negative, so the non-zero counts are the sorted list's head
        let nz = &counts[..counts.iter().take_while(|&&v| v != 0.0).count()];
        let raw = if nz.len() > 1 {
            let (mut walk, mut max_walk) = (0.0, 0.0);
            for i in 0..nz.len() - 1 {
                walk += nz[i] * (1.0 - 4.0 * (0.5 - nz[i + 1] / nz[i]).powi(2));
                max_walk += nz[i];
            }
            walk / max_walk
        } else {
            0.0
        };
        anchor[idx] = 1.0 + (raw - 0.18).min(5.0 * (raw - 0.22).powf(3.0));
    }

    // ── long-note bodies, as a step function with running sums ──
    let ln_rep = LnBodies::new(&ln_seq, t_end);

    // ── J: jack speed per column ──
    let mut jks = vec![vec![0.0f64; nb]; kk];
    let mut delta_ks = vec![vec![1e9f64; nb]; kk];
    let x_quarter = 0.11 * x.powf(0.25);
    for k in 0..kk {
        let col = &by_col[k];
        for i in 0..col.len().saturating_sub(1) {
            let (start, end) = (col[i].h, col[i + 1].h);
            let (l, r) = (bisect_left(&base, start), bisect_left(&base, end));
            if l >= r {
                continue;
            }
            let delta = 0.001 * (end - start);
            let val = delta.powf(-1.0) * (delta + x_quarter).powf(-1.0) * jack_nerfer(delta);
            jks[k][l..r].fill(val);
            delta_ks[k][l..r].fill(delta);
        }
    }
    let jbar_ks: Vec<Vec<f64>> = jks.iter().map(|j| smooth_on_corners(&base, j, 500.0, 0.001, Smooth::Sum)).collect();
    let jbar_base: Vec<f64> = (0..nb)
        .map(|i| {
            let (mut num, mut den) = (0.0, 0.0);
            for k in 0..kk {
                let w = 1.0 / delta_ks[k][i];
                num += jbar_ks[k][i].max(0.0).powf(5.0) * w;
                den += w;
            }
            (num / den.max(1e-9)).powf(1.0 / 5.0)
        })
        .collect();

    // ── X: movement between neighbouring columns ──
    let heads: Vec<Vec<(usize, f64)>> = by_col.iter().map(|c| c.iter().map(|n| (n.k, n.h)).collect()).collect();
    let xbar_base = if (1..=10).contains(&kk) {
        let cross = CROSS_MATRIX[kk];
        let mut xks = vec![vec![0.0f64; nb]; kk + 1];
        let mut fast = vec![vec![0.0f64; nb]; kk + 1];
        let has = |m: u32, c: isize| c >= 0 && m & (1 << c) != 0;
        for k in 0..=kk {
            let pair = if k == 0 {
                heads[0].clone()
            } else if k == kk {
                heads[kk - 1].clone()
            } else {
                merge_by_head(&heads[k - 1], &heads[k])
            };
            for i in 1..pair.len() {
                let (start, end) = (pair[i - 1].1, pair[i].1);
                let (is, ie) = (bisect_left(&base, start), bisect_left(&base, end));
                if is >= ie {
                    continue;
                }
                let delta = 0.001 * (end - start);
                let mut val = 0.16 * x.max(delta).powf(-2.0);
                let left = active[is.min(nb - 1)];
                let right = active[ie.min(nb - 1)];
                let ki = k as isize;
                if (!has(left, ki - 1) && !has(right, ki - 1)) || (!has(left, ki) && !has(right, ki)) {
                    val *= 1.0 - cross[k];
                }
                let f = (0.4 * delta.max(0.06).max(0.75 * x).powf(-2.0) - 80.0).max(0.0);
                xks[k][is..ie].fill(val);
                fast[k][is..ie].fill(f);
            }
        }
        let xb: Vec<f64> = (0..nb)
            .map(|i| {
                let mut s1 = 0.0;
                for k in 0..=kk {
                    s1 += xks[k][i] * cross[k];
                }
                let mut s2 = 0.0;
                for k in 0..kk {
                    s2 += (fast[k][i] * cross[k] * fast[k + 1][i] * cross[k + 1]).sqrt();
                }
                s1 + s2
            })
            .collect();
        smooth_on_corners(&base, &xb, 500.0, 0.001, Smooth::Sum)
    } else {
        vec![0.0; nb]
    };

    // ── P: overall pressure ──
    let mut p_step = vec![0.0f64; nb];
    let stream_booster = |delta: f64| {
        let e = 7.5 / delta;
        if 160.0 < e && e < 360.0 {
            1.0 + 1.7e-7 * (e - 160.0) * (e - 360.0).powi(2)
        } else {
            1.0
        }
    };
    for i in 0..seq.len() - 1 {
        let (hl, hr) = (seq[i].h, seq[i + 1].h);
        let dt = hr - hl;
        if dt < 1e-9 {
            let spike = 1000.0 * (0.02 * (4.0 / x - 24.0)).powf(0.25);
            for v in &mut p_step[bisect_left(&base, hl)..bisect_right(&base, hl)] {
                *v += spike;
            }
            continue;
        }
        let (l, r) = (bisect_left(&base, hl), bisect_left(&base, hr));
        if l >= r {
            continue;
        }
        let delta = 0.001 * dt;
        let v = 1.0 + 6.0 * 0.001 * ln_rep.sum(hl, hr);
        let boost = stream_booster(delta).max(v);
        let inc = if delta < 2.0 * x / 3.0 {
            delta.powf(-1.0) * (0.08 * x.powf(-1.0) * (1.0 - 24.0 * x.powf(-1.0) * (delta - x / 2.0).powi(2))).powf(0.25) * boost
        } else {
            delta.powf(-1.0) * (0.08 * x.powf(-1.0) * (1.0 - 24.0 * x.powf(-1.0) * (x / 6.0).powi(2))).powf(0.25) * boost
        };
        let inc_max = inc.max(inc * 2.0 - 10.0);
        for idx in l..r {
            p_step[idx] += (inc * anchor[idx]).min(inc_max);
        }
    }
    let pbar_base = smooth_on_corners(&base, &p_step, 500.0, 0.001, Smooth::Sum);

    // ── A: unevenness between neighbouring active columns ──
    let abar_base = unevenness(kk, &active, &delta_ks, &a_corners, &base, cols_of);

    // ── R: releases ──
    let mut r_step = vec![0.0f64; nb];
    if tail_seq.len() > 1 {
        let times: Vec<Vec<f64>> = by_col.iter().map(|c| c.iter().map(|n| n.h).collect()).collect();
        let ilist: Vec<f64> = tail_seq
            .iter()
            .map(|n| {
                let idx = bisect_left(&times[n.k], n.h);
                let next = by_col[n.k].get(idx + 1).map_or(1e9, |m| m.h);
                let ih = 0.001 * (n.t - n.h - 80.0).abs() / x;
                let it = 0.001 * (next - n.t - 80.0).abs() / x;
                2.0 / (2.0 + (-5.0 * (ih - 0.75)).exp() + (-5.0 * (it - 0.75)).exp())
            })
            .collect();
        for i in 0..tail_seq.len() - 1 {
            let (ts, tn) = (tail_seq[i].t, tail_seq[i + 1].t);
            let (l, r) = (bisect_left(&base, ts), bisect_left(&base, tn));
            if l >= r {
                continue;
            }
            let dr = 0.001 * (tn - ts);
            r_step[l..r].fill(0.08 * dr.powf(-0.5) * x.powf(-1.0) * (1.0 + 0.8 * (ilist[i] + ilist[i + 1])));
        }
    }
    let rbar_base = smooth_on_corners(&base, &r_step, 500.0, 0.001, Smooth::Sum);

    // ── C (notes within ±0.5 s; V2 counts tails too) and Ks ──
    let mut hit: Vec<f64> = seq.iter().map(|n| n.h).collect();
    hit.sort_by(f64::total_cmp);
    let mut hit2: Vec<f64> = seq.iter().flat_map(|n| if n.t >= 0.0 { vec![n.h, n.t] } else { vec![n.h] }).collect();
    hit2.sort_by(f64::total_cmp);
    let c_step = window_counts(&base, &hit);
    let c2_step = window_counts(&base, &hit2);
    let ks_step: Vec<f64> = active.iter().map(|m| (m.count_ones() as f64).max(1.0)).collect();

    let jbar = interp_values(&all, &base, &jbar_base);
    let xbar = interp_values(&all, &base, &xbar_base);
    let pbar = interp_values(&all, &base, &pbar_base);
    let abar = interp_values(&all, &a_corners, &abar_base);
    let rbar = interp_values(&all, &base, &rbar_base);
    let c_arr = step_interp(&all, &base, &c_step, true);
    let c2_arr = step_interp(&all, &base, &c2_step, true);
    let ks_arr = step_interp(&all, &base, &ks_step, true);

    let d_all: Vec<f64> = (0..all.len())
        .map(|i| {
            let left = 0.4 * (abar[i].powf(3.0 / ks_arr[i]) * jbar[i].min(8.0 + 0.85 * jbar[i])).powf(1.5);
            let right = 0.6 * (abar[i].powf(2.0 / 3.0) * (0.8 * pbar[i] + rbar[i] * 35.0 / (c_arr[i] + 8.0))).powf(1.5);
            let s = (left + right).powf(2.0 / 3.0);
            let t = (abar[i].powf(3.0 / ks_arr[i]) * xbar[i]) / (xbar[i] + s + 1.0);
            2.7 * s.powf(0.5) * t.powf(1.5) + s * 0.27
        })
        .collect();
    let g = gaps(&all);
    let weights: Vec<f64> = c2_arr.iter().zip(&g).map(|(c, g)| c * g).collect();
    let mut sr = aggregate(&d_all, &weights)?;

    let ln_term: f64 = ln_seq.iter().map(|n| (n.t - n.h).min(1000.0) / 200.0).sum();
    let total = seq.len() as f64 + 0.5 * ln_term;
    sr *= total / (total + 60.0);
    sr = rescale_high(sr) * 0.975;
    sr.is_finite().then_some(sr)
}

/// Notes within ±500 ms of every corner (half-open on the right).
fn window_counts(base: &[f64], times: &[f64]) -> Vec<f64> {
    let (mut lo, mut hi) = (0usize, 0usize);
    base.iter()
        .map(|&s| {
            while lo < times.len() && times[lo] < s - 500.0 {
                lo += 1;
            }
            while hi < times.len() && times[hi] < s + 500.0 {
                hi += 1;
            }
            (hi - lo) as f64
        })
        .collect()
}

/// The A term (shared with Daniel): neighbouring active columns moving at about the same speed
/// make a chart easier to read than columns at very different speeds.
pub(super) fn unevenness<I: Iterator<Item = usize>>(
    kk: usize,
    active: &[u32],
    delta_ks: &[Vec<f64>],
    a_corners: &[f64],
    base: &[f64],
    cols_of: impl Fn(u32) -> I,
) -> Vec<f64> {
    let nb = base.len();
    let mut dks = vec![vec![0.0f64; nb]; kk.saturating_sub(1)];
    let mut cols: Vec<usize> = Vec::with_capacity(kk);
    for i in 0..nb {
        cols.clear();
        cols.extend(cols_of(active[i]));
        for w in cols.windows(2) {
            let (k0, k1) = (w[0], w[1]);
            let (d0, d1) = (delta_ks[k0][i], delta_ks[k1][i]);
            dks[k0][i] = (d0 - d1).abs() + 0.4 * (d0.max(d1) - 0.11).max(0.0);
        }
    }
    let mut a_step = vec![1.0f64; a_corners.len()];
    for (i, &s) in a_corners.iter().enumerate() {
        let idx = bisect_left(base, s).min(nb - 1);
        cols.clear();
        cols.extend(cols_of(active[idx]));
        for w in cols.windows(2) {
            let (k0, k1) = (w[0], w[1]);
            let dval = dks[k0][idx];
            let slow = delta_ks[k0][idx].max(delta_ks[k1][idx]);
            if dval < 0.02 {
                a_step[i] *= (0.75 + 0.5 * slow).min(1.0);
            } else if dval < 0.07 {
                a_step[i] *= (0.65 + 5.0 * dval + 0.5 * slow).min(1.0);
            }
        }
    }
    smooth_on_corners(a_corners, &a_step, 250.0, 1.0, Smooth::Avg)
}

/// How many long-note bodies are held at any time (a head counts extra for its first 60 ms),
/// with running sums for integrals over time.
struct LnBodies {
    points: Vec<f64>,
    cumsum: Vec<f64>,
    values: Vec<f64>,
}

impl LnBodies {
    fn new(ln_seq: &[N], t_end: i64) -> Self {
        let mut diff: std::collections::BTreeMap<i64, f64> = Default::default();
        for n in ln_seq {
            let (h, t) = (n.h as i64, n.t as i64);
            let t0 = (h + 60).min(t);
            let t1 = (h + 120).min(t);
            *diff.entry(t0).or_default() += 1.3;
            *diff.entry(t1).or_default() += -1.3 + 1.0;
            *diff.entry(t).or_default() -= 1.0;
        }
        let mut pts: Vec<i64> = diff.keys().copied().chain([0, t_end]).collect();
        pts.sort_unstable();
        pts.dedup();
        let points: Vec<f64> = pts.iter().map(|&p| p as f64).collect();
        let mut values = Vec::with_capacity(points.len());
        let mut cumsum = vec![0.0];
        let mut curr = 0.0;
        for i in 0..pts.len().saturating_sub(1) {
            if let Some(d) = diff.get(&pts[i]) {
                curr += d;
            }
            let v = f64::min(curr, 2.5 + 0.5 * curr);
            values.push(v);
            cumsum.push(cumsum[cumsum.len() - 1] + (points[i + 1] - points[i]) * v);
        }
        LnBodies { points, cumsum, values }
    }

    /// The integral of the body count over `[a, b]`.
    fn sum(&self, a: f64, b: f64) -> f64 {
        if self.values.is_empty() {
            return 0.0;
        }
        let last = self.values.len() - 1;
        let i = bisect_right(&self.points, a).saturating_sub(1).min(last);
        let j = bisect_right(&self.points, b).saturating_sub(1).min(last);
        if i == j {
            return (b - a) * self.values[i];
        }
        (self.points[i + 1] - a) * self.values[i] + self.cumsum[j] - self.cumsum[i + 1] + (b - self.points[j]) * self.values[j]
    }
}
