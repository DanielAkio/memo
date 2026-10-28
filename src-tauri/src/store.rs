//! Note persistence: a single `notes.json` in the app data folder.
//!
//! Changes are kept in memory and a thread writes to disk when something is
//! pending, so dragging or resizing a note doesn't hit the disk on every
//! pixel. Writes are atomic (temporary file + rename).

use crate::{cloud::Provider, images};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_W: f64 = 300.0;
pub const DEFAULT_H: f64 = 320.0;
/// Titlebar height (matches `--titlebar-h` in CSS): the minimum window height.
pub const TITLEBAR_H: f64 = 36.0;

/// Accepted colour labels (empty = no colour).
pub const COLORS: [&str; 8] = [
    "", "yellow", "green", "coral", "teal", "iris", "lavender", "mono",
];

/// A colour is valid if it is one of the labels above or a custom colour in
/// `#rrggbb` form.
pub fn is_valid_color(color: &str) -> bool {
    COLORS.contains(&color)
        || (color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

/// A random label from `RANDOM_COLORS`, among those the fewest of `used`
/// (the colours of the existing notes or groups) have, so new ones tell
/// apart at a glance.
fn random_color<'a>(used: impl Iterator<Item = &'a str> + Clone) -> String {
    let uses = |c: &str| used.clone().filter(|u| *u == c).count();
    let least = RANDOM_COLORS.iter().map(|c| uses(c)).min().unwrap_or(0);
    let pool: Vec<&str> = RANDOM_COLORS.iter().copied().filter(|c| uses(c) == least).collect();
    let mut bytes = [0u8; 4];
    let roll = getrandom::fill(&mut bytes).map(|_| u32::from_le_bytes(bytes)).unwrap_or(0);
    pool[roll as usize % pool.len()].to_string()
}

/// The app's own colour (the manager window, and groups whose colour is
/// unreadable).
pub const DEFAULT_COLOR: &str = "iris";

/// Colour new notes start with unless one is chosen in the manager: none.
pub const DEFAULT_NOTE_COLOR: &str = "";

/// Labels a new note or group draws its colour from when its default colour
/// is "random" (the default for groups).
pub const RANDOM_COLORS: [&str; 5] = ["yellow", "green", "coral", "teal", "iris"];

/// Default group colour meaning "a random label for each new group".
pub const RANDOM_COLOR: &str = "random";

/// How long a note stays in the trash before being permanently deleted (30 days).
pub const TRASH_TTL_MS: u64 = 30 * 86_400_000;

/// Maximum length of the new-note default text, in characters.
pub const DEFAULT_TEXT_MAX: usize = 5000;

/// Maximum length of a note's name, in characters.
pub const TITLE_MAX: usize = 80;

/// Default logical width of a group bar: the same as a new note (its height
/// is always `TITLEBAR_H`).
pub const GROUP_W: f64 = DEFAULT_W;

/// Global zoom range and step (Settings, Mod +/-, Mod + wheel).
pub const ZOOM_MIN: f64 = 0.7;
pub const ZOOM_MAX: f64 = 1.6;
pub const ZOOM_STEP: f64 = 0.1;

/// Maximum length of a group's name, in characters.
pub const GROUP_NAME_MAX: usize = 60;

/// Default logical dimensions for a board window.
pub const BOARD_DEFAULT_W: f64 = 760.0;
pub const BOARD_DEFAULT_H: f64 = 520.0;
pub const BOARD_MIN_W: f64 = 380.0;
pub const BOARD_MIN_H: f64 = 280.0;
pub const BOARD_NAME_MAX: usize = 60;

/// How long the record of a permanently deleted note or group is kept (90
/// days), so that another device syncing later deletes it too instead of
/// bringing it back.
pub const TOMBSTONE_TTL_MS: u64 = 90 * 86_400_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub seq: u32,
    /// Name given by the user (empty = unnamed).
    pub title: String,
    /// Plain text (checklist items as "[ ] " / "[x] "): used for the word
    /// count, the manager list and to rebuild old notes.
    pub text: String,
    /// Formatted content (bold, italic, underline, checklist) produced by the
    /// editor. Empty in notes that predate formatting.
    pub html: String,
    /// Physical position (screen pixels) of the top-left corner.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Logical size.
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    pub color: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// When it was trashed; `None` = active note.
    pub trashed_at: Option<u64>,
    /// A welcome note reopened from the Help tab (not the first-run one):
    /// closing it deletes it instead of trashing it.
    pub welcome_copy: bool,
    /// Group the note belongs to (`Group.id`); empty = none.
    pub group_id: String,
    /// Closed with ✕: still active (listed in the manager, which reopens it)
    /// but its window is not opened.
    pub hidden: bool,
}

impl Note {
    pub fn is_blank(&self) -> bool {
        self.title.trim().is_empty() && self.text.trim().is_empty()
    }

    /// The fields that are the note itself, the same on every device. The
    /// rest (position, size, pin, closed with ✕, welcome copy) is this
    /// computer's layout. Changing any of these bumps `updated_at`.
    fn content(&self) -> NoteContent {
        NoteContent {
            title: self.title.clone(),
            text: self.text.clone(),
            html: self.html.clone(),
            color: self.color.clone(),
            group_id: self.group_id.clone(),
            trashed_at: self.trashed_at,
        }
    }
}

#[derive(PartialEq)]
struct NoteContent {
    title: String,
    text: String,
    html: String,
    color: String,
    group_id: String,
    trashed_at: Option<u64>,
}

/// Record of a note or group deleted for good (see `TOMBSTONE_TTL_MS`).
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Tombstone {
    pub id: String,
    pub deleted_at: u64,
}

impl Default for Note {
    fn default() -> Self {
        Self {
            id: String::new(),
            seq: 0,
            title: String::new(),
            text: String::new(),
            html: String::new(),
            x: None,
            y: None,
            width: DEFAULT_W,
            height: DEFAULT_H,
            pinned: false,
            color: DEFAULT_NOTE_COLOR.to_string(),
            created_at: 0,
            updated_at: 0,
            trashed_at: None,
            welcome_copy: false,
            group_id: String::new(),
            hidden: false,
        }
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct FileData {
    version: u32,
    next_seq: u32,
    /// Theme chosen in the manager (see `THEMES`); empty = "system".
    theme: String,
    /// Global zoom of every window's content (1.0 = 100%); 0 = unset.
    zoom: f64,
    /// Language chosen in Settings (see `LANGUAGES`); empty = "system".
    language: String,
    /// The magnet turned off in Settings: windows no longer stick to screen
    /// edges and to each other, and notes don't fold onto their titlebar.
    magnet_off: bool,
    /// Position, size and state of the manager window.
    manager: ManagerState,
    /// Colour for new notes, chosen in the manager (`RANDOM_COLOR` = a
    /// random label for each); `None` = `DEFAULT_NOTE_COLOR` (no colour).
    default_color: Option<String>,
    /// Title and text (plain, with "[ ] " for checklist items) of new notes,
    /// set in the manager. Empty = blank note.
    default_title: String,
    default_text: String,
    /// The same default text with formatting (HTML from the note editor).
    default_html: String,
    /// Colour new groups start with, set in the manager; `None` = a random
    /// label for each new group (`RANDOM_COLORS`).
    default_group_color: Option<String>,
    /// Name new groups start with; empty = unnamed.
    default_group_title: String,
    /// Colour new boards start with (`RANDOM_COLOR` = a random label for
    /// each); `None` = no colour.
    default_board_color: Option<String>,
    /// Name new boards start with; empty = unnamed.
    default_board_title: String,
    /// Columns new boards start with; `None` = the language's own (To Do,
    /// In Progress, Done).
    default_board_columns: Option<Vec<ColumnDefault>>,
    notes: Vec<Note>,
    /// Groups of notes (compact bars that show or hide their notes).
    groups: Vec<Group>,
    next_group_seq: u32,
    boards: Vec<Board>,
    next_board_seq: u32,
    /// When a new-note or new-group default last changed.
    defaults_updated_at: u64,
    /// Notes and groups deleted for good, kept for `TOMBSTONE_TTL_MS`.
    deleted: Vec<Tombstone>,
    /// Cloud sync bookkeeping (see `SyncState`), one per cloud: Google
    /// Drive's (`sync`, its name from before OneDrive) and OneDrive's; per
    /// machine, like the rest of this file.
    sync: SyncState,
    sync_microsoft: SyncState,
}

// ------------------------------------------------------------ cloud format
// What goes to the user's Drive (sync.rs): one JSON file per note
// (`note-<id>.json`) and per group (`group-<id>.json`), plus `settings.json`.
// Only content travels; layout stays on each computer. A deleted note or
// group keeps its file as a tombstone (`deleted: true`).

/// A note as stored in the cloud.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteDoc {
    pub version: u32,
    pub id: String,
    pub title: String,
    pub text: String,
    pub html: String,
    pub color: String,
    pub group_id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub trashed_at: Option<u64>,
    pub deleted: bool,
    pub deleted_at: u64,
}

impl NoteDoc {
    /// The time this version was made (edit or deletion).
    pub fn stamp(&self) -> u64 {
        if self.deleted {
            self.deleted_at
        } else {
            self.updated_at
        }
    }
}

/// A group as stored in the cloud.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct GroupDoc {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub trashed_at: Option<u64>,
    pub deleted: bool,
    pub deleted_at: u64,
}

