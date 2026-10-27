//! AI control: an MCP (Model Context Protocol) server, so any MCP client
//! (Claude, Codex, Copilot in VS Code, Cursor, Gemini CLI…) can read and change
//! memories and groups. Off until turned on in Settings or the tray.
//!
//! Two halves, in the same executable:
//!
//! - **In the app** (`start` / `stop`): a JSON-RPC endpoint over HTTP on
//!   127.0.0.1, on a random port, behind a random bearer token. While it runs,
//!   port and token are in `mcp.json` in the default data folder. Changes go
//!   through the same code as the windows', so the screen follows at once.
//! - **`memo --mcp`** (`bridge`): the stdio server MCP clients launch. It
//!   answers `initialize` and `tools/list` itself and forwards tool calls to
//!   the app, opening Memo first when it isn't running.

use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    beside, close_note_by_id, groups_changed, is_app_window, join_group, leave_group, notify,
    open_group_window, open_note, put_in, rename_by_id, Kind,
    restore_group, restore_note, show_group, take_out, trash, trash_group_by_id, Shared,
    AUTOSTART_ARG, CONFIG, DATA_FOLDER, MANAGER,
};
use crate::store::{is_valid_color, Config, Group, Note, Store, TITLE_MAX};

/// Command-line argument that runs the stdio server instead of the app.
pub const ARG: &str = "--mcp";
/// Port and token of the running app's endpoint, in the default data folder.
const SESSION: &str = "mcp.json";
/// Newest MCP revision spoken; older clients get their own back.
const PROTOCOL: &str = "2025-06-18";
const PROTOCOLS: [&str; 4] = ["2025-06-18", "2025-03-26", "2024-11-05", PROTOCOL];
/// Largest request body accepted (a memory with images can be big).
const BODY_MAX: usize = 32 << 20;
/// How long the bridge waits for Memo to open and answer.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);
/// Size of the text preview in `list_memories`.
const PREVIEW: usize = 200;

const INSTRUCTIONS: &str = "Memo is a sticky-notes desktop app. Each note (a \"memory\") is its own \
small window on the user's screen; pinned ones stay above every other app. Memories can be \
gathered in groups, shown as compact bars whose memories can be taken out on screen or put away. \
Memory text is plain text with a few conventions: one line per paragraph, \"[ ] item\" and \
\"[x] item\" for checklist items, \"- item\" for bullets, \"1. item\" for numbered items (Memo \
numbers them itself; two leading spaces per extra level, up to 4), `inline code`, \
links as \"[text](https://address)\" (web or mailto: addresses; a bare https:// or www. address is a link \
to itself, and the user opens links in the browser with a click), ``` fences (optionally with a language) for code blocks, \
and tables as consecutive \"| a | b |\" lines (a \"| --- | --- |\" line after the first row makes it a header; \
\"\\|\" is a \"|\" inside a cell). Images show \
as \"[image]\"/\"[imagem]\" and cannot be created here. Colours: yellow, green, coral, teal, \
iris (purple), mono (white in the dark theme, black in the light one), \"\" for none, \
or a custom \"#rrggbb\". Unless Memo's settings say otherwise, new memories start with no colour \
and new groups with a random one. Deleting for good is only possible in Memo's manager: trashed items can \
be restored for 30 days.";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

fn tool(name: &str, description: &str, properties: Value, required: &[&str], read_only: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        },
        "annotations": { "readOnlyHint": read_only, "destructiveHint": false },
    })
}

