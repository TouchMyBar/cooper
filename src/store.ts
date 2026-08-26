import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useState } from "react";
import type { AppState, MacSetup, SoundPrefs } from "./types";

// Open a secondary window from the frontend (routes by label in App.tsx). Using
// the JS API + the origin root "/" reliably loads the app; a Rust-built runtime
// window did not load the asset protocol on Windows.
async function openLabeledWindow(label: string, title: string, w: number, h: number) {
  const existing = await Promise.resolve(WebviewWindow.getByLabel(label)).catch(() => null);
  if (existing) {
    existing.setFocus();
    return;
  }
  const win = new WebviewWindow(label, {
    url: "/",
    title,
    width: w,
    height: h,
    minWidth: 480,
    minHeight: 360,
    center: true,
    resizable: true,
  });
  win.once("tauri://error", (e) => console.error("window create error", e));
}

export const api = {
  getState: () => invoke<AppState>("get_state"),
  macSetupState: () => invoke<MacSetup>("mac_setup_state"),
  macOpenAccessibility: () => invoke("mac_open_accessibility"),
  macRemoveQuarantine: (path: string) => invoke("mac_remove_quarantine", { path }),
  addEntry: (content: string) => invoke("add_entry", { content }),
  toggleDone: (id: number) => invoke("toggle_done", { id }),
  updateItem: (id: number, content: string) => invoke("update_item", { id, content }),
  deleteItem: (id: number) => invoke("delete_item", { id }),
  clearCompleted: () => invoke("clear_completed"),
  setActiveSection: (id: number | null) => invoke("set_active_section", { id }),
  setSectionCollapsed: (id: number, collapsed: boolean) =>
    invoke("set_section_collapsed", { id, collapsed }),
  addFiles: (paths: string[]) => invoke<number>("add_files", { paths }),
  addImage: (dataBase64: string, ext: string) =>
    invoke<number>("add_image", { dataBase64, ext }),
  imageData: (path: string) => invoke<string>("image_data", { path }),
  copyImage: (path: string) => invoke("copy_image", { path }),
  createSection: (name: string) => invoke<number>("create_section", { name }),
  renameSection: (id: number, name: string) => invoke("rename_section", { id, name }),
  deleteSection: (id: number) => invoke("delete_section", { id }),
  setTheme: (theme: string) => invoke("set_theme", { theme }),
  copyText: (text: string) => invoke("copy_text", { text }),
  exportMarkdown: () => invoke<string>("export_markdown"),
  captureNow: () => invoke("capture_now"),
  hidePanel: () => invoke("hide_panel"),
  openEditor: (id: number) => openLabeledWindow(`editor-${id}`, "Edit — Cooper", 480, 380),
  openDraw: () => openLabeledWindow("draw", "Draw — Cooper", 820, 600),
  openUrl: (url: string) => invoke("open_url", { url }),
  setUpdateCheckEnabled: (enabled: boolean) =>
    invoke("set_update_check_enabled", { enabled }),
  setUpdateLastCheck: (date: string) => invoke("set_update_last_check", { date }),
  attachImage: (itemId: number, dataBase64: string, ext: string) =>
    invoke<number>("attach_image", { itemId, dataBase64, ext }),
  detachAttachment: (id: number) => invoke("detach_attachment", { id }),
  addNoteToImage: (id: number) => invoke("add_note_to_image", { id }),
  setExportDir: (path: string) => invoke("set_export_dir", { path }),
  setObsidianVaultDir: (path: string) => invoke("set_obsidian_vault_dir", { path }),
  detectObsidianVault: () => invoke<string | null>("detect_obsidian_vault"),
  exportNotesObsidian: (ids: number[]) => invoke<string[]>("export_notes_obsidian", { ids }),
  setCaptureParent: (parent: number | null) => invoke("set_capture_parent", { parent }),
  setKeybinds: (json: string) => invoke("set_keybinds", { json }),
  getSoundPrefs: () => invoke<SoundPrefs>("get_sound_prefs"),
  setSoundPref: (event: string, choice: string, custom?: string) =>
    invoke("set_sound_pref", { event, choice, custom: custom ?? null }),
  addChild: (parentId: number, content: string) =>
    invoke<number>("add_child", { parentId, content }),
  setBranchStyle: (id: number, style: string) =>
    invoke("set_branch_style", { id, style }),
  setItemCollapsed: (id: number, collapsed: boolean) =>
    invoke("set_item_collapsed", { id, collapsed }),
};

// Image items store a stable file path; the data URL for a given path never
// changes, so cache it to avoid re-reading the file on every state refresh.
const imageCache = new Map<string, Promise<string>>();
export function imageDataCached(path: string): Promise<string> {
  let p = imageCache.get(path);
  if (!p) {
    p = api.imageData(path).catch((e) => {
      imageCache.delete(path); // let a later render retry
      throw e;
    });
    imageCache.set(path, p);
  }
  return p;
}

export function applyTheme(theme: string) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  // "glass" follows the system light/dark preference for text colors and adds
  // a translucent backdrop (native acrylic/vibrancy where the OS provides it).
  root.dataset.theme =
    theme === "light" || theme === "dark" ? theme : dark ? "dark" : "light";
  if (theme === "glass") root.dataset.glass = "1";
  else delete root.dataset.glass;
}

export function useAppState() {
  const [state, setState] = useState<AppState | null>(null);

  const refresh = useCallback(() => {
    api.getState().then(setState).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    listen("refresh", refresh).then((f) => (unlisten = f));
    return () => unlisten?.();
  }, [refresh]);

  useEffect(() => {
    if (!state) return;
    applyTheme(state.theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(state.theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [state?.theme]);

  return { state, refresh };
}

// Poll the macOS setup state so the guide reacts the instant the user ticks the
// Accessibility box — macOS grants that live, with no relaunch. Polls slowly
// once everything works, which also catches a permission being revoked later.
export function useMacSetup() {
  const [setup, setSetup] = useState<MacSetup | null>(null);
  const healthy = !setup || !setup.applicable || setup.tapRunning;

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .macSetupState()
        .then((s) => alive && setSetup(s))
        .catch(() => {});
    tick();
    const id = setInterval(tick, healthy ? 15000 : 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [healthy]);

  return setup;
}