impl GroupDoc {
    pub fn stamp(&self) -> u64 {
        if self.deleted {
            self.deleted_at
        } else {
            self.updated_at
        }
    }
}

/// The new-note and new-group defaults, as stored in the cloud.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsDoc {
    pub version: u32,
    pub default_color: Option<String>,
    pub default_title: String,
    pub default_text: String,
    pub default_html: String,
    pub default_group_color: Option<String>,
    pub default_group_title: String,
    pub default_board_color: Option<String>,
    pub default_board_title: String,
    pub default_board_columns: Option<Vec<ColumnDefault>>,
    pub updated_at: u64,
}

/// A cloud file this computer knows: its Drive id and the stamp
/// (`updatedAt` / `deletedAt`) last sent or received for it.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncedFile {
    pub file_id: String,
    pub synced: u64,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    /// Account these file ids belong to; another account starts over.
    pub account: String,
    /// Drive changes token: where the next pull starts. `None` = list all.
    pub page_token: Option<String>,
    /// By file name (`note-<id>.json`, `group-<id>.json`, `settings.json`).
    pub files: HashMap<String, SyncedFile>,
    /// Cloud versions of notes being edited here when they arrived; applied
    /// once their window is no longer focused.
    pub deferred: Vec<NoteDoc>,
    /// Last successful sync (ms).
    pub last_sync: u64,
}

/// Everything sync needs to read in one lock.
pub struct SyncSnapshot {
    pub notes: Vec<Note>,
    pub groups: Vec<Group>,
    pub deleted: Vec<Tombstone>,
    pub settings: SettingsDoc,
}

/// What applying a cloud note did, so the caller can update its window.
#[derive(Debug, PartialEq)]
pub enum Applied {
    Unchanged,
    Created,
    Updated,
    Trashed,
    Removed,
}

/// A group of notes: a compact bar on screen. Double-clicking it takes its
/// notes out (each back where it was) or puts them back in (their windows
/// are closed). Notes point to it with `Note.group_id`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Group {
    pub id: String,
    pub name: String,
    /// Physical position of the outer top-left corner; `None` = not placed.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Logical width; the height is always the titlebar's.
    pub width: f64,
    /// `true` = its notes are out on screen, `false` = inside the group.
    pub open: bool,
    /// Kept above other apps, like a pinned note.
    pub pinned: bool,
    /// Colour label, as for notes (see `COLORS`); empty = none.
    pub color: String,
    pub created_at: u64,
    /// Last change to its content (see `Group::content`).
    pub updated_at: u64,
    /// When it was trashed (with its notes); `None` = active group.
    pub trashed_at: Option<u64>,
    /// Closed with ✕: its bar (and its notes) are not opened until the
    /// manager reopens it.
    pub hidden: bool,
}

impl Default for Group {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            x: None,
            y: None,
            width: GROUP_W,
            open: true,
            pinned: false,
            color: DEFAULT_COLOR.to_string(),
            created_at: 0,
            updated_at: 0,
            trashed_at: None,
            hidden: false,
        }
    }
}

impl Group {
    /// The fields that are the group itself, the same on every device. The
    /// rest (position, width, out/put away, pin, closed with ✕) is this
    /// computer's layout. Changing any of these bumps `updated_at`.
    fn content(&self) -> (String, String, Option<u64>) {
        (self.name.clone(), self.color.clone(), self.trashed_at)
    }
}

/// A status column inside a kanban board holding note IDs.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BoardColumn {
    pub id: String,
    pub name: String,
    pub color: String,
    pub note_ids: Vec<String>,
    /// Memories shown folded (title only) in this column.
    pub collapsed: Vec<String>,
}

/// A column new boards start with (Settings → Defaults → Board).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ColumnDefault {
    pub name: String,
    pub color: String,
}

impl ColumnDefault {
    /// Name cut to `BOARD_NAME_MAX`, unknown colours dropped.
    pub fn clean(&self) -> Self {
        ColumnDefault {
            name: self.name.trim().chars().take(BOARD_NAME_MAX).collect(),
            color: if is_valid_color(&self.color) { self.color.clone() } else { String::new() },
        }
    }
}

/// At most this many default columns.
pub const DEFAULT_COLUMNS_MAX: usize = 20;

/// A kanban board (Trello-like) containing status columns with memories.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Board {
    pub id: String,
    pub name: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    pub color: String,
    pub columns: Vec<BoardColumn>,
    pub group_id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub trashed_at: Option<u64>,
    pub hidden: bool,
}

impl Default for Board {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            x: None,
            y: None,
            width: BOARD_DEFAULT_W,
            height: BOARD_DEFAULT_H,
            pinned: false,
            color: String::new(),
            columns: Vec::new(),
            group_id: String::new(),
            created_at: 0,
            updated_at: 0,
            trashed_at: None,
            hidden: false,
        }
    }
}

impl Board {
    fn content(&self) -> (String, String, Vec<BoardColumn>, String, Option<u64>) {
        (
            self.name.clone(),
            self.color.clone(),
            self.columns.clone(),
            self.group_id.clone(),
            self.trashed_at,
        )
    }
}

/// State of the manager window, stored like a note's.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ManagerState {
    /// Physical position of the top-left corner; `None` = centred.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Logical size.
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    /// Colour label, as for notes and groups (stripe and icon).
    pub color: String,
    /// How the Memories and Groups tabs show their items (`LAYOUTS`):
    /// "list" (the default; empty reads as list) or "cards".
    pub layout: String,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: 560.0,
            height: 640.0,
            pinned: false,
            color: DEFAULT_COLOR.to_string(),
            layout: "cards".to_string(),
        }
    }
}

/// Layouts of the manager's Memories and Groups tabs: a grid of cards or a
/// list, one row per item.
pub const LAYOUTS: &[&str] = &["cards", "list"];

/// Accepted languages: follow the OS, Portuguese or English.
pub const LANGUAGES: [&str; 3] = ["system", "pt-BR", "en"];

/// Accepted themes: follow the OS, light or dark.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

pub struct Store {
    /// Where `notes.json` lives; changes when the user picks another folder.
    /// Locked before `data` whenever both are needed.
    path: Mutex<PathBuf>,
    data: Mutex<FileData>,
    dirty: AtomicBool,
}

/// App config, kept in the default app data folder (never in the custom
/// one, since it says where that is).
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Folder chosen for `notes.json`; `None` = the app data folder.
    pub data_dir: Option<PathBuf>,
    /// Start-with-the-system has been set up once (see `init_autostart`).
    pub autostart_init: bool,
    /// E-mail of the Google account connected for cloud sync on this
    /// computer (its token is in the OS credential store, see cloud.rs).
    pub google_account: Option<String>,
    /// E-mail of the Microsoft account connected for OneDrive sync; with
    /// both set, Memo syncs with both clouds.
    pub microsoft_account: Option<String>,
    /// AI assistants may control Memo through MCP on this computer (see
    /// mcp.rs). Off by default.
    pub ai_control: bool,
    /// Automatic update checks turned off in Settings (updater.rs). On by
    /// default.
    pub updates_off: bool,
}

impl Config {
    pub fn load(path: &Path) -> Self {
        fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let json = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        write_atomic(path, &json)
    }
}

/// Writes through a temporary file + rename, so a crash never leaves a
/// half-written file.
fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