fn tools() -> Value {
    let id = json!({ "type": "string", "description": "The memory's id." });
    let group_id = json!({ "type": "string", "description": "The group's id." });
    let color = json!({
        "type": "string",
        "description": "yellow, green, coral, teal, iris, mono, \"\" (none) or \"#rrggbb\".",
    });
    let title = json!({ "type": "string", "description": "Name shown in the titlebar (\"\" = untitled, max 80 characters)." });
    let pinned = json!({ "type": "boolean", "description": "Keep it above every other app." });
    json!([
        tool(
            "list_memories",
            "List memories, newest change first, with a short preview of their text. Filter by text, group or trash.",
            json!({
                "query": { "type": "string", "description": "Only memories whose title or text contains this (case-insensitive)." },
                "group_id": { "type": "string", "description": "Only memories in this group; \"\" = only memories in no group." },
                "in_trash": { "type": "boolean", "description": "List the trash instead of the current memories.", "default": false },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500, "default": 50 },
            }),
            &[],
            true,
        ),
        tool("get_memory", "Read one memory in full.", json!({ "id": id }), &["id"], true),
        tool(
            "create_memory",
            "Create a memory. Fields left out take the defaults set in Memo's settings. Opens its window unless open is false or it goes into a group that is put away.",
            json!({
                "title": title,
                "text": { "type": "string", "description": "Content, in the plain-text format described in the server instructions." },
                "color": color,
                "pinned": pinned,
                "group_id": { "type": "string", "description": "Put it in this group." },
                "open": { "type": "boolean", "description": "Show its window on screen.", "default": true },
            }),
            &[],
            false,
        ),
        tool(
            "update_memory",
            "Change a memory. text replaces the whole content (dropping its formatting and images); append adds lines at the end and keeps the rest as it is.",
            json!({
                "id": id,
                "title": title,
                "text": { "type": "string", "description": "New content, replacing the current one." },
                "append": { "type": "string", "description": "Lines to add at the end." },
                "color": color,
                "pinned": pinned,
            }),
            &["id"],
            false,
        ),
        tool(
            "open_memory",
            "Show a memory's window and bring it to the front (a memory in a group that is put away takes the whole group out).",
            json!({ "id": id }),
            &["id"],
            false,
        ),
        tool(
            "close_memory",
            "Close a memory's window. It stays among the current memories (not the trash) and can be opened again.",
            json!({ "id": id }),
            &["id"],
            false,
        ),
        tool(
            "trash_memory",
            "Move a memory to the trash (restorable for 30 days). A memory nobody wrote in is deleted instead.",
            json!({ "id": id }),
            &["id"],
            false,
        ),
        tool("restore_memory", "Bring a memory back from the trash.", json!({ "id": id }), &["id"], false),
        tool(
            "list_groups",
            "List groups with their memories (id and title).",
            json!({ "in_trash": { "type": "boolean", "description": "List the trash instead of the current groups.", "default": false } }),
            &[],
            true,
        ),
        tool(
            "create_group",
            "Create a group; its bar opens on screen.",
            json!({
                "name": { "type": "string", "description": "Name (\"\" = untitled, max 60 characters)." },
                "color": color,
                "pinned": pinned,
            }),
            &[],
            false,
        ),
        tool(
            "update_group",
            "Change a group: name, colour, pin, and whether its memories are out on screen or put away in the bar.",
            json!({
                "id": group_id,
                "name": { "type": "string", "description": "New name (\"\" = untitled)." },
                "color": color,
                "pinned": pinned,
                "memories_out": { "type": "boolean", "description": "true takes its memories out on screen, false puts them away in the bar." },
            }),
            &["id"],
            false,
        ),
        tool(
            "move_memory_to_group",
            "Put a memory in a group, or take it out of its group with group_id \"\".",
            json!({ "id": id, "group_id": { "type": "string", "description": "Target group's id; \"\" = no group." } }),
            &["id", "group_id"],
            false,
        ),
        tool(
            "trash_group",
            "Move a group and its memories to the trash (restorable for 30 days).",
            json!({ "id": group_id }),
            &["id"],
            false,
        ),
        tool(
            "restore_group",
            "Bring a group back from the trash, with the memories that went with it.",
            json!({ "id": group_id }),
            &["id"],
            false,
        ),
        tool(
            "share_item",
            "Text to share a memory, a board or a group (with its memories and boards) with someone: readable, ending in a code Memo imports. Images are not shared.",
            json!({
                "kind": { "type": "string", "enum": ["note", "board", "group"], "description": "What to share." },
                "id": { "type": "string", "description": "Its id." },
            }),
            &["kind", "id"],
            true,
        ),
        tool(
            "import_shared",
            "Import what someone shared (a text with a memo:v1: code) as new memories, boards or groups; the shared item opens on screen.",
            json!({ "text": { "type": "string", "description": "The shared text, or just its code." } }),
            &["text"],
            false,
        ),
    ])
}

