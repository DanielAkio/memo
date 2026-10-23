---
name: memo-code-map
description: Find code in the Memo repo without reading whole files. Use before opening main.rs, app.js, manager.js, i18n.js or store.rs, or when looking for where a command, event, constant or UI string lives.
---

# Memo code map

The big files are `src-tauri/src/main.rs` (~2.7k lines), `src/app.js` (~1.6k), `src/manager.js` (~1k), `src-tauri/src/store.rs` (~800), `src/i18n.js` (~600). Reading one whole costs 10–25k tokens; almost every task needs one section. **Grep first, then read only the lines you need** (`Read` with `offset`/`limit`, or `sed -n 'A,Bp'`).

## Never read

`src/vendor/prism.js` (vendored, 65 KB), `src-tauri/icons/**`, `assets/**`, `Cargo.lock`, `package-lock.json`, `src-tauri/target/**`, `src-tauri/gen/**`, `node_modules/**`, `dist/**`. For a crate version: `grep -A1 '^name = "crate"' src-tauri/Cargo.lock` or `cargo tree -i crate`. `docs/style.md` (22 KB) is a generic Linear-site reference; the app's real tokens are in `base.css` — read style.md only for a new kind of component, and only its "Tokens" / "Do's and Don'ts" sections.

## Section maps

Sections are marked by banner comments; list them with the commands below (line numbers drift, so don't hardcode them).

```bash
# main.rs: "// ----" banners: Windows, Dragging and Snap, Commands called by notes,
#          Manager commands, Groups, Data folder, Tray / menu bar icon, then migrate_old_data + main()
grep -n -A1 '^// -\{10,\}' src-tauri/src/main.rs | grep -- '-// [A-Z]'
# app.js / manager.js / group.js: "  // ----- name" banners
grep -n '^  // -\{5,\}' src/app.js src/manager.js src/group.js
```

- **app.js** sections: helpers, render, editor content (`toPlain`, `fromPlain`, `sanitize`, `syncCheckSizes`), save, undo, checklist, code, code highlighting (`renderCode`, `codeLang`, `copyCode`), formatting, format bar, actions, title, colour picker, events (keydown/shortcuts), groups (footer picker), init.
- **manager.js** sections: helpers, render (note cards, tabs, `fitTabs`), groups tab, default colour, data, default title and text, group defaults (+ `fitSettings`), theme, events, window (like a note), window colour picker, data folder, backup, help (`renderHelp`, `keys`, `demoBox`), language, init, zoom.
- **group.js**: rename, colour, close, window. **chrome.js** (small, read whole if needed): `MemoChrome.attach` (drag, resize handles), `MemoZoom`.
- **store.rs**: constants at the top (`TITLEBAR_H`, `COLORS`, `DEFAULT_COLOR`, `TRASH_TTL_MS`, `ZOOM_*`, `GROUP_NAME_MAX`, …), then `Note`, `FileData`, `Group`, `ManagerState`, `Store`, `Config`, then `impl Store`.
- **i18n.js**: `STRINGS` (`pt`, then `en`), `PLACEHOLDERS`, `HELP` (Help guide data), then the `MemoI18n` helpers.

## Grep recipes

```bash
grep -n 'fn save_text' src-tauri/src/main.rs           # a command's Rust body (main.rs)
grep -n 'fn relocate' src-tauri/src/store.rs          # a Store method
grep -n 'generate_handler' -A80 src-tauri/src/main.rs  # the registered command list
grep -rn "'save_text'" src/                            # who calls a command
grep -rn "groups-changed" src/ src-tauri/src/         # emitters and listeners of an event
grep -n "^const\|^pub const" src-tauri/src/*.rs        # all Rust constants
grep -n "^      keyName:" src/i18n.js                   # a UI string in both languages
grep -n "data-i18n=\"keyName\"" src/*.html             # where a string is used in markup
```

For a function body, grep its name, then read from that line to the next blank-line-separated `fn`/function (usually < 60 lines). Prefer `Grep` with `-A`/`-B` context over opening the file.
