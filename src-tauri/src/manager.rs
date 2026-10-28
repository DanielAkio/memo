//! Manager commands: lists, trash, settings and defaults.

use crate::*;

/// Manager window state (pinned) on open.
#[tauri::command]
pub(crate) fn load_manager(store: State<'_, Shared>) -> ManagerState {
    store.manager()
}

/// Manager's "bring all memories to front" button. Unlike the tray's "Show
/// all memories", it doesn't create a note when none is open.
#[tauri::command]
pub(crate) async fn bring_notes_to_front(app: AppHandle) {
    raise_notes(&app);
}

/// All notes, active and trashed, without the HTML (the manager only shows
/// title, text preview, colour and dates).
#[tauri::command]
pub(crate) fn list_notes(store: State<'_, Shared>) -> Vec<Note> {
    store
        .all()
        .into_iter()
        .map(|mut n| {
            n.html = String::new();
            n
        })
        .collect()
}

pub(crate) fn ensure_note_on_screen(app: &AppHandle, win: &WebviewWindow, id: &str) {
    if let (Some((x, y)), Some((w, h))) = (desk::inner_position(win), desk::inner_size(win)) {
        if !desk::screens(win).iter().any(|m| {
            let (sl, st, sw, sh) = m.work;
            x >= sl && (x + w) <= (sl + sw) && y >= st && (y + h) <= (st + sh)
        }) {
            if let Some(mgr) = app.get_webview_window(MANAGER) {
                if let Some((nx, ny)) = beside(&mgr) {
                    desk::set_position(win, nx, ny);
                    app.state::<Shared>().update(id, |n| {
                        n.x = Some(nx);
                        n.y = Some(ny);
                    });
                }
            }
        }
    }
}

/// Opens an active note (or brings it to the front if already open).
#[tauri::command]
pub(crate) async fn open_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .get(&id)
        .filter(|n| n.trashed_at.is_none())
        .ok_or("note not found")?;
    let store = app.state::<Shared>();
    let note = store.update(&id, |n| n.hidden = false).unwrap_or(note);
    // Only this one, even inside a group that is put away or closed.
    let win = open_note_window(&app, &note).map_err(|e| e.to_string())?;
    ensure_note_on_screen(&app, &win, &id);
    notify(&app);
    Ok(())
}

/// Opens a note from a board. The note opens on desktop and, when clicked outside
/// (loses focus), returns back to the board (closes from desktop).
#[tauri::command]
pub(crate) async fn open_board_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .get(&id)
        .filter(|n| n.trashed_at.is_none())
        .ok_or("note not found")?;
    mark_board_transient(&id);
    let store = app.state::<Shared>();
    let note = store.update(&id, |n| n.hidden = false).unwrap_or(note);
    let window = open_note_window(&app, &note).map_err(|e| e.to_string())?;
    ensure_note_on_screen(&app, &window, &id);
    let _ = window.show();
    let _ = window.set_focus();
    notify(&app);
    Ok(())
}

