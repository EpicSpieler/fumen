//! The mods that change a chart itself, the way lazer applies them (MIT, ppy Pty Ltd): Easy and
//! Hard Rock on the difficulty (`IApplicableToDifficulty`), Hard Rock's and Mirror's flips and
//! osu!catch's Hard Rock offsets. Mods that only change what's shown (Hidden, Fade In,
//! Flashlight) are drawn by the playfield; rate mods are the player's.

use serde::Deserialize;

/// `ModEasy.ADJUST_RATIO`
const EASY: f32 = 0.5;
/// `ModHardRock.ADJUST_RATIO`
const HARD_ROCK: f32 = 1.4;
/// Hard Rock's own ratio for circle size
const HARD_ROCK_CS: f32 = 1.3;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mods {
    pub easy: bool,
    pub hard_rock: bool,
    /// osu!: horizontally (lazer's default axis); osu!catch: the fruits; osu!mania: the columns
    pub mirror: bool,
}

impl Mods {
    pub const NONE: Mods = Mods { easy: false, hard_rock: false, mirror: false };

    /// Circle size (osu!, osu!catch): Hard Rock ×1.3 up to 10, Easy halves it.
    pub fn cs(self, cs: f32) -> f32 {
        if self.hard_rock {
            (cs * HARD_ROCK_CS).min(10.0)
        } else if self.easy {
            cs * EASY
        } else {
            cs
        }
    }

    /// Approach rate and overall difficulty (osu!, osu!catch; osu!taiko's OD): Hard Rock ×1.4 up
    /// to 10, Easy halves them.
    pub fn ar_od(self, v: f32) -> f32 {
        if self.hard_rock {
            (v * HARD_ROCK).min(10.0)
        } else if self.easy {
            v * EASY
        } else {
            v
        }
    }

    /// osu!taiko's slider multiplier, so the scroll speed: Hard Rock 1.4 × 4/3 (stable's aspect
    /// ratio adjustment), Easy 0.8.
    pub fn taiko_velocity(self) -> f64 {
        if self.hard_rock {
            1.4 * 4.0 / 3.0
        } else if self.easy {
            0.8
        } else {
            1.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn difficulty() {
        let hr = Mods { hard_rock: true, ..Mods::NONE };
        let ez = Mods { easy: true, ..Mods::NONE };
        assert_eq!(hr.cs(4.0), 5.2);
        assert_eq!(hr.cs(9.0), 10.0);
        assert_eq!(hr.ar_od(9.0), 10.0);
        assert!((hr.ar_od(5.0) - 7.0).abs() < 1e-6);
        assert_eq!(ez.cs(4.0), 2.0);
        assert_eq!(ez.ar_od(9.0), 4.5);
        assert_eq!(Mods::NONE.cs(4.0), 4.0);
        assert!((hr.taiko_velocity() - 1.866_666).abs() < 1e-5);
    }

    /// Every osu!, osu!taiko and osu!catch difficulty of the library Fumen has imported, with each
    /// mod: no panics, the same objects, positions inside the playfield.
    #[test]
    #[ignore = "reads the installed lazer's files and Fumen's library (read-only)"]
    fn real_library() {
        let Some(lazer) = crate::paths::default_lazer_dir() else { return };
        let storage = crate::paths::resolve_lazer_storage(&lazer);
        let db = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("dev.fumen.app").join("library.db");
        let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = conn.prepare("SELECT hash, ruleset_id FROM maps WHERE ruleset_id IN (0, 1, 2) AND hash IS NOT NULL").unwrap();
        let rows: Vec<(String, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect();
        let all = [
            Mods { hard_rock: true, ..Mods::NONE },
            Mods { easy: true, ..Mods::NONE },
            Mods { mirror: true, ..Mods::NONE },
            Mods { easy: true, mirror: true, ..Mods::NONE },
        ];
        let started = std::time::Instant::now();
        let mut charts = 0;
        for (h, ruleset) in &rows {
            let Some(bytes) = crate::paths::lazer_file(&storage, h).and_then(|p| std::fs::read(p).ok()) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            for mods in all {
                match ruleset {
                    0 => {
                        let (Some(a), Some(b)) = (crate::osu::parse(&text), crate::osu::parse_with(&text, mods)) else { continue };
                        assert_eq!(a.objects.len(), b.objects.len(), "{h}");
                        assert!(b.frames.iter().all(|f| f.pos.x.is_finite() && f.pos.y.is_finite()), "{h}");
                        if mods.mirror {
                            assert!(a.objects.iter().zip(&b.objects).all(|(p, q)| (p.pos.x + q.pos.x - 512.0).abs() < 1e-3), "{h}");
                        }
                    }
                    1 => {
                        let (Some(a), Some(b)) = (crate::taiko::parse(&text), crate::taiko::parse_with(&text, mods)) else { continue };
                        assert_eq!(a.objects.len(), b.objects.len(), "{h}");
                        assert!(b.scroll.iter().all(|s| s.1.is_finite() && s.1 > 0.0), "{h}");
                    }
                    _ => {
                        let (Some(a), Some(b)) = (crate::catch::parse(&text), crate::catch::parse_with(&text, mods)) else { continue };
                        assert_eq!(a.objects.len(), b.objects.len(), "{h}");
                        assert!(b.objects.iter().all(|o| (0.0..=crate::catch::WIDTH).contains(&o.x)), "{h}");
                        assert!(b.frames.iter().all(|f| f.x.is_finite()), "{h}");
                    }
                }
            }
            charts += 1;
        }
        eprintln!("{charts} charts × {} mods in {:?}", all.len(), started.elapsed());
    }
}
