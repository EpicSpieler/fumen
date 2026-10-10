//! The dan a chart is at: Azusa for 4K rice, otherwise the Sunny star rating read against the
//! community dan tables (`estimator/intervals/*.js` and `reworkEstimatorUtils.js`).
//!
//! The tables: 4K rice runs Intro 1 … Reform 10, Alpha … CloverWisp Theta; 4K LN runs LN 5 …
//! Lnlism LN 17; 6K and 7K have Regular and LN dans; 10K has rice levels. Every dan is split in
//! low, mid/low, mid, mid/high and high.

use serde::Serialize;

use super::{azusa, notes, sunny};
use crate::chart::Chart;

/// Long-note share from which a chart also gets an LN reading.
const LN_READING: f64 = 0.15;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dan {
    /// the rice reading, e.g. "Gamma mid", "Reform 7 high", "Regular 4 low", "> CloverWisp Theta high"
    pub rc: String,
    /// the long-note reading, for charts with 15 % long notes or more (where the key count has an LN table)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ln: Option<String>,
    /// Azusa's number for 4K rice: Intro 1–3 = −2…0, Reform 1–10 = 1…10, Alpha = 11 … Kappa = 20
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f32>,
    /// which estimator rated it: "azusa" or "sunny"
    pub by: &'static str,
    /// the Sunny star rating
    pub sunny: f32,
}

impl Dan {
    /// One line: the rice reading, then the LN one.
    pub fn label(&self) -> String {
        match &self.ln {
            Some(ln) => format!("{} || {ln}", self.rc),
            None => self.rc.clone(),
        }
    }
}

/// The dan of an osu!mania chart at a clock rate, or `None` (other modes, key counts without a
/// table, charts too short to rate).
pub fn rate(chart: &Chart, rate: f64) -> Option<Dan> {
    if chart.mode != 3 || chart.keys == 0 {
        return None;
    }
    let keys = chart.keys as usize;
    let (notes, ln_ratio) = notes(chart);
    let sr = sunny::star(&notes, keys, chart.od, rate, false)?;
    // without long notes, Azusa's Sunny reference (long notes as taps) is this same rating
    let taps = (ln_ratio == 0.0).then_some(sr);
    if let Some(v) = azusa::numeric(&notes, keys, chart.od, ln_ratio, rate, taps) {
        return Some(Dan { rc: rc_label(v), ln: None, value: Some(v as f32), by: "azusa", sunny: sr as f32 });
    }
    let (rc, ln) = tables(keys)?;
    let ln = ln.filter(|_| ln_ratio >= LN_READING).map(|t| lookup(sr, t));
    Some(Dan { rc: lookup(sr, rc), ln, value: None, by: "sunny", sunny: sr as f32 })
}

fn tables(keys: usize) -> Option<(Table, Option<Table>)> {
    match keys {
        4 => Some((RC_4K, Some(LN_4K))),
        6 => Some((RC_6K, Some(LN_6K))),
        7 => Some((RC_7K, Some(LN_7K))),
        10 => Some((RC_10K, None)),
        _ => None,
    }
}

type Table = &'static [(f64, f64, &'static str)];

/// The table's dan for a star rating; below or above the table, "< first" / "> last".
fn lookup(sr: f64, table: Table) -> String {
    if let Some(&(_, _, name)) = table.iter().find(|&&(lo, hi, _)| lo <= sr && sr <= hi) {
        return name.to_owned();
    }
    if sr < table[0].0 {
        return format!("< {}", table[0].2);
    }
    format!("> {}", table[table.len() - 1].2)
}

const GREEK: [&str; 10] = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Emik Zeta", "Thaumiel Eta", "CloverWisp Theta", "Iota", "Kappa"];
const TIERS: [(&str, f64); 5] = [("low", -0.4), ("mid/low", -0.2), ("mid", 0.0), ("mid/high", 0.2), ("high", 0.4)];

