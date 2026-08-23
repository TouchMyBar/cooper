import { useEffect, useRef, useState } from "react";
import { api } from "../store";
import type { Item } from "../types";

export default function BranchPanel({
  parent,
  children,
  onClose,
}: {
  parent: Item;
  children: Item[];
  onClose: () => void;
}): JSX.Element {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Escape closes the pane (capture phase so it beats the app's global handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const startEdit = (child: Item) => {
    setEditingId(child.id);
    setDraft(child.content);
  };

  const commitEdit = (id: number) => {
    const text = draft.trim();
    if (text) api.updateItem(id, text);
    setEditingId(null);
  };

  const submitChild = () => {
    const el = taRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (text) api.addChild(parent.id, text);
    el.value = "";
    el.style.height = "auto";
    el.focus();
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <aside className="branch-pane" onMouseDown={(e) => e.stopPropagation()}>
        <div className="branch-pane-header">
          <span className="branch-pane-title" title={parent.content}>
            {parent.content}
          </span>
          <button
            className="branch-pane-inline"
            title="Show inline"
            onClick={() => {
              api.setBranchStyle(parent.id, "inline");
              onClose();
            }}
          >
            Inline
          </button>
          <button className="branch-pane-close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="branch-pane-list">
          {children.length === 0 ? (
            <div className="group-empty">No sub-points yet</div>
          ) : (
            children.map((child) => (
              <div className="branch-child-row" key={child.id}>
                <button
                  className={`check${child.done ? " checked" : ""}`}
                  title={child.done ? "Mark as not done" : "Mark as done"}
                  onClick={() => api.toggleDone(child.id)}
                  tabIndex={-1}
                >
                  {child.done && (
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                      <path
                        d="M2.5 6.5 L5 9 L9.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
                {editingId === child.id ? (
                  <input
                    className="branch-child-text"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitEdit(child.id);
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => commitEdit(child.id)}
                  />
                ) : (
                  <span
                    className="branch-child-text"
                    style={child.done ? { textDecoration: "line-through" } : undefined}
                    onDoubleClick={() => startEdit(child)}
                  >
                    {child.content}
                  </span>
                )}
                <button
                  className="branch-child-del"
                  title="Delete"
                  onClick={() => api.deleteItem(child.id)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            placeholder="Add a sub-point"
            autoFocus
            onChange={(e) => {
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitChild();
              }
            }}
          />
        </div>
      </aside>
    </div>
  );
}
