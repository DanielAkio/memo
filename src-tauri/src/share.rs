//! Sharing a memory, a board or a group (with its memories and boards)
//! through the clipboard, so it can go through any chat or email.
//!
//! The text copied is readable (names and text) and ends with one line of
//! code, `memo:v1:<data>`: the shared content as JSON, deflated (raw) and
//! in base64url (site/web.js makes and reads the same codes). Only content
//! goes: no ids, places, pins or dates; references between items are
//! indices. Images are not shared: each becomes `NO_IMAGE`, and the Memo
//! that imports puts a picture saying so in its place (`src/assets`).
//!
//! When a Memo window gets the focus with a code it hasn't offered yet in
//! the clipboard, that window shows an offer to import it (share-available,
//! components/share.js), also in the tray menu while it is pending. Import
//! makes new copies, never touching what is there.

use crate::*;
use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use std::{
    collections::{hash_map::DefaultHasher, BTreeSet, HashMap},
    hash::{Hash, Hasher},
    io::{Read, Write},
};

pub(crate) const PREFIX: &str = "memo:v1:";
/// Longer codes are cut by chat apps.
pub(crate) const MAX_CODE: usize = 60_000;
/// What an image becomes in shared HTML.
pub(crate) const NO_IMAGE: &str = "<img src=\"memo:no-image\">";

const NO_IMAGE_PT: &[u8] = include_bytes!("../../src/assets/no-image-pt.png");
const NO_IMAGE_EN: &[u8] = include_bytes!("../../src/assets/no-image-en.png");
/// Shown at half its pixels, sharp on high-density screens.
const NO_IMAGE_WIDTH: u32 = 271;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SharedNote {
    pub title: String,
    pub html: String,
    pub text: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SharedColumn {
    pub name: String,
    pub color: String,
    pub notes: Vec<usize>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SharedBoard {
    pub name: String,
    pub color: String,
    pub columns: Vec<SharedColumn>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SharedGroup {
    pub name: String,
    pub color: String,
    pub notes: Vec<usize>,
    pub boards: Vec<usize>,
}

/// What a code holds: one memory, board or group (`kind`) and what it takes
/// along. The item shared is the first of its kind.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Payload {
    pub v: u32,
    pub kind: String,
    pub notes: Vec<SharedNote>,
    pub boards: Vec<SharedBoard>,
    pub groups: Vec<SharedGroup>,
}

/// What an offer shows: the kind, the shared item's name and how much
/// comes with it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub kind: String,
    pub name: String,
    pub notes: usize,
    pub boards: usize,
}

// ------------------------------------------------------------------ build

/// A note's HTML with every image replaced by `NO_IMAGE`.
fn without_images(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find("<img") {
        let Some(end) = rest[at..].find('>') else { break };
        out.push_str(&rest[..at]);
        out.push_str(NO_IMAGE);
        rest = &rest[at + end + 1..];
    }
    out.push_str(rest);
    out
}

fn shared_note(note: &Note) -> SharedNote {
    SharedNote {
        title: note.title.clone(),
        html: without_images(&note.html),
        text: note.text.clone(),
        color: note.color.clone(),
    }
}

/// Collects notes once each, by id, as indices into `payload.notes`.
struct Notes<'a> {
    store: &'a Store,
    index: HashMap<String, usize>,
}

impl Notes<'_> {
    fn add(&mut self, payload: &mut Payload, id: &str) -> Option<usize> {
        if let Some(&i) = self.index.get(id) {
            return Some(i);
        }
        let note = self.store.get(id).filter(|n| n.trashed_at.is_none())?;
        payload.notes.push(shared_note(&note));
        let i = payload.notes.len() - 1;
        self.index.insert(id.to_string(), i);
        Some(i)
    }
}

fn shared_board(board: &Board, notes: &mut Notes, payload: &mut Payload) -> SharedBoard {
    SharedBoard {
        name: board.name.clone(),
        color: board.color.clone(),
        columns: board
            .columns
            .iter()
            .map(|c| SharedColumn {
                name: c.name.clone(),
                color: c.color.clone(),
                notes: c.note_ids.iter().filter_map(|id| notes.add(payload, id)).collect(),
            })
            .collect(),
    }
}

