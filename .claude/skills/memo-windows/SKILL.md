---
name: memo-windows
description: Memo's window behaviour in main.rs and chrome.js. Use when changing window geometry, dragging, the magnet/Snap, resizing, where new notes appear (beside), close vs trash, startup, first run, the tray or app lifecycle.
---

# Windows, dragging, Snap, lifecycle

Code: `main.rs` sections "Windows" and "Dragging and Snap" (see `memo-code-map`), `src/chrome.js`, `src/snap.html`.

## Geometry

Tracked from `WindowEvent::Moved/Resized` in `track_geometry` (branches on `is_note` to update `ManagerState` for the manager). Position is stored in **physical** pixels, size in **logical** pixels. `TITLEBAR_H` (36 px, = `--titlebar-h` in CSS) is the minimum window height. Saved positions are restored only if the titlebar would be on a connected monitor (`is_on_screen`); Windows' `-32000` minimise coordinates are ignored. No collapse feature (removed twice): a titlebar double-click renames.

All snapping uses the **visible** rect (`inner_position`/`inner_size`), not the outer one: on Windows an undecorated window has an invisible 8 px resize border on left, right and bottom (not top). `drag_to` converts between the two with the inner−outer offset.

## Dragging

Started by the page, not `startDragging` (the OS would own the window until release, so no magnet/Snap). The titlebar captures the pointer and, past a 3 px threshold, calls `drag_start` (records the grab offset from `cursor_position()`, keeps the window always-on-top during the drag), then `drag_to` on moves (calls are chained; queued moves share one call) and `drag_end` on release. `drag_move` places the window at `cursor − grab` and applies `snapped` before `set_position`.

Note, manager and group windows are built with `accept_first_mouse(true)`: on macOS a click on an inactive window otherwise only focuses it, so dragging (or any button) needed a second click. It only affects WKWebView; Windows and Linux already deliver the first click.

**Magnet (`snapped`)** collects candidate positions per axis — work-area edges of the monitor under the window's centre, plus edges of every other note really on screen (shown, not minimised, same monitor, not covered: `shows_on_screen`) in the same row (x) or column (y), either side by side with a uniform `SNAP_GAP` (6 logical px) or aligned — and picks the nearest within `SNAP_DISTANCE` (16 logical px). Work-area edges are inset by `SNAP_GAP` so nothing sits flush against the screen edge (also in `beside`).

`shows_on_screen` per OS: Windows asks `WindowFromPoint` for a 3×3 grid of points (`windows-sys`); macOS reads `NSWindow.occlusionState` (`objc2-app-kit`); Linux/X11 walks the root window's stacking order for the same grid (`x11-dl`, own Xlib connection, errors ignored); native handles via `raw-window-handle`; when a system can't tell, the window counts as shown.

**Snap** (like Aero Snap): with the cursor within `SNAP_EDGE` (4 logical px) of a monitor edge, `snap_zone` picks the left/right half of the work area, a quarter near a corner (top/bottom fifth, or the outer tenth of the top edge) or the whole work area (top edge), inset by `SNAP_GAP`. The hidden `snap-preview` window (`snap.html`; transparent, click-through, not focusable, built at startup by `build_snap_preview`; excluded via `is_app_window`) shows it; `drag_end` applies it and keeps the previous logical size in `Drags.restore`, so the next drag restores it (cursor kept at the same relative x). A manual resize forgets it; restore sizes are not persisted. Group bars don't Snap.

## Resizing

Windows are built with `resizable(false)`. `chrome.js` adds invisible handles on the 4 edges and 4 corners (plus the visible bottom-right grip; group bars get only e/w via `resizeEdges`) and sends the requested visible rect to `resize_to`, which snaps only the moving edges with the same `SnapTargets` and enforces `MIN_W` / `MANAGER_MIN_W` × `TITLEBAR_H` (scaled by zoom).

## New notes: `beside`

A note created with `+` (or from the manager, or the welcome note) is placed by `beside`: next to its parent with the same visible `SNAP_GAP` (inner rects, assuming the new window has the parent's invisible borders), right side first, else left, within the work area; if a visible note already sits there it steps down by `TITLEBAR_H + 8` until free, so repeated `+` cascades.

## Close vs trash

✕ / middle click never trash. On a note, `close_note` sets `Note.hidden` and destroys the window; the note stays among the current ones (dimmed `.is-closed` row in the manager) and `open_note` reopens it. A pristine note (`is_pristine`) or a welcome copy is deleted outright through `trash()`. Only the manager's trash buttons trash: `move_to_trash` → `trash()` sets `trashedAt` and destroys the window (a note with no text and no title is removed outright). `take_out`, `leave_group` and `restore_*` clear `hidden`.

## Startup, first run, lifecycle

- `setup` opens the manager plus `Store::visible()` notes and every active group bar; the same on relaunch (single-instance plugin → `show_all`) and macOS Dock reopen (`RunEvent::Reopen` → `show_all`).
- Started with `--autostart` (`AUTOSTART_ARG`): reopens notes but not the manager (except on first run) and creates no empty note.
- **First run** (`Store::is_first_run()`): creates the welcome note from `welcome.rs`, placed beside the manager (`open_welcome(app, pos)` → `beside`). The Help tab's button (`show_welcome`) reuses `open_welcome`, focusing an untouched open copy instead of duplicating. Only the first-run welcome note goes to the trash when trashed; copies get `Note.welcome_copy = true` and `trash()` deletes them outright. `welcome.rs` HTML must only use tags `sanitize` keeps, and its `TEXT` must equal what `toPlain` produces from that HTML.
- `show_all` / `bring_notes_to_front` go through `raise_notes`: notes first, group bars last so they end on top (`bring_notes_to_front` never creates a note).
- Closing the last window doesn't quit (`prevent_exit` when there's no exit code); the app then lives in the tray. Only "Sair do Memo" (tray, or `quit_app` in the manager) exits.
- Each note window shows in the taskbar (grouped under the app icon); macOS has a Dock icon. On Linux under Wayland, `GDK_BACKEND=x11` is forced (unless set) so always-on-top works.
- **Tray:** static items only (Nova nota, Mostrar todas as notas, separator, Gerenciador do Memo, separator, Sair do Memo; labels from `tray_labels`, rebuilt by `refresh_tray` on language change). Left click opens the manager (`open_manager`; Linux trays send no clicks).
- Window titles: a note mirrors its name (or first line) to the native title for the taskbar; groups use `group_title` ("Memo" when unnamed); the manager uses `manager_title`.
