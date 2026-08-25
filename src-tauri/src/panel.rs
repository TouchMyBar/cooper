use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

/// On Windows, hiding an always-on-top window does not reliably hand focus
/// back, so we remember the foreground window before taking focus and restore
/// it on hide. macOS (accessory app) and Linux WMs return focus on their own.
#[cfg(windows)]
mod foreground {
    use std::sync::atomic::{AtomicIsize, Ordering};

    static LAST: AtomicIsize = AtomicIsize::new(0);

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn SetForegroundWindow(hwnd: isize) -> i32;
    }

    pub fn remember() {
        unsafe { LAST.store(GetForegroundWindow(), Ordering::Relaxed) }
    }

    pub fn restore() {
        let hwnd = LAST.swap(0, Ordering::Relaxed);
        if hwnd != 0 {
            unsafe { SetForegroundWindow(hwnd) };
        }
    }
}

#[cfg(not(windows))]
mod foreground {
    pub fn remember() {}
    pub fn restore() {}
}

/// Dock the panel to the right edge of the monitor it's on, vertically centered.
pub fn position(win: &WebviewWindow) {
    let monitor = match win.current_monitor() {
        Ok(Some(m)) => m,
        _ => match win.primary_monitor() {
            Ok(Some(m)) => m,
            _ => return,
        },
    };
    let msize = monitor.size();
    let mpos = monitor.position();
    let scale = monitor.scale_factor();
    let wsize = match win.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let margin = (16.0 * scale) as i32;
    let x = mpos.x + msize.width as i32 - wsize.width as i32 - margin;
    let y = mpos.y + ((msize.height as i32 - wsize.height as i32) / 2).max(margin);
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// Run a window operation on the main thread.
///
/// macOS only: the double-shift listener calls these from its own event-tap
/// thread, where `is_visible()`/`is_focused()` fail. `toggle` reads those
/// through `unwrap_or(false)`, so off-thread it always concluded the panel was
/// hidden and took the "show" branch — meaning Right Shift x2 could never hide
/// the panel, and re-showing an already-visible one looked like a dead
/// shortcut. Other platforms keep calling these inline, where they already work.
fn on_main(app: &AppHandle, f: impl FnOnce(&AppHandle) + Send + 'static) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || f(&handle));
    }
    #[cfg(not(target_os = "macos"))]
    f(app);
}

pub fn show(app: &AppHandle) {
    on_main(app, show_now);
}

pub fn hide(app: &AppHandle) {
    on_main(app, hide_now);
}

pub fn toggle(app: &AppHandle) {
    on_main(app, toggle_now);
}

fn show_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if !win.is_focused().unwrap_or(false) {
            foreground::remember();
        }
        position(&win);
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit("panel-shown", ());
    }
}

fn hide_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
        foreground::restore();
    }
}

fn toggle_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
            foreground::restore();
        } else if visible {
            foreground::remember();
            let _ = win.set_focus();
            let _ = app.emit("panel-shown", ());
        } else {
            show_now(app);
        }
    }
}
