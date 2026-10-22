//! Note persistence: a single `notes.json` in the app data folder.
//!
//! Changes are kept in memory and a thread writes to disk when something is
//! pending, so dragging or resizing a note doesn't hit the disk on every
//! pixel. Writes are atomic (temporary file + rename).

use crate::images;
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
    notes: Vec<Note>,
    /// Groups of notes (compact bars that show or hide their notes).
    groups: Vec<Group>,
    next_group_seq: u32,
    /// When a new-note or new-group default last changed.
    defaults_updated_at: u64,
    /// Notes and groups deleted for good, kept for `TOMBSTONE_TTL_MS`.
    deleted: Vec<Tombstone>,
    /// Cloud sync bookkeeping (see `SyncState`); per machine, like the rest
    /// of this file.
    sync: SyncState,
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
    pub state: SyncState,
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
        }
    }
}

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

    /// Active notes that are on screen: not closed with ✕ and not inside a
    /// group that is put away or closed.
    pub fn visible(&self) -> Vec<Note> {
        let closed: HashSet<String> = self
            .active_groups()
            .into_iter()
            .filter(|g| !g.open || g.hidden)
            .map(|g| g.id)
            .collect();
        self.active()
            .into_iter()
            .filter(|n| !n.hidden && !closed.contains(&n.group_id))
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
    /// i.e. never edited), and in no group (joining one is a change).
    pub fn is_pristine(&self, note: &Note) -> bool {
        let color = self.default_color();
        let default_color = if color == RANDOM_COLOR {
            RANDOM_COLORS.contains(&note.color.as_str()) && note.updated_at == note.created_at
        } else {
            note.color == color
        };
        if !note.group_id.is_empty() || !default_color {
            return false;
        }
        if note.is_blank() {
            return true;
        }
        let (title, text, _) = self.new_note_defaults();
        note.title == title && note.text == text
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
    }

    pub fn manager(&self) -> ManagerState {
        self.data.lock().unwrap().manager.clone()
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
                updated_at: data.defaults_updated_at,
            },
            state: data.sync.clone(),
        }
    }

    pub fn update_sync<F: FnOnce(&mut SyncState)>(&self, f: F) {
        f(&mut self.data.lock().unwrap().sync);
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
