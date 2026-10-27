import { useEffect, useRef } from "react";

export interface MenuEntry {
  label: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onClick: () => void;
}

/** A Finder-style row of color dots (note tags) in place of a text item. */
export interface MenuSwatches {
  swatches: { label: string; color: string; on: boolean; onClick: () => void }[];
  /** Small caption above the dots. */
  caption?: string;
  separatorBefore?: boolean;
}

export type MenuRow = MenuEntry | MenuSwatches;

interface Props {
  x: number;
  y: number;
  entries: MenuRow[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = Math.min(x, window.innerWidth - rect.width - 8);
    const ny = Math.min(y, window.innerHeight - rect.height - 8);
    el.style.left = `${Math.max(8, nx)}px`;
    el.style.top = `${Math.max(8, ny)}px`;
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) => (
        <div key={i}>
          {entry.separatorBefore && <div className="menu-sep" />}
          {"swatches" in entry && entry.caption && (
            <div className="menu-caption">{entry.caption}</div>
          )}
          {"swatches" in entry ? (
            <div className="menu-swatches">
              {entry.swatches.map((s) => (
                <button
                  key={s.label}
                  className={`menu-swatch${s.on ? " on" : ""}`}
                  style={{ background: s.color }}
                  title={s.on ? `Remove ${s.label}` : s.label}
                  onClick={() => {
                    onClose();
                    s.onClick();
                  }}
                />
              ))}
            </div>
          ) : (
            <button
              className={`menu-item${entry.danger ? " danger" : ""}`}
              disabled={entry.disabled}
              onClick={() => {
                onClose();
                entry.onClick();
              }}
            >
              <span>{entry.label}</span>
              {entry.kbd && <span className="menu-kbd">{entry.kbd}</span>}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
