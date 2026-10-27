use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Db(pub Mutex<Connection>);

/// Sticky "sub-branch mode" parent: while set, captured/typed notes are inserted
/// as branch children of this item instead of top-level. `None` = mode off.
pub struct CaptureParent(pub Mutex<Option<i64>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: i64,
    pub name: String,
    pub collapsed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: i64,
    pub section_id: Option<i64>,
    pub content: String,
    /// "text" or "image". For images, `content` holds the absolute file path.
    pub kind: String,
    pub done: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Non-null when this item is a sub-point (branch child) of another item.
    pub parent_id: Option<i64>,
    /// How a parent's branch is shown: "inline" (nested) or "panel" (side pane).
    pub branch_style: String,
    /// Inline-branch collapsed state (mirrors Section.collapsed).
    pub collapsed: bool,
    /// Color tag ids (defined by the user's tag palette in `tag_prefs`).
    pub tags: Vec<String>,
}

/// An image attached to a text item (a "mixed note").
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: i64,
    pub item_id: i64,
    /// Absolute path of the stored image file under app_data_dir/images.
    pub path: String,
    pub position: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub sections: Vec<Section>,
    pub items: Vec<Item>,
    pub attachments: Vec<Attachment>,
    pub active_section_id: Option<i64>,
    pub theme: String,
    pub app_version: String,
    pub update_check_enabled: bool,
    pub last_update_check: String,
    /// Custom export folder ("" = default Documents).
    pub export_dir: String,
    /// Obsidian vault folder that "Save to Obsidian" writes .md files into ("" = unset).
    pub obsidian_vault_dir: String,
    /// JSON map of action -> accelerator overrides ("{}" = all defaults).
    pub keybinds: String,
    /// JSON tag palette + picker options (see src/tags.ts; "" = defaults).
    pub tag_prefs: String,
    /// Tag id that every new note gets ("" = tagging mode off).
    pub capture_tag: String,
    /// Panel page zoom (1.0 = 100%), remembered across launches.
    pub zoom: f64,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn init(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS sections(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS items(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
           content TEXT NOT NULL,
           done INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS settings(
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );",
    )?;
    // Migrations for older databases; harmless error if the column exists.
    let _ = conn.execute(
        "ALTER TABLE sections ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'",
        [],
    );
    // Branch columns (nullable FK is the only ADD COLUMN form SQLite allows with
    // foreign_keys=ON; CASCADE fires because the pragma is set above).
    let _ = conn.execute(
        "ALTER TABLE items ADD COLUMN parent_id INTEGER REFERENCES items(id) ON DELETE CASCADE",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE items ADD COLUMN branch_style TEXT NOT NULL DEFAULT 'inline'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE items ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // Color tags, comma-separated ("" = untagged).
    let _ = conn.execute(
        "ALTER TABLE items ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
        [],
    );
    // Attachments (mixed notes): images bound to a text item. Idempotent.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachments(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
           path TEXT NOT NULL,
           position INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_attachments_item ON attachments(item_id);",
    )?;
    Ok(conn)
}

pub fn get_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_active_section(conn: &Connection) -> Option<i64> {
    let id: i64 = get_setting(conn, "active_section")?.parse().ok()?;
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sections WHERE id = ?1)",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    exists.then_some(id)
}

pub fn set_active_section(conn: &Connection, id: Option<i64>) -> rusqlite::Result<()> {
    set_setting(
        conn,
        "active_section",
        &id.map(|v| v.to_string()).unwrap_or_default(),
    )
}

pub fn list_sections(conn: &Connection) -> rusqlite::Result<Vec<Section>> {
    let mut stmt = conn.prepare("SELECT id, name, collapsed FROM sections ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Section {
            id: r.get(0)?,
            name: r.get(1)?,
            collapsed: r.get::<_, i64>(2)? != 0,
        })
    })?;
    rows.collect()
}

