// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;
mod welcome;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::Duration,
};

use store::{
    is_valid_color, now_ms, Config, ManagerState, Note, Store, DEFAULT_H, DEFAULT_TEXT_MAX,
    DEFAULT_W, LANGUAGES, THEMES, TITLEBAR_H, TITLE_MAX,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, Theme,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
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
/// Minimum widths (logical) of a note and of the manager.
const MIN_W: f64 = 180.0;
const MANAGER_MIN_W: f64 = 380.0;
/// Label of the manager window (notes and trash).
const MANAGER: &str = "manager";
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

/// Open note windows (excluding the manager).
fn note_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(is_note)
        .collect()
}

/// Tells the windows (the manager) that the note list changed.
fn notify(app: &AppHandle) {
    let _ = app.emit("notes-changed", ());
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/// Opens a note's window (or brings it to the front if it is already open).
fn open_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    let label = label_for(&note.id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Memo")
        .inner_size(note.width, note.height)
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
    window.show()?;
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
        .inner_size(state.width, state.height)
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
    for window in app.webview_windows().values() {
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

/// Saves position and size whenever the user moves or resizes a window
/// (note or manager).
fn track_geometry(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let win = window.clone();
    let id = id_of(window);
    let note = is_note(window);
    window.on_window_event(move |event| {
        let store = app.state::<Shared>();
        match event {
            WindowEvent::Moved(pos) => {
                // Windows reports -32000 when minimising; ignore it.
                if pos.x <= -30_000 || pos.y <= -30_000 {
                    return;
                }
                let (x, y) = (Some(pos.x), Some(pos.y));
                if note {
                    store.update(&id, |n| (n.x, n.y) = (x, y));
                } else {
                    store.update_manager(|m| (m.x, m.y) = (x, y));
                }
            }
            WindowEvent::Resized(size) => {
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let scale = win.scale_factor().unwrap_or(1.0);
                let logical = size.to_logical::<f64>(scale);
                if note {
                    store.update(&id, |n| {
                        (n.width, n.height) = (logical.width, logical.height)
                    });
                } else {
                    store.update_manager(|m| (m.width, m.height) = (logical.width, logical.height));
                }
            }
            WindowEvent::ThemeChanged(_) => apply_background(&win, &store.theme()),
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
            if other.label() == window.label() || !other.is_visible().unwrap_or(false) {
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

/// Drag driven by the page: moves the window to physical (`x`, `y`), snapping
/// to monitor edges and other windows. The native drag (`startDragging`)
/// can't do this, because the OS owns the window until the button is
/// released.
#[tauri::command]
fn drag_to(window: WebviewWindow, x: i32, y: i32) {
    let (Some((dx, dy)), Ok(size)) = (frame_offset(&window), window.inner_size()) else {
        return;
    };
    // `x`,`y` are the window corner; snapping works on the visible area.
    let (vx, vy) = snapped(
        &window,
        x + dx,
        y + dy,
        size.width as i32,
        size.height as i32,
    );
    let _ = window.set_position(PhysicalPosition::new(vx - dx, vy - dy));
}

/// Resize driven by the page (handles on the edges and corners): the moving
/// edges (`edges`: "n", "s", "e", "w" or combinations) of the requested
/// visible area (physical `x`,`y`,`w`,`h`) are pulled by the same snapping as
/// dragging. Native resizing is off (`resizable(false)`): the OS wouldn't let
/// us adjust the size mid-gesture.
#[tauri::command]
fn resize_to(window: WebviewWindow, x: i32, y: i32, w: i32, h: i32, edges: String) {
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

/// Brings every open note window to the front (restoring minimised ones).
/// Returns `false` if there is none.
fn raise_notes(app: &AppHandle) -> bool {
    let windows = note_windows(app);
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
        .filter(|w| w.is_visible().unwrap_or(false))
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
    open_note_window(&app, &note).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn move_to_trash(app: AppHandle, id: String) {
    trash(&app, &id);
}

/// Takes the note out of the trash and opens its window.
#[tauri::command]
async fn restore_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .update(&id, |n| n.trashed_at = None)
        .ok_or("note not found")?;
    open_note_window(&app, &note).map_err(|e| e.to_string())?;
    notify(&app);
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
    for window in note_windows(app) {
        let _ = window.destroy();
    }
    let store = app.state::<Shared>();
    for note in store.active() {
        let _ = open_note_window(app, &note);
    }
    let theme = store.theme();
    for window in app.webview_windows().values() {
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
            drag_to,
            resize_to,
            load_note,
            save_text,
            set_pinned,
            set_color,
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
            set_default_content,
            get_data_dir,
            choose_data_dir,
            reset_data_dir,
            export_notes,
            import_notes
        ])
        .setup(|app| {
            let default_dir = default_data_dir(app.handle())?;
            std::fs::create_dir_all(&default_dir)?;
            migrate_old_data(&default_dir);
            let dir = data_dir(&default_dir);
            let store: Shared = Arc::new(Store::load(dir.join("notes.json")));
            app.manage(store.clone());

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
            open_manager(&handle)?;
            let notes = store.active();
            if store.is_first_run() {
                let pos = handle.get_webview_window(MANAGER).and_then(|m| beside(&m));
                open_welcome(&handle, pos, false)?;
            } else if notes.is_empty() {
                create_and_open(&handle, None)?;
            } else {
                for note in &notes {
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