/// Runs a tool in the app; `Ok` is the result shown to the client.
fn run(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let store = app.state::<Shared>();
    match name {
        "list_memories" => {
            let in_trash = bool_arg(args, "in_trash").unwrap_or(false);
            let query = str_arg(args, "query").unwrap_or("").to_lowercase();
            let group = str_arg(args, "group_id");
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 500) as usize;
            let mut notes: Vec<Note> = store
                .all()
                .into_iter()
                .filter(|n| n.trashed_at.is_some() == in_trash)
                .filter(|n| group.map_or(true, |g| n.group_id == g))
                .filter(|n| {
                    query.is_empty()
                        || n.title.to_lowercase().contains(&query)
                        || n.text.to_lowercase().contains(&query)
                })
                .collect();
            notes.sort_by_key(|n| std::cmp::Reverse(n.updated_at));
            let total = notes.len();
            let memories: Vec<Value> = notes.iter().take(limit).map(|n| memory(app, &store, n, false)).collect();
            Ok(json!({ "total": total, "memories": memories }))
        }
        "get_memory" => {
            let note = note_arg(&store, args)?;
            Ok(memory(app, &store, &note, true))
        }
        "create_memory" => {
            let color = color_arg(args)?;
            let group = match str_arg(args, "group_id").filter(|g| !g.is_empty()) {
                Some(id) => Some(active_group(&store, id)?),
                None => None,
            };
            let note = store.create(anchor(app));
            let note = store
                .update(&note.id, |n| {
                    if let Some(title) = str_arg(args, "title") {
                        n.title = clean_title(title);
                    }
                    if let Some(text) = str_arg(args, "text") {
                        n.text = normalize(text);
                        n.html = from_plain(&n.text);
                    }
                    if let Some(color) = color {
                        n.color = color;
                    }
                    if let Some(pinned) = bool_arg(args, "pinned") {
                        n.pinned = pinned;
                    }
                    if let Some(group) = &group {
                        n.group_id = group.id.clone();
                    }
                })
                .unwrap_or(note);
            store.flush();
            let shown = group.as_ref().map_or(true, |g| g.open && !g.hidden);
            if shown && bool_arg(args, "open").unwrap_or(true) {
                crate::open_note_window(app, &note).map_err(|e| e.to_string())?;
            } else {
                store.update(&note.id, |n| n.hidden = true);
            }
            if group.is_some() {
                groups_changed(app);
            }
            notify(app);
            Ok(memory(app, &store, &store.get(&note.id).unwrap_or(note), true))
        }
        "update_memory" => {
            let note = note_arg(&store, args)?;
            if note.trashed_at.is_some() {
                return Err("this memory is in the trash: restore it first".into());
            }
            let color = color_arg(args)?;
            let pinned = bool_arg(args, "pinned");
            let updated = store
                .update(&note.id, |n| {
                    if let Some(title) = str_arg(args, "title") {
                        n.title = clean_title(title);
                    }
                    if let Some(text) = str_arg(args, "text") {
                        n.text = normalize(text);
                        n.html = from_plain(&n.text);
                    }
                    if let Some(more) = str_arg(args, "append").filter(|s| !s.is_empty()) {
                        let more = normalize(more);
                        if n.text.trim().is_empty() && n.html.is_empty() {
                            n.text = more;
                            n.html = from_plain(&n.text);
                        } else {
                            n.text = format!("{}\n{more}", n.text.trim_end_matches('\n'));
                            // Notes without HTML are rebuilt from their text.
                            if !n.html.is_empty() {
                                n.html.push_str(&from_plain(&more));
                            }
                        }
                    }
                    if let Some(color) = color {
                        n.color = color;
                    }
                    if let Some(pinned) = pinned {
                        n.pinned = pinned;
                    }
                })
                .ok_or("memory not found")?;
            store.flush();
            // An open window shows the new content after a reload, as when
            // sync brings a change.
            if let Some(window) = app.get_webview_window(&Kind::Note.label(&note.id)) {
                if let Some(pinned) = pinned {
                    let _ = window.set_always_on_top(pinned);
                }
                let _ = window.reload();
            }
            notify(app);
            Ok(memory(app, &store, &updated, true))
        }
        "open_memory" => {
            let note = note_arg(&store, args)?;
            tauri::async_runtime::block_on(open_note(app.clone(), note.id.clone()))?;
            Ok(memory(app, &store, &store.get(&note.id).unwrap_or(note), false))
        }
        "close_memory" => {
            let note = note_arg(&store, args)?;
            close_note_by_id(app, &note.id);
            wait_closed(app, &Kind::Note.label(&note.id));
            Ok(json!({ "closed": note.id, "deleted": store.get(&note.id).is_none() }))
        }
        "trash_memory" => {
            let note = note_arg(&store, args)?;
            trash(app, &note.id);
            wait_closed(app, &Kind::Note.label(&note.id));
            Ok(json!({ "trashed": note.id, "deleted": store.get(&note.id).is_none() }))
        }
        "restore_memory" => {
            let note = note_arg(&store, args)?;
            if note.trashed_at.is_none() {
                return Err("this memory is not in the trash".into());
            }
            tauri::async_runtime::block_on(restore_note(app.clone(), note.id.clone()))?;
            Ok(memory(app, &store, &store.get(&note.id).unwrap_or(note), false))
        }
        "list_groups" => {
            let in_trash = bool_arg(args, "in_trash").unwrap_or(false);
            let groups: Vec<Value> = store
                .groups()
                .iter()
                .filter(|g| g.trashed_at.is_some() == in_trash)
                .map(|g| group_json(&store, g))
                .collect();
            Ok(json!({ "groups": groups }))
        }
        "create_group" => {
            let color = color_arg(args)?;
            let group = store.create_group(anchor(app));
            let group = store
                .update_group(&group.id, |g| {
                    if let Some(name) = str_arg(args, "name") {
                        g.name = clean_group_name(name);
                    }
                    if let Some(color) = color {
                        g.color = color;
                    }
                    if let Some(pinned) = bool_arg(args, "pinned") {
                        g.pinned = pinned;
                    }
                })
                .unwrap_or(group);
            store.flush();
            open_group_window(app, &group).map_err(|e| e.to_string())?;
            groups_changed(app);
            Ok(group_json(&store, &group))
        }
        "update_group" => {
            let group = active_group(&store, req_str(args, "id")?)?;
            let id = group.id.as_str();
            let color = color_arg(args)?;
            if let Some(name) = str_arg(args, "name") {
                rename_by_id(app, Kind::Group, id, name);
            }
            let pinned = bool_arg(args, "pinned");
            store.update_group(id, |g| {
                if let Some(color) = color {
                    g.color = color;
                }
                if let Some(pinned) = pinned {
                    g.pinned = pinned;
                }
            });
            if let (Some(pinned), Some(window)) = (pinned, app.get_webview_window(&Kind::Group.label(id))) {
                let _ = window.set_always_on_top(pinned);
            }
            match bool_arg(args, "memories_out") {
                Some(true) => {
                    if group.hidden {
                        show_group(app, id);
                    }
                    if !group.open {
                        take_out(app, id);
                    }
                }
                Some(false) if group.open => put_in(app, id),
                _ => {}
            }
            store.flush();
            groups_changed(app);
            notify(app);
            Ok(group_json(&store, &store.group(id).unwrap_or(group)))
        }
        "move_memory_to_group" => {
            let note = note_arg(&store, args)?;
            if note.trashed_at.is_some() {
                return Err("this memory is in the trash: restore it first".into());
            }
            match req_str(args, "group_id")? {
                "" => leave_group(app, Kind::Note, &note.id),
                id => {
                    active_group(&store, id)?;
                    join_group(app, Kind::Note, &note.id, id, None);
                }
            }
            Ok(memory(app, &store, &store.get(&note.id).unwrap_or(note), false))
        }
        "trash_group" => {
            let group = active_group(&store, req_str(args, "id")?)?;
            trash_group_by_id(app, &group.id);
            wait_closed(app, &Kind::Group.label(&group.id));
            Ok(json!({ "trashed": group.id, "deleted": store.group(&group.id).is_none() }))
        }
        "restore_group" => {
            let id = req_str(args, "id")?.to_string();
            tauri::async_runtime::block_on(restore_group(app.clone(), id.clone()))?;
            let group = store.group(&id).ok_or("group not found")?;
            Ok(group_json(&store, &group))
        }
        "share_item" => {
            let kind = match req_str(args, "kind")? {
                "note" => Kind::Note,
                "board" => Kind::Board,
                "group" => Kind::Group,
                other => return Err(format!("unknown kind: {other}")),
            };
            let text = crate::share::share_text(&store, kind, req_str(args, "id")?)?;
            Ok(json!({ "text": text }))
        }
        "import_shared" => {
            let payload = crate::share::decode(req_str(args, "text")?).ok_or("no valid memo:v1: code in the text")?;
            crate::share::import(app, &payload, None);
            Ok(json!({ "imported": crate::share::summary(&payload) }))
        }
        _ => Err(format!("unknown tool: {name}")),
    }
}

