// Color tags. The palette is user-editable (Settings → Tags) and stored as JSON
// in the `tag_prefs` setting; notes store tag *ids*, so renaming or recoloring a
// tag never touches the notes. Rust only reads the ids (commands::set_tag_prefs).

export interface TagDef {
  id: string;
  name: string;
  color: string; // #rrggbb
}

export interface TagPrefs {
  tags: TagDef[];
  /** Roll the search-bar dots open/closed (false = instant). */
  animate: boolean;
  /** Tint the whole panel with the color while tagging mode is on. */
  tint: boolean;
}

// Apple's Finder tags. The ids match what 0.3.75-era notes already store.
export const DEFAULT_TAGS: TagDef[] = [
  { id: "red", name: "Red", color: "#ff3b30" },
  { id: "orange", name: "Orange", color: "#ff9500" },
  { id: "yellow", name: "Yellow", color: "#ffcc00" },
  { id: "green", name: "Green", color: "#34c759" },
  { id: "blue", name: "Blue", color: "#007aff" },
  { id: "purple", name: "Purple", color: "#af52de" },
  { id: "gray", name: "Gray", color: "#8e8e93" },
];

// Quick picks in the Settings palette (plus a custom color well).
export const PRESET_COLORS: { name: string; color: string }[] = [
  ...DEFAULT_TAGS.slice(0, 6).map(({ name, color }) => ({ name, color })),
  { name: "Mint", color: "#00c7be" },
  { name: "Teal", color: "#30b0c7" },
  { name: "Indigo", color: "#5856d6" },
  { name: "Pink", color: "#ff2d55" },
  { name: "Brown", color: "#a2845e" },
  { name: "Gray", color: "#8e8e93" },
];

const HEX = /^#[0-9a-f]{6}$/i;

/** Parse the stored JSON, falling back to defaults for anything missing or bad. */
export function parseTagPrefs(json: string): TagPrefs {
  let raw: Partial<TagPrefs> = {};
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    // keep defaults
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter(
        (t) => t && typeof t.id === "string" && typeof t.name === "string" && HEX.test(t.color),
      )
    : [];
  return {
    tags: tags.length ? tags : DEFAULT_TAGS,
    animate: raw.animate !== false,
    tint: raw.tint !== false,
  };
}

/**
 * CSS variables for tinting the panel with `color`: the color itself as the
 * accent, a darker shade of it washed over the background, and a lighter wash
 * for the surfaces on top (tagged notes, the entry box). Plain hex (not
 * color-mix) so a webview without color-mix still renders the panel.
 */
export function tintVars(color: string): Record<string, string> {
  const n = parseInt(color.slice(1), 16);
  const dark = [n >> 16, (n >> 8) & 255, n & 255]
    .map((c) => Math.round(c * 0.72).toString(16).padStart(2, "0"))
    .join("");
  return {
    "--tint": color,
    "--tint-soft": `${color}2e`,
    "--tint-wash": `#${dark}4d`,
    "--tint-card": `${color}38`,
  };
}
