// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clients;
mod cloud;
mod desk;
mod images;
mod mcp;
mod store;
mod sync;
mod updater;
mod welcome;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use store::{
    is_valid_color, now_ms, Board, BoardColumn, Config, Group, ManagerState, Note, Store, BOARD_MIN_H,
    BOARD_MIN_W, BOARD_NAME_MAX, DEFAULT_H, DEFAULT_TEXT_MAX, DEFAULT_W, GROUP_NAME_MAX, LANGUAGES,
    LAYOUTS, RANDOM_COLOR, THEMES, TITLEBAR_H, TITLE_MAX, ZOOM_STEP,
};
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalSize, RunEvent, State,
    Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tauri_plugin_opener::OpenerExt;

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
/// Height of text (logical) left under a note's titlebar at which a resize
/// snaps the note down to the titlebar alone (the titlebar "magnet").
const TITLEBAR_SNAP: f64 = 40.0;
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
/// Argument of a start with the system (autostart): no manager on screen.
const AUTOSTART_ARG: &str = "--autostart";
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

fn is_board(window: &WebviewWindow) -> bool {
    window.label().starts_with("board-")
}

fn board_label(id: &str) -> String {
    format!("board-{id}")
}

fn board_id_of(window: &WebviewWindow) -> String {
    window.label().trim_start_matches("board-").to_string()
}

/// The app's real windows (notes, groups, boards and manager), i.e. not the Snap
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

/// Tells windows that boards changed.
fn boards_changed(app: &AppHandle) {
    let _ = app.emit("boards-changed", ());
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
        .inner_size(note.width, note.height)
        .decorations(false)
        // Resized through the page's handles (resize_to), with snapping.
        .resizable(false)
        .always_on_top(note.pinned)
        .background_color(CARBON)
        // macOS: the first click on an inactive window reaches the page, so
        // the titlebar drags (and buttons work) without a focusing click first.
        .accept_first_mouse(true)
        .visible(false)
        .build()?;

    match (note.x, note.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            desk::set_position(&window, x, y);
            // Built on the main monitor: on another one with a different
            // scale the window would keep the main monitor's pixel size.
            set_logical_size(&window, note.width, note.height);
        }
        _ => {
            let _ = window.center();
        }
    }

    apply_theme(&window, &app.state::<Shared>().theme());
    track_geometry(app, &window);
    let _ = window.set_zoom(app.state::<Shared>().zoom());
    Ok(window)
}

/// Manager tab (and list scope) the tray asked for, picked up by a manager
/// window that is still loading (`take_manager_view`).
#[derive(Clone, serde::Serialize)]
struct ManagerView {
    view: &'static str,
    scope: Option<&'static str>,
}

static MANAGER_VIEW: Mutex<Option<ManagerView>> = Mutex::new(None);
static BOARD_TRANSIENT_NOTES: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn mark_board_transient(note_id: &str) {
    let mut lock = BOARD_TRANSIENT_NOTES.lock().unwrap();
    let set = lock.get_or_insert_with(HashSet::new);
    set.insert(note_id.to_string());
}

fn take_board_transient(note_id: &str) -> bool {
    let mut lock = BOARD_TRANSIENT_NOTES.lock().unwrap();
    if let Some(set) = lock.as_mut() {
        set.remove(note_id)
    } else {
        false
    }
}

fn is_board_transient(note_id: &str) -> bool {
    let lock = BOARD_TRANSIENT_NOTES.lock().unwrap();
    lock.as_ref().map(|s| s.contains(note_id)).unwrap_or(false)
}

/// Opens the manager on `view` ("notes", "groups", "settings", "help"), with
/// the list showing `scope` ("current" or "trash").
fn open_manager_view(app: &AppHandle, view: &'static str, scope: Option<&'static str>) {
    let target = ManagerView { view, scope };
    if app.get_webview_window(MANAGER).is_some() {
        let _ = app.emit_to(MANAGER, "manager-view", target);
    } else {
        *MANAGER_VIEW.lock().unwrap() = Some(target);
    }
    let _ = open_manager(app);
}

/// The tab a new manager window opens on (see `open_manager_view`).
#[tauri::command]
fn take_manager_view() -> Option<ManagerView> {
    MANAGER_VIEW.lock().unwrap().take()
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
        // macOS: the first click on an inactive window reaches the page, so
        // the titlebar drags (and buttons work) without a focusing click first.
        .accept_first_mouse(true)
        .visible(false)
        .build()?;
    match (state.x, state.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            desk::set_position(&window, x, y);
            // On another monitor's scale (see `build_note_window`).
            set_logical_size(&window, state.width, state.height);
        }
        _ => {
            let _ = window.center();
        }
    }
    apply_theme(&window, &store.theme());
    track_geometry(app, &window);
    let _ = window.set_zoom(store.zoom());
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Manager window title (taskbar) in the UI language.
fn manager_title(lang: &str) -> &'static str {
    if lang == "en" {
        "Memo Manager"
    } else {
        "Gerenciador do Memo"
    }
}

/// Tray menu labels in the UI language (the same words as `i18n.js`).
struct TrayLabels {
    new_note: &'static str,
    new_group: &'static str,
    new_board: &'static str,
    show: &'static str,
    manager: &'static str,
    trash: &'static str,
    settings: &'static str,
    help: &'static str,
    theme: &'static str,
    system: &'static str,
    light: &'static str,
    dark: &'static str,
    language: &'static str,
    layout: &'static str,
    cards: &'static str,
    list: &'static str,
    autostart: &'static str,
    magnet: &'static str,
    ai_control: &'static str,
    sync: &'static str,
    check_updates: &'static str,
    update_to: &'static str,
    quit: &'static str,
}

fn tray_labels(lang: &str) -> TrayLabels {
    if lang == "en" {
        TrayLabels {
            new_note: "New memory",
            new_group: "New group",
            new_board: "New board",
            show: "Show all memories",
            manager: "Memo Manager",
            trash: "Trash",
            settings: "Settings",
            help: "Help",
            theme: "Theme",
            system: "System",
            light: "Light",
            dark: "Dark",
            language: "Language",
            layout: "Manager layout",
            cards: "Cards",
            list: "List",
            autostart: "Start with the system",
            magnet: "Window magnet",
            ai_control: "AI control (MCP)",
            sync: "Sync now",
            check_updates: "Check for updates",
            update_to: "Update to version",
            quit: "Quit Memo",
        }
    } else {
        TrayLabels {
            new_note: "Nova memória",
            new_group: "Novo grupo",
            new_board: "Novo quadro",
            show: "Mostrar todas as memórias",
            manager: "Gerenciador do Memo",
            trash: "Lixeira",
            settings: "Configurações",
            help: "Ajuda",
            theme: "Tema",
            system: "Sistema",
            light: "Claro",
            dark: "Escuro",
            language: "Idioma",
            layout: "Visualização do Gerenciador",
            cards: "Cards",
            list: "Lista",
            autostart: "Iniciar com o sistema",
            magnet: "Ímã das janelas",
            ai_control: "Controle por IA (MCP)",
            sync: "Sincronizar agora",
            check_updates: "Procurar atualizações",
            update_to: "Atualizar para a versão",
            quit: "Sair do Memo",
        }
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

/// Rebuilds the tray menu (language, theme, autostart or cloud account changed). Menus can only be changed
/// on the main thread (a macOS requirement).
fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("memo"), build_tray_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

/// The window's native theme and background for the app's theme: the
/// native theme makes its titlebar menu (`show_title_menu`) match the app.
fn apply_theme(window: &WebviewWindow, theme: &str) {
    let _ = window.set_theme(match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    });
    apply_background(window, theme);
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
        apply_theme(window, theme);
    }
    let _ = app.emit("theme-changed", theme);
    refresh_tray(app);
}

/// Scale factor of the monitor a window is on (the one holding most of it,
/// as the system decides). `scale_factor()` is what the window was last told,
/// which can lag behind on Windows with monitors of different scales: a window
/// placed on another monitor while hidden keeps the scale it was built with.
fn scale_of(window: &WebviewWindow) -> f64 {
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .or_else(|| window.scale_factor().ok())
        .unwrap_or(1.0)
}

/// Sets a window's size in logical pixels of the monitor it is on (see
/// `scale_of`), so it looks the same size on every monitor.
fn set_logical_size(window: &WebviewWindow, width: f64, height: f64) {
    let scale = scale_of(window);
    let _ = window.set_size(PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    ));
}

/// A saved position is only used if the titlebar is still visible on some
/// monitor (avoids "lost" notes after a display is disconnected).
fn is_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let screens = desk::screens(window);
    screens.is_empty()
        || screens
            .iter()
            .any(|m| m.contains(((x + 48) as f64, (y + 12) as f64)))
}

/// Which saved object a window's geometry belongs to.
enum Kind {
    Note(String),
    Group(String),
    Board(String),
    Manager,
}

/// Saves position and size whenever the user moves or resizes a window
/// (note, group, board or manager). Moves made by a group animation are skipped,
/// so a note keeps its own place.
fn track_geometry(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let win = window.clone();
    let kind = if is_note(window) {
        Kind::Note(id_of(window))
    } else if is_group(window) {
        Kind::Group(group_id_of(window))
    } else if is_board(window) {
        Kind::Board(board_id_of(window))
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
                // Saved in desktop units (`desk`), like everything they're
                // compared with.
                let (x, y) = desk::point(&win, *pos);
                let (x, y) = (Some(x), Some(y));
                match &kind {
                    Kind::Note(id) => {
                        store.update(id, |n| (n.x, n.y) = (x, y));
                    }
                    Kind::Group(id) => {
                        store.update_group(id, |g| (g.x, g.y) = (x, y));
                    }
                    Kind::Board(id) => {
                        store.update_board(id, |b| (b.x, b.y) = (x, y));
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
                let logical = size.to_logical::<f64>(scale_of(&win));
                match &kind {
                    Kind::Note(id) => {
                        store.update(id, |n| {
                            (n.width, n.height) = (logical.width, logical.height)
                        });
                    }
                    Kind::Group(id) => {
                        store.update_group(id, |g| g.width = logical.width);
                    }
                    Kind::Board(id) => {
                        store.update_board(id, |b| {
                            (b.width, b.height) = (logical.width, logical.height)
                        });
                    }
                    Kind::Manager => {
                        store.update_manager(|m| {
                            (m.width, m.height) = (logical.width, logical.height)
                        });
                    }
                }
            }
            WindowEvent::ThemeChanged(_) => apply_background(&win, &store.theme()),
            // Coming back to Memo: fetch what changed on other computers.
            WindowEvent::Focused(true) => sync::on_focus(),
            WindowEvent::Focused(false) => {
                if is_note(&win) {
                    let note_id = id_of(&win);
                    if is_board_transient(&note_id) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            let label = label_for(&note_id);
                            if let Some(w) = app.get_webview_window(&label) {
                                if !w.is_focused().unwrap_or(false) {
                                    take_board_transient(&note_id);
                                    close_note_by_id(&app, &note_id);
                                    boards_changed(&app);
                                }
                            }
                        });
                    }
                }
            }
            WindowEvent::Destroyed => {
                app.state::<Sliding>().0.lock().unwrap().remove(win.label());
                if is_note(&win) {
                    take_board_transient(&id_of(&win));
                }
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
    /// Snap reach, in desktop units (`desk`).
    reach: i32,
    /// Desktop units per logical pixel.
    scale: f64,
}

