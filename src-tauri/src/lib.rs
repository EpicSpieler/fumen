mod analysis;
mod archive;
mod care;
mod catch;
mod chart;
mod cloud;
mod replay;
mod charts;
mod collections;
mod db;
mod downloads;
mod error;
mod goals;
mod hitsounds;
mod lazer;
mod lazer_import;
mod lazer_linux;
mod matches;
mod mirror_search;
mod mma;
mod mods;
mod osu;
mod osu_auth;
mod osu_scores;
mod overlay;
mod library;
mod live;
mod paths;
mod ping;
mod secret;
mod player;
mod pools;
mod pp;
mod protocol;
mod settings;
mod skins;
mod stable;
mod stable_import;
mod stars;
mod taiko;
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
use paths::{LazerInstall, StableInstall};
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
    /// stable's files by key (see stable.rs), as of the last scan
    stable_files: RwLock<std::sync::Arc<paths::StableFiles>>,
    scanning: AtomicBool,
    analysing: AtomicBool,
    /// another analysis pass was requested while one was running
    analyse_again: AtomicBool,
    /// an osu! login is waiting for the browser, and whether to stop waiting
    logging_in: AtomicBool,
    login_cancel: AtomicBool,
    /// a sync with osu! is running
    syncing: AtomicBool,
    /// the running import of beatmaps should stop
    import_cancel: AtomicBool,
    /// comparisons with other players: the one running, and whether it should stop
    comparing: AtomicBool,
    compare_cancel: AtomicBool,
    /// when each difficulty's scores were last asked of osu! (osu!'s difficulty id)
    map_synced: Mutex<std::collections::HashMap<i64, std::time::Instant>>,
    /// lazer's storage folder being watched for new plays, and the watcher (`live.rs`)
    live: Mutex<Option<(PathBuf, notify::RecommendedWatcher)>>,
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

/// stable, when it's found and wanted.
    fn stable_install(&self) -> Option<StableInstall> {
        let s = self.settings();
        if !s.use_stable {
            return None;
        }
        paths::inspect_stable(&s.stable_override().or_else(paths::default_stable_dir)?)
    }

    /// Where the library's file keys point (lazer's store, stable's Songs folder).
    fn files(&self) -> paths::Files {
        paths::Files {
            lazer: self.storage(),
            stable: self.stable_files.read().map(|f| f.clone()).unwrap_or_default(),
        }
    }

    fn reload_stable_files(&self) {
        match stable::load_files(&self.db()) {
            Ok(f) => {
                if let Ok(mut s) = self.stable_files.write() {
                    *s = std::sync::Arc::new(f);
                }
            }
            Err(e) => eprintln!("[stable] files: {e}"),
        }
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
fn update_settings(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Result<Settings> {
    let updated = {
        let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
        s.apply_patch(patch)?;
        s.save(&state.settings_path)?;
        s.clone()
    };
    state.refresh_storage();
    watch_plays(&app);
    Ok(updated)
}

// ── Plays as they happen (live.rs) ──────────────────────────────────────────

/// Watches lazer's files for new plays (again, when lazer's folder changed). Each new play is
/// kept and goes to every window as `live-play`.
fn watch_plays(app: &AppHandle) {
    let state = app.state::<AppState>();
    let storage = state.storage();
    let mut live = state.live.lock().unwrap_or_else(|e| e.into_inner());
    if live.as_ref().map(|(p, _)| p) == storage.as_ref() {
        return;
    }
    *live = None;
    let Some(storage) = storage else { return };
    let handle = app.clone();
    let watcher = live::watch(&storage, move |play| {
        let state = handle.state::<AppState>();
        let play = {
            let conn = state.db();
            match live::store(&conn, &play) {
                Ok(true) => live::with_library(&conn, play),
                Ok(false) => return,
                Err(e) => Err(e),
            }
        };
        match play {
            Ok(p) => {
                let _ = handle.emit("live-play", p);
            }
            Err(e) => eprintln!("[live] {e}"),
        }
    });
    if let Some(w) = watcher {
        *live = Some((storage, w));
    }
}

/// The plays since `since` (unix ms), newest first.
#[tauri::command]
async fn live_plays(app: AppHandle, since: i64) -> Result<Vec<live::LivePlay>> {
    tauri::async_runtime::spawn_blocking(move || live::since(&app.state::<AppState>().db(), since))
        .await
        .map_err(|e| Error::known("internal", e.to_string()))?
}

/// One play.
#[tauri::command]
async fn live_play(app: AppHandle, id: String) -> Result<Option<live::LivePlay>> {
    tauri::async_runtime::spawn_blocking(move || live::get(&app.state::<AppState>().db(), &id))
        .await
        .map_err(|e| Error::known("internal", e.to_string()))?
}

/// The collections that can be a pool in the companion window.
#[tauri::command]
fn pool_choices(state: State<'_, AppState>) -> Result<Vec<live::PoolChoice>> {
    live::pool_choices(&state.db())
}

/// A pool's difficulties and how they went since `since` (unix ms).
#[tauri::command]
fn pool_rows(state: State<'_, AppState>, id: String, since: i64) -> Result<Vec<live::PoolRow>> {
    live::pool(&state.db(), &id, since)
}

const COMPANION: &str = "companion";

/// The companion window's width; its height follows what it shows (`fit_companion`).
const COMPANION_WIDTH: f64 = 248.0;

/// The companion window: small, on top of the game (lazer in borderless or windowed mode), in the
/// bottom right corner of the main screen. Opening it again just shows it. Async: a window made in
/// a synchronous command deadlocks on Windows (it stays white).
#[tauri::command]
async fn open_companion(app: AppHandle) -> Result<()> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(COMPANION) {
        let _ = w.show();
        return Ok(());
    }
    let (w, h) = (COMPANION_WIDTH, 180.0);
    let mut b = tauri::WebviewWindowBuilder::new(&app, COMPANION, tauri::WebviewUrl::App("companion.html".into()))
        .title("Fumen")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false);
    if let Ok(Some(m)) = app.primary_monitor() {
        let area = m.work_area();
        let scale = m.scale_factor();
        let right = (area.position.x as f64 + area.size.width as f64) / scale;
        let bottom = (area.position.y as f64 + area.size.height as f64) / scale;
        b = b.position(right - w - 12.0, bottom - h - 12.0);
    }
    let window = b.build().map_err(|e| Error::known("internal", e.to_string()))?;
    #[cfg(windows)]
    see_through(window);
    #[cfg(not(windows))]
    drop(window);
    Ok(())
}

