//! Song files over plain HTTP on 127.0.0.1, for Linux.
//!
//! WebKitGTK plays media through GStreamer, which can't read fumen://. The player used to fetch each
//! song whole and play it from a `blob:` address, and WebKitGTK plays those poorly: the whole app
//! stuttered while a song played. A stream from a real (local) server is what it handles well, like
//! the Browse previews from the mirrors.
//!
//! Only `GET`/`HEAD /<token>/file/<key>` is served, the same files as fumen://localhost/file/<key>.
//! The token is random per start and only Fumen's page gets it (`media_base`), so other programs or
//! web pages on this PC can't read the library through it.

// started on Linux only; elsewhere fumen:// plays fine
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::protocol::{parse_range, sniff};
use crate::AppState;

static BASE: OnceLock<String> = OnceLock::new();

/// `http://127.0.0.1:<port>/<token>/` once the server runs.
pub fn base() -> Option<String> {
    BASE.get().cloned()
}

/// Starts the server (once); quiet when it can't, the player then keeps its old way.
pub fn start(app: AppHandle) {
    if BASE.get().is_some() {
        return;
    }
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[media] no server: {e}");
            return;
        }
    };
    let Ok(addr) = listener.local_addr() else { return };
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        return;
    }
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let _ = BASE.set(format!("http://127.0.0.1:{}/{token}/", addr.port()));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, token) = (app.clone(), token.clone());
            std::thread::spawn(move || {
                let find = |key: &str| app.try_state::<AppState>().and_then(|s| s.files().path(key));
                let _ = answer(&find, &token, stream);
            });
        }
    });
}

/// One request, one answer, then the connection closes. `find`: a file key's path.
fn answer(find: &dyn Fn(&str) -> Option<PathBuf>, token: &str, stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut range = None;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    let mut out = stream;
    let req = match request(&line, token) {
        Ok(r) => r,
        Err(status) => return empty(&mut out, status),
    };
    let Some(path) = find(req.key) else { return empty(&mut out, "404 Not Found") };
    let Ok(mut file) = std::fs::File::open(&path) else { return empty(&mut out, "404 Not Found") };
    let len = file.metadata()?.len();
    let mut head = [0u8; 16];
    let n = file.read(&mut head)?;
    let mime = sniff(&head[..n]);

    let (status, start, end) = match range.as_deref() {
        Some(r) => match parse_range(r, len) {
            Some((s, e)) => ("206 Partial Content", s, e),
            None => {
                let msg = format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                return out.write_all(msg.as_bytes());
            }
        },
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let mut msg = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n"
    );
    if status.starts_with("206") {
        msg.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    msg.push_str("\r\n");
    out.write_all(msg.as_bytes())?;
    if req.head || count == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    std::io::copy(&mut file.take(count), &mut out)?;
    out.flush()
}

#[derive(Debug, PartialEq)]
struct Req<'a> {
    key: &'a str,
    head: bool,
}

/// The request line's method and file key, or the status to answer with.
fn request<'a>(line: &'a str, token: &str) -> Result<Req<'a>, &'static str> {
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let head = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return Err("405 Method Not Allowed"),
    };
    let path = target.split('?').next().unwrap_or("");
    let key = path
        .strip_prefix('/')
        .and_then(|p| p.strip_prefix(token))
        .and_then(|p| p.strip_prefix("/file/"))
        .filter(|k| !k.is_empty() && !k.contains('/'))
        .ok_or("404 Not Found")?;
    Ok(Req { key, head })
}

fn empty(out: &mut TcpStream, status: &str) -> std::io::Result<()> {
    out.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_files_behind_the_token() {
        let t = "abc123";
        assert_eq!(request("GET /abc123/file/deadbeef HTTP/1.1", t), Ok(Req { key: "deadbeef", head: false }));
        assert_eq!(request("HEAD /abc123/file/deadbeef?x=1 HTTP/1.1", t), Ok(Req { key: "deadbeef", head: true }));
        assert_eq!(request("GET /wrong/file/deadbeef HTTP/1.1", t), Err("404 Not Found"));
        assert_eq!(request("GET /abc123/thumb/360/deadbeef HTTP/1.1", t), Err("404 Not Found"));
        assert_eq!(request("GET /abc123/file/a/../b HTTP/1.1", t), Err("404 Not Found"));
        assert_eq!(request("GET /abc123/file/ HTTP/1.1", t), Err("404 Not Found"));
        assert_eq!(request("POST /abc123/file/deadbeef HTTP/1.1", t), Err("405 Method Not Allowed"));
    }

    /// A real connection: the whole file, a range of it, and a wrong token.
    #[test]
    fn serves_files_and_ranges() {
        let dir = std::env::temp_dir().join(format!("fumen-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let song = dir.join("song.ogg");
        let mut data = b"OggS".to_vec();
        data.extend((0..1000u32).map(|i| (i % 251) as u8));
        std::fs::write(&song, &data).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let path = song.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let path = path.clone();
                let find = move |k: &str| (k == "abc").then(|| path.clone());
                let _ = answer(&find, "tok", stream);
            }
        });
        let ask = |req: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(req.as_bytes()).unwrap();
            let mut out = Vec::new();
            s.read_to_end(&mut out).unwrap();
            let split = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            (String::from_utf8_lossy(&out[..split]).to_string(), out[split + 4..].to_vec())
        };
        let (head, body) = ask("GET /tok/file/abc HTTP/1.1\r\nHost: x\r\n\r\n");
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(head.contains("Content-Type: audio/ogg") && head.contains("Access-Control-Allow-Origin: *"));
        assert_eq!(body, data);
        let (head, body) = ask("GET /tok/file/abc HTTP/1.1\r\nRange: bytes=10-19\r\n\r\n");
        assert!(head.starts_with("HTTP/1.1 206") && head.contains("Content-Range: bytes 10-19/1004"), "{head}");
        assert_eq!(body, data[10..20]);
        let (head, body) = ask("HEAD /tok/file/abc HTTP/1.1\r\n\r\n");
        assert!(head.contains("Content-Length: 1004") && body.is_empty(), "{head}");
        let (head, _) = ask("GET /nope/file/abc HTTP/1.1\r\n\r\n");
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
