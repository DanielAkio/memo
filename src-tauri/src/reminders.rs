//! Reminders: when a memory's `remind_at` comes, it opens (even if closed),
//! comes to the front pinned, and the system shows a notification. One
//! missed while the app was closed fires on the next launch.

use crate::*;
use tauri_plugin_notification::NotificationExt;

/// How often due reminders are looked for.
const CHECK_EVERY: Duration = Duration::from_secs(20);

pub(crate) fn start(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        fire_due(&app);
        thread::sleep(CHECK_EVERY);
    });
}

fn fire_due(app: &AppHandle) {
    let store = app.state::<Shared>();
    for id in store.due_reminders(now_ms()) {
        let Some(note) = store.update(&id, |n| {
            n.remind_at = None;
            n.pinned = true;
        }) else {
            continue;
        };
        // Built off the main thread, as `open_memory` does (mcp.rs).
        let _ = tauri::async_runtime::block_on(open_note(app.clone(), id.clone()));
        let label = Kind::Note.label(&id);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.set_always_on_top(true);
            // An open window shows the pin and drops the reminder pill.
            let _ = window.emit_to(&label, "reminder-fired", ());
            reveal(&window);
        }
        let untitled = tray_labels(store.effective_language()).untitled;
        let (title, body) = notification_text(&note, untitled);
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// The memory's name (or `untitled`) and its first line of text.
pub(crate) fn notification_text(note: &Note, untitled: &str) -> (String, String) {
    let first = note.text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let first = first.trim_start_matches("[ ] ").trim_start_matches("[x] ");
    let title = if note.title.trim().is_empty() { untitled } else { note.title.trim() };
    (title.to_string(), first.chars().take(120).collect())
}
