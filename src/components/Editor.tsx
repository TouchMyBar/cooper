import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { api, applyTheme } from "../store";

export default function Editor({ id }: { id: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.getState().then((state) => {
      applyTheme(state.theme);
      const item = state.items.find((i) => i.id === id);
      setDraft(item ? item.content : "");
    });
  }, [id]);

  useEffect(() => {
    if (draft !== null) taRef.current?.focus();
  }, [draft !== null]);

  const close = () => getCurrentWindow().close();
  const save = async () => {
    if (draft !== null && draft.trim()) await api.updateItem(id, draft);
    close();
  };

  return (
    <div className="editor-window">
      <div className="editor-bar" data-tauri-drag-region>
        <span className="editor-title" data-tauri-drag-region>
          Edit
        </span>
        <button className="icon-btn" title="Close" onClick={close}>
          ✕
        </button>
      </div>
      <textarea
        ref={taRef}
        className="editor-area"
        value={draft ?? ""}
        placeholder="Loading…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            close();
          }
        }}
      />
      <div className="editor-actions">
        <span className="editor-hint">Ctrl+Enter to save · Esc to cancel</span>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
