mod analysis;
mod chart;
mod charts;
mod collections;
mod db;
mod downloads;
mod error;
mod goals;
mod hitsounds;
mod lazer;
mod lazer_import;
mod mma;
mod osu_auth;
mod osu_scores;
mod library;
mod paths;
mod protocol;
mod settings;
mod skins;
mod stars;
#[cfg(test)]
mod test_http;
mod thumbs;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use error::{Error, Result};
use lazer::ImportCounts;
use paths::LazerInstall;
use settings::Settings;

pub struct AppState {
    db: Mutex<Connection>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    cache_dir: PathBuf,
    data_dir: PathBuf,
    /// GitHub's list of lazer versions tested with the import (None: unreachable), and when it was read
    remote_compat: Mutex<Option<(std::time::Instant, Option<lazer_import::Compat>)>>,
    /// lazer's resolved storage folder (holds client.realm + files/), for the protocol handler.
    storage: RwLock<Option<PathBuf>>,
    scanning: AtomicBool,
    analysing: AtomicBool,
    /// another analysis pass was requested while one was running
    analyse_again: AtomicBool,
    /// an osu! login is waiting for the browser, and whether to stop waiting
    logging_in: AtomicBool,
    login_cancel: AtomicBool,
    /// a sync with osu! is running
    syncing: AtomicBool,
    /// when each difficulty's scores were last asked of osu! (osu!'s difficulty id)
    map_synced: Mutex<std::collections::HashMap<i64, std::time::Instant>>,
}

impl AppState {
    fn storage(&self) -> Option<PathBuf> {
        self.storage.read().ok()?.clone()
    }

    fn thumbs_dir(&self) -> PathBuf {
        self.cache_dir.join("thumbs")
    }

    fn cache_dir(&self) -> &std::path::Path {
        &self.cache_dir
    }

    /// The tested-lazer-versions list: Fumen's own, plus GitHub's (read again after 10 minutes).
    fn compat(&self) -> lazer_import::Compat {
        let fresh = |at: &std::time::Instant| at.elapsed() < std::time::Duration::from_secs(600);
        let cached = self.remote_compat.lock().ok().and_then(|g| g.clone()).filter(|(at, _)| fresh(at));
        let remote = match cached {
            Some((_, remote)) => remote,
            None => {
                let remote = lazer_import::Compat::remote();
                if let Ok(mut c) = self.remote_compat.lock() {
                    *c = Some((std::time::Instant::now(), remote.clone()));
                }
                remote
            }
        };
        lazer_import::Compat::bundled().merge(remote)
    }