/// The rice dan nearest to a number on Azusa's scale (`numericToRcLabel`).
pub fn rc_label(v: f64) -> String {
    let v = v.clamp(-2.4, 20.4);
    let mut best = (f64::INFINITY, 0i32, "");
    for base in -2..=20 {
        for (suffix, offset) in TIERS {
            let d = (v - (base as f64 + offset)).abs();
            if d < best.0 {
                best = (d, base, suffix);
            }
        }
    }
    let (_, base, suffix) = best;
    let name = if base <= 0 {
        format!("Intro {}", (base + 3).clamp(1, 3))
    } else if base <= 10 {
        format!("Reform {base}")
    } else {
        GREEK[(base - 11).clamp(0, 9) as usize].to_owned()
    };
    format!("{name} {suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(rc_label(13.0), "Gamma mid");
        assert_eq!(rc_label(12.45), "Beta high");
        assert_eq!(rc_label(12.62), "Gamma low");
        assert_eq!(rc_label(5.8), "Reform 6 mid/low");
        assert_eq!(rc_label(-1.4), "Intro 2 low");
        assert_eq!(rc_label(25.0), "Kappa high");
        assert_eq!(lookup(7.65, RC_4K), "Gamma mid");
        assert_eq!(lookup(0.5, RC_4K), "< Intro 1 low");
        assert_eq!(lookup(12.0, RC_4K), "> CloverWisp Theta high");
    }
}

// ── tables (ManiaMapAnalyser `js/estimator/intervals`): (lower, upper, dan) by Sunny star rating ──

pub const RC_4K: &[(f64, f64, &str)] = &[
    (1.502, 1.631, "Intro 1 low"),
    (1.631, 1.76, "Intro 1 mid/low"),
    (1.76, 1.89, "Intro 1 mid"),
    (1.89, 2.019, "Intro 1 mid/high"),
    (2.019, 2.148, "Intro 1 high"),
    (2.148, 2.278, "Intro 2 low"),
    (2.278, 2.407, "Intro 2 mid/low"),
    (2.407, 2.502, "Intro 2 mid"),
    (2.502, 2.56, "Intro 2 mid/high"),
    (2.56, 2.619, "Intro 2 high"),
    (2.619, 2.679, "Intro 3 low"),
    (2.679, 2.737, "Intro 3 mid/low"),
    (2.737, 2.821, "Intro 3 mid"),
    (2.821, 2.929, "Intro 3 mid/high"),
    (2.929, 3.037, "Intro 3 high"),
    (3.037, 3.145, "Reform 1 low"),
    (3.145, 3.253, "Reform 1 mid/low"),
    (3.253, 3.346, "Reform 1 mid"),
    (3.346, 3.424, "Reform 1 mid/high"),
    (3.424, 3.503, "Reform 1 high"),
    (3.503, 3.581, "Reform 2 low"),
    (3.581, 3.659, "Reform 2 mid/low"),
    (3.659, 3.701, "Reform 2 mid"),
    (3.701, 3.708, "Reform 2 mid/high"),
    (3.708, 3.714, "Reform 2 high"),
    (3.714, 3.72, "Reform 3 low"),
    (3.72, 3.727, "Reform 3 mid/low"),
    (3.727, 3.81, "Reform 3 mid"),
    (3.81, 3.97, "Reform 3 mid/high"),
    (3.97, 4.13, "Reform 3 high"),
    (4.13, 4.29, "Reform 4 low"),
    (4.29, 4.45, "Reform 4 mid/low"),
    (4.45, 4.569, "Reform 4 mid"),
    (4.569, 4.648, "Reform 4 mid/high"),
    (4.648, 4.726, "Reform 4 high"),
    (4.726, 4.804, "Reform 5 low"),
    (4.804, 4.883, "Reform 5 mid/low"),
    (4.883, 4.972, "Reform 5 mid"),
    (4.972, 5.072, "Reform 5 mid/high"),
    (5.072, 5.173, "Reform 5 high"),
    (5.173, 5.273, "Reform 6 low"),
    (5.273, 5.373, "Reform 6 mid/low"),
    (5.373, 5.441, "Reform 6 mid"),
    (5.441, 5.476, "Reform 6 mid/high"),
    (5.476, 5.511, "Reform 6 high"),
    (5.511, 5.547, "Reform 7 low"),
    (5.547, 5.582, "Reform 7 mid/low"),
    (5.582, 5.646, "Reform 7 mid"),
    (5.646, 5.738, "Reform 7 mid/high"),
    (5.738, 5.829, "Reform 7 high"),
    (5.829, 5.921, "Reform 8 low"),
    (5.921, 6.013, "Reform 8 mid/low"),
    (6.013, 6.069, "Reform 8 mid"),
    (6.069, 6.09, "Reform 8 mid/high"),
    (6.09, 6.11, "Reform 8 high"),
    (6.11, 6.13, "Reform 9 low"),
    (6.13, 6.151, "Reform 9 mid/low"),
    (6.151, 6.205, "Reform 9 mid"),
    (6.205, 6.294, "Reform 9 mid/high"),
    (6.294, 6.382, "Reform 9 high"),
    (6.382, 6.471, "Reform 10 low"),
    (6.471, 6.56, "Reform 10 mid/low"),
    (6.56, 6.616, "Reform 10 mid"),
    (6.616, 6.641, "Reform 10 mid/high"),
    (6.641, 6.666, "Reform 10 high"),
    (6.666, 6.691, "Alpha low"),
    (6.691, 6.716, "Alpha mid/low"),
    (6.716, 6.773, "Alpha mid"),
    (6.773, 6.86, "Alpha mid/high"),
    (6.86, 6.947, "Alpha high"),
    (6.947, 7.034, "Beta low"),
    (7.034, 7.121, "Beta mid/low"),
    (7.121, 7.214, "Beta mid"),
    (7.214, 7.312, "Beta mid/high"),
    (7.312, 7.41, "Beta high"),
    (7.41, 7.509, "Gamma low"),
    (7.509, 7.607, "Gamma mid/low"),
    (7.607, 7.705, "Gamma mid"),
    (7.705, 7.803, "Gamma mid/high"),
    (7.803, 7.901, "Gamma high"),
    (7.901, 8.0, "Delta low"),
    (8.0, 8.098, "Delta mid/low"),
    (8.098, 8.244, "Delta mid"),
    (8.244, 8.438, "Delta mid/high"),
    (8.438, 8.631, "Delta high"),
    (8.631, 8.825, "Epsilon low"),
    (8.825, 9.019, "Epsilon mid/low"),
    (9.019, 9.172, "Epsilon mid"),
    (9.172, 9.285, "Epsilon mid/high"),
    (9.285, 9.398, "Epsilon high"),
    (9.398, 9.511, "Emik Zeta low"),
    (9.511, 9.624, "Emik Zeta mid/low"),
    (9.624, 9.742, "Emik Zeta mid"),
    (9.742, 9.867, "Emik Zeta mid/high"),
    (9.867, 9.991, "Emik Zeta high"),
    (9.991, 10.116, "Thaumiel Eta low"),
    (10.116, 10.241, "Thaumiel Eta mid/low"),
    (10.241, 10.358, "Thaumiel Eta mid"),
    (10.358, 10.468, "Thaumiel Eta mid/high"),
    (10.468, 10.578, "Thaumiel Eta high"),
    (10.578, 10.689, "CloverWisp Theta low"),
    (10.689, 10.799, "CloverWisp Theta mid/low"),
    (10.799, 10.909, "CloverWisp Theta mid"),
    (10.909, 11.019, "CloverWisp Theta mid/high"),
    (11.019, 11.129, "CloverWisp Theta high"),
];