/// Lets clicks through the companion window while the cursor is over it, so it never stands in
/// the game's way; holding Ctrl makes it clickable again. The page fades while it lets clicks
/// through (event `companion-through`). A window that ignores the cursor gets no mouse events, so
/// the cursor is looked at from here, until the window is gone.
#[cfg(windows)]
fn see_through(window: tauri::WebviewWindow) {
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut through = false;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else { break };
            let Ok(cursor) = window.app_handle().cursor_position() else { continue };
            let over = cursor.x >= pos.x as f64
                && cursor.y >= pos.y as f64
                && cursor.x < pos.x as f64 + size.width as f64
                && cursor.y < pos.y as f64 + size.height as f64;
            let now = over && !ctrl_held();
            if now != through {
                through = now;
                let _ = window.set_ignore_cursor_events(through);
                let _ = window.emit_to(COMPANION, "companion-through", through);
            }
        }
    });
}

#[cfg(windows)]
fn ctrl_held() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    // the high bit: down right now
    unsafe { GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000 != 0 }
}

/// Fits the companion window's height to what it shows, keeping its bottom edge where it is.
#[tauri::command]
fn fit_companion(app: AppHandle, height: f64) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window(COMPANION) else { return };
    let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else { return };
    let height = (height.clamp(120.0, 520.0) * scale).round() as u32;
    if height == size.height {
        return;
    }
    let bottom = pos.y + size.height as i32;
    let _ = w.set_size(tauri::PhysicalSize::new(size.width, height));
    let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, bottom - height as i32));
}

#[tauri::command]
fn close_companion(app: AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(COMPANION) {
        let _ = w.close();
    }
}

