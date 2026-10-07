//! osu!mania star rating at any clock rate (HT 0.75×, DT 1.5×, practice rates).
//!
//! Follows lazer's mania difficulty calculator: every note adds to a per-column "individual"
//! strain and to an "overall" strain, both decaying over time; the hardest moment of every
//! 400 ms section is kept, and the sections are summed hardest first with weights 0.9ⁿ.
//! A clock rate just divides every time by the rate. lazer's own value for 1.0× comes with the
//! library, so the real-library test below checks this against it.

use crate::chart::Chart;

const INDIVIDUAL_DECAY_BASE: f64 = 0.125;
const OVERALL_DECAY_BASE: f64 = 0.30;
/// ms; releasing a hold close to another release is barely harder than one release
const RELEASE_THRESHOLD: f64 = 30.0;
const SECTION_LENGTH: f64 = 400.0;
const DECAY_WEIGHT: f64 = 0.9;
const DIFFICULTY_MULTIPLIER: f64 = 0.018;

/// Rates the chart panel offers, 0.5× to 2.0× in steps of 0.05. Star ratings are sent for all
/// of them so the panel can switch without asking again.
pub const RATES: std::ops::RangeInclusive<u32> = 10..=40;
pub const RATE_STEP: f64 = 0.05;

/// Star rating of an osu!mania chart at `rate`; 0 for other modes and empty charts.
pub fn mania(chart: &Chart, rate: f64) -> f64 {
    let objects = &chart.objects;
    if chart.mode != 3 || chart.keys == 0 || objects.len() < 2 || rate <= 0.0 {
        return 0.0;
    }
    let keys = chart.keys as usize;
    let mut start_times = vec![0.0f64; keys];
    let mut end_times = vec![0.0f64; keys];
    let mut individual_strains = vec![0.0f64; keys];
    let mut individual_strain = 0.0f64;
    let mut overall_strain = 1.0f64;

    let mut peaks: Vec<f64> = Vec::with_capacity(objects.len() / 4 + 1);
    let mut section_peak = 0.0f64;
    let mut section_end = 0.0f64;

    // the first object only sets the clock: strain starts with the second one
    for (i, o) in objects.iter().enumerate().skip(1) {
        let start = o.time as f64 / rate;
        let end = o.end as f64 / rate;
        let prev_start = objects[i - 1].time as f64 / rate;
        let delta = start - prev_start;
        let column = (o.lane as usize).min(keys - 1);

        if i == 1 {
            section_end = (start / SECTION_LENGTH).ceil() * SECTION_LENGTH;
        }
        while start > section_end {
            peaks.push(section_peak);
            // a section starts at the strain left over from the previous note, decayed
            let gap = section_end - prev_start;
            section_peak = decay(individual_strain, gap, INDIVIDUAL_DECAY_BASE) + decay(overall_strain, gap, OVERALL_DECAY_BASE);
            section_end += SECTION_LENGTH;
        }

        let mut overlapping = false;
        let mut closest_end = (end - start).abs();
        // everything is a bit harder while another column is being held
        let mut hold_factor = 1.0;
        for k in 0..keys {
            overlapping |= bigger(end_times[k], start) && bigger(end, end_times[k]) && bigger(start, start_times[k]);
            if bigger(end_times[k], end) && bigger(start, start_times[k]) {
                hold_factor = 1.25;
            }
            closest_end = closest_end.min((end - end_times[k]).abs());
        }
        // a hold that has to be released on its own, away from other releases
        let hold_addition = if overlapping { 1.0 / (1.0 + (0.27 * (RELEASE_THRESHOLD - closest_end)).exp()) } else { 0.0 };

        individual_strains[column] = decay(individual_strains[column], start - start_times[column], INDIVIDUAL_DECAY_BASE) + 2.0 * hold_factor;
        // within a chord, the hardest column counts
        individual_strain = if delta <= 1.0 { individual_strain.max(individual_strains[column]) } else { individual_strains[column] };
        overall_strain = decay(overall_strain, delta, OVERALL_DECAY_BASE) + (1.0 + hold_addition) * hold_factor;

        start_times[column] = start;
        end_times[column] = end;
        section_peak = section_peak.max(individual_strain + overall_strain);
    }
    peaks.push(section_peak);

    peaks.retain(|p| *p > 0.0);
    peaks.sort_unstable_by(|a, b| b.total_cmp(a));
    let mut weight = 1.0;
    let mut sum = 0.0;
    for p in peaks {
        sum += p * weight;
        weight *= DECAY_WEIGHT;
    }
    sum * DIFFICULTY_MULTIPLIER
}

/// Star ratings at every rate in [`RATES`]; empty outside osu!mania.
pub fn mania_rates(chart: &Chart) -> Vec<f32> {
    if chart.mode != 3 {
        return Vec::new();
    }
    RATES.map(|r| round2(mania(chart, r as f64 * RATE_STEP))).collect()
}

pub fn round2(v: f64) -> f32 {
    ((v * 100.0).round() / 100.0) as f32
}

fn decay(value: f64, ms: f64, base: f64) -> f64 {
    value * base.powf(ms / 1000.0)
}