pub const LN_4K: &[(f64, f64, &str)] = &[
    (4.832, 4.898, "LN 5 mid"),
    (4.898, 4.963, "LN 5 mid/high"),
    (4.963, 5.029, "LN 5 high"),
    (5.029, 5.095, "LN 6 low"),
    (5.095, 5.16, "LN 6 mid/low"),
    (5.16, 5.213, "LN 6 mid"),
    (5.213, 5.264, "LN 6 mid/high"),
    (5.264, 5.314, "LN 6 high"),
    (5.314, 5.446, "LN 7 low"),
    (5.446, 5.521, "LN 7 mid/low"),
    (5.521, 5.577, "LN 7 mid"),
    (5.577, 5.631, "LN 7 mid/high"),
    (5.631, 5.686, "LN 7 high"),
    (5.686, 5.74, "LN 8 low"),
    (5.74, 5.794, "LN 8 mid/low"),
    (5.794, 5.853, "LN 8 mid"),
    (5.853, 5.917, "LN 8 mid/high"),
    (5.917, 5.981, "LN 8 high"),
    (5.981, 6.044, "LN 9 low"),
    (6.044, 6.108, "LN 9 mid/low"),
    (6.108, 6.175, "LN 9 mid"),
    (6.175, 6.246, "LN 9 mid/high"),
    (6.246, 6.318, "LN 9 high"),
    (6.318, 6.389, "LN 10 low"),
    (6.389, 6.461, "LN 10 mid/low"),
    (6.461, 6.534, "LN 10 mid"),
    (6.534, 6.611, "LN 10 mid/high"),
    (6.611, 6.687, "LN 10 high"),
    (6.687, 6.763, "LN 11 low"),
    (6.763, 6.839, "LN 11 mid/low"),
    (6.839, 6.898, "LN 11 mid"),
    (6.898, 6.92, "LN 11 mid/high"),
    (6.92, 6.941, "LN 11 high"),
    (6.941, 7.023, "LN 12 low"),
    (7.023, 7.068, "LN 12 mid/low"),
    (7.068, 7.136, "LN 12 mid"),
    (7.136, 7.225, "LN 12 mid/high"),
    (7.225, 7.313, "LN 12 high"),
    (7.313, 7.401, "LN 13 low"),
    (7.401, 7.49, "LN 13 mid/low"),
    (7.49, 7.578, "LN 13 mid"),
    (7.578, 7.665, "LN 13 mid/high"),
    (7.665, 7.753, "LN 13 high"),
    (7.753, 7.841, "LN 14 low"),
    (7.841, 7.929, "LN 14 mid/low"),
    (7.929, 8.013, "LN 14 mid"),
    (8.013, 8.093, "LN 14 mid/high"),
    (8.093, 8.173, "LN 14 high"),
    (8.173, 8.253, "LN 15 low"),
    (8.253, 8.333, "LN 15 mid/low"),
    (8.333, 8.389, "LN 15 mid"),
    (8.389, 8.428, "LN 15 mid/high"),
    (8.428, 8.47, "LN 15 high"),
    (8.47, 8.509, "Hypersovae LN 16 low"),
    (8.509, 8.548, "Hypersovae LN 16 mid/low"),
    (8.548, 8.586, "Hypersovae LN 16 mid"),
    (8.586, 8.635, "Hypersovae LN 16 mid/high"),
    (8.635, 8.908, "Hypersovae LN 16 high"),
    (8.908, 9.044, "Lnlism LN 17 low"),
    (9.044, 9.18, "Lnlism LN 17 mid/low"),
    (9.18, 9.316, "Lnlism LN 17 mid"),
    (9.316, 9.452, "Lnlism LN 17 mid/high"),
    (9.452, 9.589, "Lnlism LN 17 high"),
];

