//! Windows: building, opening, placing and tracking note, manager and
//! group windows; themes, zoom and screen geometry.

use crate::*;

/// Opens a note's window (or brings it to the front if it is already open).
pub(crate) fn open_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(&Kind::Note.label(&note.id)) {
        reveal(&existing);
        return Ok(existing);
    }
    let window = build_note_window(app, note)?;
    window.show()?;
    Ok(window)
}

/// Creates a note's window, hidden, at its saved place.
pub(crate) fn build_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    let label = Kind::Note.label(&note.id);
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("windows/note/index.html".into()))
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
pub(crate) struct ManagerView {
    pub(crate) view: &'static str,
    pub(crate) scope: Option<&'static str>,
}

pub(crate) static MANAGER_VIEW: Mutex<Option<ManagerView>> = Mutex::new(None);
pub(crate) static BOARD_TRANSIENT_NOTES: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub(crate) fn mark_board_transient(note_id: &str) {
    let mut lock = BOARD_TRANSIENT_NOTES.lock().unwrap();
    let set = lock.get_or_insert_with(HashSet::new);
    set.insert(note_id.to_string());
}

pub(crate) fn take_board_transient(note_id: &str) -> bool {
    let mut lock = BOARD_TRANSIENT_NOTES.lock().unwrap();
    if let Some(set) = lock.as_mut() {
        set.remove(note_id)
    } else {
        false
    }
}

pub(crate) fn is_board_transient(note_id: &str) -> bool {
    let lock = BOARD_TRANSIENT_NOTES.lock().unwrap();
    lock.as_ref().map(|s| s.contains(note_id)).unwrap_or(false)
}

/// Opens the manager on `view` ("notes", "groups", "settings", "help"), with
/// the list showing `scope` ("current" or "trash").
pub(crate) fn open_manager_view(app: &AppHandle, view: &'static str, scope: Option<&'static str>) {
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
pub(crate) fn take_manager_view() -> Option<ManagerView> {
    MANAGER_VIEW.lock().unwrap().take()
}

/// Opens the manager window, where notes and the trash are managed. It behaves
/// like a note (frameless, own titlebar, snapping, pin) but has no
/// title or text. It also holds the theme, help and "Quit".
pub(crate) fn open_manager(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(MANAGER) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.center();
        let _ = existing.set_focus();
        return Ok(());
    }
    let store = app.state::<Shared>();
    let state = store.manager();
    let window = WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App("windows/manager/manager.html".into()))
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
    let _ = window.center();
    apply_theme(&window, &store.theme());
    track_geometry(app, &window);
    let _ = window.set_zoom(store.zoom());
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Manager window title (taskbar) in the UI language.
pub(crate) fn manager_title(lang: &str) -> &'static str {
    if lang == "en" {
        "Memo Manager"
    } else {
        "Gerenciador do Memo"
    }
}

/// Tray menu labels in the UI language (the same words as `i18n.js`).
pub(crate) struct TrayLabels {
    pub(crate) new_note: &'static str,
    pub(crate) new_group: &'static str,
    pub(crate) new_board: &'static str,
    pub(crate) show: &'static str,
    pub(crate) manager: &'static str,
    pub(crate) trash: &'static str,
    pub(crate) settings: &'static str,
    pub(crate) help: &'static str,
    pub(crate) theme: &'static str,
    pub(crate) system: &'static str,
    pub(crate) light: &'static str,
    pub(crate) dark: &'static str,
    pub(crate) language: &'static str,
    pub(crate) layout: &'static str,
    pub(crate) cards: &'static str,
    pub(crate) list: &'static str,
    pub(crate) autostart: &'static str,
    pub(crate) magnet: &'static str,
    pub(crate) ai_control: &'static str,
    pub(crate) sync: &'static str,
    pub(crate) check_updates: &'static str,
    pub(crate) update_to: &'static str,
    pub(crate) quit: &'static str,
    /// A memory with no name (a reminder's notification, reminders.rs).
    pub(crate) untitled: &'static str,
}

pub(crate) fn tray_labels(lang: &str) -> TrayLabels {
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
            untitled: "Untitled",
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
            untitled: "Sem título",
        }
    }
}

/// Changes the language of every window (chosen in Settings).
pub(crate) fn set_language(app: &AppHandle, language: &str) {
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
pub(crate) fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("memo"), build_tray_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

/// The window's native theme and background for the app's theme: the
/// native theme makes its titlebar menu (`show_title_menu`) match the app.
pub(crate) fn apply_theme(window: &WebviewWindow, theme: &str) {
    let _ = window.set_theme(match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    });
    apply_background(window, theme);
}

/// Native window background for the effective theme ("system" follows the OS).
pub(crate) fn apply_background(window: &WebviewWindow, theme: &str) {
    let light = match theme {
        "light" => true,
        "dark" => false,
        _ => matches!(window.theme(), Ok(Theme::Light)),
    };
    let _ = window.set_background_color(Some(if light { PAPER } else { CARBON }));
}