/// Windows are destroyed on the main thread, after the call that asked for
/// it returns: waits (briefly) until the window is gone, so the next call
/// (opening it again, listing) sees it closed.
fn wait_closed(app: &AppHandle, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while app.get_webview_window(label).is_some() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
}

fn memory(app: &AppHandle, store: &Store, n: &Note, full: bool) -> Value {
    let group = store
        .group(&n.group_id)
        .map(|g| json!({ "id": g.id, "name": g.name }));
    let text = if full || n.text.chars().count() <= PREVIEW {
        n.text.clone()
    } else {
        n.text.chars().take(PREVIEW).collect::<String>() + "…"
    };
    json!({
        "id": n.id,
        "title": n.title,
        "text": text,
        "color": n.color,
        "pinned": n.pinned,
        "onScreen": app.get_webview_window(&Kind::Note.label(&n.id)).is_some(),
        "group": group,
        "inTrash": n.trashed_at.is_some(),
        "createdAt": iso(n.created_at),
        "updatedAt": iso(n.updated_at),
    })
}

fn group_json(store: &Store, g: &Group) -> Value {
    let memories: Vec<Value> = store
        .all()
        .iter()
        .filter(|n| n.group_id == g.id && n.trashed_at.is_some() == g.trashed_at.is_some())
        .map(|n| json!({ "id": n.id, "title": n.title }))
        .collect();
    json!({
        "id": g.id,
        "name": g.name,
        "color": g.color,
        "pinned": g.pinned,
        "memoriesOut": g.open,
        "closed": g.hidden,
        "inTrash": g.trashed_at.is_some(),
        "memories": memories,
    })
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn req_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    str_arg(args, key).ok_or_else(|| format!("missing argument: {key}"))
}

fn bool_arg(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

fn color_arg(args: &Value) -> Result<Option<String>, String> {
    match str_arg(args, "color") {
        Some(c) => {
            let c = c.trim().to_lowercase();
            let c = if c == "purple" { "iris".to_string() } else { c };
            if is_valid_color(&c) {
                Ok(Some(c))
            } else {
                Err(format!("unknown color: {c}"))
            }
        }
        None => Ok(None),
    }
}

fn note_arg(store: &Store, args: &Value) -> Result<Note, String> {
    store.get(req_str(args, "id")?).ok_or_else(|| "memory not found".into())
}

fn active_group(store: &Store, id: &str) -> Result<Group, String> {
    store
        .group(id)
        .filter(|g| g.trashed_at.is_none())
        .ok_or_else(|| format!("group not found: {id}"))
}

fn clean_title(title: &str) -> String {
    title.trim().chars().take(TITLE_MAX).collect()
}

fn clean_group_name(name: &str) -> String {
    name.trim().chars().take(crate::store::GROUP_NAME_MAX).collect()
}

fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n").replace('\u{200B}', "")
}

/// Where a new note or group bar goes: beside the window in use (or the
/// manager, or any note), like the "+" buttons; centred when none is open.
fn anchor(app: &AppHandle) -> Option<(i32, i32)> {
    let windows = app.webview_windows();
    let visible = |w: &&tauri::WebviewWindow| w.is_visible().unwrap_or(false);
    let parent = windows
        .values()
        .filter(visible)
        .find(|w| is_app_window(w) && w.is_focused().unwrap_or(false))
        .or_else(|| windows.get(MANAGER).filter(visible))
        .or_else(|| windows.values().filter(visible).find(|w| Kind::Note.is(w)))?;
    beside(parent)
}

