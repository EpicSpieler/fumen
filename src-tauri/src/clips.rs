//! Clips OBS saved from its replay buffer after a good moment (docs/OBS.md): named after the map
//! when wanted, shown in their folder. Only video files OBS writes are touched, and only within
//! their own folder.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

/// What OBS writes a replay as.
const VIDEO: &[&str] = &["mp4", "mkv", "mov", "flv", "ts", "m4v", "webm"];

/// `path` as a clip OBS wrote: an existing video file.
fn clip(path: &str) -> Result<PathBuf> {
    let p = PathBuf::from(path);
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    if !VIDEO.contains(&ext.as_str()) || !p.is_file() {
        return Err(Error::known("clip", "That isn't a clip OBS saved."));
    }
    Ok(p)
}

/// A file name from a map's name: no characters Windows forbids, no control characters, spaces
/// squeezed, no dots at the ends, at most 120 characters.
pub fn file_name(name: &str) -> String {
    let swapped: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { ' ' } else { c }).collect();
    let squeezed = swapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = squeezed.trim_matches('.').chars().take(120).collect();
    cut.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string()
}

/// The clip at `path` named `name` in its folder (a number added when that's taken); its new path.
pub fn rename(path: &str, name: &str) -> Result<String> {
    let from = clip(path)?;
    let clean = file_name(name);
    if clean.is_empty() {
        return Ok(path.to_string());
    }
    let dir = from.parent().ok_or_else(|| Error::known("clip", "That isn't a clip OBS saved."))?;
    let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();
    let to = free_name(dir, &clean, &ext);
    std::fs::rename(&from, &to)?;
    Ok(to.to_string_lossy().into_owned())
}

fn free_name(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let mut to = dir.join(format!("{name}.{ext}"));
    let mut n = 2;
    while to.exists() {
        to = dir.join(format!("{name} ({n}).{ext}"));
        n += 1;
    }
    to
}

/// Opens the clip's folder with the clip picked.
pub fn reveal(path: &str) -> Result<()> {
    let p = clip(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer takes "/select," and the path as one argument, quoted as it is
        std::process::Command::new("explorer.exe").raw_arg(format!("/select,\"{}\"", p.display())).spawn()?;
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg("-R").arg(&p).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(Path::new("."))).spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_safe_for_files() {
        assert_eq!(file_name("Ready Steady [Hi-Fi] FC 2026-11-11 21-05"), "Ready Steady [Hi-Fi] FC 2026-11-11 21-05");
        assert_eq!(file_name("a/b\\c:d*e?f\"g<h>i|j"), "a b c d e f g h i j");
        assert_eq!(file_name("  ..odd\tname..  "), "odd name");
        assert_eq!(file_name(&"x".repeat(300)).len(), 120);
        assert_eq!(file_name("..."), "");
    }

    #[test]
    fn renames_only_clips_in_their_folder() {
        let dir = std::env::temp_dir().join(format!("fumen-clips-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("Replay 1.mp4");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(dir.join("Map [Hard] FC.mp4"), b"taken").unwrap();
        let to = rename(a.to_str().unwrap(), "Map [Hard] FC").unwrap();
        assert_eq!(PathBuf::from(&to), dir.join("Map [Hard] FC (2).mp4"));
        assert!(!a.exists());
        // not a video: left alone
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(rename(txt.to_str().unwrap(), "x").is_err());
        assert!(txt.exists());
        // a name can't climb out of the folder
        let b = dir.join("Replay 2.mkv");
        std::fs::write(&b, b"x").unwrap();
        let to = rename(b.to_str().unwrap(), "../../evil").unwrap();
        assert_eq!(PathBuf::from(&to).parent().unwrap(), dir.as_path());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
