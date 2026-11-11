//! A map's .avi or .flv video as an .mp4 the visualizer's `<video>` can play: WebView2 and
//! WebKitGTK open neither container. Only H.264 inside is handled, and nothing is decoded: its
//! frames are copied as they are into an .mp4 around them. AVI keeps no times for the order the
//! frames are shown in (B-frames come before the frames they sit between), so that order is read
//! from the frames' own headers. Xvid, DivX, Sorenson Spark and VP6 would need a real decoder:
//! those stay unplayable and the cover shows, as before.
//!
//! The .mp4 is made once into the cache (`videos/<md5 of REWRAP and the file's key>.mp4`) and served under
//! the key `mp4-<that md5>` by fumen:// (protocol.rs) and the Linux media server; the folder is
//! kept under CACHE_MAX by dropping what was used longest ago.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// the cached videos together, bytes
const CACHE_MAX: u64 = 3 * 1024 * 1024 * 1024;
/// bigger files aren't read (a map's video is tens of MB)
const INPUT_MAX: u64 = 1024 * 1024 * 1024;
/// the start of a served key
pub const KEY_PREFIX: &str = "mp4-";
/// goes up when the rewrapping changes, so videos made (or given up on) before are made again
const REWRAP: u32 = 1;

/// The cached .mp4 behind a served key (`mp4-<32 hex>`), if it's one and it's there.
pub fn served(cache_dir: &Path, key: &str) -> Option<PathBuf> {
    let id = key.strip_prefix(KEY_PREFIX)?;
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let path = cache_dir.join("videos").join(format!("{id}.mp4"));
    path.is_file().then_some(path)
}

/// Whether the file starts like an AVI or an FLV (the containers handled here).
pub fn wants(head: &[u8]) -> bool {
    is_avi(head) || is_flv(head)
}

fn is_avi(d: &[u8]) -> bool {
    d.len() >= 12 && &d[..4] == b"RIFF" && &d[8..12] == b"AVI "
}

fn is_flv(d: &[u8]) -> bool {
    d.len() >= 9 && &d[..3] == b"FLV"
}

/// The served key for the video `src` (stored under `key`) as an .mp4, made now unless it's
/// cached; None when it can't be: not H.264, or broken.
pub fn mp4_for(cache_dir: &Path, key: &str, src: &Path) -> Option<String> {
    use md5::Digest;
    let id: String = md5::Md5::digest(format!("{REWRAP}:{key}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let dir = cache_dir.join("videos");
    let out = dir.join(format!("{id}.mp4"));
    let served = format!("{KEY_PREFIX}{id}");
    if out.is_file() {
        // used now: the last to go when the folder is trimmed
        if let Ok(f) = std::fs::File::options().write(true).open(&out) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
        return Some(served);
    }
    let none = dir.join(format!("{id}.none"));
    if none.is_file() {
        return None;
    }
    std::fs::create_dir_all(&dir).ok()?;
    if std::fs::metadata(src).ok()?.len() > INPUT_MAX {
        return None;
    }
    let data = std::fs::read(src).ok()?;
    let Some(mp4) = convert(&data) else {
        // not one to rewrap: no need to look again
        let _ = std::fs::write(&none, b"");
        return None;
    };
    let tmp = dir.join(format!("{id}.{}.part", std::process::id()));
    std::fs::write(&tmp, &mp4).ok()?;
    if std::fs::rename(&tmp, &out).is_err() {
        let _ = std::fs::remove_file(&tmp);
        if !out.is_file() {
            return None;
        }
    }
    trim(&dir, &out);
    Some(served)
}

/// The cache under CACHE_MAX: the videos used longest ago go (never `keep`).
fn trim(dir: &Path, keep: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = read
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= CACHE_MAX {
            break;
        }
        if path != keep && std::fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

/// The video in `data` (AVI or FLV) as an .mp4; None when it isn't H.264 or can't be read.
pub fn convert(data: &[u8]) -> Option<Vec<u8>> {
    let track = if is_avi(data) {
        avi(data)?
    } else if is_flv(data) {
        flv(data)?
    } else {
        return None;
    };
    (!track.samples.is_empty()).then(|| mp4(&track))
}

// ── one video track, as the .mp4 gets it ──

struct Sample {
    /// decode time, track units
    dts: i64,
    /// presentation time, track units
    pts: i64,
    size: u32,
    key: bool,
}

struct Track {
    timescale: u32,
    /// what the last frame lasts, track units
    last: i64,
    width: u32,
    height: u32,
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
    samples: Vec<Sample>,
    /// the samples one after another: NAL units, each after its length (4 bytes)
    data: Vec<u8>,
}

// ── H.264: what's needed to copy it and put it in order ──

/// Reads bits, most significant first.
struct Bits<'a> {
    d: &'a [u8],
    pos: usize,
}

impl<'a> Bits<'a> {
    fn new(d: &'a [u8]) -> Self {
        Self { d, pos: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        let byte = *self.d.get(self.pos / 8)?;
        let b = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(b as u32)
    }

    fn bits(&mut self, n: u32) -> Option<u32> {
        let mut v: u64 = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()? as u64;
        }
        u32::try_from(v).ok()
    }

    /// unsigned Exp-Golomb
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        let rest = self.bits(zeros)? as u64;
        u32::try_from((1u64 << zeros) - 1 + rest).ok()
    }

    /// signed Exp-Golomb
    fn se(&mut self) -> Option<i32> {
        let k = self.ue()? as i64;
        Some(if k % 2 == 1 { ((k + 1) / 2) as i32 } else { -(k / 2) as i32 })
    }
}

/// A NAL unit's payload without its header byte and with the emulation prevention bytes
/// (00 00 03) taken out, at most `max` bytes of it.
fn rbsp(nal: &[u8], max: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(max.min(nal.len()));
    let mut zeros = 0;
    for &b in nal.iter().skip(1) {
        if out.len() >= max {
            break;
        }
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// The NAL units of an Annex B stream (each after a start code, 00 00 01 or 00 00 00 01).
fn annexb(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(starts.len());
    for (k, &s) in starts.iter().enumerate() {
        let mut e = starts.get(k + 1).map(|n| n - 3).unwrap_or(data.len());
        // the zeros before the next start code (00 00 00 01) aren't the NAL's
        while e > s && data[e - 1] == 0 {
            e -= 1;
        }
        if e > s {
            out.push(&data[s..e]);
        }
    }
    out
}

/// NAL units each after its length (`size` bytes, big-endian); None when the lengths don't fit.
fn length_prefixed(data: &[u8], size: usize) -> Option<Vec<&[u8]>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        if i + size > data.len() {
            return None;
        }
        let n = data[i..i + size].iter().fold(0usize, |v, &b| (v << 8) | b as usize);
        i += size;
        if n == 0 || i + n > data.len() {
            return None;
        }
        out.push(&data[i..i + n]);
        i += n;
    }
    Some(out)
}

fn starts_annexb(d: &[u8]) -> bool {
    d.starts_with(&[0, 0, 1]) || d.starts_with(&[0, 0, 0, 1])
}

/// A frame's NAL units. Frames after an avcC are length-prefixed, and a length of 256 to 511
/// starts with 00 00 01 just like a start code, so the lengths are tried first there and only
/// a frame they don't fit is read as Annex B. The other way round without an avcC.
fn split(data: &[u8], length_size: usize, avcc: bool) -> Vec<&[u8]> {
    let fits = |nals: &Vec<&[u8]>| nals.iter().all(|n| n[0] & 0x80 == 0);
    if avcc {
        if let Some(nals) = length_prefixed(data, length_size).filter(fits) {
            return nals;
        }
    }
    if starts_annexb(data) {
        return annexb(data);
    }
    length_prefixed(data, length_size).unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq)]