    fn settings(&self) -> Settings {
        self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn install(&self) -> Option<LazerInstall> {
        let dir = self.settings().lazer_override().or_else(paths::default_lazer_dir)?;
        paths::inspect_lazer(&dir)
    }

    fn refresh_storage(&self) {
        let storage = self.install().map(|i| PathBuf::from(i.storage));
        if let Ok(mut s) = self.storage.write() {
            *s = storage;
        }
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn update_settings(state: State<'_, AppState>, patch: Value) -> Result<Settings> {
    let updated = {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.apply_patch(patch)?;
        s.save(&state.settings_path)?;
        s.clone()
    };
    state.refresh_storage();
    Ok(updated)
}

/// Validates a folder the user picked; `None` if it isn't a lazer data folder.
#[tauri::command]
fn inspect_lazer_path(path: String) -> Option<LazerInstall> {
    paths::inspect_lazer(&PathBuf::from(path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryStatus {
    install: Option<LazerInstall>,
    default_path: Option<String>,
    scanned_at: Option<i64>,
    counts: Option<Value>,
    /// lazer's database changed (or moved) since the last import.
    changed: bool,
    scanning: bool,
}

#[tauri::command]
fn library_status(state: State<'_, AppState>) -> Result<LibraryStatus> {
    let install = state.install();
    let conn = state.db();
    let scanned_at = db::get_meta(&conn, "lazer.lastScan")?.and_then(|v| v.parse().ok());
    let counts = db::get_meta(&conn, "lazer.counts")?.and_then(|v| serde_json::from_str(&v).ok());
    let changed = match (&install, scanned_at) {
        (Some(i), Some(_)) => {
            db::get_meta(&conn, "lazer.realmModified")?.as_deref() != Some(&i.realm_modified.to_string())
                || db::get_meta(&conn, "lazer.realmSize")?.as_deref() != Some(&i.realm_size.to_string())
                || db::get_meta(&conn, "lazer.storage")?.as_deref() != Some(i.storage.as_str())
                // imported before Fumen read lazer's mania settings: worth one more import
                || db::get_meta(&conn, "lazer.maniaSettings")?.is_none()
                // …and before it read lazer's skins
                || db::get_meta(&conn, "lazer.skins")?.is_none()
                // …and the sets' sound files (custom hitsounds)
                || db::get_meta(&conn, "lazer.setSounds")?.is_none()
        }
        _ => false,
    };
    Ok(LibraryStatus {
        install,
        default_path: paths::default_lazer_dir().map(|p| p.to_string_lossy().into_owned()),
        scanned_at,
        counts,
        changed,
        scanning: state.scanning.load(Ordering::SeqCst),
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    stage: String,
    done: u64,
    total: u64,
}

/// Imports lazer's library: sidecar export → SQLite. Emits `scan-progress` along the way and
/// `library-changed` when the new data is committed.
#[tauri::command]
async fn scan_library(app: AppHandle) -> Result<ImportCounts> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.scanning.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "A scan is already running"));
        }
        let result = run_scan(&app, &state);
        state.scanning.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

fn run_scan(app: &AppHandle, state: &AppState) -> Result<ImportCounts> {
    let emit = |stage: &str, done: u64, total: u64| {
        let _ = app.emit("scan-progress", ScanProgress { stage: stage.into(), done, total });
    };
    let install = state.install().ok_or_else(|| {
        Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings.")
    })?;

    std::fs::create_dir_all(&state.cache_dir)?;
    let out = state.cache_dir.join("lazer-export.json");
    lazer::run_export(&PathBuf::from(&install.storage), &out, |stage, done, total| emit(stage, done, total))?;

    emit("import", 0, 1);
    let counts = {
        let mut conn = state.db();
        lazer::import(&mut conn, &out, &install)?
    };
    let _ = std::fs::remove_file(&out);
    state.refresh_storage();
    if let Err(e) = skins::refresh_builtin(&state.cache_dir) {
        eprintln!("[skins] built-in textures: {e}");
    }
    emit("import", 1, 1);
    let _ = app.emit("library-changed", counts);
    start_analysis(app);
    Ok(counts)
}

// ── Chart analysis ──────────────────────────────────────────────────────────

/// Analyses every difficulty that has no cached analysis yet, in the background. Emits
/// `analysis-progress` while working and `analysis-done` when new results were stored.
fn start_analysis(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.analysing.swap(true, Ordering::SeqCst) {
        state.analyse_again.store(true, Ordering::SeqCst);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        loop {
            state.analyse_again.store(false, Ordering::SeqCst);
            match run_analysis(&app, &state) {
                Ok(true) => {
                    let _ = app.emit("analysis-done", ());
                }
                Ok(false) => {}
                Err(e) => eprintln!("[analysis] {e}"),
            }
            if !state.analyse_again.load(Ordering::SeqCst) {
                break;
            }
        }
        state.analysing.store(false, Ordering::SeqCst);
    });
}

fn run_analysis(app: &AppHandle, state: &AppState) -> Result<bool> {
    let Some(storage) = state.storage() else { return Ok(false) };
    if !storage.join("files").is_dir() {
        return Ok(false);
    }
    let hashes = charts::pending(&state.db())?;
    if hashes.is_empty() {
        return Ok(false);
    }
    let total = hashes.len() as u64;
    let emit = |done: u64| {
        let _ = app.emit("analysis-progress", ScanProgress { stage: "analysis".into(), done, total });
    };
    emit(0);
    let mut done = 0u64;
    for chunk in hashes.chunks(400) {
        let rows = charts::analyse_batch(&storage, chunk);
        charts::store(&mut state.db(), &rows)?;
        done += chunk.len() as u64;
        emit(done);
    }
    Ok(true)
}

/// A difficulty's chart, read from lazer's files.
fn load_chart(app: &AppHandle, id: &str) -> Result<chart::Chart> {
    let state = app.state::<AppState>();
    let hash: Option<String> = state
        .db()
        .query_row("SELECT hash FROM maps WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
    let hash = hash.ok_or_else(|| Error::known("chart-missing", "This difficulty isn't in the library anymore."))?;
    let storage = state
        .storage()
        .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
    charts::load(&storage, &hash)
}

/// One difficulty's notes, timing and full analysis as raw JSON (see `charts.rs`).
#[tauri::command]
async fn get_chart(app: AppHandle, id: String) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || charts::chart_json(&load_chart(&app, &id)?).map(tauri::ipc::Response::new))
        .await
        .map_err(|e| Error::known("internal", e.to_string()))?
}

/// An osu!mania difficulty's dan at a clock rate (the chart comes with the one at 1×).
#[tauri::command]
async fn get_dan(app: AppHandle, id: String, rate: f64) -> Result<Option<mma::dan::Dan>> {
    tauri::async_runtime::spawn_blocking(move || Ok(mma::dan::rate(&load_chart(&app, &id)?, rate.clamp(0.25, 4.0))))
        .await
        .map_err(|e| Error::known("internal", e.to_string()))?
}

/// An osu!mania difficulty's hitsounds, with its set's custom samples and storyboard samples
/// (see `hitsounds.rs`). Empty for other modes.
#[tauri::command]
async fn get_hitsounds(app: AppHandle, id: String) -> Result<hitsounds::Sounds> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let storage = state
            .storage()
            .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
        let conn = state.db();
        hitsounds::for_map(&conn, &storage, &id)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

// ── osu! account ────────────────────────────────────────────────────────────

/// The logged-in osu! account as last seen, without asking osu!.
#[tauri::command]
fn osu_account(state: State<'_, AppState>) -> Option<osu_auth::Account> {
    osu_auth::account(&state.data_dir)
}

/// Logs in through the browser (see `osu_auth.rs`); resolves once the browser is back.
#[tauri::command]
async fn osu_login(app: AppHandle) -> Result<osu_auth::Account> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_opener::OpenerExt;
        let state = app.state::<AppState>();
        if state.logging_in.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "A login is already waiting for your browser."));
        }
        state.login_cancel.store(false, Ordering::SeqCst);
        let result = osu_auth::login(&state.data_dir, &osu_auth::Endpoints::default(), &state.login_cancel, |url| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| Error::known("open-failed", format!("The browser didn't open: {e}")))
        });
        state.logging_in.store(false, Ordering::SeqCst);
        let account = result?;
        // whose plays are "yours" from now on (another account's osu! data goes)
        osu_scores::set_user(&state.db(), account.id as i64)?;
        let _ = app.emit("history-changed", true);
        Ok(account)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Stops waiting for the browser.
