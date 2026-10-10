//! `fumen://` — serves osu! files to the webview.
//!
//!   fumen://localhost/file/<sha256>          raw file from lazer's store (Range-capable, for audio)
//!   fumen://localhost/thumb/<width>/<sha256> cached JPEG thumbnail of an image file
//!   fumen://localhost/skin/<classic|retro>/<file> lazer's built-in skin textures (see skins.rs)
//!
//! On Windows the webview sees these as `http://fumen.localhost/...`. Files are content-addressed,
//! so responses are cacheable forever. CORS is open so canvases can sample colours from images.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

use crate::paths::lazer_file;
use crate::{skins, thumbs};
use crate::AppState;

/// Open-ended range requests (`bytes=N-`) are answered in chunks so playback starts fast.
const MAX_CHUNK: u64 = 2 * 1024 * 1024;

pub fn handle(app: &AppHandle, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match route(app, req) {
        Ok(res) => res,
        Err(status) => empty(status),
    }
}

fn route(app: &AppHandle, req: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, StatusCode> {
    let state = app.try_state::<AppState>().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let parts: Vec<&str> = req.uri().path().trim_matches('/').split('/').collect();
    if let ["skin", skin, name] = parts.as_slice() {
        let path = skins::builtin_file(state.cache_dir(), skin, name).ok_or(StatusCode::BAD_REQUEST)?;
        return serve_file(&path, req);
    }
    let storage = state.storage().ok_or(StatusCode::NOT_FOUND)?;

    match parts.as_slice() {
        ["file", hash] => {
            let path = lazer_file(&storage, hash).ok_or(StatusCode::BAD_REQUEST)?;
            serve_file(&path, req)
        }
        ["thumb", width, hash] => {
            let width: u32 = width.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
            let source = lazer_file(&storage, hash).ok_or(StatusCode::BAD_REQUEST)?;
            if !source.is_file() {
                return Err(StatusCode::NOT_FOUND);
            }
            let thumb = thumbs::get_or_create(&state.thumbs_dir(), &source, hash, width)
                .map_err(|_| StatusCode::UNPROCESSABLE_ENTITY)?;
            serve_file(&thumb, req)
        }
        _ => Err(StatusCode::NOT_FOUND),
    }
}

fn serve_file(path: &Path, req: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>, StatusCode> {
    let mut file = std::fs::File::open(path).map_err(|_| StatusCode::NOT_FOUND)?;
    let len = file.metadata().map_err(|_| StatusCode::NOT_FOUND)?.len();

    let mut head = [0u8; 16];
    let n = file.read(&mut head).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mime = sniff(&head[..n]);

    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| parse_range(v, len));

    let builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable");

    match range {
        Some((start, end)) => {
            let body = read_slice(&mut file, start, end).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
        }
        None if req.headers().contains_key(header::RANGE) => Ok(Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .unwrap()),
        None => {
            let body = read_slice(&mut file, 0, len.saturating_sub(1)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            builder
                .status(StatusCode::OK)
                .header(header::CONTENT_LENGTH, body.len())
                .body(body)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}

fn read_slice(file: &mut std::fs::File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    if end < start {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((end - start + 1) as usize);
    file.take(end - start + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Parses a single `bytes=` range into an inclusive `(start, end)`. Multi-range requests are
/// answered with the first range only, which every media stack accepts.
pub fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = value.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), len - 1)
        }
        (s, "") => {
            let s: u64 = s.parse().ok()?;
            (s, (s + MAX_CHUNK - 1).min(len - 1))
        }
        (s, e) => {
            let s: u64 = s.parse().ok()?;
            let e: u64 = e.parse().ok()?;
            (s, e.min(len - 1))
        }
    };
    (start <= end && start < len).then_some((start, end))
}

pub fn sniff(head: &[u8]) -> &'static str {
    match head {
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => "audio/wav",
        [b'B', b'M', ..] => "image/bmp",
        [b'I', b'D', b'3', ..] => "audio/mpeg",
        [b'O', b'g', b'g', b'S', ..] => "audio/ogg",
        [b'f', b'L', b'a', b'C', ..] => "audio/flac",
        [0xFF, b, ..] if b & 0xE0 == 0xE0 => "audio/mpeg",
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => "video/mp4",
        _ => "application/octet-stream",
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-", 10 * MAX_CHUNK), Some((0, MAX_CHUNK - 1)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-1", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1", 0), None);
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
        assert_eq!(sniff(b"\x89PNG\r\n"), "image/png");
        assert_eq!(sniff(b"ID3\x04"), "audio/mpeg");
        assert_eq!(sniff(&[0xFF, 0xFB, 0x90]), "audio/mpeg");
        assert_eq!(sniff(b"OggS\0"), "audio/ogg");
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8"), "image/webp");
        assert_eq!(sniff(b"??"), "application/octet-stream");
    }
}
