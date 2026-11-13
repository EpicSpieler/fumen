//! Every try at a map (1.4): passes, fails, quits and restarts, as src/lib/attempts.ts makes them
//! out of what tosu shows. lazer only keeps a replay when you pass (live.rs), so this is the one
//! place fails and quits are seen at all: how far a try got, and where it failed.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    #[serde(default)]
    pub id: i64,
    pub md5: String,
    /// 0 osu!, 1 taiko, 2 catch, 3 mania
    pub mode: u8,
    /// "lazer" or "stable"
    pub client: String,
    /// unix ms
    pub started: i64,
    pub ended: i64,
    /// "pass", "fail", "quit" or "retry" (restarted before the end)
    pub outcome: String,
    /// the furthest place in the song, ms
    pub reached: i64,
    /// where the health ran out, ms
    pub failed_at: Option<i64>,
    pub first_object: Option<i64>,
    pub last_object: Option<i64>,
    /// 0–1
    pub accuracy: f64,
    pub score: i64,
    pub max_combo: i64,
    pub misses: i64,
    /// when each miss came, song ms (up to the fail)
    #[serde(default)]
    pub misses_at: Vec<i64>,
    /// "HDDT", as tosu names them
    pub mods: String,
    pub rate: f64,
    pub pp: Option<f64>,
    /// osu!'s score id, for a pass
    pub score_id: Option<i64>,
    pub rank: Option<String>,
    /// the pulse during the try, from a heart rate monitor (heart.rs)
    #[serde(default)]
    pub heart: Option<Heart>,
}

/// The pulse during a try: about a reading a second, and what it came to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Heart {
    /// [song ms, beats per minute]
    pub samples: Vec<[i64; 2]>,
    pub avg: f64,
    pub max: i64,
    pub min: i64,
    /// the average in the map's fastest part (none without its chart)
    pub fast: Option<f64>,
}

/// A try's pulse in short, for the totals (History's heart rate).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartTry {
    pub id: i64,
    pub md5: String,
    pub mode: u8,
    pub started: i64,
    pub outcome: String,
    pub mods: String,
    pub avg: f64,
    pub max: i64,
    pub min: i64,
    pub fast: Option<f64>,
}

const OUTCOMES: [&str; 4] = ["pass", "fail", "quit", "retry"];

fn check(a: &Attempt) -> Result<()> {
    let md5_ok = a.md5.len() == 32 && a.md5.bytes().all(|b| b.is_ascii_hexdigit());
    let ok = md5_ok
        && a.mode <= 3
        && OUTCOMES.contains(&a.outcome.as_str())
        && a.ended >= a.started
        && (0.0..=1.0).contains(&a.accuracy)
        && a.rate > 0.0
        && a.rate <= 4.0
        && a.mods.len() <= 64
        && a.misses_at.len() <= 5000
        && a.misses_at.iter().all(|&t| (0..=86_400_000).contains(&t))
        && a.client.len() <= 16
        && a.heart.as_ref().map_or(true, |h| {
            let bpm = |v: f64| (0.0..=300.0).contains(&v);
            h.samples.len() <= 20_000
                && h.samples.iter().all(|[t, b]| (-60_000..=86_400_000).contains(t) && (0..=300).contains(b))
                && bpm(h.avg)
                && bpm(h.max as f64)
                && bpm(h.min as f64)
                && h.fast.map_or(true, bpm)
        });
    if ok {
        Ok(())
    } else {
        Err(Error::known("bad-attempt", "That try doesn't look right."))
    }
}

/// Keeps a try; its id.
pub fn store(conn: &Connection, a: &Attempt) -> Result<i64> {
    check(a)?;
    conn.execute(
        "INSERT INTO attempts (md5, mode, client, started, ended, outcome, reached, failed_at, first_object, last_object,
            accuracy, score, max_combo, misses, misses_at, mods, rate, pp, score_id, rank, heart, hr_avg, hr_max, hr_min, hr_fast)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        params![
            a.md5.to_ascii_lowercase(),
            a.mode,
            a.client,
            a.started,
            a.ended,
            a.outcome,
            a.reached,
            a.failed_at,
            a.first_object,
            a.last_object,
            a.accuracy,
            a.score,
            a.max_combo,
            a.misses,
            serde_json::to_string(&a.misses_at)?,
            a.mods,
            a.rate,
            a.pp,
            a.score_id,
            a.rank,
            a.heart.as_ref().map(|h| serde_json::to_string(&h.samples)).transpose()?,
            a.heart.as_ref().map(|h| h.avg),
            a.heart.as_ref().map(|h| h.max),
            a.heart.as_ref().map(|h| h.min),
            a.heart.as_ref().and_then(|h| h.fast),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

const COLUMNS: &str = "id, md5, mode, client, started, ended, outcome, reached, failed_at, first_object, last_object,
    accuracy, score, max_combo, misses, misses_at, mods, rate, pp, score_id, rank, heart, hr_avg, hr_max, hr_min, hr_fast";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: r.get(0)?,
        md5: r.get(1)?,
        mode: r.get(2)?,
        client: r.get(3)?,
        started: r.get(4)?,
        ended: r.get(5)?,
        outcome: r.get(6)?,
        reached: r.get(7)?,
        failed_at: r.get(8)?,
        first_object: r.get(9)?,
        last_object: r.get(10)?,
        accuracy: r.get(11)?,
        score: r.get(12)?,
        max_combo: r.get(13)?,
        misses: r.get(14)?,
        misses_at: serde_json::from_str(&r.get::<_, String>(15)?).unwrap_or_default(),
        mods: r.get(16)?,
        rate: r.get(17)?,
        pp: r.get(18)?,
        score_id: r.get(19)?,
        rank: r.get(20)?,
        heart: match r.get::<_, Option<f64>>(22)? {
            Some(avg) => Some(Heart {
                samples: r.get::<_, Option<String>>(21)?.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
                avg,
                max: r.get::<_, Option<i64>>(23)?.unwrap_or(0),
                min: r.get::<_, Option<i64>>(24)?.unwrap_or(0),
                fast: r.get(25)?,
            }),
            None => None,
        },
    })
}