pub fn list_items(conn: &Connection) -> rusqlite::Result<Vec<Item>> {
    let mut stmt = conn.prepare(
        "SELECT id, section_id, content, kind, done, created_at, updated_at, parent_id, branch_style, collapsed, tags FROM items ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Item {
            id: r.get(0)?,
            section_id: r.get(1)?,
            content: r.get(2)?,
            kind: r.get(3)?,
            done: r.get::<_, i64>(4)? != 0,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            parent_id: r.get(7)?,
            branch_style: r.get(8)?,
            collapsed: r.get::<_, i64>(9)? != 0,
            tags: r
                .get::<_, String>(10)?
                .split(',')
                .filter(|t| !t.is_empty())
                .map(String::from)
                .collect(),
        })
    })?;
    rows.collect()
}

pub fn list_attachments(conn: &Connection) -> rusqlite::Result<Vec<Attachment>> {
    let mut stmt =
        conn.prepare("SELECT id, item_id, path, position FROM attachments ORDER BY item_id, position, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Attachment {
            id: r.get(0)?,
            item_id: r.get(1)?,
            path: r.get(2)?,
            position: r.get(3)?,
        })
    })?;
    rows.collect()
}

pub fn get_state(conn: &Connection) -> rusqlite::Result<AppState> {
    Ok(AppState {
        sections: list_sections(conn)?,
        items: list_items(conn)?,
        attachments: list_attachments(conn)?,
        active_section_id: get_active_section(conn),
        theme: get_setting(conn, "theme").unwrap_or_else(|| "system".into()),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        update_check_enabled: get_setting(conn, "update_check_enabled")
            .map(|v| v != "0")
            .unwrap_or(true),
        last_update_check: get_setting(conn, "update_last_check").unwrap_or_default(),
        export_dir: get_setting(conn, "export_dir").unwrap_or_default(),
        obsidian_vault_dir: get_setting(conn, "obsidian_vault_dir").unwrap_or_default(),
        keybinds: get_setting(conn, "keybinds").unwrap_or_else(|| "{}".into()),
        tag_prefs: get_setting(conn, "tag_prefs").unwrap_or_default(),
        capture_tag: capture_tag(conn),
        zoom: zoom(conn),
    })
}

/// Saved panel zoom, kept within the 50–200% the shortcuts allow.
pub fn zoom(conn: &Connection) -> f64 {
    get_setting(conn, "zoom")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|z| z.is_finite())
        .map_or(1.0, |z| z.clamp(0.5, 2.0))
}

/// The tag tagging mode stamps on every new note ("" = off).
pub fn capture_tag(conn: &Connection) -> String {
    get_setting(conn, "capture_tag").unwrap_or_default()
}

