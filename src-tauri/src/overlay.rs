//! The stream overlay: pages for OBS's browser source, served by Fumen while it's switched on at
//! http://127.0.0.1:<port>/ (the first free port from [`PORTS`]).
//!
//! - `/` is the tournament overlay: the match the window put on stream — names, points, the map
//!   being played, bans and picks — from the state the window sends ([`set_state`]); the page asks
//!   for it every second.
//! - `/obs/<page>` are the OBS pages (docs/OBS.md): the visualizer, the live overlay, the song card
//!   and the session card. They're Fumen's own frontend (`obs.html`, from the app's files; a debug
//!   build sends them to Vite's dev server instead). What only Fumen knows comes to them as
//!   server-sent events from `/obs/events`, one event per part the window sends ([`set_obs`]).
//!   They may load the backgrounds and the songs those parts name, nothing else.
//!
//! Only this computer can reach it (127.0.0.1), and only pages that name it as their host (a site
//! can't get at it by pointing a name of its own at 127.0.0.1). It answers GET and HEAD, nothing else.

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;

use crate::error::{Error, Result};

pub const PORTS: std::ops::RangeInclusive<u16> = 24180..=24189;
/// the most state the window may send (the tournament's, or one part of the OBS pages')
const MAX_STATE: usize = 512 * 1024;
/// the OBS pages' parts: these names only
const PARTS: [&str; 8] = ["config", "map", "tries", "player", "session", "cue", "keymap", "keys"];
/// the OBS pages
const PAGES: [&str; 4] = ["stage", "hud", "card", "session"];
/// event streams open at once (each holds a thread)
const MAX_STREAMS: usize = 24;
/// a comment down an idle event stream this often, so a closed one is noticed
const KEEP_ALIVE: Duration = Duration::from_secs(15);

const PAGE: &str = include_str!("../overlay/overlay.html");
const FONT_LATIN: &[u8] = include_bytes!("../../public/fonts/instrument-sans-latin.woff2");
const FONT_LATIN_EXT: &[u8] = include_bytes!("../../public/fonts/instrument-sans-latin-ext.woff2");

/// A map background's thumbnail (hash, width; none: not there).
pub type FindArt = dyn Fn(&str, u32) -> Option<PathBuf> + Send + Sync;
/// A library file by its key (a song).
pub type FindFile = dyn Fn(&str) -> Option<PathBuf> + Send + Sync;
/// One of the app's own files (`obs.html`, `assets/…`): its bytes and type.
pub type FindAsset = dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync;

/// Where the server finds what it hands out.
pub struct Sources {
    pub art: Box<FindArt>,
    pub file: Box<FindFile>,
    pub asset: Box<FindAsset>,
    /// a debug build's dev server (`http://localhost:1430`): the OBS pages are sent there, and it
    /// may read from here
    pub dev: Option<String>,
}

/// One part of the OBS pages' state: its JSON, the backgrounds and songs it names, and a count
/// that goes up with every change.
#[derive(Default)]
struct Part {
    json: String,
    art: HashSet<String>,
    audio: HashSet<String>,
    version: u64,
}

struct Shared {
    port: u16,
    state: RwLock<String>,
    /// the backgrounds the tournament state names
    art: RwLock<HashSet<String>>,
    parts: Mutex<BTreeMap<String, Part>>,
    changed: Condvar,
    streams: AtomicUsize,
    src: Sources,
    stop: AtomicBool,
}

impl Shared {
    fn art_named(&self, hash: &str) -> bool {
        self.art.read().unwrap_or_else(|e| e.into_inner()).contains(hash)
            || self.parts.lock().unwrap_or_else(|e| e.into_inner()).values().any(|p| p.art.contains(hash))
    }

    fn audio_named(&self, key: &str) -> bool {
        self.parts.lock().unwrap_or_else(|e| e.into_inner()).values().any(|p| p.audio.contains(key))
    }
}

