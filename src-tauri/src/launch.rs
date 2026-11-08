//! Starting osu! from Fumen (lazer or stable, the sidebar's Play button) and asking lazer to
//! close (importing and deleting need it closed). Closing is always lazer's own way out, as its
//! window's close button does it, never a kill: lazer writes its database on the way out.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

/// Starts a program on its own, detached from Fumen.
fn spawn(mut cmd: Command, what: &str) -> Result<()> {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS: no console, and it lives on without Fumen
        cmd.creation_flags(0x0000_0008);
    }
    cmd.spawn().map(drop).map_err(|e| Error::known("launch-failed", format!("{what} couldn't be started: {e}")))
}

/// Starts osu!lazer.
pub fn lazer() -> Result<()> {
    #[cfg(windows)]
    {
        // Velopack's stub in the install's root starts the current version (and updates)
        let root = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("osulazer");
        let exe = [root.join("osu!.exe"), root.join("current").join("osu!.exe")].into_iter().find(|p| p.is_file());
        let Some(exe) = exe else { return Err(Error::known("lazer-not-installed", "osu!lazer's installation wasn't found.")) };
        let mut cmd = Command::new(&exe);
        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }
        spawn(cmd, "osu!lazer")
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("/usr/bin/open");
        cmd.args(["-a", "osu!"]);
        spawn(cmd, "osu!lazer")
    }
    #[cfg(target_os = "linux")]
    {
        let Some(cmd) = crate::lazer_linux::launch_command() else {
            return Err(Error::known("lazer-not-installed", "osu!lazer wasn't found (no Flatpak, AppImage or package)."));
        };
        spawn(cmd, "osu!lazer")
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err(Error::known("lazer-not-installed", "osu!lazer can't be started from here."))
}

/// Starts osu!stable from its folder (Windows; elsewhere it runs under Wine and isn't started from
/// here).
pub fn stable(dir: &Path) -> Result<()> {
    let exe = dir.join("osu!.exe");
    if !exe.is_file() {
        return Err(Error::known("stable-not-found", "osu!stable's osu!.exe wasn't found in its folder."));
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new(&exe);
        cmd.current_dir(dir);
        spawn(cmd, "osu!stable")
    }
    #[cfg(not(windows))]
    {
        drop(exe);
        Err(Error::known("stable-not-found", "osu!stable can only be started from Fumen on Windows."))
    }
}

/// Asks a running osu!lazer to close; how many of its windows (or processes) were asked. It may
/// still ask something first (downloads running), so the caller watches whether it went.
pub fn close_lazer(install: &Path) -> usize {
    #[cfg(windows)]
    {
        windows_close(install)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = install;
        let ok = Command::new("/usr/bin/osascript").args(["-e", "tell application \"osu!\" to quit"]).status().is_ok_and(|s| s.success());
        usize::from(ok)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = install;
        crate::lazer_linux::close()
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = install;
        0
    }
}

/// lazer's processes: `osu!.exe` from lazer's install folder (stable's has the same name).
#[cfg(windows)]
fn lazer_pids(install: &Path) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    let lazer_root = install.parent().unwrap_or(install).to_string_lossy().to_lowercase();
    let mut pids = Vec::new();
    // SAFETY: plain Win32 calls on handles opened and closed here; buffers sized as documented
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return pids;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..len]).eq_ignore_ascii_case("osu!.exe") {
                let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                if !proc.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as u32;
                    if QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0
                        && String::from_utf16_lossy(&buf[..size as usize]).to_lowercase().starts_with(&lazer_root)
                    {
                        pids.push(entry.th32ProcessID);
                    }
                    CloseHandle(proc);
                }
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    pids
}

/// Posts WM_CLOSE to lazer's visible top-level windows: what its close button does.
#[cfg(windows)]
fn windows_close(install: &Path) -> usize {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE};

    struct Search {
        pids: Vec<u32>,
        asked: usize,
    }
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> i32 {
        // SAFETY: `data` is the &mut Search passed to EnumWindows below, alive for the whole call
        let search = unsafe { &mut *(data as *mut Search) };
        let mut pid = 0u32;
        // SAFETY: a window handle EnumWindows gave, and a u32 to write to
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        // SAFETY: as above
        if search.pids.contains(&pid) && unsafe { IsWindowVisible(hwnd) } != 0 && unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } != 0 {
            search.asked += 1;
        }
        1
    }

    let mut search = Search { pids: lazer_pids(install), asked: 0 };
    if search.pids.is_empty() {
        return 0;
    }
    // SAFETY: the callback only reads and writes `search`, which outlives the call
    unsafe { EnumWindows(Some(each), &mut search as *mut Search as LPARAM) };
    search.asked
}
