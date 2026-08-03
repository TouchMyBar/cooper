# Cooper — the open-source Copper app for Windows, macOS & Linux

[![Release](https://img.shields.io/github/v/release/TouchMyBar/cooper)](https://github.com/TouchMyBar/cooper/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/TouchMyBar/cooper/total)](https://github.com/TouchMyBar/cooper/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Build](https://github.com/TouchMyBar/cooper/actions/workflows/build.yml/badge.svg)](https://github.com/TouchMyBar/cooper/actions)

**Cooper** is a free, open-source recreation of **Copper** —
the Mac capture app by **shadcn** — for people who want the same workflow on
**Windows and Linux**, not just macOS. If you searched for a *Copper app for
Windows*, a *Copper alternative*, or an *open-source Copper*, this is it.

> Cooper is an independent community project. It is **not affiliated with or
> endorsed by shadcn** — if you're on a Mac, go buy the original; it's great.

Copper's pitch, which Cooper replicates faithfully: the more you use AI, the
more you collect little things you don't want to lose — an answer worth
keeping, a link, an idea, three follow-up prompts while the current one is
still generating. Cooper combines the useful parts of a **to-do list, a
clipboard, and a scratchpad**, purpose-built for AI-assisted work. It sits
next to where you work, is always one shortcut away, and works with all your
AI apps, terminals, and browsers — ChatGPT, Claude, Cursor, anything.

**Local and private.** No sync, no telemetry, no account. Everything lives in
a single SQLite file on your machine.

<p align="center">
  <img src="docs/screenshot-dark.png" width="330" alt="Cooper dark theme — empty state with capture shortcuts" />
  <img src="docs/screenshot-glass.png" width="330" alt="Cooper glass theme — captured items with inline markdown formatting" />
</p>

## Download

Grab the latest build from **[Releases](https://github.com/TouchMyBar/cooper/releases/latest)** —
no compiling needed:

| OS | File to download |
| --- | --- |
| **Windows** | `Cooper_x.y.z_x64-setup.exe` (installer) or `Cooper_x.y.z_x64_en-US.msi` |
| **macOS** (Intel & Apple Silicon) | `Cooper_x.y.z_universal.dmg` |
| **Linux** | `Cooper_x.y.z_amd64.AppImage` (portable — `chmod +x` and run), or `.deb` / `.rpm` |

First-run notes:

- **Windows**: SmartScreen may warn because the binary is unsigned — click
  *More info → Run anyway*.
- **macOS**: unsigned app; right-click → *Open* the first time (or
  `xattr -dr com.apple.quarantine /Applications/Cooper.app`). Grant
  **Accessibility** permission for the double-shift capture.
- **Linux**: the AppImage needs no install. On Wayland use the fallback
  hotkeys (see below).

## How it works

- Select text anywhere → **double-tap Left Shift** → captured.
- Think of a follow-up prompt → **double-tap Right Shift** → Cooper appears,
  type it, keep working.
- Send items back into your AI apps and check them off as you go.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Capture selected text (any app) | `Left Shift` + `Left Shift` |
| Show / hide Cooper (any app) | `Right Shift` + `Right Shift` |
| Show / hide (fallback) | `Ctrl/Cmd` + `Shift` + `Space` |
| Capture (fallback) | `Ctrl/Cmd` + `Shift` + `C` |
| Switch / create section | `Ctrl/Cmd` + `K` |
| Copy selected · Copy as list | `Ctrl/Cmd` + `C` · `Ctrl/Cmd` + `Shift` + `C` |
| Mark as done / Edit / Delete | `Space` / `Enter` / `Del` |
| Shortcut sheet | `Ctrl/Cmd` + `/` |

## Features

- **Capture panel** — frameless, always-on-top, docked to the edge of your
  screen, summoned and dismissed entirely from the keyboard.
- **Sections** — type `# Name` to create one; everything you capture lands in
  the active section until you switch (`Ctrl/Cmd+K`). Right-click a header to
  rename, delete, or retarget captures.
- **Inline formatting** — cards render `**bold**`, `*italic*`,
  `~~strikethrough~~`, and `` `code` ``. (Underscore emphasis is intentionally
  unsupported so captured snake_case and `__dunder__` code isn't mangled.)
- **Copy as List** — multi-select items and copy them back out as a Markdown
  list, ready to paste into a prompt.
- **Themes** — System / Light / Dark / **Glass**. Glass is a translucent
  liquid-glass look built on each OS's cheapest compositor effect: Windows DWM
  acrylic, macOS `NSVisualEffectView` vibrancy (GPU-composited, effectively
  free). Linux gets plain translucency; KWin or picom can blur it.
- **Tray app** — closes to the tray, optional start-at-login, single-instance.
- **Your data stays yours** — one SQLite file, plus one-click *Export to
  Markdown* so nothing is ever locked in.

## Building from source

Prerequisites: [Rust](https://rustup.rs), Node 18+, and the
[Tauri 2 platform prerequisites](https://tauri.app/start/prerequisites/)
(WebView2 on Windows — preinstalled on Win 11; `libwebkit2gtk-4.1` etc. on
Linux).

```sh
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce installers/bundles for your OS
```

One Tauri 2 codebase (Rust core + web UI in the OS webview) compiles to a
~10 MB native binary on every platform. No Electron.

## Platform notes

- **macOS** — the double-shift capture uses a low-level event tap, which
  requires the Accessibility permission. Without it, the fallback hotkeys
  still work.
- **Linux** — the raw keyboard hook works on X11; on Wayland use the fallback
  hotkeys.
- **Capture mechanics** — capturing simulates the platform copy chord and
  reads the clipboard. If nothing was selected, your previous clipboard is
  restored untouched.

## Data

- Database: `cooper.db` in the app data directory
  (`%APPDATA%/app.cooper.desktop` on Windows,
  `~/Library/Application Support/app.cooper.desktop` on macOS,
  `~/.local/share/app.cooper.desktop` on Linux).
- `⋯ → Export to Markdown` writes a checklist-style `cooper-export.md` to
  your Documents folder.

## License

[Apache-2.0](LICENSE) — fork it, ship it, build on it.