/// Brings the main window up (from the companion window), e.g. to show a score.
#[tauri::command]
fn show_main(app: AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// A play's replay (its frames), from lazer's files.
#[tauri::command]
async fn live_replay(app: AppHandle, id: String) -> Result<replay::Replay> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app
            .state::<AppState>()
            .storage()
            .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
        let missing = || Error::known("replay-missing", "The replay file isn't in lazer's files any more.");
        let path = paths::lazer_file(&storage, &id).ok_or_else(missing)?;
        replay::parse(&std::fs::read(path).map_err(|_| missing())?)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Validates a folder the user picked; `None` if it isn't a lazer data folder.
#[tauri::command]
fn inspect_lazer_path(path: String) -> Option<LazerInstall> {
    paths::inspect_lazer(&PathBuf::from(path))
}

/// Validates a folder the user picked; `None` if it isn't osu!stable's (no osu!.db or Songs).
#[tauri::command]
fn inspect_stable_path(path: String) -> Option<StableInstall> {
    paths::inspect_stable(&PathBuf::from(path))
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
    stable: StableStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StableStatus {
    /// found (and wanted)
    install: Option<StableInstall>,
    default_path: Option<String>,
    enabled: bool,
    scanned_at: Option<i64>,
    counts: Option<Value>,
}

#[tauri::command]
fn library_status(state: State<'_, AppState>) -> Result<LibraryStatus> {
    let install = state.install();
    let stable_install = state.stable_install();
    let conn = state.db();
    let lazer_scanned: Option<i64> = db::get_meta(&conn, "lazer.lastScan")?.and_then(|v| v.parse().ok());
    let stable_scanned: Option<i64> = db::get_meta(&conn, "stable.lastScan")?.and_then(|v| v.parse().ok());
    let scanned_at = lazer_scanned.max(stable_scanned);
    let stable_counts: Option<Value> = db::get_meta(&conn, "stable.counts")?.and_then(|v| serde_json::from_str(&v).ok());
    // the library's counts: lazer's, with stable's sets, difficulties and collections added
    let mut counts: Option<Value> = db::get_meta(&conn, "lazer.counts")?.and_then(|v| serde_json::from_str(&v).ok());
    if let Some(sc) = &stable_counts {
        let c = counts.get_or_insert_with(|| serde_json::json!({ "sets": 0, "maps": 0, "scores": 0, "collections": 0 }));
        for k in ["sets", "maps", "collections"] {
            c[k] = (c[k].as_u64().unwrap_or(0) + sc[k].as_u64().unwrap_or(0)).into();
        }
    }
    let stable_changed = match &stable_install {
        Some(s) => !stable::is_current(&conn, s)?,
        // switched off or gone: its sets go on the next import
        None => stable_scanned.is_some(),
    };
    let changed = scanned_at.is_some() && stable_changed || match (&install, lazer_scanned) {
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
                // …and every file of the sets (library care)
                || db::get_meta(&conn, "lazer.setFiles")?.is_none()
                // …and the song and background each difficulty names (library care)
                || db::get_meta(&conn, "lazer.mapFiles")?.is_none()
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
        stable: StableStatus {
            install: stable_install,
            default_path: paths::default_stable_dir().map(|p| p.to_string_lossy().into_owned()),
            enabled: state.settings().use_stable,
            scanned_at: stable_scanned,
            counts: stable_counts,
        },
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    stage: String,
    done: u64,
    total: u64,
}

#[derive(Clone, Serialize)]
struct CareProgress {
    done: u64,
    total: u64,
}

/// What every set takes on disk (library care). Emits `care-progress` while it measures files it
/// hasn't seen before.
#[tauri::command]
async fn library_care(app: AppHandle) -> Result<care::CareReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let lazer = state.install().map(|i| PathBuf::from(i.storage));
        let songs = state.stable_install().map(|s| PathBuf::from(s.songs));
        care::report(&state.db, lazer.as_deref(), songs.as_deref(), |done, total| {
            let _ = app.emit("care-progress", CareProgress { done, total });
        })
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Imports lazer's library (sidecar export → SQLite) and stable's (osu!.db + Songs). Emits
/// `scan-progress` along the way and `library-changed` when the new data is committed.
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
    let install = state.install();
    let stable_install = state.stable_install();
    if install.is_none() && stable_install.is_none() {
        return Err(Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."));
    }

    let mut counts = ImportCounts::default();
    if let Some(install) = &install {
        std::fs::create_dir_all(&state.cache_dir)?;
        let out = state.cache_dir.join("lazer-export.json");
        lazer::run_export(&PathBuf::from(&install.storage), &out, |stage, done, total| emit(stage, done, total))?;
        emit("import", 0, 1);
        counts = {
            let mut conn = state.db();
            lazer::import(&mut conn, &out, install)?
        };
        let _ = std::fs::remove_file(&out);
    }
    match &stable_install {
        Some(st) => {
            // osu!.db unchanged: stable's part of the library is still right
            let current = stable::is_current(&state.db(), st)?;
            let c = if current {
                stable::last_counts(&state.db())?
            } else {
                emit("stable", 0, 1);
                stable::import(&mut state.db(), st, |done, total| emit("stable", done, total))?
            };
            counts.sets += c.sets;
            counts.maps += c.maps;
            counts.collections += c.collections;
        }
        None => stable::clear(&mut state.db())?,
    }
    state.reload_stable_files();
    state.refresh_storage();
    watch_plays(app);
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
    let files = state.files();
    if files.is_empty() {
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
        let rows = charts::analyse_batch(&files, chunk);
        charts::store(&mut state.db(), &rows)?;
        done += chunk.len() as u64;
        emit(done);
    }
    Ok(true)
}

/// A difficulty's `.osu` hash.
fn chart_hash(app: &AppHandle, id: &str) -> Result<String> {
    let hash: Option<String> = app
        .state::<AppState>()
        .db()
        .query_row("SELECT hash FROM maps WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
    hash.ok_or_else(|| Error::known("chart-missing", "This difficulty isn't in the library anymore."))
}

/// A difficulty's chart, read from lazer's files or stable's.
fn load_chart(app: &AppHandle, id: &str) -> Result<chart::Chart> {
    load_chart_with(app, id, mods::Mods::NONE)
}

/// A difficulty's chart with the mods that change it (Easy, Hard Rock, Mirror).
fn load_chart_with(app: &AppHandle, id: &str, mods: mods::Mods) -> Result<chart::Chart> {
    let hash = chart_hash(app, id)?;
    charts::load_with(&app.state::<AppState>().files(), &hash, mods)
}


/// One difficulty's notes, timing and full analysis as raw JSON (see `charts.rs`), with the mods
/// that change the chart itself (the playfield draws the others).
#[tauri::command]
async fn get_chart(app: AppHandle, id: String, mods: Option<mods::Mods>) -> Result<tauri::ipc::Response> {
    let mods = mods.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || charts::chart_json(&load_chart_with(&app, &id, mods)?, mods).map(tauri::ipc::Response::new))
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

/// pp for a library difficulty at some mods and a rate: a perfect play and each play asked about
/// (see `pp.rs`).
#[tauri::command]
async fn get_pp(app: AppHandle, id: String, mods: Vec<String>, rate: f64, plays: Vec<pp::Hits>) -> Result<pp::Sheet> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // "o<osu!'s id>": a pool's difficulty that isn't in the library, its chart in the cache
        if let Some(beatmap) = id.strip_prefix('o').and_then(|b| b.parse::<i64>().ok()) {
            let md5 = pools::online_md5(&state.db(), beatmap)?;
            let (text, md5) = pools::online_chart(&state.cache_dir.join("pool-charts"), beatmap, md5.as_deref())?;
            return pp::sheet_with(|| Ok(text.into_bytes()), &md5, &mods, rate, &plays);
        }
        let hash = chart_hash(&app, &id)?;
        pp::sheet(&state.files(), &hash, &mods, rate, &plays)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// An osu!mania difficulty's hitsounds, with its set's custom samples and storyboard samples
/// (see `hitsounds.rs`). Empty for other modes.
#[tauri::command]
async fn get_hitsounds(app: AppHandle, id: String) -> Result<hitsounds::Sounds> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let files = state.files();
        let conn = state.db();
        hitsounds::for_map(&conn, &files, &id)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// The lazer scores on a library difficulty that come with a replay, best first.
#[tauri::command]
async fn replays_for_map(app: AppHandle, id: String) -> Result<Vec<replay::ReplayEntry>> {
    tauri::async_runtime::spawn_blocking(move || replay::list(&app.state::<AppState>().db(), &id))
        .await
        .map_err(|e| Error::known("internal", e.to_string()))?
}

/// A lazer score's replay: its frames, read from lazer's files.
#[tauri::command]
async fn get_replay(app: AppHandle, id: String) -> Result<replay::Replay> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let storage = state
            .storage()
            .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
        let conn = state.db();
        replay::load(&conn, &storage, &id)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// The player's scores on osu! for a library difficulty (asked for by the player).
#[tauri::command]
async fn online_replays_for_map(app: AppHandle, id: String) -> Result<Vec<replay::OnlineEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        replay::online_list(|| state.db(), &state.data_dir, &osu_auth::Endpoints::default(), &id)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// A score's replay from osu!, downloaded once and kept.
#[tauri::command]
async fn get_online_replay(app: AppHandle, id: i64) -> Result<replay::Replay> {
    tauri::async_runtime::spawn_blocking(move || replay::online_load(&app.state::<AppState>().data_dir, &osu_auth::Endpoints::default(), id))
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
        let files = state.files();
        let conn = state.db();
        osu_scores::history_json(&conn, account.as_ref(), Some(&files)).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Puts every collection of the library into the cloud, under the osu! login.
#[tauri::command]
async fn cloud_push_collections(app: AppHandle) -> Result<cloud::PushSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let cols = cloud::gather(&state.db())?;
        cloud::push(&state.data_dir, &osu_auth::Endpoints::default(), cols)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Merges the collections saved in the cloud into this library; says which sets they want that
/// it doesn't have.
#[tauri::command]
async fn cloud_pull_collections(app: AppHandle) -> Result<cloud::PullSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let saved = cloud::fetch(&state.data_dir, &osu_auth::Endpoints::default())?;
        let mut conn = state.db();
        let summary = cloud::apply(&mut conn, &saved);
        summary
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

// ── pools ────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_pools(state: State<AppState>) -> Result<Vec<pools::Pool>> {
    pools::list(&state.db())
}

#[tauri::command]
fn create_pool(state: State<AppState>, name: String, mode: i64, keys: Option<i64>, categories: Vec<pools::Category>) -> Result<String> {
    pools::create(&state.db(), &name, mode, keys, &categories)
}

#[tauri::command]
fn update_pool(state: State<AppState>, id: String, patch: pools::PoolPatch) -> Result<()> {
    pools::update(&mut state.db(), &id, &patch)
}

#[tauri::command]
fn delete_pool(state: State<AppState>, id: String) -> Result<()> {
    pools::delete(&state.db(), &id)
}

#[tauri::command]
fn set_pool_slot(state: State<AppState>, id: String, slot: String, map: String) -> Result<()> {
    pools::set_slot(&mut state.db(), &id, &slot, &map)
}

/// Puts osu!'s difficulty (a link to it, or its number) into a slot: the library's when it has
/// it, else its chart from the mirrors.
#[tauri::command]
async fn set_pool_slot_online(app: AppHandle, id: String, slot: String, link: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let beatmap = pools::beatmap_of(&link).ok_or_else(|| Error::known("bad-link", "That isn't a link to a difficulty on osu!, or its number."))?;
        pools::known_slot(&state.db(), &id, &slot)?;
        let own: Option<String> = state.db().query_row("SELECT id FROM maps WHERE online_id = ?1 LIMIT 1", [beatmap], |r| r.get(0)).optional()?;
        if let Some(map) = own {
            return pools::set_slot(&mut state.db(), &id, &slot, &map);
        }
        let (text, _) = pools::online_chart(&state.cache_dir.join("pool-charts"), beatmap, None)?;
        let (md5, online) = pools::describe(beatmap, &text)?;
        let done = pools::set_online(&mut state.db(), &id, &slot, &md5, &online);
        done
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

// ── matches ──────────────────────────────────────────────────────────────

#[tauri::command]
fn get_matches(state: State<AppState>) -> Result<Vec<matches::Match>> {
    matches::list(&state.db())
}

#[tauri::command]
fn create_match(state: State<AppState>, pool: String, patch: matches::MatchPatch) -> Result<String> {
    matches::create(&state.db(), &pool, &patch)
}

#[tauri::command]
fn update_match(state: State<AppState>, id: String, patch: matches::MatchPatch) -> Result<()> {
    matches::update(&state.db(), &id, &patch)
}

#[tauri::command]
fn delete_match(state: State<AppState>, id: String) -> Result<()> {
    matches::delete(&state.db(), &id)
}

/// Sets a match's multiplayer room from a link to it (or its number; "" takes it away).
#[tauri::command]
fn set_match_room(state: State<AppState>, id: String, link: String) -> Result<()> {
    let mp = if link.trim().is_empty() {
        0
    } else {
        matches::mp_of(&link).ok_or_else(|| Error::known("bad-room", "That isn't a link to a multiplayer room on osu!, or its number."))?
    };
    matches::update(&state.db(), &id, &matches::MatchPatch { mp_id: Some(mp), ..Default::default() })
}

/// Asks osu! for a match's room (its games and scores so far) and keeps the answer.
#[tauri::command]
async fn refresh_match(app: AppHandle, id: String) -> Result<matches::Match> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let m = matches::get(&state.db(), &id)?;
        let mp = m.mp_id.ok_or_else(|| Error::known("no-room", "This match has no multiplayer room yet."))?;
        let ep = osu_auth::Endpoints::default();
        let room = osu_auth::with_token(&state.data_dir, &ep, |token| matches::fetch(&ep, token, mp))?;
        let conn = state.db();
        matches::store_result(&conn, &id, &room)?;
        matches::get(&conn, &id)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

// ── the stream overlay ───────────────────────────────────────────────────

/// Switches the OBS overlay on (overlay.rs); its port.
#[tauri::command]
fn overlay_start(app: AppHandle) -> Result<u16> {
    let handle = app.clone();
    overlay::start(Box::new(move |hash| {
        let state = handle.state::<AppState>();
        let source = state.files().path(hash).filter(|p| p.is_file())?;
        thumbs::get_or_create(&state.thumbs_dir(), &source, hash, 640).ok()
    }))
}

#[tauri::command]
fn overlay_stop() {
    overlay::stop()
}

#[tauri::command]
fn overlay_port() -> Option<u16> {
    overlay::port()
}

/// What the overlay shows now, and the map backgrounds it may hand out.
#[tauri::command]
fn overlay_state(state: serde_json::Value, art: Vec<String>) -> Result<()> {
    overlay::set_state(&state, art)
}

#[tauri::command]
fn clear_pool_slot(state: State<AppState>, id: String, slot: String) -> Result<()> {
    pools::clear_slot(&state.db(), &id, &slot)
}

#[tauri::command]
fn swap_pool_slots(state: State<AppState>, id: String, a: String, b: String) -> Result<()> {
    pools::swap_slots(&mut state.db(), &id, &a, &b)
}

#[tauri::command]
fn set_pool_slot_note(state: State<AppState>, id: String, slot: String, note: String) -> Result<()> {
    pools::set_slot_note(&state.db(), &id, &slot, &note)
}

#[derive(Serialize)]
struct LazerCollectionsPut {
    created: usize,
    updated: usize,
}

/// Puts Fumen collections into lazer's (when that's safe, see `lazer_import.rs`), then updates
/// Fumen's library so lazer's collections show them.
#[tauri::command]
async fn put_collections_into_lazer(app: AppHandle, picks: Vec<collections::Pick>) -> Result<LazerCollectionsPut> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.scanning.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "The library is being updated; try again in a moment."));
        }
        let result = (|| {
            let storage = state
                .storage()
                .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
            let cols = collections::outgoing(&state.db(), &picks)?;
            let compat = state.compat();
            let done = lazer_import::put_collections(&storage, &state.cache_dir, &state.data_dir.join("lazer-backups"), &cols, &compat)?;
            {
                let conn = state.db();
                for d in &done {
                    collections::set_lazer_id(&conn, &d.key, &d.id)?;
                }
            }
            if let Err(e) = run_scan(&app, &state) {
                eprintln!("[collections] library update after writing lazer's collections: {e}");
            }
            let created = done.iter().filter(|d| d.created).count();
            Ok(LazerCollectionsPut { created, updated: done.len() - created })
        })();
        state.scanning.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

#[derive(Serialize)]
struct LazerSetsDeleted {
    deleted: usize,
    /// already deleted, gone, or one of lazer's own
    skipped: usize,
}

/// Deletes lazer sets the way lazer's own Delete does (when that's safe, see `lazer_import.rs`),
/// then updates Fumen's library without them. osu!stable's sets are never touched.
#[tauri::command]
async fn delete_sets_in_lazer(app: AppHandle, ids: Vec<String>) -> Result<LazerSetsDeleted> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.scanning.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "The library is being updated; try again in a moment."));
        }
        let result = (|| {
            let storage = state
                .storage()
                .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
            // only lazer's sets, as Fumen knows them
            let ids: Vec<String> = {
                let conn = state.db();
                let mut q = conn.prepare("SELECT 1 FROM sets WHERE id = ?1 AND source = 'lazer'")?;
                ids.into_iter().filter(|id| q.exists([id]).unwrap_or(false)).collect()
            };
            if ids.is_empty() {
                return Ok(LazerSetsDeleted { deleted: 0, skipped: 0 });
            }
            let compat = state.compat();
            let done = lazer_import::delete_sets(&storage, &state.cache_dir, &state.data_dir.join("lazer-backups"), &ids, &compat)?;
            if let Err(e) = run_scan(&app, &state) {
                eprintln!("[delete] library update after deleting in lazer: {e}");
            }
            let deleted = done.iter().filter(|d| d.done).count();
            Ok(LazerSetsDeleted { deleted, skipped: done.len() - deleted })
        })();
        state.scanning.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Writes the picked collections as a stable `collection.db` where the user picks in the save
