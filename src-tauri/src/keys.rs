//! The stream's key overlay (docs/OBS.md): which of osu!'s keys are held, for the live overlay's
//! key part. tosu can't say for osu!mania (it knows osu!'s K1/K2/M1/M2 only), so Fumen reads the
//! keyboard itself, the way key overlays for streams do — and only as far as that needs:
//!
//! - switched on in Fumen's OBS settings (off by default), and only while the overlay server runs;
//! - only the keys lazer binds to play (osu!mania's columns, osu!taiko's drums, osu!catch's moves,
//!   osu!'s two keys; [`keymap`]); every other key is never looked at;
//! - only while osu! is the window in front (a key let go elsewhere still counts as let go);
//! - what's held goes to the overlay's pages on this computer as the `keys` part, nothing is kept.
//!
//! Keys are told apart by where they are on the keyboard (scan codes), as osu!framework does: a
//! binding to "Z" is the key left of X on any layout.

use std::collections::{BTreeMap, BTreeSet};

/// A key by where it is: its scan code, +0x100 for the extended ones (the arrows, the right Ctrl …).
pub type Code = u16;

/// osu!framework's InputKey (the numbers in lazer's key bindings) → the scan codes it can be.
/// Shift, Control and Alt without a side are both sides. Mouse buttons and the rest: none.
pub fn codes_of(input_key: i64) -> Vec<Code> {
    const EXT: Code = 0x100;
    let one = |c: Code| vec![c];
    match input_key {
        1 => vec![0x2A, 0x36],               // Shift
        3 => vec![0x1D, 0x1D | EXT],         // Control
        5 => vec![0x38, 0x38 | EXT],         // Alt
        7 => vec![0x5B | EXT, 0x5C | EXT],   // Super
        9 => one(0x5D | EXT),                // Menu
        10..=19 => one(0x3B + (input_key - 10) as Code), // F1–F10
        20 => one(0x57),                     // F11
        21 => one(0x58),                     // F12
        45 => one(0x48 | EXT),               // Up
        46 => one(0x50 | EXT),               // Down
        47 => one(0x4B | EXT),               // Left
        48 => one(0x4D | EXT),               // Right
        49 => one(0x1C),                     // Enter
        50 => one(0x01),                     // Escape
        51 => one(0x39),                     // Space
        52 => one(0x0F),                     // Tab
        53 => one(0x0E),                     // BackSpace
        54 => one(0x52 | EXT),               // Insert
        55 => one(0x53 | EXT),               // Delete
        56 => one(0x49 | EXT),               // PageUp
        57 => one(0x51 | EXT),               // PageDown
        58 => one(0x47 | EXT),               // Home
        59 => one(0x4F | EXT),               // End
        60 => one(0x3A),                     // CapsLock
        61 => one(0x46),                     // ScrollLock
        67 => one(0x52),                     // Keypad0
        68 => one(0x4F),                     // Keypad1
        69 => one(0x50),
        70 => one(0x51),
        71 => one(0x4B),
        72 => one(0x4C),
        73 => one(0x4D),
        74 => one(0x47),
        75 => one(0x48),
        76 => one(0x49),                     // Keypad9
        77 => one(0x35 | EXT),               // KeypadDivide
        78 => one(0x37),                     // KeypadMultiply
        79 => one(0x4A),                     // KeypadMinus
        80 => one(0x4E),                     // KeypadPlus
        81 => one(0x53),                     // KeypadPeriod
        82 => one(0x1C | EXT),               // KeypadEnter
        // A–Z, where they are on a US keyboard
        83..=108 => {
            const LETTERS: [Code; 26] = [
                0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, // A–M
                0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C, // N–Z
            ];
            one(LETTERS[(input_key - 83) as usize])
        }
        109 => one(0x0B),                    // Number0
        110..=118 => one(0x02 + (input_key - 110) as Code), // Number1–9
        119 => one(0x29),                    // Tilde
        120 => one(0x0C),                    // Minus
        121 => one(0x0D),                    // Plus
        122 => one(0x1A),                    // BracketLeft
        123 => one(0x1B),                    // BracketRight
        124 => one(0x27),                    // Semicolon
        125 => one(0x28),                    // Quote
        126 => one(0x33),                    // Comma
        127 => one(0x34),                    // Period
        128 => one(0x35),                    // Slash
        129 => one(0x2B),                    // BackSlash
        130 => one(0x56),                    // NonUSBackSlash
        263 => one(0x2A),                    // LShift
        264 => one(0x36),                    // RShift
        265 => one(0x1D),                    // LControl
        266 => one(0x1D | EXT),              // RControl
        267 => one(0x38),                    // LAlt
        268 => one(0x38 | EXT),              // RAlt
        269 => one(0x5B | EXT),              // LSuper
        270 => one(0x5C | EXT),              // RSuper
        _ => vec![],
    }
}

