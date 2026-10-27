---
name: memo-code-map
description: Find code in the Memo repo without reading whole files. Use before opening app.js, manager.js, i18n.js, store.rs or a Rust module, or when looking for where a command, event, constant or UI string lives.
---

# Memo code map

The big files are `src/app.js` (~3.3k lines), `src-tauri/src/store.rs` (~1.9k), `src/manager.js` (~1.5k), `src-tauri/src/mcp.rs` (~1.3k), `src-tauri/src/sync.rs` (~1k), `src/i18n.js` (~860). Reading one whole costs 10–35k tokens; almost every task needs one section. **Grep first, then read only the lines you need** (`Read` with `offset`/`limit`, or `sed -n 'A,Bp'`).

## Never read

`src/vendor/prism.js` (vendored, 65 KB), `src-tauri/icons/**`, `assets/**`, `Cargo.lock`, `package-lock.json`, `src-tauri/target/**`, `src-tauri/gen/**`, `node_modules/**`, `dist/**`. For a crate version: `grep -A1 '^name = "crate"' src-tauri/Cargo.lock` or `cargo tree -i crate`. `docs/style.md` (22 KB) is a generic Linear-site reference; the app's real tokens are in `base.css` — read style.md only for a new kind of component, and only its "Tokens" / "Do's and Don'ts" sections.

## Rust modules (`src-tauri/src/`)

`main.rs` was split along its sections; each module starts with `use crate::*;` and its items are `pub(crate)`, so a name resolves from anywhere without a path.

| Module | Holds |
| --- | --- |
| `main.rs` | constants (`CARBON`, `SNAP_*`, `MIN_W`, labels…), small shared helpers (`id_of`, `is_note`/`is_group`/`is_board`, `group_label`/`board_label`, `check_color`, `reveal`, `destroy_window`, `window_title`, `notify`, `groups_changed`, `boards_changed`), `migrate_old_data`, `main()` with `setup` and `generate_handler!` |
| `windows.rs` | building / opening note and manager windows, themes, zoom, `track_geometry`, `is_on_screen`, `shows_on_screen` (per OS), the magnet's `SnapTargets` / `snapped`, `tray_labels` |
| `drag.rs` | `drag_start`/`drag_to`/`drag_end`, Snap zones, `resize_start`/`resize_to` |
| `notes.rs` | commands called by note windows (`load_note`, `save_text`, `set_title`, `set_pinned`, `set_color`, `new_note`, `close_note`…), `beside` |
| `color_picker.rs` | `place_color_picker` (Windows: moves the system dialog) |
| `manager.rs` | manager commands: lists, trash, settings, defaults, layout |
| `groups.rs` | group bars and their commands |
| `boards.rs` | board windows and their commands |
| `data.rs` | data folder, backup export / import |
| `tray.rs` | `build_tray_menu`, `on_tray_menu`, `show_title_menu` |
| `store.rs` | constants at the top (`TITLEBAR_H`, `COLORS`, `DEFAULT_COLOR`, `TRASH_TTL_MS`, `ZOOM_*`, `GROUP_NAME_MAX`, …), then `Note`, `FileData`, `Group`, `Board`, `ManagerState`, `Store`, `Config`, then `impl Store` |

## Frontend section maps

Sections are marked by banner comments; list them with the command below (line numbers drift, so don't hardcode them).

```bash
grep -n '^  // -\{5,\}' src/app.js src/manager.js src/group.js src/board.js
```

- **app.js** sections: helpers, render, editor content (`toPlain`, `fromPlain`, `sanitize`, `syncCheckSizes`), save, undo, checklist, code, code highlighting (`renderCode`, `codeLang`, `copyCode`), tables, images, links, formatting, format bar, format tray, format menu, actions, events (ColorMenu, TitleBar wiring), groups (GroupPicker), init.
- **manager.js** sections: helpers, render (note cards, tabs, `fitTabs`), groups tab, default colour, data, default title and text, group defaults (+ `fitSettings`), theme, events, sections (Settings, Help), window (like a note: `renderWindow`, ColorMenu, TitleBar), data folder, backup, cloud, help (`renderHelp`, `keys`, `demoBox`), language, init, zoom.
- **group.js**: render, colour (ColorMenu, bar height), close, window (TitleBar). **board.js**: drag of cards, Setup & Init, Window Chrome (ColorMenu, TitleBar), Group Menu (GroupPicker), Board Data & Render.
- **Shared, small (read whole if needed):** `chrome.js` (`MemoChrome.attach` drag/resize, `MemoChrome.titleMenu`, `MemoColorPicker`, `MemoZoom`), `src/components/*.js` (`TitleBar`, `ColorMenu` + `MemoColor` + `MemoTheme`, `GroupPicker`, `MemoText`, `MemoCard`).
- **i18n.js**: `STRINGS` (`pt`, then `en`), `PLACEHOLDERS`, `HELP` (Help guide data), then the `MemoI18n` helpers (`t`, `apply`, `set`, `keys`, `isMod`).

## Grep recipes

```bash
grep -rn 'fn save_text' src-tauri/src/                 # a command's Rust body (whichever module)
grep -n 'fn relocate' src-tauri/src/store.rs          # a Store method
grep -n 'generate_handler' -A80 src-tauri/src/main.rs  # the registered command list
grep -rn "'save_text'" src/                            # who calls a command
grep -rn "groups-changed" src/ src-tauri/src/         # emitters and listeners of an event
grep -n "^const\|^pub const\|^pub(crate) const" src-tauri/src/*.rs  # all Rust constants
grep -n "^      keyName:" src/i18n.js                   # a UI string in both languages
grep -n "data-i18n=\"keyName\"" src/*.html             # where a string is used in markup
```

For a function body, grep its name, then read from that line to the next blank-line-separated `fn`/function (usually < 60 lines). Prefer `Grep` with `-A`/`-B` context over opening the file.