static RUNNING: Mutex<Option<Arc<Shared>>> = Mutex::new(None);

/// The port it's on, when it's on.
pub fn port() -> Option<u16> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.port)
}

/// Switches the overlay on (on the first free port of [`PORTS`]); on already: its port.
pub fn start(src: Sources) -> Result<u16> {
    start_on(PORTS, src)
}

fn start_on(ports: std::ops::RangeInclusive<u16>, src: Sources) -> Result<u16> {
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
        parts: Mutex::new(BTreeMap::new()),
        changed: Condvar::new(),
        streams: AtomicUsize::new(0),
        src,
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
        // the event streams end too
        let _parts = s.parts.lock().unwrap_or_else(|e| e.into_inner());
        s.changed.notify_all();
    }
}

/// What the tournament overlay shows now (JSON from the window), and the backgrounds it names.
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

/// One part of what the OBS pages show (one of [`PARTS`]), with the backgrounds and songs it may
/// hand out; the pages hear of it at once. The same JSON again changes nothing.
pub fn set_obs(part: &str, value: &serde_json::Value, art: Vec<String>, audio: Vec<String>) -> Result<()> {
    if !PARTS.contains(&part) {
        return Err(Error::known("overlay-state", "The overlay doesn't know that part."));
    }
    let json = serde_json::to_string(value).map_err(|e| Error::known("internal", e.to_string()))?;
    if json.len() > MAX_STATE {
        return Err(Error::known("overlay-state", "That's too much for the overlay."));
    }
    let Some(s) = RUNNING.lock().unwrap_or_else(|e| e.into_inner()).clone() else { return Ok(()) };
    let mut parts = s.parts.lock().unwrap_or_else(|e| e.into_inner());
    let next = parts.values().map(|p| p.version).max().unwrap_or(0) + 1;
    let p = parts.entry(part.to_string()).or_default();
    let art: HashSet<String> = art.into_iter().filter(|h| is_hash(h)).collect();
    let audio: HashSet<String> = audio.into_iter().filter(|h| is_hash(h)).collect();
    if p.json == json && p.art == art && p.audio == audio {
        return Ok(());
    }
    *p = Part { json, art, audio, version: next };
    s.changed.notify_all();
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

struct Reply<'a> {
    stream: &'a mut TcpStream,
    head_only: bool,
    /// the dev server's origin when the request came from it (it may read the answer)
    cors: Option<String>,
}

