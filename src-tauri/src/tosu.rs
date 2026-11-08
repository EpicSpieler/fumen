//! tosu (tosu.app): a separate app that reads osu! while it runs and tells what it sees on
//! ws://127.0.0.1:24050 (the frontend listens there, src/lib/tosu-follow.ts). Fumen only finds it,
//! remembers where it is and starts it when asked; it never reads the game itself.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TosuStatus {
    pub running: bool,
    /// where tosu is: the one picked or seen running, else a guess; None when it wasn't found
    pub path: Option<String>,
}

/// Only an app called tosu is ever started (`tosu.exe`, or `tosu` on Linux).
pub fn is_tosu(path: &Path) -> bool {
    let stem_ok = path.file_stem().is_some_and(|s| s.eq_ignore_ascii_case("tosu"));
    let ext_ok = match path.extension() {
        Some(e) => cfg!(windows) && e.eq_ignore_ascii_case("exe"),
        None => !cfg!(windows),
    };
    stem_ok && ext_ok && path.is_file()
}

/// The running tosu's program file, if it runs.
pub fn running() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        windows_running()
    }
    #[cfg(target_os = "linux")]
    {
        let procs = std::fs::read_dir("/proc").ok()?;
        procs
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
            .filter(|e| std::fs::read_to_string(e.path().join("comm")).is_ok_and(|c| c.trim() == "tosu"))
            .find_map(|e| std::fs::read_link(e.path().join("exe")).ok())
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        None
    }
}

#[cfg(windows)]
fn windows_running() -> Option<PathBuf> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    let mut found = None;
    // SAFETY: plain Win32 calls on handles opened and closed here; buffers sized as documented
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok && found.is_none() {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("tosu.exe") {
                let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !proc.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    if QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0 {
                        found = Some(PathBuf::from(String::from_utf16_lossy(&buf[..size as usize])));
                    }
                    CloseHandle(proc);
                }
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    found
}

/// Where people tend to leave tosu: unzipped into Downloads, on the desktop, in Documents, or in
/// a tosu folder of its own. The newest of those found.
pub fn guess() -> Option<PathBuf> {
    let home = dirs_home()?;
    let mut roots = vec![home.join("Downloads"), home.join("Desktop"), home.join("Documents"), home.join("tosu")];
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        roots.push(local.join("tosu"));
        roots.push(local.join("Programs").join("tosu"));
    }
    let name = if cfg!(windows) { "tosu.exe" } else { "tosu" };
    let mut found: Vec<PathBuf> = Vec::new();
    for root in roots {
        found.push(root.join(name));
        // one level down: "tosu-windows-v4.26.3/tosu.exe"
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
                found.push(e.path().join(name));
            }
        }
    }
    found
        .into_iter()
        .filter(|p| is_tosu(p))
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// Starts tosu on its own, in its folder (it keeps its settings there), without a console window.
pub fn start(path: &Path) -> Result<()> {
    if !is_tosu(path) {
        return Err(Error::known("tosu-not-found", "That isn't tosu."));
    }
    let mut cmd = Command::new(path);
    if let Some(dir) = path.parent() {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NO_WINDOW: no console, and it lives on without Fumen
        cmd.creation_flags(0x0000_0008 | 0x0800_0000);
    }
    cmd.spawn().map(drop).map_err(|e| Error::known("launch-failed", format!("tosu couldn't be started: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_tosu_is_tosu() {
        let dir = std::env::temp_dir().join(format!("fumen-tosu-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let name = if cfg!(windows) { "tosu.exe" } else { "tosu" };
        let other = if cfg!(windows) { "osu!.exe" } else { "osu" };
        std::fs::write(dir.join(name), b"x").unwrap();
        std::fs::write(dir.join(other), b"x").unwrap();
        assert!(is_tosu(&dir.join(name)));
        assert!(!is_tosu(&dir.join(other)));
        assert!(!is_tosu(&dir.join("missing").join(name)));
        assert!(start(&dir.join(other)).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
