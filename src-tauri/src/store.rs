//! Note persistence: a single `notes.json` in the app data folder.
//!
//! Changes are kept in memory and a thread writes to disk when something is
//! pending, so dragging or resizing a note doesn't hit the disk on every
//! pixel. Writes are atomic (temporary file + rename).

use serde::{Deserialize, Serialize};
use std::{
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
    notes: Vec<Note>,
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
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: 560.0,
            height: 640.0,
            pinned: false,
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

/// Ensures unique ids and continuous numbering even with hand-edited files.
fn normalize(data: &mut FileData) {
    data.notes.retain(|n| !n.id.is_empty());
    let max_seq = data.notes.iter().map(|n| n.seq).max().unwrap_or(0);
    data.next_seq = data.next_seq.max(max_seq + 1).max(1);
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
            serde_json::to_string_pretty(&copy)
        };
        write_atomic(path, &json.map_err(io::Error::other)?)
    }

    /// Merges the notes of another notes file (an export or a `notes.json`):
    /// unknown ids are added and known ones replaced only if the imported copy
    /// is newer. Settings in the file are ignored. Returns the ids added or
    /// replaced.
    pub fn import_from(&self, path: &Path) -> io::Result<Vec<String>> {
        let imported = read(path)?;
        let mut changed = Vec::new();
        {
            let mut data = self.data.lock().unwrap();
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

    /// Notes not in the trash.
    pub fn active(&self) -> Vec<Note> {
        let data = self.data.lock().unwrap();
        data.notes
            .iter()
            .filter(|n| n.trashed_at.is_none())
            .cloned()
            .collect()
    }

    /// Permanently deletes notes that have been in the trash for over 30 days.
    /// Returns `true` if any was removed.
    pub fn purge_trash(&self, now: u64) -> bool {
        let removed = {
            let mut data = self.data.lock().unwrap();
            let before = data.notes.len();
            data.notes.retain(|n| {
                n.trashed_at
                    .map_or(true, |t| now.saturating_sub(t) < TRASH_TTL_MS)
            });
            data.notes.len() != before
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
