// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;
mod welcome;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use store::{
    is_valid_color, now_ms, Config, Group, ManagerState, Note, Store, DEFAULT_H, DEFAULT_TEXT_MAX,
    DEFAULT_W, GROUP_NAME_MAX, LANGUAGES, THEMES, TITLEBAR_H, TITLE_MAX,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, State,
    Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

type Shared = Arc<Store>;

/// Note background in the dark (Carbon) and light themes — used as the native
/// window background to avoid a flash while the page loads.
const CARBON: Color = Color(15, 16, 17, 255);
const PAPER: Color = Color(251, 251, 250, 255);
/// How often the trash is checked while the app is running (1 h).
const PURGE_EVERY: Duration = Duration::from_secs(3600);
const SAVE_EVERY: Duration = Duration::from_millis(800);
/// Distance (logical) from a monitor edge or another window at which the note
/// snaps to it while being dragged.
const SNAP_DISTANCE: f64 = 16.0;
/// Gap (logical) between two snapped notes, the same on all four sides; also
/// the gap between a new note and the note that created it.
const SNAP_GAP: f64 = 6.0;
/// Minimum widths (logical) of a note, the manager and a group bar.
const MIN_W: f64 = 180.0;
const MANAGER_MIN_W: f64 = 380.0;
const GROUP_MIN_W: f64 = MIN_W;
/// Group animation: notes slide out of / into their group in this many steps.
const SLIDE_STEPS: u32 = 10;
const SLIDE_STEP: Duration = Duration::from_millis(14);
/// Label of the manager window (notes and trash).
const MANAGER: &str = "manager";
/// Label of the Snap preview: a transparent, click-through window showing
/// where a dragged window will land (see "Snap").
const SNAP_PREVIEW: &str = "snap-preview";
/// How close (logical) the cursor must get to a screen edge to enter a Snap
/// zone while dragging.
const SNAP_EDGE: f64 = 4.0;
/// App config (custom data folder), always in the default data folder.
const CONFIG: &str = "config.json";
/// Name of the default data folder, inside the OS data folder (`%APPDATA%`,
/// `~/Library/Application Support`, `~/.local/share`). Not the app
/// identifier's folder, so the identifier can stay as it is.
const DATA_FOLDER: &str = "memo";
/// Earlier default data folders, newest first: the app identifier's folder
/// and, before that, Taxinha's (the app's former name).
const OLD_DATA_FOLDERS: [&str; 2] = ["br.memo.notas", "br.taxinha.notas"];

fn label_for(id: &str) -> String {
    format!("note-{id}")
}

fn id_of(window: &WebviewWindow) -> String {
    window.label().trim_start_matches("note-").to_string()
}

fn is_note(window: &WebviewWindow) -> bool {
    window.label().starts_with("note-")
}

fn group_label(id: &str) -> String {
    format!("group-{id}")
}

fn group_id_of(window: &WebviewWindow) -> String {
    window.label().trim_start_matches("group-").to_string()
}

fn is_group(window: &WebviewWindow) -> bool {
    window.label().starts_with("group-")
}

/// The app's real windows (notes, groups and manager), i.e. not the Snap
/// preview.
fn is_app_window(window: &WebviewWindow) -> bool {
    window.label() != SNAP_PREVIEW
}

/// Tells the windows (the manager) that the note list changed.
fn notify(app: &AppHandle) {
    let _ = app.emit("notes-changed", ());
}

/// Tells every window that groups (names, members, open state) changed: the
/// notes' footers, the group bars and the manager refresh on it.
fn groups_changed(app: &AppHandle) {
    let _ = app.emit("groups-changed", ());
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Opens a note's window (or brings it to the front if it is already open).
fn open_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(&label_for(&note.id)) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }
    let window = build_note_window(app, note)?;
    window.show()?;
    Ok(window)
}

/// Creates a note's window, hidden, at its saved place.
fn build_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    let label = label_for(&note.id);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Memo")
        .inner_size(
            note.width,
            if note.collapsed {
                TITLEBAR_H
            } else {
                note.height
            },
        )
        .decorations(false)
        // Resized through the page's handles (resize_to), with snapping.
        .resizable(false)
        .always_on_top(note.pinned)
        .background_color(CARBON)
        .visible(false)
        .build()?;

    match (note.x, note.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = window.center();
        }
    }

    apply_background(&window, &app.state::<Shared>().theme());
    track_geometry(app, &window);
    Ok(window)
}

/// Opens the manager window, where notes and the trash are managed. It behaves
/// like a note (frameless, own titlebar, snapping, pin) but has no
/// title or text. It also holds the theme, help and "Quit".
fn open_manager(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(MANAGER) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let store = app.state::<Shared>();
    let state = store.manager();
    let window = WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App("manager.html".into()))
        .title(manager_title(store.effective_language()))
        .inner_size(
            state.width,
            if state.collapsed {
                TITLEBAR_H
            } else {
                state.height
            },
        )
        .decorations(false)
        // Resized through the page's handles (resize_to), with snapping.
        .resizable(false)
        .always_on_top(state.pinned)
        .background_color(CARBON)
        .visible(false)
        .build()?;
    match (state.x, state.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = window.center();
        }
    }
    apply_background(&window, &store.theme());
    track_geometry(app, &window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Manager window title (taskbar) in the UI language.
fn manager_title(lang: &str) -> &'static str {
    if lang == "en" {
        "Memory Manager — Memo"
    } else {
        "Gerenciador de Memórias — Memo"
    }
}

/// Tray menu labels in the UI language.
fn tray_labels(lang: &str) -> [&'static str; 4] {
    if lang == "en" {
        [
            "New memory",
            "Show all memories",
            "Memory Manager",
            "Quit Memo",
        ]
    } else {
        [
            "Nova memória",
            "Mostrar todas as memórias",
            "Gerenciador de Memórias",
            "Sair do Memo",
        ]
    }
}

/// Changes the language of every window (chosen in Settings).
fn set_language(app: &AppHandle, language: &str) {
    let store = app.state::<Shared>();
    store.set_language(language);
    store.flush();
    let lang = store.effective_language();
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let _ = manager.set_title(manager_title(lang));
    }
    let _ = app.emit("language-changed", lang);
    refresh_tray(app);
}

/// Rebuilds the tray menu (the language changed). Menus can only be changed
/// on the main thread (a macOS requirement).
fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("memo"), build_tray_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

/// Native window background for the effective theme ("system" follows the OS).
fn apply_background(window: &WebviewWindow, theme: &str) {
    let light = match theme {
        "light" => true,
        "dark" => false,
        _ => matches!(window.theme(), Ok(Theme::Light)),
    };
    let _ = window.set_background_color(Some(if light { PAPER } else { CARBON }));
}

/// Changes the theme of every window (chosen in the manager).
fn set_theme(app: &AppHandle, theme: &str) {
    let store = app.state::<Shared>();
    store.set_theme(theme);
    store.flush();
    for window in app.webview_windows().values().filter(|w| is_app_window(w)) {
        apply_background(window, theme);
    }
    let _ = app.emit("theme-changed", theme);
}

/// A saved position is only used if the titlebar is still visible on some
/// monitor (avoids "lost" notes after a display is disconnected).
fn is_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors.iter().any(|m| {
            let p = m.position();
            let s = m.size();
            let (px, py) = (x + 48, y + 12);
            px >= p.x && px < p.x + s.width as i32 && py >= p.y && py < p.y + s.height as i32
        }),
        _ => true,
    }
}

/// Which saved object a window's geometry belongs to.
enum Kind {
    Note(String),
    Group(String),
    Manager,
}

