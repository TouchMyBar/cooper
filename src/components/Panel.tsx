import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, useAppState, useMacSetup } from "../store";
import type { Attachment, Item, Section } from "../types";
import BranchPanel from "./BranchPanel";
import ContextMenu, { MenuEntry } from "./ContextMenu";
import ItemCard from "./ItemCard";
import MacSetupSheet from "./MacSetupSheet";
import SectionSwitcher from "./SectionSwitcher";
import ShortcutsSheet from "./ShortcutsSheet";
import SettingsSheet from "./SettingsSheet";
import { runUpdateCheck } from "../update";
import { loadSoundPrefs, play } from "../sounds";
import { eventToAccel, resolveBinds } from "../keybinds";

const IS_MAC = navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl";
// Deepest branch nesting (top-level = 0). Mirrors db::MAX_BRANCH_DEPTH.
const MAX_BRANCH_DEPTH = 10;

// Read a Blob into (base64, ext) for handing raw image bytes to the backend.
function readImageBlob(blob: Blob): Promise<{ base64: string; ext: string }> {
  const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg").split("+")[0];
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // strip the "data:*/*;base64," prefix
      const result = String(reader.result);
      resolve({ base64: result.slice(result.indexOf(",") + 1), ext });
    };
    reader.readAsDataURL(blob);
  });
}

// Pull every image out of a DataTransfer (covers both file-manager files and
// image data dragged from a browser or another app).
function imageBlobsFrom(dt: DataTransfer): Blob[] {
  const blobs: Blob[] = [];
  for (const file of Array.from(dt.files)) {
    if (file.type.startsWith("image/")) blobs.push(file);
  }
  if (blobs.length === 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) blobs.push(f);
      }
    }
  }
  return blobs;
}

interface Group {
  section: Section | null;
  items: Item[];
  collapsed: boolean;
  total: number;
}

