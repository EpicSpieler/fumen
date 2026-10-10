mod analysis;
mod chart;
mod charts;
mod db;
mod error;
mod lazer;
mod mma;
mod library;
mod paths;
mod protocol;
mod settings;
mod skins;
mod stars;
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
    /// lazer's resolved storage folder (holds client.realm + files/), for the protocol handler.
    storage: RwLock<Option<PathBuf>>,
    scanning: AtomicBool,
    analysing: AtomicBool,
    /// another analysis pass was requested while one was running
    analyse_again: AtomicBool,
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
                storage: RwLock::new(None),
                scanning: AtomicBool::new(false),
                analysing: AtomicBool::new(false),
                analyse_again: AtomicBool::new(false),
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
            get_skins,
            get_skin_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fumen");
}
