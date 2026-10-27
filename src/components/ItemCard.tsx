import { useEffect, useRef, useState } from "react";
import { renderInline } from "../markdown";
import { imageDataCached } from "../store";
import type { TagDef } from "../tags";
import type { Attachment, Item } from "../types";

function ImageBody({ item, onCopy }: { item: Item; onCopy: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    imageDataCached(item.content)
      .then((s) => alive && setSrc(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [item.content]);

  if (failed) return <div className="card-content card-image-missing">Image unavailable</div>;
  if (!src) return <div className="card-image-loading" />;
  return (
    <img
      className="card-image"
      src={src}
      alt="captured"
      draggable={false}
      title="Click to copy image"
      onClick={(e) => {
        e.stopPropagation();
        onCopy();
      }}
    />
  );
}

function AttachmentThumb({
  att,
  onCopy,
  onRemove,
}: {
  att: Attachment;
  onCopy: () => void;
  onRemove: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    imageDataCached(att.path)
      .then((s) => alive && setSrc(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [att.path]);
  return (
    <span className="attachment-thumb-wrap">
      {src ? (
        <img
          className="attachment-thumb"
          src={src}
          alt="attachment"
          draggable={false}
          title="Click to copy image"
          onClick={(e) => {
            e.stopPropagation();
            onCopy();
          }}
        />
      ) : (
        <span className="attachment-thumb attachment-loading" />
      )}
      <button
        className="attachment-del"
        title="Remove"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ✕
      </button>
    </span>
  );
}

interface Props {
  item: Item;
  selected: boolean;
  /** Sub-branch mode is armed on this note (captures nest under it). */
  armed?: boolean;
  /** Being dragged to another section (the card stays put, dimmed). */
  lifted?: boolean;
  /** Carries the color tagging mode is stamping, so it wears a tint of it. */
  tinted?: boolean;
  editing: boolean;
  depth?: number;
  attachments?: Attachment[];
  /** This note's tags, in palette order. */
  tagDefs?: TagDef[];
  hasChildren?: boolean;
  childCount?: number;
  branchCollapsed?: boolean;
  branchStyle?: string;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onToggleDone: () => void;
  onEditSave: (content: string) => void;
  onEditCancel: () => void;
  onDoubleClick: () => void;
  onCopyImage: () => void;
  onCopyAttachment?: (path: string) => void;
  onDetach?: (attId: number) => void;
  onToggleBranch?: () => void;
  onOpenBranchPane?: () => void;
}

export default function ItemCard({
  item,
  selected,
  armed = false,
  lifted = false,
  tinted = false,
  editing,
  depth = 0,
  attachments,
  tagDefs = [],
  hasChildren = false,
  childCount = 0,
  branchCollapsed = false,
  branchStyle = "inline",
  onClick,
  onContextMenu,
  onPointerDown,
  onToggleDone,
  onEditSave,
  onEditCancel,
  onDoubleClick,
  onCopyImage,
  onCopyAttachment,
  onDetach,
  onToggleBranch,
  onOpenBranchPane,
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

  const isImage = item.kind === "image";
  // Inline collapse triangle at any depth (levels below the top are always
  // inline); the side-panel badge stays a top-level-only affordance.
  const inlineTri = hasChildren && (depth > 0 || branchStyle === "inline");
  const panelBadge = depth === 0 && hasChildren && branchStyle === "panel";

  // A tagged note's circle wears its tag color (split evenly between several);
  // marking it done fills the circle with that color behind the check.
  const n = tagDefs.length;
  const ring = tagDefs
    .map((t, i) => `${t.color} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`)
    .join(", ");

  const classes = ["card"];
  if (selected) classes.push("selected");
  if (armed) classes.push("sub-branch-parent");
  if (lifted) classes.push("lifted");
  if (tinted) classes.push("tinted");
  if (item.done) classes.push("done");
  if (isImage) classes.push("card-image-item");
  if (depth > 0) classes.push("is-child");

  return (
    <div
      className={classes.join(" ")}
      data-item-id={item.id}
      data-item-kind={item.kind}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      {inlineTri && (
        <button
          className="branch-tri"
          title={branchCollapsed ? "Expand branch" : "Collapse branch"}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onToggleBranch?.();
          }}
        >
          {branchCollapsed ? "▸" : "▾"}
        </button>
      )}
      <button
        className={`check${item.done ? " checked" : ""}${tagDefs.length ? " tagged" : ""}`}
        style={ring ? ({ "--ring": `conic-gradient(${ring})` } as React.CSSProperties) : undefined}
        aria-label={tagDefs.length ? `Tags: ${tagDefs.map((t) => t.name).join(", ")}` : undefined}
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
      <div className="card-main">
        {isImage ? (
          <ImageBody item={item} onCopy={onCopyImage} />
        ) : editing ? (
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
        {attachments && attachments.length > 0 && (
          <div className="card-attachments">
            {attachments.map((a) => (
              <AttachmentThumb
                key={a.id}
                att={a}
                onCopy={() => onCopyAttachment?.(a.path)}
                onRemove={() => onDetach?.(a.id)}
              />
            ))}
          </div>
        )}
      </div>
      {panelBadge && (
        <button
          className="branch-open"
          title="Open branch"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onOpenBranchPane?.();
          }}
        >
          ▸{childCount > 0 ? ` ${childCount}` : ""}
        </button>
      )}
    </div>
  );
}
