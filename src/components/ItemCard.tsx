import { useEffect, useRef, useState } from "react";
import { renderInline } from "../markdown";
import type { Item } from "../types";

interface Props {
  item: Item;
  selected: boolean;
  editing: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onToggleDone: () => void;
  onEditSave: (content: string) => void;
  onEditCancel: () => void;
  onDoubleClick: () => void;
}

export default function ItemCard({
  item,
  selected,
  editing,
  onClick,
  onContextMenu,
  onToggleDone,
  onEditSave,
  onEditCancel,
  onDoubleClick,
}: Props) {
  const [draft, setDraft] = useState(item.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(item.content);
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      }
    }
  }, [editing, item.content]);

  const classes = ["card"];
  if (selected) classes.push("selected");
  if (item.done) classes.push("done");

  return (
    <div
      className={classes.join(" ")}
      data-item-id={item.id}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      <button
        className={`check${item.done ? " checked" : ""}`}
        title={item.done ? "Mark as not done" : "Mark as done"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleDone();
        }}
        tabIndex={-1}
      >
        {item.done && (
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
      {editing ? (
        <textarea
          ref={taRef}
          className="card-edit"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onEditSave(draft);
            } else if (e.key === "Escape") {
              onEditCancel();
            }
          }}
          onBlur={() => onEditSave(draft)}
        />
      ) : (
        <div className="card-content">{renderInline(item.content)}</div>
      )}
    </div>
  );
}
