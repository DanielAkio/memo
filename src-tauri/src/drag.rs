//! Dragging and Snap: the window follows the cursor, snaps to monitor edges
//! and other windows (magnet), Snap zones and resizing.

use crate::*;

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
pub(crate) struct Rect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) w: i32,
    pub(crate) h: i32,
}

#[derive(Clone, PartialEq, Debug)]
pub(crate) enum DropTarget {
    Group(String),
    /// Board, column, and the note it goes before (`None`: at the end).
    BoardColumn(String, String, Option<String>),
}

#[derive(Clone, serde::Deserialize, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ColumnBounds {
    pub id: String,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    /// The column's cards, top to bottom: a note dropped above a card's
    /// middle goes before it.
    #[serde(default)]
    pub cards: Vec<CardBounds>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardBounds {
    pub id: String,
    pub mid: f64,
}

pub(crate) struct Drag {
    /// Cursor offset from the window's outer corner, in logical pixels: on
    /// a monitor with another scale the window changes size, and the cursor
    /// stays on the same spot of the titlebar.
    pub(crate) grab: (f64, f64),
    /// Outer position where the drag started.
    pub(crate) start: (i32, i32),
    /// Snap zone under the cursor at the last move.
    pub(crate) zone: Option<Rect>,
    /// Drop target under the cursor (group bar or board column).
    pub(crate) drop: Option<DropTarget>,
}

#[derive(Default)]
pub(crate) struct Drags {
    /// Drags in progress, by window label.
    pub(crate) active: Mutex<HashMap<String, Drag>>,
    /// Logical size of each snapped window before it was snapped, restored
    /// when it is dragged again (not persisted).
    pub(crate) restore: Mutex<HashMap<String, (f64, f64)>>,
    /// Resizes in progress, by window label.
    pub(crate) resizes: Mutex<HashMap<String, Resize>>,
    /// Active column bounds by board id for drag-drop.
    pub(crate) board_columns: Mutex<HashMap<String, Vec<ColumnBounds>>>,
}

/// Cursor and visible rect when a resize handle was grabbed.
#[derive(Clone, Copy)]
pub(crate) struct Resize {
    pub(crate) cursor: (f64, f64),
    pub(crate) rect: Rect,
}

/// Whether the window (note, group, board or manager) is pinned, to put back
/// after a drag.
pub(crate) fn pinned(window: &WebviewWindow) -> bool {
    let store = window.state::<Shared>();
    if Kind::Group.is(window) {
        store.group(&Kind::Group.id_of(window)).is_some_and(|g| g.pinned)
    } else if Kind::Note.is(window) {
        store.get(&Kind::Note.id_of(window)).is_some_and(|n| n.pinned)
    } else if Kind::Board.is(window) {
        store.board(&Kind::Board.id_of(window)).is_some_and(|b| b.pinned)
    } else {
        store.manager().pinned
    }
}

