//! Note persistence: a single `notes.json` in the app data folder.
//!
//! Changes are kept in memory and a thread writes to disk when something is
//! pending, so dragging or resizing a note doesn't hit the disk on every
//! pixel. Writes are atomic (temporary file + rename).

use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
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

/// Colour every new note starts with.
pub const DEFAULT_COLOR: &str = "yellow";

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
            color: DEFAULT_COLOR.to_string(),
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
    /// Position, size and state of the manager window.
    manager: ManagerState,
    /// Colour for new notes, chosen in the manager; `None` = `DEFAULT_COLOR`.
    default_color: Option<String>,
    /// Title and text (plain, with "[ ] " for checklist items) of new notes,
    /// set in the manager. Empty = blank note.
    default_title: String,
    default_text: String,
    /// The same default text with formatting (HTML from the note editor).
    default_html: String,
    /// Colour new groups start with, set in the manager; `None` =
    /// `DEFAULT_COLOR` (yellow, as for notes).
    default_group_color: Option<String>,
    /// Name new groups start with; empty = unnamed.
    default_group_title: String,
    notes: Vec<Note>,
    /// Groups of notes (compact bars that show or hide their notes).
    groups: Vec<Group>,
    next_group_seq: u32,
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
            trashed_at: None,
            hidden: false,
        }
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
    data.groups.retain(|g| !g.id.is_empty());
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

        let store = Self {
            path: Mutex::new(path),
            data: Mutex::new(data),
            dirty: AtomicBool::new(false),
        };
        store.purge_trash(now_ms());
        store
    }

    /// Path of the current `notes.json`.
    pub fn path(&self) -> PathBuf {
        self.path.lock().unwrap().clone()
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
            *self.data.lock().unwrap() = data;
            *current = path;
            drop(current);
            self.purge_trash(now_ms());
            Ok(true)
        } else {
            if path.exists() {
                fs::copy(
                    &path,
                    path.with_extension(format!("backup-{}.json", now_ms())),
                )?;
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
        let json = {
            let mut copy = self.data.lock().unwrap().clone();
            copy.version = 1;
            copy.notes.retain(|n| n.trashed_at.is_none());
            copy.groups.retain(|g| g.trashed_at.is_none());
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
        let imported = read(path)?;
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
                _ => DEFAULT_COLOR.to_string(),
            };
            let group = Group {
                id: format!("{:x}-g{}", now_nanos(), seq),
                name: data.default_group_title.clone(),
                color,
                x: pos.map(|p| p.0),
                y: pos.map(|p| p.1),
                created_at: now_ms(),
                ..Default::default()
            };
            data.groups.push(group.clone());
            group
        };
        self.mark_dirty();
        group
    }

    /// Applies `f` to the group and returns an updated copy.
    pub fn update_group<F: FnOnce(&mut Group)>(&self, id: &str, f: F) -> Option<Group> {
        let updated = {
            let mut data = self.data.lock().unwrap();
            let group = data.groups.iter_mut().find(|g| g.id == id)?;
            f(group);
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
            data.groups.retain(|g| g.id != id);
            for note in data.notes.iter_mut().filter(|n| n.group_id == id) {
                note.group_id.clear();
            }
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
            let before = (data.notes.len(), data.groups.len());
            data.notes.retain(|n| kept(n.trashed_at));
            data.groups.retain(|g| kept(g.trashed_at));
            let changed = before != (data.notes.len(), data.groups.len());
            if changed {
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

    /// Colour new notes start with.
    pub fn default_color(&self) -> String {
        let data = self.data.lock().unwrap();
        match &data.default_color {
            Some(c) if is_valid_color(c) => c.clone(),
            _ => DEFAULT_COLOR.to_string(),
        }
    }

    pub fn set_default_color(&self, color: &str) {
        self.data.lock().unwrap().default_color = Some(color.to_string());
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
        self.data.lock().unwrap().default_title = title;
        self.mark_dirty();
    }

    /// Colour (yellow unless chosen, as for notes) and name new groups start
    /// with.
    pub fn group_defaults(&self) -> (String, String) {
        let data = self.data.lock().unwrap();
        let color = match &data.default_group_color {
            Some(c) if is_valid_color(c) => c.clone(),
            _ => DEFAULT_COLOR.to_string(),
        };
        (color, data.default_group_title.clone())
    }

    pub fn set_default_group_color(&self, color: &str) {
        self.data.lock().unwrap().default_group_color = Some(color.to_string());
        self.mark_dirty();
    }

    pub fn set_default_group_title(&self, title: String) {
        self.data.lock().unwrap().default_group_title = title;
        self.mark_dirty();
    }

    pub fn set_default_content(&self, text: String, html: String) {
        let mut data = self.data.lock().unwrap();
        data.default_text = text;
        data.default_html = html;
        drop(data);
        self.mark_dirty();
    }

    /// The note is as it was created: nothing beyond the default title and text.
    pub fn is_pristine(&self, note: &Note) -> bool {
        if note.is_blank() {
            return true;
        }
        let (title, text, _) = self.new_note_defaults();
        note.title == title && note.text == text
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
        self.data
            .lock()
            .unwrap()
            .notes
            .retain(|n| n.trashed_at.is_none());
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
        let color = self.default_color();
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

    /// Applies `f` to the note and returns an updated copy.
    pub fn update<F: FnOnce(&mut Note)>(&self, id: &str, f: F) -> Option<Note> {
        let updated = {
            let mut data = self.data.lock().unwrap();
            let note = data.notes.iter_mut().find(|n| n.id == id)?;
            f(note);
            note.clone()
        };
        self.mark_dirty();
        Some(updated)
    }

    pub fn remove(&self, id: &str) {
        self.data.lock().unwrap().notes.retain(|n| n.id != id);
        self.mark_dirty();
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