/// Saves position and size whenever the user moves or resizes a window
/// (note, group or manager). Moves made by a group animation are skipped,
/// so a note keeps its own place.
fn track_geometry(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let win = window.clone();
    let kind = if is_note(window) {
        Kind::Note(id_of(window))
    } else if is_group(window) {
        Kind::Group(group_id_of(window))
    } else {
        Kind::Manager
    };
    window.on_window_event(move |event| {
        let store = app.state::<Shared>();
        match event {
            WindowEvent::Moved(pos) => {
                // Windows reports -32000 when minimising; ignore it.
                if pos.x <= -30_000 || pos.y <= -30_000 {
                    return;
                }
                if app
                    .state::<Sliding>()
                    .0
                    .lock()
                    .unwrap()
                    .contains(win.label())
                {
                    return;
                }
                let (x, y) = (Some(pos.x), Some(pos.y));
                match &kind {
                    Kind::Note(id) => {
                        store.update(id, |n| (n.x, n.y) = (x, y));
                    }
                    Kind::Group(id) => {
                        store.update_group(id, |g| (g.x, g.y) = (x, y));
                    }
                    Kind::Manager => {
                        store.update_manager(|m| (m.x, m.y) = (x, y));
                    }
                }
            }
            WindowEvent::Resized(size) => {
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let scale = win.scale_factor().unwrap_or(1.0);
                let logical = size.to_logical::<f64>(scale);
                match &kind {
                    Kind::Note(id) => {
                        // While collapsed, the saved height stays the expanded one.
                        store.update(id, |n| {
                            n.width = logical.width;
                            if !n.collapsed && logical.height > TITLEBAR_H + 8.0 {
                                n.height = logical.height;
                            }
                        });
                    }
                    Kind::Group(id) => {
                        store.update_group(id, |g| g.width = logical.width);
                    }
                    Kind::Manager => {
                        // While collapsed, the saved height stays the expanded one.
                        store.update_manager(|m| {
                            m.width = logical.width;
                            if !m.collapsed && logical.height > TITLEBAR_H + 8.0 {
                                m.height = logical.height;
                            }
                        });
                    }
                }
            }
            WindowEvent::ThemeChanged(_) => apply_background(&win, &store.theme()),
            WindowEvent::Destroyed => {
                app.state::<Sliding>().0.lock().unwrap().remove(win.label());
            }
            _ => {}
        }
    });
}

/// Opens the welcome note (first run, or the button in the manager's Help tab).
/// If an untouched copy is already open, just brings it to the front.
///
/// `pos` places the note when it is created (beside the manager). `copy` marks
/// a note reopened from Help: only the first-run one goes to the trash when
/// closed, copies are deleted (Help can always open another).
fn open_welcome(app: &AppHandle, pos: Option<(i32, i32)>, copy: bool) -> tauri::Result<()> {
    let store = app.state::<Shared>();
    let existing = store
        .active()
        .into_iter()
        .find(|n| welcome::is_untouched(&n.title, &n.html));
    let content = welcome::for_lang(store.effective_language());
    let note = match existing {
        Some(note) => note,
        None => {
            let note = store.create(pos);
            store
                .update(&note.id, |n| {
                    n.title = content.title.into();
                    n.text = content.text.into();
                    n.html = content.html.into();
                    n.width = welcome::WIDTH;
                    n.height = welcome::HEIGHT;
                    n.welcome_copy = copy;
                })
                .unwrap_or(note)
        }
    };
    let window = open_note_window(app, &note)?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    notify(app);
    Ok(())
}

/// Snap targets for each edge of a window whose visible area is
/// `l`,`t`,`r`,`b` (left, top, right, bottom, in physical pixels):
/// - the edges of the work area (without the taskbar) of the monitor under the
///   window's centre;
/// - the edges of the other visible windows (notes and manager) in the same
///   row/column: side by side, with `SNAP_GAP` between them, or aligned with
///   them.
///
/// Everything uses the visible area (`inner_*`): on Windows an undecorated
/// window has an invisible border on the sides and bottom, which would leave
/// uneven gaps.
struct SnapTargets {
    left: Vec<i32>,
    right: Vec<i32>,
    top: Vec<i32>,
    bottom: Vec<i32>,
    /// Snap reach, in physical pixels.
    reach: i32,
    scale: f64,
}

impl SnapTargets {
    fn new(window: &WebviewWindow, l: i32, t: i32, r: i32, b: i32) -> Self {
        let (cx, cy) = ((l + r) / 2, (t + b) / 2);
        let monitor = window.available_monitors().ok().and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let a = m.work_area();
                cx >= a.position.x
                    && cx < a.position.x + a.size.width as i32
                    && cy >= a.position.y
                    && cy < a.position.y + a.size.height as i32
            })
        });
        let scale = match &monitor {
            Some(m) => m.scale_factor(),
            None => window.scale_factor().unwrap_or(1.0),
        };
        let reach = (SNAP_DISTANCE * scale).round() as i32;
        let gap = (SNAP_GAP * scale).round() as i32;
        let mut t_ = Self {
            left: Vec::new(),
            right: Vec::new(),
            top: Vec::new(),
            bottom: Vec::new(),
            reach,
            scale,
        };
        // Monitor edges: the same gap (`SNAP_GAP`) left between notes.
        if let Some(m) = &monitor {
            let a = m.work_area();
            t_.left.push(a.position.x + gap);
            t_.right.push(a.position.x + a.size.width as i32 - gap);
            t_.top.push(a.position.y + gap);
            t_.bottom.push(a.position.y + a.size.height as i32 - gap);
        }
        for other in window.app_handle().webview_windows().into_values() {
            if other.label() == window.label()
                || !is_app_window(&other)
                || !other.is_visible().unwrap_or(false)
            {
                continue;
            }
            let (Ok(p), Ok(s)) = (other.inner_position(), other.inner_size()) else {
                continue;
            };
            let (ol, ot) = (p.x, p.y);
            let (or, ob) = (ol + s.width as i32, ot + s.height as i32);
            // Only snap to a window in the same row/column (with the reach as slack).
            if t < ob + reach && b > ot - reach {
                t_.left.extend([or + gap, ol]);
                t_.right.extend([ol - gap, or]);
            }
            if l < or + reach && r > ol - reach {
                t_.top.extend([ob + gap, ot]);
                t_.bottom.extend([ot - gap, ob]);
            }
        }
        t_
    }

    /// The target nearest to `v` within reach, or `v` itself.
    fn pick(&self, v: i32, targets: &[i32]) -> i32 {
        targets
            .iter()
            .copied()
            .filter(|t| (t - v).abs() <= self.reach)
            .min_by_key(|t| (t - v).abs())
            .unwrap_or(v)
    }
}

/// Snapped position for the window being dragged (visible corner `x`,`y`,
/// size `w`×`h`): on each axis, whichever edge is closest to a target pulls
/// the window.
fn snapped(window: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    let t = SnapTargets::new(window, x, y, x + w, y + h);
    let xs: Vec<i32> = t
        .left
        .iter()
        .copied()
        .chain(t.right.iter().map(|r| r - w))
        .collect();
    let ys: Vec<i32> = t
        .top
        .iter()
        .copied()
        .chain(t.bottom.iter().map(|b| b - h))
        .collect();
    (t.pick(x, &xs), t.pick(y, &ys))
}

/// Offset between the visible corner and the window corner (invisible border).
fn frame_offset(window: &WebviewWindow) -> Option<(i32, i32)> {
    let outer = window.outer_position().ok()?;
    let inner = window.inner_position().ok()?;
    Some((inner.x - outer.x, inner.y - outer.y))
}

// ---------------------------------------------------------------------------
// Dragging and Snap
// ---------------------------------------------------------------------------
//
// Dragging is driven by the page (chrome.js) but follows the cursor here:
// `drag_start` records where the titlebar was grabbed, each `drag_to` moves
// the window under the cursor (with the magnet of `snapped`) and `drag_end`
// drops it. The native drag (`startDragging`) can't do any of this, because
// the OS owns the window until the button is released.
//
// Snap, like Windows' Aero Snap: with the cursor against a screen edge, a
// translucent preview (`SNAP_PREVIEW`) shows where the window will land —
// left/right half, a quarter near a corner, the whole work area at the top —
// and releasing there snaps it. Dragging a snapped window again restores its
// previous size.

/// Physical rectangle of a window's visible area.
#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

struct Drag {
    /// Cursor offset from the window's outer corner, physical pixels.
    grab: (f64, f64),
    /// Outer position where the drag started.
    start: (i32, i32),
    /// Snap zone under the cursor at the last move.
    zone: Option<Rect>,
    /// Group bar under the cursor (a note dropped there joins that group).
    drop: Option<String>,
}

