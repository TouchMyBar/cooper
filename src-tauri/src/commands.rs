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
    if let Some(name) = text.strip_prefix("## ") {
        // "## Name" starts a fresh workspace: the new section becomes active and
        // everything else collapses out of the active area.
        let name = name.trim();
        if !name.is_empty() {
            let id = db::find_or_create_section(&conn, name).map_err(err)?;
            conn.execute(
                "UPDATE sections SET collapsed = CASE WHEN id = ?1 THEN 0 ELSE 1 END",
                rusqlite::params![id],
            )
            .map_err(err)?;
            db::set_active_section(&conn, Some(id)).map_err(err)?;
        }
    } else if let Some(name) = text.strip_prefix("# ") {
        let name = name.trim();
        if !name.is_empty() {
            let id = db::find_or_create_section(&conn, name).map_err(err)?;
            conn.execute(
                "UPDATE sections SET collapsed = 0 WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(err)?;
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

/// Collect the on-disk paths of image items matching a WHERE clause, so their
/// backing files can be removed alongside the rows.
fn image_files(conn: &rusqlite::Connection, where_sql: &str, id: i64) -> Vec<String> {
    let sql = format!("SELECT content FROM items WHERE kind = 'image' AND {where_sql}");
    conn.prepare(&sql)
        .and_then(|mut stmt| {
            stmt.query_map(rusqlite::params![id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn delete_item(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    let files = image_files(&conn, "id = ?1", id);
    conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![id])
        .map_err(err)?;
    drop(conn);
    for f in files {
        let _ = std::fs::remove_file(f);
    }
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn clear_completed(app: AppHandle, db: State<db::Db>) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    let files: Vec<String> = conn
        .prepare("SELECT content FROM items WHERE kind = 'image' AND done = 1")
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();
    conn.execute("DELETE FROM items WHERE done = 1", [])
        .map_err(err)?;
    drop(conn);
    for f in files {
        let _ = std::fs::remove_file(f);
    }
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn set_active_section(app: AppHandle, db: State<db::Db>, id: Option<i64>) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    if let Some(id) = id {
        conn.execute(
            "UPDATE sections SET collapsed = 0 WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(err)?;
    }
    db::set_active_section(&conn, id).map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn set_section_collapsed(
    app: AppHandle,
    db: State<db::Db>,
    id: i64,
    collapsed: bool,
) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE sections SET collapsed = ?2 WHERE id = ?1",
        rusqlite::params![id, collapsed as i64],
    )
    .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif"];

fn ext_of(name: &str) -> String {
    name.rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| e != name)
        .unwrap_or_default()
}

fn is_image_ext(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}

fn images_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("images");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

/// Monotonic suffix so rapid pastes/drops in the same millisecond never collide.
fn unique_name(ext: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let ext = if is_image_ext(ext) { ext } else { "png" };
    format!("{}-{}.{}", db::now_ms(), n, ext)
}

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" => "image/tiff",
        "avif" => "image/avif",
        _ => "image/png",
    }
}

/// Add dropped file paths as items in the active section. Image files are copied
/// into the app's images/ dir and stored as image items; other files keep their
/// path as a text item. Returns how many were added.
#[tauri::command]
pub fn add_files(app: AppHandle, db: State<db::Db>, paths: Vec<String>) -> CmdResult<usize> {
    let active = {
        let conn = db.0.lock().map_err(err)?;
        db::get_active_section(&conn)
    };
    let mut added = 0;
    for path in &paths {
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let ext = ext_of(path);
        if is_image_ext(&ext) {
            let dest = images_dir(&app)?.join(unique_name(&ext));
            if std::fs::copy(path, &dest).is_ok() {
                let conn = db.0.lock().map_err(err)?;
                db::insert_image_item(&conn, &dest.to_string_lossy(), active).map_err(err)?;
                added += 1;
            }
        } else {
            let conn = db.0.lock().map_err(err)?;
            db::insert_item(&conn, path, active).map_err(err)?;
            added += 1;
        }
    }
    refresh(&app);
    Ok(added)
}

/// Store raw image bytes (from a paste or an HTML5 drop) as an image item.
/// `data_base64` is the standard-base64 file contents; `ext` is the source
/// extension (defaults to png when unknown). Returns the new item count (1).
#[tauri::command]
pub fn add_image(
    app: AppHandle,
    db: State<db::Db>,
    data_base64: String,
    ext: String,
) -> CmdResult<usize> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(err)?;
    if bytes.is_empty() {
        return Ok(0);
    }
    let dest = images_dir(&app)?.join(unique_name(&ext.to_ascii_lowercase()));
    std::fs::write(&dest, &bytes).map_err(err)?;
    let active = {
        let conn = db.0.lock().map_err(err)?;
        db::get_active_section(&conn)
    };
    let conn = db.0.lock().map_err(err)?;
    db::insert_image_item(&conn, &dest.to_string_lossy(), active).map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(1)
}

/// Return a data: URL for an image item so the webview can display it without
/// needing filesystem/asset-protocol scope.
#[tauri::command]
pub fn image_data(path: String) -> CmdResult<String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(err)?;
    let mime = mime_for(&ext_of(&path));
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Copy an image item back onto the system clipboard as a real image, so it can
/// be pasted into any other app.
#[tauri::command]
pub fn copy_image(path: String) -> CmdResult<()> {
    let img = image::open(&path)
        .map_err(|_| "This image format can't be copied to the clipboard".to_string())?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    };
    arboard::Clipboard::new()
        .map_err(err)?
        .set_image(data)
        .map_err(err)
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
            if item.kind == "image" {
                // Embed as a relative Markdown image link next to the export.
                let name = item.content.replace('\\', "/");
                let name = name.rsplit('/').next().unwrap_or(&item.content);
                md.push_str(&format!("- [{mark}] ![image](images/{name})\n"));
            } else {
                let content = item.content.replace('\n', "\n  ");
                md.push_str(&format!("- [{mark}] {content}\n"));
            }
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