pub const RC_6K: &[(f64, f64, &str)] = &[
    (3.43, 3.526, "Regular 0 low"),
    (3.526, 3.622, "Regular 0 mid/low"),
    (3.622, 3.718, "Regular 0 mid"),
    (3.718, 3.814, "Regular 0 mid/high"),
    (3.814, 3.91, "Regular 0 high"),
    (3.91, 4.006, "Regular 1 low"),
    (4.006, 4.102, "Regular 1 mid/low"),
    (4.102, 4.21, "Regular 1 mid"),
    (4.21, 4.33, "Regular 1 mid/high"),
    (4.33, 4.45, "Regular 1 high"),
    (4.45, 4.57, "Regular 2 low"),
    (4.57, 4.69, "Regular 2 mid/low"),
    (4.69, 4.831, "Regular 2 mid"),
    (4.831, 4.993, "Regular 2 mid/high"),
    (4.993, 5.155, "Regular 2 high"),
    (5.155, 5.317, "Regular 3 low"),
    (5.317, 5.479, "Regular 3 mid/low"),
    (5.479, 5.59, "Regular 3 mid"),
    (5.59, 5.65, "Regular 3 mid/high"),
    (5.65, 5.71, "Regular 3 high"),
    (5.71, 5.77, "Regular 4 low"),
    (5.77, 5.83, "Regular 4 mid/low"),
    (5.83, 5.919, "Regular 4 mid"),
    (5.919, 6.037, "Regular 4 mid/high"),
    (6.037, 6.155, "Regular 4 high"),
    (6.155, 6.273, "Regular 5 low"),
    (6.273, 6.391, "Regular 5 mid/low"),
    (6.391, 6.49, "Regular 5 mid"),
    (6.49, 6.57, "Regular 5 mid/high"),
    (6.57, 6.65, "Regular 5 high"),
    (6.65, 6.73, "Regular 6 low"),
    (6.73, 6.81, "Regular 6 mid/low"),
    (6.81, 6.873, "Regular 6 mid"),
    (6.873, 6.919, "Regular 6 mid/high"),
    (6.919, 6.965, "Regular 6 high"),
    (6.965, 7.011, "Regular 7 low"),
    (7.011, 7.057, "Regular 7 mid/low"),
    (7.057, 7.119, "Regular 7 mid"),
    (7.119, 7.197, "Regular 7 mid/high"),
    (7.197, 7.275, "Regular 7 high"),
    (7.275, 7.353, "Regular 8 low"),
    (7.353, 7.431, "Regular 8 mid/low"),
    (7.431, 7.503, "Regular 8 mid"),
    (7.503, 7.569, "Regular 8 mid/high"),
    (7.569, 7.635, "Regular 8 high"),
    (7.635, 7.701, "Regular 9 low"),
    (7.701, 7.767, "Regular 9 mid/low"),
    (7.767, 7.833, "Regular 9 mid"),
    (7.833, 7.899, "Regular 9 mid/high"),
    (7.899, 7.965, "Regular 9 high"),
];

