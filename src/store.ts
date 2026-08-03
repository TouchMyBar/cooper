import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import type { AppState } from "./types";

export const api = {
  getState: () => invoke<AppState>("get_state"),
  addEntry: (content: string) => invoke("add_entry", { content }),
  toggleDone: (id: number) => invoke("toggle_done", { id }),
  updateItem: (id: number, content: string) => invoke("update_item", { id, content }),
  deleteItem: (id: number) => invoke("delete_item", { id }),
  clearCompleted: () => invoke("clear_completed"),
  setActiveSection: (id: number | null) => invoke("set_active_section", { id }),
  createSection: (name: string) => invoke<number>("create_section", { name }),
  renameSection: (id: number, name: string) => invoke("rename_section", { id, name }),
  deleteSection: (id: number) => invoke("delete_section", { id }),
  setTheme: (theme: string) => invoke("set_theme", { theme }),
  copyText: (text: string) => invoke("copy_text", { text }),
  exportMarkdown: () => invoke<string>("export_markdown"),
  captureNow: () => invoke("capture_now"),
  hidePanel: () => invoke("hide_panel"),
  openEditor: (id: number) => invoke("open_editor", { id }),
};

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
