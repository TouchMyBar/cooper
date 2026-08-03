use tauri::{AppHandle, Manager, WebviewWindow};

/// Toggle the "liquid glass" backdrop on a window, using the cheapest
/// compositor-backed effect each platform offers:
/// - Windows: DWM acrylic (GPU-composited, no per-frame app work)
/// - macOS: NSVisualEffectView vibrancy (native material system)
/// - Linux: no cross-compositor blur API exists — the translucent CSS theme is
///   used as-is, and compositors like KWin/picom can blur it if configured.
pub fn apply(window: &WebviewWindow, enable: bool) {
    let win = window.clone();
    // Effect APIs must run on the main thread (hard requirement on macOS).
    let _ = window.run_on_main_thread(move || set_effect(&win, enable));
}

pub fn apply_all(app: &AppHandle, enable: bool) {
    for window in app.webview_windows().values() {
        apply(window, enable);
    }
}

#[cfg(target_os = "windows")]
fn set_effect(window: &WebviewWindow, enable: bool) {
    if enable {
        let dark = !matches!(window.theme(), Ok(tauri::Theme::Light));
        let tint = if dark {
            (20, 20, 28, 120)
        } else {
            (242, 242, 248, 120)
        };
        if let Err(e) = window_vibrancy::apply_acrylic(window, Some(tint)) {
            eprintln!("cooper: acrylic unavailable: {e}");
        }
    } else if let Err(e) = window_vibrancy::clear_acrylic(window) {
        eprintln!("cooper: clear acrylic failed: {e}");
    }
}

#[cfg(target_os = "macos")]
fn set_effect(window: &WebviewWindow, enable: bool) {
    use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
    if enable {
        if let Err(e) = window_vibrancy::apply_vibrancy(
            window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            Some(12.0),
        ) {
            eprintln!("cooper: vibrancy unavailable: {e}");
        }
    } else if let Err(e) = window_vibrancy::clear_vibrancy(window) {
        eprintln!("cooper: clear vibrancy failed: {e}");
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn set_effect(_window: &WebviewWindow, _enable: bool) {}