#[derive(Default)]
struct Drags {
    /// Drags in progress, by window label.
    active: Mutex<HashMap<String, Drag>>,
    /// Logical size of each snapped window before it was snapped, restored
    /// when it is dragged again (not persisted).
    restore: Mutex<HashMap<String, (f64, f64)>>,
}

/// Whether the note (or the manager) is pinned, to put back after a drag.
fn pinned(window: &WebviewWindow) -> bool {
    let store = window.state::<Shared>();
    if is_group(window) {
        store.group(&group_id_of(window)).is_some_and(|g| g.pinned)
    } else if is_note(window) {
        store.get(&id_of(window)).is_some_and(|n| n.pinned)
    } else {
        store.manager().pinned
    }
}

/// The Snap zone under `cursor`, as the visible rect the window would get:
/// within `SNAP_EDGE` of the left/right edge of a monitor → that half of its
/// work area, or a quarter in the top/bottom fifth (near a corner); of the
/// top edge → the whole work area, or a quarter near a corner. Rects keep the
/// magnet's `SNAP_GAP` from the edges and between halves.
fn snap_zone(window: &WebviewWindow, cursor: PhysicalPosition<f64>) -> Option<Rect> {
    let monitors = window.available_monitors().ok()?;
    let m = monitors.iter().find(|m| {
        let (p, s) = (m.position(), m.size());
        cursor.x >= p.x as f64
            && cursor.x < (p.x + s.width as i32) as f64
            && cursor.y >= p.y as f64
            && cursor.y < (p.y + s.height as i32) as f64
    })?;
    let scale = m.scale_factor();
    let edge = SNAP_EDGE * scale;
    let (p, s) = (m.position(), m.size());
    let (l, t) = (p.x as f64, p.y as f64);
    let (r, b) = (l + s.width as f64, t + s.height as f64);
    let at_left = cursor.x <= l + edge;
    let at_right = cursor.x >= r - 1.0 - edge;
    let at_top = cursor.y <= t + edge;
    // Corner bands: a fifth of the height on the sides, a tenth of the width
    // along the top.
    let near_top = cursor.y < t + (b - t) / 5.0;
    let near_bottom = cursor.y > b - (b - t) / 5.0;
    let near_left = cursor.x < l + (r - l) / 10.0;
    let near_right = cursor.x > r - (r - l) / 10.0;

    let area = m.work_area();
    let gap = (SNAP_GAP * scale).round() as i32;
    let (x0, y0) = (area.position.x + gap, area.position.y + gap);
    let x1 = area.position.x + area.size.width as i32 - gap;
    let y1 = area.position.y + area.size.height as i32 - gap;
    let (mx, my) = ((x0 + x1) / 2, (y0 + y1) / 2);
    let half = gap / 2;
    let left = (x0, mx - half);
    let right = (mx + gap - half, x1);
    let upper = (y0, my - half);
    let lower = (my + gap - half, y1);
    let whole_h = (y0, y1);
    let rect = |(xa, xb): (i32, i32), (ya, yb): (i32, i32)| Rect {
        x: xa,
        y: ya,
        w: xb - xa,
        h: yb - ya,
    };

    let side = if at_left || (at_top && near_left) {
        Some(left)
    } else if at_right || (at_top && near_right) {
        Some(right)
    } else {
        None
    };
    match side {
        Some(cols) if near_top => Some(rect(cols, upper)),
        Some(cols) if near_bottom => Some(rect(cols, lower)),
        Some(cols) => Some(rect(cols, whole_h)),
        None if at_top => Some(rect((x0, x1), whole_h)),
        None => None,
    }
}

/// Creates the (hidden) Snap preview window. Transparent and click-through;
/// it never takes focus, so the drag keeps its pointer capture.
fn build_snap_preview(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, SNAP_PREVIEW, WebviewUrl::App("snap.html".into()))
        .title("Memo")
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    window.set_ignore_cursor_events(true)
}

/// Shows the preview over `rect`, or hides it (`None`).
fn show_snap_preview(app: &AppHandle, rect: Option<Rect>) {
    let Some(preview) = app.get_webview_window(SNAP_PREVIEW) else {
        return;
    };
    match rect {
        Some(r) => {
            let (dx, dy) = frame_offset(&preview).unwrap_or((0, 0));
            let _ = preview.set_position(PhysicalPosition::new(r.x - dx, r.y - dy));
            let _ = preview.set_size(PhysicalSize::new(r.w as u32, r.h as u32));
            if !preview.is_visible().unwrap_or(false) {
                let _ = preview.show();
            }
        }
        None => {
            if preview.is_visible().unwrap_or(false) {
                let _ = preview.hide();
            }
        }
    }
}

/// Start of a titlebar drag (the pointer moved past the click threshold).
/// While dragging, the window is kept above other windows — including the
/// Snap preview, which is not always on top — and its pin is put back by
/// `drag_end`.
#[tauri::command]
fn drag_start(window: WebviewWindow, drags: State<'_, Drags>) {
    let (Ok(cursor), Ok(outer)) = (window.cursor_position(), window.outer_position()) else {
        return;
    };
    let grab = (cursor.x - outer.x as f64, cursor.y - outer.y as f64);
    let _ = window.set_always_on_top(true);
    drags.active.lock().unwrap().insert(
        window.label().into(),
        Drag {
            grab,
            start: (outer.x, outer.y),
            zone: None,
            drop: None,
        },
    );
}

/// Moves the window under the cursor, with the magnet, and updates the Snap
/// preview.
#[tauri::command]
fn drag_to(window: WebviewWindow, drags: State<'_, Drags>) {
    drag_move(&window, &drags);
}

fn drag_move(window: &WebviewWindow, drags: &Drags) {
    let Ok(cursor) = window.cursor_position() else {
        return;
    };
    let mut active = drags.active.lock().unwrap();
    let Some(drag) = active.get_mut(window.label()) else {
        return;
    };

    // A window snapped by an earlier drag gets its previous size back, with
    // the cursor at the same relative spot of the titlebar.
    let restore = drags.restore.lock().unwrap().remove(window.label());
    if let (Some((w, h)), Ok(before)) = (restore, window.outer_size()) {
        let _ = window.set_size(LogicalSize::new(w, h));
        if let Ok(after) = window.outer_size() {
            drag.grab.0 *= after.width as f64 / before.width.max(1) as f64;
        }
    }
    // Moving to a monitor with another scale resizes the window: keep the
    // grab point inside it.
    if let Ok(outer) = window.outer_size() {
        drag.grab.0 = drag.grab.0.min(outer.width as f64 - 1.0);
    }

    let (Some((dx, dy)), Ok(size)) = (frame_offset(window), window.inner_size()) else {
        return;
    };
    let x = (cursor.x - drag.grab.0).round() as i32;
    let y = (cursor.y - drag.grab.1).round() as i32;
    // `x`,`y` are the window corner; the magnet works on the visible area.
    let (vx, vy) = snapped(
        window,
        x + dx,
        y + dy,
        size.width as i32,
        size.height as i32,
    );
    let _ = window.set_position(PhysicalPosition::new(vx - dx, vy - dy));

    // A note over a group bar can be dropped into it (the bar lights up);
    // group bars themselves don't Snap.
    let app = window.app_handle();
    if is_note(window) {
        let target = group_under(window, cursor);
        if target != drag.drop {
            if let Some(old) = &drag.drop {
                let _ = app.emit("drop-hover", (old, false));
            }
            if let Some(new) = &target {
                let _ = app.emit("drop-hover", (new, true));
            }
            drag.drop = target;
        }
    }
    // Group bars and collapsed windows don't Snap (a half-screen titlebar).
    let store = window.state::<Shared>();
    let collapsed = if is_note(window) {
        store.get(&id_of(window)).is_some_and(|n| n.collapsed)
    } else {
        !is_group(window) && store.manager().collapsed
    };
    drag.zone = if is_group(window) || collapsed || drag.drop.is_some() {
        None
    } else {
        snap_zone(window, cursor)
    };
    show_snap_preview(app, drag.zone);
}