pub const LN_6K: &[(f64, f64, &str)] = &[
    (3.53, 3.718, "LN 0 low"),
    (3.718, 3.906, "LN 0 mid/low"),
    (3.906, 4.094, "LN 0 mid"),
    (4.094, 4.282, "LN 0 mid/high"),
    (4.282, 4.47, "LN 0 high"),
    (4.47, 4.658, "LN 1 low"),
    (4.658, 4.846, "LN 1 mid/low"),
    (4.846, 4.974, "LN 1 mid"),
    (4.974, 5.042, "LN 1 mid/high"),
    (5.042, 5.11, "LN 1 high"),
    (5.11, 5.178, "LN 2 low"),
    (5.178, 5.246, "LN 2 mid/low"),
    (5.246, 5.294, "LN 2 mid"),
    (5.294, 5.322, "LN 2 mid/high"),
    (5.322, 5.35, "LN 2 high"),
    (5.35, 5.378, "LN 3 low"),
    (5.378, 5.406, "LN 3 mid/low"),
    (5.406, 5.513, "LN 3 mid"),
    (5.513, 5.699, "LN 3 mid/high"),
    (5.699, 5.885, "LN 3 high"),
    (5.885, 6.071, "LN 4 low"),
    (6.071, 6.257, "LN 4 mid/low"),
    (6.257, 6.347, "LN 4 mid"),
    (6.347, 6.341, "LN 4 mid/high"),
    (6.341, 6.335, "LN 4 high"),
    (6.335, 6.329, "LN 5 low"),
    (6.329, 6.323, "LN 5 mid/low"),
    (6.323, 6.371, "LN 5 mid"),
    (6.371, 6.473, "LN 5 mid/high"),
    (6.473, 6.575, "LN 5 high"),
    (6.575, 6.677, "LN 6 low"),
    (6.677, 6.779, "LN 6 mid/low"),
    (6.779, 6.84, "LN 6 mid"),
    (6.84, 6.86, "LN 6 mid/high"),
    (6.86, 6.88, "LN 6 high"),
    (6.88, 6.9, "LN 7 low"),
    (6.9, 6.92, "LN 7 mid/low"),
    (6.92, 6.973, "LN 7 mid"),
    (6.973, 7.059, "LN 7 mid/high"),
    (7.059, 7.145, "LN 7 high"),
    (7.145, 7.231, "LN 8 low"),
    (7.231, 7.317, "LN 8 mid/low"),
    (7.317, 7.366, "LN 8 mid"),
    (7.366, 7.378, "LN 8 mid/high"),
    (7.378, 7.39, "LN 8 high"),
    (7.39, 7.402, "LN 9 low"),
    (7.402, 7.414, "LN 9 mid/low"),
    (7.414, 7.469, "LN 9 mid"),
    (7.469, 7.567, "LN 9 mid/high"),
    (7.567, 7.665, "LN 9 high"),
    (7.665, 7.763, "LN Terra low"),
    (7.763, 7.861, "LN Terra mid/low"),
    (7.861, 7.952, "LN Terra mid"),
    (7.952, 8.036, "LN Terra mid/high"),
    (8.036, 8.12, "LN Terra high"),
    (8.12, 8.204, "LN Celestial low"),
    (8.204, 8.288, "LN Celestial mid/low"),
    (8.288, 8.367, "LN Celestial mid"),
    (8.367, 8.441, "LN Celestial mid/high"),
    (8.441, 8.515, "LN Celestial high"),
    (8.515, 8.589, "LN Mystery low"),
    (8.589, 8.663, "LN Mystery mid/low"),
    (8.663, 8.737, "LN Mystery mid"),
    (8.737, 8.811, "LN Mystery mid/high"),
    (8.811, 8.885, "LN Mystery high"),
    (8.885, 8.959, "LN Nihility low"),
    (8.959, 9.033, "LN Nihility mid/low"),
    (9.033, 9.112, "LN Nihility mid"),
    (9.112, 9.196, "LN Nihility mid/high"),
    (9.196, 9.28, "LN Nihility high"),
    (9.28, 9.364, "LN Finish low"),
    (9.364, 9.448, "LN Finish mid/low"),
    (9.448, 9.532, "LN Finish mid"),
    (9.532, 9.616, "LN Finish mid/high"),
    (9.616, 9.7, "LN Finish high"),
];