/// `a` is bigger than `b` by more than a millisecond.
fn bigger(a: f64, b: f64) -> bool {
    a - 1.0 > b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::parse;

    fn chart(objects: &str, keys: u8) -> Chart {
        parse(&format!("[General]\nMode: 3\n[Difficulty]\nCircleSize:{keys}\n[HitObjects]\n{objects}"))
    }

    fn stream(keys: u8, notes: usize, gap: i32) -> String {
        (0..notes)
            .map(|i| {
                let lane = i % keys as usize;
                let x = (lane * 512 + 256) / keys as usize;
                format!("{x},192,{},1,0,0:0:0:0:\n", 1000 + i as i32 * gap)
            })
            .collect()
    }

    #[test]
    fn two_notes_by_hand() {
        // one strained note at 500 ms: individual 2, overall 1·0.3^0.5 + 1
        let c = chart("64,192,0,1,0,0:0:0:0:\n192,192,500,1,0,0:0:0:0:\n", 4);
        let expected = (2.0 + 0.3f64.powf(0.5) + 1.0) * DIFFICULTY_MULTIPLIER;
        assert!((mania(&c, 1.0) - expected).abs() < 1e-12);
    }

    #[test]
    fn faster_is_harder() {
        let c = chart(&stream(4, 400, 120), 4);
        let (ht, nm, dt) = (mania(&c, 0.75), mania(&c, 1.0), mania(&c, 1.5));
        assert!(ht < nm && nm < dt, "{ht} {nm} {dt}");
        // the same chart written 1.5× denser is what DT plays
        let dense = chart(&stream(4, 400, 80), 4);
        assert!((mania(&dense, 1.0) - dt).abs() < 0.01);
    }

    #[test]
    fn holds_add_strain() {
        // (the first note only starts the clock, so the hold comes second)
        let rest = "192,192,1200,1,0,0:0:0:0:\n320,192,1400,1,0,0:0:0:0:\n448,192,1600,1,0,0:0:0:0:\n";
        let taps = chart(&format!("448,192,800,1,0,0:0:0:0:\n64,192,1000,1,0,0:0:0:0:\n{rest}"), 4);
        let held = chart(&format!("448,192,800,1,0,0:0:0:0:\n64,192,1000,128,0,1900:0:0:0:0:\n{rest}"), 4);
        assert!(mania(&held, 1.0) > mania(&taps, 1.0));
    }

    #[test]
    fn rates_table() {
        let c = chart(&stream(7, 300, 100), 7);
        let table = mania_rates(&c);
        assert_eq!(table.len(), RATES.count());
        assert!(table.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(table[10], round2(mania(&c, 1.0)));
        assert!(mania_rates(&parse("[General]\nMode: 0\n[HitObjects]\n0,0,0,1,0\n")).is_empty());
    }

    /// Compares 1.0× against the star rating lazer stored for every osu!mania difficulty:
    /// `FUMEN_TEST_STORAGE=%APPDATA%/osu FUMEN_TEST_EXPORT=<fumen-realm export> cargo test stars_match_lazer -- --ignored --nocapture`
    #[test]
    #[ignore = "needs FUMEN_TEST_STORAGE (lazer data folder) and FUMEN_TEST_EXPORT"]
    fn stars_match_lazer() {
        let (Some(storage), Some(export)) = (std::env::var_os("FUMEN_TEST_STORAGE"), std::env::var_os("FUMEN_TEST_EXPORT")) else { return };
        let storage = std::path::PathBuf::from(storage);
        let export: serde_json::Value = serde_json::from_slice(&std::fs::read(export).unwrap()).unwrap();
        let mut diffs: Vec<(f64, String)> = Vec::new();
        for set in export["sets"].as_array().unwrap() {
            for m in set["maps"].as_array().unwrap() {
                let (Some(hash), Some(sr)) = (m["hash"].as_str(), m["sr"].as_f64()) else { continue };
                if m["rulesetId"].as_i64() != Some(3) {
                    continue;
                }
                let Ok(c) = crate::charts::load(&storage, hash) else { continue };
                if c.mode != 3 {
                    continue;
                }
                let name = format!("{} [{}]", m["title"].as_str().unwrap_or("?"), m["version"].as_str().unwrap_or("?"));
                diffs.push((mania(&c, 1.0) - sr, format!("{name}: lazer {sr:.3}")));
            }
        }
        let n = diffs.len() as f64;
        let within = |d: f64| diffs.iter().filter(|x| x.0.abs() <= d).count() as f64 / n * 100.0;
        eprintln!(
            "{} charts · within 0.005: {:.1}% · 0.01: {:.1}% · 0.05: {:.1}% · 0.2: {:.1}%",
            diffs.len(),
            within(0.005),
            within(0.01),
            within(0.05),
            within(0.2)
        );
        let close = within(0.01);
        diffs.sort_by(|a, b| b.0.abs().total_cmp(&a.0.abs()));
        for (d, name) in diffs.iter().take(12) {
            eprintln!("  {d:+.3}  {name}");
        }
        assert!(close > 95.0);
    }
}