impl Reply<'_> {
    fn send(&mut self, status: &str, kind: &str, body: &[u8]) -> std::io::Result<()> {
        self.send_with(status, kind, body, "")
    }

    fn send_with(&mut self, status: &str, kind: &str, body: &[u8], extra: &str) -> std::io::Result<()> {
        let cors = self.cors.as_ref().map(|o| format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n")).unwrap_or_default();
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{cors}{extra}Connection: close\r\n\r\n",
            body.len()
        );
        self.stream.write_all(head.as_bytes())?;
        if !self.head_only {
            self.stream.write_all(body)?;
        }
        self.stream.flush()
    }
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
    let head = String::from_utf8_lossy(&buf).into_owned();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let header = |name: &str| {
        head.lines()
            .skip(1)
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
    };
    let host = header("host").map(|h| h.to_ascii_lowercase());
    let own = [format!("127.0.0.1:{}", shared.port), format!("localhost:{}", shared.port)];
    let cors = header("origin").filter(|o| shared.src.dev.as_deref().is_some_and(|d| d.trim_end_matches('/').eq_ignore_ascii_case(o)));
    let head_only = method == "HEAD";
    let mut reply = Reply { stream: &mut stream, head_only, cors };
    if !host.is_some_and(|h| own.contains(&h)) {
        return reply.send("421 Misdirected Request", "text/plain", b"");
    }
    if method != "GET" && !head_only {
        return reply.send("405 Method Not Allowed", "text/plain", b"");
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    match path {
        "/" | "/index.html" => reply.send("200 OK", "text/html; charset=utf-8", PAGE.as_bytes()),
        "/state" => {
            let state = shared.state.read().unwrap_or_else(|e| e.into_inner()).clone();
            reply.send("200 OK", "application/json", state.as_bytes())
        }
        "/fonts/instrument-sans-latin.woff2" => reply.send("200 OK", "font/woff2", FONT_LATIN),
        "/fonts/instrument-sans-latin-ext.woff2" => reply.send("200 OK", "font/woff2", FONT_LATIN_EXT),
        "/obs/events" => {
            drop(reply);
            events(&mut stream, shared, head_only, header("origin").filter(|o| shared.src.dev.as_deref().is_some_and(|d| d.trim_end_matches('/').eq_ignore_ascii_case(o))))
        }
        _ => {
            if let Some(hash) = path.strip_prefix("/art/") {
                return send_art(&mut reply, shared, hash, 640);
            }
            if let Some(rest) = path.strip_prefix("/obs/art/") {
                let Some((width, hash)) = rest.split_once('/') else { return reply.send("404 Not Found", "text/plain", b"") };
                let width = match width {
                    "320" => 320,
                    "640" => 640,
                    "1280" => 1280,
                    _ => return reply.send("404 Not Found", "text/plain", b""),
                };
                return send_art(&mut reply, shared, hash, width);
            }
            if let Some(key) = path.strip_prefix("/obs/audio/") {
                if !is_hash(key) || !shared.audio_named(key) {
                    return reply.send("404 Not Found", "text/plain", b"");
                }
                return match (shared.src.file)(key).and_then(|p| std::fs::read(p).ok()) {
                    Some(bytes) => reply.send("200 OK", crate::protocol::sniff(&bytes), &bytes),
                    None => reply.send("404 Not Found", "text/plain", b""),
                };
            }
            if let Some(page) = path.strip_prefix("/obs/") {
                if !PAGES.contains(&page) {
                    return reply.send("404 Not Found", "text/plain", b"");
                }
                if let Some(dev) = &shared.src.dev {
                    // a debug build: the page as Vite serves it, told where to find this server
                    let more = if query.is_empty() { String::new() } else { format!("&{query}") };
                    let to = format!("{}/obs.html?view={page}&fumen={}{more}", dev.trim_end_matches('/'), shared.port);
                    return reply.send_with("302 Found", "text/plain", b"", &format!("Location: {to}\r\n"));
                }
                return match (shared.src.asset)("obs.html") {
                    Some((bytes, _)) => reply.send("200 OK", "text/html; charset=utf-8", &bytes),
                    None => reply.send("404 Not Found", "text/plain", b""),
                };
            }
            if let Some(name) = path.strip_prefix("/assets/") {
                let fine = !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) && !name.starts_with('.');
                // an unknown path comes back as the app's index.html: not that
                return match (shared.src.asset)(&format!("assets/{name}")).filter(|(_, kind)| fine && !kind.starts_with("text/html")) {
                    Some((bytes, kind)) => reply.send("200 OK", &kind, &bytes),
                    None => reply.send("404 Not Found", "text/plain", b""),
                };
            }
            reply.send("404 Not Found", "text/plain", b"")
        }
    }
}

fn send_art(reply: &mut Reply, shared: &Shared, hash: &str, width: u32) -> std::io::Result<()> {
    if !is_hash(hash) || !shared.art_named(hash) {
        return reply.send("404 Not Found", "text/plain", b"");
    }
    match (shared.src.art)(hash, width).and_then(|p| std::fs::read(p).ok()) {
        Some(bytes) => reply.send("200 OK", "image/jpeg", &bytes),
        None => reply.send("404 Not Found", "text/plain", b""),
    }
}

