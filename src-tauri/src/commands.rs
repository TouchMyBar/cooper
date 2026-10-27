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
pub fn add_entry(
    app: AppHandle,
    db: State<db::Db>,
    cap: State<db::CaptureParent>,
    content: String,
) -> CmdResult<()> {
    let text = content.trim();
    if text.is_empty() {
        return Ok(());
    }
    // Snapshot the sub-branch-mode parent, then release its lock before locking
    // the DB (the two mutexes are never held simultaneously).
    let parent = { *cap.0.lock().map_err(err)? };
    let conn = db.0.lock().map_err(err)?;
    // "# Name" and "## Name" both create/switch to a section and expand ONLY that
    // section (the terminal-clear scroll is a UI concern; we never collapse others).
    let section_prefix = text
        .strip_prefix("## ")
        .or_else(|| text.strip_prefix("# "));
    let mut added_item = false;
    let mut made_section = false;
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
            made_section = true;
        }
    } else {
        // While sub-branch mode is armed, typed notes nest under the sticky parent.
        db::insert_note_maybe_child(&conn, text, parent).map_err(err)?;
        added_item = true;
    }
    drop(conn);
    // Starting a section exits sub-branch mode.
    if made_section {
        *cap.0.lock().map_err(err)? = None;
    }
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

/// Arm/disarm sub-branch mode: while `parent` is set, captured and typed notes
/// are inserted as children of that item instead of top-level. `None` = off.
#[tauri::command]
pub fn set_capture_parent(cap: State<db::CaptureParent>, parent: Option<i64>) -> CmdResult<()> {
    *cap.0.lock().map_err(err)? = parent;
    Ok(())
}

/// Set (or clear, with "") the Obsidian vault folder that "Save to Obsidian" uses.
#[tauri::command]
pub fn set_obsidian_vault_dir(db: State<db::Db>, path: String) -> CmdResult<()> {
    let p = path.trim();
    if !p.is_empty() && !std::path::Path::new(p).is_dir() {
        return Err("That folder doesn't exist".into());
    }
    let conn = db.0.lock().map_err(err)?;
    db::set_setting(&conn, "obsidian_vault_dir", p).map_err(err)
}

/// Strip a path down to its final component (file name).
fn file_basename(path: &str) -> String {
    path.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

/// Make an arbitrary string safe as a file name on Windows and macOS.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if (c as u32) < 0x20
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    // Collapse whitespace; strip leading/trailing dots and spaces (Windows rejects them).
    let mut s: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    s = s.trim_matches(|c| c == '.' || c == ' ').to_string();
    if s.is_empty() {
        s = "cooper-note".to_string();
    }
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    // Windows blocks a reserved device name even with an extension (CON.log), so
    // test the stem before the first dot.
    let stem_reserved = {
        let stem = s.split('.').next().unwrap_or(&s);
        RESERVED.contains(&stem.to_ascii_uppercase().as_str())
    };
    if stem_reserved {
        s = format!("_{s}");
    }
    if s.chars().count() > 120 {
        s = s
            .chars()
            .take(120)
            .collect::<String>()
            .trim_end_matches(|c| c == '.' || c == ' ')
            .to_string();
    }
    if s.is_empty() {
        s = "cooper-note".to_string();
    }
    s
}

/// A YAML double-quoted scalar, safe for arbitrary text values. Control chars
/// (incl. newlines) must become escape sequences or the frontmatter block fails
/// to parse in Obsidian's YAML parser and every field is silently dropped.
fn yaml_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// ISO date (UTC) from epoch milliseconds, via Hinnant's civil-from-days.
fn iso_date(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Collect an item id plus every descendant id (its whole branch).
fn collect_subtree_ids(items: &[db::Item], root: i64, out: &mut Vec<i64>) {
    out.push(root);
    for c in items.iter().filter(|c| c.parent_id == Some(root)) {
        collect_subtree_ids(items, c.id, out);
    }
}

/// Render an item and its whole branch as an Obsidian task list (tab-indented,
/// done -> "- [x]", undone -> "- [ ]"); image items and attachments embed via ![[…]].
fn render_obsidian_tree(
    items: &[db::Item],
    attachments: &[db::Attachment],
    item: &db::Item,
    depth: usize,
    out: &mut String,
) {
    let indent = "\t".repeat(depth);
    if item.kind == "image" {
        out.push_str(&format!("{indent}- ![[{}]]\n", file_basename(&item.content)));
    } else {
        let mark = if item.done { "x" } else { " " };
        let cont_indent = "\t".repeat(depth + 1);
        let content = item.content.replace('\n', &format!("\n{cont_indent}"));
        out.push_str(&format!("{indent}- [{mark}] {content}\n"));
    }
    for a in attachments.iter().filter(|a| a.item_id == item.id) {
        out.push_str(&format!("{indent}\t- ![[{}]]\n", file_basename(&a.path)));
    }
    for child in items.iter().filter(|c| c.parent_id == Some(item.id)) {
        render_obsidian_tree(items, attachments, child, depth + 1, out);
    }
}

/// Obsidian's own config file (it lists the user's vaults), per platform:
/// %APPDATA%\obsidian\obsidian.json / ~/Library/Application Support/obsidian/… /
/// ~/.config/obsidian/… — resolved via the platform config dir.
fn obsidian_config_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    let p = app.path().config_dir().ok()?.join("obsidian").join("obsidian.json");
    p.exists().then_some(p)
}

