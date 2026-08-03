use tauri::{AppHandle, Emitter, Manager, State};

use crate::{capture, db, glass, panel};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn refresh(app: &AppHandle) {
    let _ = app.emit("refresh", ());
}

#[tauri::command]
pub fn get_state(db: State<db::Db>) -> CmdResult<db::AppState> {
    let conn = db.0.lock().map_err(err)?;
    db::get_state(&conn).map_err(err)
}

/// Add a note/prompt from the input. A line of the form "# Name" creates (or
/// switches to) a section instead of adding an item.
#[tauri::command]
pub fn add_entry(app: AppHandle, db: State<db::Db>, content: String) -> CmdResult<()> {
    let text = content.trim();
    if text.is_empty() {
        return Ok(());
    }
    let conn = db.0.lock().map_err(err)?;
    if let Some(name) = text.strip_prefix("# ") {
        let name = name.trim();
        if !name.is_empty() {
            let id = db::find_or_create_section(&conn, name).map_err(err)?;
            db::set_active_section(&conn, Some(id)).map_err(err)?;
        }
    } else {
        let active = db::get_active_section(&conn);
        db::insert_item(&conn, text, active).map_err(err)?;
    }
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn toggle_done(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE items SET done = 1 - done, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, db::now_ms()],
    )
    .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn update_item(app: AppHandle, db: State<db::Db>, id: i64, content: String) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE items SET content = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, content.trim(), db::now_ms()],
    )
    .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_item(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![id])
        .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn clear_completed(app: AppHandle, db: State<db::Db>) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute("DELETE FROM items WHERE done = 1", [])
        .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn set_active_section(app: AppHandle, db: State<db::Db>, id: Option<i64>) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    db::set_active_section(&conn, id).map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn create_section(app: AppHandle, db: State<db::Db>, name: String) -> CmdResult<i64> {
    let conn = db.0.lock().map_err(err)?;
    let id = db::find_or_create_section(&conn, name.trim()).map_err(err)?;
    db::set_active_section(&conn, Some(id)).map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(id)
}

#[tauri::command]
pub fn rename_section(app: AppHandle, db: State<db::Db>, id: i64, name: String) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE sections SET name = ?2 WHERE id = ?1",
        rusqlite::params![id, name.trim()],
    )
    .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

/// Delete a section; its items fall back to the unfiled group.
#[tauri::command]
pub fn delete_section(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE items SET section_id = NULL WHERE section_id = ?1",
        rusqlite::params![id],
    )
    .map_err(err)?;
    conn.execute("DELETE FROM sections WHERE id = ?1", rusqlite::params![id])
        .map_err(err)?;
    if db::get_active_section(&conn) == Some(id) {
        db::set_active_section(&conn, None).map_err(err)?;
    }
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn set_theme(app: AppHandle, db: State<db::Db>, theme: String) -> CmdResult<()> {
    {
        let conn = db.0.lock().map_err(err)?;
        db::set_setting(&conn, "theme", &theme).map_err(err)?;
    }
    glass::apply_all(&app, theme == "glass");
    Ok(())
}

#[tauri::command]
pub fn copy_text(text: String) -> CmdResult<()> {
    let mut clip = arboard::Clipboard::new().map_err(err)?;
    clip.set_text(text).map_err(err)
}

/// Write all sections/items to a Markdown file in Documents and return its path.
#[tauri::command]
pub fn export_markdown(app: AppHandle, db: State<db::Db>) -> CmdResult<String> {
    use tauri::path::BaseDirectory;
    let conn = db.0.lock().map_err(err)?;
    let state = db::get_state(&conn).map_err(err)?;
    drop(conn);

    let mut md = String::from("# Cooper export\n\n");
    let write_items = |md: &mut String, section_id: Option<i64>| {
        for item in state.items.iter().filter(|i| i.section_id == section_id) {
            let mark = if item.done { "x" } else { " " };
            let content = item.content.replace('\n', "\n  ");
            md.push_str(&format!("- [{mark}] {content}\n"));
        }
    };
    if state.items.iter().any(|i| i.section_id.is_none()) {
        write_items(&mut md, None);
        md.push('\n');
    }
    for section in &state.sections {
        md.push_str(&format!("## {}\n\n", section.name));
        write_items(&mut md, Some(section.id));
        md.push('\n');
    }

    let dir = app
        .path()
        .resolve("", BaseDirectory::Document)
        .map_err(err)?;
    let path = dir.join("cooper-export.md");
    std::fs::write(&path, md).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn capture_now(app: AppHandle) {
    capture::capture_selection(&app);
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

#[tauri::command]
pub fn open_editor(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let label = format!("editor-{id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.set_focus();
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("index.html#/edit/{id}").into()),
    )
    .title("Edit — Cooper")
    .inner_size(460.0, 360.0)
    .min_inner_size(320.0, 240.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .center()
    .build()
    .map_err(err)?;

    let glass_on = {
        let conn = db.0.lock().map_err(err)?;
        db::get_setting(&conn, "theme").as_deref() == Some("glass")
    };
    if glass_on {
        glass::apply(&win, true);
    }
    Ok(())
}
