//! Library care: what the library takes on disk, set by set. lazer's sets list their files
//! ([filename, hash] from the realm export) and lazer keeps each file once under files/ by its
//! SHA-256, so a file's size is known for good once it's been looked at (`file_sizes`). osu!stable's
//! sets are folders in Songs, walked as they are now. Read only: nothing here touches a file
//! beyond its size.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::error::Result;

/// What a file is, by its extension (and, for audio, whether a difficulty plays it).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// the song: an audio file a difficulty plays
    Song = 0,
    Video = 1,
    /// backgrounds and storyboard images
    Image = 2,
    /// hitsounds and storyboard samples
    Sound = 3,
    /// charts, storyboards' scripts, anything else
    Other = 4,
}

pub const KINDS: usize = 5;

const VIDEO: &[&str] = &["mp4", "avi", "flv", "m4v", "mkv", "mov", "webm", "wmv", "mpg", "mpeg"];
const IMAGE: &[&str] = &["jpg", "jpeg", "png", "bmp", "gif", "webp"];
const AUDIO: &[&str] = &["mp3", "ogg", "wav", "flac", "m4a", "opus", "aac"];

pub fn kind_of(name: &str, song: bool) -> Kind {
    let ext = name.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    let ext = ext.as_str();
    if AUDIO.contains(&ext) {
        if song {
            Kind::Song
        } else {
            Kind::Sound
        }
    } else if VIDEO.contains(&ext) {
        Kind::Video
    } else if IMAGE.contains(&ext) {
        Kind::Image
    } else {
        Kind::Other
    }
}

/// One set on disk: bytes in all and by kind (song, video, images, sounds, other).
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CareSet {
    pub id: String,
    pub size: u64,
    pub kinds: [u64; KINDS],
    /// files it lists that aren't on disk
    #[serde(skip_serializing_if = "is_zero")]
    pub missing: u32,
}

