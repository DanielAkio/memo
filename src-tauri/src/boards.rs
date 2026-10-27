//! Boards: board windows, columns, board trash.

use crate::*;

pub(crate) fn build_board_window(app: &AppHandle, board: &Board) -> tauri::Result<WebviewWindow> {
    let label = Kind::Board.label(&board.id);
    let store = app.state::<Shared>();
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("windows/board/board.html".into()))
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
    let label = Kind::Board.label(&board.id);
    if let Some(existing) = app.get_webview_window(&label) {
        reveal(&existing);
        return Ok(existing);
    }
    let window = build_board_window(app, board)?;
    window.show()?;
    let _ = window.set_focus();
    Ok(window)
}

/// A new board's columns, in the app's language.
fn default_columns(store: &Shared) -> Vec<String> {
    if store.effective_language() == "en" {
        vec!["To Do".into(), "In Progress".into(), "Done".into()]
    } else {
        vec!["A Fazer".into(), "Em Andamento".into(), "Concluído".into()]
    }
}

/// Board titlebar "+": a new memory at the end of the board's first column
/// (a board with no column gets one), opened beside the board as a clicked
/// card is: it goes back to the board when it loses focus.
#[tauri::command]
pub(crate) async fn new_note_in_board(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let id = Kind::Board.id_of(&window);
    let store = app.state::<Shared>();
    store.board(&id).ok_or("board not found")?;
    let note = store.create(beside(&window));
    let first = default_columns(&store).swap_remove(0);
    store.update_board(&id, |b| {
        if b.columns.is_empty() {
            b.columns.push(BoardColumn {
                id: format!("col-{}", store::now_ms()),
                name: first,
                color: String::new(),
                note_ids: Vec::new(),
            });
        }
        b.columns[0].note_ids.push(note.id.clone());
    });
    mark_board_transient(&note.id);
    let note_window = open_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = note_window.set_focus();
    boards_changed(&app);
    notify(&app);
    Ok(())
}

#[tauri::command]
pub(crate) async fn new_board(app: AppHandle, store: State<'_, Shared>) -> Result<Board, String> {
    let board = store.create_board(None, default_columns(&store), None);
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
    Ok(store.board(&Kind::Board.id_of(&window)))
}

#[tauri::command]
pub(crate) fn save_board_columns(
    app: AppHandle,
    window: WebviewWindow,
    columns: Vec<BoardColumn>,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let id = Kind::Board.id_of(&window);
    store.update_board(&id, |b| b.columns = columns);
    boards_changed(&app);
    Ok(())
}



/// Closes board `id` (✕ or middle click): it stays among the current ones;
/// a board nobody touched (`Store::is_pristine_board`) is removed, as a group.
pub(crate) fn close_board_by_id(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    if store.is_pristine_board(id) {
        store.remove_board(id);
    } else {
        store.update_board(id, |b| b.hidden = true);
    }
    destroy_window(app, &Kind::Board.label(id));
    boards_changed(app);
}

#[tauri::command]
pub(crate) fn list_boards(store: State<'_, Shared>) -> Result<Vec<Board>, String> {
    Ok(store.boards())
}

// Async: it destroys a window (see `new_note`).
#[tauri::command]
pub(crate) async fn trash_board_id(app: AppHandle, id: String) {
    trash_board_by_id(&app, &id);
}

/// Sends board `id` to the trash; one nobody touched is removed outright, as
/// a note or a group.
pub(crate) fn trash_board_by_id(app: &AppHandle, id: &str) {
    destroy_window(app, &Kind::Board.label(id));
    let store = app.state::<Shared>();
    if store.is_pristine_board(id) {
        store.remove_board(id);
    } else {
        store.trash_board(id);
    }
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
    destroy_window(&app, &Kind::Board.label(&id));
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
    let bid = Kind::Board.id_of(&window);
    drags.board_columns.lock().unwrap().insert(bid, zones);
}
