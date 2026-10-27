// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod boards;
mod clients;
mod cloud;
mod color_picker;
mod data;
mod desk;
mod drag;
mod groups;
mod images;
mod manager;
mod mcp;
mod notes;
mod store;
mod sync;
mod tray;
mod updater;
mod welcome;
mod windows;

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

// The sections of the app, moved out of this file; everything is reachable
// from here and from each other (each module does `use crate::*`).
use windows::*;
use drag::*;
use notes::*;
use color_picker::*;
use manager::*;
use groups::*;
use boards::*;
use data::*;
use tray::*;

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

/// The objects that have a window of their own, one per object, labelled
/// `note-{id}`, `group-{id}` or `board-{id}` (the manager and the Snap
/// preview have fixed labels). The one place that knows these labels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Kind {
    Note,
    Group,
    Board,
}

impl Kind {
    const ALL: [Kind; 3] = [Kind::Note, Kind::Group, Kind::Board];

    fn prefix(self) -> &'static str {
        match self {
            Kind::Note => "note-",
            Kind::Group => "group-",
            Kind::Board => "board-",
        }
    }

    /// The window label of object `id`.
    pub(crate) fn label(self, id: &str) -> String {
        format!("{}{id}", self.prefix())
    }

    /// Whether `window` shows an object of this kind.
    pub(crate) fn is(self, window: &WebviewWindow) -> bool {
        window.label().starts_with(self.prefix())
    }

    /// The id of the object `window` shows (called by its own commands).
    pub(crate) fn id_of(self, window: &WebviewWindow) -> String {
        window.label().trim_start_matches(self.prefix()).to_string()
    }

    /// The kind and id of the object `window` shows; `None` for the manager
    /// and the Snap preview.
    pub(crate) fn of(window: &WebviewWindow) -> Option<(Kind, String)> {
        let label = window.label();
        Kind::ALL
            .into_iter()
            .find(|k| label.starts_with(k.prefix()))
            .map(|k| (k, label[k.prefix().len()..].to_string()))
    }
}

/// The app's real windows (notes, groups, boards and manager), i.e. not the Snap
/// preview.
fn is_app_window(window: &WebviewWindow) -> bool {
    window.label() != SNAP_PREVIEW
}

/// A colour sent by a window: a label or "#rrggbb" (`store::is_valid_color`).
fn check_color(color: &str) -> Result<(), String> {
    if is_valid_color(color) {
        Ok(())
    } else {
        Err(format!("unknown color: {color}"))
    }
}

/// Brings a window back: unminimised, shown and focused.
fn reveal(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Native window title of a group bar or board (taskbar): its name, or the
/// app's.
fn window_title(name: &str) -> &str {
    if name.trim().is_empty() {
        "Memo"
    } else {
        name
    }
}

/// Closes the window with this label for good, if it is open.
fn destroy_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
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
            rename,
            close_window,
            trash_window,
            place_color_picker,
            new_note,
            load_manager,
            take_manager_view,
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
            load_group,
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
            set_manager_layout,
            set_group_height,
            toggle_group,
            new_note_in_group,
            new_group,
            new_board,
            open_board,
            open_board_note,
            take_note_out_of_board,
            load_board,
            save_board_columns,
            list_boards,
            trash_board_id,
            restore_board_id,
            delete_board_forever,
            update_board_drop_zones,
            get_board_group,
            set_board_group,
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
            for board in &store.visible_boards() {
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
