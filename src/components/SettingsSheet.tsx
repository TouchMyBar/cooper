import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { api } from "../store";
import { BUILTIN_CHOICES, preview, reloadSoundPrefs, resolveUrl } from "../sounds";
import { parseTagPrefs, type TagDef } from "../tags";
import type { SoundPrefs } from "../types";
import ContextMenu from "./ContextMenu";
import ShortcutsEditor from "./ShortcutsEditor";
import TagsEditor from "./TagsEditor";

const MAX_CUSTOM_BYTES = 1_500_000;
const EVENTS: { key: "capture" | "newNote"; label: string }[] = [
  { key: "capture", label: "Capture Sound" },
  { key: "newNote", label: "New Note Sound" },
];

export default function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState<SoundPrefs | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [popup, setPopup] = useState<{ key: "capture" | "newNote"; x: number; y: number } | null>(
    null,
  );
  const [exportDir, setExportDir] = useState("");
  const [vaultDir, setVaultDir] = useState("");
  const [detectedVault, setDetectedVault] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [tags, setTags] = useState<TagDef[]>([]);
  const fileFor = useRef<"capture" | "newNote" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getSoundPrefs().then(setPrefs).catch(() => setPrefs(null));
    api
      .getState()
      .then((s) => {
        setExportDir(s.exportDir);
        setVaultDir(s.obsidianVaultDir);
        setTags(parseTagPrefs(s.tagPrefs).tags);
      })
      .catch(() => {});
    api.detectObsidianVault().then(setDetectedVault).catch(() => setDetectedVault(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showEditor && !showTags) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, showEditor, showTags]);

  const prefFor = (key: "capture" | "newNote") =>
    key === "capture" ? prefs?.capture : prefs?.newNote;

  const setChoice = async (key: "capture" | "newNote", choice: string) => {
    if (choice === "custom") {
      const existing = prefFor(key)?.custom;
      if (!existing) {
        fileFor.current = key;
        fileInput.current?.click();
        return;
      }
      await api.setSoundPref(key, "custom", existing);
    } else {
      await api.setSoundPref(key, choice);
    }
    await refreshSounds();
  };

  const refreshSounds = async () => {
    setPrefs(await api.getSoundPrefs());
    reloadSoundPrefs();
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const key = fileFor.current;
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!key || !file) return;
    if (file.size > MAX_CUSTOM_BYTES) {
      setNote("That sound file is too large (max ~1.5 MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      await api.setSoundPref(key, "custom", String(reader.result));
      setNote(null);
      await refreshSounds();
    };
    reader.onerror = () => setNote("Couldn't read that file.");
    reader.readAsDataURL(file);
  };

  const browseExport = async () => {
    const sel = await open({
      directory: true,
      defaultPath: exportDir || undefined,
      title: "Choose export folder",
    });
    if (typeof sel === "string") {
      await api.setExportDir(sel);
      setExportDir(sel);
      setNote("Export folder updated.");
    }
  };

  const browseObsidian = async () => {
    const sel = await open({
      directory: true,
      defaultPath: vaultDir || detectedVault || undefined,
      title: "Choose your Obsidian vault folder",
    });
    if (typeof sel === "string") {
      await api.setObsidianVaultDir(sel);
      setVaultDir(sel);
      setNote("Obsidian vault pinned.");
    }
  };

  // Clear the pinned override so exports follow Obsidian's current vault again.
  const useAutoVault = async () => {
    await api.setObsidianVaultDir("");
    setVaultDir("");
    const d = await api.detectObsidianVault().catch(() => null);
    setDetectedVault(d);
    setNote(d ? "Using your current Obsidian vault." : "No open Obsidian vault found yet.");
  };

  if (showEditor) return <ShortcutsEditor onClose={() => setShowEditor(false)} />;
  if (showTags)
    return (
      <TagsEditor
        onClose={() => {
          setShowTags(false);
          api
            .getState()
            .then((s) => setTags(parseTagPrefs(s.tagPrefs).tags))
            .catch(() => {});
        }}
      />
    );

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-title">Settings</div>

        {/* Sounds */}
        <div className="settings-section-title">Sounds</div>
        {!prefs && <div className="settings-note">Loading…</div>}
        {prefs && (
          <div className="settings-card">
            {EVENTS.map(({ key, label }, i) => {
              const pref = prefFor(key);
              return (
                <div key={key}>
                  {i > 0 && <div className="settings-div" />}
                  <div className="settings-row">
                    <span className="settings-label">{label}</span>
                    <span className="settings-value">
                      {pref?.choice === "custom" && (
                        <button
                          className="settings-btn"
                          onClick={() => {
                            fileFor.current = key;
                            fileInput.current?.click();
                          }}
                          title="Choose a sound file"
                        >
                          File…
                        </button>
                      )}
                      <button
                        className="settings-btn settings-preview"
                        title="Preview"
                        onClick={() => preview(resolveUrl(pref), prefs.volume)}
                      >
                        ▶
                      </button>
                      <button
                        className="popup-btn"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          if (popup && popup.key === key) {
                            setPopup(null);
                            return;
                          }
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setPopup({ key, x: r.right - 150, y: r.bottom + 4 });
                        }}
                      >
                        {BUILTIN_CHOICES.find((c) => c.id === (pref?.choice ?? "none"))?.label ??
                          "None"}
                        <svg className="popup-chev" viewBox="0 0 10 6" width="9" height="6" aria-hidden>
                          <path
                            d="M1 1 L5 5 L9 1"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Tags — opens the palette editor */}
        <div className="settings-section-title">Tags</div>
        <div className="settings-card">
          <button className="settings-row settings-link" onClick={() => setShowTags(true)}>
            <span className="settings-label">Edit tags</span>
            <span className="settings-value">
              <span className="tags-preview" aria-hidden>
                {tags.map((t) => (
                  <span key={t.id} style={{ background: t.color }} />
                ))}
              </span>
              <span className="settings-chev">›</span>
            </span>
          </button>
        </div>

        {/* Export — single row */}
        <div className="settings-section-title">Export</div>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Folder</span>
            <span className="settings-value">
              <span className="settings-path" title={exportDir || "Documents"}>
                {exportDir || "Documents"}
              </span>
              <button className="settings-btn" onClick={browseExport}>
                Browse…
              </button>
            </span>
          </div>
        </div>

        {/* Obsidian — save notes as .md into a vault. Auto-follows Obsidian's
            current vault unless a folder is pinned. */}
        <div className="settings-section-title">Obsidian</div>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-label">Vault {vaultDir ? "(pinned)" : "(auto)"}</span>
            <span className="settings-value">
              <span
                className="settings-path"
                title={vaultDir || detectedVault || "No vault detected"}
              >
                {vaultDir || detectedVault || "Open a vault in Obsidian"}
              </span>
              {vaultDir && (
                <button
                  className="settings-btn"
                  onClick={useAutoVault}
                  title="Follow Obsidian's current vault instead"
                >
                  Auto
                </button>
              )}
              <button className="settings-btn" onClick={browseObsidian}>
                Browse…
              </button>
            </span>
          </div>
        </div>

        {/* Shortcuts — opens the full editor */}
        <div className="settings-section-title">Shortcuts</div>
        <div className="settings-card">
          <button className="settings-row settings-link" onClick={() => setShowEditor(true)}>
            <span className="settings-label">Edit shortcuts</span>
            <span className="settings-chev">›</span>
          </button>
        </div>

        {note && <div className="settings-note">{note}</div>}

        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac"
          style={{ display: "none" }}
          onChange={onFile}
        />
        {popup && (
          <ContextMenu
            x={popup.x}
            y={popup.y}
            entries={BUILTIN_CHOICES.map((c) => ({
              label: c.label,
              onClick: () => setChoice(popup.key, c.id),
            }))}
            onClose={() => setPopup(null)}
          />
        )}
      </div>
    </div>
  );
}
