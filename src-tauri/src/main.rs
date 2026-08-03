#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod commands;
mod db;
mod glass;
mod panel;
mod tray;

use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            panel::show(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::add_entry,
            commands::toggle_done,
            commands::update_item,
            commands::delete_item,
            commands::clear_completed,
            commands::set_active_section,
            commands::create_section,
            commands::rename_section,
            commands::delete_section,
            commands::set_theme,
            commands::copy_text,
            commands::export_markdown,
            commands::capture_now,
            commands::hide_panel,
            commands::open_editor,
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::init(&data_dir.join("cooper.db"))?;
            let glass_on = db::get_setting(&conn, "theme").as_deref() == Some("glass");
            app.manage(db::Db(Mutex::new(conn)));

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            tray::create(app.handle())?;
            capture::register_fallback_shortcuts(app.handle());
            capture::start_double_shift_listener(app.handle().clone());

            if let Some(win) = app.get_webview_window("main") {
                panel::position(&win);
                if glass_on {
                    glass::apply(&win, true);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the panel hides it; the app lives in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Cooper");
}