export default function Panel() {
  const { state, refresh } = useAppState();
  const macSetup = useMacSetup();
  // Only meaningful on macOS, where the double-shift listener needs a permission.
  const needsSetup = !!macSetup && macSetup.applicable && !macSetup.tapRunning;
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
  const [dropCount, setDropCount] = useState<number | null>(null);
  const [update, setUpdate] = useState<{ tag: string; url: string } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMacSetup, setShowMacSetup] = useState(false);
  const [branchPaneId, setBranchPaneId] = useState<number | null>(null);
  const [composerMenu, setComposerMenu] = useState<{ x: number; y: number } | null>(null);
  const [spacerHeight, setSpacerHeight] = useState(0);
  // True while navigating notes with Tab: Enter then copies the focused note
  // (and a second Enter on the same note also marks it done).
  const [tabMode, setTabMode] = useState(false);
  const enterCopyRef = useRef<number | null>(null);
  // Sub-branch mode: while set, captured/typed notes nest under this parent id.
  const [subBranchParentId, setSubBranchParentId] = useState<number | null>(null);
  const subBranchParentIdRef = useRef<number | null>(null);
  const updateCheckedRef = useRef(false);
  const setupPromptedRef = useRef(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeGroupRef = useRef<HTMLDivElement>(null);
  const prevActiveRef = useRef<number | null | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number>();

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // Drop straight into note-taking: focus the composer and put the caret at the
  // end. Runs on the next frame so it works right as the window becomes visible.
  const focusComposer = useCallback(() => {
    setTabMode(false);
    enterCopyRef.current = null;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, []);

  // Sub-branch mode: arm makes future captures/typed notes nest under `id`;
  // disarm returns to normal top-level capturing. The backend mirrors the parent
  // (via set_capture_parent) so both the capture and typed-note paths honor it.
  const armSubBranch = useCallback(
    (id: number) => {
      setSubBranchParentId(id);
      api.setCaptureParent(id);
      flashToast("Sub-branch mode · captures nest here · Esc to exit");
    },
    [flashToast],
  );
  const disarmSubBranch = useCallback(() => {
    setSubBranchParentId((cur) => {
      if (cur !== null) api.setCaptureParent(null);
      return null;
    });
  }, []);

  // Keep a ref in sync so the once-registered capture listener reads the live value.
  useEffect(() => {
    subBranchParentIdRef.current = subBranchParentId;
  }, [subBranchParentId]);

  // Focus the quick-add input whenever the panel is summoned; brief toast + sound
  // on capture; sound on any new note.
  useEffect(() => {
    loadSoundPrefs();
    const unlisteners: (() => void)[] = [];
    listen("panel-shown", () => focusComposer()).then((f) => unlisteners.push(f));
    listen("captured", () => {
      flashToast(subBranchParentIdRef.current !== null ? "Added as sub-branch" : "Captured");
      play("capture");
    }).then((f) => unlisteners.push(f));
    listen("note-added", () => play("newNote")).then((f) => unlisteners.push(f));
    return () => unlisteners.forEach((f) => f());
  }, [flashToast, focusComposer]);

  // Also focus on first mount (e.g. the window is already visible at launch).
  useEffect(() => {
    focusComposer();
  }, [focusComposer]);

  // Once per launch, run the daily update check (the date gate lives in the DB).
  // Surface the guide by itself the first time we notice double-shift is inert;
  // the shortcut is advertised as working, so silence would just look broken.
  useEffect(() => {
    if (!needsSetup || setupPromptedRef.current) return;
    setupPromptedRef.current = true;
    setShowMacSetup(true);
  }, [needsSetup]);

  useEffect(() => {
    if (!state || updateCheckedRef.current) return;
    updateCheckedRef.current = true;
    runUpdateCheck(state, setUpdate);
  }, [state]);

  // Save a batch of image blobs, showing a single summary toast.
  const saveImageBlobs = useCallback(
    async (blobs: Blob[]) => {
      let added = 0;
      for (const blob of blobs) {
        try {
          const { base64, ext } = await readImageBlob(blob);
          added += await api.addImage(base64, ext);
        } catch (e) {
          console.error("image save failed", e);
        }
      }
      if (added) flashToast(`Added ${added} image${added === 1 ? "" : "s"}`);
      return added;
    },
    [flashToast],
  );

  // Attach a batch of image blobs to an existing (text) note — a "mixed note".
  const saveAttachments = useCallback(
    async (itemId: number, blobs: Blob[]) => {
      let n = 0;
      for (const blob of blobs) {
        try {
          const { base64, ext } = await readImageBlob(blob);
          await api.attachImage(itemId, base64, ext);
          n++;
        } catch (e) {
          console.error("attach failed", e);
        }
      }
      if (n) flashToast(`Attached ${n} image${n === 1 ? "" : "s"}`);
      return n;
    },
    [flashToast],
  );

  // HTML5 drag & drop (native OS drop is disabled so we get image *bytes*, which
  // works for file managers, browsers and screenshots alike — and lets us keep
  // the cursor in "copy" state instead of the OS "not allowed" badge).
  useEffect(() => {
    const dragCount = (dt: DataTransfer | null) => {
      if (!dt) return 0;
      if (dt.files.length) return dt.files.length;
      return Array.from(dt.items).filter((i) => i.kind === "file").length;
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      const hasFiles = Array.from(e.dataTransfer.types).includes("Files");
      if (!hasFiles) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      // Some sources (e.g. browser image drags) only expose the count on drop,
      // so fall back to 1 rather than showing 0 during hover.
      setDropCount((c) => c ?? (dragCount(e.dataTransfer) || 1));
    };
    const onDragLeave = (e: DragEvent) => {
      // Only clear when the pointer actually leaves the window.
      if (e.relatedTarget === null && e.clientX <= 0 && e.clientY <= 0) setDropCount(null);
      else if (e.relatedTarget === null) setDropCount(null);
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      setDropCount(null);
      const blobs = imageBlobsFrom(e.dataTransfer);
      if (blobs.length) {
        // Dropping onto a text card attaches to it (mixed note); onto empty
        // space (or an image card) creates standalone image notes.
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const card = el?.closest("[data-item-id]") as HTMLElement | null;
        const targetId = card ? Number(card.getAttribute("data-item-id")) : null;
        const targetKind = card?.getAttribute("data-item-kind");
        if (targetId != null && targetKind && targetKind !== "image") {
          await saveAttachments(targetId, blobs);
        } else {
          await saveImageBlobs(blobs);
        }
        return;
      }
      // Non-image drops: fall back to dropped text / filenames as notes.
      const text = e.dataTransfer.getData("text/plain").trim();
      const names = Array.from(e.dataTransfer.files).map((f) => f.name);
      const lines = text ? [text] : names;
      let added = 0;
      for (const line of lines) {
        if (line.trim()) {
          await api.addEntry(line.trim());
          added++;
        }
      }
      if (added) flashToast(`Added ${added} item${added === 1 ? "" : "s"}`);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [saveImageBlobs, saveAttachments, flashToast]);

  // Paste (Ctrl/Cmd+V) an image anywhere in the panel → capture it. Text paste
  // into the composer is left untouched.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const blobs: Blob[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) blobs.push(f);
        }
      }
      if (blobs.length) {
        e.preventDefault();
        saveImageBlobs(blobs);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [saveImageBlobs]);

  const sections = state?.sections ?? [];
  const items = state?.items ?? [];
  const activeSectionId = state?.activeSectionId ?? null;
  const activeSection = sections.find((s) => s.id === activeSectionId) ?? null;

  // Branch children grouped by parent id (children are ordinary items).
  const childrenByParent = useMemo(() => {
    const m = new Map<number, Item[]>();
    for (const i of items) {
      if (i.parentId !== null) {
        const arr = m.get(i.parentId) ?? [];
        arr.push(i);
        m.set(i.parentId, arr);
      }
    }
    return m;
  }, [items]);

  // Image attachments grouped by the text item they belong to (mixed notes).
  const attachmentsByItem = useMemo(() => {
    const m = new Map<number, Attachment[]>();
    for (const a of state?.attachments ?? []) {
      const arr = m.get(a.itemId) ?? [];
      arr.push(a);
      m.set(a.itemId, arr);
    }
    return m;
  }, [state?.attachments]);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const matchText = (i: Item) => i.content.toLowerCase().includes(q);
    // A top-level item matches search if it — or any of its children — matches.
    const match = (i: Item) =>
      !q || matchText(i) || (childrenByParent.get(i.id) ?? []).some(matchText);
    const top = (i: Item) => i.parentId === null;
    const result: Group[] = [];
    const unfiled = items.filter((i) => top(i) && i.sectionId === null && match(i));
    if (unfiled.length)
      result.push({ section: null, items: unfiled, collapsed: false, total: unfiled.length });
    for (const s of sections) {
      const inSection = items.filter((i) => top(i) && i.sectionId === s.id && match(i));
      // Searching expands everything that matches; otherwise collapsed sections
      // stay listed as compressed one-line dropdowns.
      const collapsed = !q && s.collapsed;
      if (q) {
        if (inSection.length) {
          result.push({ section: s, items: inSection, collapsed: false, total: inSection.length });
        }
      } else {
        result.push({
          section: s,
          items: collapsed ? [] : inSection,
          collapsed,
          total: inSection.length,
        });
      }
    }
    return result;
  }, [items, sections, query, activeSectionId, childrenByParent]);

  // Visual order of item ids for keyboard nav/range-select: each top item, then
  // its visible inline children.
  const flatIds = useMemo(() => {
    const ids: number[] = [];
    // Recurse through every visible inline level (top items keep their panel
    // style; deeper levels are always inline).
    const walk = (it: Item, depth: number) => {
      ids.push(it.id);
      const inline = depth < MAX_BRANCH_DEPTH && (depth > 0 || it.branchStyle === "inline");
      if (inline && !it.collapsed) {
        for (const c of childrenByParent.get(it.id) ?? []) walk(c, depth + 1);
      }
    };
    for (const g of groups) for (const it of g.items) walk(it, 0);
    return ids;
  }, [groups, childrenByParent]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Depth of each item (0 = top-level), memoized for the branch-depth cap.
  const depthById = useMemo(() => {
    const m = new Map<number, number>();
    const depthOf = (id: number): number => {
      const cached = m.get(id);
      if (cached !== undefined) return cached;
      const it = itemById.get(id);
      const d = it && it.parentId != null ? depthOf(it.parentId) + 1 : 0;
      m.set(id, d);
      return d;
    };
    for (const i of items) depthOf(i.id);
    return m;
  }, [items, itemById]);
  const binds = useMemo(() => resolveBinds(state?.keybinds), [state?.keybinds]);

  // Any section switch/create exits sub-branch mode ("Ctrl+K to start the top again").
  useEffect(() => {
    disarmSubBranch();
  }, [activeSectionId, disarmSubBranch]);

  // Auto-disarm if the sticky parent was deleted out from under us.
  useEffect(() => {
    if (subBranchParentId !== null && !itemById.has(subBranchParentId)) disarmSubBranch();
  }, [itemById, subBranchParentId, disarmSubBranch]);
  // Visual ids within the active section only — used for Tab cycling.
  const activeFlatIds = useMemo(
    () => flatIds.filter((id) => (itemById.get(id)?.sectionId ?? null) === activeSectionId),
    [flatIds, itemById, activeSectionId],
  );

  // Terminal-style "clear the board": size a trailing spacer so the active
  // section's header can scroll to the very top, leaving blank space below.
  useLayoutEffect(() => {
    if (query || !listRef.current || !activeGroupRef.current || activeSectionId === null) {
      setSpacerHeight(0);
      return;
    }
    const room = listRef.current.clientHeight - activeGroupRef.current.offsetHeight - 8;
    setSpacerHeight(Math.max(0, room));
  }, [activeSectionId, groups, query]);

  // On a section create/switch (the "clear" moment) pin the active section to
  // the top. Gated on the previous id so unrelated refreshes don't yank the view.
  useLayoutEffect(() => {
    if (query) {
      prevActiveRef.current = activeSectionId;
      return;
    }
    if (prevActiveRef.current === activeSectionId) return;
    prevActiveRef.current = activeSectionId;
    requestAnimationFrame(() => activeGroupRef.current?.scrollIntoView({ block: "start" }));
  }, [activeSectionId, spacerHeight, query]);

  const copyImage = useCallback(
    (item: Item) => {
      api.copyImage(item.content).then(() => flashToast("Image copied"));
    },
    [flashToast],
  );

  const copySelection = useCallback(
    (asList: boolean, ids?: number[]) => {
      const targets = (ids ?? selected)
        .slice()
        .sort((a, b) => flatIds.indexOf(a) - flatIds.indexOf(b))
        .map((id) => itemById.get(id))
        .filter((i): i is Item => !!i);
      if (!targets.length) return;
      // A lone image copies as a real image; otherwise copy the text items' text.
      if (targets.length === 1 && targets[0].kind === "image") {
        copyImage(targets[0]);
        return;
      }
      const textItems = targets.filter((i) => i.kind !== "image");
      if (!textItems.length) {
        // Multiple images selected — copy the first as an image.
        copyImage(targets[0]);
        return;
      }
      // Include a parent's branch children as indented sub-bullets, skipping any
      // child already in the selection to avoid duplication.
      const selectedSet = new Set(textItems.map((i) => i.id));
      // Emit an item and its whole (non-selected) branch as indented bullets.
      const bulletTree = (i: Item, indent: string): string => {
        let out = `${indent}- ${i.content.replace(/\n/g, `\n${indent}  `)}`;
        for (const c of childrenByParent.get(i.id) ?? []) {
          if (!selectedSet.has(c.id)) out += `\n${bulletTree(c, `${indent}  `)}`;
        }
        return out;
      };
      const text = asList
        ? textItems.map((i) => bulletTree(i, "")).join("\n")
        : textItems
            .map((i) => {
              const kidLines = (childrenByParent.get(i.id) ?? [])
                .filter((c) => !selectedSet.has(c.id))
                .map((c) => bulletTree(c, ""));
              return kidLines.length ? `${i.content}\n${kidLines.join("\n")}` : i.content;
            })
            .join("\n\n");
      api.copyText(text).then(() => flashToast(asList ? "Copied as list" : "Copied"));
    },
    [selected, flatIds, itemById, childrenByParent, flashToast, copyImage],
  );

  const deleteIds = useCallback(
    async (ids: number[]) => {
      for (const id of ids) await api.deleteItem(id);
      setSelected([]);
      refresh();
    },
    [refresh],
  );

  // Create a branch sub-point under a parent and drop straight into editing it.
  const createChild = useCallback(
    async (parentId: number) => {
      try {
        await api.setItemCollapsed(parentId, false);
        const newId = await api.addChild(parentId, "");
        setEditingId(newId);
      } catch (e) {
        flashToast(typeof e === "string" ? e : "Couldn't add sub-point");
      }
    },
    [flashToast],
  );

  // Save notes + their whole branches to the vault (one .md per section).
  const exportObsidian = useCallback(
    (ids: number[]) => {
      api
        .exportNotesObsidian(ids)
        .then((paths) =>
          flashToast(
            paths.length > 1 ? `Saved ${paths.length} notes to Obsidian` : "Saved to Obsidian",
          ),
        )
        .catch((e) => flashToast(typeof e === "string" ? e : "Obsidian save failed"));
    },
    [flashToast],
  );

  const onItemClick = (e: React.MouseEvent, id: number) => {
    setTabMode(false);
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
      const accel = eventToAccel(e);

      if (accel && accel === binds.switchSection) {
        e.preventDefault();
        disarmSubBranch();
        setShowSwitcher((v) => !v);
        return;
      }
      if (accel && accel === binds.help) {
        e.preventDefault();
        setShowHelp((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        if (showHelp || showSettings || showMacSetup || showSwitcher || itemMenu || sectionMenu || appMenu)
          return; // overlays close themselves
        if (editingId !== null) return;
        if (inField && (target as HTMLTextAreaElement).value) return;
        // First Esc exits sub-branch mode without hiding the panel; a second Esc
        // (now disarmed, nothing selected) falls through to hide.
        if (subBranchParentId !== null) {
          disarmSubBranch();
          setSelected([]);
          return;
        }
        if (selected.length) {
          setSelected([]);
          return;
        }
        api.hidePanel();
        return;
      }
      if (inField || editingId !== null || showSwitcher || showHelp) return;

      if (e.key === "Tab") {
        // Cycle through the active section's notes, wrapping back to the composer.
        // Tabbing also exits sub-branch mode ("we tab out").
        e.preventDefault();
        disarmSubBranch();
        if (!activeFlatIds.length) {
          focusComposer();
          return;
        }
        const cur = anchor !== null ? activeFlatIds.indexOf(anchor) : -1;
        const step = e.shiftKey ? -1 : 1;
        const nextIdx = cur === -1 ? (e.shiftKey ? activeFlatIds.length - 1 : 0) : cur + step;
        if (nextIdx < 0 || nextIdx >= activeFlatIds.length) {
          setSelected([]);
          setAnchor(null);
          focusComposer();
          return;
        }
        const id = activeFlatIds[nextIdx];
        setSelected([id]);
        setAnchor(id);
        setTabMode(true);
        enterCopyRef.current = null;
        document.querySelector(`[data-item-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      // In Tab mode: Enter copies the focused note; a second Enter on the same
      // note also marks it done — so "Tab, Enter" grabs a note to the clipboard
      // without opening Cooper's menus.
      if (e.key === "Enter" && tabMode && selected.length === 1) {
        e.preventDefault();
        const id = selected[0];
        if (enterCopyRef.current === id) {
          api.toggleDone(id);
          enterCopyRef.current = null;
        } else {
          copySelection(false, [id]);
          enterCopyRef.current = id;
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setTabMode(false);
        if (!flatIds.length) return;
        const dir = e.key === "ArrowDown" ? 1 : -1;
        const anchorIdx = anchor !== null ? flatIds.indexOf(anchor) : -1;
        if (e.shiftKey && anchorIdx !== -1) {
          // Shift+Arrow extends a contiguous range: the anchor stays put as the
          // pivot while the opposite end of the current selection is the moving
          // lead, so holding Shift and tapping down/up grows (or shrinks) the list.
          const idxs = selected.map((s) => flatIds.indexOf(s)).filter((i) => i !== -1);
          const lo = idxs.length ? Math.min(...idxs) : anchorIdx;
          const hi = idxs.length ? Math.max(...idxs) : anchorIdx;
          const leadIdx = anchorIdx === lo ? hi : lo;
          const nextLead = Math.min(Math.max(leadIdx + dir, 0), flatIds.length - 1);
          setSelected(
            flatIds.slice(Math.min(anchorIdx, nextLead), Math.max(anchorIdx, nextLead) + 1),
          );
          document
            .querySelector(`[data-item-id="${flatIds[nextLead]}"]`)
            ?.scrollIntoView({ block: "nearest" });
        } else {
          const next =
            dir === 1
              ? Math.min(anchorIdx + 1, flatIds.length - 1)
              : Math.max(anchorIdx === -1 ? flatIds.length - 1 : anchorIdx - 1, 0);
          const id = flatIds[next];
          setSelected([id]);
          setAnchor(id);
          document
            .querySelector(`[data-item-id="${id}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      } else if (accel && accel === binds.markDone && selected.length) {
        e.preventDefault();
        selected.forEach((id) => api.toggleDone(id));
      } else if (accel && accel === binds.edit && selected.length === 1) {
        const it = itemById.get(selected[0]);
        if (it && it.kind !== "image") {
          e.preventDefault();
          setEditingId(selected[0]);
        }
      } else if ((accel === binds.del || e.key === "Backspace") && selected.length) {
        e.preventDefault();
        deleteIds(selected);
      } else if (accel && accel === binds.copy && selected.length) {
        e.preventDefault();
        copySelection(false);
      } else if (accel && accel === binds.copyList && selected.length) {
        e.preventDefault();
        copySelection(true);
      } else if (accel && accel === binds.createBranch && selected.length === 1) {
        const it = itemById.get(selected[0]);
        if (it && it.kind !== "image") {
          e.preventDefault();
          const depth = depthById.get(it.id) ?? 0;
          if (depth >= MAX_BRANCH_DEPTH) {
            flashToast(`Max nesting is ${MAX_BRANCH_DEPTH} levels`);
          } else {
            // On the LAST note of its group (top-level in the section, or the last
            // child of its parent) Ctrl+B arms sub-branch mode so captures/typed
            // notes nest under it — works at any depth, so you can sub-branch a
            // sub-branch. Elsewhere it just inserts an empty sub-point to edit.
            const siblings =
              it.parentId === null
                ? groups.find((g) => (g.section?.id ?? null) === activeSectionId)?.items ?? []
                : childrenByParent.get(it.parentId) ?? [];
            const isLast = siblings.length > 0 && siblings[siblings.length - 1].id === it.id;
            if (isLast) armSubBranch(it.id);
            else createChild(it.id);
          }
        }
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
    showSettings,
    showMacSetup,
    itemMenu,
    sectionMenu,
    appMenu,
    copySelection,
    deleteIds,
    createChild,
    itemById,
    binds,
    activeFlatIds,
    focusComposer,
    tabMode,
    groups,
    activeSectionId,
    subBranchParentId,
    armSubBranch,
    disarmSubBranch,
    childrenByParent,
    depthById,
    flashToast,
  ]);

  const submitInput = async () => {
    const text = input.trim();
    if (!text) return;
    await api.addEntry(text);
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    const isSection = text.startsWith("# ") || text.startsWith("## ");
    if (isSection) {
      // The backend clears the sub-branch parent on every section command; mirror
      // it here so re-declaring the ALREADY-active section (no activeSectionId
      // change, so the disarm effect won't fire) still exits sub-branch mode.
      disarmSubBranch();
      flashToast(`Section “${text.replace(/^#{1,2}\s*/, "")}”`);
      // the activeSectionId pin effect handles the scroll
    } else {
      // Keep the newest note visible within the pinned active section (not the
      // blank trailing spacer).
      requestAnimationFrame(() => {
        if (activeGroupRef.current) activeGroupRef.current.scrollIntoView({ block: "end" });
        else listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
      });
    }
    // Stay in note-taking mode after every add / section switch.
    focusComposer();
  };

  const menuEntries = (ids: number[]): MenuEntry[] => {
    const targets = ids.map((id) => itemById.get(id)).filter((i): i is Item => !!i);
    const allDone = targets.every((i) => i.done);
    const single = targets.length === 1;
    const target = single ? targets[0] : null;
    const singleImage = single && target!.kind === "image";
    const targetDepth = single ? depthById.get(target!.id) ?? 0 : 0;
    const isTop = single && target!.parentId === null;
    // Branching is allowed at any level up to the depth cap (sub-branch a sub-branch).
    const canBranch = single && !singleImage && targetDepth < MAX_BRANCH_DEPTH;
    const hasChildren = single ? (childrenByParent.get(target!.id)?.length ?? 0) > 0 : false;
    const panelStyle = single && target!.branchStyle === "panel";

    const entries: MenuEntry[] = [
      {
        label: singleImage ? "Copy Image" : "Copy",
        kbd: `${MOD} C`,
        onClick: () => copySelection(false, ids),
      },
      { label: "Copy as List", kbd: `${MOD} ⇧ C`, onClick: () => copySelection(true, ids) },
      {
        label: allDone ? "Mark as Not Done" : "Mark as Done",
        kbd: "Space",
        separatorBefore: true,
        onClick: () => ids.forEach((id) => api.toggleDone(id)),
      },
    ];

    if (singleImage) {
      // Turn an image into a captioned note, then edit the caption.
      entries.push({
        label: "Add Note",
        onClick: async () => {
          await api.addNoteToImage(ids[0]);
          setEditingId(ids[0]);
        },
      });
    } else {
      entries.push({
        label: "Edit",
        kbd: "↵",
        disabled: !single,
        onClick: () => single && setEditingId(ids[0]),
      });
      entries.push({
        label: "Edit in New Window",
        kbd: `${MOD} ↵`,
        disabled: !single,
        onClick: () => single && api.openEditor(ids[0]),
      });
    }

    if (canBranch) {
      entries.push({
        label: hasChildren ? "Add Sub-point" : "Create Branch",
        kbd: `${MOD} B`,
        separatorBefore: true,
        onClick: () => createChild(target!.id),
      });
      if (hasChildren && isTop) {
        // Side-panel branch style only applies to top-level notes; deeper levels
        // are always shown inline.
        entries.push({
          label: panelStyle ? "Show Inline" : "Show as Side Panel",
          onClick: async () => {
            const next = panelStyle ? "inline" : "panel";
            await api.setBranchStyle(target!.id, next);
            if (next === "panel") setBranchPaneId(target!.id);
          },
        });
        if (panelStyle) {
          entries.push({ label: "Open Branch", onClick: () => setBranchPaneId(target!.id) });
        }
      }
    }

    entries.push({
      label: single ? "Save to Obsidian" : `Save ${targets.length} to Obsidian`,
      separatorBefore: true,
      onClick: () => exportObsidian(ids),
    });

    entries.push({
      label: targets.length > 1 ? `Delete ${targets.length} items` : "Delete",
      kbd: "Del",
      danger: true,
      separatorBefore: true,
      onClick: () => deleteIds(ids),
    });
    return entries;
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
      ...(macSetup?.applicable
        ? [
            {
              label: needsSetup ? "Set up double-shift…" : "Double-shift setup…",
              onClick: () => setShowMacSetup(true),
            },
          ]
        : []),
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
      {
        label: state?.updateCheckEnabled === false ? "Enable update check" : "Disable update check",
        separatorBefore: true,
        onClick: async () => {
          await api.setUpdateCheckEnabled(!(state?.updateCheckEnabled ?? true));
        },
      },
      { label: "Settings…", onClick: () => setShowSettings(true) },
      { label: "Shortcuts", kbd: `${MOD} /`, onClick: () => setShowHelp(true) },
    ];
  };

  // Render one item card, plus its inline branch children (depth-capped at 1).
  const renderItem = (item: Item, depth: number): React.ReactNode => {
    const kids = childrenByParent.get(item.id) ?? [];
    const hasKids = kids.length > 0;
    // Top-level notes honor their panel/inline style; deeper levels are always
    // inline, recursing until the depth cap.
    const inlineBranch = depth < MAX_BRANCH_DEPTH && (depth > 0 || item.branchStyle === "inline");
    const finishEdit = async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed && item.parentId !== null && !item.content.trim()) {
        await api.deleteItem(item.id); // discard an empty, freshly-created sub-point
      } else if (trimmed && content !== item.content) {
        await api.updateItem(item.id, content);
      }
      setEditingId(null);
    };
    return (
      <div key={item.id}>
        <ItemCard
          item={item}
          depth={depth}
          selected={selected.includes(item.id)}
          armed={subBranchParentId === item.id}
          editing={editingId === item.id}
          attachments={attachmentsByItem.get(item.id)}
          hasChildren={hasKids}
          childCount={kids.length}
          branchCollapsed={item.collapsed}
          branchStyle={item.branchStyle}
          onClick={(e) => onItemClick(e, item.id)}
          onContextMenu={(e) => onItemContextMenu(e, item.id)}
          onToggleDone={() => api.toggleDone(item.id)}
          onDoubleClick={() => item.kind !== "image" && setEditingId(item.id)}
          onEditSave={finishEdit}
          onEditCancel={() => finishEdit(item.content)}
          onCopyImage={() => copyImage(item)}
          onCopyAttachment={(path) => api.copyImage(path).then(() => flashToast("Image copied"))}
          onDetach={(attId) => api.detachAttachment(attId).then(refresh)}
          onToggleBranch={() => api.setItemCollapsed(item.id, !item.collapsed)}
          onOpenBranchPane={() => setBranchPaneId(item.id)}
        />
        {inlineBranch && hasKids && !item.collapsed && (
          <div className="branch-children">{kids.map((c) => renderItem(c, depth + 1))}</div>
        )}
      </div>
    );
  };

  const branchPaneParent = branchPaneId != null ? itemById.get(branchPaneId) : undefined;
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
              {needsSetup && (
                <button className="setup-nudge" onClick={() => setShowMacSetup(true)}>
                  Double-shift needs a one-time setup on macOS — set it up
                </button>
              )}
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
            <div
              key={g.section?.id ?? "unfiled"}
              className="group"
              ref={g.section && g.section.id === activeSectionId ? activeGroupRef : undefined}
            >
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
                    <button
                      className={`group-name${g.section.id === activeSectionId ? " active" : ""}`}
                      title={g.collapsed ? "Expand" : "Collapse"}
                      onClick={() => api.setSectionCollapsed(g.section!.id, !g.collapsed)}
                    >
                      <span className="group-tri">{g.collapsed ? "▸" : "▾"}</span>
                      {g.section.id === activeSectionId && <span className="active-dot" />}
                      {g.section.name}
                      {g.collapsed && g.total > 0 && (
                        <span className="group-count">{g.total}</span>
                      )}
                    </button>
                  )}
                  <span className="group-rule" />
                </div>
              )}
              {g.items.map((item) => renderItem(item, 0))}
              {g.section && !g.collapsed && g.total === 0 && (
                <div className="group-empty">Captures will land here</div>
              )}
            </div>
          ))
        )}
        {!isEmpty && query && flatIds.length === 0 && (
          <div className="no-results">No matches for “{query}”</div>
        )}
        {!query && spacerHeight > 0 && (
          <div className="board-spacer" style={{ height: spacerHeight }} aria-hidden />
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}

      {dropCount !== null && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-plus">+</div>
            <div className="drop-title">
              Add {dropCount} {dropCount === 1 ? "file" : "files"}
            </div>
            <div className="drop-sub">
              {items.filter((i) => i.sectionId === activeSectionId).length} already in{" "}
              {activeSection ? activeSection.name : "Inbox"}
            </div>
          </div>
        </div>
      )}

      {update && (
        <div className="update-banner">
          <span className="update-text">Cooper {update.tag} is available</span>
          <button
            className="update-download"
            onClick={() => {
              api.openUrl(update.url);
              setUpdate(null);
            }}
          >
            Download
          </button>
          <button className="update-dismiss" title="Dismiss" onClick={() => setUpdate(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="composer">
        <button
          className="composer-add"
          title="Attach or draw"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setComposerMenu({ x: r.left, y: r.top - 8 });
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <path
              d="M8 3.2 V12.8 M3.2 8 H12.8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
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
            } else if (e.key === "Tab") {
              // Tab from the composer jumps into the active section's notes.
              e.preventDefault();
              disarmSubBranch();
              if (!activeFlatIds.length) return;
              const id = e.shiftKey ? activeFlatIds[activeFlatIds.length - 1] : activeFlatIds[0];
              setSelected([id]);
              setAnchor(id);
              setTabMode(true);
              enterCopyRef.current = null;
              inputRef.current?.blur();
              document
                .querySelector(`[data-item-id="${id}"]`)
                ?.scrollIntoView({ block: "nearest" });
            }
          }}
        />
        {input.startsWith("#") && (
          <span className="composer-hint">
            {input.startsWith("##")
              ? "clears the board — scroll up for the rest"
              : "creates a section"}
          </span>
        )}
        {subBranchParentId !== null && !input.startsWith("#") && (
          <span className="composer-hint subbranch-hint">
            ↳ sub-branch mode · nesting under “
            {(itemById.get(subBranchParentId)?.content || "note").replace(/\n/g, " ").slice(0, 28)}
            ” · Esc to exit
          </span>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const blobs = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (blobs.length) saveImageBlobs(blobs);
        }}
      />

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
      {composerMenu && (
        <ContextMenu
          x={composerMenu.x}
          y={composerMenu.y}
          entries={[
            { label: "Attach Images…", onClick: () => fileInputRef.current?.click() },
            { label: "Create Drawing…", onClick: () => api.openDraw() },
          ]}
          onClose={() => setComposerMenu(null)}
        />
      )}
      {branchPaneParent && (
        <BranchPanel
          parent={branchPaneParent}
          children={childrenByParent.get(branchPaneParent.id) ?? []}
          onClose={() => setBranchPaneId(null)}
        />
      )}
      {showSwitcher && (
        <SectionSwitcher
          sections={sections}
          activeSectionId={activeSectionId}
          onSelect={(id) => {
            api.setActiveSection(id);
            focusComposer();
          }}
          onCreate={(name) => {
            api.createSection(name);
            focusComposer();
          }}
          onClose={() => setShowSwitcher(false)}
        />
      )}
      {showHelp && (
        <ShortcutsSheet
          onClose={() => setShowHelp(false)}
          needsSetup={needsSetup}
          onSetup={() => {
            setShowHelp(false);
            setShowMacSetup(true);
          }}
        />
      )}
      {showSettings && <SettingsSheet onClose={() => setShowSettings(false)} />}
      {showMacSetup && macSetup && (
        <MacSetupSheet setup={macSetup} onClose={() => setShowMacSetup(false)} />
      )}
    </div>
  );
}
