import { useEffect, useRef, useState } from "react";
import { api } from "../store";
import {
  ACTION_LABELS,
  ACTION_ORDER,
  DEFAULT_BINDS,
  eventToAccel,
  formatAccel,
  resolveBinds,
  type Action,
  type Binds,
} from "../keybinds";

// Shortcuts that are fixed by design (shown for reference, not rebindable here).
const FIXED: [string, string][] = [
  ["Capture selected text", "Left Shift × 2"],
  ["Show / hide Cooper", "Right Shift × 2"],
  ["Navigate list", "↑ / ↓"],
  ["Zoom in / out / reset", `${navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl"} + / − / 0`],
  ["Hide panel", "Esc"],
];

export default function ShortcutsEditor({ onClose }: { onClose: () => void }) {
  const [binds, setBinds] = useState<Binds>(resolveBinds());
  const [recording, setRecording] = useState<Action | null>(null);
  const recordingRef = useRef<Action | null>(null);
  recordingRef.current = recording;

  useEffect(() => {
    api
      .getState()
      .then((s) => setBinds(resolveBinds(s.keybinds)))
      .catch(() => {});
  }, []);

  // Esc closes the page (unless capturing a shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !recordingRef.current) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Capture the next key combo for the action being recorded.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const accel = eventToAccel(e);
      if (!accel) return; // a lone modifier — keep waiting
      const next = { ...binds, [recording]: accel };
      setBinds(next);
      setRecording(null);
      api.setKeybinds(JSON.stringify(next));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, binds]);

  const resetAll = () => {
    setBinds({ ...DEFAULT_BINDS });
    setRecording(null);
    api.setKeybinds(JSON.stringify(DEFAULT_BINDS));
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-title-row">
          <span className="sheet-title">Edit shortcuts</span>
          <button className="settings-btn" onClick={resetAll}>
            Reset all
          </button>
        </div>

        <div className="settings-card">
          {ACTION_ORDER.map((a, i) => (
            <div key={a}>
              {i > 0 && <div className="settings-div" />}
              <div className="settings-row">
                <span className="settings-label">{ACTION_LABELS[a]}</span>
                <button
                  className={`popup-btn${recording === a ? " recording" : ""}`}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => setRecording(recording === a ? null : a)}
                >
                  {recording === a ? "Press keys…" : formatAccel(binds[a])}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="settings-section-title">Fixed</div>
        <div className="settings-card">
          {FIXED.map(([label, keys], i) => (
            <div key={label}>
              {i > 0 && <div className="settings-div" />}
              <div className="settings-row">
                <span className="settings-label">{label}</span>
                <span className="settings-path">{keys}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