/// The payload for note, board or group `id`; `None` if it isn't there.
pub(crate) fn build(store: &Store, kind: Kind, id: &str) -> Option<Payload> {
    let mut payload = Payload { v: 1, ..Default::default() };
    let mut notes = Notes { store, index: HashMap::new() };
    match kind {
        Kind::Note => {
            payload.kind = "note".into();
            notes.add(&mut payload, id)?;
        }
        Kind::Board => {
            payload.kind = "board".into();
            let board = store.board(id).filter(|b| b.trashed_at.is_none())?;
            let shared = shared_board(&board, &mut notes, &mut payload);
            payload.boards.push(shared);
        }
        Kind::Group => {
            payload.kind = "group".into();
            let group = store.group(id).filter(|g| g.trashed_at.is_none())?;
            let mut boards = Vec::new();
            for board in store.board_members(id) {
                let shared = shared_board(&board, &mut notes, &mut payload);
                payload.boards.push(shared);
                boards.push(payload.boards.len() - 1);
            }
            let members = store
                .members(id)
                .iter()
                .filter_map(|n| notes.add(&mut payload, &n.id))
                .collect();
            payload.groups.push(SharedGroup {
                name: group.name.clone(),
                color: group.color.clone(),
                notes: members,
                boards,
            });
        }
    }
    Some(payload)
}

// ------------------------------------------------------------------ text

/// A memory's name: its title, else its first line.
fn note_name(note: &SharedNote) -> String {
    let title = note.title.trim();
    if !title.is_empty() {
        return title.to_string();
    }
    note.text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

fn or_untitled(name: &str, lang: &str) -> String {
    match name.trim() {
        "" if lang == "en" => "Untitled".into(),
        "" => "Sem título".into(),
        name => name.to_string(),
    }
}

/// The shared item's name, as an offer shows it ("" = untitled).
pub(crate) fn name_of(payload: &Payload) -> String {
    match payload.kind.as_str() {
        "board" => payload.boards.first().map(|b| b.name.clone()),
        "group" => payload.groups.first().map(|g| g.name.clone()),
        _ => payload.notes.first().map(note_name),
    }
    .unwrap_or_default()
}

pub(crate) fn summary(payload: &Payload) -> Summary {
    Summary {
        kind: payload.kind.clone(),
        name: name_of(payload),
        notes: payload.notes.len(),
        boards: payload.boards.len(),
    }
}

fn board_text(board: &SharedBoard, payload: &Payload, lang: &str, out: &mut String) {
    for col in &board.columns {
        out.push_str(&format!("\n## {}\n", or_untitled(&col.name, lang)));
        for &i in &col.notes {
            if let Some(note) = payload.notes.get(i) {
                out.push_str(&format!("- {}\n", or_untitled(&note_name(note), lang)));
            }
        }
    }
}

/// The readable part: what a person sees in the chat.
pub(crate) fn readable(payload: &Payload, lang: &str) -> String {
    let image = if lang == "en" { "[image not shared]" } else { "[imagem não compartilhada]" };
    let mut out = String::new();
    match payload.kind.as_str() {
        "board" => {
            if let Some(board) = payload.boards.first() {
                out.push_str(&or_untitled(&board.name, lang));
                out.push('\n');
                board_text(board, payload, lang, &mut out);
            }
        }
        "group" => {
            if let Some(group) = payload.groups.first() {
                out.push_str(&or_untitled(&group.name, lang));
                out.push('\n');
                for &i in &group.notes {
                    if let Some(note) = payload.notes.get(i) {
                        out.push_str(&format!("- {}\n", or_untitled(&note_name(note), lang)));
                    }
                }
                for &i in &group.boards {
                    if let Some(board) = payload.boards.get(i) {
                        out.push_str(&format!("\n# {}\n", or_untitled(&board.name, lang)));
                        board_text(board, payload, lang, &mut out);
                    }
                }
            }
        }
        _ => {
            if let Some(note) = payload.notes.first() {
                if !note.title.trim().is_empty() {
                    out.push_str(note.title.trim());
                    out.push('\n');
                }
                out.push_str(&note.text.replace("[imagem]", image).replace("[image]", image));
                out.push('\n');
            }
        }
    }
    out.trim_end().to_string()
}

// ------------------------------------------------------------------ code

pub(crate) fn encode(payload: &Payload) -> Result<String, String> {
    let json = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let mut deflate = DeflateEncoder::new(Vec::new(), Compression::best());
    deflate.write_all(&json).map_err(|e| e.to_string())?;
    let bytes = deflate.finish().map_err(|e| e.to_string())?;
    Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes)))
}