/// The OBS pages' event stream: every part as it is, then each change as it comes, until the page
/// goes or the overlay is switched off.
fn events(stream: &mut TcpStream, shared: &Shared, head_only: bool, cors: Option<String>) -> std::io::Result<()> {
    if shared.streams.fetch_add(1, Ordering::SeqCst) >= MAX_STREAMS {
        shared.streams.fetch_sub(1, Ordering::SeqCst);
        let mut reply = Reply { stream, head_only, cors };
        return reply.send("503 Service Unavailable", "text/plain", b"");
    }
    let result = (|| {
        let cors = cors.map(|o| format!("Access-Control-Allow-Origin: {o}\r\nVary: Origin\r\n")).unwrap_or_default();
        stream.write_all(
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{cors}Connection: keep-alive\r\n\r\n").as_bytes(),
        )?;
        if head_only {
            return stream.flush();
        }
        stream.write_all(b"retry: 1500\n\n")?;
        stream.flush()?;
        let mut seen: BTreeMap<String, u64> = BTreeMap::new();
        loop {
            let out = {
                let mut parts = shared.parts.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if shared.stop.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    let fresh: Vec<(String, u64, String)> = parts
                        .iter()
                        .filter(|(k, p)| seen.get(*k).is_none_or(|v| *v < p.version))
                        .map(|(k, p)| (k.clone(), p.version, p.json.clone()))
                        .collect();
                    if !fresh.is_empty() {
                        break Some(fresh);
                    }
                    let (next, timeout) = shared.changed.wait_timeout(parts, KEEP_ALIVE).unwrap_or_else(|e| e.into_inner());
                    parts = next;
                    if timeout.timed_out() {
                        break None;
                    }
                }
            };
            match out {
                Some(fresh) => {
                    let mut text = String::new();
                    for (key, version, json) in fresh {
                        text.push_str(&format!("event: {key}\ndata: {json}\n\n"));
                        seen.insert(key, version);
                    }
                    stream.write_all(text.as_bytes())?;
                }
                None => stream.write_all(b": still here\n\n")?,
            }
            stream.flush()?;
        }
    })();
    shared.streams.fetch_sub(1, Ordering::SeqCst);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn ask_with(port: u16, method: &str, path: &str, host: &str, extra: &str) -> (String, String, Vec<u8>) {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n").unwrap();
        let mut out = Vec::new();
        s.read_to_end(&mut out).unwrap();
        let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&out[..split]).to_string();
        (head.lines().next().unwrap().to_string(), head, out[split + 4..].to_vec())
    }

    fn ask(port: u16, method: &str, path: &str, host: &str) -> (String, Vec<u8>) {
        let (status, _, body) = ask_with(port, method, path, host, "");
        (status, body)
    }

    fn sources(art: PathBuf, song: PathBuf, dev: Option<String>) -> Sources {
        Sources {
            art: Box::new(move |_, _| Some(art.clone())),
            file: Box::new(move |_| Some(song.clone())),
            asset: Box::new(|name| match name {
                "obs.html" => Some((b"<html>obs</html>".to_vec(), "text/html".into())),
                "assets/obs-1.js" => Some((b"js".to_vec(), "text/javascript".into())),
                // what Tauri answers for a file it doesn't have
                _ => Some((b"<html>index</html>".to_vec(), "text/html".into())),
            }),
            dev,
        }
    }

    // one test: the server is one per process
    #[test]
    fn serves_only_what_is_on_stream() {
        let dir = std::env::temp_dir().join(format!("fumen-overlay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let art = dir.join("a.jpg");
        std::fs::write(&art, b"jpeg").unwrap();
        let song = dir.join("s.mp3");
        std::fs::write(&song, b"ID3song").unwrap();
        let port = start_on(24190..=24199, sources(art.clone(), song.clone(), None)).unwrap();
        // on already: the same one
        assert_eq!(start_on(24190..=24199, sources(art.clone(), song.clone(), None)).unwrap(), port);
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

        // the OBS pages, the app's own files and nothing that only looks like one
        assert_eq!(ask(port, "GET", "/obs/hud", &host), ("HTTP/1.1 200 OK".into(), b"<html>obs</html>".to_vec()));
        assert_eq!(ask(port, "GET", "/obs/elsewhere", &host).0, "HTTP/1.1 404 Not Found");
        assert_eq!(ask(port, "GET", "/assets/obs-1.js", &host), ("HTTP/1.1 200 OK".into(), b"js".to_vec()));
        assert_eq!(ask(port, "GET", "/assets/missing.js", &host).0, "HTTP/1.1 404 Not Found");
        assert_eq!(ask(port, "GET", "/assets/../secret", &host).0, "HTTP/1.1 404 Not Found");

        // songs and backgrounds once a part names them
        let key = "ef".repeat(32);
        let cover = "12".repeat(16);
        assert_eq!(ask(port, "GET", &format!("/obs/audio/{key}"), &host).0, "HTTP/1.1 404 Not Found");
        assert!(set_obs("elsewhere", &serde_json::json!({}), vec![], vec![]).is_err());
        set_obs("map", &serde_json::json!({ "title": "A" }), vec![cover.clone()], vec![key.clone()]).unwrap();
        let (status, head, body) = ask_with(port, "GET", &format!("/obs/audio/{key}"), &host, "");
        assert_eq!((status.as_str(), body.as_slice()), ("HTTP/1.1 200 OK", b"ID3song".as_slice()));
        assert!(head.contains("Content-Type: audio/mpeg"));
        assert!(!head.contains("Access-Control-Allow-Origin"));
        assert_eq!(ask(port, "GET", &format!("/obs/art/1280/{cover}"), &host).0, "HTTP/1.1 200 OK");
        assert_eq!(ask(port, "GET", &format!("/obs/art/999/{cover}"), &host).0, "HTTP/1.1 404 Not Found");

        // the event stream: every part at once, then the changes
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /obs/events HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut r = BufReader::new(s);
        let mut next_event = || {
            let mut name = String::new();
            loop {
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                if let Some(n) = line.strip_prefix("event: ") {
                    name = n.trim().to_string();
                }
                if let Some(d) = line.strip_prefix("data: ") {
                    return (name, d.trim().to_string());
                }
            }
        };
        assert_eq!(next_event(), ("map".into(), r#"{"title":"A"}"#.into()));
        set_obs("tries", &serde_json::json!({ "n": 7 }), vec![], vec![]).unwrap();
        assert_eq!(next_event(), ("tries".into(), r#"{"n":7}"#.into()));
        // the same again is no change; a new one is
        set_obs("tries", &serde_json::json!({ "n": 7 }), vec![], vec![]).unwrap();
        set_obs("tries", &serde_json::json!({ "n": 8 }), vec![], vec![]).unwrap();
        assert_eq!(next_event(), ("tries".into(), r#"{"n":8}"#.into()));
        drop(r);

        stop();
        assert_eq!(super::port(), None);
        std::thread::sleep(Duration::from_millis(150));
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err() || ask_fails(port));

        // a debug build: pages go to the dev server, which may read what's here
        let port = start_on(24190..=24199, sources(art, song, Some("http://localhost:1430".into()))).unwrap();
        let host = format!("127.0.0.1:{port}");
        let (status, head, _) = ask_with(port, "GET", "/obs/stage?bg=none", &host, "");
        assert_eq!(status, "HTTP/1.1 302 Found");
        assert!(head.contains(&format!("Location: http://localhost:1430/obs.html?view=stage&fumen={port}&bg=none")));
        let (_, head, _) = ask_with(port, "GET", "/state", &host, "Origin: http://localhost:1430\r\n");
        assert!(head.contains("Access-Control-Allow-Origin: http://localhost:1430"));
        let (_, head, _) = ask_with(port, "GET", "/state", &host, "Origin: https://evil.example\r\n");
        assert!(!head.contains("Access-Control-Allow-Origin"));
        stop();
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