/// dialog, opened from here: the page never names a path to write to. None: the dialog was
/// cancelled. `title` and `filter` are the dialog's words in the app's language.
/// The start ping (`ping.rs`), once per start and only while Settings allow it. The window asks
/// for it after the one-time notice about it, so nothing is sent before the player knew.
#[tauri::command]
fn send_ping(state: State<AppState>) {
    static SENT: AtomicBool = AtomicBool::new(false);
    if state.settings.lock().unwrap_or_else(|e| e.into_inner()).start_ping && !SENT.swap(true, Ordering::SeqCst) {
        ping::start(state.data_dir.clone(), osu_auth::Endpoints::default().site);
    }
}

#[tauri::command]
async fn save_collection_db(app: AppHandle, title: String, filter: String, picks: Vec<collections::Pick>) -> Result<Option<usize>> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().set_title(&title).set_file_name("collection.db").add_filter(&filter, &["db"]).blocking_save_file();
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
        // a stable collection file, nothing else
        let path = if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("db")) { path } else { path.with_extension("db") };
        let state = app.state::<AppState>();
        let cols = collections::outgoing(&state.db(), &picks)?;
        collections::save_collection_db(&path, &cols)?;
        Ok(Some(cols.len()))
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// "%E2%98%85" → "★" (what a header carries of a name).
fn uri_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// the most a window may save at once
const SAVE_MAX: usize = 32 * 1024 * 1024;