/// The first code in `text`, if any.
pub(crate) fn find_code(text: &str) -> Option<&str> {
    let at = text.find(PREFIX)?;
    let rest = &text[at..];
    let len = PREFIX.len()
        + rest[PREFIX.len()..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(rest.len() - PREFIX.len());
    Some(&rest[..len])
}

/// The payload of the code in `text`, if it holds a valid one.
pub(crate) fn decode(text: &str) -> Option<Payload> {
    let code = find_code(text)?;
    if code.len() > MAX_CODE * 2 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(&code[PREFIX.len()..]).ok()?;
    let mut json = Vec::new();
    DeflateDecoder::new(&bytes[..])
        .take(32 * 1024 * 1024)
        .read_to_end(&mut json)
        .ok()?;
    let payload: Payload = serde_json::from_slice(&json).ok()?;
    let has_item = match payload.kind.as_str() {
        "note" => !payload.notes.is_empty(),
        "board" => !payload.boards.is_empty(),
        "group" => !payload.groups.is_empty(),
        _ => false,
    };
    (payload.v == 1 && has_item).then_some(payload)
}

fn hash_of(code: &str) -> u64 {
    let mut h = DefaultHasher::new();
    code.hash(&mut h);
    h.finish()
}

/// The whole text to copy for note, board or group `id`: the readable part,
/// a line saying what the code is, and the code.
pub(crate) fn share_text(store: &Store, kind: Kind, id: &str) -> Result<String, String> {
    let payload = build(store, kind, id).ok_or("item not found")?;
    let code = encode(&payload)?;
    if code.len() > MAX_CODE {
        return Err("too big to share".into());
    }
    let lang = store.effective_language();
    let footer = if lang == "en" {
        "— Shared from Memo: copy this whole message and open Memo to import it —"
    } else {
        "— Compartilhado pelo Memo: copie esta mensagem inteira e abra o Memo para importar —"
    };
    Ok(format!("{}\n\n{footer}\n{code}", readable(&payload, lang)))
}

// ------------------------------------------------------------------ import

/// Ids of what an import created.
#[derive(Default, Debug)]
pub(crate) struct Created {
    pub notes: Vec<String>,
    pub boards: Vec<String>,
    pub groups: Vec<String>,
}

/// The picture an image becomes, in `lang`, as HTML.
fn no_image_html(lang: &str) -> String {
    use base64::engine::general_purpose::STANDARD;
    let png = if lang == "en" { NO_IMAGE_EN } else { NO_IMAGE_PT };
    format!(
        "<img src=\"data:image/png;base64,{}\" width=\"{NO_IMAGE_WIDTH}\">",
        STANDARD.encode(png)
    )
}

/// Creates new copies of everything in `payload` (the shared item at `pos`)
/// and returns their ids. Memories on a board are hidden, as when dropped
/// there; a group comes out open.
pub(crate) fn create(store: &Store, payload: &Payload, pos: Option<(i32, i32)>) -> Created {
    let mut created = Created::default();
    let picture = no_image_html(store.effective_language());
    let images = store.images_dir();
    let valid = |c: &str| c.is_empty() || is_valid_color(c);
    for (i, shared) in payload.notes.iter().enumerate() {
        let at = if payload.kind == "note" && i == 0 { pos } else { None };
        let note = store.create(at);
        let html = images::store_images(&shared.html.replace(NO_IMAGE, &picture), &images);
        store.update(&note.id, |n| {
            n.title = shared.title.chars().take(80).collect();
            n.html = html;
            n.text = shared.text.clone();
            if valid(&shared.color) {
                n.color = shared.color.clone();
            }
        });
        created.notes.push(note.id);
    }
    let on_board: BTreeSet<usize> = payload.boards.iter().flat_map(|b| b.columns.iter()).flat_map(|c| c.notes.iter().copied()).collect();
    for &i in &on_board {
        if let Some(id) = created.notes.get(i) {
            store.update(id, |n| n.hidden = true);
        }
    }
    let stamp = now_ms();
    for (i, shared) in payload.boards.iter().enumerate() {
        let at = if payload.kind == "board" && i == 0 { pos } else { None };
        let board = store.create_board(Some(shared.name.clone()), Vec::new(), at);
        let columns = shared
            .columns
            .iter()
            .enumerate()
            .map(|(c, col)| BoardColumn {
                id: format!("col-{stamp}-{i}-{c}"),
                name: col.name.clone(),
                color: if valid(&col.color) { col.color.clone() } else { String::new() },
                note_ids: col.notes.iter().filter_map(|&n| created.notes.get(n).cloned()).collect(),
            })
            .collect();
        store.update_board(&board.id, |b| {
            b.columns = columns;
            if valid(&shared.color) {
                b.color = shared.color.clone();
            }
        });
        created.boards.push(board.id);
    }
    for (i, shared) in payload.groups.iter().enumerate() {
        let at = if payload.kind == "group" && i == 0 { pos } else { None };
        let group = store.create_group(at);
        store.update_group(&group.id, |g| {
            g.name = shared.name.clone();
            g.open = true;
            if valid(&shared.color) && !shared.color.is_empty() {
                g.color = shared.color.clone();
            }
        });
        for id in shared.notes.iter().filter_map(|&n| created.notes.get(n)) {
            store.update(id, |n| n.group_id = group.id.clone());
        }
        for id in shared.boards.iter().filter_map(|&b| created.boards.get(b)) {
            store.update_board(id, |b| b.group_id = group.id.clone());
        }
        created.groups.push(group.id);
    }
    created
}

/// Imports `payload` and opens the shared item beside `anchor` (a group
/// with its memories and boards out).
pub(crate) fn import(app: &AppHandle, payload: &Payload, anchor: Option<&WebviewWindow>) {
    let store = app.state::<Shared>();
    let created = create(&store, payload, anchor.and_then(beside));
    store.flush();
    let opened = match payload.kind.as_str() {
        "board" => created
            .boards
            .first()
            .and_then(|id| store.board(id))
            .and_then(|b| open_board_window(app, &b).ok()),
        "group" => created.groups.first().and_then(|id| {
            show_group(app, id);
            app.get_webview_window(&Kind::Group.label(id))
        }),
        _ => created
            .notes
            .first()
            .and_then(|id| store.get(id))
            .and_then(|n| open_note_window(app, &n).ok()),
    };
    if let Some(window) = opened {
        let _ = window.set_focus();
    }
    groups_changed(app);
    boards_changed(app);
    notify(app);
}

// ------------------------------------------------------------------ offers

struct Offer {
    hash: u64,
    payload: Payload,
}

/// The shared item in the clipboard, offered in every window while it is
/// there (copied here or elsewhere), until imported or dismissed.
static PENDING: Mutex<Option<Offer>> = Mutex::new(None);
/// Codes imported or dismissed with the offer's ✕: not offered again.
static DONE: Mutex<BTreeSet<u64>> = Mutex::new(BTreeSet::new());

pub(crate) fn pending() -> bool {
    PENDING.lock().unwrap().is_some()
}

/// Makes `offer` the pending one; when that changes, every window shows it
/// (or hides it, `None`) and the tray follows.
fn set_offer(app: &AppHandle, offer: Option<Offer>) {
    let mut pending = PENDING.lock().unwrap();
    if pending.as_ref().map(|o| o.hash) == offer.as_ref().map(|o| o.hash) {
        return;
    }
    let summary = offer.as_ref().map(|o| summary(&o.payload));
    let changed = pending.is_some() != offer.is_some();
    *pending = offer;
    drop(pending);
    let _ = app.emit("share-available", summary);
    if changed {
        refresh_tray(app);
    }
}

/// The offer for `text` (the clipboard's): its code, unless dismissed.
fn offer_for(text: &str) -> Option<Offer> {
    let code = find_code(text)?;
    let hash = hash_of(code);
    if DONE.lock().unwrap().contains(&hash) {
        return None;
    }
    if let Some(o) = PENDING.lock().unwrap().as_ref().filter(|o| o.hash == hash) {
        return Some(Offer { hash, payload: o.payload.clone() });
    }
    decode(code).map(|payload| Offer { hash, payload })
}

/// Looks at the clipboard when a Memo window gets the focus: a shared item
/// there is offered in every window, and the offer goes once it isn't.
pub(crate) fn on_focus(app: &AppHandle, _window: &WebviewWindow) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        let text = app.clipboard().read_text().unwrap_or_default();
        set_offer(&app, offer_for(&text));
    });
}