/// Reads and parses a notes file.
fn read(path: &Path) -> io::Result<FileData> {
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

/// Ensures unique ids and continuous numbering even with hand-edited files,
/// and drops links to groups that no longer exist.
fn normalize(data: &mut FileData) {
    data.notes.retain(|n| !n.id.is_empty());
    let max_seq = data.notes.iter().map(|n| n.seq).max().unwrap_or(0);
    data.next_seq = data.next_seq.max(max_seq + 1).max(1);
    for note in &mut data.notes {
        note.updated_at = note.updated_at.max(note.created_at);
    }
    data.groups.retain(|g| !g.id.is_empty());
    for group in &mut data.groups {
        group.updated_at = group.updated_at.max(group.created_at);
    }
    data.next_group_seq = data.next_group_seq.max(data.groups.len() as u32 + 1);
    let groups: HashSet<String> = data.groups.iter().map(|g| g.id.clone()).collect();
    for note in &mut data.notes {
        if !note.group_id.is_empty() && !groups.contains(&note.group_id) {
            note.group_id.clear();
        }
    }
    data.boards.retain(|b| !b.id.is_empty());
    for board in &mut data.boards {
        board.updated_at = board.updated_at.max(board.created_at);
        if !board.group_id.is_empty() && !groups.contains(&board.group_id) {
            board.group_id.clear();
        }
    }
    data.next_board_seq = data.next_board_seq.max(data.boards.len() as u32 + 1);
    let note_ids: HashSet<String> = data.notes.iter().map(|n| n.id.clone()).collect();
    for board in &mut data.boards {
        for col in &mut board.columns {
            col.note_ids.retain(|id| note_ids.contains(id));
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn set_content(note: &mut Note, content: NoteContent) {
    note.title = content.title;
    note.text = content.text;
    note.html = content.html;
    note.color = content.color;
    note.group_id = content.group_id;
    note.trashed_at = content.trashed_at;
}

/// Moves inline images (data URLs) into files in `dir`; true if any moved.
fn store_all_images(data: &mut FileData, dir: &Path) -> bool {
    let mut moved = false;
    let htmls = data.notes.iter_mut().map(|n| &mut n.html);
    for html in htmls.chain(std::iter::once(&mut data.default_html)) {
        let stored = images::store_images(html, dir);
        if stored != *html {
            *html = stored;
            moved = true;
        }
    }
    moved
}

/// Records the ids as deleted for good.
fn bury(data: &mut FileData, ids: impl IntoIterator<Item = String>, now: u64) {
    for id in ids {
        data.deleted.retain(|t| t.id != id);
        data.deleted.push(Tombstone { id, deleted_at: now });
    }
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let mut data = match read(&path) {
            Ok(data) => data,
            Err(err) if err.kind() == io::ErrorKind::InvalidData => {
                // Never overwrite an unreadable file: keep a copy first.
                let backup = path.with_extension(format!("corrupted-{}.json", now_ms()));
                let _ = fs::copy(&path, &backup);
                eprintln!("memo: unreadable notes.json ({err}); copy at {backup:?}");
                FileData::default()
            }
            Err(_) => FileData::default(),
        };
        normalize(&mut data);
        // Older versions kept images inside notes.json: keep that file.
        let migrated = store_all_images(&mut data, &images::dir_for(&path));
        if migrated {
            let _ = fs::copy(&path, path.with_extension(format!("backup-{}.json", now_ms())));
        }

        let store = Self {
            path: Mutex::new(path),
            data: Mutex::new(data),
            dirty: AtomicBool::new(migrated),
        };
        store.purge_trash(now_ms());
        store
    }

    /// Path of the current `notes.json`.
    pub fn path(&self) -> PathBuf {
        self.path.lock().unwrap().clone()
    }

    /// Folder of the pasted images, beside `notes.json` (see images.rs).
    pub fn images_dir(&self) -> PathBuf {
        images::dir_for(&self.path())
    }

    /// Saves the inline images of an HTML as files; returns the HTML with
    /// references to them (what the store keeps).
    pub fn store_images(&self, html: &str) -> String {
        images::store_images(html, &self.images_dir())
    }

    /// The HTML with its images inline again (what a window shows).
    pub fn inline_images(&self, html: &str) -> String {
        images::inline_images(html, &self.images_dir())
    }

    /// Every stored HTML (notes, trashed ones included, and the new-note
    /// default), to find the images in use.
    pub fn all_html(&self) -> Vec<String> {
        let data = self.data.lock().unwrap();
        data.notes.iter().map(|n| n.html.clone()).chain([data.default_html.clone()]).collect()
    }

    /// Moves the store to `path` (a `notes.json` in another folder). If a
    /// notes file already exists there and `load_existing` is set, it is
    /// loaded in place of the notes in memory and `true` is returned;
    /// otherwise the current notes are written there (an existing file is
    /// first copied to `notes.backup-<ms>.json`). The old file is left
    /// untouched, as a backup. An unreadable file to load is an error
    /// (nothing changes).
    pub fn relocate(&self, path: PathBuf, load_existing: bool) -> io::Result<bool> {
        let mut current = self.path.lock().unwrap();
        // Pending changes still belong to the old file.
        if self.dirty.swap(false, Ordering::SeqCst) {
            if let Err(err) = self.write(&current) {
                self.mark_dirty();
                return Err(err);
            }
        }
        if path.exists() && load_existing {
            let mut data = read(&path)?;
            normalize(&mut data);
            let migrated = store_all_images(&mut data, &images::dir_for(&path));
            if migrated {
                let _ = fs::copy(&path, path.with_extension(format!("backup-{}.json", now_ms())));
            }
            *self.data.lock().unwrap() = data;
            *current = path;
            drop(current);
            if migrated {
                self.mark_dirty();
            }
            self.purge_trash(now_ms());
            Ok(true)
        } else {
            if path.exists() {
                fs::copy(
                    &path,
                    path.with_extension(format!("backup-{}.json", now_ms())),
                )?;
            }
            // The images go along (the old folder keeps its copies).
            let (from, to) = (images::dir_for(&current), images::dir_for(&path));
            for html in self.all_html() {
                images::copy_refs(&html, &from, &to)?;
            }
            self.write(&path)?;
            *current = path;
            Ok(false)
        }
    }

    /// Writes a copy of the data to `path` without the trashed notes, in the
    /// same format as `notes.json` (so an export can also serve as a data
    /// folder's file).
    pub fn export_to(&self, path: &Path) -> io::Result<()> {
        let dir = self.images_dir();
        let json = {
            let mut copy = self.data.lock().unwrap().clone();
            // One self-contained file: the images go inside it.
            for note in &mut copy.notes {
                note.html = images::inline_images(&note.html, &dir);
            }
            copy.default_html = images::inline_images(&copy.default_html, &dir);
            copy.version = 1;
            copy.notes.retain(|n| n.trashed_at.is_none());
            copy.groups.retain(|g| g.trashed_at.is_none());
            copy.deleted.clear();
            copy.sync = SyncState::default();
            copy.sync_microsoft = SyncState::default();
            normalize(&mut copy);
            serde_json::to_string_pretty(&copy)
        };
        write_atomic(path, &json.map_err(io::Error::other)?)
    }

    /// Merges the notes of another notes file (an export or a `notes.json`):
    /// unknown ids are added and known ones replaced only if the imported copy
    /// is newer; its groups are added when unknown. Settings in the file are
    /// ignored. Returns the ids added or replaced.
    pub fn import_from(&self, path: &Path) -> io::Result<Vec<String>> {
        let mut imported = read(path)?;
        // Images inside the file (an export) or beside it (a notes.json).
        let (from, to) = (images::dir_for(path), self.images_dir());
        for note in &mut imported.notes {
            note.html = images::store_images(&images::inline_images(&note.html, &from), &to);
        }
        let mut changed = Vec::new();
        {
            let mut data = self.data.lock().unwrap();
            for group in imported.groups {
                if !group.id.is_empty() && !data.groups.iter().any(|g| g.id == group.id) {
                    data.groups.push(group);
                }
            }
            for note in imported.notes.into_iter().filter(|n| !n.id.is_empty()) {
                match data.notes.iter_mut().find(|n| n.id == note.id) {
                    Some(existing) if note.updated_at > existing.updated_at => {
                        changed.push(note.id.clone());
                        *existing = note;
                    }
                    Some(_) => {}
                    None => {
                        changed.push(note.id.clone());
                        data.notes.push(note);
                    }
                }
            }
            let known: HashSet<String> = data
                .notes
                .iter()
                .map(|n| n.id.clone())
                .chain(data.groups.iter().map(|g| g.id.clone()))
                .collect();
            // What the import brought back is no longer deleted.
            data.deleted.retain(|t| !known.contains(&t.id));
            normalize(&mut data);
        }
        if !changed.is_empty() {
            self.mark_dirty();
            self.purge_trash(now_ms());
        }
        Ok(changed)
    }

    // ------------------------------------------------------------- groups

    pub fn groups(&self) -> Vec<Group> {
        self.data.lock().unwrap().groups.clone()
    }

    pub fn group(&self, id: &str) -> Option<Group> {
        self.data
            .lock()
            .unwrap()
            .groups
            .iter()
            .find(|g| g.id == id)
            .cloned()
    }

    /// New open group with the default colour and name chosen in the manager
    /// (by default none: unnamed, like a new note).
    pub fn create_group(&self, pos: Option<(i32, i32)>) -> Group {
        let group = {
            let mut data = self.data.lock().unwrap();
            let seq = data.next_group_seq.max(1);
            data.next_group_seq = seq + 1;
            let color = match &data.default_group_color {
                Some(c) if is_valid_color(c) => c.clone(),
                _ => random_color(data.groups.iter().map(|g| g.color.as_str())),
            };
            let now = now_ms();
            let group = Group {
                id: format!("{:x}-g{}", now_nanos(), seq),
                name: data.default_group_title.clone(),
                color,
                x: pos.map(|p| p.0),
                y: pos.map(|p| p.1),
                created_at: now,
                updated_at: now,
                ..Default::default()
            };
            data.groups.push(group.clone());
            group
        };
        self.mark_dirty();
        group
    }

    /// Applies `f` to the group and returns an updated copy. `updated_at`
    /// follows changes to its content (not to its layout).
    pub fn update_group<F: FnOnce(&mut Group)>(&self, id: &str, f: F) -> Option<Group> {
        let updated = {
            let mut data = self.data.lock().unwrap();
            let group = data.groups.iter_mut().find(|g| g.id == id)?;
            let before = group.content();
            f(group);
            if group.content() != before {
                group.updated_at = now_ms();
            }
            group.clone()
        };
        self.mark_dirty();
        Some(updated)
    }

    /// Removes the group and unlinks its notes (trashed ones included).
    /// Groups not in the trash.
    pub fn active_groups(&self) -> Vec<Group> {
        self.groups()
            .into_iter()
            .filter(|g| g.trashed_at.is_none())
            .collect()
    }

    /// Permanently deletes every group in the trash (their notes stay, as
    /// ungrouped notes).
    pub fn empty_group_trash(&self) {
        let ids: Vec<String> = self
            .groups()
            .into_iter()
            .filter(|g| g.trashed_at.is_some())
            .map(|g| g.id)
            .collect();
        for id in ids {
            self.remove_group(&id);
        }
    }

    pub fn remove_group(&self, id: &str) {
        {
            let mut data = self.data.lock().unwrap();
            let now = now_ms();
            data.groups.retain(|g| g.id != id);
            for note in data.notes.iter_mut().filter(|n| n.group_id == id) {
                note.group_id.clear();
                note.updated_at = now;
            }
            for board in data.boards.iter_mut().filter(|b| b.group_id == id) {
                board.group_id.clear();
                board.updated_at = now;
            }
            bury(&mut data, [id.to_string()], now);
        }
        self.mark_dirty();
    }

    /// The group's notes that are not in the trash.
    pub fn members(&self, id: &str) -> Vec<Note> {
        self.active()
            .into_iter()
            .filter(|n| n.group_id == id)
            .collect()
    }

    /// The group's notes that open as windows with it: those on a board stay
    /// cards in their board.
    pub fn loose_members(&self, id: &str) -> Vec<Note> {
        self.members(id)
            .into_iter()
            .filter(|n| !self.on_board(&n.id))
            .collect()
    }

    /// The group's boards that are not in the trash.
    pub fn board_members(&self, id: &str) -> Vec<Board> {
        self.active_boards()
            .into_iter()
            .filter(|b| b.group_id == id)
            .collect()
    }

    /// Ids of the groups whose members stay off screen: put away or closed.
    /// Whether its group keeps a member off screen: the group is closed with
    /// ✕, or put away (a pinned member stays out, as `put_in` leaves it).
    fn group_hides(&self) -> impl Fn(&str, bool) -> bool {
        let groups: HashMap<String, (bool, bool)> =
            self.active_groups().into_iter().map(|g| (g.id, (g.open, g.hidden))).collect();
        move |id, pinned| groups.get(id).is_some_and(|&(open, hidden)| hidden || (!open && !pinned))
    }

    /// Active notes that are on screen: not closed with ✕, not on a board and
    /// not kept off screen by their group (`group_hides`).
    pub fn visible(&self) -> Vec<Note> {
        let hides = self.group_hides();
        self.active()
            .into_iter()
            .filter(|n| !n.hidden && !hides(&n.group_id, n.pinned) && !self.on_board(&n.id))
            .collect()
    }

    /// Active boards that are on screen, by the same rule as `visible()`.
    pub fn visible_boards(&self) -> Vec<Board> {
        let hides = self.group_hides();
        self.active_boards()
            .into_iter()
            .filter(|b| !b.hidden && !hides(&b.group_id, b.pinned))
            .collect()
    }

    /// Notes not in the trash.
    pub fn active(&self) -> Vec<Note> {
        let data = self.data.lock().unwrap();
        data.notes
            .iter()
            .filter(|n| n.trashed_at.is_none())
            .cloned()
            .collect()
    }

    /// Permanently deletes notes and groups that have been in the trash for
    /// over 30 days.
    /// Returns `true` if any was removed.
    pub fn purge_trash(&self, now: u64) -> bool {
        let removed = {
            let mut data = self.data.lock().unwrap();
            let kept = |t: Option<u64>| t.map_or(true, |t| now.saturating_sub(t) < TRASH_TTL_MS);
            let purged: Vec<String> = data
                .notes
                .iter()
                .filter(|n| !kept(n.trashed_at))
                .map(|n| n.id.clone())
                .chain(
                    data.groups
                        .iter()
                        .filter(|g| !kept(g.trashed_at))
                        .map(|g| g.id.clone()),
                )
                .collect();
            data.notes.retain(|n| kept(n.trashed_at));
            data.groups.retain(|g| kept(g.trashed_at));
            let tombstones = data.deleted.len();
            data.deleted
                .retain(|t| now.saturating_sub(t.deleted_at) < TOMBSTONE_TTL_MS);
            let changed = !purged.is_empty() || tombstones != data.deleted.len();
            if !purged.is_empty() {
                bury(&mut data, purged, now);
                // Notes of purged groups become ungrouped.
                normalize(&mut data);
            }
            changed
        };
        if removed {
            self.mark_dirty();
        }
        removed
    }

    pub fn theme(&self) -> String {
        let theme = self.data.lock().unwrap().theme.clone();
        if THEMES.contains(&theme.as_str()) {
            theme
        } else {
            "system".into()
        }
    }

    pub fn set_theme(&self, theme: &str) {
        self.data.lock().unwrap().theme = theme.to_string();
        self.mark_dirty();
    }

    /// Global zoom (text and controls of every window), within
    /// `ZOOM_MIN`..`ZOOM_MAX`; 1.0 when unset.
    pub fn zoom(&self) -> f64 {
        let zoom = self.data.lock().unwrap().zoom;
        if zoom > 0.0 {
            zoom.clamp(ZOOM_MIN, ZOOM_MAX)
        } else {
            1.0
        }
    }

    pub fn set_zoom(&self, zoom: f64) {
        self.data.lock().unwrap().zoom = zoom.clamp(ZOOM_MIN, ZOOM_MAX);
        self.mark_dirty();
    }

    /// Whether the magnet is on (the default).
    pub fn magnet(&self) -> bool {
        !self.data.lock().unwrap().magnet_off
    }

    pub fn set_magnet(&self, on: bool) {
        self.data.lock().unwrap().magnet_off = !on;
        self.mark_dirty();
    }

    /// Chosen language ("system", "pt-BR" or "en").
    pub fn language(&self) -> String {
        let language = self.data.lock().unwrap().language.clone();
        if LANGUAGES.contains(&language.as_str()) {
            language
        } else {
            "system".into()
        }
    }

    pub fn set_language(&self, language: &str) {
        self.data.lock().unwrap().language = language.to_string();
        self.mark_dirty();
    }

    /// Effective UI language: "pt" or "en". "system" uses the OS language
    /// (Portuguese for pt-*, English otherwise).
    pub fn effective_language(&self) -> &'static str {
        match self.language().as_str() {
            "pt-BR" => "pt",
            "en" => "en",
            _ => match sys_locale::get_locale() {
                Some(locale) if locale.to_lowercase().starts_with("pt") => "pt",
                _ => "en",
            },
        }
    }

    /// Colour new notes start with, as chosen in the manager: a colour or
    /// `RANDOM_COLOR`.
    pub fn default_color(&self) -> String {
        let data = self.data.lock().unwrap();
        match &data.default_color {
            Some(c) if c == RANDOM_COLOR || is_valid_color(c) => c.clone(),
            _ => DEFAULT_NOTE_COLOR.to_string(),
        }
    }

    /// The colour for a note created now (`RANDOM_COLOR` resolved, among
    /// the least used by the notes not in the trash).
    fn new_note_color(&self) -> String {
        let color = self.default_color();
        if color != RANDOM_COLOR {
            return color;
        }
        let data = self.data.lock().unwrap();
        random_color(
            data.notes
                .iter()
                .filter(|n| n.trashed_at.is_none())
                .map(|n| n.color.as_str()),
        )
    }

    pub fn set_default_color(&self, color: &str) {
        let mut data = self.data.lock().unwrap();
        data.default_color = Some(color.to_string());
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    /// Title, text and HTML new notes start with.
    pub fn new_note_defaults(&self) -> (String, String, String) {
        let data = self.data.lock().unwrap();
        (
            data.default_title.clone(),
            data.default_text.clone(),
            data.default_html.clone(),
        )
    }

    pub fn set_default_title(&self, title: String) {
        let mut data = self.data.lock().unwrap();
        data.default_title = title;
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    /// Colour (`RANDOM_COLOR` unless one is chosen) and name new groups
    /// start with.
    pub fn group_defaults(&self) -> (String, String) {
        let data = self.data.lock().unwrap();
        let color = match &data.default_group_color {
            Some(c) if is_valid_color(c) => c.clone(),
            _ => RANDOM_COLOR.to_string(),
        };
        (color, data.default_group_title.clone())
    }

    /// `RANDOM_COLOR` goes back to a random label for each new group.
    pub fn set_default_group_color(&self, color: &str) {
        let mut data = self.data.lock().unwrap();
        data.default_group_color = (color != RANDOM_COLOR).then(|| color.to_string());
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    pub fn set_default_group_title(&self, title: String) {
        let mut data = self.data.lock().unwrap();
        data.default_group_title = title;
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    /// Colour (`""` = none, `RANDOM_COLOR`, a label or `#rrggbb`), name and
    /// columns (`None` = the language's own) new boards start with.
    pub fn board_defaults(&self) -> (String, String, Option<Vec<ColumnDefault>>) {
        let data = self.data.lock().unwrap();
        let color = match &data.default_board_color {
            Some(c) if c == RANDOM_COLOR || is_valid_color(c) => c.clone(),
            _ => String::new(),
        };
        (color, data.default_board_title.clone(), data.default_board_columns.clone())
    }

    /// `""` = new boards start with no colour.
    pub fn set_default_board_color(&self, color: &str) {
        let mut data = self.data.lock().unwrap();
        data.default_board_color = (!color.is_empty()).then(|| color.to_string());
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    pub fn set_default_board_title(&self, title: String) {
        let mut data = self.data.lock().unwrap();
        data.default_board_title = title;
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    /// `None` goes back to the language's columns.
    pub fn set_default_board_columns(&self, columns: Option<Vec<ColumnDefault>>) {
        let mut data = self.data.lock().unwrap();
        data.default_board_columns =
            columns.map(|c| c.iter().take(DEFAULT_COLUMNS_MAX).map(ColumnDefault::clean).collect());
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    pub fn set_default_content(&self, text: String, html: String) {
        let mut data = self.data.lock().unwrap();
        data.default_text = text;
        data.default_html = html;
        data.defaults_updated_at = now_ms();
        drop(data);
        self.mark_dirty();
    }

    /// The note is as it was created: nothing beyond the default title and
    /// text, the default colour (with random colours: the one it was given,
    /// i.e. never edited), and in no group and on no board (joining one is a
    /// change).
    pub fn is_pristine(&self, note: &Note) -> bool {
        let color = self.default_color();
        let default_color = if color == RANDOM_COLOR {
            RANDOM_COLORS.contains(&note.color.as_str()) && note.updated_at == note.created_at
        } else {
            note.color == color
        };
        if !note.group_id.is_empty() || !default_color || self.on_board(&note.id) {
            return false;
        }
        if note.is_blank() {
            return true;
        }
        let (title, text, _) = self.new_note_defaults();
        note.title == title && note.text == text
    }

    /// Whether a board (current or in the trash) holds note `id` in a column.
    pub fn on_board(&self, id: &str) -> bool {
        let data = self.data.lock().unwrap();
        data.boards
            .iter()
            .any(|b| b.columns.iter().any(|c| c.note_ids.iter().any(|n| n == id)))
    }

    /// The group is as it was created: no name beyond the default one, the
    /// default colour (with random colours: the one it was given, i.e. never
    /// edited), and no notes (trashed ones aside).
    pub fn is_pristine_group(&self, id: &str) -> bool {
        let Some(group) = self.group(id) else {
            return false;
        };
        let (title, color) = {
            let data = self.data.lock().unwrap();
            let color = data.default_group_color.clone().filter(|c| is_valid_color(c));
            (data.default_group_title.clone(), color)
        };
        let name = group.name.trim();
        let default_color = match color {
            Some(c) => group.color == c,
            None => {
                RANDOM_COLORS.contains(&group.color.as_str())
                    && group.updated_at == group.created_at
            }
        };
        (name.is_empty() || name == title.trim())
            && default_color
            && self.members(id).is_empty()
            && self.board_members(id).is_empty()
    }

    pub fn boards(&self) -> Vec<Board> {
        self.data.lock().unwrap().boards.clone()
    }

    pub fn board(&self, id: &str) -> Option<Board> {
        self.data
            .lock()
            .unwrap()
            .boards
            .iter()
            .find(|b| b.id == id)
            .cloned()
    }

    pub fn active_boards(&self) -> Vec<Board> {
        self.boards()
            .into_iter()
            .filter(|b| b.trashed_at.is_none())
            .collect()
    }

    pub fn create_board(
        &self,
        name: Option<String>,
        default_cols: Vec<String>,
        pos: Option<(i32, i32)>,
    ) -> Board {
        let columns = default_cols.into_iter().map(|name| ColumnDefault { name, color: String::new() });
        self.insert_board(name.unwrap_or_default(), None, columns.collect(), pos)
    }

    /// New board with the defaults chosen in Settings: name, colour and
    /// columns (`lang_cols`, the language's own, when none are chosen).
    pub fn create_default_board(&self, lang_cols: Vec<String>, pos: Option<(i32, i32)>) -> Board {
        let (color, title, columns) = self.board_defaults();
        let columns = columns.unwrap_or_else(|| {
            lang_cols.into_iter().map(|name| ColumnDefault { name, color: String::new() }).collect()
        });
        self.insert_board(title, Some(color), columns, pos)
    }

    /// `color`: `None` = none, `RANDOM_COLOR` = the least used label.
    fn insert_board(
        &self,
        name: String,
        color: Option<String>,
        columns: Vec<ColumnDefault>,
        pos: Option<(i32, i32)>,
    ) -> Board {
        let board = {
            let mut data = self.data.lock().unwrap();
            let seq = data.next_board_seq.max(1);
            data.next_board_seq = seq + 1;
            let now = now_ms();
            let color = match color {
                Some(c) if c == RANDOM_COLOR => random_color(data.boards.iter().map(|b| b.color.as_str())),
                Some(c) => c,
                None => String::new(),
            };
            let columns = columns
                .into_iter()
                .enumerate()
                .map(|(i, col)| BoardColumn {
                    id: format!("col-{}", i + 1),
                    name: col.name,
                    color: col.color,
                    note_ids: Vec::new(),
                    ..Default::default()
                })
                .collect();
            let board = Board {
                id: format!("{:x}-b{}", now_nanos(), seq),
                name,
                color,
                columns,
                x: pos.map(|p| p.0),
                y: pos.map(|p| p.1),
                created_at: now,
                updated_at: now,
                ..Default::default()
            };
            data.boards.push(board.clone());
            board
        };
        self.mark_dirty();
        board
    }

    pub fn update_board<F: FnOnce(&mut Board)>(&self, id: &str, f: F) -> Option<Board> {
        let updated = {
            let mut data = self.data.lock().unwrap();
            let board = data.boards.iter_mut().find(|b| b.id == id)?;
            let before = board.content();
            f(board);
            if board.content() != before {
                board.updated_at = now_ms();
            }
            board.clone()
        };
        self.mark_dirty();
        Some(updated)
    }

    /// A new memory (the defaults, as `create`) at the bottom of column
    /// `column_id` of board `board_id`. `None` when there is no such column.
    pub fn create_in_column(&self, board_id: &str, column_id: &str) -> Option<Note> {
        let has_column = self
            .board(board_id)
            .is_some_and(|b| b.trashed_at.is_none() && b.columns.iter().any(|c| c.id == column_id));
        if !has_column {
            return None;
        }
        let note = self.create(None);
        self.update_board(board_id, |b| {
            if let Some(c) = b.columns.iter_mut().find(|c| c.id == column_id) {
                c.note_ids.push(note.id.clone());
            }
        });
        Some(note)
    }

    /// Sends board `id` to the trash with the memories on it (a group's
    /// way): they share its `trashed_at`, which is how `restore_board` finds
    /// them. Returns those memories' ids.
    pub fn trash_board(&self, id: &str) -> Vec<String> {
        let now = now_ms();
        let Some(board) = self.update_board(id, |b| b.trashed_at = Some(now)) else {
            return Vec::new();
        };
        let mut trashed = Vec::new();
        for note_id in board.columns.iter().flat_map(|c| c.note_ids.iter()) {
            let on = self.update(note_id, |n| {
                if n.trashed_at.is_none() {
                    n.trashed_at = Some(now);
                }
            });
            if on.is_some_and(|n| n.trashed_at == Some(now)) {
                trashed.push(note_id.clone());
            }
        }
        trashed
    }

    /// Brings board `id` back with the memories that went to the trash with
    /// it (on its columns, trashed since it was).
    pub fn restore_board(&self, id: &str) {
        let Some(board) = self.board(id) else { return };
        let since = board.trashed_at;
        self.update_board(id, |b| b.trashed_at = None);
        let Some(since) = since else { return };
        for note_id in board.columns.iter().flat_map(|c| c.note_ids.iter()) {
            self.update(note_id, |n| {
                if n.trashed_at.is_some_and(|t| t >= since) {
                    n.trashed_at = None;
                }
            });
        }
    }

    /// Permanently deletes every board in the trash (their memories stay).
    pub fn empty_board_trash(&self) {
        let ids: Vec<String> = self
            .boards()
            .into_iter()
            .filter(|b| b.trashed_at.is_some())
            .map(|b| b.id)
            .collect();
        for id in ids {
            self.remove_board(&id);
        }
    }

    pub fn remove_board(&self, id: &str) {
        {
            let mut data = self.data.lock().unwrap();
            data.boards.retain(|b| b.id != id);
        }
        self.mark_dirty();
    }

    /// The board is as it was created: no name beyond the default one, the
    /// default colour (with random colours: the one it was given, i.e. never
    /// edited), and no memories.
    pub fn is_pristine_board(&self, id: &str) -> bool {
        let Some(board) = self.board(id) else {
            return false;
        };
        let (color, title, _) = self.board_defaults();
        let name = board.name.trim();
        let default_color = if color == RANDOM_COLOR {
            RANDOM_COLORS.contains(&board.color.as_str()) && board.updated_at == board.created_at
        } else {
            board.color == color
        };
        (name.is_empty() || name == title.trim())
            && default_color
            && board.columns.iter().all(|c| c.note_ids.is_empty())
    }

    pub fn remove_note_from_boards(&self, note_id: &str) {
        let mut changed = false;
        {
            let mut data = self.data.lock().unwrap();
            for b in &mut data.boards {
                for col in &mut b.columns {
                    if col.note_ids.contains(&note_id.to_string()) {
                        col.note_ids.retain(|id| id != note_id);
                        changed = true;
                    }
                }
            }
        }
        if changed {
            self.mark_dirty();
        }
    }

    pub fn manager(&self) -> ManagerState {
        let mut mgr = self.data.lock().unwrap().manager.clone();
        if !LAYOUTS.contains(&mgr.layout.as_str()) {
            mgr.layout = "cards".into();
        }
        mgr
    }

    /// Layout of the manager's Memories and Groups tabs (see `LAYOUTS`).
    pub fn manager_layout(&self) -> String {
        let layout = self.data.lock().unwrap().manager.layout.clone();
        if LAYOUTS.contains(&layout.as_str()) {
            layout
        } else {
            "cards".into()
        }
    }

    /// Applies `f` to the manager window state and returns a copy.
    pub fn update_manager<F: FnOnce(&mut ManagerState)>(&self, f: F) -> ManagerState {
        let state = {
            let mut data = self.data.lock().unwrap();
            f(&mut data.manager);
            data.manager.clone()
        };
        self.mark_dirty();
        state
    }

    /// All notes, active and trashed (for the manager).
    pub fn all(&self) -> Vec<Note> {
        self.data.lock().unwrap().notes.clone()
    }

    pub fn empty_trash(&self) {
        let mut data = self.data.lock().unwrap();
        let trashed: Vec<String> = data
            .notes
            .iter()
            .filter(|n| n.trashed_at.is_some())
            .map(|n| n.id.clone())
            .collect();
        data.notes.retain(|n| n.trashed_at.is_none());
        bury(&mut data, trashed, now_ms());
        drop(data);
        self.mark_dirty();
    }

    pub fn get(&self, id: &str) -> Option<Note> {
        self.data
            .lock()
            .unwrap()
            .notes
            .iter()
            .find(|n| n.id == id)
            .cloned()
    }

    /// No note has ever been created (first run of the app).
    pub fn is_first_run(&self) -> bool {
        let data = self.data.lock().unwrap();
        data.notes.is_empty() && data.next_seq <= 1
    }

    pub fn create(&self, pos: Option<(i32, i32)>) -> Note {
        let color = self.new_note_color();
        let (title, text, html) = self.new_note_defaults();
        let note = {
            let mut data = self.data.lock().unwrap();
            let seq = data.next_seq.max(1);
            data.next_seq = seq + 1;
            let now = now_ms();
            let note = Note {
                id: format!("{:x}-{}", now_nanos(), seq),
                seq,
                x: pos.map(|p| p.0),
                y: pos.map(|p| p.1),
                color,
                title,
                text,
                html,
                created_at: now,
                updated_at: now,
                ..Default::default()
            };
            data.notes.push(note.clone());
            note
        };
        self.mark_dirty();
        note
    }

    /// Applies `f` to the note and returns an updated copy. `updated_at`
    /// follows changes to its content (not to its layout).
    pub fn update<F: FnOnce(&mut Note)>(&self, id: &str, f: F) -> Option<Note> {
        let updated = {
            let mut data = self.data.lock().unwrap();
            let note = data.notes.iter_mut().find(|n| n.id == id)?;
            let before = note.content();
            f(note);
            if note.content() != before {
                note.updated_at = now_ms();
            }
            note.clone()
        };
        self.mark_dirty();
        Some(updated)
    }

    pub fn remove(&self, id: &str) {
        let mut data = self.data.lock().unwrap();
        data.notes.retain(|n| n.id != id);
        bury(&mut data, [id.to_string()], now_ms());
        drop(data);
        self.mark_dirty();
    }

    // --------------------------------------------------------- cloud sync

    pub fn sync_snapshot(&self) -> SyncSnapshot {
        let data = self.data.lock().unwrap();
        SyncSnapshot {
            notes: data.notes.clone(),
            groups: data.groups.clone(),
            deleted: data.deleted.clone(),
            settings: SettingsDoc {
                version: 1,
                default_color: data.default_color.clone(),
                default_title: data.default_title.clone(),
                default_text: data.default_text.clone(),
                default_html: data.default_html.clone(),
                default_group_color: data.default_group_color.clone(),
                default_group_title: data.default_group_title.clone(),
                default_board_color: data.default_board_color.clone(),
                default_board_title: data.default_board_title.clone(),
                default_board_columns: data.default_board_columns.clone(),
                updated_at: data.defaults_updated_at,
            },
        }
    }

    /// The sync bookkeeping for `cloud`.
    pub fn sync_state(&self, cloud: Provider) -> SyncState {
        let data = self.data.lock().unwrap();
        match cloud {
            Provider::Google => data.sync.clone(),
            Provider::Microsoft => data.sync_microsoft.clone(),
        }
    }

    pub fn update_sync<F: FnOnce(&mut SyncState)>(&self, cloud: Provider, f: F) {
        {
            let mut data = self.data.lock().unwrap();
            f(match cloud {
                Provider::Google => &mut data.sync,
                Provider::Microsoft => &mut data.sync_microsoft,
            });
        }
        self.mark_dirty();
    }

    /// Applies a note from the cloud as is (its stamps included, so it isn't
    /// sent back). A note new to this computer arrives closed, and so does
    /// one restored from the trash elsewhere: the manager lists them.
    pub fn apply_note_doc(&self, doc: &NoteDoc) -> Applied {
        let mut data = self.data.lock().unwrap();
        let index = data.notes.iter().position(|n| n.id == doc.id);
        let applied = if doc.deleted {
            match index {
                Some(i) => {
                    data.notes.remove(i);
                    Applied::Removed
                }
                None => Applied::Unchanged,
            }
        } else {
            let color = if is_valid_color(&doc.color) {
                doc.color.clone()
            } else {
                DEFAULT_NOTE_COLOR.to_string()
            };
            let content = NoteContent {
                title: doc.title.chars().take(TITLE_MAX).collect(),
                text: doc.text.clone(),
                html: doc.html.clone(),
                color,
                group_id: doc.group_id.clone(),
                trashed_at: doc.trashed_at,
            };
            match index {
                Some(i) => {
                    let note = &mut data.notes[i];
                    let was_trashed = note.trashed_at.is_some();
                    let changed = note.content() != content;
                    set_content(note, content);
                    note.updated_at = doc.updated_at;
                    note.created_at = doc.created_at;
                    match (was_trashed, note.trashed_at.is_some()) {
                        (false, true) => Applied::Trashed,
                        (true, false) => {
                            note.hidden = true;
                            Applied::Updated
                        }
                        _ if changed => Applied::Updated,
                        _ => Applied::Unchanged,
                    }
                }
                None => {
                    // Deleted here and edited elsewhere: the edit wins.
                    data.deleted.retain(|t| t.id != doc.id);
                    let seq = data.next_seq.max(1);
                    data.next_seq = seq + 1;
                    let mut note = Note {
                        id: doc.id.clone(),
                        seq,
                        created_at: doc.created_at,
                        updated_at: doc.updated_at,
                        hidden: true,
                        ..Default::default()
                    };
                    set_content(&mut note, content);
                    data.notes.push(note);
                    Applied::Created
                }
            }
        };
        if doc.deleted {
            data.deleted.retain(|t| t.id != doc.id);
            data.deleted.push(Tombstone {
                id: doc.id.clone(),
                deleted_at: doc.deleted_at,
            });
        }
        drop(data);
        if applied != Applied::Unchanged || doc.deleted {
            self.mark_dirty();
        }
        applied
    }

    /// Applies a group from the cloud as is. A group new to this computer
    /// arrives closed (no bar until the manager opens it). Returns `true` if
    /// anything changed.
    pub fn apply_group_doc(&self, doc: &GroupDoc) -> bool {
        let mut data = self.data.lock().unwrap();
        let index = data.groups.iter().position(|g| g.id == doc.id);
        let changed = if doc.deleted {
            data.deleted.retain(|t| t.id != doc.id);
            data.deleted.push(Tombstone {
                id: doc.id.clone(),
                deleted_at: doc.deleted_at,
            });
            if let Some(i) = index {
                data.groups.remove(i);
                for note in data.notes.iter_mut().filter(|n| n.group_id == doc.id) {
                    note.group_id.clear();
                }
            }
            true
        } else {
            let color = if is_valid_color(&doc.color) {
                doc.color.clone()
            } else {
                DEFAULT_COLOR.to_string()
            };
            let name: String = doc.name.chars().take(GROUP_NAME_MAX).collect();
            let group = match index {
                Some(i) => &mut data.groups[i],
                None => {
                    data.groups.push(Group {
                        id: doc.id.clone(),
                        hidden: true,
                        open: false,
                        ..Default::default()
                    });
                    data.groups.last_mut().unwrap()
                }
            };
            let changed = index.is_none()
                || group.content() != (name.clone(), color.clone(), doc.trashed_at);
            group.name = name;
            group.color = color;
            group.trashed_at = doc.trashed_at;
            group.created_at = doc.created_at;
            group.updated_at = doc.updated_at;
            changed
        };
        drop(data);
        if changed {
            self.mark_dirty();
        }
        changed
    }

    /// Settings → "Restore default settings": new memories, groups and
    /// boards start as Memo comes (and the cloud gets that, as an edit).
    pub fn reset_defaults(&self) {
        self.apply_settings_doc(&SettingsDoc { updated_at: now_ms(), ..Default::default() });
    }

    pub fn apply_settings_doc(&self, doc: &SettingsDoc) {
        let mut data = self.data.lock().unwrap();
        data.default_color = doc
            .default_color
            .clone()
            .filter(|c| c == RANDOM_COLOR || is_valid_color(c));
        data.default_title = doc.default_title.chars().take(TITLE_MAX).collect();
        data.default_text = doc.default_text.chars().take(DEFAULT_TEXT_MAX).collect();
        data.default_html = doc.default_html.clone();
        data.default_group_color = doc.default_group_color.clone().filter(|c| is_valid_color(c));
        data.default_group_title = doc.default_group_title.chars().take(GROUP_NAME_MAX).collect();
        data.default_board_color =
            doc.default_board_color.clone().filter(|c| c == RANDOM_COLOR || is_valid_color(c));
        data.default_board_title = doc.default_board_title.chars().take(BOARD_NAME_MAX).collect();
        data.default_board_columns = doc
            .default_board_columns
            .as_ref()
            .map(|c| c.iter().take(DEFAULT_COLUMNS_MAX).map(ColumnDefault::clean).collect());
        data.defaults_updated_at = doc.updated_at;
        drop(data);
        self.mark_dirty();
    }

    /// Keeps the version of a note that lost a conflict: a new note in the
    /// trash, titled "<title> (<suffix>)", so no text is lost.
    pub fn add_conflict_copy(&self, doc: &NoteDoc, suffix: &str) -> Note {
        let mut data = self.data.lock().unwrap();
        let seq = data.next_seq.max(1);
        data.next_seq = seq + 1;
        let now = now_ms();
        let base = if doc.title.trim().is_empty() {
            doc.text.lines().next().unwrap_or("").trim().to_string()
        } else {
            doc.title.clone()
        };
        let title: String = format!("{base} ({suffix})").trim_start().to_string();
        let note = Note {
            id: format!("{:x}-{}", now_nanos(), seq),
            seq,
            title: title.chars().take(TITLE_MAX).collect(),
            text: doc.text.clone(),
            html: doc.html.clone(),
            color: if is_valid_color(&doc.color) { doc.color.clone() } else { DEFAULT_NOTE_COLOR.to_string() },
            created_at: now,
            updated_at: now,
            trashed_at: Some(now),
            hidden: true,
            ..Default::default()
        };
        data.notes.push(note.clone());
        drop(data);
        self.mark_dirty();
        note
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::SeqCst);
    }

    /// Writes to disk if there are pending changes.
    pub fn flush(&self) {
        let path = self.path.lock().unwrap();
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Err(err) = self.write(&path) {
            eprintln!("memo: failed to save notes: {err}");
            self.mark_dirty();
        }
    }

    fn write(&self, path: &Path) -> io::Result<()> {
        let json = {
            let mut data = self.data.lock().unwrap();
            data.version = 1;
            serde_json::to_string_pretty(&*data)
        };
        write_atomic(path, &json.map_err(io::Error::other)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("memo-store-test-{name}-{}", now_nanos()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn content_vs_layout_updated_at() {
        let dir = temp_dir("layout");
        let store = Store::load(dir.join("notes.json"));
        let n = store.create(Some((10, 20)));
        let g = store.create_group(Some((30, 40)));

        // Pin updated_at in the past so any content edit advances it.
        store.data.lock().unwrap().notes[0].updated_at = 1000;
        store.data.lock().unwrap().groups[0].updated_at = 1000;

        // Layout-only updates on a note must NOT bump updated_at.
        let n = store
            .update(&n.id, |note| {
                note.x = Some(100);
                note.y = Some(200);
                note.width = 400.0;
                note.height = 500.0;
                note.pinned = true;
                note.hidden = true;
            })
            .unwrap();
        assert_eq!(n.updated_at, 1000);

        // Content update on a note MUST bump updated_at.
        let n = store
            .update(&n.id, |note| {
                note.text = "Hello".into();
                note.html = "<div>Hello</div>".into();
            })
            .unwrap();
        assert!(n.updated_at > 1000);

        // Layout-only updates on a group must NOT bump updated_at.
        let g = store
            .update_group(&g.id, |group| {
                group.x = Some(120);
                group.y = Some(240);
                group.width = 360.0;
                group.open = false;
                group.pinned = true;
                group.hidden = true;
            })
            .unwrap();
        assert_eq!(g.updated_at, 1000);

        // Content update on a group MUST bump updated_at.
        let g = store
            .update_group(&g.id, |group| {
                group.name = "Work".into();
            })
            .unwrap();
        assert!(g.updated_at > 1000);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_on_a_board_is_not_pristine() {
        let dir = temp_dir("board-pristine");
        let store = Store::load(dir.join("notes.json"));
        // Like joining a group, being put on a board is a change: an empty
        // note there is kept when its window closes.
        let note = store.create(None);
        assert!(store.is_pristine(&note));
        let board = store.create_board(None, vec!["To Do".into()], None);
        store.update_board(&board.id, |b| b.columns[0].note_ids.push(note.id.clone()));
        assert!(store.on_board(&note.id));
        assert!(!store.is_pristine(&note));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn emptying_the_board_trash_keeps_current_boards_and_memories() {
        let dir = temp_dir("board-trash");
        let store = Store::load(dir.join("notes.json"));
        let note = store.create(None);
        let old = store.create_board(Some("Old".into()), vec!["A".into()], None);
        let live = store.create_board(Some("Live".into()), Vec::new(), None);
        store.update_board(&old.id, |b| b.columns[0].note_ids = vec![note.id.clone()]);
        store.trash_board(&old.id);
        store.empty_board_trash();
        let boards: Vec<String> = store.boards().into_iter().map(|b| b.id).collect();
        assert_eq!(boards, vec![live.id], "only the trashed board goes");
        assert!(store.get(&note.id).is_some(), "its memories stay");
    }

    #[test]
    fn restoring_default_settings_clears_every_default() {
        let dir = temp_dir("reset-defaults");
        let store = Store::load(dir.join("notes.json"));
        let fresh = (store.default_color(), store.new_note_defaults(), store.group_defaults(), store.board_defaults());
        store.set_default_color("coral");
        store.set_default_title("T".into());
        store.set_default_content("x".into(), "<p>x</p>".into());
        store.set_default_group_color("teal");
        store.set_default_group_title("G".into());
        store.set_default_board_color("iris");
        store.set_default_board_title("B".into());
        store.set_default_board_columns(Some(vec![]));
        store.reset_defaults();
        let after = (store.default_color(), store.new_note_defaults(), store.group_defaults(), store.board_defaults());
        assert_eq!(format!("{after:?}"), format!("{fresh:?}"));
        assert!(store.data.lock().unwrap().defaults_updated_at > 0, "the cloud gets the reset as an edit");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_memory_in_a_column_goes_to_its_bottom() {
        let dir = temp_dir("board-column-note");
        let store = Store::load(dir.join("notes.json"));
        let board = store.create_board(Some("B".into()), vec!["A".into(), "B".into()], None);
        let col = board.columns[1].id.clone();
        let first = store.create_in_column(&board.id, &col).unwrap();
        let second = store.create_in_column(&board.id, &col).unwrap();
        let b = store.board(&board.id).unwrap();
        assert!(b.columns[0].note_ids.is_empty());
        assert_eq!(b.columns[1].note_ids, vec![first.id, second.id]);
        assert!(store.create_in_column(&board.id, "no-such-column").is_none());
        assert_eq!(store.active().len(), 2, "no memory without a column");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_trashed_board_takes_its_memories_and_brings_them_back() {
        let dir = temp_dir("board-trash-notes");
        let store = Store::load(dir.join("notes.json"));
        let on = store.create(None);
        let earlier = store.create(None);
        let loose = store.create(None);
        for id in [&on.id, &earlier.id, &loose.id] {
            store.update(id, |n| n.text = "x".into());
        }
        // A memory trashed before the board stays in the trash after it.
        store.update(&earlier.id, |n| n.trashed_at = Some(1));
        let board = store.create_board(Some("B".into()), vec!["A".into()], None);
        store.update_board(&board.id, |b| b.columns[0].note_ids = vec![on.id.clone(), earlier.id.clone()]);

        let trashed = store.trash_board(&board.id);
        assert_eq!(trashed, vec![on.id.clone()], "only what was current goes with it");
        assert!(store.board(&board.id).unwrap().trashed_at.is_some());
        assert!(store.get(&on.id).unwrap().trashed_at.is_some(), "its memory goes to the trash too");
        assert!(store.get(&loose.id).unwrap().trashed_at.is_none(), "memories elsewhere stay");

        store.restore_board(&board.id);
        assert!(store.board(&board.id).unwrap().trashed_at.is_none());
        assert!(store.get(&on.id).unwrap().trashed_at.is_none(), "it comes back with the board");
        assert_eq!(store.get(&earlier.id).unwrap().trashed_at, Some(1), "one trashed before stays there");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_boards_start_with_the_board_defaults() {
        let dir = temp_dir("board-defaults");
        let store = Store::load(dir.join("notes.json"));
        let lang = || vec!["To Do".to_string(), "Done".to_string()];
        // Nothing chosen: no name, no colour, the language's columns.
        let plain = store.create_default_board(lang(), None);
        assert_eq!((plain.name.as_str(), plain.color.as_str()), ("", ""));
        assert_eq!(plain.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["To Do", "Done"]);
        assert!(store.is_pristine_board(&plain.id));

        store.set_default_board_color("teal");
        store.set_default_board_title("Sprint".into());
        let col = |name: &str, color: &str| ColumnDefault { name: name.into(), color: color.into() };
        store.set_default_board_columns(Some(vec![col("Ideas", "coral"), col(" Now ", "nope")]));
        let board = store.create_default_board(lang(), None);
        assert_eq!((board.name.as_str(), board.color.as_str()), ("Sprint", "teal"));
        let cols: Vec<_> = board.columns.iter().map(|c| (c.name.as_str(), c.color.as_str())).collect();
        assert_eq!(cols, [("Ideas", "coral"), ("Now", "")], "names trimmed, unknown colours dropped");
        assert!(store.is_pristine_board(&board.id), "a board with only the defaults is untouched");

        // They are saved, and travel with the other defaults.
        store.flush();
        let again = Store::load(dir.join("notes.json"));
        assert_eq!(again.board_defaults(), store.board_defaults());
        let doc = store.sync_snapshot().settings;
        assert_eq!(doc.default_board_title, "Sprint");

        // Random gives each new board a label; None goes back to the language's columns.
        store.set_default_board_color(RANDOM_COLOR);
        store.set_default_board_columns(None);
        let random = store.create_default_board(lang(), None);
        assert!(RANDOM_COLORS.contains(&random.color.as_str()));
        assert_eq!(random.columns.len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pinned_members_stay_out_of_a_group_put_away() {
        let dir = temp_dir("pinned-out");
        let store = Store::load(dir.join("notes.json"));
        let group = store.create_group(None);
        let loose = store.create(None);
        let pinned = store.create(None);
        for id in [&loose.id, &pinned.id] {
            store.update(id, |n| n.group_id = group.id.clone());
        }
        store.update(&pinned.id, |n| n.pinned = true);
        let ids = |notes: Vec<Note>| notes.into_iter().map(|n| n.id).collect::<Vec<_>>();
        store.update_group(&group.id, |g| g.open = false);
        assert_eq!(ids(store.visible()), vec![pinned.id.clone()], "put away: only the pinned one is out");
        store.update_group(&group.id, |g| g.hidden = true);
        assert!(store.visible().is_empty(), "closed with the bar's ✕: none");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn board_columns_keep_folded_memories() {
        // Columns saved before folding existed load with none folded.
        let old: BoardColumn = serde_json::from_str(r#"{"id":"c1","name":"","color":"teal","noteIds":["a"]}"#).unwrap();
        assert!(old.collapsed.is_empty());
        let folded: BoardColumn = serde_json::from_str(r#"{"id":"c1","noteIds":["a","b"],"collapsed":["b"]}"#).unwrap();
        assert_eq!(folded.collapsed, vec!["b".to_string()]);
        assert!(serde_json::to_string(&folded).unwrap().contains(r#""collapsed":["b"]"#));
    }

    #[test]
    fn notes_on_a_board_stay_in_it() {
        let dir = temp_dir("board-loose");
        let store = Store::load(dir.join("notes.json"));
        // A note in a group and on a board doesn't open with the group nor
        // at startup: it is a card in its board.
        let group = store.create_group(None);
        let loose = store.create(None);
        let carded = store.create(None);
        for id in [&loose.id, &carded.id] {
            store.update(id, |n| n.group_id = group.id.clone());
        }
        let board = store.create_board(None, vec!["To Do".into()], None);
        store.update_board(&board.id, |b| b.columns[0].note_ids.push(carded.id.clone()));
        let ids = |notes: Vec<Note>| notes.into_iter().map(|n| n.id).collect::<Vec<_>>();
        assert_eq!(ids(store.loose_members(&group.id)), vec![loose.id.clone()]);
        assert!(!ids(store.visible()).contains(&carded.id));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn visible_boards_follow_their_group_like_notes() {
        let dir = temp_dir("board-visible");
        let store = Store::load(dir.join("notes.json"));
        let board = store.create_board(None, vec!["To Do".into()], None);
        assert_eq!(store.visible_boards().len(), 1);
        let group = store.create_group(None);
        store.update_board(&board.id, |b| b.group_id = group.id.clone());
        assert_eq!(store.visible_boards().len(), 1);
        // A group closed with ✕ or put away keeps its boards off screen, as
        // it does its notes.
        store.update_group(&group.id, |g| g.hidden = true);
        assert!(store.visible_boards().is_empty());
        store.update_group(&group.id, |g| { g.hidden = false; g.open = false; });
        assert!(store.visible_boards().is_empty());
        store.update_board(&board.id, |b| b.hidden = true);
        store.update_group(&group.id, |g| g.open = true);
        assert!(store.visible_boards().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn selectors_pristine_and_groups() {
        let dir = temp_dir("groups");
        let store = Store::load(dir.join("notes.json"));
        assert!(store.is_first_run());

        let n1 = store.create(None);
        assert!(!store.is_first_run());
        assert!(store.is_pristine(&n1));

        let g = store.create_group(None);
        assert!(store.is_pristine_group(&g.id));

        // Joining a group makes both the note and the group non-pristine.
        let n1 = store.update(&n1.id, |n| n.group_id = g.id.clone()).unwrap();
        assert!(!store.is_pristine(&n1));
        assert!(!store.is_pristine_group(&g.id));
        assert_eq!(store.visible().len(), 1);

        // Putting the group away hides its notes from visible() while keeping them active().
        store.update_group(&g.id, |grp| grp.open = false);
        assert_eq!(store.active().len(), 1);
        assert_eq!(store.visible().len(), 0);

        // Taking notes out again makes them visible, unless closed with ✕ (hidden).
        store.update_group(&g.id, |grp| grp.open = true);
        assert_eq!(store.visible().len(), 1);
        store.update(&n1.id, |n| n.hidden = true);
        assert_eq!(store.visible().len(), 0);
        assert_eq!(store.active().len(), 1);

        // Removing a group unlinks its notes and records a tombstone.
        store.remove_group(&g.id);
        assert_eq!(store.get(&n1.id).unwrap().group_id, "");
        assert!(store.sync_snapshot().deleted.iter().any(|t| t.id == g.id));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_purge_and_tombstones() {
        let dir = temp_dir("trash");
        let store = Store::load(dir.join("notes.json"));
        let n = store.create(None);
        store.update(&n.id, |note| note.trashed_at = Some(1_000));
        assert!(store.active().is_empty());

        // Before TRASH_TTL_MS: kept.
        assert!(!store.purge_trash(1_000 + TRASH_TTL_MS - 1));
        assert!(store.get(&n.id).is_some());

        // At TRASH_TTL_MS: purged and buried as a tombstone.
        let purge_time = 1_000 + TRASH_TTL_MS;
        assert!(store.purge_trash(purge_time));
        assert!(store.get(&n.id).is_none());
        assert!(store.sync_snapshot().deleted.iter().any(|t| t.id == n.id));

        // After TOMBSTONE_TTL_MS: tombstone is pruned.
        assert!(store.purge_trash(purge_time + TOMBSTONE_TTL_MS));
        assert!(store.sync_snapshot().deleted.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupted_backup_and_export_import() {
        let dir = temp_dir("io");
        let notes_path = dir.join("notes.json");

        // Unreadable notes.json must be backed up as notes.corrupted-*.json, never lost.
        fs::write(&notes_path, "{ not valid json").unwrap();
        let store = Store::load(notes_path.clone());
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("notes.corrupted-"))
            .collect();
        assert_eq!(backups.len(), 1);

        let keep = store.create(None);
        store.update(&keep.id, |n| {
            n.title = "Keep".into();
            n.updated_at = 2_000;
        });
        let trashed = store.create(None);
        store.update(&trashed.id, |n| n.trashed_at = Some(2_000));

        // Export omits trashed notes and tombstones.
        let export_path = dir.join("export.json");
        store.export_to(&export_path).unwrap();

        let dir2 = temp_dir("io2");
        let store2 = Store::load(dir2.join("notes.json"));
        let imported = store2.import_from(&export_path).unwrap();
        assert_eq!(imported, vec![keep.id.clone()]);
        assert!(store2.get(&trashed.id).is_none());

        // Importing an older version does not overwrite a newer local edit.
        store2.update(&keep.id, |n| {
            n.title = "Newer local".into();
            n.updated_at = 5_000;
        });
        let imported_again = store2.import_from(&export_path).unwrap();
        assert!(imported_again.is_empty());
        assert_eq!(store2.get(&keep.id).unwrap().title, "Newer local");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }
}