/// Saves what the window made (a pool as CSV or JSON, a showcase image) where the player picks in
/// the system's save dialog: only there, and only as the kind it says. The bytes are the
/// request's body; its headers (URI-encoded) say the rest: x-fumen-kind (csv, json, png),
/// x-fumen-name (the file name offered), x-fumen-title and x-fumen-filter (the dialog's words).
/// Returns the file's name, None when cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err(Error::known("bad-file", "There's nothing to save.")) };
    if bytes.is_empty() || bytes.len() > SAVE_MAX {
        return Err(Error::known("bad-file", "There's nothing to save."));
    }
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(uri_decode).unwrap_or_default();
    let ext: &'static str = match header("x-fumen-kind").as_str() {
        "csv" => "csv",
        "json" => "json",
        "png" => "png",
        _ => return Err(Error::known("bad-file", "There's nothing to save.")),
    };
    // a name, not a path
    let name: String = header("x-fumen-name").chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()).take(120).collect();
    let (title, filter, bytes) = (header("x-fumen-title"), header("x-fumen-filter"), bytes.clone());
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let picked = app.dialog().file().set_title(&title).set_file_name(&name).add_filter(&filter, &[ext]).blocking_save_file();
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
        let path = if path.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)) { path } else { path.with_extension(ext) };
        std::fs::write(&path, &bytes)?;
        Ok(path.file_name().map(|n| n.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
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
        let mut status = lazer_import::status(state.storage().as_deref(), &compat);
        status.unfinished = unfinished_sets(&state.db())?;
        Ok(status)
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// lazer sets in the library that lazer's importer left without details (no star rating, or
/// objects but no length and BPM): the ones an older Fumen imported. The importer decides for
/// itself which to finish; this is for showing.
fn unfinished_sets(conn: &rusqlite::Connection) -> Result<usize> {
    Ok(conn.query_row(
        "SELECT COUNT(DISTINCT s.id) FROM sets s JOIN maps m ON m.set_id = s.id
         WHERE s.source = 'lazer' AND (m.sr < 0 OR (m.length = 0 AND m.bpm = 0 AND m.objects > 0))",
        [],
        |r| r.get::<_, i64>(0),
    )? as usize)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepairSummary {
    finished: usize,
    failed: usize,
}

/// Finishes the sets an older Fumen imported into lazer without their details (see
/// `lazer_import.rs`), then updates Fumen's library.
#[tauri::command]
async fn repair_lazer_sets(app: AppHandle) -> Result<RepairSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.scanning.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "The library is being updated; try again in a moment."));
        }
        let result = (|| {
            let storage = state
                .storage()
                .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
            let (finished, failed) = lazer_import::repair(&storage, &state.cache_dir, &state.data_dir.join("lazer-backups"), &state.compat())?;
            if finished > 0 {
                if let Err(e) = run_scan(&app, &state) {
                    eprintln!("[repair] library update: {e}");
                }
            }
            Ok(RepairSummary { finished, failed })
        })();
        state.scanning.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    /// which of the pasted lines
    index: usize,
    /// resolving | downloading | held (the mirrors are busy or resting after a rate limit; `total`:
    /// seconds to go, about) | ready (downloaded, waiting for lazer) | importing | done | skipped |
    /// error
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
    /// sets left out because the import was cancelled or stopped
    cancelled: usize,
    /// why the import stopped before the end (lazer was opened, …)
    stopped: Option<String>,
}