/// Ends the offer (imported or dismissed): that code is not offered again.
fn take_offer(app: &AppHandle) -> Option<Payload> {
    let offer = PENDING.lock().unwrap().as_ref().map(|o| (o.hash, o.payload.clone()));
    let (hash, payload) = offer?;
    DONE.lock().unwrap().insert(hash);
    set_offer(app, None);
    Some(payload)
}

/// The offer's Import, or the tray's "Import shared item".
pub(crate) fn import_pending(app: &AppHandle, anchor: Option<&WebviewWindow>) {
    if let Some(payload) = take_offer(app) {
        import(app, &payload, anchor);
    }
}

/// Puts the text to share for the calling window's note, board or group
/// (or `kind` / `id`) in the clipboard, and returns it. Written from here:
/// the titlebar menu is native, so the page has no click to copy with.
#[tauri::command]
pub(crate) fn copy_share(
    app: AppHandle,
    window: WebviewWindow,
    kind: Option<String>,
    id: Option<String>,
) -> Result<String, String> {
    let (kind, id) = match (kind.as_deref(), id) {
        (Some("note"), Some(id)) => (Kind::Note, id),
        (Some("board"), Some(id)) => (Kind::Board, id),
        (Some("group"), Some(id)) => (Kind::Group, id),
        _ => {
            Kind::of(&window).ok_or("nothing to share here")?
        }
    };
    let text = share_text(&app.state::<Shared>(), kind, &id)?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text.clone()).map_err(|e| e.to_string())?;
    // Now in the clipboard: offered like any shared item.
    set_offer(&app, offer_for(&text));
    Ok(text)
}

