//! A small HTTP server for tests that talk to osu! or Fumen's site.

use std::io::{Read, Write};
use std::net::TcpListener;

pub type Route = dyn Fn(&str, &str, &str, &str) -> (u16, String) + Send + Sync;

/// Answers every request with `route(method, path with query, authorization, body)`; returns
/// the server's base URL.
pub fn mock(route: Box<Route>) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut s in listener.incoming().flatten() {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head, body) = loop {
                let n = s.read(&mut chunk).unwrap_or(0);
                buf.extend_from_slice(&chunk[..n]);
                let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                    if n == 0 {
                        break (String::new(), String::new());
                    }
                    continue;
                };
                let head = String::from_utf8_lossy(&buf[..p]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                while buf.len() < p + 4 + len {
                    let n = s.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                break (head, String::from_utf8_lossy(&buf[p + 4..]).to_string());
            };
            let mut first = head.lines().next().unwrap_or("").split(' ');
            let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
            let auth = head
                .lines()
                .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim()))
                .unwrap_or("");
            let (status, out) = route(method, path, auth, &body);
            let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
        }
    });
    base
}
