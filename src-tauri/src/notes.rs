//! Commands called by note windows (the note id comes from the window label).

use crate::*;

#[tauri::command]
pub(crate) fn get_theme(store: State<'_, Shared>) -> String {
    store.theme()
}

#[tauri::command]
pub(crate) fn load_note(window: WebviewWindow, store: State<'_, Shared>) -> Option<Note> {
    let mut note = store.get(&Kind::Note.id_of(&window))?;
    note.html = store.inline_images(&note.html);
    Some(note)
}

/// Names the calling window's note (its title), group or board; empty =
/// unnamed. Returns the name as saved. One command for every window, like
/// `set_color` (the manager has a fixed name).
#[tauri::command]
pub(crate) fn rename(app: AppHandle, window: WebviewWindow, name: String) -> Result<String, String> {
    match Kind::of(&window) {
        Some((Kind::Note, id)) => {
            let title: String = name.trim().chars().take(TITLE_MAX).collect();
            app.state::<Shared>().update(&id, |n| n.title = title.clone());
            notify(&app);
            Ok(title)
        }
        Some((kind, id)) => Ok(rename_by_id(&app, kind, &id, &name)),
        None => Err("this window has no name".into()),
    }
}

#[tauri::command]
pub(crate) fn save_text(
    app: AppHandle,
    window: WebviewWindow,
    text: String,
    html: String,
    store: State<'_, Shared>,
) {
    // Images are kept as files; the note refers to them (images.rs).
    let html = store.store_images(&html);
    let mut changed = false;
    store.update(&Kind::Note.id_of(&window), |n| {
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
pub(crate) fn open_link(app: AppHandle, url: String) -> Result<(), String> {
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
pub(crate) fn set_pinned(
    window: WebviewWindow,
    pinned: bool,
    store: State<'_, Shared>,
) -> Result<bool, String> {
    window
        .set_always_on_top(pinned)
        .map_err(|e| e.to_string())?;
    if Kind::Note.is(&window) {
        store.update(&Kind::Note.id_of(&window), |n| n.pinned = pinned);
    } else if Kind::Group.is(&window) {
        store.update_group(&Kind::Group.id_of(&window), |g| g.pinned = pinned);
    } else if Kind::Board.is(&window) {
        store.update_board(&Kind::Board.id_of(&window), |b| b.pinned = pinned);
    } else {
        store.update_manager(|m| m.pinned = pinned);
    }
    Ok(pinned)
}

/// Colour of the calling window: its note, group or board, or the manager
/// (a label, "" = none, or "#rrggbb"). One command for every window, like
/// `set_pinned`.
#[tauri::command]
pub(crate) fn set_color(
    app: AppHandle,
    window: WebviewWindow,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    check_color(&color)?;
    match Kind::of(&window) {
        Some((Kind::Note, id)) => {
            store.update(&id, |n| n.color = color);
            notify(&app);
        }
        Some((Kind::Group, id)) => {
            store.update_group(&id, |g| g.color = color);
            groups_changed(&app);
        }
        Some((Kind::Board, id)) => {
            store.update_board(&id, |b| b.color = color);
            boards_changed(&app);
        }
        None => {
            store.update_manager(|m| m.color = color);
        }
    }
    Ok(())
}

/// Reminds of the calling window's memory at `at` (ms), or no more (`None`):
/// it then comes to the front, pinned (reminders.rs).
#[tauri::command]
pub(crate) fn set_reminder(app: AppHandle, window: WebviewWindow, at: Option<u64>) {
    app.state::<Shared>().update(&Kind::Note.id_of(&window), |n| n.remind_at = at);
    notify(&app);
}

// Creating and destroying windows from sync commands can deadlock on
// Windows, so the commands that do so are async.
#[tauri::command]
pub(crate) async fn new_note(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
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
pub(crate) fn beside(parent: &WebviewWindow) -> Option<(i32, i32)> {
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

/// ✕ or middle click on any window: closes it. Its note, group or board
/// stays among the current ones and the manager reopens it; one nobody
/// touched is removed. One command for every window, like `set_color`.
#[tauri::command]
pub(crate) async fn close_window(app: AppHandle, window: WebviewWindow) {
    match Kind::of(&window) {
        Some((Kind::Note, id)) => close_note_by_id(&app, &id),
        Some((Kind::Group, id)) => close_group_by_id(&app, &id),
        Some((Kind::Board, id)) => close_board_by_id(&app, &id),
        None => {
            let _ = window.destroy();
        }
    }
}

/// The trash button in a window's titlebar: its note, group (with its
/// notes) or board goes to the trash.
#[tauri::command]
pub(crate) async fn trash_window(app: AppHandle, window: WebviewWindow) {
    match Kind::of(&window) {
        Some((Kind::Note, id)) => trash(&app, &id),
        Some((Kind::Group, id)) => trash_group_by_id(&app, &id),
        Some((Kind::Board, id)) => trash_board_by_id(&app, &id),
        None => {}
    }
}

/// Closes note `id`: it stays among the current ones. A note nobody touched
/// (or a welcome copy) goes the way `trash` sends it: deleted outright.
pub(crate) fn close_note_by_id(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    match store.get(id) {
        Some(note) if note.welcome_copy || store.is_pristine(&note) => trash(app, id),
        Some(_) => {
            store.update(id, |n| n.hidden = true);
            store.flush();
            destroy_window(app, &Kind::Note.label(id));
            notify(app);
        }
        None => {}
    }
}