#[tauri::command]
fn osu_login_cancel(state: State<'_, AppState>) {
    state.login_cancel.store(true, Ordering::SeqCst);
}

/// The account as osu! has it now; None when not logged in (anymore). Offline, it's the one
/// last seen.
#[tauri::command]
async fn osu_refresh_account(app: AppHandle) -> Result<Option<osu_auth::Account>> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.state::<AppState>().data_dir.clone();
        if osu_auth::account(&dir).is_none() {
            return Ok(None);
        }
        match osu_auth::refresh_account(&dir, &osu_auth::Endpoints::default()) {
            Ok(account) => Ok(Some(account)),
            Err(e) if e.code() == "osu-logged-out" => Ok(None),
            Err(e) => {
                eprintln!("[osu] account update: {e}");
                Ok(osu_auth::account(&dir))
            }
        }
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

#[tauri::command]
async fn osu_logout(app: AppHandle) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        osu_auth::logout(&state.data_dir, &osu_auth::Endpoints::default())?;
        osu_scores::clear(&state.db())?;
        let _ = app.emit("history-changed", true);
        Ok(())
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

// ── Plays ───────────────────────────────────────────────────────────────────

/// The player's plays, local and from osu!, as raw JSON (see `osu_scores.rs`).
#[tauri::command]
async fn get_history(app: AppHandle) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let account = osu_auth::account(&state.data_dir);
        let storage = state.storage();
        let conn = state.db();
        osu_scores::history_json(&conn, account.as_ref(), storage.as_deref()).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

