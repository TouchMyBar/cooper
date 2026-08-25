import { useEffect, useState } from "react";
import { api } from "../store";
import type { MacSetup } from "../types";

/// The one thing the user should do right now. Order is not cosmetic: granting
/// permission to a copy macOS is running from a temporary location can never
/// stick, so relocating always comes before granting.
function step(s: MacSetup) {
  if (s.tapRunning) {
    return {
      done: true,
      title: "Double-shift is working",
      lines: [
        "Tap Left Shift twice to capture whatever text is selected.",
        "Tap Right Shift twice to show or hide Cooper.",
      ],
    };
  }

  if (s.translocated && s.onReadOnlyVolume) {
    return {
      title: "Move Cooper out of its disk image",
      lines: [
        "Cooper is running from the disk image you downloaded, which macOS keeps read-only. Permissions granted here are forgotten every time you open it.",
        "1. Drag Cooper into your Applications folder.",
        "2. Eject the Cooper disk image.",
        "3. Open Cooper from Applications, then come back here.",
      ],
      note: s.realPath,
    };
  }

  if (s.translocated) {
    return {
      title: "Move Cooper to Applications",
      lines: [
        "macOS is running Cooper from a temporary copy, so it cannot remember permissions.",
        "Move Cooper into your Applications folder using Finder, then open it again.",
      ],
      note: s.realPath,
      fix: "Unlock this copy instead",
    };
  }

  if (s.willTranslocate) {
    return {
      title: "Unlock Cooper first",
      lines: [
        "Cooper is still marked as downloaded from the internet. Until that is cleared, macOS will keep running it from a temporary copy and no permission will stick.",
        "Click below, then quit and reopen Cooper.",
      ],
      note: s.realPath,
      fix: "Unlock Cooper",
    };
  }

  return {
    title: "Let Cooper watch for the double-tap",
    lines: [
      "Only a system permission can see a bare Shift key. Cooper reads nothing else and stores nothing.",
      "1. Click Open Accessibility Settings below.",
      "2. Click the padlock at the bottom left and enter your password.",
      "3. Tick the box next to Cooper in the list.",
    ],
    open: true,
  };
}

export default function MacSetupSheet({
  setup,
  onClose,
}: {
  setup: MacSetup;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

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

  const s = step(setup);

  const unlock = async () => {
    setBusy(null);
    try {
      await api.macRemoveQuarantine(setup.realPath);
      setBusy("Unlocked. Quit Cooper and open it again.");
    } catch (e) {
      setBusy(String(e));
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-title">{s.done ? "Set up" : "Set up double-shift"}</div>
        <div className="sheet-group">
          <div className="sheet-group-title">{s.title}</div>
          {s.lines.map((line) => (
            <p key={line} className="setup-line">
              {line}
            </p>
          ))}
          {s.note ? <p className="setup-path">{s.note}</p> : null}
          {busy ? <p className="setup-line">{busy}</p> : null}
          <div className="setup-actions">
            {s.open ? (
              <button onClick={() => api.macOpenAccessibility()}>
                Open Accessibility Settings
              </button>
            ) : null}
            {s.fix ? <button onClick={unlock}>{s.fix}</button> : null}
            <button onClick={onClose}>{s.done ? "Done" : "Close"}</button>
          </div>
          {s.done ? null : (
            <p className="setup-line setup-muted">
              This window updates on its own the moment it works — no need to restart Cooper.
            </p>
          )}
        </div>
        <div className="sheet-group">
          <div className="sheet-group-title">After a Cooper update</div>
          <p className="setup-line setup-muted">
            Cooper isn't signed with a paid Apple certificate, so macOS treats each new build as a
            different app and quietly drops the permission — the checkbox still looks ticked. If
            double-shift stops working after an update, open Accessibility settings, select Cooper,
            click <b>−</b> to remove it, then reopen Cooper and tick it again. Cooper will notice and
            reopen this guide on its own.
          </p>
        </div>
      </div>
    </div>
  );
}
