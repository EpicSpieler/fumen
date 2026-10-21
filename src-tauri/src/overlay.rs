//! The stream overlay: a page for OBS's browser source, served by Fumen while it's switched on at
//! http://127.0.0.1:<port>/ (the first free port from [`PORTS`]). It shows the match the window put
//! on stream — names, points, the map being played, bans and picks — from the state the window
//! sends ([`set_state`]); the page asks for it every second.
//!
//! Only this computer can reach it (127.0.0.1), and only pages that name it as their host (a site
//! can't get at it by pointing a name of its own at 127.0.0.1). It answers GET and HEAD for the
//! page, its fonts, the state, and the backgrounds of the maps on stream, nothing else.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use crate::error::{Error, Result};

pub const PORTS: std::ops::RangeInclusive<u16> = 24180..=24189;
/// the most state the window may send
const MAX_STATE: usize = 512 * 1024;

const PAGE: &str = include_str!("../overlay/overlay.html");
const FONT_LATIN: &[u8] = include_bytes!("../../public/fonts/instrument-sans-latin.woff2");
const FONT_LATIN_EXT: &[u8] = include_bytes!("../../public/fonts/instrument-sans-latin-ext.woff2");

/// A map background's thumbnail by the background's hash (none: not there).
pub type FindArt = dyn Fn(&str) -> Option<PathBuf> + Send + Sync;

struct Shared {
    port: u16,
    state: RwLock<String>,
    /// the backgrounds the state names, the only ones served
    art: RwLock<HashSet<String>>,
    find_art: Box<FindArt>,
    stop: AtomicBool,
}

static RUNNING: Mutex<Option<Arc<Shared>>> = Mutex::new(None);

/// The port it's on, when it's on.
pub fn port() -> Option<u16> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.port)
}

/// Switches the overlay on (on the first free port of [`PORTS`]); on already: its port.
pub fn start(find_art: Box<FindArt>) -> Result<u16> {
    start_on(PORTS, find_art)
}

fn start_on(ports: std::ops::RangeInclusive<u16>, find_art: Box<FindArt>) -> Result<u16> {
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = running.as_ref() {
        return Ok(s.port);
    }
    let listener = ports
        .clone()
        .find_map(|p| TcpListener::bind(("127.0.0.1", p)).ok())
        .ok_or_else(|| Error::known("overlay-port", "The overlay's ports (24180 to 24189) are all taken by other programs."))?;
    let port = listener.local_addr()?.port();
    listener.set_nonblocking(true)?;
    let shared = Arc::new(Shared {
        port,
        state: RwLock::new(r#"{"on":false}"#.into()),
        art: RwLock::new(HashSet::new()),
        find_art,
        stop: AtomicBool::new(false),
    });
    let s = shared.clone();
    std::thread::Builder::new().name("overlay".into()).spawn(move || serve(listener, s))?;
    *running = Some(shared);
    Ok(port)
}

pub fn stop() {
    if let Some(s) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).take() {
        s.stop.store(true, Ordering::SeqCst);
    }
}

/// What the overlay shows now (JSON from the window), and the backgrounds it names.
pub fn set_state(state: &serde_json::Value, art: Vec<String>) -> Result<()> {
    let text = serde_json::to_string(state).map_err(|e| Error::known("internal", e.to_string()))?;
    if text.len() > MAX_STATE {
        return Err(Error::known("overlay-state", "That's too much for the overlay."));
    }
    if let Some(s) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        *s.state.write().unwrap_or_else(|e| e.into_inner()) = text;
        *s.art.write().unwrap_or_else(|e| e.into_inner()) = art.into_iter().filter(|h| is_hash(h)).collect();
    }
    Ok(())
}

fn is_hash(h: &str) -> bool {
    (32..=64).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_hexdigit())
}