#[tauri::command]
fn get_collections(state: State<AppState>) -> Result<Vec<collections::Collection>> {
    collections::list(&state.db())
}

#[tauri::command]
fn create_collection(state: State<AppState>, name: String, maps: Vec<String>) -> Result<String> {
    collections::create(&mut state.db(), &name, &maps)
}

/// Saves a search (the UI's filters as JSON) as a smart collection.
#[tauri::command]
fn create_smart_collection(state: State<AppState>, name: String, query: String) -> Result<String> {
    collections::create_smart(&state.db(), &name, &query)
}

#[tauri::command]
fn set_collection_query(state: State<AppState>, id: String, query: String) -> Result<()> {
    collections::set_query(&state.db(), &id, &query)
}

/// A Fumen copy of one of lazer's collections (Fumen's can be changed).
#[tauri::command]
fn copy_lazer_collection(state: State<AppState>, id: String, name: String) -> Result<String> {
    collections::copy_lazer(&mut state.db(), &id, &name)
}

#[tauri::command]
fn rename_collection(state: State<AppState>, id: String, name: String) -> Result<()> {
    collections::rename(&state.db(), &id, &name)
}

#[tauri::command]
fn delete_collection(state: State<AppState>, id: String) -> Result<()> {
    collections::delete(&state.db(), &id)
}

#[tauri::command]
fn add_to_collection(state: State<AppState>, id: String, maps: Vec<String>) -> Result<usize> {
    collections::add(&mut state.db(), &id, &maps)
}

#[tauri::command]
fn remove_from_collection(state: State<AppState>, id: String, maps: Vec<String>) -> Result<usize> {
    collections::remove(&mut state.db(), &id, &maps)
}

#[tauri::command]
fn get_goals(state: State<AppState>) -> Result<Vec<serde_json::Value>> {
    goals::list(&state.db())
}

#[tauri::command]
fn put_goal(state: State<AppState>, goal: serde_json::Value) -> Result<()> {
    goals::put(&state.db(), &goal)
}

#[tauri::command]
fn delete_goal(state: State<AppState>, id: String) -> Result<()> {
    goals::delete(&state.db(), &id)
}

/// Reads the player's scores, stats and play counts from osu!. Emits "history-changed" (its
/// payload, here and elsewhere: whether the library's best scores may have changed).
#[tauri::command]
async fn sync_osu_scores(app: AppHandle) -> Result<osu_scores::SyncSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.syncing.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "Fumen is already reading your scores from osu!."));
        }
        let result = (|| {
            let account = osu_auth::account(&state.data_dir).ok_or_else(|| Error::known("osu-logged-out", "You're not logged in to osu!."))?;
            let ep = osu_auth::Endpoints::default();
            let fetched = osu_auth::with_token(&state.data_dir, &ep, |token| osu_scores::fetch(&ep, token, &account))?;
            osu_scores::store(&mut state.db(), &fetched)
        })();
        state.syncing.store(false, Ordering::SeqCst);
        if let Ok(summary) = &result {
            let _ = app.emit("history-changed", summary.added > 0);
        }
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Reads the player's scores on one difficulty (osu!'s id) from osu!, in these rulesets: plays
/// from other computers or stable that the syncs' top and recent plays don't reach. Asks osu! at
/// most every 10 minutes per difficulty; nothing when logged out. How many scores were new.
#[tauri::command]
async fn sync_map_scores(app: AppHandle, beatmap_id: i64, modes: Vec<i64>) -> Result<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let Some(account) = osu_auth::account(&state.data_dir) else { return Ok(0) };
        {
            let mut seen = state.map_synced.lock().unwrap_or_else(|e| e.into_inner());
            let now = std::time::Instant::now();
            if seen.get(&beatmap_id).is_some_and(|at| now.duration_since(*at) < std::time::Duration::from_secs(600)) {
                return Ok(0);
            }
            seen.insert(beatmap_id, now);
        }
        let ep = osu_auth::Endpoints::default();
        let scores = osu_auth::with_token(&state.data_dir, &ep, |token| osu_scores::fetch_map(&ep, token, account.id, beatmap_id, &modes))?;
        let added = osu_scores::store_map(&mut state.db(), account.id as i64, &scores)?;
        if added > 0 {
            let _ = app.emit("history-changed", true);
        }
        Ok(added)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

