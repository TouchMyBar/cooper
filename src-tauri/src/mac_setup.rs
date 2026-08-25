//! Works out why double-shift isn't working yet, so the UI can give the user
//! the one instruction that actually applies to them.
//!
//! Order matters. Granting Accessibility to a translocated copy is wasted
//! effort: Gatekeeper runs quarantined apps from a read-only `nullfs` mount
//! whose path is a fresh UUID every launch, so the grant can never stick.
//! De-translocation therefore has to come first.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use crate::commands::MacSetup;
use crate::mac_tap;

const MNT_RDONLY: u32 = 0x0000_0001;
const MNT_QUARANTINE: u32 = 0x0000_0400;
/// Bit set in the quarantine flags once the user has approved the app.
const QTN_APPROVED: u32 = 0x0040;

fn statfs_of(path: &Path) -> Option<libc::statfs> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut sb: libc::statfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statfs(c.as_ptr(), &mut sb) } == 0).then_some(sb)
}

fn c_field(field: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = field
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `.../Cooper.app/Contents/MacOS/cooper` -> `.../Cooper.app`
fn bundle_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// The quarantine flag word, read from the *real* path — it isn't visible
/// through the translocated mount.
fn quarantine_flags(path: &Path) -> Option<u32> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    let name = CString::new("com.apple.quarantine").ok()?;
    let mut buf = [0u8; 256];
    let n = unsafe {
        libc::getxattr(
            c.as_ptr(),
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            buf.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    if n <= 0 {
        return None;
    }
    let text = std::str::from_utf8(&buf[..n as usize]).ok()?;
    u32::from_str_radix(text.split(';').next()?, 16).ok()
}

pub fn state() -> MacSetup {
    let mut out = MacSetup {
        applicable: true,
        tap_running: mac_tap::is_running(),
        trusted: mac_tap::is_trusted(),
        translocated: false,
        real_path: String::new(),
        on_read_only_volume: false,
        will_translocate: false,
    };

    // A dev build run straight from target/debug has no bundle; nothing below
    // applies to it, and it is not a state any user can be in.
    let Some(running_from) = bundle_path() else {
        out.real_path = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        return out;
    };

    let Some(sb) = statfs_of(&running_from) else {
        out.real_path = running_from.to_string_lossy().into_owned();
        return out;
    };
    out.translocated =
        c_field(&sb.f_fstypename) == "nullfs" && c_field(&sb.f_mntonname).contains("/AppTranslocation/");

    let real = if out.translocated {
        PathBuf::from(c_field(&sb.f_mntfromname))
    } else {
        running_from
    };
    out.on_read_only_volume = statfs_of(&real)
        .map(|s| s.f_flags & MNT_RDONLY != 0 || s.f_flags & MNT_QUARANTINE != 0)
        .unwrap_or(false);
    // Still carrying an unapproved quarantine flag means Gatekeeper will run
    // the next launch from a temporary copy again.
    out.will_translocate = !out.translocated
        && matches!(quarantine_flags(&real), Some(f) if f & QTN_APPROVED == 0);
    out.real_path = real.to_string_lossy().into_owned();
    out
}

/// Open System Preferences straight to the Accessibility list. The legacy
/// `preference.security` URL is the one that works on Monterey *and* on the
/// System Settings of later releases, so no version check is needed.
pub fn open_accessibility_settings() {
    // Monterey ignores the anchor if System Preferences is already sitting on
    // another pane, so close it first.
    let _ = std::process::Command::new("osascript")
        .args(["-e", "tell application \"System Preferences\" to quit"])
        .status();
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .spawn();
}

/// Strip the quarantine flag so Gatekeeper stops running Cooper from a
/// temporary copy. Fails harmlessly when the bundle is on a read-only volume.
pub fn remove_quarantine(path: &str) -> Result<(), String> {
    let out = std::process::Command::new("xattr")
        .args(["-dr", "com.apple.quarantine", path])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}