/// A memory's HTML from its plain text: the Rust twin of `fromPlain` in
/// note.js (lines, checklist items, bullets, numbered items, inline code,
/// links, code blocks, tables).
fn from_plain(text: &str) -> String {
    if text.is_empty() {
        return "<div><br></div>".into();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(lang) = fence_open(line) {
            if let Some(end) = (i + 1..lines.len()).find(|&j| lines[j].trim_end() == "```") {
                let body = lines[i + 1..end].join("\n");
                let lang = if lang.is_empty() { String::new() } else { format!(" data-lang=\"{}\"", esc(lang)) };
                let body = if body.is_empty() { "<br>".into() } else { esc(&body) };
                out.push_str(&format!("<pre class=\"code\"{lang}>{body}</pre>"));
                i = end + 1;
                continue;
            }
        }
        if is_table_row(line) {
            let end = (i..lines.len()).take_while(|&j| is_table_row(lines[j])).last().unwrap_or(i);
            let mut rows: Vec<Vec<String>> = lines[i..=end].iter().map(|l| row_cells(l)).collect();
            let head = rows.len() > 1 && is_table_sep(lines[i + 1]);
            if head {
                rows.remove(1);
            }
            let cols = rows.iter().map(Vec::len).max().unwrap_or(1);
            out.push_str(if head { "<table class=\"head\"><tbody>" } else { "<table><tbody>" });
            for row in &rows {
                out.push_str("<tr>");
                for c in 0..cols {
                    let cell = row.get(c).map(String::as_str).unwrap_or("");
                    let body = if cell.is_empty() { "<br>".into() } else { inline(cell) };
                    out.push_str(&format!("<td>{body}</td>"));
                }
                out.push_str("</tr>");
            }
            out.push_str("</tbody></table>");
            i = end + 1;
            continue;
        }
        match list_item(line) {
            Some((level, class, body)) => {
                let level = if level > 0 { format!(" data-level=\"{level}\"") } else { String::new() };
                let body = if body.is_empty() { "<br>".into() } else { inline(body) };
                out.push_str(&format!("<div class=\"{class}\"{level}>{body}</div>"));
            }
            None => {
                let body = if line.is_empty() { "<br>".into() } else { inline(line) };
                out.push_str(&format!("<div>{body}</div>"));
            }
        }
        i += 1;
    }
    out
}

/// A table row, "| a | b |" (as `TABLE_ROW_RE` in components/text.js).
fn is_table_row(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 2 && t.starts_with('|') && t.ends_with('|')
}

/// The "| --- | --- |" line after a header row (as `TABLE_SEP_RE`).
fn is_table_sep(line: &str) -> bool {
    let t = line.trim();
    is_table_row(t)
        && t[1..t.len() - 1].split('|').all(|c| {
            let c = c.trim().trim_start_matches(':').trim_end_matches(':');
            !c.is_empty() && c.chars().all(|ch| ch == '-')
        })
}

/// The cells of a "| a | b |" line; "\|" is a "|" inside a cell.
fn row_cells(line: &str) -> Vec<String> {
    let t = line.trim();
    let inner = &t[1..t.len() - 1];
    let mut cells = vec![String::new()];
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                cells.last_mut().unwrap().push('|');
                chars.next();
            }
            '|' => cells.push(String::new()),
            _ => cells.last_mut().unwrap().push(c),
        }
    }
    cells.into_iter().map(|c| c.trim().to_string()).collect()
}

/// "```lang" opening a code block (as `/^```([\w+#.-]*)\s*$/`): the language.
fn fence_open(line: &str) -> Option<&str> {
    let lang = line.strip_prefix("```")?.trim_end();
    lang.chars()
        .all(|c| c.is_alphanumeric() || c == '_' || "+#.-".contains(c))
        .then_some(lang)
}

/// A checklist item, bullet or numbered item (as `LIST_RE` in components/text.js):
/// level, class, text.
fn list_item(line: &str) -> Option<(usize, &'static str, &str)> {
    let rest = line.trim_start_matches(' ');
    let level = ((line.len() - rest.len()) / 2).min(4);
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let (class, after) = if let Some(after) = rest.strip_prefix('-') {
        ("bullet", after)
    } else if digits > 0 {
        ("number", rest[digits..].strip_prefix('.')?)
    } else {
        let inner = rest.strip_prefix('[')?;
        let (mark, after) = match inner.chars().next()? {
            ']' => ("", &inner[1..]),
            c @ (' ' | 'x' | 'X') => (if c == ' ' { "" } else { "x" }, inner[1..].strip_prefix(']')?),
            _ => return None,
        };
        (if mark.is_empty() { "check" } else { "check done" }, after)
    };
    if !(after.is_empty() || after.starts_with(' ')) {
        return None;
    }
    Some((level, class, after.strip_prefix(' ').unwrap_or(after)))
}