pub fn insert_item(conn: &Connection, content: &str, section_id: Option<i64>) -> rusqlite::Result<i64> {
    let t = now_ms();
    conn.execute(
        "INSERT INTO items(section_id, content, kind, done, created_at, updated_at, tags) VALUES(?1, ?2, 'text', 0, ?3, ?3, ?4)",
        params![section_id, content, t, capture_tag(conn)],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Insert an image item; `path` is the absolute path of the stored image file.
pub fn insert_image_item(
    conn: &Connection,
    path: &str,
    section_id: Option<i64>,
) -> rusqlite::Result<i64> {
    let t = now_ms();
    conn.execute(
        "INSERT INTO items(section_id, content, kind, done, created_at, updated_at, tags) VALUES(?1, ?2, 'image', 0, ?3, ?3, ?4)",
        params![section_id, path, t, capture_tag(conn)],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Insert a note as a branch child of `parent` when sub-branch mode is armed and
/// `parent` is still a valid top-level item; otherwise insert it top-level in the
/// active section. Returns the new item id. Shared by capture and typed-note paths.
/// Deepest allowed branch nesting (a top-level item is depth 0, so this permits
/// ten levels of sub-branches beneath it).
pub const MAX_BRANCH_DEPTH: i64 = 10;

/// Depth of an item in its branch (0 = top-level). `None` if it doesn't exist.
pub fn item_depth(conn: &Connection, id: i64) -> Option<i64> {
    conn.query_row(
        "WITH RECURSIVE anc(id, pid, d) AS (
           SELECT id, parent_id, 0 FROM items WHERE id = ?1
           UNION ALL
           SELECT items.id, items.parent_id, anc.d + 1 FROM items JOIN anc ON items.id = anc.pid
         )
         SELECT MAX(d) FROM anc",
        params![id],
        |r| r.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
}

pub fn insert_note_maybe_child(
    conn: &Connection,
    text: &str,
    parent: Option<i64>,
) -> rusqlite::Result<i64> {
    if let Some(pid) = parent {
        // Nest under the sticky parent (at any level) as long as it still exists
        // and is shallower than the depth cap, so a new child stays within it.
        if let Some(depth) = item_depth(conn, pid) {
            if depth < MAX_BRANCH_DEPTH {
                let section_id: Option<i64> = conn
                    .query_row(
                        "SELECT section_id FROM items WHERE id = ?1",
                        params![pid],
                        |r| r.get(0),
                    )
                    .unwrap_or(None);
                let id = insert_child_item(conn, text, pid, section_id)?;
                // Make sure the newly-added sub-point is visible.
                conn.execute("UPDATE items SET collapsed = 0 WHERE id = ?1", params![pid])?;
                return Ok(id);
            }
        }
    }
    let active = get_active_section(conn);
    insert_item(conn, text, active)
}

/// Insert a branch child (sub-point) under `parent_id`, inheriting its section.
pub fn insert_child_item(
    conn: &Connection,
    content: &str,
    parent_id: i64,
    section_id: Option<i64>,
) -> rusqlite::Result<i64> {
    let t = now_ms();
    conn.execute(
        "INSERT INTO items(section_id, content, kind, done, created_at, updated_at, parent_id, tags) VALUES(?1, ?2, 'text', 0, ?3, ?3, ?4, ?5)",
        params![section_id, content, t, parent_id, capture_tag(conn)],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Attach an image (already written to disk at `path`) to a text item.
pub fn insert_attachment(conn: &Connection, item_id: i64, path: &str) -> rusqlite::Result<i64> {
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM attachments WHERE item_id = ?1",
            params![item_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO attachments(item_id, path, position, created_at) VALUES(?1, ?2, ?3, ?4)",
        params![item_id, path, pos, now_ms()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Paths of the images stored across an item's whole branch (itself + descendants).
pub fn subtree_image_files(conn: &Connection, root_id: i64) -> Vec<String> {
    conn.prepare(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1 UNION ALL SELECT items.id FROM items JOIN sub ON items.parent_id = sub.id
         )
         SELECT content FROM items WHERE kind = 'image' AND id IN (SELECT id FROM sub)",
    )
    .and_then(|mut s| {
        s.query_map(params![root_id], |r| r.get::<_, String>(0))?
            .collect()
    })
    .unwrap_or_default()
}

/// Paths of attachment images across an item's whole branch (itself + descendants).
pub fn subtree_attachment_files(conn: &Connection, root_id: i64) -> Vec<String> {
    conn.prepare(
        "WITH RECURSIVE sub(id) AS (
           SELECT ?1 UNION ALL SELECT items.id FROM items JOIN sub ON items.parent_id = sub.id
         )
         SELECT path FROM attachments WHERE item_id IN (SELECT id FROM sub)",
    )
    .and_then(|mut s| {
        s.query_map(params![root_id], |r| r.get::<_, String>(0))?
            .collect()
    })
    .unwrap_or_default()
}

/// Find a section by name (case-insensitive) or create it. Returns its id.
pub fn find_or_create_section(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM sections WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO sections(name, created_at) VALUES(?1, ?2)",
        params![name, now_ms()],
    )?;
    Ok(conn.last_insert_rowid())
}
