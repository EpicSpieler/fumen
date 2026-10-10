//! Daniel's 4K rice star rating (<https://thebagelofman.github.io/Daniel/>), as ManiaMapAnalyser
//! runs it (`danielAlgorithm.js`): Sunny's model without the long-note terms, with its own stream
//! booster, judged at OD 9, and the dan it reads that rating as.

use super::core::{
    aggregate, bisect_left, bisect_right, corners, gaps, hit_leniency, interp_values, jack_nerfer, merge_by_head, rescale_high,
    smooth_on_corners, step_interp, union, Smooth, CROSS_MATRIX,
};
use super::sunny::unevenness;
use super::Note;

/// Daniel's star rating of a 4K chart at a clock rate (long notes count as their heads).
pub fn star(notes: &[Note], keys: usize, rate: f64) -> Option<f64> {
    if keys != 4 || notes.is_empty() {
        return None;
    }
    let kk = 4usize;
    let scale = if rate != 0.0 { 1.0 / rate } else { 1.0 };
    let mut seq: Vec<(usize, f64)> = notes.iter().map(|n| (n.col.min(kk - 1), (n.start as f64 * scale).floor())).collect();
    seq.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
    let mut by_col: Vec<Vec<(usize, f64)>> = vec![Vec::new(); kk];
    for &n in &seq {
        by_col[n.0].push(n);
    }
    // Daniel's own parser keeps OD at 9
    let x = hit_leniency(9.0);
    let t_end = seq[seq.len() - 1].1 as i64 + 1;
    if t_end <= 0 {
        return None;
    }
    let te = t_end as f64;

    let mut b = Vec::with_capacity(seq.len() * 4);
    let mut a = Vec::with_capacity(seq.len() * 3);
    for &(_, h) in &seq {
        let h = h as i64;
        b.extend([h, h + 501, h - 499, h + 1]);
        a.extend([h, h + 1000, h - 1000]);
    }
    let base = corners(b, t_end);
    let a_corners = corners(a, t_end);
    let all = union(&base, &a_corners);
    let nb = base.len();

    let mut active = vec![0u32; nb];
    for &(k, h) in &seq {
        let (l, r) = (bisect_left(&base, (h - 150.0).max(0.0)), bisect_left(&base, (h + 150.0).min(te - 1.0)));
        for m in &mut active[l..r.max(l)] {
            *m |= 1 << k;
        }
    }
    let cols_of = |m: u32| (0..kk).filter(move |k| m & (1 << k) != 0);

    let mut usage400 = vec![vec![0.0f64; nb]; kk];
    let coeff = 3.75 / 400f64.powi(2);
    for &(k, h) in &seq {
        let l400 = bisect_left(&base, h - 400.0);
        let c = bisect_left(&base, h);
        let r400 = bisect_left(&base, h + 400.0);
        let u = &mut usage400[k];
        if c < nb {
            u[c] += 3.75;
        }
        for idx in l400..c {
            u[idx] += 3.75 - coeff * (base[idx] - h).powi(2);
        }
        for idx in (c + 1)..r400 {
            u[idx] += 3.75 - coeff * (base[idx] - h).powi(2);
        }
    }
    let mut anchor = vec![0.0f64; nb];
    let mut counts = [0.0f64; 4];
    for idx in 0..nb {
        for k in 0..kk {
            counts[k] = usage400[k][idx];
        }
        counts.sort_by(|a, b| b.total_cmp(a));
        let nz = &counts[..counts.iter().take_while(|&&v| v > 0.0).count()];
        let mut raw = 0.0;
        if nz.len() > 1 {
            let (mut walk, mut max_walk) = (0.0, 0.0);
            for i in 0..nz.len() - 1 {
                walk += nz[i] * (1.0 - 4.0 * (0.5 - nz[i + 1] / nz[i]).powi(2));
                max_walk += nz[i];
            }
            raw = if max_walk > 0.0 { walk / max_walk } else { 0.0 };
        }
        anchor[idx] = 1.0 + (raw - 0.18).min(5.0 * (raw - 0.22).powf(3.0));
    }

    // J
    let x_quarter = 0.11 * x.powf(0.25);
    let mut jks = vec![vec![0.0f64; nb]; kk];
    let mut delta_ks = vec![vec![1e9f64; nb]; kk];
    for k in 0..kk {
        let col = &by_col[k];
        for i in 0..col.len().saturating_sub(1) {
            let (start, end) = (col[i].1, col[i + 1].1);
            if end <= start {
                continue;
            }
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
                let w = 1.0 / delta_ks[k][i].max(1e-9);
                num += jbar_ks[k][i].max(0.0).powf(5.0) * w;
                den += w;
            }
            (num / den.max(1e-9)).powf(0.2)
        })
        .collect();

    // X
    let cross = CROSS_MATRIX[kk];
    let mut xks = vec![vec![0.0f64; nb]; kk + 1];
    let mut fast = vec![vec![0.0f64; nb]; kk + 1];
    let has = |m: Option<&u32>, c: isize| c >= 0 && m.is_some_and(|m| m & (1 << c) != 0);
    for k in 0..=kk {
        let pair = if k == 0 {
            by_col[0].clone()
        } else if k == kk {
            by_col[kk - 1].clone()
        } else {
            merge_by_head(&by_col[k - 1], &by_col[k])
        };
        for i in 1..pair.len() {
            let (start, end) = (pair[i - 1].1, pair[i].1);
            if end <= start {
                continue;
            }
            let (l, r) = (bisect_left(&base, start), bisect_left(&base, end));
            if r <= l {
                continue;
            }
            let delta = 0.001 * (end - start);
            let mut val = 0.16 * x.max(delta).powf(-2.0);
            let (left, right) = (active.get(l), active.get(r));
            let ki = k as isize;
            if (!has(left, ki - 1) && !has(right, ki - 1)) || (!has(left, ki) && !has(right, ki)) {
                val *= 1.0 - cross[k];
            }
            let f = (0.4 * delta.max(0.06).max(0.75 * x).powf(-2.0) - 80.0).max(0.0);
            xks[k][l..r].fill(val);
            fast[k][l..r].fill(f);
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
                let p = fast[k][i] * cross[k] * fast[k + 1][i] * cross[k + 1];
                if p > 0.0 {
                    s2 += p.sqrt();
                }
            }
            s1 + s2
        })
        .collect();
    let xbar_base = smooth_on_corners(&base, &xb, 500.0, 0.001, Smooth::Sum);

    // P
    let booster = |delta: f64| {
        let bpm = (7.5 / delta.max(1e-9)).clamp(0.0, 420.0);
        let primary = 0.10 / (1.0 + (-0.06 * (bpm - 175.0)).exp());
        let secondary = if (200.0..=350.0).contains(&bpm) { 0.30 * (1.0 - (-0.02 * (bpm - 200.0)).exp()) } else { 0.0 };
        1.0 + primary + secondary
    };
    let x_inv = x.powf(-1.0);
    let base_inc = (0.08 * x_inv * (1.0 - 24.0 * x_inv * (x / 6.0).powi(2))).powf(0.25);
    let spike = 1000.0 * (0.02 * (4.0 / x - 24.0)).powf(0.25);
    let mut p_step = vec![0.0f64; nb];
    for i in 0..seq.len() - 1 {
        let (hl, hr) = (seq[i].1, seq[i + 1].1);
        let dt = hr - hl;
        if dt < 1e-9 {
            for v in &mut p_step[bisect_left(&base, hl)..bisect_right(&base, hl)] {
                *v += spike;
            }
            continue;
        }
        let (l, r) = (bisect_left(&base, hl), bisect_left(&base, hr));
        if r <= l {
            continue;
        }
        let delta = 0.001 * dt;
        let boost = booster(delta).max(1.0);
        let inc = if delta < 2.0 * x / 3.0 {
            delta.powf(-1.0) * (0.08 * x_inv * (1.0 - 24.0 * x_inv * (delta - x / 2.0).powi(2))).powf(0.25) * boost
        } else {
            delta.powf(-1.0) * base_inc * boost
        };
        let cap = inc.max(inc * 2.0 - 10.0);
        for idx in l..r {
            p_step[idx] += (inc * anchor[idx]).min(cap);
        }
    }
    let pbar_base = smooth_on_corners(&base, &p_step, 500.0, 0.001, Smooth::Sum);

    let abar_base = unevenness(kk, &active, &delta_ks, &a_corners, &base, cols_of);

    // C and Ks
    let mut hit: Vec<f64> = seq.iter().map(|n| n.1).collect();
    hit.sort_by(f64::total_cmp);
    let (mut lo, mut hi) = (0usize, 0usize);
    let c_step: Vec<f64> = base
        .iter()
        .map(|&s| {
            while lo < hit.len() && hit[lo] < s - 500.0 {
                lo += 1;
            }
            while hi < hit.len() && hit[hi] < s + 500.0 {
                hi += 1;
            }
            (hi - lo) as f64
        })
        .collect();
    let ks_step: Vec<f64> = active.iter().map(|m| (m.count_ones() as f64).max(1.0)).collect();

    let jbar = interp_values(&all, &base, &jbar_base);
    let xbar = interp_values(&all, &base, &xbar_base);
    let pbar = interp_values(&all, &base, &pbar_base);
    let abar = interp_values(&all, &a_corners, &abar_base);
    let c_arr = step_interp(&all, &base, &c_step, false);
    let ks_arr = step_interp(&all, &base, &ks_step, false);

    let d_all: Vec<f64> = (0..all.len())
        .map(|i| {
            let left = 0.4 * (abar[i].powf(3.0 / ks_arr[i]) * jbar[i].min(8.0 + 0.85 * jbar[i])).powf(1.5);
            let right = 0.6 * (abar[i].powf(2.0 / 3.0) * (0.8 * pbar[i])).powf(1.5);
            let s = (left + right).powf(2.0 / 3.0);
            let t = (abar[i].powf(3.0 / ks_arr[i]) * xbar[i]) / (xbar[i] + s + 1.0);
            2.7 * s.powf(0.5) * t.powf(1.5) + s * 0.27
        })
        .collect();
    let g = gaps(&all);
    let weights: Vec<f64> = c_arr.iter().zip(&g).map(|(c, g)| c * g).collect();
    let Some(mut sr) = aggregate(&d_all, &weights) else { return Some(0.0) };
    let n = seq.len() as f64;
    sr *= n / (n + 60.0);
    sr = rescale_high(sr) * 0.975;
    sr.is_finite().then_some(sr)
}

/// Daniel's tiers (Alpha … CloverWisp Theta) by the mean star rating of each, read as a number:
/// 11 + tier index + the position inside the tier. `None` outside the tiers it knows.
pub fn dan_numeric(sr: f64) -> Option<f64> {
    const MEANS: [f64; 8] = [6.562, 6.957, 7.459, 7.939, 9.095, 9.473, 10.162, 10.782];
    let n = MEANS.len();
    let bounds = |i: usize| {
        let m = MEANS[i];
        let lower = if i > 0 { (MEANS[i - 1] + m) / 2.0 } else { m - ((MEANS[1] + m) / 2.0 - m) };
        let upper = if i < n - 1 { (m + MEANS[i + 1]) / 2.0 } else { m + (m - MEANS[i - 1]) / 2.0 };
        (lower, upper)
    };
    if !sr.is_finite() || sr < bounds(0).0 || sr >= bounds(n - 1).1 {
        return None;
    }
    (0..n).find_map(|i| {
        let (lower, upper) = bounds(i);
        (sr >= lower && sr < upper).then(|| {
            let t = ((sr - lower) / (upper - lower)).clamp(0.0, 1.0);
            ((11.0 + i as f64 + t) * 100.0).round() / 100.0
        })
    })
}
