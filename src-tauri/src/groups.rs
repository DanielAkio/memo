//! Groups: group bars, membership, take out / put away, group trash.

use crate::*;

// A group is a compact bar (`group.html`, label `group-{id}`). Its arrow
// button takes its notes out — each window slides from the bar to the
// note's saved place — or puts them back in: they slide into the bar and
// their windows close. Notes join a group by being dropped on its bar, from
// the picker in their footer or from the manager's list. ✕ closes the bar
// and its notes' windows; trashing a group sends its notes to the trash
// with it.

/// Windows being moved by a group animation: their `Moved` events are not
/// saved, so a note keeps its own place. A label is removed when its window
/// is destroyed, or shortly after a slide-out ends.
#[derive(Default)]
pub(crate) struct Sliding(pub(crate) Mutex<HashSet<String>>);

/// Slides `window` (outer position) from `from` to `to` on a worker thread,
/// easing out, then runs `done` there.
pub(crate) fn slide(
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

/// Opens a group's bar (or brings it to the front if already open).
pub(crate) fn open_group_window(app: &AppHandle, group: &Group) -> tauri::Result<WebviewWindow> {
    let label = Kind::Group.label(&group.id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        return Ok(existing);
    }
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("group.html".into()))
        .title(window_title(&group.name))
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
pub(crate) fn group_anchor(app: &AppHandle, id: &str) -> Option<(i32, i32)> {
    if let Some(p) = app
        .get_webview_window(&Kind::Group.label(id))
        .and_then(|w| desk::outer_position(&w))
    {
        return Some(p);
    }
    let group = app.state::<Shared>().group(id)?;
    Some((group.x?, group.y?))
}

/// Takes the group's notes out: each window appears at the bar and slides to
/// the note's saved place.
pub(crate) fn take_out(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    store.update_group(id, |g| g.open = true);
    let anchor = group_anchor(app, id);
    for note in store.members(id) {
        // Taking out shows all of them, those closed with ✕ too.
        let note = store.update(&note.id, |n| n.hidden = false).unwrap_or(note);
        let label = Kind::Note.label(&note.id);
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
        let label = Kind::Board.label(&board.id);
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
pub(crate) fn put_in(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    store.update_group(id, |g| g.open = false);
    store.flush();
    let anchor = group_anchor(app, id);
    for note in store.members(id) {
        if let Some(window) = app.get_webview_window(&Kind::Note.label(&note.id)) {
            slide_in(app, window, anchor);
        }
    }
    for board in store.board_members(id) {
        if let Some(window) = app.get_webview_window(&Kind::Board.label(&board.id)) {
            slide_in(app, window, anchor);
        }
    }
    groups_changed(app);
    boards_changed(app);
    notify(app);
}

/// Slides a note window into its group bar at `anchor` and closes it (its
/// saved place is kept: the slide's moves are not recorded).
pub(crate) fn slide_in(app: &AppHandle, window: WebviewWindow, anchor: Option<(i32, i32)>) {
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
pub(crate) fn join_group(app: &AppHandle, note_id: &str, group_id: &str, back_to: Option<(i32, i32)>) {
    let store = app.state::<Shared>();
    let Some(group) = store.group(group_id) else {
        return;
    };
    store.update(note_id, |n| n.group_id = group_id.to_string());
    store.flush();
    if let Some(window) = app.get_webview_window(&Kind::Note.label(note_id)) {
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
pub(crate) fn leave_group(app: &AppHandle, note_id: &str) {
    let store = app.state::<Shared>();
    let Some(note) = store.update(note_id, |n| {
        n.group_id.clear();
        n.hidden = false;
    }) else {
        return;
    };
    store.flush();
    if note.trashed_at.is_none() && app.get_webview_window(&Kind::Note.label(note_id)).is_none() {
        let _ = open_note_window(app, &note);
    }
    groups_changed(app);
    notify(app);
}

/// Moves a note to `group_id`: "" = no group, "new" = a new group whose bar
/// opens beside `anchor` (the note's window, or the manager).
pub(crate) fn assign_group(app: &AppHandle, note_id: &str, group_id: &str, anchor: &WebviewWindow) {
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

pub(crate) fn join_board_to_group(app: &AppHandle, board_id: &str, group_id: &str, back_to: Option<(i32, i32)>) {
    let store = app.state::<Shared>();
    let Some(group) = store.group(group_id) else {
        return;
    };
    store.update_board(board_id, |b| b.group_id = group_id.to_string());
    store.flush();
    if let Some(window) = app.get_webview_window(&Kind::Board.label(board_id)) {
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

pub(crate) fn leave_board_group(app: &AppHandle, board_id: &str) {
    let store = app.state::<Shared>();
    let Some(board) = store.update_board(board_id, |b| {
        b.group_id.clear();
        b.hidden = false;
    }) else {
        return;
    };
    store.flush();
    if board.trashed_at.is_none() && app.get_webview_window(&Kind::Board.label(board_id)).is_none() {
        let _ = open_board_window(app, &board);
    }
    boards_changed(app);
    groups_changed(app);
    notify(app);
}

pub(crate) fn assign_board_group(app: &AppHandle, board_id: &str, group_id: &str, anchor: &WebviewWindow) {
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
pub(crate) fn list_groups(store: State<'_, Shared>) -> Vec<Group> {
    store.groups()
}

/// The calling note's group id ("" = none).
#[tauri::command]
pub(crate) fn get_note_group(window: WebviewWindow, store: State<'_, Shared>) -> String {
    store
        .get(&Kind::Note.id_of(&window))
        .map(|n| n.group_id)
        .unwrap_or_default()
}

/// Footer picker of a note: moves it to `group_id` ("" = none, "new").
#[tauri::command]
pub(crate) async fn set_note_group(app: AppHandle, window: WebviewWindow, group_id: String) {
    assign_group(&app, &Kind::Note.id_of(&window), &group_id, &window);
}

/// The calling board's group id ("" = none).
#[tauri::command]
pub(crate) fn get_board_group(window: WebviewWindow, store: State<'_, Shared>) -> String {
    store
        .board(&Kind::Board.id_of(&window))
        .map(|b| b.group_id)
        .unwrap_or_default()
}

/// Picker of a board: moves it to `group_id` ("" = none, "new").
#[tauri::command]
pub(crate) async fn set_board_group(app: AppHandle, window: WebviewWindow, group_id: String) {
    let id = Kind::Board.id_of(&window);
    assign_board_group(&app, &id, &group_id, &window);
}

/// The calling group bar's data and how many notes & boards it holds.
#[tauri::command]
pub(crate) fn load_group(window: WebviewWindow, store: State<'_, Shared>) -> Option<(Group, usize)> {
    let id = Kind::Group.id_of(&window);
    let group = store.group(&id)?;
    Some((group, store.members(&id).len() + store.board_members(&id).len()))
}

/// Renames the calling group (empty = unnamed, as for notes). Returns the
/// name as saved.
#[tauri::command]
pub(crate) fn rename_group(app: AppHandle, window: WebviewWindow, name: String) -> String {
    rename_group_by_id(&app, &Kind::Group.id_of(&window), &name)
}

pub(crate) fn rename_group_by_id(app: &AppHandle, id: &str, name: &str) -> String {
    let store = app.state::<Shared>();
    let name: String = name.trim().chars().take(GROUP_NAME_MAX).collect();
    let group = store.update_group(id, |g| g.name = name.clone());
    let saved = group.map(|g| g.name).unwrap_or_default();
    if let Some(window) = app.get_webview_window(&Kind::Group.label(id)) {
        let _ = window.set_title(window_title(&saved));
    }
    groups_changed(app);
    notify(app);
    saved
}

/// Colour of the manager window (same labels as notes and groups).
#[tauri::command]
pub(crate) fn set_manager_color(color: String, store: State<'_, Shared>) -> Result<(), String> {
    check_color(&color)?;
    store.update_manager(|m| m.color = color);
    Ok(())
}

/// Settings → Appearance → Layout: the Memories and Groups tabs as cards or
/// as a list (also in the tray menu).
#[tauri::command]
pub(crate) fn set_manager_layout(app: AppHandle, layout: String) -> Result<(), String> {
    if !LAYOUTS.contains(&layout.as_str()) {
        return Err(format!("unknown layout: {layout}"));
    }
    set_layout(&app, &layout);
    Ok(())
}

/// Saves the manager's layout; the manager and the tray follow.
pub(crate) fn set_layout(app: &AppHandle, layout: &str) {
    let store = app.state::<Shared>();
    store.update_manager(|m| m.layout = layout.to_string());
    store.flush();
    let _ = app.emit("layout-changed", layout);
    refresh_tray(app);
}

/// Colour of the calling group (same labels as notes).
#[tauri::command]
pub(crate) fn set_group_color(app: AppHandle, window: WebviewWindow, color: String) -> Result<(), String> {
    check_color(&color)?;
    app.state::<Shared>()
        .update_group(&Kind::Group.id_of(&window), |g| g.color = color);
    groups_changed(&app);
    Ok(())
}

/// The bar is only a titlebar tall: while its colour picker is open the
/// window grows to `height` (CSS pixels, scaled by the zoom), then shrinks
/// back. Not saved — a group's height is always a titlebar.
#[tauri::command]
pub(crate) fn set_group_height(window: WebviewWindow, height: f64) -> Result<(), String> {
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
pub(crate) async fn toggle_group(app: AppHandle, window: WebviewWindow) {
    toggle_group_by_id(&app, &Kind::Group.id_of(&window));
}

/// Manager's Groups tab: shows group `id`'s bar and brings it to the front,
/// with its notes if the group is out.
#[tauri::command]
pub(crate) async fn focus_group(app: AppHandle, id: String) -> Result<(), String> {
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
pub(crate) async fn show_group_notes(app: AppHandle, window: WebviewWindow) {
    raise_group(&app, &Kind::Group.id_of(&window));
}

/// Brings group `id`'s bar to the front and, if the group is out, all its
/// notes with it (those closed with ✕ open again, as when taking them out).
/// The bar is focused last, so it stays on top and keeps the keyboard.
pub(crate) fn raise_group(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    let Some(group) = store.group(id) else {
        return;
    };
    if group.open {
        let closed = store
            .members(id)
            .iter()
            .any(|n| app.get_webview_window(&Kind::Note.label(&n.id)).is_none())
            || store
                .board_members(id)
                .iter()
                .any(|b| app.get_webview_window(&Kind::Board.label(&b.id)).is_none());
        if closed {
            take_out(app, id);
        }
        for note in store.members(id) {
            if let Some(window) = app.get_webview_window(&Kind::Note.label(&note.id)) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        for board in store.board_members(id) {
            if let Some(window) = app.get_webview_window(&Kind::Board.label(&board.id)) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
    }
    if let Some(bar) = app.get_webview_window(&Kind::Group.label(id)) {
        let _ = bar.unminimize();
        let _ = bar.set_focus();
    }
}

/// Reopens a group closed with ✕: its bar, and its notes if it is out.
pub(crate) fn show_group(app: &AppHandle, id: &str) {
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
pub(crate) async fn close_group(app: AppHandle, window: WebviewWindow) {
    let id = Kind::Group.id_of(&window);
    let store = app.state::<Shared>();
    if store.is_pristine_group(&id) {
        store.remove_group(&id);
    } else {
        store.update_group(&id, |g| g.hidden = true);
        for note in store.members(&id) {
            destroy_window(&app, &Kind::Note.label(&note.id));
        }
        for board in store.board_members(&id) {
            destroy_window(&app, &Kind::Board.label(&board.id));
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
pub(crate) async fn toggle_group_id(app: AppHandle, id: String) {
    toggle_group_by_id(&app, &id);
}

pub(crate) fn toggle_group_by_id(app: &AppHandle, id: &str) {
    match app.state::<Shared>().group(id) {
        Some(group) if group.open => put_in(app, id),
        Some(_) => take_out(app, id),
        None => {}
    }
}

/// Manager's "new group" button: an empty, unnamed group bar beside the
/// manager.
#[tauri::command]
pub(crate) async fn new_group(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let group = app.state::<Shared>().create_group(beside(&window));
    open_group_window(&app, &group).map_err(|e| e.to_string())?;
    groups_changed(&app);
    Ok(())
}

/// "+" on a group bar (or Mod+N there): a new note already in the group,
/// opened beside the bar. A closed group is taken out first, so the new note
/// doesn't come out alone.
#[tauri::command]
pub(crate) async fn new_note_in_group(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let id = Kind::Group.id_of(&window);
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

/// Group bar window: sends the group and its notes to the trash.
#[tauri::command]
pub(crate) async fn trash_group(app: AppHandle, window: WebviewWindow) {
    trash_group_by_id(&app, &Kind::Group.id_of(&window));
}

/// Manager's Groups tab: sends group `id` to the trash, with its notes.
#[tauri::command]
pub(crate) async fn trash_group_id(app: AppHandle, id: String) {
    trash_group_by_id(&app, &id);
}

/// A group nobody touched is removed outright (`Store::is_pristine_group`).
/// Otherwise the group
/// is marked trashed first, so its notes (trashed right after)
/// have a later `trashed_at`: that is how `restore_group` finds the notes
/// that went to the trash with it.
pub(crate) fn trash_group_by_id(app: &AppHandle, id: &str) {
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
            trash_board_by_id(app, &board.id);
        }
    }
    store.flush();
    destroy_window(app, &Kind::Group.label(id));
    groups_changed(app);
    boards_changed(app);
    notify(app);
}

/// Manager's Groups trash: brings group `id` back with the notes that went to
/// the trash with it; its bar opens, and its notes too if it is open.
#[tauri::command]
pub(crate) async fn restore_group(app: AppHandle, id: String) -> Result<(), String> {
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
pub(crate) fn delete_group_forever(app: AppHandle, id: String, store: State<'_, Shared>) {
    if store.group(&id).is_some_and(|g| g.trashed_at.is_some()) {
        store.remove_group(&id);
        store.flush();
        groups_changed(&app);
        notify(&app);
    }
}

/// Manager's Groups trash: "Empty trash".
#[tauri::command]
pub(crate) fn empty_group_trash(app: AppHandle, store: State<'_, Shared>) {
    store.empty_group_trash();
    store.flush();
    groups_changed(&app);
    notify(&app);
}
