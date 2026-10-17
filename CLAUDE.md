# CLAUDE.md

Taxinha is a cross-platform (Windows/macOS/Linux) sticky-notes desktop app built on **Tauri 2**. Each note is its own frameless window; the headline feature is the pin button, which toggles "always on top". The UI, comments, user-facing strings and commit-facing docs are in **Brazilian Portuguese** — keep new code and copy consistent with that.

## Commands

```bash
npm install
npm run dev      # tauri dev — runs the app with the Rust backend in debug (also "Rodar em modo dev" in .vscode/launch.json)
npm run build    # tauri build — installers in src-tauri/target/release/bundle/
```

Windows installer without a local toolchain: `docker compose -f docker/compose.yml run --build --rm windows` (also the "Gerar instalador do Windows (Docker)" entry in `.vscode/launch.json`). It cross-compiles with `cargo-xwin` and outputs only the NSIS `*-setup.exe` to `dist/` (no `.msi` — WiX needs Windows). `node_modules`, `target` and caches live in Docker volumes, separate from the host's.

There are no tests, linters or JS build step. For Rust-only checks: `cargo check` / `cargo clippy` inside `src-tauri/`.

CI (`.github/workflows/build.yml`) builds installers for Windows, macOS arm64 + x64, and Linux (ubuntu-22.04). It runs only via `workflow_dispatch` (manual); run from a `v*` tag, it creates a draft GitHub release via `tauri-action`. Builds are unsigned.

## Layout

```
src/                 frontend — plain HTML/CSS/JS, no bundler, served as-is (frontendDist = ../src)
  index.html         markup for ONE note window (titlebar, colour popover, format bar, editor, statusbar)
  app.js             per-window logic; talks to Rust via window.__TAURI__ (withGlobalTauri)
  styles.css         design tokens + components, derived from docs/style.md
  fonts/             bundled Inter woff files (CSP forbids remote fonts)
src-tauri/
  src/main.rs        window creation, Tauri commands, tray menu, app lifecycle
  src/store.rs       Note model + persistence to notes.json
  src/welcome.rs     welcome note created on first run (title, HTML + matching plain text)
  tauri.conf.json    app id br.taxinha.notas, CSP, bundle config (no static windows)
  capabilities/default.json  permissions for windows labelled note-*
  icons/             generated from assets/icon.svg; tray.png / tray-template.png (macOS)
docs/style.md        design reference ("Linear"-style dark system) the UI follows
```

## Architecture

**One window per note.** Window label is `note-{id}`; Rust derives the note id from the calling window's label (`id_of`), so commands never take an id argument — the frontend just calls `invoke('save_text', { text })` etc. and it applies to its own note. All windows load the same `index.html`; `app.js` calls `load_note` on startup to get its data.

**Rust is the source of truth.** `Store` (`store.rs`) holds all notes in a `Mutex<FileData>` and sets a `dirty` flag on change. A background thread calls `flush()` every 800 ms; it writes atomically (`notes.json.tmp` → rename). Unreadable `notes.json` is backed up as `notes.corrompido-<ms>.json` before starting fresh — never overwrite user data. `flush()` is also called explicitly on delete, quit and `RunEvent::Exit`.

**Tauri commands** (`main.rs`, registered in `generate_handler!`): `load_note`, `save_text`, `set_pinned`, `set_color`, `set_collapsed`, `set_title`, `new_note`, `trash_note`. `new_note` and `trash_note` are `async` on purpose — creating/destroying windows from sync commands can deadlock on Windows. When adding a command, register it in `generate_handler!`; if it needs a new window API from JS, add the permission in `capabilities/default.json`.

**Geometry** is tracked from `WindowEvent::Moved/Resized` in `track_geometry`. Position is stored in *physical* pixels, size in *logical* pixels. `height` always stores the expanded height; while collapsed the window is `COLLAPSED_H` (36px, matches `--titlebar-h` in CSS). Saved positions are only restored if the titlebar would be on a connected monitor (`is_on_screen`); Windows' `-32000` minimise coordinates are ignored. A note created with `+` is placed by `beside`: next to its parent (right, else left, within the monitor work area); if another visible note already sits on that spot, it steps down by `COLLAPSED_H + 8` until free, so repeated `+` clicks cascade instead of stacking.

**Trash:** the ✕ button calls `trash_note`, which sets `trashedAt` and destroys the window (a note with no text and no title is removed outright). Only notes with `trashedAt == None` (`Store::active`) are opened at startup. Trashed notes are listed in the tray's "Lixeira" submenu (item ids `restore:<id>`, plus "Esvaziar lixeira"); the menu is rebuilt by `refresh_tray`, which runs on the main thread (macOS requirement) — call it whenever the trash changes. Notes older than `TRASH_TTL_MS` (30 days) are purged on load and hourly by the saver thread. There is no permanent delete outside the trash.

**Theme:** app-wide setting stored in `notes.json` (`FileData.theme`: `system` | `light` | `dark`, empty = system), chosen in the tray's "Tema" submenu (`CheckMenuItem`s with ids `theme:<value>`). `set_theme` saves it, updates every window's native background (`apply_background`: `PAPER` or `CARBON`; "system" uses `window.theme()`, re-applied on `WindowEvent::ThemeChanged`) and emits `theme-changed`; `app.js` reads it with `get_theme` and sets `<html data-theme>` (no attribute = follow the OS through `prefers-color-scheme`). In CSS the light theme redefines the same grey tokens (`--color-carbon`, `--color-mist`, …) plus the `--overlay-*`, `--selection` and `--shadow-popover` tokens — never use raw white/black overlays, use those tokens so both themes work.