/// The group bar under `cursor` (not the note's own group), by id.
fn group_under(note: &WebviewWindow, cursor: PhysicalPosition<f64>) -> Option<String> {
    let own = note
        .state::<Shared>()
        .get(&id_of(note))
        .map(|n| n.group_id)
        .unwrap_or_default();
    note.app_handle()
        .webview_windows()
        .into_values()
        .filter(|w| is_group(w) && w.is_visible().unwrap_or(false))
        .find(|w| {
            let (Ok(p), Ok(s)) = (w.inner_position(), w.inner_size()) else {
                return false;
            };
            cursor.x >= p.x as f64
                && cursor.x < (p.x + s.width as i32) as f64
                && cursor.y >= p.y as f64
                && cursor.y < (p.y + s.height as i32) as f64
        })
        .map(|w| group_id_of(&w))
        .filter(|id| *id != own)
}

/// End of the drag: final move, then, if released in a Snap zone, the window
/// takes the zone's rect (its size is kept to restore on the next drag).
#[tauri::command]
fn drag_end(window: WebviewWindow, drags: State<'_, Drags>) {
    drag_move(&window, &drags);
    let drag = drags.active.lock().unwrap().remove(window.label());
    show_snap_preview(window.app_handle(), None);
    let _ = window.set_always_on_top(pinned(&window));
    let Some(drag) = drag else {
        return;
    };
    // Dropped on a group bar: the note joins it, going back to where the drag
    // started (open group) or into the bar (closed group).
    if let Some(group) = drag.drop {
        let app = window.app_handle();
        let _ = app.emit("drop-hover", (&group, false));
        join_group(app, &id_of(&window), &group, Some(drag.start));
        return;
    }
    let Some(zone) = drag.zone else {
        return;
    };
    let (Some((dx, dy)), Ok(size), Ok(scale)) = (
        frame_offset(&window),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let logical = size.to_logical::<f64>(scale);
    drags
        .restore
        .lock()
        .unwrap()
        .insert(window.label().into(), (logical.width, logical.height));
    let _ = window.set_position(PhysicalPosition::new(zone.x - dx, zone.y - dy));
    let _ = window.set_size(PhysicalSize::new(zone.w as u32, zone.h as u32));
}

/// Resize driven by the page (handles on the edges and corners): the moving
/// edges (`edges`: "n", "s", "e", "w" or combinations) of the requested
/// visible area (physical `x`,`y`,`w`,`h`) are pulled by the same snapping as
/// dragging. Native resizing is off (`resizable(false)`): the OS wouldn't let
/// us adjust the size mid-gesture.
#[tauri::command]
fn resize_to(
    window: WebviewWindow,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    edges: String,
    drags: State<'_, Drags>,
) {
    // Resized by hand: no longer "snapped", so a later drag keeps this size.
    drags.restore.lock().unwrap().remove(window.label());
    let Some((dx, dy)) = frame_offset(&window) else {
        return;
    };
    let (mut l, mut t, mut r, mut b) = (x, y, x + w, y + h);
    let targets = SnapTargets::new(&window, l, t, r, b);
    if edges.contains('w') {
        l = targets.pick(l, &targets.left);
    }
    if edges.contains('e') {
        r = targets.pick(r, &targets.right);
    }
    if edges.contains('n') {
        t = targets.pick(t, &targets.top);
    }
    if edges.contains('s') {
        b = targets.pick(b, &targets.bottom);
    }

    // Minimum size (the same as when the window was resizable).
    let min_w = if is_note(&window) {
        MIN_W
    } else if is_group(&window) {
        GROUP_MIN_W
    } else {
        MANAGER_MIN_W
    };
    let min_w = (min_w * targets.scale).round() as i32;
    let min_h = (TITLEBAR_H * targets.scale).round() as i32;
    if r - l < min_w {
        if edges.contains('w') {
            l = r - min_w;
        } else {
            r = l + min_w;
        }
    }
    if b - t < min_h {
        if edges.contains('n') {
            t = b - min_h;
        } else {
            b = t + min_h;
        }
    }

    if edges.contains('w') || edges.contains('n') {
        let _ = window.set_position(PhysicalPosition::new(l - dx, t - dy));
    }
    let _ = window.set_size(PhysicalSize::new((r - l) as u32, (b - t) as u32));
}

fn create_and_open(app: &AppHandle, pos: Option<(i32, i32)>) -> tauri::Result<()> {
    let note = app.state::<Shared>().create(pos);
    let window = open_note_window(app, &note)?;
    let _ = window.set_focus();
    notify(app);
    Ok(())
}

/// Tray "Show all memories", relaunch and Dock reopen: brings every note to
/// the front, or opens a new one when none is open.
fn show_all(app: &AppHandle) {
    if !raise_notes(app) {
        let _ = create_and_open(app, None);
    }
}

/// Brings every open note window and group bar to the front (restoring
/// minimised ones). Returns `false` if there is none.
fn raise_notes(app: &AppHandle) -> bool {
    let windows: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| is_note(w) || is_group(w))
        .collect();
    for window in &windows {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    !windows.is_empty()
}

/// Moves a note to the trash (closing its window, if open). A note nobody
/// touched (empty, or only the default title and text) and a welcome note
/// reopened from Help are deleted outright so they don't clutter the trash.
fn trash(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    match store.get(id) {
        Some(note) if note.welcome_copy || store.is_pristine(&note) => store.remove(id),
        Some(_) => {
            store.update(id, |n| n.trashed_at = Some(now_ms()));
        }
        None => {}
    }
    store.flush();
    if let Some(window) = app.get_webview_window(&label_for(id)) {
        let _ = window.destroy();
    }
    notify(app);
}

// ---------------------------------------------------------------------------
// Commands called by notes
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_theme(store: State<'_, Shared>) -> String {
    store.theme()
}

#[tauri::command]
fn load_note(window: WebviewWindow, store: State<'_, Shared>) -> Option<Note> {
    store.get(&id_of(&window))
}

/// Names the note; returns the name as saved.
#[tauri::command]
fn set_title(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    store: State<'_, Shared>,
) -> String {
    let title: String = title.trim().chars().take(TITLE_MAX).collect();
    store.update(&id_of(&window), |n| n.title = title.clone());
    notify(&app);
    title
}

#[tauri::command]
fn save_text(
    app: AppHandle,
    window: WebviewWindow,
    text: String,
    html: String,
    store: State<'_, Shared>,
) {
    let mut changed = false;
    store.update(&id_of(&window), |n| {
        if n.text != text || n.html != html {
            n.text = text;
            n.html = html;
            n.updated_at = now_ms();
            changed = true;
        }
    });
    if changed {
        notify(&app);
    }
}

/// The headline feature: keeps (or stops keeping) the note above every other app.
#[tauri::command]
fn set_pinned(
    window: WebviewWindow,
    pinned: bool,
    store: State<'_, Shared>,
) -> Result<bool, String> {
    window
        .set_always_on_top(pinned)
        .map_err(|e| e.to_string())?;
    if is_note(&window) {
        store.update(&id_of(&window), |n| n.pinned = pinned);
    } else if is_group(&window) {
        store.update_group(&group_id_of(&window), |g| g.pinned = pinned);
    } else {
        store.update_manager(|m| m.pinned = pinned);
    }
    Ok(pinned)
}

#[tauri::command]
fn set_color(
    app: AppHandle,
    window: WebviewWindow,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("unknown color: {color}"));
    }
    store.update(&id_of(&window), |n| n.color = color);
    notify(&app);
    Ok(())
}

