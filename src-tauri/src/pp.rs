//! Performance points for a library difficulty, from rosu-pp (MaxOhn, MIT): a port of osu!'s own
//! difficulty and performance calculators, as of osu!'s October 2025 pp update.
//!
//! A difficulty's attributes are worked out once per chart, mods and rate and kept, so the chart
//! panel can ask again with every number typed. One question carries any number of plays: the
//! panel's calculator, its accuracy steps and every point of its graph.
//!
//! Plays are given the way lazer counts them. osu!mania: Great, Good, Ok, Meh and Miss, the rest
//! are Perfect, and hold notes count twice (head and tail). osu!: Ok, Meh and Miss, the rest
//! Great, slider ends and ticks all hit. osu!taiko: Ok and Miss. osu!catch: misses (fruits and
//! droplets) and missed tiny droplets.

use std::sync::Mutex;

use rosu_pp::any::DifficultyAttributes;
use rosu_pp::catch::CatchPerformance;
use rosu_pp::mania::ManiaPerformance;
use rosu_pp::model::mods::rosu_mods::GameModsIntermode;
use rosu_pp::osu::{OsuPerformance, OsuScoreOrigin};
use rosu_pp::taiko::TaikoPerformance;
use rosu_pp::{Beatmap, Difficulty};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::paths;

/// The mods the panel offers (the rest change nothing about pp); the rate comes on its own, as
/// Double Time or Half Time at any speed.
const MODS: [&str; 5] = ["EZ", "NF", "HD", "HR", "FL"];

/// A play to price.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hits {
    pub great: u32,
    pub good: u32,
    pub ok: u32,
    pub meh: u32,
    pub miss: u32,
    /// osu!catch: tiny droplets missed
    pub tiny_miss: u32,
    /// osu!, osu!catch: the longest combo; the most the misses allow when not given
    pub combo: Option<u32>,
    /// an accuracy (0–100) to make the hits up for, in place of the counts (misses still count)
    pub acc: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub pp: f64,
    /// 0–1, as lazer shows it
    pub acc: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    /// the ruleset the chart is for (0 osu!, 1 osu!taiko, 2 osu!catch, 3 osu!mania)
    pub mode: u8,
    pub stars: f64,
    /// pp for a perfect play
    pub max: f64,
    pub max_combo: u32,
    /// judgements a play has, the most any count can be (osu!catch: fruits and droplets)
    pub total: u32,
    /// osu!catch: tiny droplets
    pub tiny: u32,
    /// one per play asked about, in order
    pub plays: Vec<Outcome>,
}

struct Kept {
    hash: String,
    mods: String,
    rate: u64,
    attrs: DifficultyAttributes,
}

/// The last few difficulties worked out: the panel asks for one chart over and over.
static KEPT: Mutex<Vec<Kept>> = Mutex::new(Vec::new());
const KEEP: usize = 8;

/// The panel's mods as rosu-pp's, with the rate as Double Time or Half Time.
fn settings(mods: &[String], rate: f64) -> (String, Difficulty) {
    let mut acronyms: Vec<&str> = MODS.iter().copied().filter(|m| mods.iter().any(|x| x == m)).collect();
    if rate > 1.0 {
        acronyms.push("DT");
    } else if rate < 1.0 {
        acronyms.push("HT");
    }
    let key = acronyms.concat();
    let difficulty = Difficulty::new().mods(GameModsIntermode::from_acronyms(&key)).clock_rate(rate).lazer(true);
    (key, difficulty)
}

fn attributes(files: &paths::Files, hash: &str, key: &str, rate: f64, difficulty: &Difficulty) -> Result<DifficultyAttributes> {
    let bits = rate.to_bits();
    if let Some(k) = KEPT.lock().unwrap().iter().find(|k| k.hash == hash && k.mods == key && k.rate == bits) {
        return Ok(k.attrs.clone());
    }
    let bytes = files.read(hash).ok_or_else(|| Error::known("chart-missing", "This difficulty's .osu file is missing."))?;
    let map = Beatmap::from_bytes(&bytes).map_err(|_| Error::known("pp-unreadable", "Couldn't read this chart for pp."))?;
    // osu! gives up on such charts too (they'd take ages); rosu-pp leaves the check to us
    map.check_suspicion().map_err(|_| Error::known("pp-suspicious", "This chart is too unusual to work out pp for."))?;
    let attrs = difficulty.calculate(&map);
    let mut kept = KEPT.lock().unwrap();
    kept.insert(0, Kept { hash: hash.to_string(), mods: key.to_string(), rate: bits, attrs: attrs.clone() });
    kept.truncate(KEEP);
    Ok(attrs)
}

/// Takes counts off a total in order, so they never add up to more than there is.
struct Budget(u32);