// ── Import into lazer ───────────────────────────────────────────────────────

/// Whether beatmap sets can be imported into lazer right now, and why not.
#[tauri::command]
async fn lazer_import_status(app: AppHandle) -> Result<lazer_import::Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let compat = state.compat();
        Ok(lazer_import::status(state.storage().as_deref(), &compat))
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    /// which of the pasted lines
    index: usize,
    /// resolving | downloading | importing | done | skipped | error
    stage: &'static str,
    set: Option<u32>,
    title: Option<String>,
    done: u64,
    total: u64,
    message: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ImportSummary {
    imported: usize,
    skipped: usize,
    failed: usize,
}

/// Downloads the sets behind pasted osu! links and imports them into lazer (see
/// `lazer_import.rs` for when that's allowed), then updates Fumen's library. Emits
/// `import-progress` per line along the way.
#[tauri::command]
async fn import_beatmaps(app: AppHandle, links: Vec<String>) -> Result<ImportSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.scanning.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "The library is being updated; try again in a moment."));
        }
        let result = run_import(&app, &state, &links);
        state.scanning.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

fn run_import(app: &AppHandle, state: &AppState, links: &[String]) -> Result<ImportSummary> {
    let emit = |index: usize, stage: &'static str, set: Option<u32>, title: Option<String>, message: Option<String>| {
        let p = ImportProgress { index, stage, set, title, done: 0, total: 0, message };
        let _ = app.emit("import-progress", p);
    };
    let mut summary = ImportSummary::default();

    let storage = state
        .storage()
        .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
    let compat = state.compat();
    // nothing gets downloaded for an import that couldn't happen anyway
    let st = lazer_import::status(Some(&storage), &compat);
    if let Some(reason) = st.reason {
        return Err(Error::known(lazer_import::error_code(reason), st.message.unwrap_or_default()));
    }

    // links → sets (each set once)
    let mut sets: Vec<(usize, u32)> = Vec::new();
    for (i, line) in links.iter().enumerate() {
        let set = match downloads::parse_link(line) {
            None => {
                emit(i, "error", None, None, Some("Not an osu! beatmap link".into()));
                summary.failed += 1;
                continue;
            }
            Some(downloads::Target::Set(id)) => id,
            Some(downloads::Target::Beatmap(b)) => {
                emit(i, "resolving", None, None, None);
                match downloads::set_of_beatmap(b) {
                    Ok(id) => id,
                    Err(e) => {
                        emit(i, "error", None, None, Some(e.to_string()));
                        summary.failed += 1;
                        continue;
                    }
                }
            }
        };
        if sets.iter().any(|&(_, s)| s == set) {
            emit(i, "skipped", Some(set), None, Some("Same set as above".into()));
            summary.skipped += 1;
        } else {
            sets.push((i, set));
        }
    }

    // already in the library: nothing to do
    let title_of = |set: u32| -> Option<String> {
        state
            .db()
            .query_row(
                "SELECT artist || ' - ' || title FROM sets WHERE online_id = ?1 AND source = 'lazer' LIMIT 1",
                [set],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
    };
    sets.retain(|&(i, set)| match title_of(set) {
        Some(title) => {
            emit(i, "skipped", Some(set), Some(title), Some("Already in your library".into()));
            summary.skipped += 1;
            false
        }
        None => true,
    });

    // downloads
    let dl_dir = state.cache_dir.join("downloads");
    let mut files: Vec<(usize, u32, PathBuf)> = Vec::new();
    for &(i, set) in &sets {
        let mut last: Option<std::time::Instant> = None;
        let result = downloads::download_set(set, &dl_dir, |done, total| {
            if last.map_or(true, |t| t.elapsed() >= std::time::Duration::from_millis(120)) || Some(done) == total {
                last = Some(std::time::Instant::now());
                let p = ImportProgress { index: i, stage: "downloading", set: Some(set), title: None, done, total: total.unwrap_or(0), message: None };
                let _ = app.emit("import-progress", p);
            }
        });
        match result {
            Ok((path, _mirror)) => files.push((i, set, path)),
            Err(e) => {
                emit(i, "error", Some(set), None, Some(e.to_string()));
                summary.failed += 1;
            }
        }
    }
    if files.is_empty() {
        return Ok(summary);
    }

    // into lazer, all at once (one backup, one start of the importer)
    for &(i, set, _) in &files {
        emit(i, "importing", Some(set), None, None);
    }
    let paths: Vec<PathBuf> = files.iter().map(|(_, _, p)| p.clone()).collect();
    let results = lazer_import::import(&storage, &state.cache_dir, &state.data_dir.join("lazer-backups"), &paths, &compat);
    for p in &paths {
        let _ = std::fs::remove_file(p);
    }
    let results = match results {
        Ok(r) => r,
        Err(e) => {
            for &(i, set, _) in &files {
                emit(i, "error", Some(set), None, Some(e.to_string()));
            }
            return Err(e);
        }
    };

    // Fumen's library catches up, then every line gets its title
    if let Err(e) = run_scan(app, state) {
        eprintln!("[import] library update after import: {e}");
    }
    for (i, set, path) in &files {
        match results.iter().find(|r| r.file.file_name() == path.file_name()) {
            Some(r) if r.ok && !r.sets.is_empty() => {
                emit(*i, "done", Some(*set), title_of(*set), None);
                summary.imported += 1;
            }
            Some(r) => {
                let why = r.message.clone().unwrap_or_else(|| "lazer found no beatmaps in the download".into());
                emit(*i, "error", Some(*set), None, Some(why));
                summary.failed += 1;
            }
            None => {
                emit(*i, "error", Some(*set), None, Some("The importer didn't report on this set".into()));
                summary.failed += 1;
            }
        }
    }
    Ok(summary)
}