impl SnapTargets {
    /// Targets for the visible rect `l`,`t`,`r`,`b`, in desktop units.
    fn new(window: &WebviewWindow, l: i32, t: i32, r: i32, b: i32) -> Self {
        let (cx, cy) = ((l + r) / 2, (t + b) / 2);
        let monitor = desk::screens(window)
            .into_iter()
            .find(|m| m.work_contains((cx, cy)));
        let scale = match &monitor {
            Some(m) => m.scale,
            None => desk::scale(window),
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
        // Magnet off (Settings): nothing pulls.
        if !window.state::<Shared>().magnet() {
            return t_;
        }
        // Monitor edges: the same gap (`SNAP_GAP`) left between notes.
        if let Some(m) = &monitor {
            let (ax, ay, aw, ah) = m.work;
            t_.left.push(ax + gap);
            t_.right.push(ax + aw - gap);
            t_.top.push(ay + gap);
            t_.bottom.push(ay + ah - gap);
        }
        // Other windows pull only when they are really on the user's screen:
        // shown, not minimised, and on the monitor where this window is.
        for other in window.app_handle().webview_windows().into_values() {
            if other.label() == window.label()
                || !is_app_window(&other)
                || !other.is_visible().unwrap_or(false)
                || other.is_minimized().unwrap_or(false)
            {
                continue;
            }
            let (Some((ol, ot)), Some((ow, oh))) =
                (desk::inner_position(&other), desk::inner_size(&other))
            else {
                continue;
            };
            let (or, ob) = (ol + ow, ot + oh);
            // Covered by other apps' windows: not on screen either.
            if !shows_on_screen(&other, (ol, ot, or, ob)) {
                continue;
            }
            if let Some(m) = &monitor {
                let (mx, my, mw, mh) = m.area;
                let on_monitor = ol < mx + mw && or > mx && ot < my + mh && ob > my;
                if !on_monitor {
                    continue;
                }
            }
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

/// Whether any part of `window` (visible rect `l`,`t`,`r`,`b`, physical) is
/// actually seen on screen, i.e. not covered by other windows: a covered note
/// must not pull with the magnet. Each system answers in its own way (below);
/// when it can't tell, the window counts as shown.
///
/// Windows and Linux sample the same points: a 3×3 grid over the window,
/// slightly inset; it is shown if the top window at any of them is itself.
fn sample_points((l, t, r, b): (i32, i32, i32, i32)) -> impl Iterator<Item = (i32, i32)> {
    let inset = 4;
    let xs = [l + inset, (l + r) / 2, r - 1 - inset];
    let ys = [t + inset, (t + b) / 2, b - 1 - inset];
    ys.into_iter()
        .flat_map(move |y| xs.into_iter().map(move |x| (x, y)))
}

/// Windows: asks which top-level window is shown at each point.
#[cfg(windows)]
fn shows_on_screen(window: &WebviewWindow, rect: (i32, i32, i32, i32)) -> bool {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT},
    };
    let Ok(hwnd) = window.hwnd() else {
        return true;
    };
    let own = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    sample_points(rect).any(|(x, y)| {
        // SAFETY: plain Win32 queries with no pointers kept; a null result
        // just doesn't match.
        let top = unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT) };
        top == own
    })
}

/// macOS: the window server tracks this itself — `occlusionState` has the
/// "visible" flag while any part of the window can be seen.
#[cfg(target_os = "macos")]
fn shows_on_screen(window: &WebviewWindow, _rect: (i32, i32, i32, i32)) -> bool {
    use objc2_app_kit::{NSView, NSWindowOcclusionState};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else {
        return true;
    };
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return true;
    };
    // SAFETY: the handle's view lives as long as the window, which is held
    // here; this runs on the main thread (sync commands do).
    let view: &NSView = unsafe { appkit.ns_view.cast().as_ref() };
    match view.window() {
        Some(ns_window) => ns_window
            .occlusionState()
            .contains(NSWindowOcclusionState::Visible),
        None => true,
    }
}

/// Linux (X11 — Memo forces XWayland, see `main`): the root window's children
/// in stacking order; at each point the top-most viewable one must be this
/// window's top-level (usually the window manager's frame around it).
#[cfg(target_os = "linux")]
fn shows_on_screen(window: &WebviewWindow, rect: (i32, i32, i32, i32)) -> bool {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else {
        return true;
    };
    let xid = match handle.as_raw() {
        RawWindowHandle::Xlib(h) => h.window,
        RawWindowHandle::Xcb(h) => h.window.get().into(),
        _ => return true, // native Wayland: no way to tell
    };
    X11.with(|x11| match x11 {
        // SAFETY: a private Xlib connection used only on this thread.
        Some((xlib, display)) => unsafe { x11_shows(xlib, *display, xid, rect) },
        None => true,
    })
}

#[cfg(target_os = "linux")]
thread_local! {
    /// Memo's own Xlib connection (libX11 loaded at run time), opened once
    /// per thread on first use; `None` without X11.
    static X11: Option<(x11_dl::xlib::Xlib, *mut x11_dl::xlib::Display)> = {
        let xlib = x11_dl::xlib::Xlib::open().ok();
        xlib.and_then(|xlib| {
            // SAFETY: opens the default display; null when there is none.
            let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
            (!display.is_null()).then_some((xlib, display))
        })
    };
}

/// See `shows_on_screen` (Linux).
///
/// # Safety
/// `display` must be a live connection opened with `xlib`.
#[cfg(target_os = "linux")]
unsafe fn x11_shows(
    xlib: &x11_dl::xlib::Xlib,
    display: *mut x11_dl::xlib::Display,
    xid: x11_dl::xlib::Window,
    rect: (i32, i32, i32, i32),
) -> bool {
    use std::{mem, os::raw::c_int, ptr};
    use x11_dl::xlib;

    // A window can vanish between two queries: Xlib's default handler would
    // end the process on that error, so errors are ignored meanwhile.
    unsafe extern "C" fn ignore(_: *mut xlib::Display, _: *mut xlib::XErrorEvent) -> c_int {
        0
    }
    let previous = (xlib.XSetErrorHandler)(Some(ignore));

    // Children of `w` (stacking order, bottom first) and its parent.
    let query = |w: xlib::Window| -> Option<(Vec<xlib::Window>, xlib::Window)> {
        let (mut root, mut parent) = (0, 0);
        let (mut kids, mut n): (*mut xlib::Window, u32) = (ptr::null_mut(), 0);
        if (xlib.XQueryTree)(display, w, &mut root, &mut parent, &mut kids, &mut n) == 0 {
            return None;
        }
        let list = if kids.is_null() {
            Vec::new()
        } else {
            let list = std::slice::from_raw_parts(kids, n as usize).to_vec();
            (xlib.XFree)(kids.cast());
            list
        };
        Some((list, parent))
    };

    let root = (xlib.XDefaultRootWindow)(display);
    let shown = (|| {
        // This window's top-level: its ancestor that is a child of the root.
        let mut top = xid;
        loop {
            let (_, parent) = query(top)?;
            if parent == root || parent == 0 {
                break;
            }
            top = parent;
        }
        // Viewable top-levels with their rects, top of the stack first.
        let (stack, _) = query(root)?;
        let rects: Vec<(xlib::Window, i32, i32, i32, i32)> = stack
            .into_iter()
            .rev()
            .filter_map(|w| {
                let mut a: xlib::XWindowAttributes = mem::zeroed();
                if (xlib.XGetWindowAttributes)(display, w, &mut a) == 0
                    || a.map_state != xlib::IsViewable
                {
                    return None;
                }
                let border = 2 * a.border_width;
                Some((w, a.x, a.y, a.x + a.width + border, a.y + a.height + border))
            })
            .collect();
        Some(sample_points(rect).any(|(x, y)| {
            rects
                .iter()
                .find(|&&(_, l, t, r, b)| x >= l && x < r && y >= t && y < b)
                .is_some_and(|&(w, ..)| w == top)
        }))
    })();

    (xlib.XSync)(display, xlib::False);
    (xlib.XSetErrorHandler)(previous);
    shown.unwrap_or(true)
}

/// Other systems: no check.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn shows_on_screen(_window: &WebviewWindow, _rect: (i32, i32, i32, i32)) -> bool {
    true
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
    let outer = desk::outer_position(window)?;
    let inner = desk::inner_position(window)?;
    Some((inner.0 - outer.0, inner.1 - outer.1))
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

#[derive(Clone, PartialEq, Debug)]
enum DropTarget {
    Group(String),
    BoardColumn(String, String),
}

#[derive(Clone, serde::Deserialize, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnBounds {
    pub id: String,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

struct Drag {
    /// Cursor offset from the window's outer corner, in logical pixels: on
    /// a monitor with another scale the window changes size, and the cursor
    /// stays on the same spot of the titlebar.
    grab: (f64, f64),
    /// Outer position where the drag started.
    start: (i32, i32),
    /// Snap zone under the cursor at the last move.
    zone: Option<Rect>,
    /// Drop target under the cursor (group bar or board column).
    drop: Option<DropTarget>,
}

#[derive(Default)]
struct Drags {
    /// Drags in progress, by window label.
    active: Mutex<HashMap<String, Drag>>,
    /// Logical size of each snapped window before it was snapped, restored
    /// when it is dragged again (not persisted).
    restore: Mutex<HashMap<String, (f64, f64)>>,
    /// Resizes in progress, by window label.
    resizes: Mutex<HashMap<String, Resize>>,
    /// Active column bounds by board id for drag-drop.
    board_columns: Mutex<HashMap<String, Vec<ColumnBounds>>>,
}