/// The offer's Import button: the pending item, opened beside the window.
#[tauri::command]
pub(crate) async fn import_share(app: AppHandle, window: WebviewWindow) {
    import_pending(&app, Some(&window));
}

/// The offer a window opening now shows (`None`: nothing to import).
#[tauri::command]
pub(crate) fn share_offer() -> Option<Summary> {
    PENDING.lock().unwrap().as_ref().map(|o| summary(&o.payload))
}

/// The offer's ✕: that code is not offered again.
#[tauri::command]
pub(crate) fn dismiss_share(app: AppHandle) {
    take_offer(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};

    fn temp_store(name: &str) -> (Store, std::path::PathBuf) {
        let dir = env::temp_dir().join(format!("memo-share-{name}-{}", now_nanos_for_tests()));
        fs::create_dir_all(&dir).unwrap();
        (Store::load(dir.join("notes.json")), dir)
    }

    fn now_nanos_for_tests() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    fn note(store: &Store, title: &str, html: &str, text: &str) -> String {
        let n = store.create(None);
        store.update(&n.id, |x| {
            x.title = title.into();
            x.html = html.into();
            x.text = text.into();
            x.color = "coral".into();
        });
        n.id
    }

    #[test]
    fn a_board_goes_and_comes_back_as_new_copies() {
        let (store, dir) = temp_store("board");
        let a = note(&store, "A", "<div>a</div>", "a");
        let b = note(&store, "", "<div>b <img src=\"images/0123456789abcdef0123456789abcdef.png\" width=\"40\"></div>", "b [image]");
        let board = store.create_board(Some("Plan".into()), vec!["To Do".into(), "Done".into()], None);
        store.update_board(&board.id, |x| {
            x.columns[0].note_ids = vec![a.clone(), b.clone()];
            x.color = "iris".into();
        });

        let text = share_text(&store, Kind::Board, &board.id).unwrap();
        assert!(text.starts_with("Plan\n"), "{text}");
        assert!(text.contains("## To Do\n- A\n- b"), "{text}");
        let payload = decode(&text).expect("the text holds a code");
        assert_eq!(payload.kind, "board");
        assert_eq!(payload.notes.len(), 2);
        assert!(payload.notes[1].html.contains(NO_IMAGE), "images are not shared");
        assert!(!payload.notes[1].html.contains("images/"));

        let before = store.boards().len();
        let created = create(&store, &payload, None);
        assert_eq!(store.boards().len(), before + 1);
        let copy = store.board(&created.boards[0]).unwrap();
        assert_ne!(copy.id, board.id);
        assert_eq!(copy.name, "Plan");
        assert_eq!(copy.color, "iris");
        assert_eq!(copy.columns.len(), 2);
        assert_eq!(copy.columns[0].note_ids, created.notes);
        assert!(!created.notes.contains(&a) && !created.notes.contains(&b));
        let first = store.get(&created.notes[0]).unwrap();
        assert_eq!((first.title.as_str(), first.text.as_str(), first.hidden), ("A", "a", true));
        let second = store.get(&created.notes[1]).unwrap();
        assert!(second.html.contains("src=\"images/"), "the placeholder picture is stored as an image");
        // The originals are untouched.
        assert_eq!(store.board(&board.id).unwrap().columns[0].note_ids, vec![a, b]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_group_takes_its_memories_and_boards() {
        let (store, dir) = temp_store("group");
        let group = store.create_group(None);
        store.update_group(&group.id, |g| g.name = "Trip".into());
        let loose = note(&store, "Tickets", "<div>t</div>", "t");
        let carded = note(&store, "Hotel", "<div>h</div>", "h");
        for id in [&loose, &carded] {
            store.update(id, |n| n.group_id = group.id.clone());
        }
        let board = store.create_board(Some("Days".into()), vec!["Mon".into()], None);
        store.update_board(&board.id, |b| {
            b.columns[0].note_ids = vec![carded.clone()];
            b.group_id = group.id.clone();
        });

        let payload = decode(&share_text(&store, Kind::Group, &group.id).unwrap()).unwrap();
        assert_eq!((payload.notes.len(), payload.boards.len(), payload.groups.len()), (2, 1, 1));
        let created = create(&store, &payload, None);
        let gid = &created.groups[0];
        assert_eq!(store.group(gid).unwrap().name, "Trip");
        assert_eq!(store.members(gid).len(), 2);
        assert_eq!(store.board_members(gid).len(), 1);
        assert_eq!(store.loose_members(gid).len(), 1, "the memory on the board stays on it");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_codes_are_ignored() {
        assert!(decode("no code here").is_none());
        assert!(decode("memo:v1:!!!").is_none());
        assert!(decode("memo:v1:AAAA").is_none());
        let empty = encode(&Payload { v: 1, kind: "note".into(), ..Default::default() }).unwrap();
        assert!(decode(&empty).is_none(), "a code without its item");
        assert_eq!(find_code("hi\nmemo:v1:abc-_9\n"), Some("memo:v1:abc-_9"));
    }

    #[test]
    fn codes_made_by_memo_web_are_read() {
        // site/web.js encodePayload({ v: 1, kind: 'note', notes: [{ title: 'Oi', html: '<div>oi</div>', text: 'oi', color: 'mint' }] })
        let web = include_str!("../tests/web-share-code.txt").trim();
        let payload = decode(web).expect("web code");
        assert_eq!(payload.notes[0].title, "Oi");
        assert_eq!(payload.notes[0].color, "mint");
    }
}