pub const RC_7K: &[(f64, f64, &str)] = &[
    (3.5085, 3.6631, "Regular 0 low"),
    (3.6631, 3.8177, "Regular 0 mid/low"),
    (3.8177, 3.9723, "Regular 0 mid"),
    (3.9723, 4.1269, "Regular 0 mid/high"),
    (4.1269, 4.2815, "Regular 0 high"),
    (4.2815, 4.4361, "Regular 1 low"),
    (4.4361, 4.5907, "Regular 1 mid/low"),
    (4.5907, 4.7202, "Regular 1 mid"),
    (4.7202, 4.8246, "Regular 1 mid/high"),
    (4.8246, 4.929, "Regular 1 high"),
    (4.929, 5.0334, "Regular 2 low"),
    (5.0334, 5.1378, "Regular 2 mid/low"),
    (5.1378, 5.2379, "Regular 2 mid"),
    (5.2379, 5.3337, "Regular 2 mid/high"),
    (5.3337, 5.4295, "Regular 2 high"),
    (5.4295, 5.5253, "Regular 3 low"),
    (5.5253, 5.6211, "Regular 3 mid/low"),
    (5.6211, 5.6927, "Regular 3 mid"),
    (5.6927, 5.7401, "Regular 3 mid/high"),
    (5.7401, 5.7875, "Regular 3 high"),
    (5.7875, 5.8349, "Regular 4 low"),
    (5.8349, 5.8823, "Regular 4 mid/low"),
    (5.8823, 5.9313, "Regular 4 mid"),
    (5.9313, 5.9819, "Regular 4 mid/high"),
    (5.9819, 6.0325, "Regular 4 high"),
    (6.0325, 6.0831, "Regular 5 low"),
    (6.0831, 6.1337, "Regular 5 mid/low"),
    (6.1337, 6.2176, "Regular 5 mid"),
    (6.2176, 6.3348, "Regular 5 mid/high"),
    (6.3348, 6.452, "Regular 5 high"),
    (6.452, 6.5692, "Regular 6 low"),
    (6.5692, 6.6864, "Regular 6 mid/low"),
    (6.6864, 6.7772, "Regular 6 mid"),
    (6.7772, 6.8416, "Regular 6 mid/high"),
    (6.8416, 6.906, "Regular 6 high"),
    (6.906, 6.9704, "Regular 7 low"),
    (6.9704, 7.0348, "Regular 7 mid/low"),
    (7.0348, 7.1085, "Regular 7 mid"),
    (7.1085, 7.1915, "Regular 7 mid/high"),
    (7.1915, 7.2745, "Regular 7 high"),
    (7.2745, 7.3575, "Regular 8 low"),
    (7.3575, 7.4405, "Regular 8 mid/low"),
    (7.4405, 7.5096, "Regular 8 mid"),
    (7.5096, 7.5648, "Regular 8 mid/high"),
    (7.5648, 7.62, "Regular 8 high"),
    (7.62, 7.6752, "Regular 9 low"),
    (7.6752, 7.7304, "Regular 9 mid/low"),
    (7.7304, 7.8134, "Regular 9 mid"),
    (7.8134, 7.9242, "Regular 9 mid/high"),
    (7.9242, 8.035, "Regular 9 high"),
    (8.035, 8.1458, "Regular 10 low"),
    (8.1458, 8.2566, "Regular 10 mid/low"),
    (8.2566, 8.357, "Regular 10 mid"),
    (8.357, 8.447, "Regular 10 mid/high"),
    (8.447, 8.537, "Regular 10 high"),
    (8.537, 8.627, "Regular Gamma low"),
    (8.627, 8.717, "Regular Gamma mid/low"),
    (8.717, 8.8079, "Regular Gamma mid"),
    (8.8079, 8.8997, "Regular Gamma mid/high"),
    (8.8997, 8.9915, "Regular Gamma high"),
    (8.9915, 9.0833, "Regular Azimuth low"),
    (9.0833, 9.1751, "Regular Azimuth mid/low"),
    (9.1751, 9.2921, "Regular Azimuth mid"),
    (9.2921, 9.4343, "Regular Azimuth mid/high"),
    (9.4343, 9.5765, "Regular Azimuth high"),
    (9.5765, 9.7187, "Regular Zenith low"),
    (9.7187, 9.8609, "Regular Zenith mid/low"),
    (9.8609, 9.9728, "Regular Zenith mid"),
    (9.9728, 10.0544, "Regular Zenith mid/high"),
    (10.0544, 10.136, "Regular Zenith high"),
    (10.136, 10.2176, "Regular Stellium low"),
    (10.2176, 10.2992, "Regular Stellium mid/low"),
    (10.2992, 10.3808, "Regular Stellium mid"),
    (10.3808, 10.4624, "Regular Stellium mid/high"),
    (10.4624, 10.544, "Regular Stellium high"),
];