/// Changes the theme of every window (chosen in the manager).
pub(crate) fn set_theme(app: &AppHandle, theme: &str) {
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
pub(crate) fn scale_of(window: &WebviewWindow) -> f64 {
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
pub(crate) fn set_logical_size(window: &WebviewWindow, width: f64, height: f64) {
    let scale = scale_of(window);
    let _ = window.set_size(PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    ));
}

/// A saved position is only used if the titlebar is still visible on some
/// monitor (avoids "lost" notes after a display is disconnected).
pub(crate) fn is_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let screens = desk::screens(window);
    screens.is_empty()
        || screens
            .iter()
            .any(|m| m.contains(((x + 48) as f64, (y + 12) as f64)))
}

/// Saves position and size whenever the user moves or resizes a window
/// (note, group, board or manager). Moves made by a group animation are skipped,
/// so a note keeps its own place.
pub(crate) fn track_geometry(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let win = window.clone();
    // The saved object the geometry belongs to; `None` = the manager.
    let kind = Kind::of(window);
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
                    Some((Kind::Note, id)) => {
                        store.update(id, |n| (n.x, n.y) = (x, y));
                    }
                    Some((Kind::Group, id)) => {
                        store.update_group(id, |g| (g.x, g.y) = (x, y));
                    }
                    Some((Kind::Board, id)) => {
                        store.update_board(id, |b| (b.x, b.y) = (x, y));
                    }
                    None => {
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
                    Some((Kind::Note, id)) => {
                        store.update(id, |n| {
                            (n.width, n.height) = (logical.width, logical.height)
                        });
                    }
                    Some((Kind::Group, id)) => {
                        store.update_group(id, |g| g.width = logical.width);
                    }
                    Some((Kind::Board, id)) => {
                        store.update_board(id, |b| {
                            (b.width, b.height) = (logical.width, logical.height)
                        });
                    }
                    None => {
                        store.update_manager(|m| {
                            (m.width, m.height) = (logical.width, logical.height)
                        });
                    }
                }
            }
            WindowEvent::ThemeChanged(_) => apply_background(&win, &store.theme()),
            // Coming back to Memo: fetch what changed on other computers.
            WindowEvent::Focused(true) => {
                sync::on_focus();
            }
            WindowEvent::Focused(false) => {
                if Kind::Note.is(&win) {
                    let note_id = Kind::Note.id_of(&win);
                    if is_board_transient(&note_id) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(150)).await;
                            let label = Kind::Note.label(&note_id);
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
                if Kind::Note.is(&win) {
                    take_board_transient(&Kind::Note.id_of(&win));
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
pub(crate) fn open_welcome(app: &AppHandle, pos: Option<(i32, i32)>, copy: bool) -> tauri::Result<()> {
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
pub(crate) struct SnapTargets {
    pub(crate) left: Vec<i32>,
    pub(crate) right: Vec<i32>,
    pub(crate) top: Vec<i32>,
    pub(crate) bottom: Vec<i32>,
    /// Snap reach, in desktop units (`desk`).
    pub(crate) reach: i32,
    /// Desktop units per logical pixel.
    pub(crate) scale: f64,
}

impl SnapTargets {
    /// Targets for the visible rect `l`,`t`,`r`,`b`, in desktop units.
    pub(crate) fn new(window: &WebviewWindow, l: i32, t: i32, r: i32, b: i32) -> Self {
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
    pub(crate) fn pick(&self, v: i32, targets: &[i32]) -> i32 {
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
pub(crate) fn sample_points((l, t, r, b): (i32, i32, i32, i32)) -> impl Iterator<Item = (i32, i32)> {
    let inset = 4;
    let xs = [l + inset, (l + r) / 2, r - 1 - inset];
    let ys = [t + inset, (t + b) / 2, b - 1 - inset];
    ys.into_iter()
        .flat_map(move |y| xs.into_iter().map(move |x| (x, y)))
}

/// Windows: asks which top-level window is shown at each point.
#[cfg(windows)]
pub(crate) fn shows_on_screen(window: &WebviewWindow, rect: (i32, i32, i32, i32)) -> bool {
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
pub(crate) fn shows_on_screen(window: &WebviewWindow, _rect: (i32, i32, i32, i32)) -> bool {
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
pub(crate) fn shows_on_screen(window: &WebviewWindow, rect: (i32, i32, i32, i32)) -> bool {
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
pub(crate) unsafe fn x11_shows(
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
pub(crate) fn shows_on_screen(_window: &WebviewWindow, _rect: (i32, i32, i32, i32)) -> bool {
    true
}

/// Snapped position for the window being dragged (visible corner `x`,`y`,
/// size `w`×`h`): on each axis, whichever edge is closest to a target pulls
/// the window.
pub(crate) fn snapped(window: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
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
pub(crate) fn frame_offset(window: &WebviewWindow) -> Option<(i32, i32)> {
    let outer = desk::outer_position(window)?;
    let inner = desk::inner_position(window)?;
    Some((inner.0 - outer.0, inner.1 - outer.1))
}
