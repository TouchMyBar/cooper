export interface Section {
  id: number;
  name: string;
  collapsed: boolean;
}

export interface Item {
  id: number;
  sectionId: number | null;
  content: string;
  /** "text" or "image"; for images `content` is the absolute file path. */
  kind: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  /** Non-null when this item is a branch child (sub-point) of another item. */
  parentId: number | null;
  /** "inline" (nested bullets) or "panel" (side pane). */
  branchStyle: string;
  /** Inline-branch collapsed state. */
  collapsed: boolean;
}

export interface Attachment {
  id: number;
  itemId: number;
  path: string;
  position: number;
}

export interface SoundPref {
  choice: string;
  custom: string | null;
}

export interface SoundPrefs {
  capture: SoundPref;
  newNote: SoundPref;
  volume: number;
}

export interface UpdateInfo {
  tag: string;
  url: string;
}

export interface AppState {
  sections: Section[];
  items: Item[];
  attachments: Attachment[];
  activeSectionId: number | null;
  theme: string;
  appVersion: string;
  updateCheckEnabled: boolean;
  lastUpdateCheck: string;
  exportDir: string;
  obsidianVaultDir: string;
  keybinds: string;
}

export interface MacSetup {
  applicable: boolean;
  tapRunning: boolean;
  trusted: boolean;
  translocated: boolean;
  realPath: string;
  onReadOnlyVolume: boolean;
  willTranslocate: boolean;
}