pub const LN_7K: &[(f64, f64, &str)] = &[
    (4.836, 4.9704, "LN 3 low"),
    (4.9704, 5.1048, "LN 3 mid/low"),
    (5.1048, 5.2392, "LN 3 mid"),
    (5.2392, 5.3736, "LN 3 mid/high"),
    (5.3736, 5.508, "LN 3 high"),
    (5.508, 5.5592, "LN 4 low"),
    (5.5592, 5.6104, "LN 4 mid/low"),
    (5.6104, 5.6616, "LN 4 mid"),
    (5.6616, 5.7128, "LN 4 mid/high"),
    (5.7128, 5.764, "LN 4 high"),
    (5.764, 5.8824, "LN 5 low"),
    (5.8824, 6.0008, "LN 5 mid/low"),
    (6.0008, 6.1192, "LN 5 mid"),
    (6.1192, 6.2376, "LN 5 mid/high"),
    (6.2376, 6.356, "LN 5 high"),
    (6.356, 6.4708, "LN 6 low"),
    (6.4708, 6.5856, "LN 6 mid/low"),
    (6.5856, 6.7004, "LN 6 mid"),
    (6.7004, 6.8152, "LN 6 mid/high"),
    (6.8152, 6.93, "LN 6 high"),
    (6.93, 6.9372, "LN 7 low"),
    (6.9372, 6.9444, "LN 7 mid/low"),
    (6.9444, 6.9516, "LN 7 mid"),
    (6.9516, 6.9588, "LN 7 mid/high"),
    (6.9588, 7.053, "LN 7 high"),
    (7.053, 7.1472, "LN 8 low"),
    (7.1472, 7.2414, "LN 8 mid/low"),
    (7.2414, 7.3356, "LN 8 mid"),
    (7.3356, 7.4298, "LN 8 mid/high"),
    (7.4298, 7.4872, "LN 8 high"),
    (7.4872, 7.5446, "LN 9 low"),
    (7.5446, 7.602, "LN 9 mid/low"),
    (7.602, 7.6594, "LN 9 mid"),
    (7.6594, 7.7168, "LN 9 mid/high"),
    (7.7168, 7.8572, "LN 9 high"),
    (7.8572, 7.9976, "LN 10 low"),
    (7.9976, 8.138, "LN 10 mid/low"),
    (8.138, 8.2784, "LN 10 mid"),
    (8.2784, 8.4188, "LN 10 mid/high"),
    (8.4188, 8.4938, "LN 10 high"),
    (8.4938, 8.5688, "LN Gamma low"),
    (8.5688, 8.6438, "LN Gamma mid/low"),
    (8.6438, 8.7188, "LN Gamma mid"),
    (8.7188, 8.7938, "LN Gamma mid/high"),
    (8.7938, 8.8878, "LN Gamma high"),
    (8.8878, 8.9818, "LN Azimuth low"),
    (8.9818, 9.0758, "LN Azimuth mid/low"),
    (9.0758, 9.1698, "LN Azimuth mid"),
    (9.1698, 9.2638, "LN Azimuth mid/high"),
    (9.2638, 9.3784, "LN Azimuth high"),
    (9.3784, 9.493, "LN Zenith low"),
    (9.493, 9.6076, "LN Zenith mid/low"),
    (9.6076, 9.7222, "LN Zenith mid"),
    (9.7222, 9.8368, "LN Zenith mid/high"),
    (9.8368, 9.975, "LN Zenith high"),
    (9.975, 10.1132, "LN Stellium low"),
    (10.1132, 10.2514, "LN Stellium mid/low"),
    (10.2514, 10.3896, "LN Stellium mid"),
    (10.3896, 10.5278, "LN Stellium mid/high"),
    (10.5278, 10.666, "LN Stellium high"),
];

