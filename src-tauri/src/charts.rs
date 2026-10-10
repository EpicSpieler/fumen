//! Charts for the UI, and chart analysis for the whole library.
//!
//! A single difficulty is read on demand for the chart panel (notes + full analysis). The library
//! job analyses every difficulty once and caches a summary by `.osu` hash, so search can filter by
//! pattern and peak density. lazer stores files content-addressed, so a cached row never goes stale.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::analysis::{self, Analysis};
use crate::chart::{self, Chart};
use crate::error::{Error, Result};
use crate::mma::{dan, patterns};
use crate::paths;
use crate::stars;

pub fn load(storage: &Path, hash: &str) -> Result<Chart> {
    let path = paths::lazer_file(storage, hash).ok_or_else(|| Error::known("chart-missing", "This difficulty has no chart file."))?;
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::known("chart-missing", "This difficulty's .osu file is missing from lazer's files."),
        _ => e.into(),
    })?;
    // very old files can be in a legacy code page; the parts we read are ASCII anyway
    Ok(chart::parse(&String::from_utf8_lossy(&bytes)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChartOut<'a> {
    mode: u8,
    keys: u8,
    /// `[time, lane, length]` per object (lane is the x position outside osu!mania)
    notes: Vec<i32>,
    /// `[time, beat length, meter]` per uninherited timing point
    beats: Vec<f64>,
    /// `[start, end]` per break
    breaks: Vec<i32>,
    /// `[start, end]` per kiai section
    kiai: Vec<i32>,
    /// osu!mania star rating at 0.5×, 0.55× … 2.0× (empty for other modes)
    stars: Vec<f32>,
    analysis: &'a Analysis,
    /// osu!mania: the pattern report (ManiaMapAnalyser)
    #[serde(skip_serializing_if = "Option::is_none")]
    report: Option<patterns::Report>,
    /// osu!mania: the dan at 1×
    #[serde(skip_serializing_if = "Option::is_none")]
    dan: Option<dan::Dan>,
}

pub fn chart_json(chart: &Chart) -> Result<Vec<u8>> {
    let analysis = analysis::analyse(chart);
    let mania = chart.mode == 3;
    let out = ChartOut {
        mode: chart.mode,
        keys: chart.keys,
        notes: chart.objects.iter().flat_map(|o| [o.time, if mania { o.lane as i32 } else { o.x }, o.end - o.time]).collect(),
        beats: chart
            .timing
            .iter()
            .filter(|t| t.uninherited && t.beat_len > 0.0)
            .flat_map(|t| [t.time, t.beat_len, t.meter as f64])
            .collect(),
        breaks: chart.breaks.iter().flat_map(|&(s, e)| [s, e]).collect(),
        kiai: kiai_sections(chart, analysis.end),
        stars: stars::mania_rates(chart),
        analysis: &analysis,
        report: patterns::report(chart),
        dan: dan::rate(chart, 1.0),
    };
    Ok(serde_json::to_vec(&out)?)
}

/// Kiai is a flag on timing points: on from one point until a later point turns it off.
fn kiai_sections(chart: &Chart, end: i32) -> Vec<i32> {
    let mut out = Vec::new();
    let mut open: Option<i32> = None;
    for p in &chart.timing {
        let t = p.time as i32;
        match (open, p.kiai) {
            (None, true) => open = Some(t),
            (Some(s), false) if t > s => {
                out.extend([s, t]);
                open = None;
            }
            (Some(_), false) => open = None,
            _ => {}
        }
    }
    if let Some(s) = open.filter(|&s| end > s) {
        out.extend([s, end]);
    }
    out
}

// ── library-wide cache ─────────────────────────────────────────────────────

/// Difficulty hashes without a current analysis.
pub fn pending(conn: &Connection) -> Result<Vec<String>> {
    let mut st = conn.prepare(
        "SELECT DISTINCT m.hash FROM maps m
         LEFT JOIN chart_stats c ON c.hash = m.hash AND c.version = ?1
         WHERE m.hash IS NOT NULL AND c.hash IS NULL",
    )?;
    let hashes = st.query_map([analysis::VERSION], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(hashes)
}

pub struct Summary {
    hash: String,
    nps_avg: f32,
    nps_peak: f32,
    ln_time: f32,
    jack_ratio: f32,
    longest_burst: i32,
    tags: String,
    patterns: String,
    sr_ht: Option<f32>,
    sr_dt: Option<f32>,
    dan: Option<String>,
    dan_value: Option<f32>,
    category: Option<String>,
}

fn summarize(hash: &str, chart: &Chart) -> Summary {
    let a = analysis::analyse(chart);
    let rated = |rate: f64| (chart.mode == 3).then(|| stars::round2(stars::mania(chart, rate)));
    let d = dan::rate(chart, 1.0);
    let report = patterns::report(chart);
    Summary {
        hash: hash.to_owned(),
        nps_avg: a.nps_avg,
        nps_peak: a.nps_peak,
        ln_time: a.ln_time,
        jack_ratio: a.jack_ratio,
        longest_burst: a.longest_burst,
        tags: a.tags.join(" "),
        patterns: serde_json::to_string(&a.patterns).unwrap_or_else(|_| "[]".into()),
        sr_ht: rated(0.75),
        sr_dt: rated(1.5),
        dan: d.as_ref().map(dan::Dan::label),
        dan_value: d.and_then(|d| d.value),
        category: report.map(|r| if r.sv() { format!("{} SV", r.category) } else { r.category }),
    }
}

/// Reads and analyses files in parallel. Files that can't be read are left out (and retried on
/// the next run) rather than cached as empty.
pub fn analyse_batch(storage: &Path, hashes: &[String]) -> Vec<Summary> {
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8);
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(hash) = hashes.get(i) else { break };
                        if let Ok(chart) = load(storage, hash) {
                            out.push(summarize(hash, &chart));
                        }
                    }
                    out
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

pub fn store(conn: &mut Connection, rows: &[Summary]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut st = tx.prepare(
            "INSERT OR REPLACE INTO chart_stats
               (hash, version, nps_avg, nps_peak, ln_time, jack_ratio, longest_burst, tags, patterns, sr_ht, sr_dt, dan, dan_value, category)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        for r in rows {
            st.execute(params![
                r.hash,
                analysis::VERSION,
                r.nps_avg,
                r.nps_peak,
                r.ln_time,
                r.jack_ratio,
                r.longest_burst,
                r.tags,
                r.patterns,
                r.sr_ht,
                r.sr_dt,
                r.dan,
                r.dan_value,
                r.category
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Analyses every difficulty of a real lazer install and prints what came out:
    /// `FUMEN_TEST_STORAGE=%APPDATA%/osu FUMEN_TEST_EXPORT=<fumen-realm export> cargo test real_library -- --ignored --nocapture`
    #[test]
    #[ignore = "needs FUMEN_TEST_STORAGE (lazer data folder) and FUMEN_TEST_EXPORT"]
    fn real_library() {
        let (Some(storage), Some(export)) = (std::env::var_os("FUMEN_TEST_STORAGE"), std::env::var_os("FUMEN_TEST_EXPORT")) else { return };
        let storage = std::path::PathBuf::from(storage);
        let export: serde_json::Value = serde_json::from_slice(&std::fs::read(export).unwrap()).unwrap();
        let mut names = std::collections::HashMap::new();
        let mut hashes = Vec::new();
        for set in export["sets"].as_array().unwrap() {
            for m in set["maps"].as_array().unwrap() {
                if let Some(h) = m["hash"].as_str() {
                    names.insert(h.to_owned(), format!("{} [{}]", set["title"].as_str().or(m["title"].as_str()).unwrap_or("?"), m["version"].as_str().unwrap_or("?")));
                    hashes.push(h.to_owned());
                }
            }
        }
        hashes.sort();
        hashes.dedup();
        let t = std::time::Instant::now();
        let out = analyse_batch(&storage, &hashes);
        eprintln!("analysed {} of {} charts in {:?}", out.len(), hashes.len(), t.elapsed());
        let mut tags: std::collections::BTreeMap<String, usize> = Default::default();
        for s in &out {
            for t in s.tags.split_whitespace() {
                *tags.entry(t.into()).or_default() += 1;
            }
        }
        eprintln!("tags: {tags:?}");
        let peak = out.iter().map(|s| s.nps_peak).fold(0f32, f32::max);
        eprintln!("highest peak: {peak} notes/s");
        // a sample per tag, to eyeball
        for tag in ["stream", "jumpstream", "handstream", "chordjack", "jacks", "ln", "stamina"] {
            for s in out.iter().filter(|s| s.tags.split_whitespace().next() == Some(tag) || (tag == "stamina" && s.tags.contains(tag))).take(4) {
                eprintln!("{tag:>10}: {} → {} | peak {:.1}", names[&s.hash], s.tags, s.nps_peak);
            }
        }
        assert_eq!(out.len(), hashes.len());
    }

    /// Chart files for the browser preview (tools/browser-preview), for every difficulty whose
    /// title contains one of the comma-separated `FUMEN_PREVIEW_TITLES` (and every one already
    /// there, refreshed). osu!mania charts also get `dans`: the dan at every rate the panel offers,
    /// for the preview's `get_dan`:
    /// `FUMEN_TEST_STORAGE=… FUMEN_TEST_EXPORT=… FUMEN_PREVIEW_TITLES="FREEDOM DiVE,Ready Steady"
    ///  FUMEN_PREVIEW_CHARTS=../tools/browser-preview/.cache/charts cargo test preview_charts -- --ignored`
    #[test]
    #[ignore = "writes chart files for the browser preview"]
    fn preview_charts() {
        let var = std::env::var_os;
        let (Some(storage), Some(export), Some(titles), Some(out)) =
            (var("FUMEN_TEST_STORAGE"), var("FUMEN_TEST_EXPORT"), var("FUMEN_PREVIEW_TITLES"), var("FUMEN_PREVIEW_CHARTS"))
        else {
            return;
        };
        let storage = std::path::PathBuf::from(storage);
        let out = std::path::PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        let wanted: Vec<String> =
            titles.to_string_lossy().split(',').map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
        let export: serde_json::Value = serde_json::from_slice(&std::fs::read(export).unwrap()).unwrap();
        let mut written = 0;
        for set in export["sets"].as_array().unwrap() {
            let files = crate::hitsounds::SetFiles::new(serde_json::from_value::<Vec<(String, String)>>(set["sounds"].clone()).unwrap_or_default());
            for m in set["maps"].as_array().unwrap() {
                let title = m["title"].as_str().unwrap_or_default().to_lowercase();
                let (Some(id), Some(hash)) = (m["id"].as_str(), m["hash"].as_str()) else { continue };
                let file = out.join(format!("{id}.json"));
                if !wanted.iter().any(|w| title.contains(w.as_str())) && !file.exists() {
                    continue;
                }
                let Ok(chart) = load(&storage, hash) else { continue };
                let mut v: serde_json::Value = serde_json::from_slice(&chart_json(&chart).unwrap()).unwrap();
                if chart.mode == 3 {
                    let dans: serde_json::Map<String, serde_json::Value> = stars::RATES
                        .map(|r| r as f64 * stars::RATE_STEP)
                        .map(|r| (format!("{r:.2}"), serde_json::to_value(dan::rate(&chart, r)).unwrap()))
                        .collect();
                    v["dans"] = dans.into();
                    let read = |h: &str| paths::lazer_file(&storage, h).and_then(|p| std::fs::read(p).ok()).map(|b| String::from_utf8_lossy(&b).into_owned());
                    if let Some(osu) = read(hash) {
                        let osb = files.storyboard().and_then(read);
                        v["hitsounds"] = serde_json::to_value(crate::hitsounds::resolve(&osu, osb.as_deref(), &files)).unwrap();
                    }
                }
                std::fs::write(file, serde_json::to_vec(&v).unwrap()).unwrap();
                written += 1;
            }
        }
        eprintln!("wrote {written} charts to {}", out.display());
    }
}