/// Escapes a line and turns `x` into inline code (as the regex in note.js:
/// a backtick opens code only when another one closes it with something in
/// between).
fn inline(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(open) = rest.find('`') {
        out.push_str(&links(&rest[..open]));
        let after = &rest[open + 1..];
        match after.find('`') {
            Some(close) if close > 0 => {
                out.push_str(&format!("<code>{}</code>", esc(&after[..close])));
                rest = &after[close + 1..];
            }
            _ => {
                out.push('`');
                rest = after;
            }
        }
    }
    out.push_str(&links(rest));
    out
}

/// Escapes text and turns its links into `<a href>`: "[text](address)" with
/// a web or mail address, and bare "https://…" / "www.…" addresses (as
/// `linkHtml` in note.js).
fn links(s: &str) -> String {
    let mut out = String::new();
    let (mut last, mut i) = (0, 0);
    while i < s.len() {
        let rest = &s[i..];
        let link = plain_link(rest).or_else(|| {
            // A bare address starts a word (as the regex's lookbehind).
            let prev = s[..i].chars().next_back();
            let starts = !prev.is_some_and(|c| c.is_ascii_alphanumeric() || "_@./".contains(c));
            starts
                .then(|| bare_url(rest))
                .flatten()
                .map(|url| {
                    let href = if starts_ci(url, "www.") { format!("https://{url}") } else { url.to_string() };
                    (url, href, url.len())
                })
        });
        match link {
            Some((text, href, len)) => {
                out.push_str(&esc(&s[last..i]));
                out.push_str(&format!("<a href=\"{}\">{}</a>", esc(&href), esc(text)));
                i += len;
                last = i;
            }
            None => i += rest.chars().next().map_or(1, char::len_utf8),
        }
    }
    out.push_str(&esc(&s[last..]));
    out
}

fn starts_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// "[text](address)" at the start of `s`: (text, address, length).
fn plain_link(s: &str) -> Option<(&str, String, usize)> {
    let body = s.strip_prefix('[')?;
    let close = body.find(']')?;
    let text = &body[..close];
    if text.is_empty() || text.contains('\n') {
        return None;
    }
    let target = body[close + 1..].strip_prefix('(')?;
    let end = target.find(|c: char| c == ')' || c.is_whitespace())?;
    let href = &target[..end];
    let scheme = ["http://", "https://", "mailto:"].into_iter().find(|p| starts_ci(href, p))?;
    if href.len() == scheme.len() || !target[end..].starts_with(')') {
        return None;
    }
    Some((text, href.to_string(), 1 + close + 2 + end + 1))
}

/// A bare web address at the start of `s`, without the punctuation that
/// usually follows one in a sentence.
fn bare_url(s: &str) -> Option<&str> {
    let end = s.find(|c: char| c.is_whitespace() || "<>\"".contains(c)).unwrap_or(s.len());
    let word = &s[..end];
    if starts_ci(word, "www.") {
        // "www." + a name + "." + something.
        let name = &word[4..];
        let dot = name.find(['.', '/'])?;
        if dot == 0 || !name[dot..].starts_with('.') || name.len() == dot + 1 {
            return None;
        }
    } else if !["http://", "https://"].into_iter().any(|p| starts_ci(word, p) && word.len() > p.len()) {
        return None;
    }
    let mut url = word;
    while let Some(last) = url.chars().next_back() {
        let unbalanced = |open: char, close: char| last == close && url.matches(open).count() < url.matches(close).count();
        if !".,;:!?'\"*".contains(last) && !unbalanced('(', ')') && !unbalanced('[', ']') {
            break;
        }
        url = &url[..url.len() - last.len_utf8()];
    }
    (!url.is_empty()).then_some(url)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// UTC date and time of a timestamp in ms, as ISO 8601.
fn iso(ms: u64) -> String {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

/// Answer to one JSON-RPC message (`None` for notifications). `call` runs a
/// tool and returns its MCP result.
fn reply(msg: &Value, call: &dyn Fn(&str, &Value) -> Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match msg.get("method").and_then(Value::as_str).unwrap_or("") {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            let version = if PROTOCOLS.contains(&asked) { asked } else { PROTOCOL };
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "memo", "title": "Memo", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" | "logging/setLevel" => json!({}),
        // Not offered (see capabilities), but some clients ask anyway.
        "resources/list" => json!({ "resources": [] }),
        "resources/templates/list" => json!({ "resourceTemplates": [] }),
        "prompts/list" => json!({ "prompts": [] }),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            call(name, &args)
        }
        method => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") },
            }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn tool_result(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }],
            "isError": false,
        }),
        Err(err) => tool_error(&err),
    }
}

fn tool_error(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

// ---------------------------------------------------------------------------
// In the app: the local HTTP endpoint
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Session {
    port: u16,
    token: String,
}

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    session: PathBuf,
}

static SERVER: Mutex<Option<Server>> = Mutex::new(None);

/// Whether AI control is on (Settings / tray), from `config.json`.
pub fn enabled(dir: &Path) -> bool {
    Config::load(&dir.join(CONFIG)).ai_control
}

/// Turns AI control on or off: saves the choice and starts or stops the
/// endpoint. `dir` is the default data folder.
pub fn set_enabled(app: &AppHandle, dir: &Path, on: bool) -> Result<(), String> {
    let path = dir.join(CONFIG);
    let mut config = Config::load(&path);
    config.ai_control = on;
    config.save(&path).map_err(|e| e.to_string())?;
    if on {
        start(app, dir).map_err(|e| e.to_string())
    } else {
        stop();
        Ok(())
    }
}

