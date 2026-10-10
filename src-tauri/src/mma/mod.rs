//! osu!mania pattern report and dan rating, ported from ManiaMapAnalyser by Leo_Black
//! (<https://github.com/LeoBlackMT/osumania_map_analyser>, MIT — see `LICENSE` in this folder).
//!
//! - [`patterns`]: its pattern analysis (itself built on Interlude's RC pattern finder, YAVSRG,
//!   with LN detection added): every row of the chart becomes a primitive (notes, jacks,
//!   direction, long-note heads / bodies / tails), pattern matchers label short windows of
//!   primitives, and the labels are clustered by speed into the chart's report: the patterns
//!   that matter, their BPM and specific types, a category and a mode tag (RC / LN / HB / Mix).
//! - [`dan`]: an estimate of the dan (course tier) a chart is at. 4K rice is rated by its
//!   "Azusa" estimator (its own skill curve blended with the Daniel and Sunny star ratings,
//!   calibrated on its benchmark of rated charts); everything else maps the Sunny star rating
//!   onto the community's dan tables for 4K, 6K, 7K and 10K.
//!
//! The ports follow the JavaScript closely (same constants, same order of operations) so results
//! match the analyser's, with two deliberate differences: notes come from Fumen's `.osu` parser
//! (lazer's key count rounding), and a note stacked inside a long note is dropped instead of
//! failing the pattern report. Azusa's marathon correction is left out: it needs Etterna's
//! MinaCalc (a WebAssembly build of a C++ calculator) and only nudges 4K charts over five minutes.

mod azusa;
mod core;
pub mod dan;
mod daniel;
pub mod patterns;
mod sunny;

use crate::chart::{Chart, Kind};

/// A note as the analyser's `.osu` parser sees it: column, start and, for long notes, the end.
#[derive(Debug, Clone, Copy)]
struct Note {
    col: usize,
    start: i32,
    /// `Some` for long notes (object type 128), even when it ends where it starts
    end: Option<i32>,
}

/// The osu!mania notes of a chart in time order (then by column), and the share of long notes.
fn notes(chart: &Chart) -> (Vec<Note>, f64) {
    let keys = chart.keys.max(1) as usize;
    let notes: Vec<Note> = chart
        .objects
        .iter()
        .map(|o| Note { col: (o.lane as usize).min(keys - 1), start: o.time, end: (o.kind == Kind::Hold).then_some(o.end) })
        .collect();
    let lns = notes.iter().filter(|n| n.end.is_some()).count();
    let ratio = if notes.is_empty() { 0.0 } else { lns as f64 / notes.len() as f64 };
    (notes, ratio)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes this port's numbers for a list of `.osu` files (one path per line), to compare
    /// with ManiaMapAnalyser's own:
    /// `FUMEN_MMA_LIST=list.txt FUMEN_MMA_OUT=rust.jsonl [FUMEN_MMA_RATE=1.5] cargo test mma::tests::compare -- --ignored`
    #[test]
    #[ignore = "needs FUMEN_MMA_LIST and FUMEN_MMA_OUT"]
    fn compare() {
        let (Some(list), Some(out)) = (std::env::var_os("FUMEN_MMA_LIST"), std::env::var_os("FUMEN_MMA_OUT")) else { return };
        let rate: f64 = std::env::var("FUMEN_MMA_RATE").ok().and_then(|r| r.parse().ok()).unwrap_or(1.0);
        let mut lines = Vec::new();
        let t = std::time::Instant::now();
        for path in std::fs::read_to_string(list).unwrap().lines().filter(|l| !l.is_empty()) {
            let chart = crate::chart::parse(&String::from_utf8_lossy(&std::fs::read(path).unwrap()));
            let keys = chart.keys as usize;
            let (notes, ln_ratio) = notes(&chart);
            let report = patterns::report(&chart);
            let v = serde_json::json!({
                "path": path,
                "keys": keys,
                "lnRatio": ln_ratio,
                "sunny": sunny::star(&notes, keys, chart.od, rate, false),
                "daniel": daniel::star(&notes, keys, rate),
                "azusa": azusa::numeric(&notes, keys, chart.od, ln_ratio, rate, None),
                "dan": dan::rate(&chart, rate).map(|d| d.label()),
                "category": report.as_ref().map(|r| r.category.clone()),
                "mode": report.as_ref().map(|r| r.mode),
                "sv": report.as_ref().map(|r| r.sv_amount),
                "clusters": report.as_ref().map(|r| r.clusters.iter().map(|c| serde_json::json!([c.pattern, c.bpm, c.mixed, c.amount.round(), c.specific.iter().map(|(n, v)| serde_json::json!([n, (*v as f64 * 1000.0).round() / 1000.0])).collect::<Vec<_>>()])).collect::<Vec<_>>()),
            });
            lines.push(v.to_string());
        }
        eprintln!("{} charts in {:?}", lines.len(), t.elapsed());
        std::fs::write(out, lines.join("\n")).unwrap();
    }
}
