//! Files only this Windows user can read back: the osu! login's tokens are sealed with Windows'
//! own data protection (DPAPI, tied to the user's Windows login), so a copy of the data folder,
//! a backup or another user on the PC gets nothing usable. Elsewhere the bytes are kept as they are.

/// What a sealed file starts with (older, plain files don't).
const MARK: &[u8] = b"fumen-sealed-1\n";

/// `plain` sealed for this user.
pub fn seal(plain: &[u8]) -> std::io::Result<Vec<u8>> {
    let sealed = imp::protect(plain)?;
    Ok([MARK, &sealed].concat())
}

/// The bytes of a file written by [`seal`]; a file from before sealing comes back as it is, with
/// `false` (so it gets sealed on the next write).
pub fn open(stored: &[u8]) -> Option<(Vec<u8>, bool)> {
    match stored.strip_prefix(MARK) {
        Some(sealed) => imp::unprotect(sealed).map(|p| (p, true)),
        None => Some((stored.to_vec(), false)),
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    /// Copies DPAPI's output and frees it.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        bytes
    }

    pub fn protect(plain: &[u8]) -> std::io::Result<Vec<u8>> {
        let input = blob(plain);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { take(out) })
    }

    pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        let input = blob(sealed);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        (ok != 0).then(|| unsafe { take(out) })
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn protect(plain: &[u8]) -> std::io::Result<Vec<u8>> {
        Ok(plain.to_vec())
    }

    pub fn unprotect(sealed: &[u8]) -> Option<Vec<u8>> {
        Some(sealed.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_bytes_open_again() {
        let plain = br#"{"access_token":"abc"}"#;
        let sealed = seal(plain).unwrap();
        assert!(sealed.starts_with(MARK));
        #[cfg(windows)]
        assert!(!sealed.windows(3).any(|w| w == b"abc"), "the token isn't readable in the file");
        assert_eq!(open(&sealed), Some((plain.to_vec(), true)));
        // a plain file from before
        assert_eq!(open(plain), Some((plain.to_vec(), false)));
        // a broken sealed file
        #[cfg(windows)]
        assert_eq!(open(&[MARK, b"junk"].concat()), None);
    }
}
