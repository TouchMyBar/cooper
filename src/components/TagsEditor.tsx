import { useEffect, useRef, useState } from "react";
import { api } from "../store";
import { PRESET_COLORS, parseTagPrefs, type TagDef, type TagPrefs } from "../tags";

// Settings → Tags: the color palette (recolor, rename, reorder, add, remove) plus
// how the search-bar picker and tagging mode behave. A sub-page, like shortcuts.
export default function TagsEditor({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState<TagPrefs | null>(null);
  // The tag whose color palette is open, and the one being dragged, if any.
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getState()
      .then((s) => setPrefs(parseTagPrefs(s.tagPrefs)))
      .catch(() => setPrefs(parseTagPrefs("")));
  }, []);

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

  if (!prefs) return null;

  // Every edit saves straight away; removing a color also takes it off notes.
  const save = (next: TagPrefs) => {
    setPrefs(next);
    api.setTagPrefs(JSON.stringify(next));
  };
  const updateTag = (id: string, patch: Partial<TagDef>) =>
    save({ ...prefs, tags: prefs.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const addTag = () => {
    const used = new Set(prefs.tags.map((t) => t.color));
    const p = PRESET_COLORS.find((c) => !used.has(c.color)) ?? PRESET_COLORS[0];
    const id = Date.now().toString(36);
    save({ ...prefs, tags: [...prefs.tags, { id, name: p.name, color: p.color }] });
    setColorFor(id);
  };

  // Drag a row's ≡ handle to reorder; rows swap live as the pointer crosses
  // them, and the new order is saved on release.
  const startReorder = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    setColorFor(null);
    setDragId(id);
    let tags = prefs.tags;
    const onMove = (ev: PointerEvent) => {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-tag-id]") ?? []);
      const over = rows.find((r) => {
        const b = r.getBoundingClientRect();
        return ev.clientY >= b.top && ev.clientY < b.bottom;
      })?.dataset.tagId;
      if (!over || over === id) return;
      const next = [...tags];
      const [moved] = next.splice(next.findIndex((t) => t.id === id), 1);
      next.splice(tags.findIndex((t) => t.id === over), 0, moved);
      tags = next;
      setPrefs((p) => p && { ...p, tags: next });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragId(null);
      if (tags !== prefs.tags) save({ ...prefs, tags });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <span className="sheet-title">Edit tags</span>
          <button className="settings-btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="settings-card" ref={listRef}>
          {prefs.tags.map((t, i) => (
            <div key={t.id} data-tag-id={t.id} className={dragId === t.id ? "tag-dragging" : undefined}>
              {i > 0 && <div className="settings-div" />}
              <div className="settings-row tag-row">
                <button
                  className="tag-swatch"
                  style={{ background: t.color }}
                  title="Change color"
                  onClick={() => setColorFor((cur) => (cur === t.id ? null : t.id))}
                />
                <input
                  className="tag-name"
                  value={t.name}
                  onChange={(e) => updateTag(t.id, { name: e.target.value })}
                />
                <button
                  className="settings-btn"
                  title="Remove this color (also from notes)"
                  disabled={prefs.tags.length === 1}
                  onClick={() => save({ ...prefs, tags: prefs.tags.filter((x) => x.id !== t.id) })}
                >
                  ✕
                </button>
                <span
                  className="tag-handle"
                  title="Drag to reorder"
                  onPointerDown={(e) => startReorder(e, t.id)}
                >
                  ≡
                </span>
              </div>
              {colorFor === t.id && (
                <div className="tag-palette">
                  {PRESET_COLORS.map((p) => (
                    <button
                      key={p.color}
                      className={`menu-swatch${p.color === t.color ? " on" : ""}`}
                      style={{ background: p.color }}
                      title={p.name}
                      onClick={() => {
                        updateTag(t.id, { color: p.color });
                        setColorFor(null);
                      }}
                    />
                  ))}
                  {/* The system color picker, behind a rainbow "custom" swatch. */}
                  <span className="tag-custom" title="Custom color…">
                    <input
                      type="color"
                      value={t.color}
                      onChange={(e) => updateTag(t.id, { color: e.target.value })}
                    />
                  </span>
                </div>
              )}
            </div>
          ))}
          <div className="settings-div" />
          <button className="settings-row settings-link" onClick={addTag}>
            <span className="settings-label">Add Color</span>
            <span className="settings-chev">+</span>
          </button>
        </div>

        <div className="settings-section-title">Behavior</div>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Animate tag picker</span>
            <button
              role="switch"
              aria-checked={prefs.animate}
              className={`switch${prefs.animate ? " on" : ""}`}
              onClick={() => save({ ...prefs, animate: !prefs.animate })}
            />
          </div>
          <div className="settings-div" />
          <div className="settings-row">
            <span className="settings-label">Tint app while tagging</span>
            <button
              role="switch"
              aria-checked={prefs.tint}
              className={`switch${prefs.tint ? " on" : ""}`}
              onClick={() => save({ ...prefs, tint: !prefs.tint })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