/// lazer's bindings as Fumen keeps them (`lazer.keyBindings`: "ruleset/variant" → per action the
/// InputKeys) → the same with scan codes; actions without a key on the keyboard stay empty.
pub fn keymap(bindings: &serde_json::Value) -> BTreeMap<String, Vec<Vec<Code>>> {
    let mut out = BTreeMap::new();
    let Some(map) = bindings.as_object() else { return out };
    for (variant, actions) in map {
        let Some(actions) = actions.as_array() else { continue };
        let list: Vec<Vec<Code>> = actions
            .iter()
            .map(|keys| {
                let mut codes: Vec<Code> = keys.as_array().into_iter().flatten().filter_map(|k| k.as_i64()).flat_map(codes_of).collect();
                codes.dedup();
                codes
            })
            .collect();
        out.insert(variant.clone(), list);
    }
    out
}

/// Every key some binding names: the only ones looked at.
pub fn watched(map: &BTreeMap<String, Vec<Vec<Code>>>) -> BTreeSet<Code> {
    map.values().flatten().flatten().copied().collect()
}

/// What a key is called on this computer's keyboard layout (the key left of X: "Z" on a US
/// keyboard, "Y" on a German one); empty when it can't be said.
#[cfg(windows)]
pub fn name_of(code: Code) -> String {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetKeyNameTextW;
    let lparam = (((code & 0xFF) as i32) << 16) | if code & 0x100 != 0 { 1 << 24 } else { 0 };
    let mut buf = [0u16; 64];
    let len = unsafe { GetKeyNameTextW(lparam, buf.as_mut_ptr(), buf.len() as i32) };
    if len <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..len as usize])
}
#[cfg(not(windows))]
pub fn name_of(_code: Code) -> String {
    String::new()
}

#[cfg(windows)]
pub use win::{start, stop};

#[cfg(not(windows))]
pub fn start(_keys: BTreeSet<Code>, _publish: impl Fn(&BTreeSet<Code>, &BTreeMap<Code, u64>) + Send + 'static) -> bool {
    false
}
#[cfg(not(windows))]
pub fn stop() {}

#[cfg(windows)]
mod win {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::mpsc;
    use std::sync::Mutex;

