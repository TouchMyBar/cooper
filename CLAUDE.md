# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run tauri dev      # dev (Vite on :1420 + Rust core)
npm run tauri build    # installers/bundles for the host OS
npm run build          # tsc && vite build — the only typecheck gate
node scripts/gen-sounds.mjs   # regenerate src/sounds-builtin.ts
```

Prerequisites: Rust, Node 18+, Tauri 2 platform prerequisites.

**There are no tests, linters, or formatters** — no ESLint/Prettier/Biome/rustfmt config,
no `#[cfg(test)]`, no test runner. The only automated quality gate is `tsc --strict`
with `noUnusedLocals`/`noUnusedParameters` (an unused import fails the build).
CI (`.github/workflows/build.yml`) runs `tauri-action` on macOS/Ubuntu 22.04/Windows;
it typechecks only implicitly via `beforeBuildCommand`. Verify changes by running the app.
Style is convention-only: 2-space, double quotes, trailing commas, ~95 col.

## Architecture

Tauri 2: Rust core + React 18/TS/Vite webview. No router, no state library, no CSS
framework. Runtime deps are only `react`, `react-dom`, `@tauri-apps/api`,
`@tauri-apps/plugin-dialog`.

### The data flow, which everything else follows from

**SQLite is the single source of truth and there is no optimistic UI.** Every mutation is
a fire-and-forget `invoke` → Rust writes the DB → Rust emits `"refresh"` → `useAppState`
(`src/store.ts:101`) re-fetches the *entire* `AppState` and the whole tree re-renders.
There is no client-side item cache. Don't add local mirrors of item state; add a command
and let `refresh` carry it.

- `src/store.ts` — the whole Rust bridge and the only state hook. A flat `api` object of
  `invoke` wrappers (one per `#[tauri::command]`), plus `imageDataCached`, `applyTheme`,
  `openLabeledWindow`.
- Rust events consumed by the UI: `refresh`, `panel-shown`, `captured`, `note-added`.

### Window routing

`src/App.tsx` (16 lines) routes on the **native window label**, not a URL — `draw` →
`DrawWindow`, `editor-<id>` → `Editor`, else `Panel`. Secondary windows are created from
JS (`openLabeledWindow`) with `url: "/"`; URL fragments and Rust-built runtime windows
both failed to load the asset protocol on Windows. **A new window label must also be added
to `src-tauri/capabilities/default.json`** (`["main", "editor-*", "draw"]`) or every Tauri
API call from it is denied.

### Rust core (`src-tauri/src/`)

| File | Role |
| --- | --- |
| `main.rs` | Builder, plugin + command registration, setup |
| `commands.rs` | Every `#[tauri::command]`; each mutator ends by emitting `refresh` |
| `db.rs` | Schema, `AppState`, additive `ALTER TABLE` migrations |
| `capture.rs` | Double-shift listener, fallback hotkeys, copy-chord capture |
| `panel.rs` | Show/hide/toggle/position; Windows focus hand-back |
| `tray.rs`, `glass.rs` | Tray menu; per-OS backdrop (acrylic / vibrancy / none) |

Migrations are additive `ALTER TABLE` statements whose errors are ignored (`db.rs:96-118`) —
follow that pattern rather than introducing a version-numbered migration system.

### The Panel is the monolith

`src/components/Panel.tsx` (~1100 lines) owns search, composer, multi-select, all global
key handling, drag-drop, paste, context menus, toasts, and the update banner. Other
components are small and leaf-ish (`ItemCard`, `SectionSwitcher`, `BranchPanel`,
`ContextMenu`, `SettingsSheet`, `ShortcutsEditor`, `ShortcutsSheet`, `Editor`).
`src/draw/shapes.ts` is a deliberately pure, dependency-free model (no React, no Tauri);
`DrawWindow.tsx` keeps its shape model in **refs, mutated imperatively**, with React state
only for the toolbar.

## Invariants that bite

1. **`src/types.ts` is a hand-written mirror of the Rust structs.** Rust uses
   `#[serde(rename_all = "camelCase")]`, so JS sees camelCase over a snake_case DB.
   Changing a Rust struct breaks the frontend **with no compile error** — update
   `types.ts` in the same change.
2. **Items are a flat list, not a tree.** A "child" is an ordinary `Item` with
   `parentId !== null`, regrouped client-side. Nesting is capped at one level by the UI
   only (`renderItem` recurses only at `depth === 0`); the schema does not enforce it.
3. **`kind === "image"` means `content` is an absolute file path, not text.** Check `kind`
   before touching `content`.
4. **Composer syntax (`# Name` / `## Name`) is parsed in Rust** (`commands.rs:31-48`), not
   JS. The `##` "clears the board" effect is purely a UI scroll illusion (a computed
   trailing spacer + scroll-to-top); Rust never collapses other sections.
5. **Overlays own Escape via capture-phase listeners** *and* Panel defensively early-returns
   when an overlay flag is set. A new overlay needs both halves or Esc hides the whole panel.
6. **Native OS file drop is disabled on purpose** (`dragDropEnabled: false`) so the webview
   delivers image *bytes* via HTML5 DnD. Images always travel as base64 + extension.
7. **`src/sounds-builtin.ts` is generated** — edits are lost on the next `gen-sounds.mjs`.
   `loadSoundPrefs()` must run before `play()` or playback is a silent no-op.
8. **Shortcuts are listed in three places that drift**: `keybinds.ts` `DEFAULT_BINDS` (the
   real behavior), `ShortcutsSheet.tsx` `GROUPS`, `ShortcutsEditor.tsx` `FIXED`, plus
   hardcoded `kbd:` labels in Panel's `menuEntries`. Only `keybinds.ts` is live.
9. `keybinds.ts` collapses `ctrlKey || metaKey` into one `mod` token by design — Ctrl and
   Cmd are indistinguishable. It covers **in-app** actions only.

## Global capture: platform reality

Left-Shift×2 (capture) and Right-Shift×2 (toggle) live entirely in Rust
(`capture.rs:27-86`) on an `rdev` listener thread, and are **compiled out on macOS**:
`rdev` is declared under `[target.'cfg(not(target_os = "macos"))'.dependencies]` and the
listener is started under the same `cfg` (`main.rs:73-74`), because rdev's macOS event tap
crashes (SIGTRAP in HIToolbox). On macOS only the fallback global shortcuts
`CmdOrCtrl+Shift+Space` / `CmdOrCtrl+Shift+C` exist. **The README, `ShortcutsSheet`,
`ShortcutsEditor`, and the Panel empty state all advertise double-shift unconditionally on
every platform** — that copy is wrong on macOS.

Capture itself simulates the platform copy chord via `enigo` and reads the clipboard,
using a zero-width sentinel to tell "nothing selected" from "same text re-copied". On
macOS `enigo`'s synthetic events require the **Accessibility** permission, so the fallback
capture hotkey silently captures nothing without it. Unsigned builds run under Gatekeeper
**App Translocation** from a randomized path, which prevents Accessibility grants from
persisting; `xattr -dr com.apple.quarantine /Applications/Cooper.app` is required first.
