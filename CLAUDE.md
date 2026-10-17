# CLAUDE.md

Taxinha is a cross-platform (Windows/macOS/Linux) sticky-notes desktop app built on **Tauri 2**. Each note is its own frameless window; the headline feature is the pin button, which toggles "always on top". The UI, comments, user-facing strings and commit-facing docs are in **Brazilian Portuguese** — keep new code and copy consistent with that.

## Commands

```bash
npm install
npm run dev      # tauri dev — runs the app with the Rust backend in debug
npm run build    # tauri build — installers in src-tauri/target/release/bundle/
```

There are no tests, linters or JS build step. For Rust-only checks: `cargo check` / `cargo clippy` inside `src-tauri/`.

CI (`.github/workflows/build.yml`) builds installers for Windows, macOS arm64 + x64, and Linux (ubuntu-22.04) on every push/PR; a `v*` tag creates a draft GitHub release via `tauri-action`. Builds are unsigned.

## Layout

```
src/                 frontend — plain HTML/CSS/JS, no bundler, served as-is (frontendDist = ../src)
  index.html         markup for ONE note window (titlebar, ⋯ menu, textarea, statusbar)
  app.js             per-window logic; talks to Rust via window.__TAURI__ (withGlobalTauri)
  styles.css         design tokens + components, derived from docs/style.md
  fonts/             bundled Inter woff files (CSP forbids remote fonts)
src-tauri/
  src/main.rs        window creation, Tauri commands, tray menu, app lifecycle
  src/store.rs       Note model + persistence to notes.json
  tauri.conf.json    app id br.taxinha.notas, CSP, bundle config (no static windows)
  capabilities/default.json  permissions for windows labelled note-*
  icons/             generated from assets/icon.svg; tray.png / tray-template.png (macOS)
docs/style.md        design reference ("Linear"-style dark system) the UI follows
```

## Architecture

**One window per note.** Window label is `note-{id}`; Rust derives the note id from the calling window's label (`id_of`), so commands never take an id argument — the frontend just calls `invoke('save_text', { text })` etc. and it applies to its own note. All windows load the same `index.html`; `app.js` calls `load_note` on startup to get its data.

**Rust is the source of truth.** `Store` (`store.rs`) holds all notes in a `Mutex<FileData>` and sets a `dirty` flag on change. A background thread calls `flush()` every 800 ms; it writes atomically (`notes.json.tmp` → rename). Unreadable `notes.json` is backed up as `notes.corrompido-<ms>.json` before starting fresh — never overwrite user data. `flush()` is also called explicitly on delete, quit and `RunEvent::Exit`.

**Tauri commands** (`main.rs`, registered in `generate_handler!`): `load_note`, `save_text`, `set_pinned`, `set_color`, `set_collapsed`, `new_note`, `delete_note`. `new_note` and `delete_note` are `async` on purpose — creating/destroying windows from sync commands can deadlock on Windows. When adding a command, register it in `generate_handler!`; if it needs a new window API from JS, add the permission in `capabilities/default.json`.

**Geometry** is tracked from `WindowEvent::Moved/Resized` in `track_geometry`. Position is stored in *physical* pixels, size in *logical* pixels. `height` always stores the expanded height; while collapsed the window is `COLLAPSED_H` (36px, matches `--titlebar-h` in CSS). Saved positions are only restored if the titlebar would be on a connected monitor (`is_on_screen`); Windows' `-32000` minimise coordinates are ignored.

**Lifecycle:** single-instance plugin (relaunch → `show_all`). Closing the last window doesn't quit (`prevent_exit` when no exit code); the app lives in the tray, and only the tray "Sair" item exits. macOS uses `ActivationPolicy::Accessory` (no Dock icon). On Linux under Wayland, `GDK_BACKEND=x11` is forced (unless already set) so always-on-top works through XWayland.

**Frontend (`app.js`)**: a single IIFE. Text saves are debounced 250 ms and flushed on blur/window blur/beforeunload. Pin toggling is optimistic and reverts on error. Delete requires a second click within 3 s if the note has text. Titlebar handles drag (`startDragging`) and double-click collapse; the bottom-right grip calls `startResizeDragging`. Shortcuts: Mod+Shift+P pin, Mod+N new note (Mod = ⌘ on Mac, Ctrl elsewhere). The native context menu is suppressed except inside the textarea.

## Conventions

- **Colour labels** must stay in sync in three places: `COLORS` in `store.rs` (server-side validation), the `.swatch` buttons in `index.html`, and the `[data-color=...]` rules in `styles.css`. Empty string = no colour.
- **Note model** uses `#[serde(rename_all = "camelCase", default)]`, so new fields need a `Default` value and appear camelCase in JS (`updatedAt`, `createdAt`). The file format has `version: 1`.
- **Design:** follow `docs/style.md` — near-black surfaces (Carbon `#0f1011` is the note background, also set as the native window background to avoid a white flash), Inter at weights 400–590, hairline borders, and acid-lime `#e4f222` reserved for the pin action only. Use the CSS custom properties in `styles.css` rather than raw colours.
- **CSP** (`tauri.conf.json`) is `default-src 'self'`: no CDNs, remote fonts or inline scripts. Keep all assets local.
- Rust errors returned to JS are `String`s; user-facing error text is in Portuguese.