    use windows_sys::Win32::Foundation::{CloseHandle, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, MSG,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    use super::Code;

    struct Hooked {
        keys: BTreeSet<Code>,
        down: BTreeSet<Code>,
        count: BTreeMap<Code, u64>,
        /// the window in front's process, and whether it's osu!
        front: Option<(u32, bool)>,
        tell: mpsc::Sender<()>,
        thread: u32,
    }

    static HOOKED: Mutex<Option<Hooked>> = Mutex::new(None);

    /// Starts reading `keys` (a new set while running replaces the old one); `publish` hears what's
    /// held and how often each was pressed, after every change. False: it couldn't start.
    pub fn start(keys: BTreeSet<Code>, publish: impl Fn(&BTreeSet<Code>, &BTreeMap<Code, u64>) + Send + 'static) -> bool {
        {
            let mut hooked = HOOKED.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(h) = hooked.as_mut() {
                h.keys = keys;
                h.down.retain(|k| h.keys.contains(k));
                let _ = h.tell.send(());
                return true;
            }
        }
        let (tell, heard) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        let keys_for_hook = keys;
        let started = std::thread::Builder::new().name("keys".into()).spawn(move || unsafe {
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), GetModuleHandleW(std::ptr::null()), 0);
            if hook.is_null() {
                let _ = ready_tx.send(false);
                return;
            }
            *HOOKED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Hooked {
                keys: keys_for_hook,
                down: BTreeSet::new(),
                count: BTreeMap::new(),
                front: None,
                tell,
                thread: GetCurrentThreadId(),
            });
            let _ = ready_tx.send(true);
            // the hook is called on this thread while it waits for messages
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {}
            UnhookWindowsHookEx(hook);
            *HOOKED.lock().unwrap_or_else(|e| e.into_inner()) = None;
        });
        if started.is_err() || !ready_rx.recv().unwrap_or(false) {
            return false;
        }
        // what's held goes out from its own thread, so the hook returns at once
        let _ = std::thread::Builder::new().name("keys-out".into()).spawn(move || {
            while heard.recv().is_ok() {
                while heard.try_recv().is_ok() {}
                let snapshot = HOOKED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|h| (h.down.clone(), h.count.clone()));
                match snapshot {
                    Some((down, count)) => publish(&down, &count),
                    None => break,
                }
            }
        });
        true
    }

    pub fn stop() {
        let thread = HOOKED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|h| h.thread);
        if let Some(thread) = thread {
            unsafe { PostThreadMessageW(thread, WM_QUIT, 0, 0) };
        }
    }

    /// Whether the process is osu! (lazer's or stable's `osu!.exe`).
    fn is_osu(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) != 0;
            CloseHandle(process);
            ok && String::from_utf16_lossy(&buf[..len as usize]).rsplit(['\\', '/']).next().is_some_and(|n| n.eq_ignore_ascii_case("osu!.exe"))
        }
    }

    unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 && lparam != 0 {
            let info = &*(lparam as *const KBDLLHOOKSTRUCT);
            let key = (info.scanCode as Code & 0xFF) | if info.flags & LLKHF_EXTENDED != 0 { 0x100 } else { 0 };
            let msg = wparam as u32;
            let pressed = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let released = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if pressed || released {
                if let Ok(mut guard) = HOOKED.try_lock() {
                    if let Some(h) = guard.as_mut().filter(|h| h.keys.contains(&key)) {
                        let changed = if pressed {
                            // osu! in front? (asked once per window that comes to the front)
                            let mut pid = 0u32;
                            GetWindowThreadProcessId(GetForegroundWindow(), &mut pid);
                            let osu = match h.front {
                                Some((p, osu)) if p == pid => osu,
                                _ => {
                                    let osu = is_osu(pid);
                                    h.front = Some((pid, osu));
                                    osu
                                }
                            };
                            // held keys repeat: only the first press counts
                            osu && h.down.insert(key) && {
                                *h.count.entry(key).or_default() += 1;
                                true
                            }
                        } else {
                            h.down.remove(&key)
                        };
                        if changed {
                            let _ = h.tell.send(());
                        }
                    }
                }
            }
        }
        CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lazers_keys_by_place() {
        // D F J K, Space, the arrows
        assert_eq!(codes_of(86), vec![0x20]);
        assert_eq!(codes_of(88), vec![0x21]);
        assert_eq!(codes_of(92), vec![0x24]);
        assert_eq!(codes_of(93), vec![0x25]);
        assert_eq!(codes_of(51), vec![0x39]);
        assert_eq!(codes_of(47), vec![0x14B]);
        // Z is left of X wherever the layout puts its letter
        assert_eq!(codes_of(108), vec![0x2C]);
        assert_eq!(codes_of(1), vec![0x2A, 0x36]);
        // mouse buttons aren't keys
        assert!(codes_of(132).is_empty());
    }

    #[test]
    fn keymap_from_bindings() {
        let map = keymap(&json!({ "mania/4": [[86], [88], [92], [93]], "osu/0": [[108, 132], [106, 134]] }));
        assert_eq!(map["mania/4"], vec![vec![0x20], vec![0x21], vec![0x24], vec![0x25]]);
        assert_eq!(map["osu/0"], vec![vec![0x2C], vec![0x2D]]);
        let keys = watched(&map);
        assert!(keys.contains(&0x20) && keys.contains(&0x2D) && keys.len() == 6);
    }
}
