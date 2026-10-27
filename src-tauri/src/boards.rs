//! Boards: board windows, columns, board trash.

use crate::*;

pub(crate) fn build_board_window(app: &AppHandle, board: &Board) -> tauri::Result<WebviewWindow> {
    let label = board_label(&board.id);
    let store = app.state::<Shared>();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("board.html".into()))
        .title(window_title(&board.name))
        .inner_size(board.width, board.height)
        .min_inner_size(BOARD_MIN_W, BOARD_MIN_H)
        .decorations(false)
        .resizable(false)
        .always_on_top(board.pinned)
        .background_color(CARBON)
        .accept_first_mouse(true)
        .visible(false)
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

pub(crate) fn open_board_window(app: &AppHandle, board: &Board) -> tauri::Result<WebviewWindow> {
    let label = board_label(&board.id);
    if let Some(existing) = app.get_webview_window(&label) {
        reveal(&existing);
        return Ok(existing);
    }
    let window = build_board_window(app, board)?;
    window.show()?;
    let _ = window.set_focus();
    Ok(window)
}

#[tauri::command]
pub(crate) async fn new_board(app: AppHandle, store: State<'_, Shared>) -> Result<Board, String> {
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
pub(crate) async fn open_board(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    let board = store.board(&id).ok_or_else(|| "board not found".to_string())?;
    store.update_board(&id, |b| b.hidden = false);
    open_board_window(&app, &board).map_err(|e| e.to_string())?;
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn load_board(window: WebviewWindow, store: State<'_, Shared>) -> Result<Option<Board>, String> {
    Ok(store.board(&board_id_of(&window)))
}

#[tauri::command]
pub(crate) fn save_board_columns(
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
pub(crate) fn rename_board(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    store: State<'_, Shared>,
) -> Result<String, String> {
    let id = board_id_of(&window);
    let clean = name.trim().chars().take(BOARD_NAME_MAX).collect::<String>();
    store.update_board(&id, |b| b.name = clean.clone());
    let _ = window.set_title(window_title(&clean));
    boards_changed(&app);
    Ok(clean)
}

#[tauri::command]
pub(crate) fn set_board_color(
    app: AppHandle,
    window: WebviewWindow,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    check_color(&color)?;
    let id = board_id_of(&window);
    store.update_board(&id, |b| b.color = color);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn close_board(
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
pub(crate) fn list_boards(store: State<'_, Shared>) -> Result<Vec<Board>, String> {
    Ok(store.boards())
}

// Async: they destroy windows (see `new_note`).
#[tauri::command]
pub(crate) async fn trash_board(app: AppHandle, window: WebviewWindow) {
    trash_board_by_id(&app, &board_id_of(&window));
}

#[tauri::command]
pub(crate) async fn trash_board_id(app: AppHandle, id: String) {
    trash_board_by_id(&app, &id);
}

pub(crate) fn trash_board_by_id(app: &AppHandle, id: &str) {
    destroy_window(app, &board_label(id));
    app.state::<Shared>().trash_board(id);
    boards_changed(app);
}

#[tauri::command]
pub(crate) fn restore_board_id(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    store.restore_board(&id);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_board_forever(app: AppHandle, id: String, store: State<'_, Shared>) -> Result<(), String> {
    destroy_window(&app, &board_label(&id));
    store.remove_board(&id);
    boards_changed(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn update_board_drop_zones(
    window: WebviewWindow,
    zones: Vec<ColumnBounds>,
    drags: State<'_, Drags>,
) {
    let bid = board_id_of(&window);
    drags.board_columns.lock().unwrap().insert(bid, zones);
}
