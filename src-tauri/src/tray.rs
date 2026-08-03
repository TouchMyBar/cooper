use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

use crate::{capture, panel};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show / Hide Cooper", true, None::<&str>)?;
    let cap_clip = MenuItem::with_id(app, "capture-clipboard", "Capture clipboard", true, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart =
        CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Cooper", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &cap_clip,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let autostart_item = autostart.clone();
    TrayIconBuilder::with_id("cooper-tray")
        .icon(
            app.default_window_icon()
                .expect("app icon missing")
                .clone(),
        )
        .tooltip("Cooper — double-tap Right Shift to open")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => panel::toggle(app),
            "capture-clipboard" => capture::capture_clipboard(app),
            "autostart" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let result = if enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };
                if let Err(e) = result {
                    eprintln!("cooper: autostart toggle failed: {e}");
                }
                let _ = autostart_item.set_checked(app.autolaunch().is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                panel::toggle(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