/// Double-click on a note's (or the manager's) titlebar: collapses it to the
/// titlebar or expands it back to its saved height.
#[tauri::command]
fn set_collapsed(
    window: WebviewWindow,
    collapsed: bool,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let (width, expanded) = if is_note(&window) {
        let note = store
            .update(&id_of(&window), |n| n.collapsed = collapsed)
            .ok_or("note not found")?;
        (note.width, note.height)
    } else {
        let state = store.update_manager(|m| m.collapsed = collapsed);
        (state.width, state.height)
    };
    let height = if collapsed { TITLEBAR_H } else { expanded };
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

// Creating and destroying windows from sync commands can deadlock on
// Windows, so the commands that do so are async.
#[tauri::command]
async fn new_note(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    create_and_open(&app, beside(&window)).map_err(|e| e.to_string())
}

/// Position (physical) for a new note beside the `parent` note, without
/// overlapping: on the right if it fits in the monitor work area, else on the
/// left. Overlapping would hide the new note behind a pinned one. With no room
/// on either side, it sits against the edge of the roomier side. If the spot
/// is already taken by another note (several "+" in a row), it steps down.
///
/// As with drag snapping, the maths uses the visible area (`inner_*`), so the
/// gap between notes is a real `SNAP_GAP`, without Windows' invisible border.
/// The new note has the same borders as its parent.
fn beside(parent: &WebviewWindow) -> Option<(i32, i32)> {
    let outer = parent.outer_position().ok()?;
    let pos = parent.inner_position().ok()?;
    let size = parent.inner_size().ok()?;
    let (dx, dy) = (pos.x - outer.x, pos.y - outer.y);
    let monitor = parent.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let gap = (SNAP_GAP * scale).round() as i32;
    // Work area inset by the snap gap: the new note doesn't touch the edge.
    let (left_edge, top_edge) = (area.position.x + gap, area.position.y + gap);
    let right_edge = area.position.x + area.size.width as i32 - gap;
    let bottom_edge = area.position.y + area.size.height as i32 - gap;

    let w = (DEFAULT_W * scale).round() as i32;
    let h = (DEFAULT_H * scale).round() as i32;
    let parent_right = pos.x + size.width as i32;

    // Visible corner of the new note.
    let vx = if parent_right + gap + w <= right_edge {
        parent_right + gap
    } else if pos.x - gap - w >= left_edge {
        pos.x - gap - w
    } else if right_edge - parent_right >= pos.x - left_edge {
        right_edge - w
    } else {
        left_edge
    };
    let vx = vx.max(left_edge);
    let vy = pos.y.clamp(top_edge, (bottom_edge - h).max(top_edge));

    // Window corner (with the invisible borders), which is what gets positioned.
    let x = vx - dx;
    let max_y = (bottom_edge - h).max(top_edge) - dy;
    let mut y = vy - dy;

    // Several "+" in a row on the same note would all land on the same spot:
    // if a note is already there, step down (titlebar + slack) until a free
    // spot is found, so they all stay visible.
    let step = ((TITLEBAR_H + 8.0) * scale).round() as i32;
    let taken: Vec<PhysicalPosition<i32>> = parent
        .app_handle()
        .webview_windows()
        .values()
        .filter(|w| is_app_window(w) && w.is_visible().unwrap_or(false))
        .filter_map(|w| w.outer_position().ok())
        .collect();
    let occupied = |y: i32| {
        taken
            .iter()
            .any(|p| (p.x - x).abs() < step / 2 && (p.y - y).abs() < step / 2)
    };
    while occupied(y) && y + step <= max_y {
        y += step;
    }
    Some((x, y))
}

/// Closes the note (✕ button or middle click) by moving it to the trash.
#[tauri::command]
async fn trash_note(app: AppHandle, window: WebviewWindow) {
    trash(&app, &id_of(&window));
}

// ---------------------------------------------------------------------------
// Manager commands
// ---------------------------------------------------------------------------

/// Manager window state (pinned) on open.
#[tauri::command]
fn load_manager(store: State<'_, Shared>) -> ManagerState {
    store.manager()
}

/// Manager's "bring all memories to front" button. Unlike the tray's "Show
/// all memories", it doesn't create a note when none is open.
#[tauri::command]
async fn bring_notes_to_front(app: AppHandle) {
    raise_notes(&app);
}

/// Closes the manager window (✕ or middle click on the titlebar).
#[tauri::command]
async fn close_manager(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// All notes, active and trashed, without the HTML (the manager only shows
/// title, text preview, colour and dates).
#[tauri::command]
fn list_notes(store: State<'_, Shared>) -> Vec<Note> {
    store
        .all()
        .into_iter()
        .map(|mut n| {
            n.html = String::new();
            n
        })
        .collect()
}

/// Opens an active note (or brings it to the front if already open).
#[tauri::command]
async fn open_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .get(&id)
        .filter(|n| n.trashed_at.is_none())
        .ok_or("note not found")?;
    // Inside a closed group: take the whole group out.
    match app.state::<Shared>().group(&note.group_id) {
        Some(group) if !group.open => take_out(&app, &group.id),
        _ => {
            open_note_window(&app, &note).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn move_to_trash(app: AppHandle, id: String) {
    trash(&app, &id);
}

/// Takes the note out of the trash and opens its window (unless it goes back
/// into a closed group).
#[tauri::command]
async fn restore_note(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Shared>();
    let note = store
        .update(&id, |n| n.trashed_at = None)
        .ok_or("note not found")?;
    if store.group(&note.group_id).map_or(true, |g| g.open) {
        open_note_window(&app, &note).map_err(|e| e.to_string())?;
    }
    notify(&app);
    groups_changed(&app);
    Ok(())
}

/// Permanently deletes a note from the trash.
#[tauri::command]
fn delete_forever(app: AppHandle, id: String, store: State<'_, Shared>) {
    if store.get(&id).is_some_and(|n| n.trashed_at.is_some()) {
        store.remove(&id);
        store.flush();
        notify(&app);
    }
}

#[tauri::command]
fn empty_trash(app: AppHandle, store: State<'_, Shared>) {
    store.empty_trash();
    store.flush();
    notify(&app);
}

/// Chosen language and the effective one ("pt" or "en"), for the pages.
#[tauri::command]
fn get_language(store: State<'_, Shared>) -> (String, &'static str) {
    (store.language(), store.effective_language())
}

/// Changes the UI language (chosen in the manager).
#[tauri::command]
fn change_language(app: AppHandle, language: String) -> Result<(), String> {
    if !LANGUAGES.contains(&language.as_str()) {
        return Err(format!("unknown language: {language}"));
    }
    set_language(&app, &language);
    Ok(())
}

#[tauri::command]
fn change_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !THEMES.contains(&theme.as_str()) {
        return Err(format!("unknown theme: {theme}"));
    }
    set_theme(&app, &theme);
    Ok(())
}

/// Reopens the welcome note (button in the manager's Help tab).
#[tauri::command]
async fn show_welcome(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    open_welcome(&app, beside(&window), true).map_err(|e| e.to_string())
}

/// Quits the app (the only way out: closing the notes doesn't quit).
#[tauri::command]
fn quit_app(app: AppHandle, store: State<'_, Shared>) {
    store.flush();
    app.exit(0);
}

#[tauri::command]
fn get_default_color(store: State<'_, Shared>) -> String {
    store.default_color()
}

/// Default title, text and HTML for new notes, for the manager.
#[tauri::command]
fn get_new_note_defaults(store: State<'_, Shared>) -> (String, String, String) {
    store.new_note_defaults()
}

#[tauri::command]
fn set_default_title(title: String, store: State<'_, Shared>) {
    store.set_default_title(title.trim().chars().take(TITLE_MAX).collect());
}

/// Colour and name new groups start with, for the manager's Settings.
#[tauri::command]
fn get_group_defaults(store: State<'_, Shared>) -> (String, String) {
    store.group_defaults()
}

#[tauri::command]
fn set_default_group_color(color: String, store: State<'_, Shared>) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("unknown color: {color}"));
    }
    store.set_default_group_color(&color);
    Ok(())
}

#[tauri::command]
fn set_default_group_title(title: String, store: State<'_, Shared>) {
    store.set_default_group_title(title.trim().chars().take(GROUP_NAME_MAX).collect());
}

/// Default content for new notes, edited in the manager with the same note
/// editor (index.html?defaults): plain text and HTML, as a note stores them.
#[tauri::command]
fn set_default_content(text: String, html: String, store: State<'_, Shared>) {
    let text = text.chars().take(DEFAULT_TEXT_MAX).collect();
    let html = html.chars().take(DEFAULT_TEXT_MAX * 10).collect();
    store.set_default_content(text, html);
}

#[tauri::command]
fn set_default_color(
    app: AppHandle,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("unknown color: {color}"));
    }
    store.set_default_color(&color);
    notify(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
//
// A group is a compact bar (`group.html`, label `group-{id}`). Double-click
// takes its notes out — each window slides from the bar to the note's saved
// place — or puts them back in: they slide into the bar and their windows
// close. Notes join a group by being dropped on its bar, from the picker in
// their footer or from the manager's list. Deleting a group sends its notes
// to the trash.

/// Windows being moved by a group animation: their `Moved` events are not
/// saved, so a note keeps its own place. A label is removed when its window
/// is destroyed, or shortly after a slide-out ends.
#[derive(Default)]
struct Sliding(Mutex<HashSet<String>>);

/// Slides `window` (outer position) from `from` to `to` on a worker thread,
/// easing out, then runs `done` there.
fn slide(
    window: WebviewWindow,
    from: (i32, i32),
    to: (i32, i32),
    done: impl FnOnce(&WebviewWindow) + Send + 'static,
) {
    thread::spawn(move || {
        for i in 1..=SLIDE_STEPS {
            let t = i as f64 / SLIDE_STEPS as f64;
            let e = 1.0 - (1.0 - t).powi(3);
            let x = from.0 + ((to.0 - from.0) as f64 * e).round() as i32;
            let y = from.1 + ((to.1 - from.1) as f64 * e).round() as i32;
            let _ = window.set_position(PhysicalPosition::new(x, y));
            thread::sleep(SLIDE_STEP);
        }
        done(&window);
    });
}

/// Native window title of a group bar (taskbar): its name, or the app's.
fn group_title(name: &str) -> &str {
    if name.is_empty() {
        "Memo"
    } else {
        name
    }
}

/// Opens a group's bar (or brings it to the front if already open).
fn open_group_window(app: &AppHandle, group: &Group) -> tauri::Result<WebviewWindow> {
    let label = group_label(&group.id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        return Ok(existing);
    }
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("group.html".into()))
        .title(group_title(&group.name))
        .inner_size(group.width, TITLEBAR_H)
        .decorations(false)
        .resizable(false)
        .always_on_top(group.pinned)
        .background_color(CARBON)
        .visible(false)
        .build()?;
    match (group.x, group.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = window.center();
        }
    }
    apply_background(&window, &app.state::<Shared>().theme());
    track_geometry(app, &window);
    window.show()?;
    Ok(window)
}