fn is_zero(v: &u32) -> bool {
    *v == 0
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CareReport {
    pub sets: Vec<CareSet>,
    /// lazer's beatmap files, each counted once (sets can share files)
    pub lazer_size: u64,
    pub stable_size: u64,
    pub duplicates: Vec<DupeGroup>,
    /// the sets in `duplicates`, as they're shown (stable's copies of lazer's aren't in the snapshot)
    pub dupe_sets: Vec<SetInfo>,
}

/// Sets that are (partly) the same.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DupeGroup {
    /// "stable-copy": osu!stable sets with every difficulty in lazer too; "same-set": one beatmap
    /// set (its osu! id) more than once; "shared": sets with difficulties in common (a pack and
    /// the set, say); "reupload": the same title by the same mapper with the same song file
    pub kind: &'static str,
    /// newest first
    pub sets: Vec<String>,
    /// difficulties in more than one of them
    pub shared: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetInfo {
    pub id: String,
    pub source: String,
    pub online_id: Option<i64>,
    pub title: String,
    pub artist: String,
    pub creator: String,
    pub bg: Option<String>,
    pub added: Option<i64>,
    pub maps: usize,
    pub folder: Option<String>,
}

struct LazerSet {
    id: String,
    files: Vec<(String, String)>,
    songs: HashSet<String>,
}

struct StableSet {
    id: String,
    folder: String,
    /// paths in the Songs folder of the audio its difficulties play (lowercase)
    songs: HashSet<String>,
}

/// Sizes of every set in the library. `progress` gets (done, total) files and folders.
pub fn report(db: &std::sync::Mutex<Connection>, lazer: Option<&Path>, songs: Option<&Path>, progress: impl Fn(u64, u64) + Sync) -> Result<CareReport> {
    // what to look at, read while holding the database
    let (lazer_sets, stable_sets, mut sizes) = {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        (lazer_sets(&conn)?, stable_sets(&conn)?, known_sizes(&conn)?)
    };

    // lazer: every hash not measured yet, stat'ed in parallel
    let mut todo: Vec<String> = Vec::new();
    if lazer.is_some() {
        let mut seen = HashSet::new();
        for s in &lazer_sets {
            for (_, h) in &s.files {
                if !sizes.contains_key(h) && seen.insert(h.as_str()) {
                    todo.push(h.clone());
                }
            }
        }
    }
    let total = (todo.len() + stable_sets.len()) as u64;
    let done = std::sync::atomic::AtomicU64::new(0);
    let tick = || {
        let d = done.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if d % 500 == 0 || d == total {
            progress(d, total);
        }
    };
    progress(0, total);

    let measured: Vec<(String, Option<u64>)> = match lazer {
        Some(storage) => parallel(&todo, |h| {
            tick();
            (h.clone(), crate::paths::lazer_file(storage, h).and_then(|p| std::fs::metadata(p).ok()).filter(|m| m.is_file()).map(|m| m.len()))
        }),
        None => Vec::new(),
    };
    let found: Vec<(String, u64)> = measured.iter().filter_map(|(h, s)| s.map(|s| (h.clone(), s))).collect();
    if !found.is_empty() {
        let mut conn = db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction()?;
        {
            let mut ins = tx.prepare("INSERT OR REPLACE INTO file_sizes (hash, size) VALUES (?1, ?2)")?;
            for (h, s) in &found {
                ins.execute(params![h, *s as i64])?;
            }
        }
        tx.commit()?;
    }
    sizes.extend(found);

    let mut out = CareReport::default();
    {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        (out.duplicates, out.dupe_sets) = duplicates(&conn)?;
    }
    let mut unique = HashSet::new();
    for s in &lazer_sets {
        let mut c = CareSet { id: s.id.clone(), ..CareSet::default() };
        for (name, h) in &s.files {
            match sizes.get(h) {
                Some(&size) => {
                    c.size += size;
                    c.kinds[kind_of(name, s.songs.contains(h)) as usize] += size;
                    if unique.insert(h.as_str()) {
                        out.lazer_size += size;
                    }
                }
                None => c.missing += 1,
            }
        }
        out.sets.push(c);
    }

    // stable: the folders as they are
    if let Some(songs) = songs {
        let walked = parallel(&stable_sets, |s| {
            tick();
            walk(songs, s)
        });
        for c in walked.into_iter().flatten() {
            out.stable_size += c.size;
            out.sets.push(c);
        }
    }
    Ok(out)
}

/// Sets that are (partly) the same: linked by a difficulty they share (its MD5), their osu! id, or
/// the same title by the same mapper with the same song file (lazer keeps files by their hash, so
/// the same file has the same hash; packs carry their songs' files too, hence the title); each
/// linked group once, named by the closest link in it.
pub fn duplicates(conn: &Connection) -> Result<(Vec<DupeGroup>, Vec<SetInfo>)> {
    let mut infos: Vec<SetInfo> = Vec::new();
    let mut audio: Vec<Option<String>> = Vec::new();
    let mut q = conn.prepare("SELECT id, source, online_id, title, artist, creator, bg, date_added, folder, audio FROM sets ORDER BY rowid")?;
    for r in q.query_map([], |r| {
        Ok((
            SetInfo {
                id: r.get(0)?,
                source: r.get(1)?,
                online_id: r.get::<_, Option<i64>>(2)?.filter(|v| *v > 0),
                title: r.get(3)?,
                artist: r.get(4)?,
                creator: r.get(5)?,
                bg: r.get(6)?,
                added: r.get(7)?,
                maps: 0,
                folder: r.get(8)?,
            },
            r.get::<_, Option<String>>(9)?,
        ))
    })? {
        let (info, a) = r?;
        infos.push(info);
        audio.push(a);
    }
    let index: HashMap<String, usize> = infos.iter().enumerate().map(|(i, s)| (s.id.clone(), i)).collect();
    let mut md5s: Vec<HashSet<String>> = vec![HashSet::new(); infos.len()];
    let mut q = conn.prepare("SELECT set_id, md5 FROM maps WHERE md5 IS NOT NULL AND md5 != ''")?;
    for r in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (set, md5) = r?;
        if let Some(&i) = index.get(&set) {
            md5s[i].insert(md5);
        }
    }
    for (i, m) in md5s.iter().enumerate() {
        infos[i].maps = m.len();
    }

    // linked: union–find over the links
    let mut parent: Vec<usize> = (0..infos.len()).collect();
    fn root(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    fn join(p: &mut [usize], a: usize, b: usize) {
        let (ra, rb) = (root(p, a), root(p, b));
        if ra != rb {
            p[ra.max(rb)] = ra.min(rb);
        }
    }
    fn link<K: std::hash::Hash + Eq>(seen: &mut HashMap<K, usize>, p: &mut [usize], key: K, i: usize) {
        match seen.get(&key) {
            Some(&j) => join(p, i, j),
            None => {
                seen.insert(key, i);
            }
        }
    }
    let mut by_md5: HashMap<&str, usize> = HashMap::new();
    let mut by_online: HashMap<i64, usize> = HashMap::new();
    let mut by_song: HashMap<(String, String, &str), usize> = HashMap::new();
    for (i, s) in infos.iter().enumerate() {
        for md5 in &md5s[i] {
            link(&mut by_md5, &mut parent, md5.as_str(), i);
        }
        if let Some(o) = s.online_id {
            link(&mut by_online, &mut parent, o, i);
        }
        // stable's files go by their path, not their content: only lazer's songs compare
        let creator = s.creator.trim().to_lowercase();
        let title = s.title.trim().to_lowercase();
        if let (Some(a), "lazer", false) = (&audio[i], s.source.as_str(), creator.is_empty()) {
            link(&mut by_song, &mut parent, (creator, title, a.as_str()), i);
        }
    }

    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..infos.len() {
        let r = root(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut roots: Vec<usize> = groups.keys().copied().filter(|r| groups[r].len() > 1).collect();
    roots.sort_unstable();
    let mut out: Vec<DupeGroup> = Vec::new();
    let mut shown: Vec<usize> = Vec::new();
    for r in roots {
        let members = &groups[&r];
        let mut count: HashMap<&str, usize> = HashMap::new();
        for &i in members {
            for m in &md5s[i] {
                *count.entry(m.as_str()).or_default() += 1;
            }
        }
        let shared = count.values().filter(|&&n| n > 1).count();
        let lazer_md5s: HashSet<&str> = members.iter().filter(|&&i| infos[i].source == "lazer").flat_map(|&i| md5s[i].iter().map(String::as_str)).collect();
        let stable: Vec<usize> = members.iter().copied().filter(|&i| infos[i].source == "stable").collect();
        let copies = !stable.is_empty()
            && !lazer_md5s.is_empty()
            && stable.iter().all(|&i| !md5s[i].is_empty() && md5s[i].iter().all(|m| lazer_md5s.contains(m.as_str())));
        let mut online: HashMap<i64, usize> = HashMap::new();
        for &i in members {
            if let Some(o) = infos[i].online_id {
                *online.entry(o).or_default() += 1;
            }
        }
        let kind = if copies {
            "stable-copy"
        } else if online.values().any(|&n| n > 1) {
            "same-set"
        } else if shared > 0 {
            "shared"
        } else {
            "reupload"
        };
        let mut sets: Vec<usize> = members.clone();
        sets.sort_by_key(|&i| std::cmp::Reverse(infos[i].added.unwrap_or(0)));
        shown.extend(sets.iter().copied());
        out.push(DupeGroup { kind, sets: sets.iter().map(|&i| infos[i].id.clone()).collect(), shared });
    }
    shown.sort_unstable();
    Ok((out, shown.into_iter().map(|i| infos[i].clone()).collect()))
}

fn lazer_sets(conn: &Connection) -> Result<Vec<LazerSet>> {
    let mut songs: HashMap<String, HashSet<String>> = HashMap::new();
    let mut q = conn.prepare("SELECT m.set_id, m.audio FROM maps m JOIN sets s ON s.id = m.set_id WHERE s.source = 'lazer' AND m.audio IS NOT NULL")?;
    for r in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (set, audio) = r?;
        songs.entry(set).or_default().insert(audio);
    }
    let mut q = conn.prepare("SELECT id, files FROM sets WHERE source = 'lazer'")?;
    let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        let (id, files) = r?;
        let files: Vec<(String, String)> = serde_json::from_str(&files).unwrap_or_default();
        let songs = songs.remove(&id).unwrap_or_default();
        out.push(LazerSet { id, files, songs });
    }
    Ok(out)
}

fn stable_sets(conn: &Connection) -> Result<Vec<StableSet>> {
    let mut songs: HashMap<String, HashSet<String>> = HashMap::new();
    let mut q = conn.prepare(
        "SELECT m.set_id, f.path FROM maps m JOIN sets s ON s.id = m.set_id JOIN stable_files f ON f.key = m.audio WHERE s.source = 'stable'",
    )?;
    for r in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (set, path) = r?;
        songs.entry(set).or_default().insert(path.replace('\\', "/").to_lowercase());
    }
    let mut q = conn.prepare("SELECT id, folder FROM sets WHERE source = 'stable' AND folder IS NOT NULL")?;
    let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for r in rows {
        let (id, folder) = r?;
        let songs = songs.remove(&id).unwrap_or_default();
        out.push(StableSet { id, folder, songs });
    }
    Ok(out)
}

