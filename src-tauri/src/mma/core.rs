//! The numeric helpers the Sunny and Daniel star ratings share (`reworkMathCore.js`), plus the
//! corner-grid plumbing both use.

/// First index whose value is ≥ `target`.
pub fn bisect_left(a: &[f64], target: f64) -> usize {
    a.partition_point(|&v| v < target)
}

/// First index whose value is > `target`.
pub fn bisect_right(a: &[f64], target: f64) -> usize {
    a.partition_point(|&v| v <= target)
}

fn cumulative_sum(x: &[f64], f: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; x.len()];
    for i in 1..x.len() {
        out[i] = out[i - 1] + f[i - 1] * (x[i] - x[i - 1]);
    }
    out
}

fn query_cumsum(q: f64, x: &[f64], cum: &[f64], f: &[f64]) -> f64 {
    if q <= x[0] {
        return 0.0;
    }
    if q >= x[x.len() - 1] {
        return cum[cum.len() - 1];
    }
    let i = bisect_right(x, q) - 1;
    cum[i] + f[i] * (q - x[i])
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Smooth {
    Sum,
    Avg,
}

/// The integral of the step function `f` over `[s − window, s + window]` at every corner `s`
/// (times `scale`), or its average.
pub fn smooth_on_corners(x: &[f64], f: &[f64], window: f64, scale: f64, mode: Smooth) -> Vec<f64> {
    if x.is_empty() {
        return Vec::new();
    }
    let cum = cumulative_sum(x, f);
    let first = x[0];
    let last = x[x.len() - 1];
    x.iter()
        .map(|&s| {
            let a = (s - window).max(first);
            let b = (s + window).min(last);
            let val = query_cumsum(b, x, &cum, f) - query_cumsum(a, x, &cum, f);
            match mode {
                Smooth::Avg => {
                    if b - a > 0.0 {
                        val / (b - a)
                    } else {
                        0.0
                    }
                }
                Smooth::Sum => scale * val,
            }
        })
        .collect()
}

/// Linear interpolation of `(old_x, old)` at every `new_x` (both sorted), held flat at the ends.
pub fn interp_values(new_x: &[f64], old_x: &[f64], old: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; new_x.len()];
    let n = old_x.len();
    let mut idx = 0usize;
    for (i, &x) in new_x.iter().enumerate() {
        if x <= old_x[0] {
            out[i] = old[0];
            continue;
        }
        if x >= old_x[n - 1] {
            out[i] = old[n - 1];
            continue;
        }
        while idx + 1 < n && old_x[idx + 1] < x {
            idx += 1;
        }
        let (x0, x1, y0, y1) = (old_x[idx], old_x[idx + 1], old[idx], old[idx + 1]);
        out[i] = if x1 == x0 { y0 } else { y0 + (x - x0) / (x1 - x0) * (y1 - y0) };
    }
    out
}

/// Step interpolation: the value of the last old sample at or before each new x. With
/// `strict`, an exact match takes the previous sample (Sunny since the C# port sync); Daniel
/// keeps the older inclusive form.
pub fn step_interp(new_x: &[f64], old_x: &[f64], old: &[f64], strict: bool) -> Vec<f64> {
    let mut out = vec![0.0; new_x.len()];
    let mut idx = 0usize;
    for (i, &x) in new_x.iter().enumerate() {
        while idx + 1 < old_x.len() && (if strict { old_x[idx + 1] < x } else { old_x[idx + 1] <= x }) {
            idx += 1;
        }
        out[i] = old[idx.min(old.len() - 1)];
    }
    out
}

pub fn rescale_high(sr: f64) -> f64 {
    if sr <= 9.0 {
        sr
    } else {
        9.0 + (sr - 9.0) / 1.2
    }
}

pub fn jack_nerfer(delta: f64) -> f64 {
    1.0 - 7e-5 * (0.15 + (delta - 0.08).abs()).powf(-4.0)
}

pub const TARGET_PERCENTILES: [f64; 8] = [0.945, 0.935, 0.925, 0.915, 0.845, 0.835, 0.825, 0.815];