/// Where notes come out of / go into: the group bar's outer corner.
fn group_anchor(app: &AppHandle, id: &str) -> Option<(i32, i32)> {
    if let Some(p) = app
        .get_webview_window(&group_label(id))
        .and_then(|w| w.outer_position().ok())
    {
        return Some((p.x, p.y));
    }
    let group = app.state::<Shared>().group(id)?;
    Some((group.x?, group.y?))
}

/// Takes the group's notes out: each window appears at the bar and slides to
/// the note's saved place.
fn take_out(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    store.update_group(id, |g| g.open = true);
    let anchor = group_anchor(app, id);
    for note in store.members(id) {
        let label = label_for(&note.id);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        app.state::<Sliding>()
            .0
            .lock()
            .unwrap()
            .insert(label.clone());
        let Ok(window) = build_note_window(app, &note) else {
            app.state::<Sliding>().0.lock().unwrap().remove(&label);
            continue;
        };
        let target = window.outer_position().map(|p| (p.x, p.y));
        match (anchor, target) {
            (Some(from), Ok(to)) => {
                let _ = window.set_position(PhysicalPosition::new(from.0, from.1));
                let _ = window.show();
                let app = app.clone();
                slide(window, from, to, move |w| {
                    // Late `Moved` events of the slide are still ignored.
                    thread::sleep(Duration::from_millis(150));
                    app.state::<Sliding>().0.lock().unwrap().remove(w.label());
                });
            }
            _ => {
                let _ = window.show();
                app.state::<Sliding>().0.lock().unwrap().remove(&label);
            }
        }
    }
    store.flush();
    groups_changed(app);
    notify(app);
}

/// Puts the group's notes in: each window slides into the bar and closes.
fn put_in(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    store.update_group(id, |g| g.open = false);
    store.flush();
    let anchor = group_anchor(app, id);
    for note in store.members(id) {
        if let Some(window) = app.get_webview_window(&label_for(&note.id)) {
            slide_in(app, window, anchor);
        }
    }
    groups_changed(app);
    notify(app);
}

/// Slides a note window into its group bar at `anchor` and closes it (its
/// saved place is kept: the slide's moves are not recorded).
fn slide_in(app: &AppHandle, window: WebviewWindow, anchor: Option<(i32, i32)>) {
    app.state::<Sliding>()
        .0
        .lock()
        .unwrap()
        .insert(window.label().into());
    match (anchor, window.outer_position()) {
        (Some(to), Ok(from)) => slide(window, (from.x, from.y), to, |w| {
            let _ = w.destroy();
        }),
        _ => {
            let _ = window.destroy();
        }
    }
}

/// Puts a note in a group. With the group open the note stays out (sliding
/// back to `back_to`, where a drag onto the bar started); with it closed the
/// note slides into the bar.
fn join_group(app: &AppHandle, note_id: &str, group_id: &str, back_to: Option<(i32, i32)>) {
    let store = app.state::<Shared>();
    let Some(group) = store.group(group_id) else {
        return;
    };
    store.update(note_id, |n| n.group_id = group_id.to_string());
    store.flush();
    if let Some(window) = app.get_webview_window(&label_for(note_id)) {
        if !group.open {
            slide_in(app, window, group_anchor(app, group_id));
        } else if let (Some(to), Ok(from)) = (back_to, window.outer_position()) {
            slide(window, (from.x, from.y), to, |_| {});
        }
    }
    groups_changed(app);
    notify(app);
}

/// Takes a note out of its group; a note that was inside a closed group
/// comes out on screen.
fn leave_group(app: &AppHandle, note_id: &str) {
    let store = app.state::<Shared>();
    let Some(note) = store.update(note_id, |n| n.group_id.clear()) else {
        return;
    };
    store.flush();
    if note.trashed_at.is_none() && app.get_webview_window(&label_for(note_id)).is_none() {
        let _ = open_note_window(app, &note);
    }
    groups_changed(app);
    notify(app);
}

/// Moves a note to `group_id`: "" = no group, "new" = a new group whose bar
/// opens beside `anchor` (the note's window, or the manager).
fn assign_group(app: &AppHandle, note_id: &str, group_id: &str, anchor: &WebviewWindow) {
    match group_id {
        "" => leave_group(app, note_id),
        "new" => {
            let group = app.state::<Shared>().create_group(beside(anchor));
            let _ = open_group_window(app, &group);
            join_group(app, note_id, &group.id, None);
        }
        id => join_group(app, note_id, id, None),
    }
}

/// All groups, for the notes' footer picker and the manager.
#[tauri::command]
fn list_groups(store: State<'_, Shared>) -> Vec<Group> {
    store.groups()
}

/// The calling note's group id ("" = none).
#[tauri::command]
fn get_note_group(window: WebviewWindow, store: State<'_, Shared>) -> String {
    store
        .get(&id_of(&window))
        .map(|n| n.group_id)
        .unwrap_or_default()
}

/// Footer picker of a note: moves it to `group_id` ("" = none, "new").
#[tauri::command]
async fn set_note_group(app: AppHandle, window: WebviewWindow, group_id: String) {
    assign_group(&app, &id_of(&window), &group_id, &window);
}

/// Manager list: moves note `id` to `group_id` ("" = none, "new").
#[tauri::command]
async fn move_note_to_group(app: AppHandle, window: WebviewWindow, id: String, group_id: String) {
    assign_group(&app, &id, &group_id, &window);
}

/// The calling group bar's data and how many notes it holds.
#[tauri::command]
fn load_group(window: WebviewWindow, store: State<'_, Shared>) -> Option<(Group, usize)> {
    let id = group_id_of(&window);
    let group = store.group(&id)?;
    Some((group, store.members(&id).len()))
}

/// Renames the calling group (empty = unnamed, as for notes). Returns the
/// name as saved.
#[tauri::command]
fn rename_group(app: AppHandle, window: WebviewWindow, name: String) -> String {
    let store = app.state::<Shared>();
    let id = group_id_of(&window);
    let name: String = name.trim().chars().take(GROUP_NAME_MAX).collect();
    let group = store.update_group(&id, |g| g.name = name.clone());
    let saved = group.map(|g| g.name).unwrap_or_default();
    let _ = window.set_title(group_title(&saved));
    groups_changed(&app);
    notify(&app);
    saved
}

