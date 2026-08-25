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
    // "# Name" and "## Name" both create/switch to a section and expand ONLY that
    // section (the terminal-clear scroll is a UI concern; we never collapse others).
    let section_prefix = text
        .strip_prefix("## ")
        .or_else(|| text.strip_prefix("# "));
    let mut added_item = false;
    if let Some(name) = section_prefix {
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
        added_item = true;
    }
    drop(conn);
    refresh(&app);
    if added_item {
        let _ = app.emit("note-added", ());
    }
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
    // Gather every backing file in this item's branch (images + attachments)
    // before the row (and its cascaded children/attachments) are deleted.
    let mut files = db::subtree_image_files(&conn, id);
    files.extend(db::subtree_attachment_files(&conn, id));
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
    // A done parent that still has an undone child is preserved (deleting it
    // would take the undone child via CASCADE).
    let deletable: Vec<i64> = conn
        .prepare(
            "SELECT id FROM items i WHERE i.done = 1
               AND NOT EXISTS (SELECT 1 FROM items c WHERE c.parent_id = i.id AND c.done = 0)",
        )
        .and_then(|mut stmt| {
            stmt.query_map([], |r| r.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();
    let mut files = Vec::new();
    for &id in &deletable {
        files.extend(db::subtree_image_files(&conn, id));
        files.extend(db::subtree_attachment_files(&conn, id));
    }
    for &id in &deletable {
        // CASCADE removes any done descendants; a no-op if already gone.
        let _ = conn.execute("DELETE FROM items WHERE id = ?1", rusqlite::params![id]);
    }
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
    let basename = |content: &str| -> String {
        let n = content.replace('\\', "/");
        n.rsplit('/').next().unwrap_or(content).to_string()
    };
    // Write one item (+ its attachments) at the given indent.
    let write_one = |md: &mut String, item: &db::Item, indent: &str| {
        let mark = if item.done { "x" } else { " " };
        if item.kind == "image" {
            md.push_str(&format!(
                "{indent}- [{mark}] ![image](images/{})\n",
                basename(&item.content)
            ));
        } else {
            let content = item.content.replace('\n', &format!("\n{indent}  "));
            md.push_str(&format!("{indent}- [{mark}] {content}\n"));
        }
        for a in state.attachments.iter().filter(|a| a.item_id == item.id) {
            md.push_str(&format!("{indent}  - ![image](images/{})\n", basename(&a.path)));
        }
    };
    // Write a section's top-level items, nesting each item's branch children.
    let write_items = |md: &mut String, section_id: Option<i64>| {
        for item in state
            .items
            .iter()
            .filter(|i| i.section_id == section_id && i.parent_id.is_none())
        {
            write_one(md, item, "");
            for child in state.items.iter().filter(|c| c.parent_id == Some(item.id)) {
                write_one(md, child, "  ");
            }
        }
    };
    if state
        .items
        .iter()
        .any(|i| i.section_id.is_none() && i.parent_id.is_none())
    {
        write_items(&mut md, None);
        md.push('\n');
    }
    for section in &state.sections {
        md.push_str(&format!("## {}\n\n", section.name));
        write_items(&mut md, Some(section.id));
        md.push('\n');
    }

    // Use the configured export folder if set and valid, else Documents.
    let custom = {
        let conn = db.0.lock().map_err(err)?;
        db::get_setting(&conn, "export_dir").filter(|s| !s.is_empty())
    };
    let dir = match custom {
        Some(d) if std::path::Path::new(&d).is_dir() => std::path::PathBuf::from(d),
        _ => app.path().resolve("", BaseDirectory::Document).map_err(err)?,
    };
    let path = dir.join("cooper-export.md");
    std::fs::write(&path, md).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Set (or clear, with "") the folder that Export to Markdown writes to.
#[tauri::command]
pub fn set_export_dir(db: State<db::Db>, path: String) -> CmdResult<()> {
    let p = path.trim();
    if !p.is_empty() && !std::path::Path::new(p).is_dir() {
        return Err("That folder doesn't exist".into());
    }
    let conn = db.0.lock().map_err(err)?;
    db::set_setting(&conn, "export_dir", p).map_err(err)
}

/// Persist the JSON map of shortcut overrides.
#[tauri::command]
pub fn set_keybinds(app: AppHandle, db: State<db::Db>, json: String) -> CmdResult<()> {
    {
        let conn = db.0.lock().map_err(err)?;
        db::set_setting(&conn, "keybinds", json.trim()).map_err(err)?;
    }
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn capture_now(app: AppHandle) {
    capture::capture_selection(&app);
}

#[tauri::command]
pub fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

// Editor and Draw windows are created from the frontend (see store.ts
// openLabeledWindow) via the JS WebviewWindow API at origin "/", which reliably
// loads the app; a Rust-built runtime window did not load the asset protocol.

/// Whether `url` is a plain https URL safe to hand to an OS opener as argv.
/// Requires the https scheme, bounded length, and only ordinary URL characters —
/// no whitespace, control chars, quotes, or shell metacharacters (`< > | ^ \``,
/// backslash, quotes) that could break out of a command line or argv. The https
/// prefix also rules out a leading `-` being read as a flag by the opener.
fn is_safe_url(url: &str) -> bool {
    url.starts_with("https://")
        && url.len() <= 2048
        && url
            .chars()
            .all(|c| c.is_ascii_graphic() && !matches!(c, '"' | '\'' | '`' | '<' | '>' | '|' | '^' | '\\'))
}

/// Open an https URL in the user's default browser. Never routes through a shell
/// (`cmd.exe`), so URL characters are never re-interpreted as shell syntax.
#[tauri::command]
pub fn open_url(url: String) -> CmdResult<()> {
    if !is_safe_url(&url) {
        return Err("refused unsafe url".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // rundll32 is not a shell; the URL is passed as a single argv to the
        // system protocol handler via CreateProcess (no metacharacter parsing).
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW — no console flash
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("--")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_update_check_enabled(app: AppHandle, db: State<db::Db>, enabled: bool) -> CmdResult<()> {
    {
        let conn = db.0.lock().map_err(err)?;
        db::set_setting(&conn, "update_check_enabled", if enabled { "1" } else { "0" })
            .map_err(err)?;
    }
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn set_update_last_check(db: State<db::Db>, date: String) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    db::set_setting(&conn, "update_last_check", date.trim()).map_err(err)
}

/// Attach raw image bytes (paste/drop onto a note) to a text item; returns the
/// new attachment id.
#[tauri::command]
pub fn attach_image(
    app: AppHandle,
    db: State<db::Db>,
    item_id: i64,
    data_base64: String,
    ext: String,
) -> CmdResult<i64> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(err)?;
    if bytes.is_empty() {
        return Ok(0);
    }
    let dest = images_dir(&app)?.join(unique_name(&ext.to_ascii_lowercase()));
    std::fs::write(&dest, &bytes).map_err(err)?;
    let att_id = {
        let conn = db.0.lock().map_err(err)?;
        db::insert_attachment(&conn, item_id, &dest.to_string_lossy()).map_err(err)?
    };
    refresh(&app);
    Ok(att_id)
}

/// Turn a standalone image item into a text note that keeps the image as an
/// attachment (so the user can add a caption). The item id is preserved.
#[tauri::command]
pub fn add_note_to_image(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    let path: Option<String> = conn
        .query_row(
            "SELECT content FROM items WHERE id = ?1 AND kind = 'image'",
            rusqlite::params![id],
            |r| r.get::<_, String>(0),
        )
        .ok();
    if let Some(p) = path {
        conn.execute(
            "UPDATE items SET kind = 'text', content = '' WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(err)?;
        db::insert_attachment(&conn, id, &p).map_err(err)?;
    }
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn detach_attachment(app: AppHandle, db: State<db::Db>, id: i64) -> CmdResult<()> {
    let path: Option<String> = {
        let conn = db.0.lock().map_err(err)?;
        let p = conn
            .query_row(
                "SELECT path FROM attachments WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get::<_, String>(0),
            )
            .ok();
        conn.execute("DELETE FROM attachments WHERE id = ?1", rusqlite::params![id])
            .map_err(err)?;
        p
    };
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
    refresh(&app);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundPref {
    pub choice: String,
    pub custom: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundPrefs {
    pub capture: SoundPref,
    pub new_note: SoundPref,
    pub volume: f64,
}

#[tauri::command]
pub fn get_sound_prefs(db: State<db::Db>) -> CmdResult<SoundPrefs> {
    let conn = db.0.lock().map_err(err)?;
    let pref = |prefix: &str, default_choice: &str| SoundPref {
        choice: db::get_setting(&conn, &format!("sound_{prefix}_choice"))
            .unwrap_or_else(|| default_choice.to_string()),
        custom: db::get_setting(&conn, &format!("sound_{prefix}_custom")).filter(|s| !s.is_empty()),
    };
    let volume = db::get_setting(&conn, "sound_volume")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.6);
    Ok(SoundPrefs {
        capture: pref("capture", "pop"),
        new_note: pref("newnote", "none"),
        volume,
    })
}

#[tauri::command]
pub fn set_sound_pref(
    db: State<db::Db>,
    event: String,
    choice: String,
    custom: Option<String>,
) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    if event == "volume" {
        return db::set_setting(&conn, "sound_volume", choice.trim()).map_err(err);
    }
    let prefix = match event.as_str() {
        "capture" => "capture",
        "newNote" => "newnote",
        _ => return Err("unknown sound event".into()),
    };
    db::set_setting(&conn, &format!("sound_{prefix}_choice"), choice.trim()).map_err(err)?;
    let custom = if choice == "custom" {
        custom.unwrap_or_default()
    } else {
        String::new()
    };
    db::set_setting(&conn, &format!("sound_{prefix}_custom"), &custom).map_err(err)?;
    Ok(())
}

/// Create a branch child (sub-point) under a parent item; returns the new id.
#[tauri::command]
pub fn add_child(app: AppHandle, db: State<db::Db>, parent_id: i64, content: String) -> CmdResult<i64> {
    let id = {
        let conn = db.0.lock().map_err(err)?;
        let section_id: Option<i64> = conn
            .query_row(
                "SELECT section_id FROM items WHERE id = ?1",
                rusqlite::params![parent_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .unwrap_or(None);
        db::insert_child_item(&conn, content.trim(), parent_id, section_id).map_err(err)?
    };
    refresh(&app);
    Ok(id)
}

#[tauri::command]
pub fn set_branch_style(app: AppHandle, db: State<db::Db>, id: i64, style: String) -> CmdResult<()> {
    if style != "inline" && style != "panel" {
        return Err("invalid branch style".into());
    }
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE items SET branch_style = ?2 WHERE id = ?1",
        rusqlite::params![id, style],
    )
    .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn set_item_collapsed(app: AppHandle, db: State<db::Db>, id: i64, collapsed: bool) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    conn.execute(
        "UPDATE items SET collapsed = ?2 WHERE id = ?1",
        rusqlite::params![id, collapsed as i64],
    )
    .map_err(err)?;
    drop(conn);
    refresh(&app);
    Ok(())
}

/// Why the macOS double-shift listener isn't running yet, so the UI can show
/// the single step that applies. Every field is inert off macOS.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MacSetup {
    pub applicable: bool,
    pub tap_running: bool,
    pub trusted: bool,
    pub translocated: bool,
    pub real_path: String,
    pub on_read_only_volume: bool,
    pub will_translocate: bool,
}

#[tauri::command]
pub fn mac_setup_state() -> MacSetup {
    #[cfg(target_os = "macos")]
    {
        crate::mac_setup::state()
    }
    #[cfg(not(target_os = "macos"))]
    {
        MacSetup {
            applicable: false,
            tap_running: true,
            trusted: true,
            translocated: false,
            real_path: String::new(),
            on_read_only_volume: false,
            will_translocate: false,
        }
    }
}

#[tauri::command]
pub fn mac_open_accessibility() {
    #[cfg(target_os = "macos")]
    crate::mac_setup::open_accessibility_settings();
}

#[tauri::command]
pub fn mac_remove_quarantine(path: String) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    {
        return crate::mac_setup::remove_quarantine(&path).map_err(|e| e);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(())
    }
}