/// Vault folders Obsidian knows about, best-first: the currently-open vault(s)
/// first, then by most-recently-opened. Empty if Obsidian isn't set up.
fn obsidian_vaults(app: &AppHandle) -> Vec<String> {
    let Some(cfg) = obsidian_config_file(app) else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&cfg) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let Some(vaults) = json.get("vaults").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut list: Vec<(String, bool, i64)> = vaults
        .values()
        .filter_map(|v| {
            let path = v.get("path")?.as_str()?.to_string();
            let open = v.get("open").and_then(|o| o.as_bool()).unwrap_or(false);
            let ts = v.get("ts").and_then(|t| t.as_i64()).unwrap_or(0);
            Some((path, open, ts))
        })
        .collect();
    // Open vault(s) first, then most-recently-opened.
    list.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    list.into_iter().map(|(p, _, _)| p).collect()
}

/// Resolve the vault to write into, freshly each call so it tracks the current
/// setup: the user's explicit override if set and still present, otherwise
/// Obsidian's currently-open / most-recent vault. `None` if none exists.
fn resolve_obsidian_vault(conn: &rusqlite::Connection, app: &AppHandle) -> Option<String> {
    if let Some(dir) = db::get_setting(conn, "obsidian_vault_dir").filter(|s| !s.is_empty()) {
        if std::path::Path::new(&dir).is_dir() {
            return Some(dir);
        }
    }
    obsidian_vaults(app)
        .into_iter()
        .find(|p| std::path::Path::new(p).is_dir())
}

/// The vault "Save to Obsidian" would currently write to (explicit override, or
/// Obsidian's open/most-recent vault). Lets Settings show the live target.
#[tauri::command]
pub fn detect_obsidian_vault(app: AppHandle, db: State<db::Db>) -> CmdResult<Option<String>> {
    let conn = db.0.lock().map_err(err)?;
    Ok(resolve_obsidian_vault(&conn, &app))
}

/// True if any ancestor of `it` is itself in `selected` — such a note is already
/// rendered inside that ancestor's branch, so exporting it again would duplicate it.
fn has_selected_ancestor(
    items: &[db::Item],
    it: &db::Item,
    selected: &std::collections::HashSet<i64>,
) -> bool {
    let mut cur = it;
    while let Some(pid) = cur.parent_id {
        if selected.contains(&pid) {
            return true;
        }
        match items.iter().find(|p| p.id == pid) {
            Some(p) => cur = p,
            None => break,
        }
    }
    false
}

