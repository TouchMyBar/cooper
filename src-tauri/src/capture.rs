use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::{db, panel};

/// Marker written to the clipboard before simulating copy, so we can tell
/// "nothing was selected" apart from "the same text was copied again".
const SENTINEL: &str = "\u{200B}cooper::capturing\u{200B}";
const TAP_WINDOW: Duration = Duration::from_millis(400);
const HOLD_LIMIT: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Left,
    Right,
}

/// Global low-level keyboard listener: Left Shift x2 captures the current
/// selection, Right Shift x2 toggles the panel. Runs on its own thread; if the
/// OS denies the hook (e.g. missing macOS accessibility permission, Wayland),
/// the fallback shortcuts registered below still work.
pub fn start_double_shift_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let mut pressed: Option<(Side, Instant)> = None;
        let mut dirty = false; // a non-shift key was pressed while shift was held
        let mut last_tap: Option<(Side, Instant)> = None;

        let result = rdev::listen(move |event| {
            use rdev::{EventType, Key};
            match event.event_type {
                EventType::KeyPress(Key::ShiftLeft) => {
                    if pressed.is_none() {
                        pressed = Some((Side::Left, Instant::now()));
                        dirty = false;
                    }
                }
                EventType::KeyPress(Key::ShiftRight) => {
                    if pressed.is_none() {
                        pressed = Some((Side::Right, Instant::now()));
                        dirty = false;
                    }
                }
                EventType::KeyPress(_) => {
                    dirty = true;
                    last_tap = None;
                }
                EventType::KeyRelease(Key::ShiftLeft) | EventType::KeyRelease(Key::ShiftRight) => {
                    let side = if matches!(event.event_type, EventType::KeyRelease(Key::ShiftLeft)) {
                        Side::Left
                    } else {
                        Side::Right
                    };
                    let tap_ok = matches!(
                        pressed,
                        Some((s, t)) if s == side && !dirty && t.elapsed() < HOLD_LIMIT
                    );
                    pressed = None;
                    if !tap_ok {
                        last_tap = None;
                        return;
                    }
                    if let Some((s, t)) = last_tap {
                        if s == side && t.elapsed() < TAP_WINDOW {
                            last_tap = None;
                            match side {
                                Side::Left => capture_selection(&app),
                                Side::Right => panel::toggle(&app),
                            }
                            return;
                        }
                    }
                    last_tap = Some((side, Instant::now()));
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            eprintln!("cooper: global keyboard listener unavailable ({e:?}); double-shift shortcuts disabled, fallback hotkeys still active");
        }
    });
}

/// Standard hotkeys for environments where the raw keyboard hook is
/// unavailable (Wayland, denied permissions) or if the user prefers them.
pub fn register_fallback_shortcuts(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    if let Err(e) = gs.on_shortcut("CmdOrCtrl+Shift+Space", |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            panel::toggle(app);
        }
    }) {
        eprintln!("cooper: could not register CmdOrCtrl+Shift+Space: {e}");
    }
    if let Err(e) = gs.on_shortcut("CmdOrCtrl+Shift+C", |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            capture_selection(app);
        }
    }) {
        eprintln!("cooper: could not register CmdOrCtrl+Shift+C: {e}");
    }
}

/// Capture whatever text is selected in the foreground app by simulating the
/// platform copy chord and reading the clipboard.
pub fn capture_selection(app: &AppHandle) {
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    if CAPTURING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = do_capture(&app) {
            eprintln!("cooper: capture failed: {e}");
        }
        CAPTURING.store(false, Ordering::SeqCst);
    });
}

fn do_capture(app: &AppHandle) -> Result<(), String> {
    let mut clip = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let old = clip.get_text().ok();
    let _ = clip.set_text(SENTINEL.to_string());

    // Let the user's shift release settle before injecting the copy chord.
    std::thread::sleep(Duration::from_millis(60));
    send_copy()?;

    let mut captured = None;
    for _ in 0..14 {
        std::thread::sleep(Duration::from_millis(50));
        if let Ok(text) = clip.get_text() {
            if text != SENTINEL && !text.trim().is_empty() {
                captured = Some(text);
                break;
            }
        }
    }

    match captured {
        Some(text) => {
            add_text_item(app, text.trim())?;
            // The text stays on the clipboard — the user did just copy it.
        }
        None => {
            // Nothing was selected; put the previous clipboard back.
            match old {
                Some(o) => {
                    let _ = clip.set_text(o);
                }
                None => {
                    let _ = clip.clear();
                }
            }
        }
    }
    Ok(())
}

/// Capture the clipboard as-is, without simulating a copy (tray menu action).
pub fn capture_clipboard(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let text = arboard::Clipboard::new()
            .ok()
            .and_then(|mut c| c.get_text().ok())
            .unwrap_or_default();
        if !text.trim().is_empty() {
            let _ = add_text_item(&app, text.trim());
        }
    });
}

fn add_text_item(app: &AppHandle, text: &str) -> Result<(), String> {
    let db = app.state::<db::Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let active = db::get_active_section(&conn);
    db::insert_item(&conn, text, active).map_err(|e| e.to_string())?;
    drop(conn);
    let _ = app.emit("refresh", ());
    let _ = app.emit("captured", ());
    Ok(())
}

fn send_copy() -> Result<(), String> {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let modifier = Key::Meta;
    #[cfg(not(target_os = "macos"))]
    let modifier = Key::Control;
    enigo.key(modifier, Direction::Press).map_err(|e| e.to_string())?;
    enigo
        .key(Key::Unicode('c'), Direction::Click)
        .map_err(|e| e.to_string())?;
    enigo
        .key(modifier, Direction::Release)
        .map_err(|e| e.to_string())?;
    Ok(())
}
