//! The start ping: once per start, Fumen tells fumen.dertesti.dev "a Fumen started", with a random
//! id made on this PC (so a person counts once, however often they start it) and its version.
//! Nothing else goes along, no answer is waited for, and a failure is silent. Settings can turn
//! it off; development builds never send it.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The random id, made on the first start: 32 hex digits, tied to nothing.
fn install_id(data_dir: &Path) -> Option<String> {
    let path = data_dir.join("install-id");
    if let Ok(id) = std::fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if is_id(&id) {
            return Some(id);
        }
    }
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(data_dir).ok()?;
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Sends the ping in the background (release builds only).
pub fn start(data_dir: PathBuf, site: String) {
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || {
        let Some(id) = install_id(&data_dir) else { return };
        let body = serde_json::json!({ "id": id, "version": env!("CARGO_PKG_VERSION") });
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .user_agent(crate::downloads::USER_AGENT)
            .timeout_global(Some(Duration::from_secs(10)))
            .build()
            .into();
        let _ = agent.post(&format!("{site}/api/ping")).header("Content-Type", "application/json").send(body.to_string());
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_is_made_once_and_kept() {
        let dir = std::env::temp_dir().join(format!("fumen-ping-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = install_id(&dir).unwrap();
        assert!(is_id(&a));
        assert_eq!(install_id(&dir).unwrap(), a);
        // a broken file gets a new one
        std::fs::write(dir.join("install-id"), "nope").unwrap();
        let b = install_id(&dir).unwrap();
        assert!(is_id(&b) && b != a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