/// Cursor and visible rect when a resize handle was grabbed.
#[derive(Clone, Copy)]
struct Resize {
    cursor: (f64, f64),
    rect: Rect,
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
fn snap_zone(window: &WebviewWindow, cursor: (f64, f64)) -> Option<Rect> {
    let m = desk::screens(window)
        .into_iter()
        .find(|m| m.contains(cursor))?;
    let (cx, cy) = cursor;
    let scale = m.scale;
    let edge = SNAP_EDGE * scale;
    let (ml, mt, mw, mh) = m.area;
    let (l, t) = (ml as f64, mt as f64);
    let (r, b) = (l + mw as f64, t + mh as f64);
    let at_left = cx <= l + edge;
    let at_right = cx >= r - 1.0 - edge;
    let at_top = cy <= t + edge;
    // Corner bands: a fifth of the height on the sides, a tenth of the width
    // along the top.
    let near_top = cy < t + (b - t) / 5.0;
    let near_bottom = cy > b - (b - t) / 5.0;
    let near_left = cx < l + (r - l) / 10.0;
    let near_right = cx > r - (r - l) / 10.0;

    let (ax, ay, aw, ah) = m.work;
    let gap = (SNAP_GAP * scale).round() as i32;
    let (x0, y0) = (ax + gap, ay + gap);
    let x1 = ax + aw - gap;
    let y1 = ay + ah - gap;
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
    // On Linux the GTK window has no GDK window until it is first shown, and
    // tao panics setting its input shape before that: `show_snap_preview`
    // makes it click-through there instead.
    #[cfg(not(target_os = "linux"))]
    window.set_ignore_cursor_events(true)?;
    #[cfg(target_os = "linux")]
    let _ = window;
    Ok(())
}

/// Shows the preview over `rect`, or hides it (`None`).
fn show_snap_preview(app: &AppHandle, rect: Option<Rect>) {
    let Some(preview) = app.get_webview_window(SNAP_PREVIEW) else {
        return;
    };
    match rect {
        Some(r) => {
            let (dx, dy) = frame_offset(&preview).unwrap_or((0, 0));
            desk::set_position(&preview, r.x - dx, r.y - dy);
            desk::set_size(&preview, r.w, r.h);
            if !preview.is_visible().unwrap_or(false) {
                let _ = preview.show();
                #[cfg(target_os = "linux")]
                let _ = preview.set_ignore_cursor_events(true);
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
    let (Some(cursor), Some(outer)) = (desk::cursor(&window), desk::outer_position(&window)) else {
        return;
    };
    let scale = desk::scale(&window);
    let grab = (
        (cursor.0 - outer.0 as f64) / scale,
        (cursor.1 - outer.1 as f64) / scale,
    );
    let _ = window.set_always_on_top(true);
    drags.active.lock().unwrap().insert(
        window.label().into(),
        Drag {
            grab,
            start: outer,
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
    let Some(cursor) = desk::cursor(window) else {
        return;
    };
    let mut active = drags.active.lock().unwrap();
    let Some(drag) = active.get_mut(window.label()) else {
        return;
    };

    // A window snapped by an earlier drag gets its previous size back, with
    // the cursor at the same relative spot of the titlebar.
    let restore = drags.restore.lock().unwrap().remove(window.label());
    if let (Some((w, h)), Some(before)) = (restore, desk::outer_size(window)) {
        set_logical_size(window, w, h);
        if let Some(after) = desk::outer_size(window) {
            drag.grab.0 *= after.0 as f64 / before.0.max(1) as f64;
        }
    }
    // The grab point in desktop units, kept inside the window.
    let scale = desk::scale(window);
    let (mut gx, mut gy) = (drag.grab.0 * scale, drag.grab.1 * scale);
    if let Some((ow, oh)) = desk::outer_size(window) {
        gx = gx.min(ow as f64 - 1.0);
        gy = gy.min(oh as f64 - 1.0);
    }

    let (Some((dx, dy)), Some((w, h))) = (frame_offset(window), desk::inner_size(window)) else {
        return;
    };
    let x = (cursor.0 - gx).round() as i32;
    let y = (cursor.1 - gy).round() as i32;
    // `x`,`y` are the window corner; the magnet works on the visible area.
    let (vx, vy) = snapped(window, x + dx, y + dy, w, h);
    desk::set_position(window, vx - dx, vy - dy);

    // A note over a group bar or board column can be dropped into it;
    // a board over a group bar can be dropped into it;
    // group bars themselves don't Snap.
    let app = window.app_handle();
    if is_note(window) || is_board(window) {
        let target = if let Some(gid) = group_under(window, cursor) {
            Some(DropTarget::Group(gid))
        } else if is_note(window) {
            if let Some((bid, cid)) = board_col_under(app, cursor) {
                Some(DropTarget::BoardColumn(bid, cid))
            } else {
                None
            }
        } else {
            None
        };
        if target != drag.drop {
            match &drag.drop {
                Some(DropTarget::Group(old)) => {
                    let _ = app.emit("drop-hover", (old, false));
                }
                Some(DropTarget::BoardColumn(bid, cid)) => {
                    let _ = app.emit("board-drop-hover", (bid, cid, false));
                }
                None => {}
            }
            match &target {
                Some(DropTarget::Group(new)) => {
                    let _ = app.emit("drop-hover", (new, true));
                }
                Some(DropTarget::BoardColumn(bid, cid)) => {
                    let _ = app.emit("board-drop-hover", (bid, cid, true));
                }
                None => {}
            }
            drag.drop = target;
        }
    }
    // Group bars don't Snap (a half-screen titlebar).
    drag.zone = if is_group(window) || drag.drop.is_some() {
        None
    } else {
        snap_zone(window, cursor)
    };
    show_snap_preview(app, drag.zone);
}

/// The group bar under `cursor` (not the note or board's own group), by id.
fn group_under(window: &WebviewWindow, cursor: (f64, f64)) -> Option<String> {
    let own = if is_note(window) {
        window
            .state::<Shared>()
            .get(&id_of(window))
            .map(|n| n.group_id)
            .unwrap_or_default()
    } else if is_board(window) {
        window
            .state::<Shared>()
            .board(&board_id_of(window))
            .map(|b| b.group_id)
            .unwrap_or_default()
    } else {
        String::new()
    };
    window.app_handle()
        .webview_windows()
        .into_values()
        .filter(|w| {
            is_group(w) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
        })
        .find(|w| {
            let (Some((x, y)), Some((bw, bh))) = (desk::inner_position(w), desk::inner_size(w))
            else {
                return false;
            };
            cursor.0 >= x as f64
                && cursor.0 < (x + bw) as f64
                && cursor.1 >= y as f64
                && cursor.1 < (y + bh) as f64
        })
        .map(|w| group_id_of(&w))
        .filter(|id| *id != own)
}

/// The board column under `cursor`, if any.
fn board_col_under(app: &AppHandle, cursor: (f64, f64)) -> Option<(String, String)> {
    let board_windows: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| is_board(w) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .collect();

    for w in board_windows {
        let (Some((bx, by)), Some((bw, bh))) = (desk::inner_position(&w), desk::inner_size(&w)) else {
            continue;
        };
        if cursor.0 >= bx as f64 && cursor.0 < (bx + bw) as f64 && cursor.1 >= by as f64 && cursor.1 < (by + bh) as f64 {
            let rel_x = cursor.0 - bx as f64;
            let rel_y = cursor.1 - by as f64;
            let bid = board_id_of(&w);
            let drags = app.state::<Drags>();
            let cols = drags.board_columns.lock().unwrap().get(&bid).cloned().unwrap_or_default();
            for col in cols {
                if rel_x >= col.left && rel_x < col.right && rel_y >= col.top && rel_y < col.bottom {
                    return Some((bid, col.id));
                }
            }
        }
    }
    None
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
    // Dropped on a group bar or board column.
    if let Some(target) = drag.drop {
        let app = window.app_handle();
        match target {
            DropTarget::Group(group) => {
                let _ = app.emit("drop-hover", (&group, false));
                if is_board(&window) {
                    join_board_to_group(app, &board_id_of(&window), &group, Some(drag.start));
                } else {
                    join_group(app, &id_of(&window), &group, Some(drag.start));
                }
                return;
            }
            DropTarget::BoardColumn(bid, cid) => {
                let _ = app.emit("board-drop-hover", (&bid, &cid, false));
                let note_id = id_of(&window);
                let store = app.state::<Shared>();
                store.update_board(&bid, |b| {
                    for col in &mut b.columns {
                        col.note_ids.retain(|id| id != &note_id);
                    }
                    if let Some(col) = b.columns.iter_mut().find(|c| c.id == cid) {
                        col.note_ids.push(note_id.clone());
                    }
                });
                store.flush();
                store.update(&note_id, |n| n.hidden = true);
                store.flush();
                let _ = window.destroy();
                boards_changed(app);
                notify(app);
                return;
            }
        }
    }
    let Some(zone) = drag.zone else {
        return;
    };
    let (Some((dx, dy)), Ok(size)) = (frame_offset(&window), window.inner_size()) else {
        return;
    };
    let logical = size.to_logical::<f64>(scale_of(&window));
    drags
        .restore
        .lock()
        .unwrap()
        .insert(window.label().into(), (logical.width, logical.height));
    desk::set_position(&window, zone.x - dx, zone.y - dy);
    desk::set_size(&window, zone.w, zone.h);
}

/// Start of a resize by one of the page's handles: records the cursor and the
/// visible rect. Like dragging, the resize then follows the cursor as Rust
/// reads it (desktop units, `desk`), which stays right across monitors with
/// different scales, where the page's screen coordinates don't.
#[tauri::command]
fn resize_start(window: WebviewWindow, drags: State<'_, Drags>) {
    let (Some(cursor), Some((x, y)), Some((w, h))) = (
        desk::cursor(&window),
        desk::inner_position(&window),
        desk::inner_size(&window),
    ) else {
        return;
    };
    let rect = Rect { x, y, w, h };
    drags
        .resizes
        .lock()
        .unwrap()
        .insert(window.label().into(), Resize { cursor, rect });
}

/// Resize driven by the page (handles on the edges and corners): the moving
/// edges (`edges`: "n", "s", "e", "w" or combinations) follow the cursor from
/// `resize_start` and are pulled by the same snapping as dragging. Native
/// resizing is off (`resizable(false)`): the OS wouldn't let us adjust the
/// size mid-gesture.
#[tauri::command]
fn resize_to(window: WebviewWindow, edges: String, drags: State<'_, Drags>) {
    let Some(Resize {
        cursor: start,
        rect,
    }) = drags.resizes.lock().unwrap().get(window.label()).copied()
    else {
        return;
    };
    let Some(cursor) = desk::cursor(&window) else {
        return;
    };
    // Resized by hand: no longer "snapped", so a later drag keeps this size.
    drags.restore.lock().unwrap().remove(window.label());
    let Some((dx, dy)) = frame_offset(&window) else {
        return;
    };
    let mx = (cursor.0 - start.0).round() as i32;
    let my = (cursor.1 - start.1).round() as i32;
    let (mut l, mut t, mut r, mut b) = (rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    if edges.contains('w') {
        l += mx;
    }
    if edges.contains('e') {
        r += mx;
    }
    if edges.contains('n') {
        t += my;
    }
    if edges.contains('s') {
        b += my;
    }
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
    let zoom = window.state::<Shared>().zoom();
    let min_h = (TITLEBAR_H * zoom * targets.scale).round() as i32;
    if r - l < min_w {
        if edges.contains('w') {
            l = r - min_w;
        } else {
            r = l + min_w;
        }
    }
    // Titlebar magnet: a note with almost no text left closes onto its
    // titlebar, like the other magnets; pulling the edge past it opens it.
    let shut = (TITLEBAR_SNAP * zoom * targets.scale).round() as i32;
    if is_note(&window)
        && window.state::<Shared>().magnet()
        && (edges.contains('n') || edges.contains('s'))
        && b - t < min_h + shut
    {
        if edges.contains('n') {
            t = b - min_h;
        } else {
            b = t + min_h;
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
        desk::set_position(&window, l - dx, t - dy);
    }
    desk::set_size(&window, r - l, b - t);
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
/// minimised ones). Notes are raised first and group bars last, so the
/// groups end up on top. Returns `false` if there is none.
fn raise_notes(app: &AppHandle) -> bool {
    let mut windows: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| is_note(w) || is_group(w) || is_board(w))
        .collect();
    // Each focused window goes on top of the previous ones.
    windows.sort_by_key(is_group);
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
    let mut note = store.get(&id_of(&window))?;
    note.html = store.inline_images(&note.html);
    Some(note)
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
    // Images are kept as files; the note refers to them (images.rs).
    let html = store.store_images(&html);
    let mut changed = false;
    store.update(&id_of(&window), |n| {
        if n.text != text || n.html != html {
            n.text = text;
            n.html = html;
            changed = true;
        }
    });
    if changed {
        notify(&app);
    }
}

/// Opens a link from a note in the system's default browser (or mail app).
/// Only web and mail links: anything else could launch a local program.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !["http://", "https://", "mailto:"].iter().any(|s| lower.starts_with(s)) {
        return Err(format!("not a web or mail link: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
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
    } else if is_board(&window) {
        store.update_board(&board_id_of(&window), |b| b.pinned = pinned);
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
    let (dx, dy) = frame_offset(parent)?;
    let (px, py) = desk::inner_position(parent)?;
    let (pw, _) = desk::inner_size(parent)?;
    let monitor = desk::current_screen(parent)?;
    let scale = monitor.scale;
    let (ax, ay, aw, ah) = monitor.work;
    let gap = (SNAP_GAP * scale).round() as i32;
    // Work area inset by the snap gap: the new note doesn't touch the edge.
    let (left_edge, top_edge) = (ax + gap, ay + gap);
    let right_edge = ax + aw - gap;
    let bottom_edge = ay + ah - gap;

    let w = (DEFAULT_W * scale).round() as i32;
    let h = (DEFAULT_H * scale).round() as i32;
    let parent_right = px + pw;

    // Visible corner of the new note.
    let vx = if parent_right + gap + w <= right_edge {
        parent_right + gap
    } else if px - gap - w >= left_edge {
        px - gap - w
    } else if right_edge - parent_right >= px - left_edge {
        right_edge - w
    } else {
        left_edge
    };
    let vx = vx.max(left_edge);
    let vy = py.clamp(top_edge, (bottom_edge - h).max(top_edge));

    // Window corner (with the invisible borders), which is what gets positioned.
    let x = vx - dx;
    let max_y = (bottom_edge - h).max(top_edge) - dy;
    let mut y = vy - dy;

    // Several "+" in a row on the same note would all land on the same spot:
    // if a note is already there, step down (titlebar + slack) until a free
    // spot is found, so they all stay visible.
    let step = ((TITLEBAR_H + 8.0) * scale).round() as i32;
    let taken: Vec<(i32, i32)> = parent
        .app_handle()
        .webview_windows()
        .values()
        .filter(|w| is_app_window(w) && w.is_visible().unwrap_or(false))
        .filter_map(desk::outer_position)
        .collect();
    let occupied = |y: i32| {
        taken
            .iter()
            .any(|&(tx, ty)| (tx - x).abs() < step / 2 && (ty - y).abs() < step / 2)
    };
    while occupied(y) && y + step <= max_y {
        y += step;
    }
    Some((x, y))
}

/// Closes the note (✕ button or middle click): it stays among the current
/// ones and the manager reopens it. A note nobody touched (or a welcome copy)
/// goes the way `trash` sends it: deleted outright.
#[tauri::command]
async fn close_note(app: AppHandle, window: WebviewWindow) {
    close_note_by_id(&app, &id_of(&window));
}

fn close_note_by_id(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    match store.get(id) {
        Some(note) if note.welcome_copy || store.is_pristine(&note) => trash(app, id),
        Some(_) => {
            store.update(id, |n| n.hidden = true);
            store.flush();
            if let Some(window) = app.get_webview_window(&label_for(id)) {
                let _ = window.destroy();
            }
            notify(app);
        }
        None => {}
    }
}

// ---------------------------------------------------------------------------
// System colour picker
// ---------------------------------------------------------------------------

/// Called just before a page opens the system colour picker (chrome.js,
/// `MemoColorPicker`).
#[tauri::command]
fn place_color_picker() {
    place_color_dialog();
}

/// Moves the system colour dialog next to the mouse pointer (the swatch just
/// clicked). Windows opens it where the WebView2 browser process sees fit,
/// often far from the window that asked; the dialog belongs to that process,
/// so it is found by its owner: one of Memo's windows. Elsewhere the system
/// places its picker itself (GTK dialog, NSColorPanel), so nothing to do.
#[cfg(windows)]
fn place_color_dialog() {
    use std::{thread, time::Duration};
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, POINT, RECT},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        System::Threading::GetCurrentProcessId,
        UI::WindowsAndMessaging::{
            EnumWindows, GetAncestor, GetClassNameW, GetCursorPos, GetWindow, GetWindowRect,
            GetWindowThreadProcessId, IsWindowVisible, SetWindowPos, GA_ROOT, GW_OWNER,
            SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        },
    };

    // A visible "#32770" (dialog class) window owned by one of ours.
    unsafe extern "system" fn find(hwnd: HWND, found: LPARAM) -> i32 {
        // SAFETY: plain Win32 queries; `found` points at the caller's HWND.
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut class = [0u16; 16];
            let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            if String::from_utf16_lossy(&class[..len.max(0) as usize]) != "#32770" {
                return 1;
            }
            let owner = GetAncestor(GetWindow(hwnd, GW_OWNER), GA_ROOT);
            let mut pid = 0;
            GetWindowThreadProcessId(owner, &mut pid);
            if owner.is_null() || pid != GetCurrentProcessId() {
                return 1;
            }
            *(found as *mut HWND) = hwnd;
            0
        }
    }

    let mut cursor = POINT { x: 0, y: 0 };
    // SAFETY: writes into the local POINT.
    if unsafe { GetCursorPos(&mut cursor) } == 0 {
        return;
    }
    thread::spawn(move || {
        // The dialog shows up a moment after the click: look for it for 2 s.
        for _ in 0..80 {
            thread::sleep(Duration::from_millis(25));
            let mut dialog: HWND = std::ptr::null_mut();
            // SAFETY: `find` only writes the HWND it was given.
            unsafe { EnumWindows(Some(find), &mut dialog as *mut HWND as LPARAM) };
            if dialog.is_null() {
                continue;
            }
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            // SAFETY: plain Win32 calls on locals; a failed one leaves the
            // dialog where it is.
            unsafe {
                if GetWindowRect(dialog, &mut rect) == 0
                    || GetMonitorInfoW(
                        MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST),
                        &mut info,
                    ) == 0
                {
                    return;
                }
                // Below and to the right of the pointer, kept on its monitor.
                let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
                let area = info.rcWork;
                let x = (cursor.x - 16).min(area.right - w).max(area.left);
                let y = if cursor.y + 16 + h <= area.bottom {
                    cursor.y + 16
                } else {
                    cursor.y - 16 - h
                };
                let y = y.min(area.bottom - h).max(area.top);
                SetWindowPos(
                    dialog,
                    std::ptr::null_mut(),
                    x,
                    y,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            return;
        }
    });
}

#[cfg(not(windows))]
fn place_color_dialog() {}


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
    let store = app.state::<Shared>();
    let note = store.update(&id, |n| n.hidden = false).unwrap_or(note);
    // Inside a closed group: reopen it and take the whole group out.
    match store.group(&note.group_id) {
        Some(group) if group.hidden || !group.open => {
            if group.hidden {
                show_group(&app, &group.id);
            }
            take_out(&app, &group.id);
        }
        _ => {
            open_note_window(&app, &note).map_err(|e| e.to_string())?;
        }
    }
    notify(&app);
    Ok(())
}

/// Opens a note from a board. The note opens on desktop and, when clicked outside
/// (loses focus), returns back to the board (closes from desktop).
#[tauri::command]
async fn open_board_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .get(&id)
        .filter(|n| n.trashed_at.is_none())
        .ok_or("note not found")?;
    mark_board_transient(&id);
    let store = app.state::<Shared>();
    let note = store.update(&id, |n| n.hidden = false).unwrap_or(note);
    let window = open_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    notify(&app);
    Ok(())
}

/// Takes a note out of any board: removes it from all boards, marks hidden=false,
/// and opens it on desktop at (screen_x, screen_y) if supplied.
#[tauri::command]
async fn take_note_out_of_board(
    app: AppHandle,
    id: String,
    screen_x: Option<i32>,
    screen_y: Option<i32>,
    store: State<'_, Shared>,
) -> Result<(), String> {
    take_board_transient(&id);
    store.remove_note_from_boards(&id);
    let note = store.update(&id, |n| {
        n.hidden = false;
        if let (Some(sx), Some(sy)) = (screen_x, screen_y) {
            n.x = Some(sx);
            n.y = Some(sy);
        }
    }).ok_or_else(|| "note not found".to_string())?;
    store.flush();
    let window = open_note_window(&app, &note).map_err(|e| e.to_string())?;
    if let (Some(sx), Some(sy)) = (screen_x, screen_y) {
        desk::set_position(&window, sx, sy);
    }
    let _ = window.show();
    let _ = window.set_focus();
    boards_changed(&app);
    notify(&app);
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
        .update(&id, |n| {
            n.trashed_at = None;
            n.hidden = false;
        })
        .ok_or("note not found")?;
    // Its group is in the trash: the note comes back ungrouped.
    let note = match store.group(&note.group_id) {
        Some(group) if group.trashed_at.is_some() => {
            store.update(&id, |n| n.group_id.clear()).unwrap_or(note)
        }
        _ => note,
    };
    if store
        .group(&note.group_id)
        .map_or(true, |g| g.open && !g.hidden)
    {
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

/// Global zoom, for the Settings control.
#[tauri::command]
fn get_zoom(store: State<'_, Shared>) -> f64 {
    store.zoom()
}

/// Steps the global zoom (`step` × 10%, `0` = back to 100%) and applies it
/// to every window: Settings' − / + / reset, Mod + / Mod − / Mod 0 and
/// Mod + wheel in any window. Group bars, a titlebar tall, grow with it.
/// Returns the new zoom; emits "zoom-changed".
#[tauri::command]
fn change_zoom(app: AppHandle, step: i32) -> f64 {
    let store = app.state::<Shared>();
    let zoom = if step == 0 {
        1.0
    } else {
        ((store.zoom() + step as f64 * ZOOM_STEP) * 10.0).round() / 10.0
    };
    store.set_zoom(zoom);
    let zoom = store.zoom();
    for window in app.webview_windows().values().filter(|w| is_app_window(w)) {
        let _ = window.set_zoom(zoom);
        if is_group(window) {
            if let Some(group) = store.group(&group_id_of(window)) {
                let _ = window.set_min_size(Some(tauri::LogicalSize::new(
                    GROUP_MIN_W,
                    TITLEBAR_H * zoom,
                )));
                set_logical_size(window, group.width, TITLEBAR_H * zoom);
            }
        }
    }
    let _ = app.emit("zoom-changed", zoom);
    zoom
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
    let (title, text, html) = store.new_note_defaults();
    (title, text, store.inline_images(&html))
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
    if color != RANDOM_COLOR && !is_valid_color(&color) {
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
    let html = store.store_images(&html).chars().take(DEFAULT_TEXT_MAX * 10).collect();
    store.set_default_content(text, html);
}

#[tauri::command]
fn set_default_color(
    app: AppHandle,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if color != RANDOM_COLOR && !is_valid_color(&color) {
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
            desk::set_position(&window, x, y);
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
        .inner_size(group.width, TITLEBAR_H * app.state::<Shared>().zoom())
        .min_inner_size(GROUP_MIN_W, TITLEBAR_H * app.state::<Shared>().zoom())
        .decorations(false)
        // GTK sizes a non-resizable window to its content's natural size,
        // which for a webview is at least 200 px tall: on Linux the bar would
        // be a tall block instead of a titlebar.
        .resizable(cfg!(target_os = "linux"))
        .always_on_top(group.pinned)
        .background_color(CARBON)
        // macOS: the first click on an inactive window reaches the page, so
        // the titlebar drags (and buttons work) without a focusing click first.
        .accept_first_mouse(true)
        .visible(false)
        .build()?;
    match (group.x, group.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            desk::set_position(&window, x, y);
            // On another monitor's scale (see `build_note_window`).
            let zoom = app.state::<Shared>().zoom();
            set_logical_size(&window, group.width, TITLEBAR_H * zoom);
        }
        _ => {
            let _ = window.center();
        }
    }
    apply_theme(&window, &app.state::<Shared>().theme());
    track_geometry(app, &window);
    let _ = window.set_zoom(app.state::<Shared>().zoom());
    window.show()?;
    // Sized after show: on Windows calling set_size while hidden makes Tao
    // calculate a bogus non-client height offset and stretch the bar.
    let zoom = app.state::<Shared>().zoom();
    set_logical_size(&window, group.width, TITLEBAR_H * zoom);
    Ok(window)
}

/// Where notes come out of / go into: the group bar's outer corner.
fn group_anchor(app: &AppHandle, id: &str) -> Option<(i32, i32)> {
    if let Some(p) = app
        .get_webview_window(&group_label(id))
        .and_then(|w| desk::outer_position(&w))
    {
        return Some(p);
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
        // Taking out shows all of them, those closed with ✕ too.
        let note = store.update(&note.id, |n| n.hidden = false).unwrap_or(note);
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
        // The saved place (where `build_note_window` put it): a hidden window
        // reports (0, 0) as its position on Linux until it is mapped.
        let target = match (note.x, note.y) {
            (Some(x), Some(y)) if is_on_screen(&window, x, y) => Ok((x, y)),
            _ => desk::outer_position(&window).ok_or(()),
        };
        match (anchor, target) {
            (Some(from), Ok(to)) => {
                desk::set_position(&window, from.0, from.1);
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
    for board in store.board_members(id) {
        let board = store.update_board(&board.id, |b| b.hidden = false).unwrap_or(board);
        let label = board_label(&board.id);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        app.state::<Sliding>()
            .0
            .lock()
            .unwrap()
            .insert(label.clone());
        let Ok(window) = build_board_window(app, &board) else {
            app.state::<Sliding>().0.lock().unwrap().remove(&label);
            continue;
        };
        let target = match (board.x, board.y) {
            (Some(x), Some(y)) if is_on_screen(&window, x, y) => Ok((x, y)),
            _ => desk::outer_position(&window).ok_or(()),
        };
        match (anchor, target) {
            (Some(from), Ok(to)) => {
                desk::set_position(&window, from.0, from.1);
                let _ = window.show();
                let app = app.clone();
                slide(window, from, to, move |w| {
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
    boards_changed(app);
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
    for board in store.board_members(id) {
        if let Some(window) = app.get_webview_window(&board_label(&board.id)) {
            slide_in(app, window, anchor);
        }
    }
    groups_changed(app);
    boards_changed(app);
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
    match (anchor, desk::outer_position(&window)) {
        (Some(to), Some(from)) => slide(window, from, to, |w| {
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
        if group.hidden {
            let _ = window.destroy();
        } else if !group.open {
            slide_in(app, window, group_anchor(app, group_id));
        } else if let (Some(to), Some(from)) = (back_to, desk::outer_position(&window)) {
            slide(window, from, to, |_| {});
        }
    }
    groups_changed(app);
    notify(app);
}

/// Takes a note out of its group; a note that was inside a closed group
/// comes out on screen.
fn leave_group(app: &AppHandle, note_id: &str) {
    let store = app.state::<Shared>();
    let Some(note) = store.update(note_id, |n| {
        n.group_id.clear();
        n.hidden = false;
    }) else {
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

fn join_board_to_group(app: &AppHandle, board_id: &str, group_id: &str, back_to: Option<(i32, i32)>) {
    let store = app.state::<Shared>();
    let Some(group) = store.group(group_id) else {
        return;
    };
    store.update_board(board_id, |b| b.group_id = group_id.to_string());
    store.flush();
    if let Some(window) = app.get_webview_window(&board_label(board_id)) {
        if group.hidden {
            let _ = window.destroy();
        } else if !group.open {
            slide_in(app, window, group_anchor(app, group_id));
        } else if let (Some(to), Some(from)) = (back_to, desk::outer_position(&window)) {
            slide(window, from, to, |_| {});
        }
    }
    boards_changed(app);
    groups_changed(app);
    notify(app);
}

fn leave_board_group(app: &AppHandle, board_id: &str) {
    let store = app.state::<Shared>();
    let Some(board) = store.update_board(board_id, |b| {
        b.group_id.clear();
        b.hidden = false;
    }) else {
        return;
    };
    store.flush();
    if board.trashed_at.is_none() && app.get_webview_window(&board_label(board_id)).is_none() {
        let _ = open_board_window(app, &board);
    }
    boards_changed(app);
    groups_changed(app);
    notify(app);
}

fn assign_board_group(app: &AppHandle, board_id: &str, group_id: &str, anchor: &WebviewWindow) {
    match group_id {
        "" => leave_board_group(app, board_id),
        "new" => {
            let group = app.state::<Shared>().create_group(beside(anchor));
            let _ = open_group_window(app, &group);
            join_board_to_group(app, board_id, &group.id, None);
        }
        id => join_board_to_group(app, board_id, id, None),
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

/// The calling board's group id ("" = none).
#[tauri::command]
fn get_board_group(window: WebviewWindow, store: State<'_, Shared>) -> String {
    store
        .board(&board_id_of(&window))
        .map(|b| b.group_id)
        .unwrap_or_default()
}

/// Picker of a board: moves it to `group_id` ("" = none, "new").
#[tauri::command]
async fn set_board_group(app: AppHandle, window: WebviewWindow, group_id: String) {
    let id = board_id_of(&window);
    assign_board_group(&app, &id, &group_id, &window);
}

/// Manager list: moves board `id` to `group_id` ("" = none, "new").
#[tauri::command]
async fn move_board_to_group(app: AppHandle, window: WebviewWindow, id: String, group_id: String) {
    assign_board_group(&app, &id, &group_id, &window);
}

/// The calling group bar's data and how many notes & boards it holds.
#[tauri::command]
fn load_group(window: WebviewWindow, store: State<'_, Shared>) -> Option<(Group, usize)> {
    let id = group_id_of(&window);
    let group = store.group(&id)?;
    Some((group, store.members(&id).len() + store.board_members(&id).len()))
}

/// Renames the calling group (empty = unnamed, as for notes). Returns the
/// name as saved.
#[tauri::command]
fn rename_group(app: AppHandle, window: WebviewWindow, name: String) -> String {
    rename_group_by_id(&app, &group_id_of(&window), &name)
}

fn rename_group_by_id(app: &AppHandle, id: &str, name: &str) -> String {
    let store = app.state::<Shared>();
    let name: String = name.trim().chars().take(GROUP_NAME_MAX).collect();
    let group = store.update_group(id, |g| g.name = name.clone());
    let saved = group.map(|g| g.name).unwrap_or_default();
    if let Some(window) = app.get_webview_window(&group_label(id)) {
        let _ = window.set_title(group_title(&saved));
    }
    groups_changed(app);
    notify(app);
    saved
}

/// Colour of the manager window (same labels as notes and groups).
#[tauri::command]
fn set_manager_color(color: String, store: State<'_, Shared>) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("unknown color: {color}"));
    }
    store.update_manager(|m| m.color = color);
    Ok(())
}

/// Settings → Appearance → Layout: the Memories and Groups tabs as cards or
/// as a list (also in the tray menu).
#[tauri::command]
fn set_manager_layout(app: AppHandle, layout: String) -> Result<(), String> {
    if !LAYOUTS.contains(&layout.as_str()) {
        return Err(format!("unknown layout: {layout}"));
    }
    set_layout(&app, &layout);
    Ok(())
}

/// Saves the manager's layout; the manager and the tray follow.
fn set_layout(app: &AppHandle, layout: &str) {
    let store = app.state::<Shared>();
    store.update_manager(|m| m.layout = layout.to_string());
    store.flush();
    let _ = app.emit("layout-changed", layout);
    refresh_tray(app);
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
/// window grows to `height` (CSS pixels, scaled by the zoom), then shrinks
/// back. Not saved — a group's height is always a titlebar.
#[tauri::command]
fn set_group_height(window: WebviewWindow, height: f64) -> Result<(), String> {
    let zoom = window.state::<Shared>().zoom();
    let scale = scale_of(&window);
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let height = ((height * zoom).max(TITLEBAR_H * zoom) * scale).round() as u32;
    window
        .set_size(PhysicalSize::new(size.width, height))
        .map_err(|e| e.to_string())
}

/// Double-click on the bar: takes the notes out, or puts them back in.
#[tauri::command]
async fn toggle_group(app: AppHandle, window: WebviewWindow) {
    toggle_group_by_id(&app, &group_id_of(&window));
}

/// Manager's Groups tab: shows group `id`'s bar and brings it to the front,
/// with its notes if the group is out.
#[tauri::command]
async fn focus_group(app: AppHandle, id: String) -> Result<(), String> {
    let group = app
        .state::<Shared>()
        .group(&id)
        .filter(|g| g.trashed_at.is_none())
        .ok_or("group not found")?;
    if group.hidden {
        show_group(&app, &id);
    }
    let group = app.state::<Shared>().group(&id).unwrap_or(group);
    open_group_window(&app, &group).map_err(|e| e.to_string())?;
    raise_group(&app, &id);
    Ok(())
}

/// A click on a group bar: brings the group's notes to the front with it.
#[tauri::command]
async fn show_group_notes(app: AppHandle, window: WebviewWindow) {
    raise_group(&app, &group_id_of(&window));
}

/// Brings group `id`'s bar to the front and, if the group is out, all its
/// notes with it (those closed with ✕ open again, as when taking them out).
/// The bar is focused last, so it stays on top and keeps the keyboard.
fn raise_group(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    let Some(group) = store.group(id) else {
        return;
    };
    if group.open {
        let closed = store
            .members(id)
            .iter()
            .any(|n| app.get_webview_window(&label_for(&n.id)).is_none())
            || store
                .board_members(id)
                .iter()
                .any(|b| app.get_webview_window(&board_label(&b.id)).is_none());
        if closed {
            take_out(app, id);
        }
        for note in store.members(id) {
            if let Some(window) = app.get_webview_window(&label_for(&note.id)) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        for board in store.board_members(id) {
            if let Some(window) = app.get_webview_window(&board_label(&board.id)) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
    if let Some(bar) = app.get_webview_window(&group_label(id)) {
        let _ = bar.unminimize();
        let _ = bar.set_focus();
    }
}

/// Reopens a group closed with ✕: its bar, and its notes if it is out.
fn show_group(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    let Some(group) = store.update_group(id, |g| g.hidden = false) else {
        return;
    };
    let _ = open_group_window(app, &group);
    if group.open {
        for note in store.members(id).iter().filter(|n| !n.hidden) {
            let _ = open_note_window(app, note);
        }
        for board in store.board_members(id).iter().filter(|b| !b.hidden) {
            let _ = open_board_window(app, board);
        }
    }
    store.flush();
    groups_changed(app);
    boards_changed(app);
    notify(app);
}

/// ✕ or middle click on a group bar: closes the bar and its notes' windows.
/// The group stays among the current ones and the manager reopens it; a
/// group nobody touched is just removed (`Store::is_pristine_group`).
#[tauri::command]
async fn close_group(app: AppHandle, window: WebviewWindow) {
    let id = group_id_of(&window);
    let store = app.state::<Shared>();
    if store.is_pristine_group(&id) {
        store.remove_group(&id);
    } else {
        store.update_group(&id, |g| g.hidden = true);
        for note in store.members(&id) {
            if let Some(note_window) = app.get_webview_window(&label_for(&note.id)) {
                let _ = note_window.destroy();
            }
        }
        for board in store.board_members(&id) {
            if let Some(w) = app.get_webview_window(&board_label(&board.id)) {
                let _ = w.destroy();
            }
        }
    }
    store.flush();
    let _ = window.destroy();
    groups_changed(&app);
    boards_changed(&app);
    notify(&app);
}

/// Manager's Groups tab: takes group `id`'s notes out, or puts them in.
#[tauri::command]
async fn toggle_group_id(app: AppHandle, id: String) {
    toggle_group_by_id(&app, &id);
}

fn toggle_group_by_id(app: &AppHandle, id: &str) {
    match app.state::<Shared>().group(id) {
        Some(group) if group.open => put_in(app, id),
        Some(_) => take_out(app, id),
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

/// Manager's Groups tab: sends group `id` to the trash, with its notes.
#[tauri::command]
async fn trash_group_id(app: AppHandle, id: String) {
    trash_group_by_id(&app, &id);
}

/// A group nobody touched is removed outright (`Store::is_pristine_group`).
/// Otherwise the group
/// is marked trashed first, so its notes (trashed right after)
/// have a later `trashed_at`: that is how `restore_group` finds the notes
/// that went to the trash with it.
fn trash_group_by_id(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    let members = store.members(id);
    let board_members = store.board_members(id);
    // Like a blank note: a group nobody touched is just removed.
    if store.is_pristine_group(id) {
        store.remove_group(id);
    } else {
        store.update_group(id, |g| g.trashed_at = Some(now_ms()));
        for note in members {
            trash(app, &note.id);
        }
        for board in board_members {
            let _ = trash_board_id(app.clone(), board.id.clone(), store.clone());
        }
    }
    store.flush();
    if let Some(window) = app.get_webview_window(&group_label(id)) {
        let _ = window.destroy();
    }
    groups_changed(app);
    boards_changed(app);
    notify(app);
}

/// Manager's Groups trash: brings group `id` back with the notes that went to
/// the trash with it; its bar opens, and its notes too if it is open.
#[tauri::command]
async fn restore_group(app: AppHandle, id: String) -> Result<(), String> {
    let store = app.state::<Shared>();
    let since = store
        .group(&id)
        .and_then(|g| g.trashed_at)
        .ok_or("group not in the trash")?;
    let group = store
        .update_group(&id, |g| {
            g.trashed_at = None;
            g.hidden = false;
        })
        .ok_or("group not found")?;
    let together: Vec<String> = store
        .all()
        .into_iter()
        .filter(|n| n.group_id == id && n.trashed_at.is_some_and(|t| t >= since))
        .map(|n| n.id)
        .collect();
    for note_id in together {
        if let Some(note) = store.update(&note_id, |n| {
            n.trashed_at = None;
            n.hidden = false;
        }) {
            if group.open {
                let _ = open_note_window(&app, &note);
            }
        }
    }
    let together_boards: Vec<String> = store
        .boards()
        .into_iter()
        .filter(|b| b.group_id == id && b.trashed_at.is_some_and(|t| t >= since))
        .map(|b| b.id)
        .collect();
    for board_id in together_boards {
        if let Some(board) = store.update_board(&board_id, |b| {
            b.trashed_at = None;
            b.hidden = false;
        }) {
            if group.open {
                let _ = open_board_window(&app, &board);
            }
        }
    }
    store.flush();
    open_group_window(&app, &group).map_err(|e| e.to_string())?;
    groups_changed(&app);
    boards_changed(&app);
    notify(&app);
    Ok(())
}

/// Manager's Groups trash: permanently deletes group `id` (its notes stay in
/// the memories' trash, ungrouped).
#[tauri::command]
fn delete_group_forever(app: AppHandle, id: String, store: State<'_, Shared>) {
    if store.group(&id).is_some_and(|g| g.trashed_at.is_some()) {
        store.remove_group(&id);
        store.flush();
        groups_changed(&app);
        notify(&app);
    }
}

/// Manager's Groups trash: "Empty trash".
#[tauri::command]
fn empty_group_trash(app: AppHandle, store: State<'_, Shared>) {
    store.empty_group_trash();
    store.flush();
    groups_changed(&app);
    notify(&app);
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

fn board_title(name: &str) -> &str {
    if name.trim().is_empty() {
        "Memo"
    } else {
        name
    }
}

fn build_board_window(app: &AppHandle, board: &Board) -> tauri::Result<WebviewWindow> {
    let label = board_label(&board.id);
    let store = app.state::<Shared>();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("board.html".into()))
        .title(board_title(&board.name))
        .inner_size(board.width, board.height)
        .min_inner_size(BOARD_MIN_W, BOARD_MIN_H)
        .decorations(false)
        .resizable(false)
        .always_on_top(board.pinned)
        .background_color(CARBON)
        .accept_first_mouse(true)
        .visible(false)
        .drag_and_drop(false)
        .build()?;
    match (board.x, board.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            desk::set_position(&window, x, y);
            set_logical_size(&window, board.width, board.height);
        }
        _ => {
            let _ = window.center();
        }
    }
    apply_theme(&window, &store.theme());
    track_geometry(app, &window);
    let _ = window.set_zoom(store.zoom());
    Ok(window)
}

fn open_board_window(app: &AppHandle, board: &Board) -> tauri::Result<WebviewWindow> {
    let label = board_label(&board.id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }
    let window = build_board_window(app, board)?;
    window.show()?;
    let _ = window.set_focus();
    Ok(window)
}

#[tauri::command]
async fn new_board(app: AppHandle, store: State<'_, Shared>) -> Result<Board, String> {
    let lang = store.effective_language();
    let default_cols = if lang == "en" {
        vec!["To Do".into(), "In Progress".into(), "Done".into()]
    } else {
        vec!["A Fazer".into(), "Em Andamento".into(), "Concluído".into()]
    };
    let board = store.create_board(None, default_cols, None);
    open_board_window(&app, &board).map_err(|e| e.to_string())?;
    boards_changed(&app);
    Ok(board)
}

#[tauri::command]
async fn open_board(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    let board = store.board(&id).ok_or_else(|| "board not found".to_string())?;
    store.update_board(&id, |b| b.hidden = false);
    open_board_window(&app, &board).map_err(|e| e.to_string())?;
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
fn load_board(window: WebviewWindow, store: State<'_, Shared>) -> Result<Option<Board>, String> {
    Ok(store.board(&board_id_of(&window)))
}

#[tauri::command]
fn save_board_columns(
    app: AppHandle,
    window: WebviewWindow,
    columns: Vec<BoardColumn>,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let id = board_id_of(&window);
    store.update_board(&id, |b| b.columns = columns);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
fn rename_board(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    store: State<'_, Shared>,
) -> Result<String, String> {
    let id = board_id_of(&window);
    let clean = name.trim().chars().take(BOARD_NAME_MAX).collect::<String>();
    store.update_board(&id, |b| b.name = clean.clone());
    let _ = window.set_title(board_title(&clean));
    boards_changed(&app);
    Ok(clean)
}

#[tauri::command]
fn set_board_color(
    app: AppHandle,
    window: WebviewWindow,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("unknown color: {color}"));
    }
    let id = board_id_of(&window);
    store.update_board(&id, |b| b.color = color);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
async fn close_board(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let id = board_id_of(&window);
    if store.is_pristine_board(&id) {
        store.remove_board(&id);
    } else {
        store.update_board(&id, |b| b.hidden = true);
    }
    let _ = window.destroy();
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
fn list_boards(store: State<'_, Shared>) -> Result<Vec<Board>, String> {
    Ok(store.boards())
}

#[tauri::command]
fn trash_board_id(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&board_label(&id)) {
        let _ = w.destroy();
    }
    store.trash_board(&id);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
fn restore_board_id(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    store.restore_board(&id);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
fn delete_board_forever(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&board_label(&id)) {
        let _ = w.destroy();
    }
    store.remove_board(&id);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
fn update_board_drop_zones(
    window: WebviewWindow,
    zones: Vec<ColumnBounds>,
    drags: State<'_, Drags>,
) {
    let bid = board_id_of(&window);
    drags.board_columns.lock().unwrap().insert(bid, zones);
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
    let mut config = Config::load(&default.join(CONFIG));
    config.data_dir = (dir != default).then(|| dir.clone());
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
    for group in store.active_groups().iter().filter(|g| !g.hidden) {
        let _ = open_group_window(app, group);
    }
    for note in store.visible() {
        let _ = open_note_window(app, &note);
    }
    let theme = store.theme();
    for window in app.webview_windows().values().filter(|w| is_app_window(w)) {
        apply_theme(window, &theme);
    }
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let _ = manager.set_title(manager_title(store.effective_language()));
    }
    refresh_tray(app);
    let _ = app.emit("store-replaced", ());
}

/// Folder where the notes are saved and whether it is the default one.
/// Start with the system, set up once: on Windows the installer asked
/// (windows/hooks.nsh); on macOS and Linux, which have no installer step for
/// it, it is turned on by the first run of a release build.
fn init_autostart(app: &AppHandle, default_dir: &Path) {
    use tauri_plugin_autostart::ManagerExt;
    let path = default_dir.join(CONFIG);
    let mut config = Config::load(&path);
    if config.autostart_init {
        return;
    }
    if cfg!(not(windows)) && !cfg!(debug_assertions) {
        let _ = app.autolaunch().enable();
    }
    config.autostart_init = true;
    let _ = config.save(&path);
}

/// Configurações → "Start with the system".
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if on {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|e| e.to_string())?;
    refresh_tray(&app);
    manager.is_enabled().map_err(|e| e.to_string())
}

/// Settings → Magnet: whether windows stick to screen edges and to each
/// other while dragged or resized (and notes fold onto their titlebar).
#[tauri::command]
fn get_magnet(store: State<'_, Shared>) -> bool {
    store.magnet()
}

#[tauri::command]
fn set_magnet(app: AppHandle, on: bool) -> bool {
    toggle_magnet(&app, on);
    on
}

/// Turns the magnet on or off (Settings switch or tray item); the manager's
/// switch and the tray follow.
fn toggle_magnet(app: &AppHandle, on: bool) {
    let store = app.state::<Shared>();
    store.set_magnet(on);
    store.flush();
    let _ = app.emit("magnet-changed", on);
    refresh_tray(app);
}

/// Settings → AI control: whether it is on, and the executable MCP clients
/// launch (`<path> --mcp`), for the setup snippets.
#[tauri::command]
fn get_ai_control(app: AppHandle) -> Result<(bool, String), String> {
    let dir = default_data_dir(&app).map_err(|e| e.to_string())?;
    Ok((mcp::enabled(&dir), ai_exe()))
}

/// Settings → AI control: the MCP clients installed here and whether each
/// one has Memo.
#[tauri::command]
fn get_ai_clients() -> Vec<clients::Status> {
    clients::list(&ai_exe())
}

/// Adds Memo to MCP client `id` (or removes it); returns the new list.
#[tauri::command]
fn connect_ai_client(id: String, on: bool) -> Result<Vec<clients::Status>, String> {
    let exe = ai_exe();
    if exe.is_empty() {
        return Err("no executable path".into());
    }
    clients::connect(&id, &exe, on)?;
    Ok(clients::list(&exe))
}

fn ai_exe() -> String {
    mcp::app_path().map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
fn set_ai_control(app: AppHandle, on: bool) -> Result<bool, String> {
    toggle_ai_control(&app, on)?;
    Ok(on)
}

/// Turns AI control on or off (Settings switch or tray item); the manager's
/// switch and the tray follow.
fn toggle_ai_control(app: &AppHandle, on: bool) -> Result<(), String> {
    let dir = default_data_dir(app).map_err(|e| e.to_string())?;
    mcp::set_enabled(app, &dir, on)?;
    let _ = app.emit("ai-control-changed", on);
    refresh_tray(app);
    Ok(())
}

/// Settings → Updates: whether automatic checks are on, and the update
/// status (`updater::Status`).
#[tauri::command]
fn get_updates(app: AppHandle) -> (bool, updater::Status) {
    (updater::auto_enabled(&app), updater::status())
}

#[tauri::command]
fn set_auto_update(app: AppHandle, on: bool) -> Result<bool, String> {
    updater::set_auto(&app, on)?;
    Ok(on)
}

/// "Check for updates": the answer comes as `update-changed`.
#[tauri::command]
async fn check_update(app: AppHandle) {
    updater::check(&app, true).await;
}

/// Downloads and installs the update found, then restarts Memo.
#[tauri::command]
async fn install_update(app: AppHandle) {
    updater::install(&app).await;
}

/// Configurações → Sincronização: whether this build can connect a Google
/// account, the one connected on this computer and how syncing goes.
#[tauri::command]
fn get_cloud_account(app: AppHandle) -> (bool, Option<String>, sync::Status) {
    (cloud::available(), cloud_account(&app), sync::status())
}

/// The Google account connected on this computer, if this build can sync.
fn cloud_account(app: &AppHandle) -> Option<String> {
    if !cloud::available() {
        return None;
    }
    let dir = default_data_dir(app).ok()?;
    Config::load(&dir.join(CONFIG)).google_account
}

/// "Sync now".
#[tauri::command]
fn sync_cloud(app: AppHandle) {
    sync::sync_now(&app);
}

/// Signs in with Google in the browser and remembers the account. Errors are
/// `cloud::ERR_*` codes the page translates.
#[tauri::command]
async fn connect_cloud(app: AppHandle) -> Result<String, String> {
    let lang = app.state::<Shared>().effective_language();
    let email = cloud::sign_in(&app, lang).await?;
    let path = default_data_dir(&app).map_err(|e| e.to_string())?.join(CONFIG);
    let mut config = Config::load(&path);
    config.google_account = Some(email.clone());
    config.save(&path).map_err(|e| e.to_string())?;
    sync::on_connected(&app);
    let _ = app.emit("cloud-changed", ());
    refresh_tray(&app);
    Ok(email)
}

/// Stops a sign-in still waiting for the browser.
#[tauri::command]
fn cancel_cloud_connect() {
    cloud::cancel_sign_in();
}

/// Forgets the Google account on this computer; the memories stay here.
#[tauri::command]
fn disconnect_cloud(app: AppHandle) -> Result<(), String> {
    cloud::sign_out();
    let path = default_data_dir(&app).map_err(|e| e.to_string())?.join(CONFIG);
    let mut config = Config::load(&path);
    config.google_account = None;
    config.save(&path).map_err(|e| e.to_string())?;
    sync::reset(&app);
    let _ = app.emit("cloud-changed", ());
    refresh_tray(&app);
    Ok(())
}

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

/// Tray menu: the app's commands that make sense without a window (creating,
/// showing, the manager's tabs, appearance, sync) and "Quit". Rebuilt by
/// `refresh_tray` whenever a checked item or a label changes.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let items = app_menu_items(app, "")?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    Menu::with_items(app, &refs)
}

/// The app's commands, as in the tray menu: also the bottom part of every
/// titlebar menu (`show_title_menu`), with the item ids behind `prefix`.
fn app_menu_items(app: &AppHandle, prefix: &str) -> tauri::Result<Vec<MenuItemKind<tauri::Wry>>> {
    let store = app.state::<Shared>();
    let l = tray_labels(store.effective_language());
    let id = |id: &str| format!("{prefix}{id}");
    let item = |key: &str, text: &str| MenuItem::with_id(app, id(key), text, true, None::<&str>);
    let check = |key: &str, text: &str, on: bool| CheckMenuItem::with_id(app, id(key), text, true, on, None::<&str>);

    let theme = store.theme();
    let theme_menu = Submenu::with_items(
        app,
        l.theme,
        true,
        &[
            &check("theme:system", l.system, theme == "system")?,
            &check("theme:light", l.light, theme == "light")?,
            &check("theme:dark", l.dark, theme == "dark")?,
        ],
    )?;
    // Language names stay in their own language, as in Settings.
    let language = store.language();
    let language_menu = Submenu::with_items(
        app,
        l.language,
        true,
        &[
            &check("language:system", l.system, language == "system")?,
            &check("language:pt-BR", "Português", language == "pt-BR")?,
            &check("language:en", "English", language == "en")?,
        ],
    )?;
    let layout = store.manager_layout();
    let layout_menu = Submenu::with_items(
        app,
        l.layout,
        true,
        &[
            &check("layout:cards", l.cards, layout == "cards")?,
            &check("layout:list", l.list, layout == "list")?,
        ],
    )?;
    let autostart = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled()
    };
    let autostart_item = CheckMenuItem::with_id(
        app,
        id("autostart"),
        l.autostart,
        autostart.is_ok(),
        autostart.unwrap_or(false),
        None::<&str>,
    )?;

    let ai_control = default_data_dir(app).is_ok_and(|dir| mcp::enabled(&dir));
    let separator = || PredefinedMenuItem::separator(app).map(|s| s.kind());
    let mut items = vec![
        item("new", l.new_note)?.kind(),
        item("new-group", l.new_group)?.kind(),
        item("new-board", l.new_board)?.kind(),
        item("show", l.show)?.kind(),
        separator()?,
        item("manager", l.manager)?.kind(),
        item("trash", l.trash)?.kind(),
        item("settings", l.settings)?.kind(),
        item("help", l.help)?.kind(),
        separator()?,
        theme_menu.kind(),
        language_menu.kind(),
        layout_menu.kind(),
        autostart_item.kind(),
        check("magnet", l.magnet, store.magnet())?.kind(),
        check("ai-control", l.ai_control, ai_control)?.kind(),
    ];
    // "Sync now" only with a Google account connected on this computer.
    if cloud_account(app).is_some() {
        items.push(item("sync", l.sync)?.kind());
    }
    items.push(separator()?);
    // A newer version found (updater.rs) replaces "Check for updates".
    items.push(
        match updater::status().available {
            Some(version) => item("update", &format!("{} {version}", l.update_to))?,
            None => item("check-updates", l.check_updates)?,
        }
        .kind(),
    );
    // The running version, greyed out: shows at a glance which build is open.
    items.push(
        MenuItem::with_id(
            app,
            id("version"),
            format!("Memo {}", app.package_info().version),
            false,
            None::<&str>,
        )?
        .kind(),
    );
    items.push(item("quit", l.quit)?.kind());
    Ok(items)
}

/// One of a window's own commands in its titlebar menu (`null` in JS = a
/// separator). `checked` makes it a check item (pin); `items` a submenu
/// (a note's "Format").
#[derive(serde::Deserialize)]
struct TitleMenuItem {
    id: String,
    label: String,
    checked: Option<bool>,
    items: Option<Vec<Option<TitleMenuItem>>>,
}

/// The native entry for a `TitleMenuItem` (recursive for submenus), with
/// its id behind `prefix`.
fn title_menu_entry(app: &AppHandle, prefix: &str, item: Option<TitleMenuItem>) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    Ok(match item {
        None => PredefinedMenuItem::separator(app)?.kind(),
        Some(TitleMenuItem { id, label, items: Some(items), .. }) => {
            let sub = Submenu::with_id(app, format!("{prefix}own:{id}"), label, true)?;
            for item in items {
                sub.append(&title_menu_entry(app, prefix, item)?)?;
            }
            sub.kind()
        }
        Some(TitleMenuItem { id, label, checked: Some(on), .. }) => {
            CheckMenuItem::with_id(app, format!("{prefix}own:{id}"), label, true, on, None::<&str>)?.kind()
        }
        Some(TitleMenuItem { id, label, .. }) => {
            MenuItem::with_id(app, format!("{prefix}own:{id}"), label, true, None::<&str>)?.kind()
        }
    })
}

/// Right click on a titlebar, or its "…" button: a native menu with the
/// window's own commands on top and all the app's commands (the tray menu's)
/// below, so any window reaches every command. Native, so it is never cut
/// by a small window. `at` is the button's bottom-left corner (CSS pixels);
/// without it the menu opens at the pointer. Clicks come back in
/// `on_tray_menu` as `win:<label>:<id>`.
#[tauri::command]
async fn show_title_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<Option<TitleMenuItem>>,
    at: Option<(f64, f64)>,
) -> Result<(), String> {
    let prefix = format!("win:{}:", window.label());
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    let mut own = Vec::new();
    for item in items {
        own.push(title_menu_entry(&app, &prefix, item).map_err(|e| e.to_string())?);
    }
    if !own.is_empty() {
        own.push(PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?.kind());
    }
    own.extend(app_menu_items(&app, &prefix).map_err(|e| e.to_string())?);
    for item in &own {
        menu.append(item).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    set_menu_theme(&app.state::<Shared>().theme());
    match at {
        Some((x, y)) => {
            let zoom = app.state::<Shared>().zoom();
            window.popup_menu_at(&menu, LogicalPosition::new(x * zoom, y * zoom))
        }
        None => window.popup_menu(&menu),
    }
    .map_err(|e| e.to_string())
}

/// Windows draws popup menus light or dark from the process-wide "preferred
/// app mode", not from the window's theme: set it to Memo's theme before a
/// titlebar menu opens. uxtheme's SetPreferredAppMode (ordinal 135) and
/// FlushMenuThemes (136) are undocumented but stable since Windows 10 1903.
#[cfg(windows)]
fn set_menu_theme(theme: &str) {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    // 1 = follow the system, 2 = force dark, 3 = force light.
    let mode: i32 = match theme {
        "dark" => 2,
        "light" => 3,
        _ => 1,
    };
    let name: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
    unsafe {
        let lib = LoadLibraryW(name.as_ptr());
        if lib.is_null() {
            return;
        }
        if let Some(set) = GetProcAddress(lib, 135 as *const u8) {
            let set: unsafe extern "system" fn(i32) -> i32 = std::mem::transmute(set);
            set(mode);
        }
        if let Some(flush) = GetProcAddress(lib, 136 as *const u8) {
            let flush: unsafe extern "system" fn() = std::mem::transmute(flush);
            flush();
        }
    }
}

/// A click in a titlebar menu (`show_title_menu`), from window `label`: its
/// own commands go back to the window ("title-menu" event); new memories and
/// groups open beside it, as with its buttons; the rest is the tray's.
fn on_title_menu(app: &AppHandle, label: &str, id: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return on_tray_menu(app, id);
    };
    if let Some(own) = id.strip_prefix("own:") {
        let _ = window.emit_to(label, "title-menu", own);
        return;
    }
    match id {
        "new" => {
            let _ = create_and_open(app, beside(&window));
        }
        "new-group" => {
            let group = app.state::<Shared>().create_group(beside(&window));
            if let Ok(window) = open_group_window(app, &group) {
                let _ = window.set_focus();
            }
            groups_changed(app);
        }
        "new-board" => {
            let store = app.state::<Shared>();
            let lang = store.effective_language();
            let default_cols = if lang == "en" {
                vec!["To Do".into(), "In Progress".into(), "Done".into()]
            } else {
                vec!["A Fazer".into(), "Em Andamento".into(), "Concluído".into()]
            };
            let board = store.create_board(None, default_cols, beside(&window));
            if let Ok(w) = open_board_window(app, &board) {
                let _ = w.set_focus();
            }
            boards_changed(app);
        }
        _ => on_tray_menu(app, id),
    }
}

/// A tray menu click.
fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "new" => {
            let _ = create_and_open(app, None);
        }
        "new-group" => {
            let group = app.state::<Shared>().create_group(None);
            if let Ok(window) = open_group_window(app, &group) {
                let _ = window.set_focus();
            }
            groups_changed(app);
        }
        "new-board" => {
            let store = app.state::<Shared>();
            let lang = store.effective_language();
            let default_cols = if lang == "en" {
                vec!["To Do".into(), "In Progress".into(), "Done".into()]
            } else {
                vec!["A Fazer".into(), "Em Andamento".into(), "Concluído".into()]
            };
            let board = store.create_board(None, default_cols, None);
            if let Ok(w) = open_board_window(app, &board) {
                let _ = w.set_focus();
            }
            boards_changed(app);
        }
        "show" => show_all(app),
        "manager" => {
            let _ = open_manager(app);
        }
        "trash" => open_manager_view(app, "notes", Some("trash")),
        "settings" => open_manager_view(app, "settings", None),
        "help" => open_manager_view(app, "help", None),
        "autostart" => {
            use tauri_plugin_autostart::ManagerExt;
            let manager = app.autolaunch();
            let result = match manager.is_enabled() {
                Ok(true) => manager.disable(),
                Ok(false) => manager.enable(),
                Err(err) => Err(err),
            };
            if let Err(err) = result {
                eprintln!("memo: autostart: {err}");
            }
            // The manager's switch follows.
            let _ = app.emit("autostart-changed", manager.is_enabled().unwrap_or(false));
            refresh_tray(app);
        }
        "magnet" => {
            let on = !app.state::<Shared>().magnet();
            toggle_magnet(app, on);
        }
        "ai-control" => {
            let on = default_data_dir(app).is_ok_and(|dir| !mcp::enabled(&dir));
            if let Err(err) = toggle_ai_control(app, on) {
                eprintln!("memo: ai control: {err}");
                refresh_tray(app);
            }
        }
        "sync" => sync::sync_now(app),
        // Both answer in Settings, which shows the check and the download.
        "check-updates" => {
            open_manager_view(app, "settings", Some("update"));
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::check(&app, true).await });
        }
        "update" => {
            open_manager_view(app, "settings", Some("update"));
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::install(&app).await });
        }
        "quit" => {
            app.state::<Shared>().flush();
            app.exit(0);
        }
        _ => {
            if let Some((label, id)) = id.strip_prefix("win:").and_then(|rest| rest.split_once(':')) {
                on_title_menu(app, label, id);
            } else if let Some(theme) = id.strip_prefix("theme:") {
                set_theme(app, theme);
            } else if let Some(language) = id.strip_prefix("language:") {
                set_language(app, language);
            } else if let Some(layout) = id.strip_prefix("layout:") {
                set_layout(app, layout);
            }
        }
    }
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
        .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
        // A click on the tray icon opens the manager (Linux trays send no
        // clicks: the menu has the manager item).
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = open_manager(tray.app_handle());
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
    // `memo --mcp`: the stdio MCP server AI assistants launch (mcp.rs), not
    // the app.
    if std::env::args().any(|a| a == mcp::ARG) {
        std::process::exit(mcp::bridge());
    }

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

    // TLS for the Google sign-in (reqwest is built without a default
    // crypto provider, so the installer needs no C toolchain for it).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // In-app updates from the GitHub releases (updater.rs).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Start with the system: same name and argument as the Windows
        // installer's Run value (windows/hooks.nsh).
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Memo")
                .arg(AUTOSTART_ARG)
                .build(),
        )
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
            resize_start,
            resize_to,
            load_note,
            save_text,
            open_link,
            set_pinned,
            set_color,
            set_title,
            place_color_picker,
            new_note,
            close_note,
            load_manager,
            take_manager_view,
            close_manager,
            bring_notes_to_front,
            show_title_menu,
            list_notes,
            open_note,
            move_to_trash,
            restore_note,
            delete_forever,
            empty_trash,
            change_theme,
            get_zoom,
            change_zoom,
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
            focus_group,
            show_group_notes,
            toggle_group_id,
            trash_group_id,
            restore_group,
            delete_group_forever,
            get_autostart,
            set_autostart,
            get_magnet,
            set_magnet,
            get_ai_control,
            set_ai_control,
            get_ai_clients,
            connect_ai_client,
            get_cloud_account,
            connect_cloud,
            cancel_cloud_connect,
            disconnect_cloud,
            sync_cloud,
            get_updates,
            set_auto_update,
            check_update,
            install_update,
            empty_group_trash,
            set_group_color,
            set_manager_color,
            set_manager_layout,
            set_group_height,
            toggle_group,
            new_note_in_group,
            new_group,
            close_group,
            new_board,
            open_board,
            open_board_note,
            take_note_out_of_board,
            load_board,
            save_board_columns,
            rename_board,
            set_board_color,
            close_board,
            list_boards,
            trash_board_id,
            restore_board_id,
            delete_board_forever,
            update_board_drop_zones,
            get_board_group,
            set_board_group,
            move_board_to_group
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
            init_autostart(&handle, &default_dir);

            // The manager opens on every launch (but a start with the system
            // only reopens the notes); on the first one, the welcome note
            // opens beside it.
            let at_login = std::env::args().any(|a| a == AUTOSTART_ARG);
            build_snap_preview(&handle)?;
            if !at_login || store.is_first_run() {
                open_manager(&handle)?;
            }
            for group in store.active_groups().iter().filter(|g| !g.hidden) {
                open_group_window(&handle, group)?;
            }
            let closed_groups: std::collections::HashSet<String> = store.active_groups().into_iter().filter(|g| !g.open).map(|g| g.id).collect();
            for board in store.active_boards().iter().filter(|b| !b.hidden && !closed_groups.contains(&b.group_id)) {
                let _ = open_board_window(&handle, board);
            }
            if store.is_first_run() {
                let pos = handle.get_webview_window(MANAGER).and_then(|m| beside(&m));
                open_welcome(&handle, pos, false)?;
            } else if store.active().is_empty() && store.active_groups().is_empty() && !at_login {
                create_and_open(&handle, None)?;
            } else {
                // Notes inside closed groups stay in them.
                for note in &store.visible() {
                    open_note_window(&handle, note)?;
                }
            }
            sync::start(&handle);
            updater::start(&handle);
            if mcp::enabled(&default_dir) {
                if let Err(err) = mcp::start(&handle, &default_dir) {
                    eprintln!("memo: mcp: {err}");
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
        RunEvent::Exit => {
            app.state::<Shared>().flush();
            mcp::stop();
        }
        // Clicking the Dock icon brings the notes to the front and opens the manager.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            show_all(app);
            let _ = open_manager(app);
        }
        _ => {}
    });
}