/// Sets per run of lazer's importer (each run: one backup of client.realm, one importer start).
const IMPORT_BATCH: usize = 20;
/// Downloads at once.
const DOWNLOADERS: usize = 3;
/// Downloaded sets waiting for the importer, at most (they take disk space).
const MAX_WAITING: usize = IMPORT_BATCH * 2;

/// Another player's osu!mania plays and the charts behind them, for comparing skills (see
/// `player.rs`), as raw JSON. Emits `compare-progress` along the way. A comparison already
/// running is stopped first.
#[tauri::command]
async fn compare_player(app: AppHandle, name: String) -> Result<tauri::ipc::Response> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // the one before gives way
        state.compare_cancel.store(true, Ordering::SeqCst);
        let started = std::time::Instant::now();
        while state.comparing.swap(true, Ordering::SeqCst) {
            if started.elapsed() > std::time::Duration::from_secs(10) {
                return Err(Error::known("busy", "Another comparison is still stopping; try again in a moment."));
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        state.compare_cancel.store(false, Ordering::SeqCst);
        let result = (|| {
            let ep = osu_auth::Endpoints::default();
            let emit = |p: player::Progress| {
                let _ = app.emit("compare-progress", p);
            };
            let fetched = osu_auth::with_token(&state.data_dir, &ep, |token| player::fetch(&ep, token, &name, &state.compare_cancel, emit))?;
            let conn = state.db();
            player::build(&conn, &state.files(), &state.cache_dir.join("osu-charts"), fetched, &state.compare_cancel, emit).map(tauri::ipc::Response::new)
        })();
        state.comparing.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Stops the running comparison.
#[tauri::command]
fn cancel_compare(state: State<'_, AppState>) {
    state.compare_cancel.store(true, Ordering::SeqCst);
}

/// Stops the running import after what's being imported right now.
#[tauri::command]
fn cancel_import(state: State<'_, AppState>) {
    state.import_cancel.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayedSetOut {
    #[serde(flatten)]
    set: osu_scores::PlayedSet,
    /// osu!stable has it (but lazer doesn't)
    in_stable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayedFound {
    /// sets played that osu!lazer doesn't have, most played first
    missing: Vec<PlayedSetOut>,
    /// sets played in all
    played: usize,
    /// play counts and top plays read from osu!
    read: usize,
}

/// Every set the player has played that isn't in osu!lazer: from osu!'s play counts and top
/// plays (every ruleset) and the scores synced for the Performance view. Emits
/// `played-progress` with the play counts and scores read so far.
#[tauri::command]
async fn find_played_sets(app: AppHandle) -> Result<PlayedFound> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let account = osu_auth::account(&state.data_dir).ok_or_else(|| Error::known("osu-logged-out", "Log in to osu! in Settings first."))?;
        let ep = osu_auth::Endpoints::default();
        let mut all = osu_scores::PlayedSets::default();
        let mut read = 0;
        osu_auth::with_token(&state.data_dir, &ep, |token| {
            osu_scores::played_sets(&ep, token, account.id, &mut all, |n| {
                read = n;
                let _ = app.emit("played-progress", n);
            })
        })?;
        let conn = state.db();
        osu_scores::synced_sets(&conn, account.id as i64, &mut all)?;
        let sets = all.into_sorted();
        let mut have = conn.prepare("SELECT source FROM sets WHERE online_id = ?1")?;
        let played = sets.len();
        let mut missing = Vec::new();
        for set in sets {
            let sources: Vec<String> = have.query_map([set.id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            if sources.iter().any(|s| s == "lazer") {
                continue;
            }
            missing.push(PlayedSetOut { in_stable: !sources.is_empty(), set });
        }
        Ok(PlayedFound { missing, played, read })
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

/// One page of a beatmap search on the mirrors (see `mirror_search.rs`; never osu!'s servers).
#[tauri::command]
async fn search_mirrors(query: mirror_search::Query) -> Result<mirror_search::Page> {
    tauri::async_runtime::spawn_blocking(move || mirror_search::search(&mirror_search::Endpoints::default(), &query))
        .await
        .map_err(|e| Error::known("internal", e.to_string()))?
}

/// Downloads the sets behind pasted osu! links and imports them into lazer (see
/// `lazer_import.rs` for when that's allowed), then updates Fumen's library. With `target`
/// "stable" they go into osu!stable's Songs folder instead (`stable_import.rs`, only while that's
/// turned on). Emits `import-progress` per line along the way.
#[tauri::command]
async fn import_beatmaps(app: AppHandle, links: Vec<String>, target: Option<String>) -> Result<ImportSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        if state.scanning.swap(true, Ordering::SeqCst) {
            return Err(Error::known("busy", "The library is being updated; try again in a moment."));
        }
        state.import_cancel.store(false, Ordering::SeqCst);
        let result = run_import(&app, &state, &links, target.as_deref() == Some("stable"));
        state.scanning.store(false, Ordering::SeqCst);
        result
    })
    .await
    .map_err(|e| Error::known("internal", e.to_string()))?
}

fn run_import(app: &AppHandle, state: &AppState, links: &[String], into_stable: bool) -> Result<ImportSummary> {
    let emit = |index: usize, stage: &'static str, set: Option<u32>, title: Option<String>, message: Option<String>| {
        let p = ImportProgress { index, stage, set, title, done: 0, total: 0, message };
        let _ = app.emit("import-progress", p);
    };
    let mut summary = ImportSummary::default();

    // into lazer (its data folder), or into stable (its Songs folder); nothing gets downloaded for
    // an import that couldn't happen anyway
    let compat = state.compat();
    let (storage, songs) = if into_stable {
        if !state.settings().stable_import {
            return Err(Error::known("stable-import-off", "Importing into osu!stable is turned off (Settings › osu!stable)."));
        }
        let install = state
            .stable_install()
            .ok_or_else(|| Error::known("stable-not-found", "osu!stable wasn't found. Pick its folder in Settings."))?;
        (PathBuf::new(), Some(PathBuf::from(install.songs)))
    } else {
        let storage = state
            .storage()
            .ok_or_else(|| Error::known("lazer-not-found", "osu!lazer's data folder wasn't found. Pick it in Settings."))?;
        let st = lazer_import::status(Some(&storage), &compat);
        if let Some(reason) = st.reason {
            return Err(Error::known(lazer_import::error_code(reason), st.message.unwrap_or_default()));
        }
        (storage, None)
    };
    let source = if into_stable { "stable" } else { "lazer" };

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
                "SELECT artist || ' - ' || title FROM sets WHERE online_id = ?1 AND source = ?2 LIMIT 1",
                rusqlite::params![set, source],
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
        None if songs.as_deref().is_some_and(|songs| stable_import::waiting(songs, set)) => {
            emit(i, "skipped", Some(set), None, Some("Already waiting in osu!stable's Songs folder".into()));
            summary.skipped += 1;
            false
        }
        None => true,
    });

    // downloads (a few at once) and imports (a batch at a time) run side by side; downloads wait
    // while enough sets are waiting for lazer
    let dl_dir = state.cache_dir.join("downloads");
    let mirrors = downloads::Mirrors::default();
    let cancel = &state.import_cancel;
    let queue = Mutex::new(std::collections::VecDeque::from(sets.clone()));
    let waiting = std::sync::atomic::AtomicUsize::new(0);
    let (tx, rx) = std::sync::mpsc::channel::<(usize, u32, Result<PathBuf>)>();
    let mut imported: Vec<(usize, u32)> = Vec::new();
    std::thread::scope(|scope| {
        for _ in 0..DOWNLOADERS.min(sets.len()) {
            let tx = tx.clone();
            let (queue, waiting, dl_dir, mirrors) = (&queue, &waiting, &dl_dir, &mirrors);
            scope.spawn(move || loop {
                if cancel.load(Ordering::SeqCst) {
                    break;
                }
                if waiting.load(Ordering::SeqCst) >= MAX_WAITING {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
                let Some((i, set)) = queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() else { break };
                let mut last: Option<(std::time::Instant, &'static str, u64)> = None;
                let result = downloads::download_set(set, dl_dir, mirrors, |p| {
                    let (stage, done, total, end) = match p {
                        downloads::Progress::Bytes { done, total } => ("downloading", done, total.unwrap_or(0), Some(done) == total),
                        downloads::Progress::Waiting { until } => {
                            ("held", 0, until.saturating_duration_since(std::time::Instant::now()).as_secs(), false)
                        }
                    };
                    // bytes a few times a second; a wait when it starts and as its seconds tick
                    let due = match last {
                        None => true,
                        Some((at, s, t)) => {
                            s != stage || end || if stage == "held" { t != total } else { at.elapsed() >= std::time::Duration::from_millis(120) }
                        }
                    };
                    if due {
                        last = Some((std::time::Instant::now(), stage, total));
                        let p = ImportProgress { index: i, stage, set: Some(set), title: None, done, total, message: None };
                        let _ = app.emit("import-progress", p);
                    }
                    !cancel.load(Ordering::SeqCst)
                });
                match result {
                    Ok((path, _mirror)) => {
                        waiting.fetch_add(1, Ordering::SeqCst);
                        let _ = tx.send((i, set, Ok(path)));
                    }
                    Err(e) => {
                        let _ = tx.send((i, set, Err(e)));
                    }
                }
            });
        }
        drop(tx);

        let mut ready: Vec<(usize, u32, PathBuf)> = Vec::new();
        let mut downloading = true;
        let mut repaired = false;
        loop {
            match rx.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok((i, set, Ok(path))) => {
                    emit(i, "ready", Some(set), None, None);
                    ready.push((i, set, path));
                }
                Ok((i, set, Err(e))) if e.code() == "cancelled" => {
                    emit(i, "skipped", Some(set), None, Some("Cancelled".into()));
                    summary.cancelled += 1;
                }
                Ok((i, set, Err(e))) => {
                    emit(i, "error", Some(set), None, Some(e.to_string()));
                    summary.failed += 1;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => downloading = false,
            }
            if cancel.load(Ordering::SeqCst) {
                if !downloading {
                    break;
                }
                continue;
            }
            // into stable: each set into its Songs folder as soon as it's downloaded
            if let Some(songs) = &songs {
                for (i, set, path) in ready.drain(..) {
                    emit(i, "importing", Some(set), None, None);
                    match stable_import::put(&path, songs, set) {
                        Ok(()) => {
                            emit(i, "done", Some(set), None, None);
                            summary.imported += 1;
                        }
                        Err(e) => {
                            let _ = std::fs::remove_file(&path);
                            emit(i, "error", Some(set), None, Some(e.to_string()));
                            summary.failed += 1;
                        }
                    }
                    waiting.fetch_sub(1, Ordering::SeqCst);
                }
            }
            if ready.len() >= IMPORT_BATCH || (!downloading && !ready.is_empty()) {
                let batch: Vec<(usize, u32, PathBuf)> = ready.drain(..ready.len().min(IMPORT_BATCH)).collect();
                // into lazer, the batch at once (one backup, one start of the importer)
                for &(i, set, _) in &batch {
                    emit(i, "importing", Some(set), None, None);
                }
                let paths: Vec<PathBuf> = batch.iter().map(|(_, _, p)| p.clone()).collect();
                // the run's first batch also finishes sets an older Fumen imported without details
                let results = lazer_import::import(&storage, &state.cache_dir, &state.data_dir.join("lazer-backups"), &paths, !repaired, &compat);
                repaired = true;
                for p in &paths {
                    let _ = std::fs::remove_file(p);
                }
                waiting.fetch_sub(batch.len(), Ordering::SeqCst);
                match results {
                    Ok(results) => {
                        for (i, set, path) in &batch {
                            match results.iter().find(|r| r.file.file_name() == path.file_name()) {
                                Some(r) if r.ok && !r.sets.is_empty() => {
                                    emit(*i, "done", Some(*set), None, None);
                                    imported.push((*i, *set));
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
                    }
                    Err(e) => {
                        // lazer was opened, …: nothing more goes in
                        for &(i, set, _) in &batch {
                            emit(i, "error", Some(set), None, Some(e.to_string()));
                        }
                        summary.failed += batch.len();
                        summary.stopped = Some(e.to_string());
                        cancel.store(true, Ordering::SeqCst);
                    }
                }
            }
            if !downloading && ready.is_empty() {
                break;
            }
        }
        // downloaded but not imported (cancelled or stopped)
        for (i, set, path) in ready.drain(..) {
            let _ = std::fs::remove_file(&path);
            emit(i, "skipped", Some(set), None, Some("Cancelled".into()));
            summary.cancelled += 1;
        }
    });
    // never started
    for (i, set) in queue.into_inner().unwrap_or_else(|e| e.into_inner()) {
        emit(i, "skipped", Some(set), None, Some("Cancelled".into()));
        summary.cancelled += 1;
    }

    // Fumen's library catches up, then every set imported gets its title
    if !imported.is_empty() {
        if let Err(e) = run_scan(app, state) {
            eprintln!("[import] library update after import: {e}");
        }
        for (i, set) in imported {
            if let Some(title) = title_of(set) {
                emit(i, "done", Some(set), Some(title), None);
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
/// Fumen's own page: the bundled app (tauri://localhost, http(s)://tauri.localhost on Windows)
/// or the dev server on localhost.
fn own_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => matches!(url.host_str(), Some("localhost" | "tauri.localhost" | "127.0.0.1")),
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // the window only ever shows Fumen's own page: links out go to the browser (opener), and
        // anything that tried to navigate the window elsewhere is stopped
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard").on_navigation(|_, url| own_page(url)).build())
        .register_asynchronous_uri_scheme_protocol("fumen", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(protocol::handle(&app, &request)));
        })
        // the companion window goes with the main one
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                if let Some(w) = window.app_handle().get_webview_window(COMPANION) {
                    let _ = w.close();
                }
            }
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
                stable_files: RwLock::new(Default::default()),
                scanning: AtomicBool::new(false),
                analysing: AtomicBool::new(false),
                analyse_again: AtomicBool::new(false),
                logging_in: AtomicBool::new(false),
                login_cancel: AtomicBool::new(false),
                syncing: AtomicBool::new(false),
                import_cancel: AtomicBool::new(false),
                comparing: AtomicBool::new(false),
                compare_cancel: AtomicBool::new(false),
                map_synced: Mutex::new(std::collections::HashMap::new()),
                live: Mutex::new(None),
            };
            state.refresh_storage();
            state.reload_stable_files();
            app.manage(state);
            watch_plays(app.handle());
            // difficulties imported by an older version (or before a crash) still need analysing
            start_analysis(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            library_care,
            update_settings,
            inspect_lazer_path,
            inspect_stable_path,
            library_status,
            scan_library,
            get_library,
            get_chart,
            get_dan,
            get_pp,
            get_hitsounds,
            get_skins,
            get_skin_files,
            lazer_import_status,
            repair_lazer_sets,
            compare_player,
            cancel_compare,
            import_beatmaps,
            cancel_import,
            find_played_sets,
            search_mirrors,
            replays_for_map,
            get_replay,
            live_plays,
            live_play,
            live_replay,
            pool_choices,
            pool_rows,
            open_companion,
            close_companion,
            fit_companion,
            show_main,
            online_replays_for_map,
            get_online_replay,
            cloud_push_collections,
            cloud_pull_collections,
            osu_account,
            osu_login,
            osu_login_cancel,
            get_collections,
            get_pools,
            create_pool,
            update_pool,
            delete_pool,
            set_pool_slot,
            set_pool_slot_online,
            clear_pool_slot,
            swap_pool_slots,
            set_pool_slot_note,
            get_matches,
            create_match,
            update_match,
            delete_match,
            set_match_room,
            refresh_match,
            overlay_start,
            overlay_stop,
            overlay_port,
            overlay_state,
            create_collection,
            create_smart_collection,
            set_collection_query,
            put_collections_into_lazer,
            delete_sets_in_lazer,
            save_collection_db,
            save_file,
            send_ping,
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

#[cfg(test)]
mod tests {
    #[test]
    fn the_window_stays_on_fumen() {
        let ok = |u: &str| super::own_page(&tauri::Url::parse(u).unwrap());
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/"));
        assert!(ok("http://localhost:1430/"));
        assert!(!ok("https://evil.example/"));
        assert!(!ok("https://osu.ppy.sh/beatmapsets/1"));
        assert!(!ok("file:///C:/Windows/"));
        assert!(!ok("javascript:alert(1)"));
    }

    #[test]
    fn names_from_headers() {
        assert_eq!(super::uri_decode("RPRO%20Cup%20%E2%98%85.png"), "RPRO Cup ★.png");
        // what isn't an escape stays
        assert_eq!(super::uri_decode("100%"), "100%");
        assert_eq!(super::uri_decode("%zz%4"), "%zz%4");
    }
}
