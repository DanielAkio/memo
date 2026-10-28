//! Sharing a memory, a board or a group (with its memories and boards) as
//! a link, so it can go through any chat or email.
//!
//! The link is `share_url()` + `memo:v1:<data>`: the shared content as JSON,
//! deflated (raw) and in base64url (site/web.js makes and reads the same
//! codes), in the fragment, so it never reaches a server. Only content goes:
//! no ids, places, pins or dates; references between items are indices.
//! Images are not shared: each becomes `NO_IMAGE`, and the Memo that imports
//! puts a picture saying so in its place (`src/assets`).
//!
//! Memo Web opens the link with an offer to import it, and its "Open in the
//! app" hands it to this app as `memo://import#<code>` (tauri-plugin-deep-
//! link, `open_link`): every window shows the offer (share-available,
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
/// Links to a shared item: Memo Web, with the code after the `#`
/// (site/web.js SHARE_URL, checked by tools/check.mjs).
pub(crate) const SHARE_URL: &str = "https://danielakio.github.io/memo/app.html#";
/// The same page served locally by `npm run web` (tools/serve-web.mjs), for
/// links made by a dev build (site/web.js LOCAL_SHARE_URL).
pub(crate) const LOCAL_SHARE_URL: &str = "http://localhost:3000/memo/app.html#";

/// Where links point: the local Memo Web for a dev build (`npm run dev`), so
/// what is shared while developing opens there; the published one otherwise.
pub(crate) fn share_url() -> &'static str {
    if cfg!(debug_assertions) {
        LOCAL_SHARE_URL
    } else {
        SHARE_URL
    }
}
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

/// The payload of note, board or group `id` and its code.
fn share_code(store: &Store, kind: Kind, id: &str) -> Result<(Payload, String), String> {
    let payload = build(store, kind, id).ok_or("item not found")?;
    let code = encode(&payload)?;
    if code.len() > MAX_CODE {
        return Err("too big to share".into());
    }
    Ok((payload, code))
}

/// The link to note, board or group `id`: only the address, with the
/// content in its code.
pub(crate) fn share_link(store: &Store, kind: Kind, id: &str) -> Result<String, String> {
    let (_, code) = share_code(store, kind, id)?;
    Ok(format!("{}{code}", share_url()))
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
                ..Default::default()
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

/// Imports `payload` and opens the shared item in the middle of the screen
/// of `anchor` (or of any Memo window); a group with its memories and
/// boards out.
pub(crate) fn import(app: &AppHandle, payload: &Payload, anchor: Option<&WebviewWindow>) {
    let store = app.state::<Shared>();
    let created = create(&store, payload, None);
    center(app, &store, payload, &created, anchor);
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

/// Moves the shared item (the first of its kind in `created`) to the middle
/// of the work area of the screen `anchor` is on.
fn center(app: &AppHandle, store: &Store, payload: &Payload, created: &Created, anchor: Option<&WebviewWindow>) {
    let window = anchor.cloned().or_else(|| {
        let windows: Vec<_> = app.webview_windows().into_values().filter(is_app_window).collect();
        windows.iter().find(|w| w.is_focused().unwrap_or(false)).or(windows.first()).cloned()
    });
    let Some(screen) = window.as_ref().and_then(desk::current_screen) else {
        return;
    };
    let (ax, ay, aw, ah) = screen.work;
    let at = |w: f64, h: f64| {
        let (w, h) = ((w * screen.scale).round() as i32, (h * screen.scale).round() as i32);
        (Some(ax + ((aw - w) / 2).max(0)), Some(ay + ((ah - h) / 2).max(0)))
    };
    match payload.kind.as_str() {
        "board" => {
            if let Some(id) = created.boards.first() {
                store.update_board(id, |b| (b.x, b.y) = at(b.width, b.height));
            }
        }
        "group" => {
            if let Some(id) = created.groups.first() {
                store.update_group(id, |g| (g.x, g.y) = at(g.width, TITLEBAR_H));
            }
        }
        _ => {
            if let Some(id) = created.notes.first() {
                store.update(id, |n| (n.x, n.y) = at(n.width, n.height));
            }
        }
    }
}

// ------------------------------------------------------------------ offers

struct Offer {
    hash: u64,
    payload: Payload,
}

/// The shared item of the last link opened, offered in every window until
/// imported or dismissed.
static PENDING: Mutex<Option<Offer>> = Mutex::new(None);

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

/// Ends the offer (imported or dismissed).
fn take_offer(app: &AppHandle) -> Option<Payload> {
    let payload = PENDING.lock().unwrap().as_ref().map(|o| o.payload.clone())?;
    set_offer(app, None);
    Some(payload)
}

/// The offer's Import, or the tray's "Import shared item".
pub(crate) fn import_pending(app: &AppHandle, anchor: Option<&WebviewWindow>) {
    if let Some(payload) = take_offer(app) {
        import(app, &payload, anchor);
    }
}

/// Puts the link to the calling window's note, board or group (or `kind` /
/// `id`) in the clipboard, and returns it. Written from here: the titlebar
/// menu is native, so the page has no click to copy with.
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
    let text = share_link(&app.state::<Shared>(), kind, &id)?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text.clone()).map_err(|e| e.to_string())?;
    Ok(text)
}

/// A `memo://import#<code>` link opened (Memo Web's "Open in the app", or a
/// link clicked anywhere): its item is offered, with the manager in front
/// so the offer shows.
pub(crate) fn open_link(app: &AppHandle, url: &str) {
    let Some(code) = find_code(url) else { return };
    let Some(payload) = decode(code) else { return };
    set_offer(app, Some(Offer { hash: hash_of(code), payload }));
    show_all(app);
    let _ = open_manager(app);
}

/// The offer's Import button: the pending item, in the middle of the screen.
#[tauri::command]
pub(crate) async fn import_share(app: AppHandle, window: WebviewWindow) {
    import_pending(&app, Some(&window));
}

/// The offer a window opening now shows (`None`: nothing to import).
#[tauri::command]
pub(crate) fn share_offer() -> Option<Summary> {
    PENDING.lock().unwrap().as_ref().map(|o| summary(&o.payload))
}

/// The offer's ✕.
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
    fn a_link_carries_the_same_code() {
        let (store, dir) = temp_store("link");
        let id = note(&store, "Mercado", "<div>pão</div>", "pão");
        let link = share_link(&store, Kind::Note, &id).unwrap();
        let url = link.as_str();
        assert!(url.starts_with(share_url()), "only the link, no name before it: {url}");
        // Tests run a dev build: the local Memo Web.
        assert!(url.starts_with(LOCAL_SHARE_URL), "{url}");
        assert!(!url.contains(char::is_whitespace), "{url}");
        let code = find_code(url).unwrap();
        assert_eq!(code.len(), url.len() - share_url().len(), "the whole fragment is the code");
        // What Memo Web's "Open in the app" hands over.
        let app_link = format!("memo://import#{code}");
        assert_eq!(find_code(&app_link), Some(code));
        assert_eq!(decode(&app_link).unwrap().notes[0].title, "Mercado");
        let _ = fs::remove_dir_all(&dir);
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

        let link = share_link(&store, Kind::Board, &board.id).unwrap();
        assert!(link.starts_with(&format!("{}memo:v1:", share_url())), "{link}");
        let payload = decode(&link).expect("the link holds a code");
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

        let payload = decode(&share_link(&store, Kind::Group, &group.id).unwrap()).unwrap();
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
