//! Starting osu! from Fumen (lazer or stable, the sidebar's Play button, which turns into Close
//! while that osu! runs) and asking it to close (importing and deleting need lazer closed).
//! Closing is always the game's own way out, as its window's close button does it, never a kill:
//! lazer writes its database on the way out.

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

/// Which osu! is running right now.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct Running {
    pub lazer: bool,
    pub stable: bool,
}

/// Which osu! runs (`install`: lazer's install, to tell its `osu!.exe` from stable's). stable only
/// counts on Windows.
pub fn running(install: Option<&Path>) -> Running {
    #[cfg(windows)]
    {
        let (lazer, stable) = osu_pids(install);
        Running { lazer: !lazer.is_empty(), stable: !stable.is_empty() }
    }
    #[cfg(not(windows))]
    {
        Running { lazer: install.is_some_and(crate::lazer_import::lazer_running), stable: false }
    }
}

/// how often closing is asked for at most, and how long it waits for the game to go each time
const CLOSE_TRIES: usize = 4;
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_millis(900);

/// Asks a running osu! ("lazer" or "stable") to close, as often as it takes: lazer answers the
/// first request with "Are you sure?" (which a second one confirms), and from a screen deeper in it
/// first goes back. Asks again while it still runs, up to CLOSE_TRIES times; how many windows (or
/// processes) were asked in all, 0 when it wasn't running. The caller still watches whether it
/// went (its exit animation takes a moment).
pub fn close(client: &str, install: Option<&Path>) -> usize {
    let still = |r: Running| if client == "stable" { r.stable } else { r.lazer };
    let mut asked = 0;
    for _ in 0..CLOSE_TRIES {
        let n = close_once(client, install);
        if n == 0 {
            break;
        }
        asked += n;
        // gone within the wait: done; else ask again
        let mut waited = std::time::Duration::ZERO;
        while waited < CLOSE_WAIT {
            std::thread::sleep(std::time::Duration::from_millis(100));
            waited += std::time::Duration::from_millis(100);
            if !still(running(install)) {
                return asked;
            }
        }
    }
    asked
}

/// One request to close (what Alt+F4 or the window's close button does once).
fn close_once(client: &str, install: Option<&Path>) -> usize {
    #[cfg(windows)]
    {
        let (lazer, stable) = osu_pids(install);
        windows_close(if client == "stable" { stable } else { lazer })
    }
    #[cfg(target_os = "macos")]
    {
        let _ = install;
        if client == "stable" {
            return 0;
        }
        let ok = Command::new("/usr/bin/osascript").args(["-e", "tell application \"osu!\" to quit"]).status().is_ok_and(|s| s.success());
        usize::from(ok)
    }
    #[cfg(target_os = "linux")]
    {
        let _ = install;
        if client == "stable" {
            return 0;
        }
        crate::lazer_linux::close()
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (client, install);
        0
    }
}

/// The running `osu!.exe` processes, lazer's (from its install folder) and stable's (any other).
#[cfg(windows)]
fn osu_pids(install: Option<&Path>) -> (Vec<u32>, Vec<u32>) {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    let lazer_root = install.map(|i| i.parent().unwrap_or(i).to_string_lossy().to_lowercase());
    let (mut lazer, mut stable) = (Vec::new(), Vec::new());
    // SAFETY: plain Win32 calls on handles opened and closed here; buffers sized as documented
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return (lazer, stable);
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
                    if QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut size) != 0 {
                        let path = String::from_utf16_lossy(&buf[..size as usize]).to_lowercase();
                        if lazer_root.as_ref().is_some_and(|r| path.starts_with(r.as_str())) {
                            lazer.push(entry.th32ProcessID);
                        } else {
                            stable.push(entry.th32ProcessID);
                        }
                    }
                    CloseHandle(proc);
                }
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    (lazer, stable)
}

/// Posts WM_CLOSE to the processes' visible top-level windows: what their close button does.
#[cfg(windows)]
fn windows_close(pids: Vec<u32>) -> usize {
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

    let mut search = Search { pids, asked: 0 };
    if search.pids.is_empty() {
        return 0;
    }
    // SAFETY: the callback only reads and writes `search`, which outlives the call
    unsafe { EnumWindows(Some(each), &mut search as *mut Search as LPARAM) };
    search.asked
}