/// Starts the endpoint (if it isn't running) and writes `mcp.json`.
pub fn start(app: &AppHandle, dir: &Path) -> io::Result<()> {
    let mut server = SERVER.lock().unwrap();
    if server.is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| io::Error::other(e.to_string()))?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let session = dir.join(SESSION);
    let json = serde_json::to_string(&Session { port, token: token.clone() }).map_err(io::Error::other)?;
    std::fs::write(&session, json)?;

    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let app = app.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let (app, token) = (app.clone(), token.clone());
            thread::spawn(move || {
                if let Err(err) = serve(&app, stream, &token, port) {
                    eprintln!("memo: mcp: {err}");
                }
            });
        }
    });
    *server = Some(Server { port, stop, session });
    Ok(())
}

/// Stops the endpoint and removes `mcp.json`.
pub fn stop() {
    if let Some(server) = SERVER.lock().unwrap().take() {
        server.stop.store(true, Ordering::SeqCst);
        // Wakes the blocked `accept` so the thread sees the flag.
        let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port));
        let _ = std::fs::remove_file(server.session);
    }
}

/// One HTTP request: `POST /mcp` with a JSON-RPC message, answered with JSON
/// (MCP's Streamable HTTP without streams). Only from this computer: the
/// token is required and browser requests (an `Origin`, a foreign `Host`)
/// are refused.
fn serve(app: &AppHandle, stream: TcpStream, token: &str, port: u16) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut out = stream;
    let mut request = String::new();
    reader.read_line(&mut request)?;
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
            break;
        }
        if headers.len() > 64 {
            return respond(&mut out, "431 Request Header Fields Too Large", None);
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let mut parts = request.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if path != "/mcp" {
        return respond(&mut out, "404 Not Found", None);
    }
    if method != "POST" {
        return respond(&mut out, "405 Method Not Allowed", None);
    }
    let host = headers.get("host").map(String::as_str).unwrap_or("");
    if headers.contains_key("origin") || (host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}")) {
        return respond(&mut out, "403 Forbidden", None);
    }
    if headers.get("authorization").map(String::as_str) != Some(format!("Bearer {token}").as_str()) {
        return respond(&mut out, "401 Unauthorized", None);
    }
    let len: usize = headers.get("content-length").and_then(|l| l.parse().ok()).unwrap_or(0);
    if len > BODY_MAX {
        return respond(&mut out, "413 Content Too Large", None);
    }
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    let answer = match serde_json::from_slice::<Value>(&body) {
        Ok(msg) => reply(&msg, &|name, args| tool_result(run(app, name, args))),
        Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })),
    };
    match answer {
        Some(answer) => respond(&mut out, "200 OK", Some(&answer.to_string())),
        None => respond(&mut out, "202 Accepted", None),
    }
}

fn respond(out: &mut TcpStream, status: &str, json: Option<&str>) -> io::Result<()> {
    let body = json.unwrap_or("");
    let kind = if json.is_some() { "Content-Type: application/json\r\n" } else { "" };
    write!(
        out,
        "HTTP/1.1 {status}\r\n{kind}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    out.flush()
}

/// The app's executable as MCP clients should launch it (an AppImage's
/// file, not its temporary mount).
pub fn app_path() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok())
}

// ---------------------------------------------------------------------------
// `memo --mcp`: the stdio server
// ---------------------------------------------------------------------------

/// Reads JSON-RPC messages from stdin (one per line) and writes the answers
/// to stdout, until stdin closes. Returns the process exit code.
pub fn bridge() -> i32 {
    let Some(dir) = os_data_dir().map(|d| d.join(DATA_FOLDER)) else {
        eprintln!("memo: no data folder");
        return 1;
    };
    let mut stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(msg) => reply(&msg, &|_, _| forward(&dir, &msg)),
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } })),
        };
        if let Some(answer) = answer {
            if writeln!(stdout, "{answer}").and_then(|()| stdout.flush()).is_err() {
                break;
            }
        }
    }
    0
}

/// Sends a `tools/call` to the app and returns its result, opening Memo
/// first if it isn't running.
fn forward(dir: &Path, msg: &Value) -> Value {
    if !enabled(dir) {
        return tool_error(
            "AI control is off in Memo. Ask the user to turn on \"AI control (MCP)\" in Memo's \
             Settings (or in the menu of Memo's tray icon), then try again.",
        );
    }
    let body = msg.to_string();
    let deadline = Instant::now() + LAUNCH_WAIT;
    let mut launched = false;
    loop {
        match post(dir, &body) {
            Ok(answer) => {
                return match answer.get("result") {
                    Some(result) => result.clone(),
                    None => tool_error(
                        answer["error"]["message"].as_str().unwrap_or("Memo answered with an error"),
                    ),
                }
            }
            Err(err) if not_running(&err) && Instant::now() < deadline => {
                if !launched {
                    launched = true;
                    if let Err(err) = launch() {
                        return tool_error(&format!("Memo is not running and could not be opened: {err}"));
                    }
                }
                thread::sleep(Duration::from_millis(400));
            }
            Err(err) => return tool_error(&format!("Could not reach Memo: {err}")),
        }
    }
}

