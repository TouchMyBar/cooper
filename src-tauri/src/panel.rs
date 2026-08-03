use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

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

pub fn show(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        position(&win);
        let _ = win.show();
        let _ = win.set_focus();
        let _ = app.emit("panel-shown", ());
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

pub fn toggle(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = win.hide();
        } else if visible {
            let _ = win.set_focus();
            let _ = app.emit("panel-shown", ());
        } else {
            show(app);
        }
    }
}