/// Save the selected notes (each with its whole branch) into the configured vault
/// as Obsidian-friendly Markdown — one file per section, since title/filename is
/// the section name and the notes are its bullets. Collisions get a numbered
/// suffix. Images are copied into <vault>/attachments and embedded by name.
/// Returns the written file paths.
#[tauri::command]
pub fn export_notes_obsidian(
    app: AppHandle,
    db: State<db::Db>,
    ids: Vec<i64>,
) -> CmdResult<Vec<String>> {
    let (state, vault) = {
        let conn = db.0.lock().map_err(err)?;
        // Resolve the vault live so an on-the-fly change in Obsidian or Settings
        // is always honored.
        let vault = resolve_obsidian_vault(&conn, &app);
        (db::get_state(&conn).map_err(err)?, vault)
    };
    let vault =
        vault.ok_or("No Obsidian vault found — set one in Settings, or open a vault in Obsidian")?;
    let vault_dir = std::path::PathBuf::from(&vault);
    if !vault_dir.is_dir() {
        return Err("Your Obsidian vault folder no longer exists".into());
    }

    // Keep only the topmost note of each selected branch, in board order.
    let selected: std::collections::HashSet<i64> = ids.iter().copied().collect();
    let roots: Vec<&db::Item> = state
        .items
        .iter()
        .filter(|i| selected.contains(&i.id) && !has_selected_ancestor(&state.items, i, &selected))
        .collect();
    if roots.is_empty() {
        return Err("Those notes no longer exist".into());
    }

    // Group by section, preserving the order sections first appear.
    let mut groups: Vec<(Option<i64>, Vec<&db::Item>)> = Vec::new();
    for r in roots {
        match groups.iter_mut().find(|(sid, _)| *sid == r.section_id) {
            Some((_, members)) => members.push(r),
            None => groups.push((r.section_id, vec![r])),
        }
    }

    let mut written = Vec::new();
    for (section_id, members) in &groups {
        let section_name = section_id
            .and_then(|sid| state.sections.iter().find(|s| s.id == sid))
            .map(|s| s.name.clone())
            .unwrap_or_else(|| "Inbox".to_string());

        // Copy every image in these branches (image items + text attachments)
        // into the vault's attachments folder, then embed by bare name.
        let mut subtree = Vec::new();
        for m in members {
            collect_subtree_ids(&state.items, m.id, &mut subtree);
        }
        let idset: std::collections::HashSet<i64> = subtree.iter().copied().collect();
        let mut image_files: Vec<String> = state
            .items
            .iter()
            .filter(|i| idset.contains(&i.id) && i.kind == "image")
            .map(|i| i.content.clone())
            .collect();
        image_files.extend(
            state
                .attachments
                .iter()
                .filter(|a| idset.contains(&a.item_id))
                .map(|a| a.path.clone()),
        );
        if !image_files.is_empty() {
            let att_dir = vault_dir.join("attachments");
            std::fs::create_dir_all(&att_dir).map_err(err)?;
            for src in &image_files {
                let dest = att_dir.join(file_basename(src));
                if !dest.exists() {
                    let _ = std::fs::copy(src, &dest);
                }
            }
        }

        let created = members.iter().map(|m| m.created_at).min().unwrap_or(0);
        let mut md = String::new();
        md.push_str("---\n");
        md.push_str(&format!("title: {}\n", yaml_str(&section_name)));
        md.push_str(&format!("created: {}\n", iso_date(created)));
        md.push_str("source: Cooper\n");
        md.push_str(&format!("section: {}\n", yaml_str(&section_name)));
        md.push_str("tags:\n  - cooper\n");
        if members.len() == 1 {
            md.push_str(&format!("cooper_id: {}\n", members[0].id));
        } else {
            md.push_str("cooper_ids:\n");
            for m in members {
                md.push_str(&format!("  - {}\n", m.id));
            }
        }
        md.push_str("---\n\n");
        for m in members {
            render_obsidian_tree(&state.items, &state.attachments, m, 0, &mut md);
        }

        // Filename = section name, de-duplicated with " 2", " 3", …
        let base = sanitize_filename(&section_name);
        let mut path = vault_dir.join(format!("{base}.md"));
        let mut n = 2;
        while path.exists() {
            path = vault_dir.join(format!("{base} {n}.md"));
            n += 1;
        }
        std::fs::write(&path, md).map_err(err)?;
        written.push(path.to_string_lossy().into_owned());
    }
    Ok(written)
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
        match db::item_depth(&conn, parent_id) {
            Some(d) if d < db::MAX_BRANCH_DEPTH => {}
            Some(_) => return Err("Maximum nesting depth reached".into()),
            None => return Err("That note no longer exists".into()),
        }
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

/// Add or remove one color tag on several notes at once (the dot row in the note
/// menu). Ids are stored comma-separated; the UI orders the dots by the palette.
#[tauri::command]
pub fn set_tag(app: AppHandle, db: State<db::Db>, ids: Vec<i64>, tag: String, on: bool) -> CmdResult<()> {
    if tag.is_empty() || tag.contains(',') {
        return Err("invalid tag".into());
    }
    let conn = db.0.lock().map_err(err)?;
    for id in ids {
        let current: String = conn
            .query_row(
                "SELECT tags FROM items WHERE id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .map_err(err)?;
        let mut next: Vec<&str> = current.split(',').filter(|t| !t.is_empty() && *t != tag).collect();
        if on {
            next.push(&tag);
        }
        conn.execute(
            "UPDATE items SET tags = ?2 WHERE id = ?1",
            rusqlite::params![id, next.join(",")],
        )
        .map_err(err)?;
    }
    drop(conn);
    refresh(&app);
    Ok(())
}

/// Save the tag palette + picker options (JSON, see src/tags.ts). A color removed
/// from the palette is also taken off every note, and ends tagging mode if it was
/// the active one, so no note is left carrying an invisible tag.
#[tauri::command]
pub fn set_tag_prefs(app: AppHandle, db: State<db::Db>, json: String) -> CmdResult<()> {
    #[derive(serde::Deserialize)]
    struct Prefs {
        tags: Vec<Tag>,
    }
    #[derive(serde::Deserialize)]
    struct Tag {
        id: String,
    }
    let prefs: Prefs = serde_json::from_str(&json).map_err(err)?;
    let keep: std::collections::HashSet<String> = prefs.tags.into_iter().map(|t| t.id).collect();
    let conn = db.0.lock().map_err(err)?;
    db::set_setting(&conn, "tag_prefs", json.trim()).map_err(err)?;
    let tagged: Vec<(i64, String)> = conn
        .prepare("SELECT id, tags FROM items WHERE tags != ''")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()
        })
        .map_err(err)?;
    for (id, tags) in tagged {
        let next: Vec<&str> = tags.split(',').filter(|t| keep.contains(*t)).collect();
        if next.join(",") != tags {
            conn.execute(
                "UPDATE items SET tags = ?2 WHERE id = ?1",
                rusqlite::params![id, next.join(",")],
            )
            .map_err(err)?;
        }
    }
    if !keep.contains(&db::capture_tag(&conn)) {
        db::set_setting(&conn, "capture_tag", "").map_err(err)?;
    }
    drop(conn);
    refresh(&app);
    Ok(())
}