fn not_running(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
    )
}

/// One request to the app's endpoint, with the port and token it left in
/// `mcp.json`.
fn post(dir: &Path, body: &str) -> io::Result<Value> {
    let session: Session = serde_json::from_str(&std::fs::read_to_string(dir.join(SESSION))?)
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, session.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    write!(
        stream,
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\n\
         Content-Type: application/json\r\nAccept: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        session.port,
        session.token,
        body.len()
    )?;
    stream.flush()?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let raw = String::from_utf8_lossy(&raw);
    let (head, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::other("bad answer from Memo"))?;
    let status = head.lines().next().unwrap_or("");
    if !status.contains(" 200 ") {
        return Err(io::Error::other(format!("Memo answered {status}")));
    }
    serde_json::from_str(body).map_err(io::Error::other)
}

/// Opens Memo in the background, as a start with the system does (its
/// memories, no manager), detached from the MCP client.
fn launch() -> io::Result<()> {
    let exe = app_path().ok_or_else(|| io::Error::other("executable not found"))?;
    // macOS: through Launch Services, so it is a normal app (Dock, menu bar).
    #[cfg(target_os = "macos")]
    if let Some(bundle) = exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        Command::new("open")
            .arg("-g")
            .arg("-a")
            .arg(bundle)
            .args(["--args", AUTOSTART_ARG])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        return Ok(());
    }
    let command = || {
        let mut cmd = Command::new(&exe);
        cmd.arg(AUTOSTART_ARG)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        // Out of the client's job, so closing the client doesn't close Memo
        // (refused when the job doesn't allow it).
        if command().creation_flags(flags | CREATE_BREAKAWAY_FROM_JOB).spawn().is_ok() {
            return Ok(());
        }
        command().creation_flags(flags).spawn().map(|_| ())
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command().process_group(0).spawn().map(|_| ())
    }
    #[cfg(not(any(windows, unix)))]
    {
        command().spawn().map(|_| ())
    }
}

/// The OS data folder, as Tauri's `path().data_dir()` gives it to the app
/// (here without Tauri, which the stdio server doesn't start).
fn os_data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_to_html() {
        assert_eq!(from_plain(""), "<div><br></div>");
        assert_eq!(
            from_plain("Hi <you>\n\n[ ] a\n  [x] b\n- `c` d\n```js\nx < 1\n```"),
            "<div>Hi &lt;you&gt;</div><div><br></div><div class=\"check\">a</div>\
             <div class=\"check done\" data-level=\"1\">b</div>\
             <div class=\"bullet\"><code>c</code> d</div>\
             <pre class=\"code\" data-lang=\"js\">x &lt; 1</pre>"
        );
        assert_eq!(from_plain("[]\n-x\na ` b"), "<div class=\"check\"><br></div><div>-x</div><div>a ` b</div>");
        assert_eq!(
            from_plain("1. a\n  12. b\n3.c\n2025"),
            "<div class=\"number\">a</div><div class=\"number\" data-level=\"1\">b</div><div>3.c</div><div>2025</div>"
        );
        assert_eq!(
            from_plain("| A | B |\n| --- | :-: |\n| `x` | a \\| b |\n|  |\nend"),
            "<table class=\"head\"><tbody><tr><td>A</td><td>B</td></tr>\
             <tr><td><code>x</code></td><td>a | b</td></tr><tr><td><br></td><td><br></td></tr></tbody></table><div>end</div>"
        );
        assert_eq!(from_plain("| a |\n| b |"), "<table><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>");
    }

    #[test]
    fn plain_links() {
        assert_eq!(
            from_plain("See [Memo](https://memo.app) and www.x.com.br.\n- (https://a.io/b?c=1) `https://no.pe`"),
            "<div>See <a href=\"https://memo.app\">Memo</a> and <a href=\"https://www.x.com.br\">www.x.com.br</a>.</div>\
             <div class=\"bullet\">(<a href=\"https://a.io/b?c=1\">https://a.io/b?c=1</a>) <code>https://no.pe</code></div>"
        );
        assert_eq!(
            from_plain("[mail](mailto:a@b.c) [x](file:///etc) xhttps://a.io www. https:// a@www.b.c"),
            "<div><a href=\"mailto:a@b.c\">mail</a> [x](file:///etc) xhttps://a.io www. https:// a@www.b.c</div>"
        );
        assert_eq!(from_plain("| <https://a.io> |"), "<table><tbody><tr><td>&lt;<a href=\"https://a.io\">https://a.io</a>&gt;</td></tr></tbody></table>");
    }

    #[test]
    fn dates() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_792_594_466_000), "2026-10-21T14:54:26Z");
    }

    #[test]
    fn protocol() {
        let none = |_: &str, _: &Value| tool_error("unused");
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2024-11-05" } });
        assert_eq!(reply(&init, &none).unwrap()["result"]["protocolVersion"], "2024-11-05");
        assert!(reply(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &none).is_none());
        let list = reply(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &none).unwrap();
        assert!(list["result"]["tools"].as_array().unwrap().len() > 10);
    }
}