/// Colour of the calling group (same labels as notes).
#[tauri::command]
fn set_group_color(app: AppHandle, window: WebviewWindow, color: String) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("unknown color: {color}"));
    }
    app.state::<Shared>()
        .update_group(&group_id_of(&window), |g| g.color = color);
    groups_changed(&app);
    Ok(())
}

/// The bar is only a titlebar tall: while its colour picker is open the
/// window grows to `height` (logical), then shrinks back. Not saved — a
/// group's height is always `TITLEBAR_H`.
#[tauri::command]
fn set_group_height(window: WebviewWindow, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let width = size.to_logical::<f64>(scale).width;
    window
        .set_size(LogicalSize::new(width, height.max(TITLEBAR_H)))
        .map_err(|e| e.to_string())
}

/// Double-click on the bar: takes the notes out, or puts them back in.
#[tauri::command]
async fn toggle_group(app: AppHandle, window: WebviewWindow) {
    let id = group_id_of(&window);
    match app.state::<Shared>().group(&id) {
        Some(group) if group.open => put_in(&app, &id),
        Some(_) => take_out(&app, &id),
        None => {}
    }
}

/// Manager's "new group" button: an empty, unnamed group bar beside the
/// manager.
#[tauri::command]
async fn new_group(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let group = app.state::<Shared>().create_group(beside(&window));
    open_group_window(&app, &group).map_err(|e| e.to_string())?;
    groups_changed(&app);
    Ok(())
}

/// "+" on a group bar (or Mod+N there): a new note already in the group,
/// opened beside the bar. A closed group is taken out first, so the new note
/// doesn't come out alone.
#[tauri::command]
async fn new_note_in_group(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let id = group_id_of(&window);
    let store = app.state::<Shared>();
    let group = store.group(&id).ok_or("group not found")?;
    if !group.open {
        take_out(&app, &id);
    }
    let note = store.create(beside(&window));
    let note = store
        .update(&note.id, |n| n.group_id = id.clone())
        .unwrap_or(note);
    let note_window = open_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = note_window.set_focus();
    groups_changed(&app);
    notify(&app);
    Ok(())
}

/// Deletes the calling group; its notes go to the trash.
#[tauri::command]
async fn delete_group(app: AppHandle, window: WebviewWindow) {
    let id = group_id_of(&window);
    let store = app.state::<Shared>();
    for note in store.members(&id) {
        trash(&app, &note.id);
    }
    store.remove_group(&id);
    store.flush();
    let _ = window.destroy();
    groups_changed(&app);
    notify(&app);
}

// ---------------------------------------------------------------------------
// Data folder
// ---------------------------------------------------------------------------

/// Default data folder: `<OS data folder>/memo`.
fn default_data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().data_dir()?.join(DATA_FOLDER))
}

/// Folder holding `notes.json`: the one set in `config.json`, or the default
/// data folder. A custom folder that can't be created (e.g. on an
/// unplugged drive) falls back to the default for this session.
fn data_dir(default: &Path) -> PathBuf {
    match Config::load(&default.join(CONFIG)).data_dir {
        Some(dir) => match std::fs::create_dir_all(&dir) {
            Ok(()) => dir,
            Err(err) => {
                eprintln!("memo: data folder {dir:?} unavailable ({err}); using {default:?}");
                default.to_path_buf()
            }
        },
        None => default.to_path_buf(),
    }
}

/// Texts of the data folder dialogs in the UI language.
struct StorageText {
    pick_title: &'static str,
    existing: &'static str,
    open_existing: &'static str,
    replace_existing: &'static str,
    cancel: &'static str,
    failed: &'static str,
    export_title: &'static str,
    export_failed: &'static str,
    import_title: &'static str,
    import_failed: &'static str,
}

fn storage_text(lang: &str) -> StorageText {
    if lang == "en" {
        StorageText {
            pick_title: "Choose the memories folder",
            existing: "This folder already has Memo memories.\n\nOpen them in place of the current ones (which stay saved in the previous folder), or replace them with the current memories (the file there is kept as a backup)?",
            open_existing: "Open those",
            replace_existing: "Replace with current",
            cancel: "Cancel",
            failed: "Couldn't use this folder.",
            export_title: "Export memories",
            export_failed: "Couldn't export the memories.",
            import_title: "Import memories",
            import_failed: "Couldn't import this file. It must be a Memo export or notes.json.",
        }
    } else {
        StorageText {
            pick_title: "Escolha a pasta das memórias",
            existing: "Esta pasta já tem memórias do Memo.\n\nAbrir essas memórias no lugar das atuais (que continuam salvas na pasta anterior) ou substituí-las pelas memórias atuais (o arquivo de lá fica como backup)?",
            open_existing: "Abrir as de lá",
            replace_existing: "Substituir pelas atuais",
            cancel: "Cancelar",
            failed: "Não foi possível usar esta pasta.",
            export_title: "Exportar memórias",
            export_failed: "Não foi possível exportar as memórias.",
            import_title: "Importar memórias",
            import_failed: "Não foi possível importar este arquivo. Ele precisa ser uma exportação do Memo ou um notes.json.",
        }
    }
}

/// Moves the notes to `dir`. If it already has a `notes.json`, asks whether to
/// switch to those notes (reopening the windows with them) or to replace them
/// with the current ones; otherwise the current notes are copied there. The
/// old file stays as a backup. Returns `false` if nothing changed (same folder
/// or cancelled).
fn move_data_dir(app: &AppHandle, window: &WebviewWindow, dir: PathBuf) -> Result<bool, String> {
    let store = app.state::<Shared>();
    let default = default_data_dir(app).map_err(|e| e.to_string())?;
    let text = storage_text(store.effective_language());
    let target = dir.join("notes.json");
    if store.path() == target {
        return Ok(false);
    }
    let mut load_existing = false;
    if target.exists() {
        let choice = app
            .dialog()
            .message(text.existing)
            .title("Memo")
            .parent(window)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                text.open_existing.into(),
                text.replace_existing.into(),
                text.cancel.into(),
            ))
            .blocking_show_with_result();
        // Depending on the OS, custom buttons come back as Yes/No or as their label.
        load_existing = match choice {
            MessageDialogResult::Yes => true,
            MessageDialogResult::No => false,
            MessageDialogResult::Custom(label) if label == text.open_existing => true,
            MessageDialogResult::Custom(label) if label == text.replace_existing => false,
            _ => return Ok(false),
        };
    }
    let config = Config {
        data_dir: (dir != default).then(|| dir.clone()),
    };
    let result = store
        .relocate(target, load_existing)
        .and_then(|loaded| config.save(&default.join(CONFIG)).map(|()| loaded));
    let loaded = match result {
        Ok(loaded) => loaded,
        Err(err) => {
            storage_error(app, window, text.failed, &err);
            return Err(err.to_string());
        }
    };
    if loaded {
        reload_windows(app);
    }
    notify(app);
    Ok(true)
}

/// After switching to another notes file: closes the note windows, opens the
/// active notes of the new file and applies its theme and language. The
/// manager reloads itself on "store-replaced".
fn reload_windows(app: &AppHandle) {
    for window in app.webview_windows().into_values() {
        if is_note(&window) || is_group(&window) {
            let _ = window.destroy();
        }
    }
    let store = app.state::<Shared>();
    for group in store.groups() {
        let _ = open_group_window(app, &group);
    }
    for note in store.visible() {
        let _ = open_note_window(app, &note);
    }
    let theme = store.theme();
    for window in app.webview_windows().values().filter(|w| is_app_window(w)) {
        apply_background(window, &theme);
    }
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let _ = manager.set_title(manager_title(store.effective_language()));
    }
    refresh_tray(app);
    let _ = app.emit("store-replaced", ());
}

/// Folder where the notes are saved and whether it is the default one.
#[tauri::command]
fn get_data_dir(app: AppHandle, store: State<'_, Shared>) -> (String, bool) {
    let path = store.path();
    let dir = path.parent().unwrap_or(&path);
    let is_default = default_data_dir(&app).is_ok_and(|d| d == dir);
    (dir.display().to_string(), is_default)
}

