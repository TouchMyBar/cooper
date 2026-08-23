// Rebindable in-app shortcuts. Accelerators are stored as lowercase strings like
// "mod+shift+k" where "mod" means Ctrl (or ⌘ on macOS). Arrows and Esc stay fixed.

export type Action =
  | "switchSection"
  | "createBranch"
  | "copy"
  | "copyList"
  | "markDone"
  | "edit"
  | "del"
  | "help";

export const DEFAULT_BINDS: Record<Action, string> = {
  switchSection: "mod+k",
  createBranch: "mod+b",
  copy: "mod+c",
  copyList: "mod+shift+c",
  markDone: "space",
  edit: "enter",
  del: "delete",
  help: "mod+/",
};

export const ACTION_ORDER: Action[] = [
  "switchSection",
  "createBranch",
  "copy",
  "copyList",
  "markDone",
  "edit",
  "del",
  "help",
];

export const ACTION_LABELS: Record<Action, string> = {
  switchSection: "Switch / create section",
  createBranch: "Create branch",
  copy: "Copy",
  copyList: "Copy as list",
  markDone: "Mark as done",
  edit: "Edit note",
  del: "Delete",
  help: "Shortcuts sheet",
};

export type Binds = Record<Action, string>;

export function resolveBinds(json?: string): Binds {
  let over: Partial<Binds> = {};
  try {
    if (json) over = JSON.parse(json);
  } catch {
    /* ignore malformed */
  }
  return { ...DEFAULT_BINDS, ...over };
}

/** Normalize a keyboard event to an accelerator string, or null for a bare modifier. */
export function eventToAccel(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (key === "control" || key === "meta" || key === "shift" || key === "alt") return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

const IS_MAC = navigator.userAgent.includes("Mac");

const KEY_LABELS: Record<string, string> = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  shift: IS_MAC ? "⇧" : "Shift",
  alt: IS_MAC ? "⌥" : "Alt",
  space: "Space",
  enter: "Enter",
  delete: "Del",
  backspace: "Backspace",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  escape: "Esc",
  tab: "Tab",
};

export function formatAccel(accel: string): string {
  const parts = accel
    .split("+")
    .map((p) => KEY_LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p));
  return parts.join(IS_MAC ? "" : "+");
}
