use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::Result;

/// Persistent settings (`<config>/settings.json`). `ui` belongs to the frontend: Rust stores it
/// untouched so UI preferences can grow without backend changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// osu!lazer data folder override; `None` = auto-detect.
    pub lazer_path: Option<String>,
    /// Re-import automatically when lazer's database changed since the last scan.
    pub auto_rescan: bool,
    /// osu!stable folder override; `None` = auto-detect.
    pub stable_path: Option<String>,
    /// stable's beatmaps in the library too (when it's found).
    pub use_stable: bool,
    /// The start ping (ping.rs): counted among the people using Fumen.
    pub start_ping: bool,
    pub ui: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { lazer_path: None, auto_rescan: true, stable_path: None, use_stable: true, start_ping: true, ui: Map::new() }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Applies a partial update from the UI. `ui` is merged key by key, other fields replace.
    pub fn apply_patch(&mut self, patch: Value) -> Result<()> {
        let Value::Object(mut patch) = patch else { return Ok(()) };
        if let Some(Value::Object(ui)) = patch.remove("ui") {
            for (k, v) in ui {
                if v.is_null() {
                    self.ui.remove(&k);
                } else {
                    self.ui.insert(k, v);
                }
            }
        }
        let mut current = serde_json::to_value(&*self)?;
        if let Value::Object(cur) = &mut current {
            for (k, v) in patch {
                cur.insert(k, v);
            }
        }
        *self = serde_json::from_value(current)?;
        Ok(())
    }

    pub fn lazer_override(&self) -> Option<PathBuf> {
        self.lazer_path.as_deref().filter(|p| !p.trim().is_empty()).map(PathBuf::from)
    }

    pub fn stable_override(&self) -> Option<PathBuf> {
        self.stable_path.as_deref().filter(|p| !p.trim().is_empty()).map(PathBuf::from)
    }
}