/// Every try with its pulse, in short, newest first.
pub fn heart_tries(conn: &Connection) -> Result<Vec<HeartTry>> {
    let mut st = conn.prepare(
        "SELECT id, md5, mode, started, outcome, mods, hr_avg, hr_max, hr_min, hr_fast FROM attempts
         WHERE hr_avg IS NOT NULL ORDER BY started DESC LIMIT 50000",
    )?;
    let rows = st.query_map([], |r| {
        Ok(HeartTry {
            id: r.get(0)?,
            md5: r.get(1)?,
            mode: r.get(2)?,
            started: r.get(3)?,
            outcome: r.get(4)?,
            mods: r.get(5)?,
            avg: r.get(6)?,
            max: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
            min: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
            fast: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The tries at a difficulty, newest first.
pub fn for_map(conn: &Connection, md5: &str, limit: u32) -> Result<Vec<Attempt>> {
    let mut st = conn.prepare(&format!("SELECT {COLUMNS} FROM attempts WHERE md5 = ?1 ORDER BY started DESC LIMIT ?2"))?;
    let rows = st.query_map(params![md5.to_ascii_lowercase(), limit], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The tries since `since` (unix ms), newest first.
pub fn since(conn: &Connection, since: i64) -> Result<Vec<Attempt>> {
    let mut st = conn.prepare(&format!("SELECT {COLUMNS} FROM attempts WHERE started >= ?1 ORDER BY started DESC"))?;
    let rows = st.query_map([since], row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(outcome: &str, started: i64) -> Attempt {
        Attempt {
            id: 0,
            md5: "0123456789ABCDEF0123456789abcdef".into(),
            mode: 3,
            client: "lazer".into(),
            started,
            ended: started + 30_000,
            outcome: outcome.into(),
            reached: 33_656,
            failed_at: (outcome == "fail").then_some(33_656),
            first_object: Some(4_802),
            last_object: Some(120_000),
            accuracy: 0.8709,
            score: 120_000,
            max_combo: 242,
            misses: 12,
            misses_at: vec![30_100, 31_900, 33_400],
            mods: "DT".into(),
            rate: 1.5,
            pp: Some(15.4),
            score_id: None,
            rank: None,
            heart: None,
        }
    }

    #[test]
    fn keeps_and_finds_tries() {
        let dir = std::env::temp_dir().join(format!("fumen-attempts-{}", std::process::id()));
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        let a = store(&conn, &attempt("fail", 1000)).unwrap();
        let b = store(&conn, &attempt("pass", 5000)).unwrap();
        assert!(b > a);
        let got = for_map(&conn, "0123456789abcdef0123456789ABCDEF", 10).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].outcome, "pass");
        assert_eq!(got[1].failed_at, Some(33_656));
        assert_eq!(got[1].md5, "0123456789abcdef0123456789abcdef");
        assert_eq!(got[1].misses_at, vec![30_100, 31_900, 33_400]);
        assert_eq!(since(&conn, 2000).unwrap().len(), 1);
        assert!(got[0].heart.is_none() && heart_tries(&conn).unwrap().is_empty());
        // with the pulse during it
        let mut h = attempt("pass", 9000);
        h.heart = Some(Heart { samples: vec![[-1000, 88], [0, 90], [1000, 131]], avg: 103.0, max: 131, min: 88, fast: Some(131.0) });
        let id = store(&conn, &h).unwrap();
        let back = for_map(&conn, &h.md5, 1).unwrap().remove(0);
        assert_eq!((back.id, back.heart.clone()), (id, h.heart.clone()));
        let short = heart_tries(&conn).unwrap();
        assert_eq!((short.len(), short[0].max, short[0].fast), (1, 131, Some(131.0)));
        h.heart.as_mut().unwrap().max = 900;
        assert!(store(&conn, &h).is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn odd_tries_are_turned_away() {
        let dir = std::env::temp_dir().join(format!("fumen-attempts-bad-{}", std::process::id()));
        let conn = crate::db::open(&dir.join("t.db")).unwrap();
        let mut a = attempt("fail", 1000);
        a.outcome = "drop table".into();
        assert!(store(&conn, &a).is_err());
        let mut a = attempt("fail", 1000);
        a.md5 = "nope".into();
        assert!(store(&conn, &a).is_err());
        let mut a = attempt("fail", 1000);
        a.accuracy = 87.0;
        assert!(store(&conn, &a).is_err());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