/// Lets the user pick another folder for the notes and moves them there.
/// Returns `false` if cancelled or unchanged.
#[tauri::command]
async fn choose_data_dir(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    let store = app.state::<Shared>();
    let text = storage_text(store.effective_language());
    let current = store.path();
    let mut picker = app
        .dialog()
        .file()
        .set_title(text.pick_title)
        .set_parent(&window);
    if let Some(dir) = current.parent() {
        picker = picker.set_directory(dir);
    }
    let Some(picked) = picker.blocking_pick_folder() else {
        return Ok(false);
    };
    let dir = picked.into_path().map_err(|e| e.to_string())?;
    move_data_dir(&app, &window, dir)
}

/// Moves the notes back to the default data folder.
#[tauri::command]
async fn reset_data_dir(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    let dir = default_data_dir(&app).map_err(|e| e.to_string())?;
    move_data_dir(&app, &window, dir)
}

/// Native error dialog for a failed storage action, with the OS error below.
fn storage_error(app: &AppHandle, window: &WebviewWindow, message: &str, err: &std::io::Error) {
    app.dialog()
        .message(format!("{message}\n\n{err}"))
        .title("Memo")
        .kind(MessageDialogKind::Error)
        .parent(window)
        .blocking_show();
}

/// Exports the notes not in the trash to a `.json` file picked by the user.
/// `file_name` is the suggested name (the page knows the local date).
/// Returns `false` if cancelled.
#[tauri::command]
async fn export_notes(
    app: AppHandle,
    window: WebviewWindow,
    file_name: String,
) -> Result<bool, String> {
    let store = app.state::<Shared>();
    let text = storage_text(store.effective_language());
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(text.export_title)
        .set_parent(&window)
        .set_file_name(file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    store.export_to(&path).map_err(|err| {
        storage_error(&app, &window, text.export_failed, &err);
        err.to_string()
    })?;
    Ok(true)
}

/// Imports the notes of a `.json` file picked by the user (see
/// `Store::import_from`) and opens or refreshes the windows of the notes that
/// changed. Returns how many notes were added or replaced; `None` if
/// cancelled.
#[tauri::command]
async fn import_notes(app: AppHandle, window: WebviewWindow) -> Result<Option<usize>, String> {
    let store = app.state::<Shared>();
    let text = storage_text(store.effective_language());
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(text.import_title)
        .set_parent(&window)
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let ids = store.import_from(&path).map_err(|err| {
        storage_error(&app, &window, text.import_failed, &err);
        err.to_string()
    })?;
    store.flush();
    for id in &ids {
        let note = store.get(id);
        let open = app.get_webview_window(&label_for(id));
        match (note, open) {
            // Window already open: reload it with the imported content.
            (Some(note), Some(w)) if note.trashed_at.is_none() => {
                let _ = w.set_always_on_top(note.pinned);
                let _ = w.reload();
            }
            (Some(note), None) if note.trashed_at.is_none() => {
                let _ = open_note_window(&app, &note);
            }
            // Imported as trashed (or purged): close its window.
            (_, Some(w)) => {
                let _ = w.destroy();
            }
            _ => {}
        }
    }
    notify(&app);
    Ok(Some(ids.len()))
}

// ---------------------------------------------------------------------------
// Tray / menu bar icon
// ---------------------------------------------------------------------------

/// Tray menu: shortcuts and "Quit". Theme and help live in the manager.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let [new_label, show_label, manager_label, quit_label] =
        tray_labels(app.state::<Shared>().effective_language());
    let new_item = MenuItem::with_id(app, "new", new_label, true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let manager_item = MenuItem::with_id(app, "manager", manager_label, true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &new_item,
            &show_item,
            &separator,
            &manager_item,
            &separator2,
            &quit_item,
        ],
    )
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;

    // On macOS the icon is a "template" (monochrome, adapts to the menu bar theme).
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::include_image!("icons/tray.png");

    TrayIconBuilder::with_id("memo")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Memo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new" => {
                let _ = create_and_open(app, None);
            }
            "show" => show_all(app),
            "manager" => {
                let _ = open_manager(app);
            }
            "quit" => {
                app.state::<Shared>().flush();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_all(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------

/// The default data folder used to be named after the app identifier
/// (`br.memo.notas`, and `br.taxinha.notas` when the app was called Taxinha).
/// On the first run with the `memo` folder (no `notes.json` or `config.json`
/// there yet), copies both files from the newest old folder that has them.
/// The old folders are left intact, as a backup.
fn migrate_old_data(dir: &Path) {
    let files = ["notes.json", CONFIG];
    if files.iter().any(|f| dir.join(f).exists()) {
        return;
    }
    let Some(parent) = dir.parent() else {
        return;
    };
    let Some(old) = OLD_DATA_FOLDERS
        .iter()
        .map(|name| parent.join(name))
        .find(|old| files.iter().any(|f| old.join(f).exists()))
    else {
        return;
    };
    for file in files {
        let from = old.join(file);
        if from.exists() {
            if let Err(err) = std::fs::copy(&from, dir.join(file)) {
                eprintln!("memo: could not copy {from:?}: {err}");
            }
        }
    }
}

fn main() {
    // On Wayland the compositor ignores "always on top". Running through
    // XWayland, pinning works on GNOME, KDE and the like.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var_os("GDK_BACKEND").is_none()
        {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Launching the app again brings the notes to the front and opens the manager.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_all(app);
            let _ = open_manager(app);
        }))
        .invoke_handler(tauri::generate_handler![
            get_theme,
            drag_start,
            drag_to,
            drag_end,
            resize_to,
            load_note,
            save_text,
            set_pinned,
            set_color,
            set_collapsed,
            set_title,
            new_note,
            trash_note,
            load_manager,
            close_manager,
            bring_notes_to_front,
            list_notes,
            open_note,
            move_to_trash,
            restore_note,
            delete_forever,
            empty_trash,
            change_theme,
            get_language,
            change_language,
            show_welcome,
            quit_app,
            get_default_color,
            set_default_color,
            get_new_note_defaults,
            set_default_title,
            get_group_defaults,
            set_default_group_color,
            set_default_group_title,
            set_default_content,
            get_data_dir,
            choose_data_dir,
            reset_data_dir,
            export_notes,
            import_notes,
            list_groups,
            get_note_group,
            set_note_group,
            move_note_to_group,
            load_group,
            rename_group,
            set_group_color,
            set_group_height,
            toggle_group,
            new_note_in_group,
            new_group,
            delete_group
        ])
        .setup(|app| {
            let default_dir = default_data_dir(app.handle())?;
            std::fs::create_dir_all(&default_dir)?;
            migrate_old_data(&default_dir);
            let dir = data_dir(&default_dir);
            let store: Shared = Arc::new(Store::load(dir.join("notes.json")));
            app.manage(store.clone());
            app.manage(Drags::default());
            app.manage(Sliding::default());

            // Writes pending changes and, every hour, purges from the trash
            // whatever is older than 30 days.
            let saver = store.clone();
            let saver_app = app.handle().clone();
            thread::spawn(move || {
                let ticks_per_purge = (PURGE_EVERY.as_millis() / SAVE_EVERY.as_millis()) as u32;
                let mut tick = 0u32;
                loop {
                    thread::sleep(SAVE_EVERY);
                    tick = (tick + 1) % ticks_per_purge;
                    if tick == 0 && saver.purge_trash(now_ms()) {
                        notify(&saver_app);
                    }
                    saver.flush();
                }
            });

            let handle = app.handle().clone();
            build_tray(&handle)?;

            // The manager opens on every launch; on the first one, the welcome
            // note opens beside it.
            build_snap_preview(&handle)?;
            open_manager(&handle)?;
            for group in store.groups() {
                open_group_window(&handle, &group)?;
            }
            if store.is_first_run() {
                let pos = handle.get_webview_window(MANAGER).and_then(|m| beside(&m));
                open_welcome(&handle, pos, false)?;
            } else if store.active().is_empty() && store.groups().is_empty() {
                create_and_open(&handle, None)?;
            } else {
                // Notes inside closed groups stay in them.
                for note in &store.visible() {
                    open_note_window(&handle, note)?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start Memo");

    app.run(|app, event| match event {
        // Closing the last note doesn't quit the app: it stays in the tray.
        RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => app.state::<Shared>().flush(),
        // Clicking the Dock icon brings the notes to the front and opens the manager.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            show_all(app);
            let _ = open_manager(app);
        }
        _ => {}
    });
}