pub const RC_10K: &[(f64, f64, &str)] = &[
    (1.5427, 1.6496, "Level 0 low"),
    (1.6496, 1.7565, "Level 0 mid/low"),
    (1.7565, 1.8635, "Level 0 mid"),
    (1.8635, 1.9704, "Level 0 mid/high"),
    (1.9704, 2.0773, "Level 0 high"),
    (2.0773, 2.1842, "Level 1 low"),
    (2.1842, 2.2911, "Level 1 mid/low"),
    (2.2911, 2.3889, "Level 1 mid"),
    (2.3889, 2.4778, "Level 1 mid/high"),
    (2.4778, 2.5666, "Level 1 high"),
    (2.5666, 2.6554, "Level 2 low"),
    (2.6554, 2.7443, "Level 2 mid/low"),
    (2.7443, 2.8622, "Level 2 mid"),
    (2.8622, 3.0092, "Level 2 mid/high"),
    (3.0092, 3.1563, "Level 2 high"),
    (3.1563, 3.3033, "Level 3 low"),
    (3.3033, 3.4503, "Level 3 mid/low"),
    (3.4503, 3.5455, "Level 3 mid"),
    (3.5455, 3.5887, "Level 3 mid/high"),
    (3.5887, 3.632, "Level 3 high"),
    (3.632, 3.6752, "Level 4 low"),
    (3.6752, 3.7184, "Level 4 mid/low"),
    (3.7184, 3.7864, "Level 4 mid"),
    (3.7864, 3.879, "Level 4 mid/high"),
    (3.879, 3.9717, "Level 4 high"),
    (3.9717, 4.0643, "Level 5 low"),
    (4.0643, 4.157, "Level 5 mid/low"),
    (4.157, 4.2547, "Level 5 mid"),
    (4.2547, 4.3575, "Level 5 mid/high"),
    (4.3575, 4.4602, "Level 5 high"),
    (4.4602, 4.563, "Level 6 low"),
    (4.563, 4.6658, "Level 6 mid/low"),
    (4.6658, 4.7767, "Level 6 mid"),
    (4.7767, 4.8956, "Level 6 mid/high"),
    (4.8956, 5.0146, "Level 6 high"),
    (5.0146, 5.1335, "Level 7 low"),
    (5.1335, 5.2525, "Level 7 mid/low"),
    (5.2525, 5.3615, "Level 7 mid"),
    (5.3615, 5.4607, "Level 7 mid/high"),
    (5.4607, 5.5598, "Level 7 high"),
    (5.5598, 5.659, "Level 8 low"),
    (5.659, 5.7581, "Level 8 mid/low"),
    (5.7581, 5.8642, "Level 8 mid"),
    (5.8642, 5.9773, "Level 8 mid/high"),
    (5.9773, 6.0904, "Level 8 high"),
    (6.0904, 6.2034, "Level 9 low"),
    (6.2034, 6.3165, "Level 9 mid/low"),
    (6.3165, 6.4809, "Level 9 mid"),
    (6.4809, 6.6967, "Level 9 mid/high"),
    (6.6967, 6.9125, "Level 9 high"),
    (6.9125, 7.1283, "Level 10 low"),
    (7.1283, 7.3441, "Level 10 mid/low"),
    (7.3441, 7.4888, "Level 10 mid"),
    (7.4888, 7.5624, "Level 10 mid/high"),
    (7.5624, 7.6361, "Level 10 high"),
    (7.6361, 7.7097, "Level XI low"),
    (7.7097, 7.7834, "Level XI mid/low"),
    (7.7834, 7.8989, "Level XI mid"),
    (7.8989, 8.0564, "Level XI mid/high"),
    (8.0564, 8.2139, "Level XI high"),
    (8.2139, 8.3714, "Level V low"),
    (8.3714, 8.5289, "Level V mid/low"),
    (8.5289, 8.6864, "Level V mid"),
    (8.6864, 8.8439, "Level V mid/high"),
    (8.8439, 9.0014, "Level V high"),
];
