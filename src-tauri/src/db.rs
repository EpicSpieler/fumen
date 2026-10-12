//! SQLite cache of the imported library plus Fumen's own data (later: collections, analysis,
//! pools). Migrations are append-only and tracked with `PRAGMA user_version`.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;

const MIGRATIONS: &[&str] = &[
    // 1 — lazer import
    r#"
    CREATE TABLE sets (
        id             TEXT PRIMARY KEY,
        source         TEXT NOT NULL DEFAULT 'lazer',
        online_id      INTEGER,
        status         INTEGER,
        date_added     INTEGER,
        date_submitted INTEGER,
        date_ranked    INTEGER,
        protected      INTEGER NOT NULL DEFAULT 0,
        title          TEXT NOT NULL DEFAULT '',
        title_unicode  TEXT NOT NULL DEFAULT '',
        artist         TEXT NOT NULL DEFAULT '',
        artist_unicode TEXT NOT NULL DEFAULT '',
        creator        TEXT NOT NULL DEFAULT '',
        creator_id     INTEGER,
        source_text    TEXT NOT NULL DEFAULT '',
        tags           TEXT NOT NULL DEFAULT '',
        bg             TEXT,
        audio          TEXT,
        preview_time   INTEGER
    );
    CREATE TABLE maps (
        id           TEXT PRIMARY KEY,
        set_id       TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
        online_id    INTEGER,
        version      TEXT NOT NULL DEFAULT '',
        ruleset      TEXT,
        ruleset_id   INTEGER,
        status       INTEGER,
        hash         TEXT,
        md5          TEXT,
        sr           REAL,
        bpm          REAL,
        length       REAL,
        objects      INTEGER,
        end_objects  INTEGER,
        last_played  INTEGER,
        last_update  INTEGER,
        hidden       INTEGER NOT NULL DEFAULT 0,
        hp           REAL,
        cs           REAL,
        od           REAL,
        ar           REAL,
        bg           TEXT,
        audio        TEXT,
        preview_time INTEGER
    );
    CREATE INDEX maps_set ON maps(set_id);
    CREATE INDEX maps_md5 ON maps(md5);
    CREATE TABLE scores (
        id                 TEXT PRIMARY KEY,
        map_id             TEXT,
        map_md5            TEXT,
        ruleset            TEXT,
        total_score        INTEGER,
        accuracy           REAL,
        max_combo          INTEGER,
        rank               INTEGER,
        pp                 REAL,
        date               INTEGER,
        mods               TEXT,
        statistics         TEXT,
        maximum_statistics TEXT,
        online_id          INTEGER,
        legacy             INTEGER NOT NULL DEFAULT 0,
        user               TEXT,
        user_id            INTEGER
    );
    CREATE INDEX scores_md5 ON scores(map_md5);
    CREATE TABLE lazer_collections (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        modified INTEGER,
        position INTEGER NOT NULL
    );
    CREATE TABLE lazer_collection_items (
        collection_id TEXT NOT NULL REFERENCES lazer_collections(id) ON DELETE CASCADE,
        md5           TEXT NOT NULL,
        position      INTEGER NOT NULL
    );
    CREATE INDEX lazer_collection_items_c ON lazer_collection_items(collection_id);
    CREATE TABLE meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    "#,
    // 2 — chart analysis, keyed by the .osu file's SHA-256 (content-addressed: never stale)
    r#"
    CREATE TABLE chart_stats (
        hash          TEXT PRIMARY KEY,
        version       INTEGER NOT NULL,
        nps_avg       REAL,
        nps_peak      REAL,
        ln_time       REAL,
        jack_ratio    REAL,
        longest_burst INTEGER,
        tags          TEXT NOT NULL DEFAULT '',
        patterns      TEXT NOT NULL DEFAULT '[]'
    );
    "#,
    // 3 — osu!mania star ratings at HT (0.75×) and DT (1.5×), from Fumen's own calculator
    r#"
    ALTER TABLE chart_stats ADD COLUMN sr_ht REAL;
    ALTER TABLE chart_stats ADD COLUMN sr_dt REAL;
    "#,
    // 4 — lazer skins (for the playfield preview); files are [filename, sha256] pairs as JSON
    r#"
    CREATE TABLE skins (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL DEFAULT '',
        creator   TEXT NOT NULL DEFAULT '',
        kind      TEXT NOT NULL,
        protected INTEGER NOT NULL DEFAULT 0,
        position  INTEGER NOT NULL,
        files     TEXT NOT NULL DEFAULT '[]'
    );
    "#,
    // 5 — dan rating (label and, for 4K rice, Azusa's number) and pattern category, at 1×
    r#"
    ALTER TABLE chart_stats ADD COLUMN dan TEXT;
    ALTER TABLE chart_stats ADD COLUMN dan_value REAL;
    ALTER TABLE chart_stats ADD COLUMN category TEXT;
    "#,
    // 6 — a set's sound files and storyboard ([filename, sha256] pairs as JSON), for hitsounds
    r#"
    ALTER TABLE sets ADD COLUMN sounds TEXT NOT NULL DEFAULT '[]';
    "#,
    // 7 — osu!mania star rating at 1× from Fumen's calculator: stands in until lazer has its own
    //     (sets imported through Fumen get theirs on lazer's next start)
    r#"
    ALTER TABLE chart_stats ADD COLUMN sr REAL;
    "#,
    // 8 — what osu! knows about the logged-in player (osu_scores.rs): scores (ids are osu!'s solo
    //     score ids, the online ids lazer keeps), the difficulties they're on, the most played
    //     difficulties. A library rescan never touches these.
    r#"
    CREATE TABLE osu_beatmaps (
        id             INTEGER PRIMARY KEY,
        set_id         INTEGER,
        md5            TEXT,
        mode           INTEGER,
        version        TEXT NOT NULL DEFAULT '',
        sr             REAL,
        length         REAL,
        title          TEXT NOT NULL DEFAULT '',
        title_unicode  TEXT NOT NULL DEFAULT '',
        artist         TEXT NOT NULL DEFAULT '',
        artist_unicode TEXT NOT NULL DEFAULT '',
        creator        TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE osu_scores (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER NOT NULL,
        beatmap_id  INTEGER NOT NULL,
        mode        INTEGER NOT NULL,
        total_score INTEGER NOT NULL DEFAULT 0,
        accuracy    REAL NOT NULL DEFAULT 0,
        max_combo   INTEGER NOT NULL DEFAULT 0,
        rank        INTEGER NOT NULL DEFAULT -1,
        pp          REAL,
        passed      INTEGER NOT NULL DEFAULT 1,
        date        INTEGER NOT NULL,
        mods        TEXT NOT NULL DEFAULT '[]',
        statistics  TEXT NOT NULL DEFAULT '{}',
        legacy_id   INTEGER,
        best_pos    INTEGER
    );
    CREATE INDEX osu_scores_beatmap ON osu_scores(beatmap_id);
    CREATE TABLE osu_playcounts (
        beatmap_id INTEGER PRIMARY KEY,
        count      INTEGER NOT NULL,
        position   INTEGER NOT NULL
    );
    CREATE INDEX scores_online ON scores(online_id);
    "#,
    // 9 — osu!mania star ratings at rates people played that the library doesn't carry (0.75× and
    //     1.5× are in chart_stats), from Fumen's calculator: rate × 100, for analysis `version`
    r#"
    CREATE TABLE rate_stars (
        hash    TEXT NOT NULL,
        rate    INTEGER NOT NULL,
        version INTEGER NOT NULL,
        sr      REAL NOT NULL,
        PRIMARY KEY (hash, rate)
    );
    "#,
    // 10 — the player's goals (src/goals.rs): JSON as the UI keeps it
    r#"
    CREATE TABLE goals (
        id      TEXT PRIMARY KEY,
        created INTEGER NOT NULL,
        data    TEXT NOT NULL
    );
    "#,
    // 11 — Fumen's own collections (src/collections.rs): difficulties by MD5, like lazer's and
    //      stable's; `query` is for saved searches later
    r#"
    CREATE TABLE collections (
        id       TEXT PRIMARY KEY,
        name     TEXT NOT NULL,
        created  INTEGER NOT NULL,
        position INTEGER NOT NULL,
        query    TEXT
    );
    CREATE TABLE collection_items (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        md5           TEXT NOT NULL,
        added         INTEGER NOT NULL,
        PRIMARY KEY (collection_id, md5)
    );
    "#,
    // 12 — the lazer collection a Fumen collection went into (or was copied from), so putting it
    //      into lazer again updates that one
    r#"
    ALTER TABLE collections ADD COLUMN lazer_id TEXT;
    "#,
];

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA temp_store = MEMORY;",
    )?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current.max(0) as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_apply_and_are_idempotent() {
        let dir = std::env::temp_dir().join(format!("fumen-db-test-{}", std::process::id()));
        let path = dir.join("t.db");
        let _ = std::fs::remove_dir_all(&dir);
        {
            let conn = open(&path).unwrap();
            set_meta(&conn, "k", "v").unwrap();
        }
        let conn = open(&path).unwrap();
        assert_eq!(get_meta(&conn, "k").unwrap().as_deref(), Some("v"));
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v as usize, MIGRATIONS.len());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