/// lazer's skins (without their files), the selected one and the built-in textures at hand.
#[tauri::command]
async fn get_skins(app: AppHandle) -> Result<skins::SkinList> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // first run after an update, or lazer was updated: (re-)extract classic / retro
        if let Err(e) = skins::refresh_builtin(state.cache_dir()) {
            eprintln!("[skins] built-in textures: {e}");
        }
        let install = state.install();
        let conn = state.db();
        skins::list(&conn, install.as_ref(), state.cache_dir())
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// One skin's files as raw JSON: `[[filename, sha256], …]`.
#[tauri::command]
fn get_skin_files(state: State<'_, AppState>, id: String) -> Result<tauri::ipc::Response> {
    let files = skins::files(&state.db(), &id)?
        .ok_or_else(|| Error::known("skin-missing", "This skin isn't in lazer anymore."))?;
    Ok(tauri::ipc::Response::new(files.into_bytes()))
}

/// The full library snapshot as raw JSON (see `library.rs`).
#[tauri::command]
async fn get_library(app: AppHandle) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let conn = state.db();
        library::snapshot_json(&conn).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

// ── App ─────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("fumen", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(protocol::handle(&app, &request)));
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            let settings_path = config_dir.join("settings.json");
            let settings = Settings::load(&settings_path);
            let conn = db::open(&data_dir.join("library.db"))?;

            let state = AppState {
                db: Mutex::new(conn),
                settings: Mutex::new(settings),
                settings_path,
                cache_dir,
                data_dir,
                remote_compat: Mutex::new(None),
                storage: RwLock::new(None),
                scanning: AtomicBool::new(false),
                analysing: AtomicBool::new(false),
                analyse_again: AtomicBool::new(false),
                logging_in: AtomicBool::new(false),
                login_cancel: AtomicBool::new(false),
                syncing: AtomicBool::new(false),
                map_synced: Mutex::new(std::collections::HashMap::new()),
            };
            state.refresh_storage();
            app.manage(state);
            // difficulties imported by an older version (or before a crash) still need analysing
            start_analysis(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            inspect_lazer_path,
            library_status,
            scan_library,
            get_library,
            get_chart,
            get_dan,
            get_hitsounds,
            get_skins,
            get_skin_files,
            lazer_import_status,
            import_beatmaps,
            osu_account,
            osu_login,
            osu_login_cancel,
            get_collections,
            create_collection,
            create_smart_collection,
            set_collection_query,
            copy_lazer_collection,
            rename_collection,
            delete_collection,
            add_to_collection,
            remove_from_collection,
            get_goals,
            put_goal,
            delete_goal,
            osu_refresh_account,
            osu_logout,
            get_history,
            sync_osu_scores,
            sync_map_scores,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fumen");
}