fn serve(listener: TcpListener, shared: Arc<Shared>) {
    while !shared.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let s = shared.clone();
                let _ = std::thread::Builder::new().name("overlay-request".into()).spawn(move || {
                    let _ = answer(stream, &s);
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn answer(mut stream: TcpStream, shared: &Shared) -> std::io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    // the request's head, at most 8 KB
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk)?;
        if n == 0 || buf.len() > 8192 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let host = lines.find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_ascii_lowercase()));
    let own = [format!("127.0.0.1:{}", shared.port), format!("localhost:{}", shared.port)];
    if !host.is_some_and(|h| own.contains(&h)) {
        return respond(&mut stream, "421 Misdirected Request", "text/plain", b"", false);
    }
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"", false);
    }
    let path = target.split('?').next().unwrap_or("");
    match path {
        "/" | "/index.html" => respond(&mut stream, "200 OK", "text/html; charset=utf-8", PAGE.as_bytes(), head_only),
        "/state" => {
            let state = shared.state.read().unwrap_or_else(|e| e.into_inner()).clone();
            respond(&mut stream, "200 OK", "application/json", state.as_bytes(), head_only)
        }
        "/fonts/instrument-sans-latin.woff2" => respond(&mut stream, "200 OK", "font/woff2", FONT_LATIN, head_only),
        "/fonts/instrument-sans-latin-ext.woff2" => respond(&mut stream, "200 OK", "font/woff2", FONT_LATIN_EXT, head_only),
        _ => {
            let Some(hash) = path.strip_prefix("/art/") else { return respond(&mut stream, "404 Not Found", "text/plain", b"", head_only) };
            let named = shared.art.read().unwrap_or_else(|e| e.into_inner()).contains(hash);
            match named.then(|| (shared.find_art)(hash)).flatten().and_then(|p| std::fs::read(p).ok()) {
                Some(bytes) => respond(&mut stream, "200 OK", "image/jpeg", &bytes, head_only),
                None => respond(&mut stream, "404 Not Found", "text/plain", b"", head_only),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(port: u16, method: &str, path: &str, host: &str) -> (String, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "{method} {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8_lossy(&out[..split]).lines().next().unwrap().to_string(), out[split + 4..].to_vec())
    }

    #[test]
    fn serves_only_what_is_on_stream() {
        let dir = std::env::temp_dir().join(format!("fumen-overlay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let art = dir.join("a.jpg");
        std::fs::write(&art, b"jpeg").unwrap();
        let found = art.clone();
        let port = start_on(24190..=24199, Box::new(move |_| Some(found.clone()))).unwrap();
        // on already: the same one
        assert_eq!(start_on(24190..=24199, Box::new(|_| None)).unwrap(), port);
        let host = format!("127.0.0.1:{port}");

        let (status, page) = ask(port, "GET", "/", &host);
        assert_eq!(status, "HTTP/1.1 200 OK");
        assert!(String::from_utf8_lossy(&page).contains("<html"));
        assert_eq!(ask(port, "GET", "/state", &host).1, br#"{"on":false}"#);

        let hash = "ab".repeat(16);
        set_state(&serde_json::json!({ "on": true, "red": { "name": "A" } }), vec![hash.clone(), "../../secret".into()]).unwrap();
        assert_eq!(ask(port, "GET", "/state?t=1", &format!("localhost:{port}")).1, br#"{"on":true,"red":{"name":"A"}}"#);
        assert_eq!(ask(port, "GET", &format!("/art/{hash}"), &host), ("HTTP/1.1 200 OK".into(), b"jpeg".to_vec()));
        // a background the state doesn't name, or no hash at all
        assert_eq!(ask(port, "GET", &format!("/art/{}", "cd".repeat(16)), &host).0, "HTTP/1.1 404 Not Found");
        assert_eq!(ask(port, "GET", "/art/../../secret", &host).0, "HTTP/1.1 404 Not Found");
        // another host name (a site pointed at 127.0.0.1), or anything but reading
        assert_eq!(ask(port, "GET", "/state", "evil.example").0, "HTTP/1.1 421 Misdirected Request");
        assert_eq!(ask(port, "POST", "/state", &host).0, "HTTP/1.1 405 Method Not Allowed");
        let (status, body) = ask(port, "HEAD", "/fonts/instrument-sans-latin.woff2", &host);
        assert_eq!((status.as_str(), body.len()), ("HTTP/1.1 200 OK", 0));

        stop();
        assert_eq!(super::port(), None);
        std::thread::sleep(Duration::from_millis(150));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err() || ask_fails(port));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A connection the stopped server never answers.
    fn ask_fails(port: u16) -> bool {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let _ = write!(s, "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n");
        let mut b = [0u8; 16];
        !matches!(s.read(&mut b), Ok(n) if n > 0)
    }
}