struct Sps {
    width: u32,
    height: u32,
    log2_max_frame_num: u32,
    poc_type: u32,
    log2_max_poc_lsb: u32,
    frame_mbs_only: bool,
    separate_colour_plane: bool,
}

/// A sequence parameter set: its id and what the slices and the size need.
fn parse_sps(nal: &[u8]) -> Option<(u32, Sps)> {
    if nal.first()? & 0x80 != 0 {
        return None;
    }
    let r = rbsp(nal, 2048);
    let mut b = Bits::new(&r);
    let profile = b.bits(8)?;
    b.bits(16)?;
    let id = b.ue()?;
    if id > 31 {
        return None;
    }
    let mut chroma = 1;
    let mut separate_colour_plane = false;
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        chroma = b.ue()?;
        if chroma > 3 {
            return None;
        }
        if chroma == 3 {
            separate_colour_plane = b.bit()? == 1;
        }
        b.ue()?;
        b.ue()?;
        b.bit()?;
        if b.bit()? == 1 {
            for i in 0..(if chroma == 3 { 12 } else { 8 }) {
                if b.bit()? == 1 {
                    skip_scaling_list(&mut b, if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    let log2_max_frame_num = b.ue()? + 4;
    let poc_type = b.ue()?;
    let mut log2_max_poc_lsb = 0;
    match poc_type {
        0 => log2_max_poc_lsb = b.ue()? + 4,
        1 => {
            b.bit()?;
            b.se()?;
            b.se()?;
            let n = b.ue()?;
            if n > 255 {
                return None;
            }
            for _ in 0..n {
                b.se()?;
            }
        }
        2 => {}
        _ => return None,
    }
    b.ue()?;
    b.bit()?;
    let width_mbs = b.ue()? + 1;
    let height_units = b.ue()? + 1;
    let frame_mbs_only = b.bit()? == 1;
    if !frame_mbs_only {
        b.bit()?;
    }
    b.bit()?;
    let (mut left, mut right, mut top, mut bottom) = (0, 0, 0, 0);
    if b.bit()? == 1 {
        left = b.ue()?;
        right = b.ue()?;
        top = b.ue()?;
        bottom = b.ue()?;
    }
    let fields = if frame_mbs_only { 1 } else { 2 };
    let (ux, uy) = if separate_colour_plane || chroma == 0 {
        (1, fields)
    } else {
        match chroma {
            1 => (2, 2 * fields),
            2 => (2, fields),
            _ => (1, fields),
        }
    };
    let width = (width_mbs * 16).saturating_sub(ux * (left + right));
    let height = (fields * height_units * 16).saturating_sub(uy * (top + bottom));
    if log2_max_frame_num > 16 || log2_max_poc_lsb > 16 {
        return None;
    }
    Some((id, Sps { width, height, log2_max_frame_num, poc_type, log2_max_poc_lsb, frame_mbs_only, separate_colour_plane }))
}

fn skip_scaling_list(b: &mut Bits, size: usize) -> Option<()> {
    let (mut last, mut next) = (8i32, 8i32);
    for _ in 0..size {
        if next != 0 {
            next = (last + b.se()? + 256) % 256;
        }
        if next != 0 {
            last = next;
        }
    }
    Some(())
}

/// A picture parameter set: its id and its sequence's.
fn parse_pps(nal: &[u8]) -> Option<(u32, u32)> {
    if nal.first()? & 0x80 != 0 {
        return None;
    }
    let r = rbsp(nal, 64);
    let mut b = Bits::new(&r);
    let (id, sps) = (b.ue()?, b.ue()?);
    (id <= 255 && sps <= 31).then_some((id, sps))
}

/// What a frame's first slice says about where it goes.
struct Slice {
    idr: bool,
    reference: bool,
    /// pic_order_cnt_lsb (only with poc type 0)
    poc_lsb: Option<u32>,
    log2_max_poc_lsb: u32,
}

fn parse_slice(nal: &[u8], pps: &HashMap<u32, u32>, sps: &HashMap<u32, Sps>) -> Option<Slice> {
    let kind = nal.first()? & 0x1f;
    let reference = (nal[0] >> 5) & 3 != 0;
    let r = rbsp(nal, 64);
    let mut b = Bits::new(&r);
    b.ue()?;
    b.ue()?;
    let s = sps.get(pps.get(&b.ue()?)?)?;
    if s.separate_colour_plane {
        b.bits(2)?;
    }
    b.bits(s.log2_max_frame_num)?;
    if !s.frame_mbs_only && b.bit()? == 1 {
        b.bit()?;
    }
    if kind == 5 {
        b.ue()?;
    }
    let poc_lsb = if s.poc_type == 0 { Some(b.bits(s.log2_max_poc_lsb)?) } else { None };
    Some(Slice { idr: kind == 5, reference, poc_lsb, log2_max_poc_lsb: s.log2_max_poc_lsb })
}

/// Collects a stream's parameter sets and turns its frames into the .mp4's samples.
#[derive(Default)]
struct Writer {
    sps: Vec<Vec<u8>>,
    pps: Vec<Vec<u8>>,
    sps_by_id: HashMap<u32, Sps>,
    pps_by_id: HashMap<u32, u32>,
    data: Vec<u8>,
}

impl Writer {
    /// Takes a parameter set: true when it's in the sample entry (avcC) already, so the frame
    /// doesn't need to carry it.
    fn param(&mut self, nal: &[u8]) -> bool {
        match nal[0] & 0x1f {
            7 => {
                if self.sps.iter().any(|s| s == nal) {
                    return true;
                }
                let Some((id, s)) = parse_sps(nal) else { return false };
                // a different one under an id that's taken: it stays in the frame
                let known = self.sps_by_id.contains_key(&id);
                self.sps_by_id.insert(id, s);
                if known || self.sps.len() >= 31 {
                    return false;
                }
                self.sps.push(nal.to_vec());
                true
            }
            8 => {
                if self.pps.iter().any(|p| p == nal) {
                    return true;
                }
                let Some((id, sps)) = parse_pps(nal) else { return false };
                let known = self.pps_by_id.contains_key(&id);
                self.pps_by_id.insert(id, sps);
                if known || self.pps.len() >= 255 {
                    return false;
                }
                self.pps.push(nal.to_vec());
                true
            }
            _ => false,
        }
    }

    /// A frame's NAL units into the samples' data: its size, whether it has an IDR picture, and
    /// its first slice (None when it has no picture).
    fn frame(&mut self, nals: &[&[u8]]) -> (u32, bool, Option<Slice>) {
        let start = self.data.len();
        let mut idr = false;
        let mut slice = None;
        for nal in nals {
            if nal.is_empty() {
                continue;
            }
            let kind = nal[0] & 0x1f;
            // access unit delimiters and filler aren't needed; known parameter sets are in the avcC
            if kind == 9 || kind == 12 || ((kind == 7 || kind == 8) && self.param(nal)) {
                continue;
            }
            if kind == 5 {
                idr = true;
            }
            if (kind == 1 || kind == 5) && slice.is_none() {
                slice = parse_slice(nal, &self.pps_by_id, &self.sps_by_id);
                if slice.is_none() {
                    slice = Some(Slice { idr: kind == 5, reference: true, poc_lsb: None, log2_max_poc_lsb: 0 });
                }
            }
            self.data.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            self.data.extend_from_slice(nal);
        }
        if slice.is_none() {
            self.data.truncate(start);
        }
        ((self.data.len() - start) as u32, idr, slice)
    }

    fn size(&self) -> (u32, u32) {
        self.sps.first().and_then(|s| parse_sps(s)).map(|(_, s)| (s.width, s.height)).unwrap_or((0, 0))
    }
}

/// Picture order counts (poc type 0, frames) in decode order, as the decoder works them out.
#[derive(Default)]
struct Poc {
    msb: i64,
    lsb: i64,
}

impl Poc {
    fn next(&mut self, s: &Slice) -> i64 {
        let Some(lsb) = s.poc_lsb else { return 0 };
        let lsb = lsb as i64;
        if s.idr {
            self.msb = 0;
            self.lsb = 0;
        }
        let max = 1i64 << s.log2_max_poc_lsb;
        let msb = if lsb < self.lsb && self.lsb - lsb >= max / 2 {
            self.msb + max
        } else if lsb > self.lsb && lsb - self.lsb > max / 2 {
            self.msb - max
        } else {
            self.msb
        };
        if s.reference {
            self.msb = msb;
            self.lsb = lsb;
        }
        msb + lsb
    }
}

/// Frames in decode order with their decode times, put in the order they're shown: the shown
/// times are the decode times handed out in picture order (between IDR pictures).
fn order(frames: &mut [Sample], pocs: &[(u32, i64)]) {
    let mut by_shown: Vec<usize> = (0..frames.len()).collect();
    by_shown.sort_by_key(|&i| (pocs[i].0, pocs[i].1, i));
    let times: Vec<i64> = frames.iter().map(|f| f.dts).collect();
    for (rank, &i) in by_shown.iter().enumerate() {
        frames[i].pts = times[rank];
    }
}

// ── AVI ──

/// The chunks between `start` and `end`: (fourcc, data's start, data's length).
fn riff_chunks(d: &[u8], start: usize, end: usize) -> Vec<([u8; 4], usize, usize)> {
    let end = end.min(d.len());
    let mut out = Vec::new();
    let mut p = start;
    while p + 8 <= end {
        let id: [u8; 4] = d[p..p + 4].try_into().unwrap();
        let size = u32::from_le_bytes(d[p + 4..p + 8].try_into().unwrap()) as usize;
        let data = p + 8;
        let len = size.min(end - data);
        out.push((id, data, len));
        p = data + size + (size & 1);
    }
    out
}

struct AviStream {
    kind: [u8; 4],
    handler: [u8; 4],
    scale: u32,
    rate: u32,
    format: Vec<u8>,
}

fn avi(d: &[u8]) -> Option<Track> {
    let mut streams: Vec<AviStream> = Vec::new();
    let mut movi: Vec<(usize, usize)> = Vec::new();
    let mut idx1: Option<(usize, usize)> = None;
    // the RIFF "AVI " and any "AVIX" after it (OpenDML)
    let mut p = 0;
    while p + 12 <= d.len() && &d[p..p + 4] == b"RIFF" {
        let size = u32::from_le_bytes(d[p + 4..p + 8].try_into().unwrap()) as usize;
        let end = (p + 8 + size).min(d.len());
        for (id, at, len) in riff_chunks(d, p + 12, end) {
            if &id == b"LIST" && len >= 4 {
                match &d[at..at + 4] {
                    b"hdrl" => streams.extend(avi_header(d, at + 4, at + len)),
                    b"movi" => movi.push((at + 4, at + len)),
                    _ => {}
                }
            } else if &id == b"idx1" {
                idx1 = Some((at, len));
            }
        }
        p = p + 8 + size + (size & 1);
    }
    let (index, video) = streams.iter().enumerate().find(|(_, s)| &s.kind == b"vids")?;
    let fourcc = |b: &[u8]| String::from_utf8_lossy(b).to_ascii_lowercase();
    let h264 = |f: String| matches!(f.as_str(), "h264" | "x264" | "avc1" | "davc" | "vssh" | "v264");
    let compression = video.format.get(16..20).map(|b| fourcc(b)).unwrap_or_default();
    if !h264(compression) && !h264(fourcc(&video.handler)) {
        return None;
    }
    let tag = format!("{index:02}");
    let ours = |id: &[u8; 4]| id[..2] == *tag.as_bytes() && (&id[2..] == b"dc" || &id[2..] == b"db");

    // the frames in the file's order (one chunk each, some empty: a frame that repeats)
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    fn walk(d: &[u8], start: usize, end: usize, ours: &dyn Fn(&[u8; 4]) -> bool, out: &mut Vec<(usize, usize)>) {
        for (id, at, len) in riff_chunks(d, start, end) {
            if &id == b"LIST" && len >= 4 && &d[at..at + 4] == b"rec " {
                walk(d, at + 4, at + len, ours, out);
            } else if ours(&id) {
                out.push((at, len));
            }
        }
    }
    for &(s, e) in &movi {
        walk(d, s, e, &ours, &mut chunks);
    }
    // the index's keyframe flags, when it lists the same frames
    let flags: Option<Vec<bool>> = idx1.and_then(|(at, len)| {
        let f: Vec<bool> = d[at..at + len]
            .chunks_exact(16)
            .filter(|e| ours(e[..4].try_into().unwrap()))
            .map(|e| u32::from_le_bytes(e[4..8].try_into().unwrap()) & 0x10 != 0)
            .collect();
        (f.len() == chunks.len()).then_some(f)
    });

    let mut w = Writer::default();
    // the parameter sets that come with the format (avcC, or Annex B)
    let mut length_size = 4;
    let mut avcc = false;
    if let Some(extra) = video.format.get(40..).filter(|e| !e.is_empty()) {
        if extra[0] == 1 && extra.len() > 6 {
            avcc = true;
            length_size = (extra[4] & 3) as usize + 1;
            for nal in avcc_params(extra) {
                w.param(nal);
            }
        } else if starts_annexb(extra) {
            for nal in annexb(extra) {
                w.param(nal);
            }
        }
    }

    let (scale, rate) = if video.scale > 0 && video.rate > 0 { (video.scale, video.rate) } else { (1, 25) };
    let g = gcd(scale, rate);
    let (scale, rate) = (scale / g, rate / g);
    let mut samples = Vec::new();
    let mut pocs = Vec::new();
    let mut poc = Poc::default();
    let mut period = 0u32;
    for (n, &(at, len)) in chunks.iter().enumerate() {
        let data = &d[at..at + len];
        if data.is_empty() {
            continue;
        }
        let nals = split(data, length_size, avcc);
        let (size, idr, slice) = w.frame(&nals);
        let Some(slice) = slice else { continue };
        let key = idr || flags.as_ref().is_some_and(|f| f[n]);
        // nothing before the first picture that stands on its own
        if samples.is_empty() && !key {
            w.data.truncate(w.data.len() - size as usize);
            continue;
        }
        if slice.idr {
            period += 1;
        }
        let p = if slice.poc_lsb.is_some() { poc.next(&slice) } else { samples.len() as i64 };
        pocs.push((period, p));
        let dts = n as i64 * scale as i64;
        samples.push(Sample { dts, pts: dts, size, key });
    }
    if samples.is_empty() || w.sps.is_empty() || w.pps.is_empty() {
        return None;
    }
    order(&mut samples, &pocs);
    let (vw, vh) = w.size();
    let width = if vw > 0 { vw } else { u32::from_le_bytes(video.format.get(4..8)?.try_into().ok()?) };
    let height = if vh > 0 { vh } else { i32::from_le_bytes(video.format.get(8..12)?.try_into().ok()?).unsigned_abs() };
    Some(Track { timescale: rate, last: scale as i64, width, height, sps: w.sps, pps: w.pps, samples, data: w.data })
}

fn avi_header(d: &[u8], start: usize, end: usize) -> Vec<AviStream> {
    let mut out = Vec::new();
    for (id, at, len) in riff_chunks(d, start, end) {
        if &id != b"LIST" || len < 4 || &d[at..at + 4] != b"strl" {
            continue;
        }
        let mut s = AviStream { kind: [0; 4], handler: [0; 4], scale: 0, rate: 0, format: Vec::new() };
        for (id, at, len) in riff_chunks(d, at + 4, at + len) {
            let c = &d[at..at + len];
            if &id == b"strh" && c.len() >= 28 {
                s.kind = c[0..4].try_into().unwrap();
                s.handler = c[4..8].try_into().unwrap();
                s.scale = u32::from_le_bytes(c[20..24].try_into().unwrap());
                s.rate = u32::from_le_bytes(c[24..28].try_into().unwrap());
            } else if &id == b"strf" {
                s.format = c.to_vec();
            }
        }
        out.push(s);
    }
    out
}

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a.max(1)
    } else {
        gcd(b, a % b)
    }
}

/// The parameter sets in an AVCDecoderConfigurationRecord.
fn avcc_params(rec: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 5;
    for round in 0..2 {
        let Some(&count) = rec.get(i) else { break };
        let count = if round == 0 { count & 0x1f } else { count };
        i += 1;
        for _ in 0..count {
            let Some(len) = rec.get(i..i + 2).map(|b| u16::from_be_bytes([b[0], b[1]]) as usize) else { return out };
            i += 2;
            let Some(nal) = rec.get(i..i + len) else { return out };
            if !nal.is_empty() {
                out.push(nal);
            }
            i += len;
        }
    }
    out
}

// ── FLV ──

fn flv(d: &[u8]) -> Option<Track> {
    let header = u32::from_be_bytes(d.get(5..9)?.try_into().ok()?) as usize;
    let mut p = header + 4;
    let mut w = Writer::default();
    let mut length_size = 4;
    let mut samples: Vec<Sample> = Vec::new();
    // bytes of the data in samples so far (what's after them goes with the next frame)
    let mut used = 0usize;
    let mut seen_avc = false;
    while p + 11 <= d.len() {
        let kind = d[p] & 0x1f;
        let encrypted = d[p] & 0x20 != 0;
        let size = u32::from_be_bytes([0, d[p + 1], d[p + 2], d[p + 3]]) as usize;
        let ts = u32::from_be_bytes([d[p + 7], d[p + 4], d[p + 5], d[p + 6]]) as i64;
        let body = p + 11;
        let end = (body + size).min(d.len());
        p = body + size + 4;
        if kind != 9 || encrypted || end < body + 5 {
            continue;
        }
        let b0 = d[body];
        // the newer form (its codec as a fourcc) isn't handled
        if b0 & 0x80 != 0 {
            return None;
        }
        if b0 & 0x0f != 7 {
            if seen_avc {
                continue;
            }
            return None;
        }
        seen_avc = true;
        let frame_type = b0 >> 4;
        if frame_type == 5 {
            continue;
        }
        let cts = {
            let v = u32::from_be_bytes([0, d[body + 2], d[body + 3], d[body + 4]]) as i64;
            if v & 0x80_0000 != 0 {
                v - 0x100_0000
            } else {
                v
            }
        };
        let payload = &d[body + 5..end];
        match d[body + 1] {
            0 => {
                if payload.len() > 6 && payload[0] == 1 {
                    length_size = (payload[4] & 3) as usize + 1;
                    // the first ones go in the avcC; a later, different one goes along with the next frame
                    let params: Vec<Vec<u8>> = avcc_params(payload).into_iter().map(|n| n.to_vec()).collect();
                    let inline: Vec<Vec<u8>> = params.into_iter().filter(|n| !w.param(n)).collect();
                    for nal in inline {
                        w.data.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                        w.data.extend_from_slice(&nal);
                    }
                }
            }
            1 => {
                let Some(nals) = length_prefixed(payload, length_size) else { continue };
                let (_, idr, slice) = w.frame(&nals);
                if slice.is_none() {
                    continue;
                }
                let key = frame_type == 1 || idr;
                // nothing before the first picture that stands on its own
                if samples.is_empty() && !key {
                    w.data.truncate(used);
                    continue;
                }
                let dts = match samples.last() {
                    Some(prev) if ts <= prev.dts => prev.dts + 1,
                    _ => ts,
                };
                // with any parameter sets that came before it
                let size = (w.data.len() - used) as u32;
                used = w.data.len();
                samples.push(Sample { dts, pts: dts + cts, size, key });
            }
            _ => {}
        }
    }
    if samples.is_empty() || w.sps.is_empty() || w.pps.is_empty() {
        return None;
    }
    let (width, height) = w.size();
    let last = if samples.len() > 1 { (samples[samples.len() - 1].dts - samples[samples.len() - 2].dts).max(1) } else { 40 };
    Some(Track { timescale: 1000, last, width, height, sps: w.sps, pps: w.pps, samples, data: w.data })
}

// ── MP4 ──

fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&(body.len() as u32 + 8).to_be_bytes());
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v
}

fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(body.len() + 4);
    b.push(version);
    b.extend_from_slice(&flags.to_be_bytes()[1..]);
    b.extend_from_slice(body);
    bx(kind, &b)
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn be32(v: &mut Vec<u8>, n: u32) {
    v.extend_from_slice(&n.to_be_bytes());
}

fn be64(v: &mut Vec<u8>, n: u64) {
    v.extend_from_slice(&n.to_be_bytes());
}

fn mp4(t: &Track) -> Vec<u8> {
    let ftyp = bx(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41");
    let moov_len = moov(t, 0).len();
    let offset = (ftyp.len() + moov_len + 8) as u64;
    let moov = moov(t, offset);
    let mut out = Vec::with_capacity(offset as usize + t.data.len());
    out.extend_from_slice(&ftyp);
    out.extend_from_slice(&moov);
    out.extend_from_slice(&(t.data.len() as u32 + 8).to_be_bytes());
    out.extend_from_slice(b"mdat");
    out.extend_from_slice(&t.data);
    out
}

fn moov(t: &Track, offset: u64) -> Vec<u8> {
    let s = &t.samples;
    // the .mp4's decode times start at 0 (the first sample's); shown times are decode times plus
    // an offset that can't be below 0, so all are moved on by `lead` and the edit takes it back
    let start_dts = s[0].dts;
    let lead = s.iter().map(|x| x.dts - x.pts).max().unwrap_or(0).max(0);
    let first = s.iter().map(|x| x.pts).min().unwrap_or(0) - start_dts + lead;
    let end = s.last().map(|x| x.dts).unwrap_or(0) + t.last;
    let media = (end - start_dts).max(1) as u64;
    let shown = media;

    let mut mvhd = Vec::new();
    be64(&mut mvhd, 0);
    be64(&mut mvhd, 0);
    be32(&mut mvhd, t.timescale);
    be64(&mut mvhd, shown);
    be32(&mut mvhd, 0x0001_0000);
    mvhd.extend_from_slice(&[1, 0]);
    mvhd.extend_from_slice(&[0; 10]);
    for m in MATRIX {
        be32(&mut mvhd, m);
    }
    mvhd.extend_from_slice(&[0; 24]);
    be32(&mut mvhd, 2);

    let mut tkhd = Vec::new();
    be64(&mut tkhd, 0);
    be64(&mut tkhd, 0);
    be32(&mut tkhd, 1);
    be32(&mut tkhd, 0);
    be64(&mut tkhd, shown);
    tkhd.extend_from_slice(&[0; 8]);
    tkhd.extend_from_slice(&[0; 8]);
    for m in MATRIX {
        be32(&mut tkhd, m);
    }
    be32(&mut tkhd, t.width << 16);
    be32(&mut tkhd, t.height << 16);

    // the edit: from the first frame shown
    let mut elst = Vec::new();
    be32(&mut elst, 1);
    be64(&mut elst, shown);
    be64(&mut elst, first.max(0) as u64);
    elst.extend_from_slice(&[0, 1, 0, 0]);
    let edts = bx(b"edts", &full(b"elst", 1, 0, &elst));

    let mut mdhd = Vec::new();
    be64(&mut mdhd, 0);
    be64(&mut mdhd, 0);
    be32(&mut mdhd, t.timescale);
    be64(&mut mdhd, media);
    mdhd.extend_from_slice(&[0x55, 0xC4, 0, 0]);
    let mut hdlr = vec![0; 4];
    hdlr.extend_from_slice(b"vide");
    hdlr.extend_from_slice(&[0; 12]);
    hdlr.extend_from_slice(b"VideoHandler\0");

    let vmhd = full(b"vmhd", 0, 1, &[0; 8]);
    let mut dref = Vec::new();
    be32(&mut dref, 1);
    dref.extend_from_slice(&full(b"url ", 0, 1, &[]));
    let dinf = bx(b"dinf", &full(b"dref", 0, 0, &dref));

    // the sample entry: avc1 with its avcC
    let mut avcc = vec![1, t.sps[0][1], t.sps[0][2], t.sps[0][3], 0xFF, 0xE0 | t.sps.len() as u8];
    for p in &t.sps {
        avcc.extend_from_slice(&(p.len() as u16).to_be_bytes());
        avcc.extend_from_slice(p);
    }
    avcc.push(t.pps.len() as u8);
    for p in &t.pps {
        avcc.extend_from_slice(&(p.len() as u16).to_be_bytes());
        avcc.extend_from_slice(p);
    }
    let mut avc1 = vec![0; 6];
    avc1.extend_from_slice(&[0, 1]);
    avc1.extend_from_slice(&[0; 16]);
    avc1.extend_from_slice(&(t.width.min(0xFFFF) as u16).to_be_bytes());
    avc1.extend_from_slice(&(t.height.min(0xFFFF) as u16).to_be_bytes());
    be32(&mut avc1, 0x0048_0000);
    be32(&mut avc1, 0x0048_0000);
    be32(&mut avc1, 0);
    avc1.extend_from_slice(&[0, 1]);
    avc1.extend_from_slice(&[0; 32]);
    avc1.extend_from_slice(&[0, 0x18, 0xFF, 0xFF]);
    avc1.extend_from_slice(&bx(b"avcC", &avcc));
    let mut stsd = Vec::new();
    be32(&mut stsd, 1);
    stsd.extend_from_slice(&bx(b"avc1", &avc1));

    // how long each frame lasts (runs of the same)
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for (i, x) in s.iter().enumerate() {
        let d = s.get(i + 1).map(|n| n.dts - x.dts).unwrap_or(t.last).max(1) as u32;
        match runs.last_mut() {
            Some((n, v)) if *v == d => *n += 1,
            _ => runs.push((1, d)),
        }
    }
    let mut stts = Vec::new();
    be32(&mut stts, runs.len() as u32);
    for (n, v) in runs {
        be32(&mut stts, n);
        be32(&mut stts, v);
    }
    // when each is shown, after it's decoded
    let mut offs: Vec<(u32, u32)> = Vec::new();
    for x in s {
        let o = (x.pts - x.dts + lead) as u32;
        match offs.last_mut() {
            Some((n, v)) if *v == o => *n += 1,
            _ => offs.push((1, o)),
        }
    }
    let ctts = (offs.len() > 1 || offs.first().is_some_and(|o| o.1 != 0)).then(|| {
        let mut c = Vec::new();
        be32(&mut c, offs.len() as u32);
        for (n, v) in &offs {
            be32(&mut c, *n);
            be32(&mut c, *v);
        }
        full(b"ctts", 0, 0, &c)
    });
    let keys: Vec<u32> = s.iter().enumerate().filter(|(_, x)| x.key).map(|(i, _)| i as u32 + 1).collect();
    let stss = (keys.len() < s.len()).then(|| {
        let mut k = Vec::new();
        be32(&mut k, keys.len() as u32);
        for n in &keys {
            be32(&mut k, *n);
        }
        full(b"stss", 0, 0, &k)
    });
    let mut stsc = Vec::new();
    be32(&mut stsc, 1);
    be32(&mut stsc, 1);
    be32(&mut stsc, s.len() as u32);
    be32(&mut stsc, 1);
    let mut stsz = Vec::new();
    be32(&mut stsz, 0);
    be32(&mut stsz, s.len() as u32);
    for x in s {
        be32(&mut stsz, x.size);
    }
    let mut co64 = Vec::new();
    be32(&mut co64, 1);
    be64(&mut co64, offset);

    let mut stbl = full(b"stsd", 0, 0, &stsd);
    stbl.extend_from_slice(&full(b"stts", 0, 0, &stts));
    if let Some(c) = ctts {
        stbl.extend_from_slice(&c);
    }
    if let Some(k) = stss {
        stbl.extend_from_slice(&k);
    }
    stbl.extend_from_slice(&full(b"stsc", 0, 0, &stsc));
    stbl.extend_from_slice(&full(b"stsz", 0, 0, &stsz));
    stbl.extend_from_slice(&full(b"co64", 0, 0, &co64));

    let mut minf = vmhd;
    minf.extend_from_slice(&dinf);
    minf.extend_from_slice(&bx(b"stbl", &stbl));
    let mut mdia = full(b"mdhd", 1, 0, &mdhd);
    mdia.extend_from_slice(&full(b"hdlr", 0, 0, &hdlr));
    mdia.extend_from_slice(&bx(b"minf", &minf));
    let mut trak = full(b"tkhd", 1, 3, &tkhd);
    trak.extend_from_slice(&edts);
    trak.extend_from_slice(&bx(b"mdia", &mdia));
    let mut moov = full(b"mvhd", 1, 0, &mvhd);
    moov.extend_from_slice(&bx(b"trak", &trak));
    bx(b"moov", &moov)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes bits (and Exp-Golomb), for making H.264 headers to read back.
    #[derive(Default)]
    struct BitWriter {
        out: Vec<u8>,
        n: u32,
    }

    impl BitWriter {
        fn bit(&mut self, b: u32) {
            if self.n % 8 == 0 {
                self.out.push(0);
            }
            if b != 0 {
                *self.out.last_mut().unwrap() |= 0x80 >> (self.n % 8);
            }
            self.n += 1;
        }
        fn bits(&mut self, v: u32, n: u32) {
            for i in (0..n).rev() {
                self.bit((v >> i) & 1);
            }
        }
        fn ue(&mut self, v: u32) {
            let x = v as u64 + 1;
            let len = 64 - x.leading_zeros();
            self.bits(0, len - 1);
            for i in (0..len).rev() {
                self.bit(((x >> i) & 1) as u32);
            }
        }
        /// rbsp_trailing_bits, then emulation prevention, after the NAL header byte
        fn nal(mut self, header: u8) -> Vec<u8> {
            self.bit(1);
            while self.n % 8 != 0 {
                self.bit(0);
            }
            let mut out = vec![header];
            let mut zeros = 0;
            for b in self.out {
                if zeros >= 2 && b <= 3 {
                    out.push(3);
                    zeros = 0;
                }
                zeros = if b == 0 { zeros + 1 } else { 0 };
                out.push(b);
            }
            out
        }
    }

    /// High profile 4:2:0, `w`×`h` macroblocks, poc type 0 with 6-bit lsb, cropping at the bottom
    fn sps(w: u32, h: u32, crop_bottom: u32) -> Vec<u8> {
        let mut b = BitWriter::default();
        b.bits(100, 8);
        b.bits(0, 8);
        b.bits(40, 8);
        b.ue(0); // id
        b.ue(1); // chroma 4:2:0
        b.ue(0);
        b.ue(0);
        b.bit(0);
        b.bit(0); // no scaling matrix
        b.ue(0); // log2_max_frame_num 4
        b.ue(0); // poc type 0
        b.ue(2); // log2_max_poc_lsb 6
        b.ue(4);
        b.bit(0);
        b.ue(w - 1);
        b.ue(h - 1);
        b.bit(1); // frames only
        b.bit(1);
        if crop_bottom > 0 {
            b.bit(1);
            b.ue(0);
            b.ue(0);
            b.ue(0);
            b.ue(crop_bottom);
        } else {
            b.bit(0);
        }
        b.bit(0); // no VUI
        b.nal(0x67)
    }

    fn pps() -> Vec<u8> {
        let mut b = BitWriter::default();
        b.ue(0);
        b.ue(0);
        b.bit(1);
        b.nal(0x68)
    }

    /// A slice: IDR (header 0x65), reference P (0x41) or non-reference B (0x01), with its poc lsb
    fn slice(header: u8, frame_num: u32, poc_lsb: u32) -> Vec<u8> {
        let mut b = BitWriter::default();
        b.ue(0);
        b.ue(if header == 0x01 { 1 } else if header == 0x65 { 7 } else { 0 });
        b.ue(0);
        b.bits(frame_num, 4);
        if header & 0x1f == 5 {
            b.ue(0);
        }
        b.bits(poc_lsb, 6);
        // some made-up picture data
        b.bits(0xA5C3, 16);
        b.nal(header)
    }

    #[test]
    fn exp_golomb() {
        // 1 | 010 | 011 | 00100 | 00101 → 0, 1, 2, 3, 4 (and se: 0, 1, -1, 2, -2)
        let d = [0b1010_0110, 0b0100_0010, 0b1000_0000];
        let mut b = Bits::new(&d);
        assert_eq!([b.ue(), b.ue(), b.ue(), b.ue(), b.ue()], [Some(0), Some(1), Some(2), Some(3), Some(4)]);
        let mut b = Bits::new(&d);
        assert_eq!([b.se(), b.se(), b.se(), b.se(), b.se()], [Some(0), Some(1), Some(-1), Some(2), Some(-2)]);
    }

    #[test]
    fn reads_the_size_and_order_from_an_sps() {
        let (id, s) = parse_sps(&sps(80, 45, 0)).unwrap();
        assert_eq!((id, s.width, s.height, s.poc_type, s.log2_max_poc_lsb, s.log2_max_frame_num), (0, 1280, 720, 0, 6, 4));
        // 1088 rows coded, 8 cropped (4 units of 2 in 4:2:0)
        assert_eq!(parse_sps(&sps(120, 68, 4)).unwrap().1.height, 1080);
    }

    #[test]
    fn splits_annexb_and_lengths() {
        let d = [0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 4];
        assert_eq!(annexb(&d), vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 4][..]]);
        assert_eq!(length_prefixed(&[0, 0, 0, 2, 9, 9, 0, 0, 0, 1, 7], 4), Some(vec![&[9, 9][..], &[7][..]]));
        assert_eq!(length_prefixed(&[0, 0, 0, 9, 1], 4), None);
        // a length of 300 looks like a start code (00 00 01) followed by 0x2c
        let mut frame = vec![0, 0, 1, 0x2c, 0x01, 0x9e];
        frame.resize(304, 7);
        assert_eq!(split(&frame, 4, true), vec![&frame[4..]]);
        assert_eq!(split(&frame, 4, false), vec![&frame[3..]]);
        // and real start codes still work after an avcC
        assert_eq!(split(&[0, 0, 0, 1, 0x65, 9, 0, 0, 1, 0x41, 8], 4, true), vec![&[0x65, 9][..], &[0x41, 8][..]]);
    }

    /// RIFF chunk
    fn chunk(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut v = id.to_vec();
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        if data.len() % 2 == 1 {
            v.push(0);
        }
        v
    }

    fn list(kind: &[u8; 4], parts: &[Vec<u8>]) -> Vec<u8> {
        let mut body = kind.to_vec();
        for p in parts {
            body.extend_from_slice(p);
        }
        chunk(b"LIST", &body)
    }

    fn annexb_frame(nals: &[&[u8]]) -> Vec<u8> {
        nals.iter().flat_map(|n| [&[0u8, 0, 0, 1][..], n].concat()).collect()
    }

    /// An AVI at 25 fps: IDR (poc 0), P (poc 6), B (poc 2), B (poc 4), an empty chunk, P (poc 8)
    fn test_avi() -> Vec<u8> {
        let mut strh = b"vidsH264".to_vec();
        strh.extend_from_slice(&[0; 12]);
        strh.extend_from_slice(&1u32.to_le_bytes());
        strh.extend_from_slice(&25u32.to_le_bytes());
        strh.extend_from_slice(&[0; 28]);
        let mut strf = 40u32.to_le_bytes().to_vec();
        strf.extend_from_slice(&1280u32.to_le_bytes());
        strf.extend_from_slice(&720u32.to_le_bytes());
        strf.extend_from_slice(&[1, 0, 24, 0]);
        strf.extend_from_slice(b"H264");
        strf.extend_from_slice(&[0; 20]);
        let hdrl = list(b"hdrl", &[chunk(b"avih", &[0; 56]), list(b"strl", &[chunk(b"strh", &strh), chunk(b"strf", &strf)])]);
        let (s, p) = (sps(80, 45, 0), pps());
        let frames = [
            annexb_frame(&[&[0x09, 0xF0], &s, &p, &slice(0x65, 0, 0)]),
            annexb_frame(&[&slice(0x41, 1, 6)]),
            annexb_frame(&[&slice(0x01, 2, 2)]),
            annexb_frame(&[&slice(0x01, 2, 4)]),
            Vec::new(),
            annexb_frame(&[&slice(0x41, 2, 8)]),
        ];
        let movi = list(b"movi", &frames.iter().map(|f| chunk(b"00dc", f)).collect::<Vec<_>>());
        let mut riff = b"AVI ".to_vec();
        riff.extend_from_slice(&hdrl);
        riff.extend_from_slice(&movi);
        chunk(b"RIFF", &riff)
    }

    /// A box's body, found by its path of kinds
    fn find<'a>(d: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
        let mut i = 0;
        while i + 8 <= d.len() {
            let size = u32::from_be_bytes(d[i..i + 4].try_into().unwrap()) as usize;
            if size < 8 || i + size > d.len() {
                return None;
            }
            if &d[i + 4..i + 8] == path[0] {
                let body = &d[i + 8..i + size];
                if path.len() == 1 {
                    return Some(body);
                }
                // stsd's entries come after its own header; avc1's after its 78 bytes
                let skip = match path[0] {
                    b"stsd" => 8,
                    b"avc1" => 78,
                    _ => 0,
                };
                return find(&body[skip..], &path[1..]);
            }
            i += size;
        }
        None
    }

    fn u32s(body: &[u8]) -> Vec<u32> {
        body[4..].chunks_exact(4).map(|c| u32::from_be_bytes(c.try_into().unwrap())).collect()
    }

    const STBL: [&[u8; 4]; 5] = [b"moov", b"trak", b"mdia", b"minf", b"stbl"];

    fn stbl(mp4: &[u8], kind: &[u8; 4]) -> Option<Vec<u32>> {
        let mut path = STBL.to_vec();
        path.push(kind);
        find(mp4, &path).map(u32s)
    }

    #[test]
    fn rewraps_an_avi_with_b_frames() {
        let mp4 = convert(&test_avi()).unwrap();
        assert_eq!(&mp4[4..8], b"ftyp");
        // five pictures (the empty chunk is a repeated frame: no sample, but its time passes)
        let sizes = stbl(&mp4, b"stsz").unwrap();
        assert_eq!(sizes[1], 5);
        // decode times 0, 1, 2, 3, 5 (in 1/25 s): durations 1, 1, 1, 2, 1
        assert_eq!(stbl(&mp4, b"stts").unwrap(), vec![3, 3, 1, 1, 2, 1, 1]);
        // shown at 0, 3, 1, 2, 5 → offsets after decoding 0, 2, -1, -1, 0, plus 1 so none is below 0
        assert_eq!(stbl(&mp4, b"ctts").unwrap(), vec![4, 1, 1, 1, 3, 2, 0, 1, 1]);
        // the edit starts at the first frame shown (1 = time 0 + the 1 added)
        let elst = find(&mp4, &[b"moov", b"trak", b"edts", b"elst"]).unwrap();
        assert_eq!(u64::from_be_bytes(elst[16..24].try_into().unwrap()), 1);
        // only the IDR picture is a keyframe
        assert_eq!(stbl(&mp4, b"stss").unwrap(), vec![1, 1]);
        // its parameter sets moved into the avcC; the AUD went
        let avcc = find(&mp4, &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"avc1", b"avcC"]).unwrap();
        assert_eq!(avcc_params(avcc), vec![&sps(80, 45, 0)[..], &pps()[..]]);
        let mdat = mp4.windows(4).position(|w| w == b"mdat").unwrap() + 4;
        let first = u32::from_be_bytes(mp4[mdat..mdat + 4].try_into().unwrap()) as usize;
        assert_eq!(mp4[mdat + 4], 0x65);
        assert_eq!(first, slice(0x65, 0, 0).len());
        // the sample entry has the size from the SPS
        let avc1 = find(&mp4, &[b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd"]).unwrap();
        assert_eq!(&avc1[12..16], b"avc1");
        assert_eq!(u16::from_be_bytes(avc1[16 + 24..16 + 26].try_into().unwrap()), 1280);
    }

    #[test]
    fn rewraps_an_flv() {
        let (s, p) = (sps(80, 45, 0), pps());
        let mut rec = vec![1, s[1], s[2], s[3], 0xFF, 0xE1];
        rec.extend_from_slice(&(s.len() as u16).to_be_bytes());
        rec.extend_from_slice(&s);
        rec.push(1);
        rec.extend_from_slice(&(p.len() as u16).to_be_bytes());
        rec.extend_from_slice(&p);
        let tag = |ts: u32, data: Vec<u8>| {
            let mut t = vec![9];
            t.extend_from_slice(&(data.len() as u32).to_be_bytes()[1..]);
            t.extend_from_slice(&ts.to_be_bytes()[1..]);
            t.push(0);
            t.extend_from_slice(&[0, 0, 0]);
            t.extend_from_slice(&data);
            t.extend_from_slice(&(data.len() as u32 + 11).to_be_bytes());
            t
        };
        let video = |frame: u8, pkt: u8, cts: u32, payload: &[u8]| {
            let mut v = vec![(frame << 4) | 7, pkt];
            v.extend_from_slice(&cts.to_be_bytes()[1..]);
            v.extend_from_slice(payload);
            v
        };
        let nalu = |n: &[u8]| [&(n.len() as u32).to_be_bytes()[..], n].concat();
        let mut flv = b"FLV\x01\x01\0\0\0\x09\0\0\0\0".to_vec();
        flv.extend(tag(0, video(1, 0, 0, &rec)));
        flv.extend(tag(0, video(1, 1, 40, &nalu(&slice(0x65, 0, 0)))));
        flv.extend(tag(40, video(2, 1, 80, &nalu(&slice(0x41, 1, 4)))));
        flv.extend(tag(80, video(2, 1, 0, &nalu(&slice(0x01, 2, 2)))));
        let mp4 = convert(&flv).unwrap();
        assert_eq!(stbl(&mp4, b"stsz").unwrap()[1], 3);
        assert_eq!(stbl(&mp4, b"stts").unwrap(), vec![1, 3, 40]);
        // the FLV's own composition times: 40, 80, 0 → shown at 40, 120, 80
        assert_eq!(stbl(&mp4, b"ctts").unwrap(), vec![3, 1, 40, 1, 80, 1, 0]);
        let elst = find(&mp4, &[b"moov", b"trak", b"edts", b"elst"]).unwrap();
        assert_eq!(u64::from_be_bytes(elst[16..24].try_into().unwrap()), 40);
    }

    #[test]
    fn leaves_other_codecs_alone() {
        let avi = test_avi();
        let xvid: Vec<u8> = {
            let mut a = avi.clone();
            for at in [a.windows(4).position(|w| w == b"H264").unwrap(), a.windows(4).rposition(|w| w == b"H264").unwrap()] {
                a[at..at + 4].copy_from_slice(b"XVID");
            }
            a
        };
        assert!(convert(&xvid).is_none());
        let mut flv = b"FLV\x01\x01\0\0\0\x09\0\0\0\0".to_vec();
        flv.extend_from_slice(&[9, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0x12, 0, 0, 0, 0, 0, 0, 0, 0, 17]);
        assert!(convert(&flv).is_none());
        assert!(convert(b"not a video at all").is_none());
    }

    #[test]
    fn serves_only_its_own_keys() {
        let dir = std::env::temp_dir().join(format!("fumen-remux-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("videos")).unwrap();
        let src = dir.join("v.avi");
        std::fs::write(&src, test_avi()).unwrap();
        let key = mp4_for(&dir, "abc", &src).unwrap();
        assert!(key.starts_with(KEY_PREFIX));
        assert!(served(&dir, &key).is_some());
        // the second time from the cache
        assert_eq!(mp4_for(&dir, "abc", &src).unwrap(), key);
        assert!(served(&dir, "mp4-../../x").is_none());
        assert!(served(&dir, &"0".repeat(32)).is_none());
        // something else: remembered as not one to rewrap
        let other = dir.join("o.avi");
        std::fs::write(&other, b"RIFF\0\0\0\0AVI ").unwrap();
        assert!(mp4_for(&dir, "other", &other).is_none());
        assert!(std::fs::read_dir(dir.join("videos")).unwrap().flatten().any(|e| e.path().extension().is_some_and(|x| x == "none")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The library's .avi and .flv videos rewrapped into `FUMEN_REMUX_OUT`: run by hand
    /// (`cargo test --lib real_videos -- --ignored --nocapture`).
    #[test]
    #[ignore]
    fn real_videos() {
        let out = PathBuf::from(std::env::var("FUMEN_REMUX_OUT").expect("FUMEN_REMUX_OUT"));
        let files = std::env::var("FUMEN_REMUX_IN").expect("FUMEN_REMUX_IN");
        std::fs::create_dir_all(&out).unwrap();
        let (mut done, mut skipped) = (0, 0);
        for line in std::fs::read_to_string(files).unwrap().lines() {
            let path = Path::new(line.trim());
            let Ok(data) = std::fs::read(path) else { continue };
            let t = std::time::Instant::now();
            match convert(&data) {
                Some(mp4) => {
                    done += 1;
                    let name = path.file_name().unwrap().to_string_lossy();
                    std::fs::write(out.join(format!("{done:03}-{}.mp4", &name[..8.min(name.len())])), &mp4).unwrap();
                    println!("{done:03} {} MB in {:?}", data.len() / 1_000_000, t.elapsed());
                }
                None => skipped += 1,
            }
        }
        println!("rewrapped {done}, left {skipped}");
    }
}
