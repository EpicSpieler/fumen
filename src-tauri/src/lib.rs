mod db;
mod error;
mod lazer;
mod library;
mod paths;
mod protocol;
mod settings;
mod thumbs;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

use rusqlite::Connection;
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
}

impl AppState {
    fn storage(&self) -> Option<PathBuf> {
        self.storage.read().ok()?.clone()
    }

    fn thumbs_dir(&self) -> PathBuf {
        self.cache_dir.join("thumbs")
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
    emit("import", 1, 1);
    let _ = app.emit("library-changed", counts);
    Ok(counts)
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
            };
            state.refresh_storage();
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            inspect_lazer_path,
            library_status,
            scan_library,
            get_library,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fumen");
}