/// Tagging mode: every note created from now on gets `tag` ("" turns it off).
#[tauri::command]
pub fn set_capture_tag(app: AppHandle, db: State<db::Db>, tag: String) -> CmdResult<()> {
    if tag.contains(',') {
        return Err("invalid tag".into());
    }
    {
        let conn = db.0.lock().map_err(err)?;
        db::set_setting(&conn, "capture_tag", &tag).map_err(err)?;
    }
    refresh(&app);
    Ok(())
}

/// Zoom the panel (Ctrl/⌘ + − 0), clamped to 50–200% and remembered for next launch.
/// Native webview zoom, so clicks, drags and menus keep lining up with what's drawn.
#[tauri::command]
pub fn set_zoom(app: AppHandle, db: State<db::Db>, zoom: f64) -> CmdResult<f64> {
    if !zoom.is_finite() {
        return Err("invalid zoom".into());
    }
    let zoom = zoom.clamp(0.5, 2.0);
    {
        let conn = db.0.lock().map_err(err)?;
        db::set_setting(&conn, "zoom", &zoom.to_string()).map_err(err)?;
    }
    if let Some(win) = app.get_webview_window("main") {
        win.set_zoom(zoom).map_err(err)?;
    }
    refresh(&app);
    Ok(zoom)
}

/// Move notes into a section (dragging a note onto a section). Each note takes its
/// whole branch along and lands top-level; a note whose ancestor is also being
/// moved just rides along inside that ancestor's branch.
#[tauri::command]
pub fn move_to_section(
    app: AppHandle,
    db: State<db::Db>,
    ids: Vec<i64>,
    section_id: Option<i64>,
) -> CmdResult<()> {
    let conn = db.0.lock().map_err(err)?;
    let items = db::list_items(&conn).map_err(err)?;
    let moving: std::collections::HashSet<i64> = ids.into_iter().collect();
    for it in items.iter().filter(|i| moving.contains(&i.id)) {
        if has_selected_ancestor(&items, it, &moving) {
            continue;
        }
        let mut branch = Vec::new();
        collect_subtree_ids(&items, it.id, &mut branch);
        conn.execute(
            "UPDATE items SET parent_id = NULL WHERE id = ?1",
            rusqlite::params![it.id],
        )
        .map_err(err)?;
        for id in branch {
            conn.execute(
                "UPDATE items SET section_id = ?2 WHERE id = ?1",
                rusqlite::params![id, section_id],
            )
            .map_err(err)?;
        }
    }
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
