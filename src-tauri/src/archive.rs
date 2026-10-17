//! A downloaded set checked before it goes anywhere near osu!lazer. Mirrors aren't osu!: one that
//! is broken, hacked or hostile could hand out a different set than the one asked for (lazer would
//! then treat it as that set), a zip bomb, or paths that try to leave the set's folder. Only the
//! zip's directory and the start of each `.osu` are read; nothing is unpacked.

use std::io::Read;
use std::path::Path;

/// Bigger than any real set (the largest, with video, are a few hundred MB).
pub const MAX_DOWNLOAD: u64 = 500 * 1024 * 1024;
const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
/// An entry that grows more than this much when unpacked (and is big) is a bomb, not a beatmap.
const MAX_RATIO: u64 = 200;
/// How much of a `.osu` is read to find its set ID ([Metadata] is near the top).
const HEAD: u64 = 256 * 1024;

/// Ok if `path` looks like set `set`, else why not (in words, for the mirror's failure line).
pub fn check_set(path: &Path, set: u32) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "not a beatmap archive".to_string())?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("{} files in the archive", zip.len()));
    }
    let mut unpacked = 0u64;
    let mut charts = Vec::new();
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|e| e.to_string())?;
        let name = entry.name().replace('\\', "/");
        if !safe_name(&name) {
            return Err(format!("a file that leaves the set's folder ({name})"));
        }
        let size = entry.size();
        unpacked = unpacked.saturating_add(size);
        if size > 16 * 1024 * 1024 && size / entry.compressed_size().max(1) > MAX_RATIO {
            return Err(format!("a file that unpacks {}x bigger ({name})", size / entry.compressed_size().max(1)));
        }
        if name.to_ascii_lowercase().ends_with(".osu") {
            charts.push(i);
        }
    }
    if unpacked > MAX_UNPACKED {
        return Err(format!("{} MB unpacked", unpacked / 1024 / 1024));
    }
    if charts.is_empty() {
        return Err("no difficulties in the archive".into());
    }
    for i in charts {
        let entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let mut head = Vec::new();
        entry.take(HEAD).read_to_end(&mut head).map_err(|e| e.to_string())?;
        if let Some(found) = set_id(&String::from_utf8_lossy(&head)) {
            if found != set {
                return Err(format!("set {found} instead of {set}"));
            }
        }
    }
    Ok(())
}

/// No absolute paths, drive letters or `..`: the archive's files stay inside the set.
fn safe_name(name: &str) -> bool {
    !name.starts_with('/') && !name.contains(':') && !name.split('/').any(|part| part == "..") && !name.contains('\0')
}

/// `BeatmapSetID:` of a `.osu` when it names one (older charts have none, unsubmitted ones -1).
fn set_id(text: &str) -> Option<u32> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("BeatmapSetID:"))
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|&v| v > 0)
        .and_then(|v| u32::try_from(v).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn osz(files: &[(&str, &str)]) -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("fumen-archive-{}-{n}.osz", std::process::id()));
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, body) in files {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    const CHART: &str = "osu file format v14\n\n[General]\nAudioFilename: audio.mp3\n\n[Metadata]\nTitle:Song\nBeatmapID:75\nBeatmapSetID:1\n";

    #[test]
    fn the_set_asked_for_passes() {
        let p = osz(&[("Song [Easy].osu", CHART), ("audio.mp3", "ID3")]);
        assert_eq!(check_set(&p, 1), Ok(()));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn another_set_is_refused() {
        let p = osz(&[("Song [Easy].osu", CHART), ("bg.jpg", "x")]);
        assert_eq!(check_set(&p, 2), Err("set 1 instead of 2".into()));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn charts_without_a_set_id_pass() {
        let old = CHART.replace("BeatmapSetID:1\n", "BeatmapSetID:-1\n");
        let p = osz(&[("old.osu", &old), ("a.mp3", "x"), ("b.png", "x")]);
        assert_eq!(check_set(&p, 9), Ok(()));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn paths_out_of_the_set_and_empty_sets_are_refused() {
        let p = osz(&[("../../evil.osu", CHART)]);
        assert!(check_set(&p, 1).unwrap_err().contains("leaves"));
        let _ = std::fs::remove_file(p);
        let p = osz(&[("C:/Windows/evil.osu", CHART), ("x", "y")]);
        assert!(check_set(&p, 1).unwrap_err().contains("leaves"));
        let _ = std::fs::remove_file(p);
        let p = osz(&[("audio.mp3", "x"), ("bg.jpg", "y"), ("v.mp4", "z"), ("s.wav", "w")]);
        assert_eq!(check_set(&p, 1), Err("no difficulties in the archive".into()));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn not_a_zip_is_refused() {
        let path = std::env::temp_dir().join(format!("fumen-archive-{}-junk.osz", std::process::id()));
        std::fs::write(&path, b"PK\x03\x04 not really a zip at all").unwrap();
        assert!(check_set(&path, 1).is_err());
        let _ = std::fs::remove_file(path);
    }
}