/// Merges two head-sorted note lists (stable: `a` first on equal heads).
pub fn merge_by_head(a: &[(usize, f64)], b: &[(usize, f64)]) -> Vec<(usize, f64)> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].1 <= b[j].1 {
            out.push(a[i]);
            i += 1;
        } else {
            out.push(b[j]);
            j += 1;
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

/// Sorted, de-duplicated corner times within `[0, t_max]`.
pub fn corners(mut times: Vec<i64>, t_max: i64) -> Vec<f64> {
    times.push(0);
    times.push(t_max);
    times.retain(|&s| s >= 0 && s <= t_max);
    times.sort_unstable();
    times.dedup();
    times.into_iter().map(|t| t as f64).collect()
}

/// Union of two sorted corner lists.
pub fn union(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = a.iter().chain(b).copied().collect();
    out.sort_by(f64::total_cmp);
    out.dedup();
    out
}

/// The cross matrix: how much each pair of neighbouring columns (and the two outer edges)
/// counts, per key count.
pub const CROSS_MATRIX: [&[f64]; 11] = [
    &[-1.0],
    &[0.075, 0.075],
    &[0.125, 0.05, 0.125],
    &[0.125, 0.125, 0.125, 0.125],
    &[0.175, 0.25, 0.05, 0.25, 0.175],
    &[0.175, 0.25, 0.175, 0.175, 0.25, 0.175],
    &[0.225, 0.35, 0.25, 0.05, 0.25, 0.35, 0.225],
    &[0.225, 0.35, 0.25, 0.225, 0.225, 0.25, 0.35, 0.225],
    &[0.275, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.275],
    &[0.275, 0.45, 0.35, 0.25, 0.275, 0.275, 0.25, 0.35, 0.45, 0.275],
    &[0.325, 0.55, 0.45, 0.35, 0.25, 0.05, 0.25, 0.35, 0.45, 0.55, 0.325],
];

/// The final star rating from the difficulty at every corner: the weighted 93rd and 83rd
/// percentiles and a weighted power mean, blended. `None` when nothing carries weight.
pub fn aggregate(d_all: &[f64], weights: &[f64]) -> Option<f64> {
    let mut order: Vec<usize> = (0..d_all.len()).collect();
    order.sort_by(|&a, &b| d_all[a].partial_cmp(&d_all[b]).unwrap_or(std::cmp::Ordering::Equal));
    let d_sorted: Vec<f64> = order.iter().map(|&i| d_all[i]).collect();
    let w_sorted: Vec<f64> = order.iter().map(|&i| weights[i]).collect();
    let mut cum = Vec::with_capacity(w_sorted.len());
    let mut running = 0.0;
    for &w in &w_sorted {
        running += w;
        cum.push(running);
    }
    let total = *cum.last()?;
    if !(total.is_finite() && total > 0.0) {
        return None;
    }
    let norm: Vec<f64> = cum.iter().map(|w| w / total).collect();
    let at = |p: f64| d_sorted[bisect_left(&norm, p).min(d_sorted.len() - 1)];
    let p93 = TARGET_PERCENTILES[..4].iter().map(|&p| at(p)).sum::<f64>() / 4.0;
    let p83 = TARGET_PERCENTILES[4..].iter().map(|&p| at(p)).sum::<f64>() / 4.0;
    let (mut num, mut den) = (0.0, 0.0);
    for (d, w) in d_sorted.iter().zip(&w_sorted) {
        num += d.powf(5.0) * w;
        den += w;
    }
    let mean = (num / den.max(1e-9)).powf(0.2);
    Some(0.88 * p93 * 0.25 + 0.94 * p83 * 0.2 + mean * 0.55)
}

/// Half the distance to each neighbouring corner: how much time a corner stands for.
pub fn gaps(all: &[f64]) -> Vec<f64> {
    let n = all.len();
    let mut g = vec![0.0; n];
    if n < 2 {
        return g;
    }
    g[0] = (all[1] - all[0]) / 2.0;
    g[n - 1] = (all[n - 1] - all[n - 2]) / 2.0;
    for i in 1..n - 1 {
        g[i] = (all[i + 1] - all[i - 1]) / 2.0;
    }
    g
}

/// Hit-window term from OD (both algorithms): smaller for stricter judgement.
pub fn hit_leniency(od: f64) -> f64 {
    let x = 0.3 * ((64.5 - (od * 3.0).ceil()) / 500.0).sqrt();
    x.min(0.6 * (x - 0.09) + 0.09)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoothing_and_interpolation() {
        let x = [0.0, 10.0, 20.0, 30.0];
        let f = [1.0, 1.0, 1.0, 0.0];
        // the integral over [s-10, s+10] of a step that's 1 until 30
        assert_eq!(smooth_on_corners(&x, &f, 10.0, 1.0, Smooth::Sum), vec![10.0, 20.0, 20.0, 10.0]);
        assert_eq!(smooth_on_corners(&x, &f, 10.0, 1.0, Smooth::Avg), vec![1.0, 1.0, 1.0, 1.0]);
        assert_eq!(interp_values(&[5.0, 25.0, 40.0], &[0.0, 10.0, 30.0], &[0.0, 1.0, 3.0]), vec![0.5, 2.5, 3.0]);
        assert_eq!(step_interp(&[10.0], &[0.0, 10.0], &[1.0, 2.0], true), vec![1.0]);
        assert_eq!(step_interp(&[10.0], &[0.0, 10.0], &[1.0, 2.0], false), vec![2.0]);
    }
}
