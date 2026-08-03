import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useAppState } from "../store";
import type { Item, Section } from "../types";
import ContextMenu, { MenuEntry } from "./ContextMenu";
import ItemCard from "./ItemCard";
import SectionSwitcher from "./SectionSwitcher";
import ShortcutsSheet from "./ShortcutsSheet";

const IS_MAC = navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl";

interface Group {
  section: Section | null;
  items: Item[];
}

export default function Panel() {
  const { state, refresh } = useAppState();
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [itemMenu, setItemMenu] = useState<{ x: number; y: number; ids: number[] } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [renamingSection, setRenamingSection] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [appMenu, setAppMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number>();

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // Focus the quick-add input whenever the panel is summoned; brief toast on capture.
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    listen("panel-shown", () => {
      inputRef.current?.focus();
    }).then((f) => unlisteners.push(f));
    listen("captured", () => flashToast("Captured")).then((f) => unlisteners.push(f));
    return () => unlisteners.forEach((f) => f());
  }, [flashToast]);

  const sections = state?.sections ?? [];
  const items = state?.items ?? [];
  const activeSectionId = state?.activeSectionId ?? null;
  const activeSection = sections.find((s) => s.id === activeSectionId) ?? null;

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (i: Item) => !q || i.content.toLowerCase().includes(q);
    const result: Group[] = [];
    const unfiled = items.filter((i) => i.sectionId === null && match(i));
    if (unfiled.length) result.push({ section: null, items: unfiled });
    for (const s of sections) {
      const inSection = items.filter((i) => i.sectionId === s.id && match(i));
      // Show an empty section header only when it's the active target (and not searching).
      if (inSection.length || (!q && s.id === activeSectionId)) {
        result.push({ section: s, items: inSection });
      }
    }
    return result;
  }, [items, sections, query, activeSectionId]);

  const flatIds = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const copySelection = useCallback(
    (asList: boolean, ids?: number[]) => {
      const targets = (ids ?? selected)
        .slice()
        .sort((a, b) => flatIds.indexOf(a) - flatIds.indexOf(b))
        .map((id) => itemById.get(id))
        .filter((i): i is Item => !!i);
      if (!targets.length) return;
      const text = asList
        ? targets.map((i) => `- ${i.content.replace(/\n/g, "\n  ")}`).join("\n")
        : targets.map((i) => i.content).join("\n\n");
      api.copyText(text).then(() => flashToast(asList ? "Copied as list" : "Copied"));
    },
    [selected, flatIds, itemById, flashToast],
  );

  const deleteIds = useCallback(
    async (ids: number[]) => {
      for (const id of ids) await api.deleteItem(id);
      setSelected([]);
      refresh();
    },
    [refresh],
  );

  const onItemClick = (e: React.MouseEvent, id: number) => {
    if (e.ctrlKey || e.metaKey) {
      setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
      setAnchor(id);
    } else if (e.shiftKey && anchor !== null) {
      const a = flatIds.indexOf(anchor);
      const b = flatIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        setSelected(flatIds.slice(Math.min(a, b), Math.max(a, b) + 1));
      }
    } else {
      setSelected([id]);
      setAnchor(id);
    }
  };

  const onItemContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    const ids = selected.includes(id) ? selected : [id];
    if (!selected.includes(id)) {
      setSelected([id]);
      setAnchor(id);
    }
    setItemMenu({ x: e.clientX, y: e.clientY, ids });
  };

  // Global keyboard handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === "TEXTAREA" || target.tagName === "INPUT";
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowSwitcher((v) => !v);
        return;
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        if (showHelp || showSwitcher || itemMenu || sectionMenu || appMenu) return; // overlays close themselves
        if (editingId !== null) return;
        if (inField && (target as HTMLTextAreaElement).value) return;
        if (selected.length) {
          setSelected([]);
          return;
        }
        api.hidePanel();
        return;
      }
      if (inField || editingId !== null || showSwitcher || showHelp) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!flatIds.length) return;
        const current = anchor !== null ? flatIds.indexOf(anchor) : -1;
        const next =
          e.key === "ArrowDown"
            ? Math.min(current + 1, flatIds.length - 1)
            : Math.max(current === -1 ? flatIds.length - 1 : current - 1, 0);
        const id = flatIds[next];
        setSelected([id]);
        setAnchor(id);
        document
          .querySelector(`[data-item-id="${id}"]`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (e.key === " " && selected.length) {
        e.preventDefault();
        selected.forEach((id) => api.toggleDone(id));
      } else if (e.key === "Enter" && selected.length === 1) {
        e.preventDefault();
        setEditingId(selected[0]);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.length) {
        e.preventDefault();
        deleteIds(selected);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "c" && selected.length) {
        e.preventDefault();
        copySelection(false);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "c" && selected.length) {
        e.preventDefault();
        copySelection(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    flatIds,
    anchor,
    selected,
    editingId,
    showSwitcher,
    showHelp,
    itemMenu,
    sectionMenu,
    appMenu,
    copySelection,
    deleteIds,
  ]);

  const submitInput = async () => {
    const text = input.trim();
    if (!text) return;
    await api.addEntry(text);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    if (text.startsWith("# ")) {
      flashToast(`Section “${text.slice(2).trim()}”`);
    } else {
      requestAnimationFrame(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      });
    }
  };

  const menuEntries = (ids: number[]): MenuEntry[] => {
    const targets = ids.map((id) => itemById.get(id)).filter((i): i is Item => !!i);
    const allDone = targets.every((i) => i.done);
    const single = targets.length === 1;
    return [
      { label: "Copy", kbd: `${MOD} C`, onClick: () => copySelection(false, ids) },
      { label: "Copy as List", kbd: `${MOD} ⇧ C`, onClick: () => copySelection(true, ids) },
      {
        label: allDone ? "Mark as Not Done" : "Mark as Done",
        kbd: "Space",
        separatorBefore: true,
        onClick: () => ids.forEach((id) => api.toggleDone(id)),
      },
      {
        label: "Edit",
        kbd: "↵",
        disabled: !single,
        onClick: () => single && setEditingId(ids[0]),
      },
      {
        label: "Edit in New Window",
        kbd: `${MOD} ↵`,
        disabled: !single,
        onClick: () => single && api.openEditor(ids[0]),
      },
      {
        label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
        kbd: "Del",
        danger: true,
        separatorBefore: true,
        onClick: () => deleteIds(ids),
      },
    ];
  };

  const sectionMenuEntries = (id: number): MenuEntry[] => [
    {
      label: "Capture here",
      onClick: () => api.setActiveSection(id),
    },
    {
      label: "Rename",
      onClick: () => {
        const s = sections.find((x) => x.id === id);
        setRenameDraft(s?.name ?? "");
        setRenamingSection(id);
      },
    },
    {
      label: "Delete section",
      danger: true,
      separatorBefore: true,
      onClick: () => api.deleteSection(id),
    },
  ];

  const appMenuEntries = (): MenuEntry[] => {
    const theme = state?.theme ?? "system";
    const cycle: Record<string, string> = {
      system: "light",
      light: "dark",
      dark: "glass",
      glass: "system",
    };
    const nextTheme = cycle[theme] ?? "system";
    return [
      { label: "New section…", kbd: `${MOD} K`, onClick: () => setShowSwitcher(true) },
      { label: "Capture selection", onClick: () => api.captureNow() },
      {
        label: `Theme: ${theme[0].toUpperCase()}${theme.slice(1)}`,
        separatorBefore: true,
        onClick: async () => {
          await api.setTheme(nextTheme);
          refresh();
        },
      },
      {
        label: "Export to Markdown",
        onClick: async () => {
          const path = await api.exportMarkdown();
          flashToast(`Exported → ${path}`);
        },
      },
      {
        label: "Clear completed",
        danger: true,
        onClick: () => api.clearCompleted(),
      },
      { label: "Shortcuts", kbd: `${MOD} /`, separatorBefore: true, onClick: () => setShowHelp(true) },
    ];
  };

  const isEmpty = items.length === 0;

  return (
    <div className="panel">
      <div className="topbar" data-tauri-drag-region>
        <div className="search">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        <button
          className="icon-btn"
          title="Menu"
          onClick={(e) => {
            const r = (e.target as HTMLElement).getBoundingClientRect();
            setAppMenu({ x: r.right - 200, y: r.bottom + 6 });
          }}
        >
          ···
        </button>
      </div>

      <div className="list" ref={listRef} onMouseDown={(e) => {
        if (e.target === e.currentTarget) setSelected([]);
      }}>
        {isEmpty && !query ? (
          <div className="empty">
            <div className="empty-title">Nothing captured yet</div>
            <div className="empty-sub">
              An answer, a link, a half-formed prompt. It all waits here.
            </div>
            <div className="empty-rows">
              <div className="empty-row">
                <span>Capture selected text</span>
                <span>
                  <kbd>Left Shift</kbd> <kbd>Left Shift</kbd>
                </span>
              </div>
              <div className="empty-row">
                <span>Show Cooper</span>
                <span>
                  <kbd>Right Shift</kbd> <kbd>Right Shift</kbd>
                </span>
              </div>
              <div className="empty-row">
                <span>See all shortcuts</span>
                <span>
                  <kbd>{MOD} /</kbd>
                </span>
              </div>
            </div>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.section?.id ?? "unfiled"} className="group">
              {g.section && (
                <div
                  className="group-header"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSectionMenu({ x: e.clientX, y: e.clientY, id: g.section!.id });
                  }}
                >
                  {renamingSection === g.section.id ? (
                    <input
                      className="group-rename"
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={async (e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          if (renameDraft.trim())
                            await api.renameSection(g.section!.id, renameDraft);
                          setRenamingSection(null);
                        } else if (e.key === "Escape") {
                          setRenamingSection(null);
                        }
                      }}
                      onBlur={() => setRenamingSection(null)}
                    />
                  ) : (
                    <span
                      className={`group-name${g.section.id === activeSectionId ? " active" : ""}`}
                      title={
                        g.section.id === activeSectionId
                          ? "New captures land here"
                          : "Right-click for options"
                      }
                    >
                      {g.section.id === activeSectionId && <span className="active-dot" />}
                      {g.section.name}
                    </span>
                  )}
                  <span className="group-rule" />
                </div>
              )}
              {g.items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  selected={selected.includes(item.id)}
                  editing={editingId === item.id}
                  onClick={(e) => onItemClick(e, item.id)}
                  onContextMenu={(e) => onItemContextMenu(e, item.id)}
                  onToggleDone={() => api.toggleDone(item.id)}
                  onDoubleClick={() => setEditingId(item.id)}
                  onEditSave={async (content) => {
                    if (content.trim() && content !== item.content) {
                      await api.updateItem(item.id, content);
                    }
                    setEditingId(null);
                  }}
                  onEditCancel={() => setEditingId(null)}
                />
              ))}
              {g.section && g.items.length === 0 && (
                <div className="group-empty">Captures will land here</div>
              )}
            </div>
          ))
        )}
        {!isEmpty && query && flatIds.length === 0 && (
          <div className="no-results">No matches for “{query}”</div>
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}

      <div className="composer">
        <span className="composer-circle" />
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={`Add a note or a prompt${activeSection ? ` (${activeSection.name.toLowerCase()})` : ""}`}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitInput();
            }
          }}
        />
        {input.startsWith("#") && <span className="composer-hint">creates a section</span>}
      </div>

      {itemMenu && (
        <ContextMenu
          x={itemMenu.x}
          y={itemMenu.y}
          entries={menuEntries(itemMenu.ids)}
          onClose={() => setItemMenu(null)}
        />
      )}
      {sectionMenu && (
        <ContextMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          entries={sectionMenuEntries(sectionMenu.id)}
          onClose={() => setSectionMenu(null)}
        />
      )}
      {appMenu && (
        <ContextMenu
          x={appMenu.x}
          y={appMenu.y}
          entries={appMenuEntries()}
          onClose={() => setAppMenu(null)}
        />
      )}
      {showSwitcher && (
        <SectionSwitcher
          sections={sections}
          activeSectionId={activeSectionId}
          onSelect={(id) => api.setActiveSection(id)}
          onCreate={(name) => api.createSection(name)}
          onClose={() => setShowSwitcher(false)}
        />
      )}
      {showHelp && <ShortcutsSheet onClose={() => setShowHelp(false)} />}
    </div>
  );
}