impl Budget {
    fn take(&mut self, n: u32) -> u32 {
        let n = n.min(self.0);
        self.0 -= n;
        n
    }
}

/// pp at the panel's mods and rate: a perfect play, and each play asked about.
pub fn sheet(files: &paths::Files, hash: &str, mods: &[String], rate: f64, plays: &[Hits]) -> Result<Sheet> {
    let rate = rate.clamp(0.5, 2.0);
    let (key, difficulty) = settings(mods, rate);
    let attrs = attributes(files, hash, &key, rate, &difficulty)?;
    let failed = |_| Error::known("pp-failed", "Couldn't work out pp for this chart.");

    Ok(match attrs {
        DifficultyAttributes::Mania(a) => {
            // lazer judges a hold note's head and tail apart
            let total = a.n_objects + a.n_hold_notes;
            let price = |h: &Hits| -> Result<Outcome> {
                let base = ManiaPerformance::new(a.clone()).difficulty(difficulty.clone());
                let mut perf = match h.acc {
                    Some(acc) => base.accuracy(acc).misses(h.miss.min(total)),
                    None => {
                        let mut left = Budget(total);
                        let (miss, meh, ok, good, great) = (left.take(h.miss), left.take(h.meh), left.take(h.ok), left.take(h.good), left.take(h.great));
                        base.n320(left.0).n300(great).n200(good).n100(ok).n50(meh).misses(miss)
                    }
                };
                let state = perf.generate_state().map_err(failed)?;
                let acc = state.accuracy(false);
                Ok(Outcome { pp: perf.state(state).calculate().map_err(failed)?.pp, acc })
            };
            Sheet {
                mode: 3,
                stars: a.stars,
                max: price(&Hits::default())?.pp,
                max_combo: a.max_combo,
                total,
                tiny: 0,
                plays: plays.iter().map(price).collect::<Result<_>>()?,
            }
        }
        DifficultyAttributes::Osu(a) => {
            let total = a.n_circles + a.n_sliders + a.n_spinners;
            let origin = OsuScoreOrigin::WithSliderAcc { max_large_ticks: a.n_large_ticks, max_slider_ends: a.n_sliders };
            let price = |h: &Hits| -> Result<Outcome> {
                let mut perf = OsuPerformance::new(a.clone()).difficulty(difficulty.clone());
                perf = match h.acc {
                    Some(acc) => perf.accuracy(acc).misses(h.miss.min(total)),
                    None => {
                        let mut left = Budget(total);
                        let (miss, meh, ok) = (left.take(h.miss), left.take(h.meh), left.take(h.ok));
                        perf.n300(left.0).n100(ok).n50(meh).misses(miss)
                    }
                };
                if let Some(combo) = h.combo {
                    perf = perf.combo(combo);
                }
                let state = perf.generate_state().map_err(failed)?;
                let acc = state.hitresults.accuracy(origin);
                Ok(Outcome { pp: perf.state(state).calculate().map_err(failed)?.pp, acc })
            };
            Sheet {
                mode: 0,
                stars: a.stars,
                max: price(&Hits::default())?.pp,
                max_combo: a.max_combo,
                total,
                tiny: 0,
                plays: plays.iter().map(price).collect::<Result<_>>()?,
            }
        }
        DifficultyAttributes::Taiko(a) => {
            let total = a.max_combo;
            let price = |h: &Hits| -> Result<Outcome> {
                let perf = TaikoPerformance::new(a.clone()).difficulty(difficulty.clone());
                let mut perf = match h.acc {
                    Some(acc) => perf.accuracy(acc).misses(h.miss.min(total)),
                    None => {
                        let mut left = Budget(total);
                        let (miss, ok) = (left.take(h.miss), left.take(h.ok));
                        perf.n300(left.0).n100(ok).misses(miss)
                    }
                };
                let state = perf.generate_state().map_err(failed)?;
                let acc = state.hitresults.accuracy();
                Ok(Outcome { pp: perf.state(state).calculate().map_err(failed)?.pp, acc })
            };
            Sheet {
                mode: 1,
                stars: a.stars,
                max: price(&Hits::default())?.pp,
                max_combo: a.max_combo,
                total,
                tiny: 0,
                plays: plays.iter().map(price).collect::<Result<_>>()?,
            }
        }
        DifficultyAttributes::Catch(a) => {
            let total = a.n_fruits + a.n_droplets;
            let tiny = a.n_tiny_droplets;
            let price = |h: &Hits| -> Result<Outcome> {
                let mut perf = CatchPerformance::new(a.clone()).difficulty(difficulty.clone());
                perf = match h.acc {
                    Some(acc) => perf.accuracy(acc).misses(h.miss.min(total)),
                    None => perf.misses(h.miss.min(total)).tiny_droplet_misses(h.tiny_miss.min(tiny)),
                };
                if let Some(combo) = h.combo {
                    perf = perf.combo(combo);
                }
                let state = perf.generate_state().map_err(failed)?;
                let acc = state.hitresults.accuracy();
                Ok(Outcome { pp: perf.state(state).calculate().map_err(failed)?.pp, acc })
            };
            Sheet {
                mode: 2,
                stars: a.stars,
                max: price(&Hits::default())?.pp,
                max_combo: a.max_combo(),
                total,
                tiny,
                plays: plays.iter().map(price).collect::<Result<_>>()?,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosu_pp::Performance;

    /// A score's lazer mods (`[{"acronym":"DT","settings":{"speed_change":1.2}}]`) as rosu-pp's,
    /// with the clock rate they set.
    fn score_mods(json: &str) -> (GameModsIntermode, f64) {
        let mods: Vec<serde_json::Value> = serde_json::from_str(json).unwrap_or_default();
        let mut acronyms = String::new();
        let mut rate = 1.0;
        for m in &mods {
            let a = m["acronym"].as_str().unwrap_or("");
            acronyms.push_str(a);
            let default = match a {
                "DT" | "NC" => 1.5,
                "HT" | "DC" => 0.75,
                _ => continue,
            };
            rate = m["settings"]["speed_change"].as_f64().unwrap_or(default);
        }
        (GameModsIntermode::from_acronyms(&acronyms), rate)
    }

    /// A 4K chart of 600 notes, one in five a hold, in lazer's file store under a made-up hash.
    fn mania_chart(tag: &str) -> (std::path::PathBuf, paths::Files, String) {
        let mut text = String::from(
            "osu file format v14\n\n[General]\nMode: 3\n\n[Difficulty]\nHPDrainRate:8\nCircleSize:4\nOverallDifficulty:8\nApproachRate:5\nSliderMultiplier:1.4\nSliderTickRate:1\n\n[TimingPoints]\n0,300,4,2,0,100,1,0\n\n[HitObjects]\n",
        );
        for i in 0..600 {
            let (x, t) = (64 + (i * 3 % 4) * 128, 1000 + i * 75);
            if i % 5 == 0 {
                text += &format!("{x},192,{t},128,0,{}:0:0:0:0:\n", t + 60);
            } else {
                text += &format!("{x},192,{t},1,0,0:0:0:0:\n");
            }
        }
        let dir = std::env::temp_dir().join(format!("fumen-pp-{tag}-{}", std::process::id()));
        let hash = format!("{:064x}", 0xfeed_u64);
        let path = paths::lazer_file(&dir, &hash).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        (dir.clone(), paths::Files::lazer(dir), hash)
    }

    #[test]
    fn mania_sheet() {
        let (dir, files, hash) = mania_chart("sheet");
        let plays = [
            Hits::default(),
            Hits { good: 10, ..Hits::default() },
            Hits { good: 20, ..Hits::default() },
            Hits { miss: 10, ..Hits::default() },
            Hits { good: 10, miss: 10, ..Hits::default() },
            // more than there are: the counts are cut down to the 720 judgements
            Hits { miss: 5000, ..Hits::default() },
            Hits { acc: Some(98.0), ..Hits::default() },
        ];
        let s = sheet(&files, &hash, &[], 1.0, &plays).unwrap();
        // 600 notes, 120 of them holds judged at head and tail
        assert_eq!((s.mode, s.total), (3, 720));
        assert!(s.stars > 0.5 && s.max > 1.0, "{s:?}");
        let pp: Vec<f64> = s.plays.iter().map(|o| o.pp).collect();
        assert!((pp[0] - s.max).abs() < 1e-9 && (s.plays[0].acc - 1.0).abs() < 1e-12);
        // osu!mania's pp falls in a straight line with each Good, and further with each Miss
        assert!(((pp[0] - pp[1]) - (pp[1] - pp[2])).abs() < 1e-9);
        assert!(pp[3] < pp[1] && pp[4] < pp[3]);
        assert_eq!(pp[5], 0.0);
        assert!((s.plays[6].acc - 0.98).abs() < 0.005, "{:?}", s.plays[6]);

        // No Fail ×0.75, Easy ×0.5, and a faster rate is harder
        let nf = sheet(&files, &hash, &["NF".into()], 1.0, &[]).unwrap();
        let ez = sheet(&files, &hash, &["EZ".into()], 1.0, &[]).unwrap();
        let dt = sheet(&files, &hash, &[], 1.5, &[]).unwrap();
        assert!((nf.max / s.max - 0.75).abs() < 1e-9 && (ez.max / s.max - 0.5).abs() < 1e-9);
        assert!(dt.stars > s.stars && dt.max > s.max);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_chart() {
        let dir = std::env::temp_dir().join(format!("fumen-pp-none-{}", std::process::id()));
        let err = sheet(&paths::Files::lazer(&dir), &format!("{:064x}", 1), &[], 1.0, &[]).unwrap_err();
        assert_eq!(err.code(), "chart-missing");
    }

    /// Prices every synced osu! score with pp on a library difficulty of its own ruleset, from its
    /// statistics, and compares with what osu! gave it. Reads Fumen's database, never writes:
    /// `FUMEN_TEST_DB=%APPDATA%/dev.fumen.app/library.db FUMEN_TEST_STORAGE=%APPDATA%/osu cargo test pp::tests::real_scores -- --ignored --nocapture`
    /// osu!stable scores in osu! are left out: osu! prices them with their stable score, which
    /// Fumen doesn't keep. On 2026-10-21 all 413 others (mania 184, taiko 204, osu! 24, catch 1)
    /// came within 0.1%.
    #[test]
    #[ignore = "needs FUMEN_TEST_DB (Fumen's library.db) and FUMEN_TEST_STORAGE (lazer data folder)"]
    fn real_scores() {
        let (Some(db), Some(storage)) = (std::env::var_os("FUMEN_TEST_DB"), std::env::var_os("FUMEN_TEST_STORAGE")) else { return };
        let files = paths::Files::lazer(paths::resolve_lazer_storage(std::path::Path::new(&storage)));
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut q = conn
            .prepare(
                "SELECT s.mode, s.pp, s.mods, s.statistics, s.max_combo, m.hash, m.version FROM osu_scores s
                 JOIN maps m ON m.online_id = s.beatmap_id AND m.ruleset_id = s.mode
                 WHERE s.pp > 0 AND m.hash IS NOT NULL AND NOT (s.mode = 0 AND s.legacy_id IS NOT NULL) GROUP BY s.id",
            )
            .unwrap();
        let rows: Vec<(u8, f64, String, String, u32, String, String)> = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        let mut off: Vec<Vec<f64>> = vec![Vec::new(); 4];
        let mut sheets = 0;
        for (mode, pp, mods, stats, combo, hash, version) in &rows {
            let Some(bytes) = files.read(hash) else { continue };
            let map = Beatmap::from_bytes(&bytes).unwrap();
            let s: serde_json::Value = serde_json::from_str(stats).unwrap();
            let n = |k: &str| s[k].as_u64().unwrap_or(0) as u32;
            let (game_mods, rate) = score_mods(mods);
            let perf = Performance::new(&map).mods(game_mods).clock_rate(rate).lazer(true).combo(*combo);
            let perf = match mode {
                0 => perf
                    .n300(n("great"))
                    .n100(n("ok"))
                    .n50(n("meh"))
                    .misses(n("miss"))
                    .large_tick_hits(n("large_tick_hit"))
                    .small_tick_hits(n("small_tick_hit"))
                    .slider_end_hits(n("slider_tail_hit")),
                1 => perf.n300(n("great")).n100(n("ok")).misses(n("miss")),
                2 => perf
                    .n300(n("great"))
                    .n100(n("large_tick_hit"))
                    .n50(n("small_tick_hit"))
                    .n_katu(n("small_tick_miss"))
                    .misses(n("miss") + n("large_tick_miss")),
                _ => perf.n_geki(n("perfect")).n300(n("great")).n_katu(n("good")).n100(n("ok")).n50(n("meh")).misses(n("miss")),
            };
            let ours = perf.calculate().pp();
            // the panel's own way in, from the counts it asks for (osu! and osu!catch need more)
            if (*mode == 1 || *mode == 3) && mods == "[]" {
                let hits = Hits { great: n("great"), good: n("good"), ok: n("ok"), meh: n("meh"), miss: n("miss"), ..Hits::default() };
                let hits = if *mode == 1 { Hits { great: 0, ..hits } } else { hits };
                let panel = sheet(&files, hash, &[], 1.0, &[hits]).unwrap().plays[0].pp;
                assert!(((panel - ours) / ours).abs() < 1e-9, "[{version}] the panel says {panel}, the score {ours}");
                sheets += 1;
            }
            let rel = (ours - pp) / pp;
            if rel.abs() > 0.001 {
                eprintln!("mode {mode} [{version}] {mods}: osu! {pp:.2}, ours {ours:.2} ({:+.2}%) {stats}", rel * 100.0);
            }
            off[*mode as usize].push(rel.abs());
        }
        for (mode, v) in off.iter().enumerate().filter(|(_, v)| !v.is_empty()) {
            let close = v.iter().filter(|r| **r <= 0.001).count();
            let worst = v.iter().copied().fold(0.0, f64::max);
            eprintln!("mode {mode}: {} scores, {close} within 0.1%, worst {:.3}%", v.len(), worst * 100.0);
            assert!(worst < 0.002, "mode {mode} is off by up to {:.2}%", worst * 100.0);
        }
        eprintln!("{sheets} scores priced the panel's way too");
    }
}