/// Takes a note out of any board: removes it from all boards, marks hidden=false,
/// and opens it on desktop at (screen_x, screen_y) if supplied.
#[tauri::command]
pub(crate) async fn take_note_out_of_board(
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
pub(crate) async fn move_to_trash(app: AppHandle, id: String) {
    trash(&app, &id);
}

/// Takes the note out of the trash and opens its window (unless it goes back
/// into a closed group).
#[tauri::command]
pub(crate) async fn restore_note(app: AppHandle, id: String) -> Result<(), String> {
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
pub(crate) fn delete_forever(app: AppHandle, id: String, store: State<'_, Shared>) {
    if store.get(&id).is_some_and(|n| n.trashed_at.is_some()) {
        store.remove(&id);
        store.flush();
        notify(&app);
    }
}

#[tauri::command]
pub(crate) fn empty_trash(app: AppHandle, store: State<'_, Shared>) {
    store.empty_trash();
    store.flush();
    notify(&app);
}

/// Chosen language and the effective one ("pt" or "en"), for the pages.
#[tauri::command]
pub(crate) fn get_language(store: State<'_, Shared>) -> (String, &'static str) {
    (store.language(), store.effective_language())
}

/// Changes the UI language (chosen in the manager).
#[tauri::command]
pub(crate) fn change_language(app: AppHandle, language: String) -> Result<(), String> {
    if !LANGUAGES.contains(&language.as_str()) {
        return Err(format!("unknown language: {language}"));
    }
    set_language(&app, &language);
    Ok(())
}

/// Global zoom, for the Settings control.
#[tauri::command]
pub(crate) fn get_zoom(store: State<'_, Shared>) -> f64 {
    store.zoom()
}

/// Steps the global zoom (`step` × 10%, `0` = back to 100%) and applies it
/// to every window: Settings' − / + / reset, Mod + / Mod − / Mod 0 and
/// Mod + wheel in any window. Group bars, a titlebar tall, grow with it.
/// Returns the new zoom; emits "zoom-changed".
#[tauri::command]
pub(crate) fn change_zoom(app: AppHandle, step: i32) -> f64 {
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
        if Kind::Group.is(window) {
            if let Some(group) = store.group(&Kind::Group.id_of(window)) {
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
pub(crate) fn change_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !THEMES.contains(&theme.as_str()) {
        return Err(format!("unknown theme: {theme}"));
    }
    set_theme(&app, &theme);
    Ok(())
}

/// Settings → "Restore default settings": theme, language, zoom, layout,
/// the magnet, update notices and the defaults for new items go back to how
/// Memo comes. Start with the system, AI control, cloud accounts and the
/// data folder stay as they are (they are set up, not preferences).
#[tauri::command]
pub(crate) fn reset_settings(app: AppHandle) -> Result<(), String> {
    set_theme(&app, "system");
    set_language(&app, "system");
    change_zoom(app.clone(), 0);
    set_layout(&app, LAYOUTS[0]);
    toggle_magnet(&app, true);
    updater::set_auto(&app, true)?;
    app.state::<Shared>().reset_defaults();
    notify(&app);
    Ok(())
}

/// Reopens the welcome note (button in the manager's Help tab).
#[tauri::command]
pub(crate) async fn show_welcome(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    open_welcome(&app, beside(&window), true).map_err(|e| e.to_string())
}

/// Quits the app (the only way out: closing the notes doesn't quit).
#[tauri::command]
pub(crate) fn quit_app(app: AppHandle, store: State<'_, Shared>) {
    store.flush();
    app.exit(0);
}

#[tauri::command]
pub(crate) fn get_default_color(store: State<'_, Shared>) -> String {
    store.default_color()
}

/// Default title, text and HTML for new notes, for the manager.
#[tauri::command]
pub(crate) fn get_new_note_defaults(store: State<'_, Shared>) -> (String, String, String) {
    let (title, text, html) = store.new_note_defaults();
    (title, text, store.inline_images(&html))
}

#[tauri::command]
pub(crate) fn set_default_title(title: String, store: State<'_, Shared>) {
    store.set_default_title(title.trim().chars().take(TITLE_MAX).collect());
}

/// Colour and name new groups start with, for the manager's Settings.
#[tauri::command]
pub(crate) fn get_group_defaults(store: State<'_, Shared>) -> (String, String) {
    store.group_defaults()
}

#[tauri::command]
pub(crate) fn set_default_group_color(color: String, store: State<'_, Shared>) -> Result<(), String> {
    if color != RANDOM_COLOR {
        check_color(&color)?;
    }
    store.set_default_group_color(&color);
    Ok(())
}

#[tauri::command]
pub(crate) fn set_default_group_title(title: String, store: State<'_, Shared>) {
    store.set_default_group_title(title.trim().chars().take(GROUP_NAME_MAX).collect());
}

/// Colour, name and columns new boards start with, for the manager's
/// Settings (columns `None` = the language's own).
#[tauri::command]
pub(crate) fn get_board_defaults(store: State<'_, Shared>) -> (String, String, Option<Vec<ColumnDefault>>) {
    store.board_defaults()
}

/// `""` = no colour.
#[tauri::command]
pub(crate) fn set_default_board_color(color: String, store: State<'_, Shared>) -> Result<(), String> {
    if !color.is_empty() && color != RANDOM_COLOR {
        check_color(&color)?;
    }
    store.set_default_board_color(&color);
    Ok(())
}

#[tauri::command]
pub(crate) fn set_default_board_title(title: String, store: State<'_, Shared>) {
    store.set_default_board_title(title.trim().chars().take(BOARD_NAME_MAX).collect());
}

#[tauri::command]
pub(crate) fn set_default_board_columns(columns: Option<Vec<ColumnDefault>>, store: State<'_, Shared>) {
    store.set_default_board_columns(columns);
}

/// Default content for new notes, edited in the manager with the same note
/// editor (index.html?defaults): plain text and HTML, as a note stores them.
#[tauri::command]
pub(crate) fn set_default_content(text: String, html: String, store: State<'_, Shared>) {
    let text = text.chars().take(DEFAULT_TEXT_MAX).collect();
    let html = store.store_images(&html).chars().take(DEFAULT_TEXT_MAX * 10).collect();
    store.set_default_content(text, html);
}

#[tauri::command]
pub(crate) fn set_default_color(
    app: AppHandle,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if color != RANDOM_COLOR {
        check_color(&color)?;
    }
    store.set_default_color(&color);
    notify(&app);
    Ok(())
}