fn known_sizes(conn: &Connection) -> Result<HashMap<String, u64>> {
    let mut q = conn.prepare("SELECT hash, size FROM file_sizes")?;
    let rows = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64)))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

/// A stable set's folder, everything in it (subfolders too).
fn walk(songs: &Path, s: &StableSet) -> Option<CareSet> {
    let root = songs.join(&s.folder);
    if !root.is_dir() {
        return None;
    }
    let mut c = CareSet { id: s.id.clone(), ..CareSet::default() };
    let mut stack: Vec<PathBuf> = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                stack.push(e.path());
                continue;
            }
            let path = e.path();
            let rel = path.strip_prefix(songs).map(|p| p.to_string_lossy().replace('\\', "/").to_lowercase()).unwrap_or_default();
            let size = meta.len();
            c.size += size;
            c.kinds[kind_of(&rel, s.songs.contains(&rel)) as usize] += size;
        }
    }
    Some(c)
}

/// `f` over `items` on a few threads (the disk is what's slow), in order.
fn parallel<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    if items.is_empty() {
        return Vec::new();
    }
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(2, 8);
    let chunk = items.len().div_ceil(threads);
    std::thread::scope(|scope| {
        let handles: Vec<_> = items.chunks(chunk).map(|part| scope.spawn(|| part.iter().map(&f).collect::<Vec<R>>())).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_by_extension() {
        assert_eq!(kind_of("audio.mp3", true), Kind::Song);
        assert_eq!(kind_of("soft-hitclap.wav", false), Kind::Sound);
        assert_eq!(kind_of("Video.MP4", false), Kind::Video);
        assert_eq!(kind_of("sb/star.png", false), Kind::Image);
        assert_eq!(kind_of("Artist - Title (Mapper) [Hard].osu", false), Kind::Other);
    }

    #[test]
    fn duplicates_by_kind() {
        let dir = std::env::temp_dir().join(format!("fumen-dupes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let conn = crate::db::open(&dir.join("fumen.db")).unwrap();
        conn.execute_batch(
            "INSERT INTO sets (id, source, online_id, creator, audio, date_added) VALUES
                ('L1', 'lazer', 10, 'a', 'song1', 1), ('S1', 'stable', 10, 'a', 'k1', 0),
                ('L2', 'lazer', 20, 'b', 'song2', 1), ('L3', 'lazer', 20, 'b', 'song9', 2),
                ('P', 'lazer', 30, 'c', 'pack', 1), ('L4', 'lazer', 40, 'd', 'song4', 1),
                ('R1', 'lazer', 50, 'Mapper', 'song5', 1), ('R2', 'lazer', 51, 'mapper', 'song5', 2),
                ('Q', 'lazer', 52, 'mapper', 'song5', 3),
                ('X', 'lazer', 60, 'e', 'song5', 1), ('Y', 'lazer', 70, 'f', 'song7', 1);
             INSERT INTO maps (id, set_id, md5) VALUES
                ('a1', 'L1', 'm1'), ('a2', 'L1', 'm2'), ('s1', 'S1', 'm1'),
                ('b1', 'L2', 'm3'), ('b2', 'L3', 'm4'),
                ('p1', 'P', 'm5'), ('p2', 'P', 'm6'), ('d1', 'L4', 'm6'),
                ('r1', 'R1', 'm7'), ('r2', 'R2', 'm8'), ('x1', 'X', 'm9'), ('y1', 'Y', 'm10'), ('q1', 'Q', 'm11');",
        )
        .unwrap();
        let (groups, _) = duplicates(&conn).unwrap();
        let find = |id: &str| groups.iter().find(|g| g.sets.iter().any(|s| s == id)).map(|g| (g.kind, g.sets.clone(), g.shared));
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(find("S1"), Some(("stable-copy", ids(&["L1", "S1"]), 1)));
        assert_eq!(find("L2"), Some(("same-set", ids(&["L3", "L2"]), 0)));
        assert_eq!(find("P"), Some(("shared", ids(&["P", "L4"]), 1)));
        // the same song by another mapper isn't a re-upload, nor the mapper's pack with it
        conn.execute_batch("UPDATE sets SET title = 'Song' WHERE id IN ('R1', 'R2', 'X'); UPDATE sets SET title = 'Pack' WHERE id = 'Q'").unwrap();
        let (groups, infos) = duplicates(&conn).unwrap();
        let find = |id: &str| groups.iter().find(|g| g.sets.iter().any(|s| s == id)).map(|g| (g.kind, g.sets.clone(), g.shared));
        assert_eq!(find("R1"), Some(("reupload", ids(&["R2", "R1"]), 0)));
        assert_eq!(find("X"), None);
        assert_eq!(find("Q"), None);
        assert_eq!(groups.len(), 4);
        assert_eq!(infos.len(), 8);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lazer_sets_count_shared_files_once() {
        let dir = std::env::temp_dir().join(format!("fumen-care-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let hash = |c: char| c.to_string().repeat(64);
        let put = |h: &str, len: usize| {
            let p = crate::paths::lazer_file(&dir, h).unwrap();
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, vec![0u8; len]).unwrap();
        };
        let (song, bg, video, shared) = (hash('a'), hash('b'), hash('c'), hash('d'));
        put(&song, 1000);
        put(&bg, 200);
        put(&video, 5000);
        put(&shared, 30);
        let conn = crate::db::open(&dir.join("fumen.db")).unwrap();
        let files = |v: &[(&str, &str)]| serde_json::to_string(v).unwrap();
        conn.execute(
            "INSERT INTO sets (id, source, files) VALUES ('s1', 'lazer', ?1), ('s2', 'lazer', ?2)",
            params![
                files(&[("audio.mp3", &song), ("bg.jpg", &bg), ("bga.mp4", &video), ("hit.wav", &shared), ("gone.png", &hash('e'))]),
                files(&[("hit.wav", &shared)]),
            ],
        )
        .unwrap();
        conn.execute("INSERT INTO maps (id, set_id, audio) VALUES ('m1', 's1', ?1)", [&song]).unwrap();
        let db = std::sync::Mutex::new(conn);
        let r = report(&db, Some(&dir), None, |_, _| {}).unwrap();
        let s1 = r.sets.iter().find(|s| s.id == "s1").unwrap();
        assert_eq!(s1.size, 6230);
        assert_eq!(s1.kinds, [1000, 5000, 200, 30, 0]);
        assert_eq!(s1.missing, 1);
        assert_eq!(r.lazer_size, 6230);
        // measured once, kept
        let n: i64 = db.lock().unwrap().query_row("SELECT COUNT(*) FROM file_sizes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// On a real export and lazer's files, read only: `FUMEN_TEST_EXPORT=<json> FUMEN_TEST_STORAGE=<lazer>
    /// cargo test care::tests::real -- --ignored`; FUMEN_TEST_STABLE (osu!stable's folder) adds its
    /// sets; with FUMEN_CARE_OUT, the report goes there (the browser preview's .cache/care.json).
    #[test]
    #[ignore = "reads a real lazer library"]
    fn real() {
        let (Some(json), Some(storage)) = (std::env::var_os("FUMEN_TEST_EXPORT"), std::env::var_os("FUMEN_TEST_STORAGE")) else { return };
        let dir = std::env::temp_dir().join(format!("fumen-care-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut conn = crate::db::open(&dir.join("t.db")).unwrap();
        let install = crate::paths::LazerInstall { path: "x".into(), storage: "x".into(), realm_size: 1, realm_modified: 1 };
        crate::lazer::import(&mut conn, Path::new(&json), &install).unwrap();
        let stable = std::env::var_os("FUMEN_TEST_STABLE").and_then(|p| crate::paths::inspect_stable(Path::new(&p)));
        if let Some(st) = &stable {
            crate::stable::import(&mut conn, st, |_, _| {}).unwrap();
        }
        let songs = stable.as_ref().map(|s| PathBuf::from(&s.songs));
        let db = std::sync::Mutex::new(conn);
        for round in 0..2 {
            let t = std::time::Instant::now();
            let r = report(&db, Some(Path::new(&storage)), songs.as_deref(), |_, _| {}).unwrap();
            let gb = |b: u64| b as f64 / 1e9;
            let mut kinds = [0u64; KINDS];
            for s in &r.sets {
                for k in 0..KINDS {
                    kinds[k] += s.kinds[k];
                }
            }
            let missing: u32 = r.sets.iter().map(|s| s.missing).sum();
            eprintln!(
                "round {round}: {} sets, {:.2} GB unique, by kind {:?} GB, {missing} files missing, in {:?}",
                r.sets.len(),
                gb(r.lazer_size),
                kinds.map(|k| (gb(k) * 100.0).round() / 100.0),
                t.elapsed()
            );
            let mut kinds_n: HashMap<&str, usize> = HashMap::new();
            for g in &r.duplicates {
                *kinds_n.entry(g.kind).or_default() += 1;
            }
            eprintln!("  stable {:.2} GB, duplicates {kinds_n:?}", gb(r.stable_size));
            if round == 1 {
                let name = |id: &str| r.dupe_sets.iter().find(|s| s.id == id).map(|s| format!("{} - {} ({}, {})", s.artist, s.title, s.creator, s.source)).unwrap_or_default();
                for kind in ["stable-copy", "same-set", "shared", "reupload"] {
                    for g in r.duplicates.iter().filter(|g| g.kind == kind).take(4) {
                        eprintln!("  {kind} shared {}: {}", g.shared, g.sets.iter().map(|s| name(s)).collect::<Vec<_>>().join(" | "));
                    }
                }
            }
            if let (1, Some(out)) = (round, std::env::var_os("FUMEN_CARE_OUT")) {
                std::fs::write(out, serde_json::to_string(&r).unwrap()).unwrap();
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