/// The Snap zone under `cursor`, as the visible rect the window would get:
/// within `SNAP_EDGE` of the left/right edge of a monitor → that half of its
/// work area, or a quarter in the top/bottom fifth (near a corner); of the
/// top edge → the whole work area, or a quarter near a corner. Rects keep the
/// magnet's `SNAP_GAP` from the edges and between halves.
pub(crate) fn snap_zone(window: &WebviewWindow, cursor: (f64, f64)) -> Option<Rect> {
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
pub(crate) fn build_snap_preview(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, SNAP_PREVIEW, WebviewUrl::App("windows/snap/snap.html".into()))
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
pub(crate) fn show_snap_preview(app: &AppHandle, rect: Option<Rect>) {
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
pub(crate) fn drag_start(window: WebviewWindow, drags: State<'_, Drags>) {
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
pub(crate) fn drag_to(window: WebviewWindow, drags: State<'_, Drags>) {
    drag_move(&window, &drags);
}

pub(crate) fn drag_move(window: &WebviewWindow, drags: &Drags) {
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
    if Kind::Note.is(window) || Kind::Board.is(window) {
        let target = if let Some(gid) = group_under(window, cursor) {
            Some(DropTarget::Group(gid))
        } else if Kind::Note.is(window) {
            if let Some((bid, cid, before)) = board_col_under(app, cursor) {
                Some(DropTarget::BoardColumn(bid, cid, before))
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
                Some(DropTarget::BoardColumn(bid, cid, before)) => {
                    let _ = app.emit("board-drop-hover", (bid, cid, false, before));
                }
                None => {}
            }
            match &target {
                Some(DropTarget::Group(new)) => {
                    let _ = app.emit("drop-hover", (new, true));
                }
                Some(DropTarget::BoardColumn(bid, cid, before)) => {
                    let _ = app.emit("board-drop-hover", (bid, cid, true, before));
                }
                None => {}
            }
            drag.drop = target;
        }
    }
    // Group bars don't Snap (a half-screen titlebar).
    drag.zone = if Kind::Group.is(window) || drag.drop.is_some() {
        None
    } else {
        snap_zone(window, cursor)
    };
    show_snap_preview(app, drag.zone);
}

/// The group bar under `cursor` (not the note or board's own group), by id.
pub(crate) fn group_under(window: &WebviewWindow, cursor: (f64, f64)) -> Option<String> {
    let own = if Kind::Note.is(window) {
        window
            .state::<Shared>()
            .get(&Kind::Note.id_of(window))
            .map(|n| n.group_id)
            .unwrap_or_default()
    } else if Kind::Board.is(window) {
        window
            .state::<Shared>()
            .board(&Kind::Board.id_of(window))
            .map(|b| b.group_id)
            .unwrap_or_default()
    } else {
        String::new()
    };
    window.app_handle()
        .webview_windows()
        .into_values()
        .filter(|w| {
            Kind::Group.is(w) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false)
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
        .map(|w| Kind::Group.id_of(&w))
        .filter(|id| *id != own)
}

/// The board column under `cursor`, if any, and the note a drop there goes
/// before (the first card whose middle is below the cursor; `None`: the end).
pub(crate) fn board_col_under(app: &AppHandle, cursor: (f64, f64)) -> Option<(String, String, Option<String>)> {
    let board_windows: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| Kind::Board.is(w) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .collect();

    for w in board_windows {
        let (Some((bx, by)), Some((bw, bh))) = (desk::inner_position(&w), desk::inner_size(&w)) else {
            continue;
        };
        if cursor.0 >= bx as f64 && cursor.0 < (bx + bw) as f64 && cursor.1 >= by as f64 && cursor.1 < (by + bh) as f64 {
            let rel_x = cursor.0 - bx as f64;
            let rel_y = cursor.1 - by as f64;
            let bid = Kind::Board.id_of(&w);
            let drags = app.state::<Drags>();
            let cols = drags.board_columns.lock().unwrap().get(&bid).cloned().unwrap_or_default();
            for col in cols {
                if rel_x >= col.left && rel_x < col.right && rel_y >= col.top && rel_y < col.bottom {
                    let before = col.cards.iter().find(|c| rel_y < c.mid).map(|c| c.id.clone());
                    return Some((bid, col.id, before));
                }
            }
        }
    }
    None
}

/// End of the drag: final move, then, if released in a Snap zone, the window
/// takes the zone's rect (its size is kept to restore on the next drag).
#[tauri::command]
pub(crate) fn drag_end(window: WebviewWindow, drags: State<'_, Drags>) {
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
                if Kind::Board.is(&window) {
                    join_group(app, Kind::Board, &Kind::Board.id_of(&window), &group, Some(drag.start));
                } else {
                    join_group(app, Kind::Note, &Kind::Note.id_of(&window), &group, Some(drag.start));
                }
                return;
            }
            DropTarget::BoardColumn(bid, cid, before) => {
                let _ = app.emit("board-drop-hover", (&bid, &cid, false, &before));
                let note_id = Kind::Note.id_of(&window);
                let store = app.state::<Shared>();
                store.update_board(&bid, |b| {
                    for col in &mut b.columns {
                        col.note_ids.retain(|id| id != &note_id);
                    }
                    if let Some(col) = b.columns.iter_mut().find(|c| c.id == cid) {
                        match before.as_ref().and_then(|id| col.note_ids.iter().position(|n| n == id)) {
                            Some(at) => col.note_ids.insert(at, note_id.clone()),
                            None => col.note_ids.push(note_id.clone()),
                        }
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
pub(crate) fn resize_start(window: WebviewWindow, drags: State<'_, Drags>) {
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
pub(crate) fn resize_to(window: WebviewWindow, edges: String, drags: State<'_, Drags>) {
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
    let min_w = if Kind::Note.is(&window) {
        MIN_W
    } else if Kind::Group.is(&window) {
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
    if Kind::Note.is(&window)
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

pub(crate) fn create_and_open(app: &AppHandle, pos: Option<(i32, i32)>) -> tauri::Result<()> {
    let note = app.state::<Shared>().create(pos);
    let window = open_note_window(app, &note)?;
    let _ = window.set_focus();
    notify(app);
    Ok(())
}

/// Tray "Show all memories", relaunch and Dock reopen: brings every note to
/// the front, or opens a new one when none is open.
pub(crate) fn show_all(app: &AppHandle) {
    if !raise_notes(app) {
        let _ = create_and_open(app, None);
    }
}

/// Brings every open note window and group bar to the front (restoring
/// minimised ones). Notes are raised first and group bars last, so the
/// groups end up on top. Returns `false` if there is none.
pub(crate) fn raise_notes(app: &AppHandle) -> bool {
    let mut windows: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| Kind::Note.is(w) || Kind::Group.is(w) || Kind::Board.is(w))
        .collect();
    // Each focused window goes on top of the previous ones.
    windows.sort_by_key(|w| Kind::Group.is(w));
    for window in &windows {
        reveal(window);
    }
    !windows.is_empty()
}

/// Moves a note to the trash (closing its window, if open). A note nobody
/// touched (empty, or only the default title and text) and a welcome note
/// reopened from Help are deleted outright so they don't clutter the trash.
pub(crate) fn trash(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    match store.get(id) {
        Some(note) if note.welcome_copy || store.is_pristine(&note) => store.remove(id),
        Some(_) => {
            store.update(id, |n| n.trashed_at = Some(now_ms()));
        }
        None => {}
    }
    store.flush();
    destroy_window(app, &Kind::Note.label(id));
    notify(app);
}
