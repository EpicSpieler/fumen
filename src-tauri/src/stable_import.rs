//! Imports into osu!stable: the one exception to "Fumen never writes stable's files". A set
//! downloaded from the mirrors (checked by `archive::check_set` like every download) goes into
//! stable's Songs folder as `<set id>.osz`; stable imports it the next time it starts, with its own
//! code, and Fumen's library picks it up from osu!.db after that.
//!
//! Only while `Settings::stable_import` is on (turned on behind two warnings in Settings ›
//! osu!stable). Nothing in the Songs folder is ever replaced or removed: a set whose file is
//! already there is left alone.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// Where a set's .osz goes in stable's Songs folder.
pub fn target(songs: &Path, set: u32) -> PathBuf {
    songs.join(format!("{set}.osz"))
}

/// The set is already waiting in the Songs folder for stable's next start.
pub fn waiting(songs: &Path, set: u32) -> bool {
    target(songs, set).exists()
}

/// Puts a downloaded .osz into stable's Songs folder. It's copied under a name stable doesn't
/// look at first and renamed when it's all there, so stable never sees half a file; the download
/// is removed afterwards.
pub fn put(osz: &Path, songs: &Path, set: u32) -> Result<()> {
    if !songs.is_dir() {
        return Err(Error::known("stable-not-found", "osu!stable's Songs folder wasn't found."));
    }
    let target = target(songs, set);
    if target.exists() {
        return Err(Error::known("stable-waiting", "Already waiting in osu!stable's Songs folder"));
    }
    let part = songs.join(format!("{set}.osz.fumen-part"));
    let result = std::fs::copy(osz, &part).and_then(|_| std::fs::rename(&part, &target));
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result?;
    let _ = std::fs::remove_file(osz);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_set_goes_into_the_songs_folder_once() {
        let dir = std::env::temp_dir().join(format!("fumen-stable-songs-drop-{}", std::process::id()));
        let songs = dir.join("Songs");
        std::fs::create_dir_all(&songs).unwrap();
        let dl = dir.join("123.osz");
        std::fs::write(&dl, b"osz").unwrap();

        assert!(!waiting(&songs, 123));
        put(&dl, &songs, 123).unwrap();
        assert!(waiting(&songs, 123));
        assert_eq!(std::fs::read(songs.join("123.osz")).unwrap(), b"osz");
        assert!(!dl.exists(), "the download is gone");
        assert!(!songs.join("123.osz.fumen-part").exists());

        // never replaced
        std::fs::write(&dl, b"other").unwrap();
        assert_eq!(put(&dl, &songs, 123).unwrap_err().code(), "stable-waiting");
        assert_eq!(std::fs::read(songs.join("123.osz")).unwrap(), b"osz");

        // no Songs folder, nothing written
        assert_eq!(put(&dl, &dir.join("nope"), 5).unwrap_err().code(), "stable-not-found");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