**First run:** when `Store::is_first_run()` (no notes and `next_seq <= 1`, i.e. a fresh `notes.json`), `setup` creates the welcome note from `welcome.rs` instead of an empty one. The tray item "Como usar a Taxinha" (`help`) reopens it through the same `open_welcome`, which focuses an untouched copy (same title and HTML) if one is open instead of duplicating it. Its `HTML` must only use tags the `sanitize` whitelist keeps, and `TEXT` must equal what `toPlain` produces from that HTML.

**Lifecycle:** single-instance plugin (relaunch → `show_all`). Each note window appears in the taskbar (grouped under the app icon); on macOS the app has a Dock icon and `RunEvent::Reopen` → `show_all`. Closing the last window doesn't quit (`prevent_exit` when no exit code); with no notes open the app lives only in the tray, and only the tray "Sair" item exits. On Linux under Wayland, `GDK_BACKEND=x11` is forced (unless already set) so always-on-top works through XWayland.

**Frontend (`app.js`)**: a single IIFE. Text saves are debounced 250 ms and flushed on blur/window blur/beforeunload. Pin toggling is optimistic and reverts on error. Titlebar layout: pin on the far left, colour dot (`#colorBtn`, opens the swatch popover `#colorMenu`), name, then new / collapse / close on the right. It handles drag (`startDragging`) middle-click close (`auxclick` → `closeNote`, same as ✕) and double-click rename (inline `#titleInput` → `set_title`, max 80 chars). All titlebar buttons stay visible when collapsed; opening the colour popover on a collapsed note grows the window (`setSize`, not persisted since `height` is only tracked while expanded) and shrinks it back when the popover closes or the window loses focus. The note name (or first line) is mirrored to the native window title (`setTitle`) for the taskbar. The bottom-right grip calls `startResizeDragging`.

**Editor:** `#editor` is a `contenteditable` div; each line is a `<div>`, formatting is `<b>`/`<i>`/`<u>` (`styleWithCSS` off) plus text size as `<font size="2|3|5">` from `execCommand('fontSize')` (`SIZES` in app.js; real px sizes in the `.editor font[size]` CSS rules — keep the two in sync), and a checklist item is `<div class="check">` (checked: `check done`, box drawn in CSS `::before`). The note stores both `html` (the editor's `innerHTML`, re-sanitised to that whitelist on load by `sanitize`) and `text` (plain text via `toPlain`, items as `[ ] ` / `[x] `) — Rust only reads `text` (tray names, `is_blank`), and notes with empty `html` are rebuilt from `text` (`fromPlain`). `save_text` takes both. Typing `[]` at line start turns the line into an item, clicking the box toggles it, Enter on an item continues the list (the browser clones the block; `done` is cleared), Enter on an empty item or Backspace at its start leaves the list. Paste is always plain text. Formatting: Mod+B/I/U, Mod+Shift+> / Mod+Shift+< (text size, matched by `e.code` Period/Comma), or the floating `#formatBar` (N / I / S + three "A" size buttons) shown above a non-empty selection — hidden while the mouse drags a selection, repositioned on `selectionchange`/scroll/resize, buttons use `mousedown` preventDefault so the selection survives, and active state comes from `queryCommandState`. Bold must render at weight ≥ 600 or Chromium's `queryCommandState('bold')` (and Ctrl+B toggling off) breaks. Right-click keeps the native menu (spellcheck, cut/copy/paste) inside the editor. Shortcuts: Mod+Shift+P pin, Mod+N new note (Mod = ⌘ on Mac, Ctrl elsewhere). The native context menu is suppressed everywhere except the editor and the title input.

## Conventions

- **Colour labels** must stay in sync in three places: `COLORS` in `store.rs` (server-side validation), the `.swatch` buttons in `index.html`, and the `[data-color=...]` rules in `styles.css`. Empty string = no colour; `mono` maps to `--color-paper`, so it is white in the dark theme and black in the light one (its swatch label is switched by `renderMonoName`); a `#rrggbb` value is a per-note custom colour (validated by `is_valid_color`, picked through the "Personalizada" swatch → hidden `<input type="color">`, applied as an inline `--note-color` with `data-color="custom"`); new notes start with `DEFAULT_COLOR` (`yellow`, which is the `Default` for `Note.color`, so a note saved without a `color` field also becomes yellow).
- **Note model** uses `#[serde(rename_all = "camelCase", default)]`, so new fields need a `Default` value and appear camelCase in JS (`updatedAt`, `createdAt`). The file format has `version: 1`.
- **Design:** follow `docs/style.md` — near-black surfaces (Carbon `#0f1011` is the note background, also set as the native window background to avoid a white flash), Inter at weights 400–590, hairline borders. The only colour on screen is the note's label (stripe + dot); the pin button is deliberately colourless (pinned = filled white icon on a subtle grey background). Use the CSS custom properties in `styles.css` rather than raw colours.
- **CSP** (`tauri.conf.json`) is `default-src 'self'`: no CDNs, remote fonts or inline scripts. Keep all assets local.
- Rust errors returned to JS are `String`s; user-facing error text is in Portuguese.
