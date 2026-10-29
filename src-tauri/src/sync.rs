//! Cloud sync with the user's Google Drive (the app's hidden folder) or
//! OneDrive (the app's folder, `Apps/Memo`): one logic, two `Remote`s.
//!
//! Local first: `notes.json` stays the source of truth and the app works the
//! same offline. A background task pulls what changed in the Drive (changes
//! API, from a saved page token), applies it, then pushes what changed here.
//! Each note and group is one file (`note-<id>.json`, `group-<id>.json`,
//! formats in store.rs) plus `settings.json` for the new-note / new-group
//! defaults; a file's `appProperties.stamp` is its `updatedAt` (or
//! `deletedAt` for a tombstone), so a pull compares versions without
//! downloading. `SyncState.files` remembers, per file, the last stamp sent
//! or received: anything newer here is pushed, anything newer there is
//! applied.
//!
//! Pasted images (files beside `notes.json`, see images.rs) go as files of
//! their own, `image-<name>`, sent before the first note that uses them and
//! fetched when a note from the cloud refers to one missing here. They never
//! change (the name is a hash of the bytes), so they carry no stamp to
//! compare and are sent once.
//!
//! Conflicts (changed here and there since the last sync): the newer version
//! wins and the other one is kept as a copy in the trash, so no text is lost.
//! An edit beats a deletion. A cloud change to a note whose window is focused
//! waits (`SyncState.deferred`) until the window loses focus.
//!
//! OneDrive has no custom metadata on personal accounts, so there a file's
//! stamp is part of its name (`note-<id>.json~<stamp>`, see `OneDrive`);
//! the logic above sees the same names and stamps as with Google Drive.
//!
//! When it runs: on start and on connecting, a few seconds after local
//! changes, when a window gets focus (at most every 30 s), every 5 minutes,
//! and on "Sync now". Errors are `cloud::ERR_*` codes shown by the manager.

use crate::{
    cloud::{self, Provider},
    images, notify, Kind,
    store::{Applied, GroupDoc, Note, NoteDoc, SettingsDoc, SyncState, SyncedFile},
    welcome, Shared,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

const API: &str = "https://www.googleapis.com";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const SETTINGS_FILE: &str = "settings.json";
/// Start of an image's file name in the Drive (`image-<name>`).
const IMAGE_PREFIX: &str = "image-";

/// How often the task wakes up to see whether a sync is due.
const TICK: Duration = Duration::from_secs(5);
/// Local changes are sent once they are this old (typing settles first).
const SETTLE_MS: u64 = 3_000;
/// A pull happens at least this often while the app runs.
const PULL_EVERY_MS: u64 = 5 * 60_000;
/// Wait after a failed sync before trying again on its own.
const RETRY_MS: u64 = 60_000;
/// A window getting focus pulls if the last sync is older than this.
const FOCUS_PULL_MS: u64 = 30_000;

/// What the manager shows (`get_cloud_account`, `cloud-changed`).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub syncing: bool,
    pub last_sync: u64,
    /// Changes here not sent yet.
    pub pending: usize,
    /// `cloud::ERR_*` code of the last failed sync.
    pub error: Option<String>,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
static WAKE: Notify = Notify::const_new();
static NOW: AtomicBool = AtomicBool::new(false);
/// Each connected cloud's status.
static STATUS: Mutex<Vec<(Provider, Status)>> = Mutex::new(Vec::new());

pub fn status(cloud: Provider) -> Status {
    STATUS.lock().unwrap().iter().find(|(p, _)| *p == cloud).map(|(_, s)| s.clone()).unwrap_or_default()
}

fn set_status(app: &AppHandle, cloud: Provider, f: impl FnOnce(&mut Status)) {
    {
        let mut all = STATUS.lock().unwrap();
        if !all.iter().any(|(p, _)| *p == cloud) {
            all.push((cloud, Status::default()));
        }
        if let Some((_, status)) = all.iter_mut().find(|(p, _)| *p == cloud) {
            f(status);
        }
    }
    let _ = app.emit("cloud-changed", ());
}

fn clear_status(cloud: Provider) {
    STATUS.lock().unwrap().retain(|(p, _)| *p != cloud);
}

/// The connected accounts: one per cloud, Google Drive and/or OneDrive.
fn accounts(app: &AppHandle) -> Vec<(Provider, String)> {
    crate::cloud_logins(app)
}

/// Starts the background task if an account is connected (no-op if it
/// already runs). Each connected cloud syncs on its own schedule; what one
/// brings in is sent to the other on its next run (this computer is the
/// bridge), so with both connected they hold the same memories.
pub fn start(app: &AppHandle) {
    if accounts(app).is_empty() || RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_run: HashMap<&'static str, u64> = HashMap::new();
        NOW.store(true, Ordering::SeqCst);
        loop {
            let logins = accounts(&app);
            if logins.is_empty() {
                break;
            }
            let now_asked = NOW.swap(false, Ordering::SeqCst);
            for (cloud, email) in logins {
                // A lost sign-in waits until the user connects again.
                if status(cloud).error.as_deref() == Some(cloud::ERR_REAUTH) {
                    continue;
                }
                let now = crate::now_ms();
                let last = last_run.get(cloud.id()).copied().unwrap_or(0);
                let store = app.state::<Shared>();
                let (pending, newest) = pending_summary(&store, cloud);
                // After a failure (offline…), automatic runs wait a minute.
                let backoff = status(cloud).error.is_some() && now.saturating_sub(last) < RETRY_MS;
                let due = now_asked
                    || (!backoff && pending > 0 && now.saturating_sub(newest) >= SETTLE_MS)
                    || now.saturating_sub(last) >= PULL_EVERY_MS;
                if due {
                    last_run.insert(cloud.id(), now);
                    set_status(&app, cloud, |s| s.syncing = true);
                    let result = run(&app, cloud, &email).await;
                    let (pending, _) = pending_summary(&store, cloud);
                    set_status(&app, cloud, |s| {
                        s.syncing = false;
                        s.pending = pending;
                        match &result {
                            Ok(()) => {
                                s.last_sync = crate::now_ms();
                                s.error = None;
                            }
                            Err(err) => s.error = Some(err.clone()),
                        }
                    });
                } else if pending != status(cloud).pending {
                    set_status(&app, cloud, |s| s.pending = pending);
                }
            }
            let _ = tokio::time::timeout(TICK, WAKE.notified()).await;
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

/// "Sync now", or a reconnect: sync at once.
pub fn sync_now(app: &AppHandle) {
    NOW.store(true, Ordering::SeqCst);
    WAKE.notify_one();
    start(app);
}

/// Just signed in (again) to `cloud`: forget an expired sign-in's error and
/// sync.
pub fn on_connected(app: &AppHandle, cloud: Provider) {
    clear_status(cloud);
    sync_now(app);
}

/// A window got focus: pull if the last sync is a while ago (also retries
/// cloud changes that waited for a focused note).
pub fn on_focus() {
    if !RUNNING.load(Ordering::SeqCst) {
        return;
    }
    let oldest = Provider::ALL.into_iter().map(|p| status(p).last_sync).min().unwrap_or(0);
    if crate::now_ms().saturating_sub(oldest) >= FOCUS_PULL_MS {
        NOW.store(true, Ordering::SeqCst);
        WAKE.notify_one();
    }
}

/// Forgets this computer's sync bookkeeping with `cloud` (on disconnect).
pub fn reset(app: &AppHandle, cloud: Provider) {
    app.state::<Shared>().update_sync(cloud, |s| *s = SyncState::default());
    clear_status(cloud);
    let _ = app.emit("cloud-changed", ());
    WAKE.notify_one();
}

// ------------------------------------------------------------ the run

fn note_file(id: &str) -> String {
    format!("note-{id}.json")
}

fn group_file(id: &str) -> String {
    format!("group-{id}.json")
}

pub(crate) fn note_doc(note: &Note) -> NoteDoc {
    NoteDoc {
        version: 1,
        id: note.id.clone(),
        title: note.title.clone(),
        text: note.text.clone(),
        html: note.html.clone(),
        color: note.color.clone(),
        group_id: note.group_id.clone(),
        created_at: note.created_at,
        updated_at: note.updated_at,
        trashed_at: note.trashed_at,
        remind_at: note.remind_at,
        ..Default::default()
    }
}

/// One file to send: its name, stamp and JSON body, and the images it
/// refers to (sent first).
struct Upload {
    name: String,
    stamp: u64,
    body: String,
    images: Vec<String>,
}

/// What changed here since the last sync, ready to send. Skips notes never
/// sent that are still empty / the defaults or an untouched welcome note
/// (each computer has its own), and deletions of things never sent.
fn uploads(store: &Shared, state: &SyncState) -> Vec<Upload> {
    let snap = store.sync_snapshot();
    let synced = |name: &str| state.files.get(name).map(|f| f.synced);
    let deferred: Vec<String> = state.deferred.iter().map(|d| note_file(&d.id)).collect();
    let mut out = Vec::new();
    for group in &snap.groups {
        let name = group_file(&group.id);
        match synced(&name) {
            Some(s) if group.updated_at <= s => continue,
            // Untouched and never sent: closing it deletes it, so it waits
            // until it is changed or a note joins it.
            None if store.is_pristine_group(&group.id) => continue,
            _ => {}
        }
        let doc = GroupDoc {
            version: 1,
            id: group.id.clone(),
            name: group.name.clone(),
            color: group.color.clone(),
            created_at: group.created_at,
            updated_at: group.updated_at,
            trashed_at: group.trashed_at,
            ..Default::default()
        };
        out.push(Upload { stamp: group.updated_at, body: json(&doc), name, images: Vec::new() });
    }
    for note in &snap.notes {
        let name = note_file(&note.id);
        if deferred.contains(&name) {
            continue;
        }
        match synced(&name) {
            Some(s) if note.updated_at <= s => continue,
            None if note.welcome_copy
                || store.is_pristine(note)
                || welcome::is_untouched(&note.title, &note.html) =>
            {
                continue
            }
            _ => {}
        }
        let images = images::refs(&note.html).into_iter().collect();
        out.push(Upload { stamp: note.updated_at, body: json(&note_doc(note)), name, images });
    }
    for tomb in &snap.deleted {
        let is_group = state.files.contains_key(&group_file(&tomb.id));
        let name = if is_group { group_file(&tomb.id) } else { note_file(&tomb.id) };
        // Never sent: nothing to delete in the cloud.
        let Some(s) = synced(&name) else { continue };
        if tomb.deleted_at <= s {
            continue;
        }
        let body = if is_group {
            json(&GroupDoc { version: 1, id: tomb.id.clone(), deleted: true, deleted_at: tomb.deleted_at, ..Default::default() })
        } else {
            json(&NoteDoc { version: 1, id: tomb.id.clone(), deleted: true, deleted_at: tomb.deleted_at, ..Default::default() })
        };
        out.push(Upload { name, stamp: tomb.deleted_at, body, images: Vec::new() });
    }
    let settings = snap.settings;
    if settings.updated_at > 0 && synced(SETTINGS_FILE).map_or(true, |s| settings.updated_at > s) {
        out.push(Upload { name: SETTINGS_FILE.into(), stamp: settings.updated_at, body: json(&settings), images: Vec::new() });
    }
    out
}

/// Number of local changes waiting for `cloud`, and the time of the newest
/// one.
fn pending_summary(store: &Shared, cloud: Provider) -> (usize, u64) {
    let state = store.sync_state(cloud);
    let up = uploads(store, &state);
    (up.len(), up.iter().map(|u| u.stamp).max().unwrap_or(0))
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// What a sync does to the windows: an interface so the logic can run
/// without any (tests).
trait Ui {
    /// The note's window has the focus (the user may be typing in it).
    fn focused(&self, note_id: &str) -> bool;
    /// Shows the new content in the note's window, if open.
    fn reload_note(&self, note_id: &str);
    /// Closes the note's window, if open (trashed, deleted or hidden).
    fn close_note(&self, note_id: &str);
    /// Closes a group's bar, if open.
    fn close_group(&self, group_id: &str);
    /// Tells the pages what changed.
    fn changed(&self, groups: bool, notes: bool);
}

impl Ui for AppHandle {
    fn focused(&self, note_id: &str) -> bool {
        self.get_webview_window(&Kind::Note.label(note_id))
            .is_some_and(|w| w.is_focused().unwrap_or(false))
    }

    fn reload_note(&self, note_id: &str) {
        if let Some(w) = self.get_webview_window(&Kind::Note.label(note_id)) {
            let _ = w.reload();
        }
    }

    fn close_note(&self, note_id: &str) {
        if let Some(w) = self.get_webview_window(&Kind::Note.label(note_id)) {
            let _ = w.destroy();
        }
    }

    fn close_group(&self, group_id: &str) {
        if let Some(w) = self.get_webview_window(&Kind::Group.label(group_id)) {
            let _ = w.destroy();
        }
    }

    fn changed(&self, groups: bool, notes: bool) {
        if groups {
            let _ = self.emit("groups-changed", ());
        }
        if notes || groups {
            notify(self);
        }
    }
}

async fn run(app: &AppHandle, cloud: Provider, email: &str) -> Result<(), String> {
    let store = app.state::<Shared>().inner().clone();
    match cloud {
        Provider::Google => run_with(&store, app, &Drive::new().await?, cloud, email).await,
        Provider::Microsoft => run_with(&store, app, &OneDrive::new().await?, cloud, email).await,
    }
}

async fn run_with<R: Remote>(
    store: &Shared,
    ui: &(dyn Ui + Sync),
    drive: &R,
    cloud: Provider,
    account: &str,
) -> Result<(), String> {
    let mut state = store.sync_state(cloud);
    if state.account != account {
        state = SyncState { account: account.to_string(), ..Default::default() };
    }

    // Pull.
    let (remote, next_token) = match &state.page_token {
        Some(token) => drive.changes(token).await?,
        None => {
            // Token first, so nothing changed during the listing is missed.
            let token = drive.start_token().await?;
            (drive.list_all().await?, token)
        }
    };
    let mut ctx = Ctx { ui, store, state: &mut state, groups_changed: false, notes_changed: false };
    let deferred = std::mem::take(&mut ctx.state.deferred);
    for doc in deferred {
        ctx.receive_note(doc, None);
    }
    // Images first (their ids are needed to fetch them), then groups before
    // notes, so a new note's group already exists.
    let mut remote = remote;
    remote.sort_by_key(|f| (!f.name.starts_with(IMAGE_PREFIX), !f.name.starts_with("group-"), f.name.clone()));
    for file in remote {
        if file.name.starts_with(IMAGE_PREFIX) {
            ctx.state.files.insert(file.name, SyncedFile { file_id: file.id, synced: file.stamp });
            continue;
        }
        let known = ctx.state.files.get(&file.name).map(|f| f.synced);
        if known.is_some_and(|s| file.stamp <= s) {
            // Our own upload coming back, or nothing new.
            ctx.state.files.entry(file.name.clone()).or_default().file_id = file.id.clone();
            continue;
        }
        let body = drive.download(&file.id).await?;
        if file.name == SETTINGS_FILE {
            if let Ok(doc) = serde_json::from_str::<SettingsDoc>(&body) {
                let local = store.sync_snapshot().settings.updated_at;
                let synced = known.unwrap_or(0);
                if local <= synced || doc.updated_at >= local {
                    store.apply_settings_doc(&doc);
                }
            }
            ctx.state.files.insert(file.name, SyncedFile { file_id: file.id, synced: file.stamp });
        } else if file.name.starts_with("group-") {
            if let Ok(doc) = serde_json::from_str::<GroupDoc>(&body) {
                ctx.receive_group(&doc, known.unwrap_or(0));
            }
            ctx.state.files.insert(file.name, SyncedFile { file_id: file.id, synced: file.stamp });
        } else if file.name.starts_with("note-") {
            if let Ok(mut doc) = serde_json::from_str::<NoteDoc>(&body) {
                // Inline images from older versions become files too.
                doc.html = store.store_images(&doc.html);
                fetch_images(drive, store, &ctx.state.files, &doc.html).await;
                ctx.receive_note(doc, Some(file.id));
            }
        }
    }
    // Images that failed to arrive before.
    for html in store.all_html() {
        fetch_images(drive, store, &ctx.state.files, &html).await;
    }
    let (groups_changed, notes_changed) = (ctx.groups_changed, ctx.notes_changed);
    state.page_token = Some(next_token);
    store.update_sync(cloud, |s| *s = state.clone());
    ui.changed(groups_changed, notes_changed);

    // Push.
    for up in uploads(store, &state) {
        for image in &up.images {
            let name = format!("{IMAGE_PREFIX}{image}");
            if state.files.contains_key(&name) {
                continue;
            }
            let Ok(bytes) = std::fs::read(store.images_dir().join(image)) else { continue };
            let id = drive.upload_bytes(None, &name, 1, images::mime(image), &bytes).await?;
            state.files.insert(name, SyncedFile { file_id: id, synced: 1 });
        }
        let file_id = state.files.get(&up.name).map(|f| f.file_id.clone()).filter(|id| !id.is_empty());
        let id = drive.upload(file_id.as_deref(), &up.name, up.stamp, &up.body).await?;
        state.files.insert(up.name, SyncedFile { file_id: id, synced: up.stamp });
        store.update_sync(cloud, |s| s.files = state.files.clone());
    }
    store.update_sync(cloud, |s| s.last_sync = crate::now_ms());
    Ok(())
}

/// Downloads the images `html` refers to that are missing here and known in
/// the Drive. A failure is skipped (the note keeps the reference; the next
/// sync tries again).
async fn fetch_images<R: Remote>(drive: &R, store: &Shared, files: &HashMap<String, SyncedFile>, html: &str) {
    let dir = store.images_dir();
    for image in images::refs(html) {
        if dir.join(&image).exists() {
            continue;
        }
        let Some(file) = files.get(&format!("{IMAGE_PREFIX}{image}")) else { continue };
        match drive.download_bytes(&file.file_id).await {
            Ok(bytes) => {
                if let Err(err) = images::write(&dir, &image, &bytes) {
                    eprintln!("memo: failed to save image {image}: {err}");
                }
            }
            Err(err) => eprintln!("memo: failed to fetch image {image}: {err}"),
        }
    }
}

/// Applying one pull.
struct Ctx<'a> {
    ui: &'a (dyn Ui + Sync),
    store: &'a Shared,
    state: &'a mut SyncState,
    groups_changed: bool,
    notes_changed: bool,
}

impl Ctx<'_> {
    fn conflict_suffix(&self) -> &'static str {
        match self.store.effective_language() {
            "pt" => "conflito",
            _ => "conflict",
        }
    }

    /// A note from the cloud (`file_id` is `None` for a deferred one, whose
    /// file is already known).
    fn receive_note(&mut self, doc: NoteDoc, file_id: Option<String>) {
        let name = note_file(&doc.id);
        let entry = self.state.files.get(&name).cloned().unwrap_or_default();
        let file_id = file_id.unwrap_or(entry.file_id);
        let synced = entry.synced;
        let snap = self.store.sync_snapshot();
        let local = snap.notes.iter().find(|n| n.id == doc.id).cloned();
        let local_tomb = snap.deleted.iter().find(|t| t.id == doc.id).map(|t| t.deleted_at);
        let local_stamp = local.as_ref().map(|n| n.updated_at).or(local_tomb).unwrap_or(0);
        let focused = self.ui.focused(&doc.id);

        let mut record = doc.stamp();
        let changed_here = local_stamp > synced;
        let apply = match (&local, changed_here) {
            // Nothing changed here: take the cloud's version.
            (_, false) => true,
            // Edited here, deleted there: the edit wins (sent again below).
            (Some(_), true) if doc.deleted => {
                record = record.min(local_stamp.saturating_sub(1));
                false
            }
            // Deleted here, edited there: the edit wins.
            (None, true) => true,
            (Some(note), true) => {
                if note_doc(note).text == doc.text && note.title == doc.title && note.html == doc.html {
                    // Same text: keep the newer one, no copy needed.
                    doc.updated_at >= note.updated_at
                } else if doc.updated_at >= note.updated_at {
                    if !focused {
                        self.store.add_conflict_copy(&note_doc(note), self.conflict_suffix());
                    }
                    true
                } else {
                    self.store.add_conflict_copy(&doc, self.conflict_suffix());
                    self.notes_changed = true;
                    false
                }
            }
        };
        if apply && focused && !doc.deleted && local.is_some() {
            // Don't change a note under the user's cursor: try again later.
            self.state.deferred.retain(|d| d.id != doc.id);
            self.state.deferred.push(doc);
            if !file_id.is_empty() {
                self.state.files.entry(name).or_default().file_id = file_id;
            }
            return;
        }
        if apply {
            let result = self.store.apply_note_doc(&doc);
            if result != Applied::Unchanged {
                self.notes_changed = true;
            }
            match result {
                Applied::Updated if self.store.get(&doc.id).is_some_and(|n| n.trashed_at.is_none() && !n.hidden) => {
                    self.ui.reload_note(&doc.id);
                }
                Applied::Updated | Applied::Trashed | Applied::Removed => self.ui.close_note(&doc.id),
                _ => {}
            }
        }
        self.state.files.insert(name, SyncedFile { file_id, synced: record });
    }

    fn receive_group(&mut self, doc: &GroupDoc, synced: u64) {
        let snap = self.store.sync_snapshot();
        let local = snap.groups.iter().find(|g| g.id == doc.id).map(|g| g.updated_at);
        let local_tomb = snap.deleted.iter().find(|t| t.id == doc.id).map(|t| t.deleted_at);
        let local_stamp = local.or(local_tomb).unwrap_or(0);
        if local_stamp > synced && local_stamp > doc.stamp() {
            return; // changed here more recently: ours is sent
        }
        if self.store.apply_group_doc(doc) {
            self.groups_changed = true;
            let gone = doc.deleted || doc.trashed_at.is_some();
            if gone {
                self.ui.close_group(&doc.id);
            }
        }
    }
}

// ---------------------------------------------------------- the clouds

/// A cloud folder holding the app's files, as the sync sees it: files by
/// name, each with a stamp, and the changes since a token.
trait Remote {
    /// A token for `changes` that starts now.
    async fn start_token(&self) -> Result<String, String>;
    /// Every file (one per name).
    async fn list_all(&self) -> Result<Vec<RemoteFile>, String>;
    /// Files changed since `token`, and the token for next time.
    async fn changes(&self, token: &str) -> Result<(Vec<RemoteFile>, String), String>;
    async fn download(&self, id: &str) -> Result<String, String>;
    async fn download_bytes(&self, id: &str) -> Result<Vec<u8>, String>;
    /// Creates the file (no `file_id`) or replaces it; returns its id. A
    /// file removed in the cloud meanwhile is created again.
    async fn upload_bytes(
        &self,
        file_id: Option<&str>,
        name: &str,
        stamp: u64,
        content_type: &str,
        body: &[u8],
    ) -> Result<String, String>;

    async fn upload(&self, file_id: Option<&str>, name: &str, stamp: u64, body: &str) -> Result<String, String> {
        self.upload_bytes(file_id, name, stamp, "application/json", body.as_bytes()).await
    }
}

/// Maps an HTTP failure to an error code; a 401 also drops the cached token
/// so the next run gets a fresh one.
fn http_error(status: reqwest::StatusCode) -> String {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        cloud::forget_access_token();
    }
    eprintln!("memo: cloud request failed: {status}");
    cloud::ERR_NETWORK.into()
}

/// Keeps one file per name (the newest), in case two computers created the
/// same file at once; also returns the older ones.
fn dedupe_split(files: Vec<RemoteFile>) -> (Vec<RemoteFile>, Vec<RemoteFile>) {
    let mut by_name: HashMap<String, RemoteFile> = HashMap::new();
    let mut older = Vec::new();
    for file in files {
        match by_name.get(&file.name) {
            Some(kept) if kept.stamp >= file.stamp => older.push(file),
            _ => {
                if let Some(kept) = by_name.insert(file.name.clone(), file) {
                    older.push(kept);
                }
            }
        }
    }
    (by_name.into_values().collect(), older)
}

fn dedupe(files: Vec<RemoteFile>) -> Vec<RemoteFile> {
    dedupe_split(files).0
}

// ----------------------------------------------------------- Drive API

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileMeta {
    id: String,
    name: String,
    app_properties: HashMap<String, String>,
    trashed: bool,
}

/// A file in the app folder: id, name and stamp.
struct RemoteFile {
    id: String,
    name: String,
    stamp: u64,
}

impl RemoteFile {
    fn from_meta(meta: FileMeta) -> Option<Self> {
        if meta.trashed || !(meta.name.ends_with(".json") || meta.name.starts_with(IMAGE_PREFIX)) {
            return None;
        }
        let stamp = meta.app_properties.get("stamp")?.parse().ok()?;
        Some(Self { id: meta.id, name: meta.name, stamp })
    }
}

struct Drive {
    http: reqwest::Client,
    token: String,
    /// `API`, or a fake Drive in tests.
    base: String,
}

impl Drive {
    async fn new() -> Result<Self, String> {
        Ok(Self { http: cloud::http()?, token: cloud::access_token(cloud::Provider::Google).await?, base: API.into() })
    }

    async fn get(&self, url: &str, query: &[(&str, &str)]) -> Result<reqwest::Response, String> {
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .query(query)
            .send()
            .await
            .map_err(|_| cloud::ERR_NETWORK.to_string())?;
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        Ok(response)
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, url: &str, query: &[(&str, &str)]) -> Result<T, String> {
        self.get(url, query)
            .await?
            .json()
            .await
            .map_err(|_| cloud::ERR_NETWORK.to_string())
    }

    /// One multipart upload (metadata + content).
    async fn send_upload(
        &self,
        file_id: Option<&str>,
        name: &str,
        stamp: u64,
        content_type: &str,
        body: &[u8],
    ) -> Result<String, reqwest::StatusCode> {
        #[derive(Deserialize)]
        struct Created {
            id: String,
        }
        let mut meta = serde_json::json!({ "appProperties": { "stamp": stamp.to_string() } });
        if file_id.is_none() {
            meta["name"] = name.into();
            meta["parents"] = serde_json::json!(["appDataFolder"]);
        }
        // Random, so no note text can contain it.
        let boundary = format!("memo-{}", cloud::random_b64(18));
        let mut payload = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n\
             --{boundary}\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .into_bytes();
        payload.extend_from_slice(body);
        payload.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
        let request = match file_id {
            Some(id) => self.http.patch(format!("{}/upload/drive/v3/files/{id}", self.base)),
            None => self.http.post(format!("{}/upload/drive/v3/files", self.base)),
        };
        let response = request
            .bearer_auth(&self.token)
            .query(&[("uploadType", "multipart"), ("fields", "id")])
            .header("Content-Type", format!("multipart/related; boundary={boundary}"))
            .body(payload)
            .send()
            .await
            .map_err(|_| reqwest::StatusCode::SERVICE_UNAVAILABLE)?;
        if !response.status().is_success() {
            return Err(response.status());
        }
        let created: Created = response.json().await.map_err(|_| reqwest::StatusCode::BAD_GATEWAY)?;
        Ok(created.id)
    }
}

impl Remote for Drive {
    async fn start_token(&self) -> Result<String, String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Start {
            start_page_token: String,
        }
        let start: Start = self.get_json(&format!("{}/drive/v3/changes/startPageToken", self.base), &[]).await?;
        Ok(start.start_page_token)
    }

    async fn list_all(&self) -> Result<Vec<RemoteFile>, String> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct List {
            files: Vec<FileMeta>,
            next_page_token: Option<String>,
        }
        let mut files = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut query = vec![
                ("spaces", "appDataFolder"),
                ("pageSize", "1000"),
                ("fields", "nextPageToken,files(id,name,appProperties,trashed)"),
            ];
            if let Some(p) = &page {
                query.push(("pageToken", p));
            }
            let list: List = self.get_json(&format!("{}/drive/v3/files", self.base), &query).await?;
            files.extend(list.files.into_iter().filter_map(RemoteFile::from_meta));
            match list.next_page_token {
                Some(next) => page = Some(next),
                None => break,
            }
        }
        Ok(dedupe(files))
    }

    /// Files changed since `token`, and the token for next time.
    async fn changes(&self, token: &str) -> Result<(Vec<RemoteFile>, String), String> {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Change {
            file: Option<FileMeta>,
        }
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Changes {
            changes: Vec<Change>,
            next_page_token: Option<String>,
            new_start_page_token: Option<String>,
        }
        let mut files = Vec::new();
        let mut page = token.to_string();
        loop {
            let list: Changes = self
                .get_json(
                    &format!("{}/drive/v3/changes", self.base),
                    &[
                        ("pageToken", &page),
                        ("spaces", "appDataFolder"),
                        ("pageSize", "1000"),
                        ("fields", "nextPageToken,newStartPageToken,changes(file(id,name,appProperties,trashed))"),
                    ],
                )
                .await?;
            files.extend(list.changes.into_iter().filter_map(|c| c.file).filter_map(RemoteFile::from_meta));
            if let Some(next) = list.new_start_page_token {
                return Ok((dedupe(files), next));
            }
            match list.next_page_token {
                Some(next) => page = next,
                None => return Err(cloud::ERR_NETWORK.into()),
            }
        }
    }

    async fn download(&self, id: &str) -> Result<String, String> {
        self.get(&format!("{}/drive/v3/files/{id}", self.base), &[("alt", "media")])
            .await?
            .text()
            .await
            .map_err(|_| cloud::ERR_NETWORK.to_string())
    }

    async fn download_bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let response = self.get(&format!("{}/drive/v3/files/{id}", self.base), &[("alt", "media")]).await?;
        let bytes = response.bytes().await.map_err(|_| cloud::ERR_NETWORK.to_string())?;
        Ok(bytes.to_vec())
    }

    async fn upload_bytes(
        &self,
        file_id: Option<&str>,
        name: &str,
        stamp: u64,
        content_type: &str,
        body: &[u8],
    ) -> Result<String, String> {
        if let Some(id) = file_id {
            match self.send_upload(Some(id), name, stamp, content_type, body).await {
                Err(status) if status == reqwest::StatusCode::NOT_FOUND => {}
                Err(status) => return Err(http_error(status)),
                Ok(id) => return Ok(id),
            }
        }
        self.send_upload(None, name, stamp, content_type, body).await.map_err(http_error)
    }

}

// -------------------------------------------------------- OneDrive API

/// The app's folder in OneDrive (Microsoft Graph, `special/approot`). A
/// file's stamp is in its name, `<name>~<stamp>`: an upload with a new stamp
/// writes a new file and deletes the one it replaces (so `changes` never
/// needs a download to compare versions, as Drive's `appProperties` give).
struct OneDrive {
    http: reqwest::Client,
    token: String,
    /// `GRAPH`, or a fake OneDrive in tests.
    base: String,
}

/// Over this, a file goes through an upload session (a simple upload takes
/// up to 4 MB).
const SIMPLE_UPLOAD_MAX: usize = 4 * 1024 * 1024;

#[derive(Deserialize, Default)]
#[serde(default)]
struct DriveItem {
    id: String,
    name: String,
    file: Option<serde_json::Value>,
    deleted: Option<serde_json::Value>,
}

impl DriveItem {
    fn remote(self) -> Option<RemoteFile> {
        if self.deleted.is_some() || self.file.is_none() {
            return None;
        }
        let (name, stamp) = self.name.rsplit_once('~')?;
        if !(name.ends_with(".json") || name.starts_with(IMAGE_PREFIX)) {
            return None;
        }
        Some(RemoteFile { id: self.id, name: name.to_string(), stamp: stamp.parse().ok()? })
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ItemPage {
    value: Vec<DriveItem>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
    #[serde(rename = "@odata.deltaLink")]
    delta_link: Option<String>,
}

impl OneDrive {
    async fn new() -> Result<Self, String> {
        Ok(Self { http: cloud::http()?, token: cloud::access_token(cloud::Provider::Microsoft).await?, base: GRAPH.into() })
    }

    async fn get(&self, url: &str) -> Result<reqwest::Response, String> {
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| cloud::ERR_NETWORK.to_string())?;
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        Ok(response)
    }

    async fn page(&self, url: &str) -> Result<ItemPage, String> {
        self.get(url).await?.json().await.map_err(|_| cloud::ERR_NETWORK.to_string())
    }

    /// Follows `url` page by page; returns the files and the delta link.
    async fn pages(&self, url: &str) -> Result<(Vec<RemoteFile>, Option<String>), String> {
        let mut files = Vec::new();
        let mut url = url.to_string();
        loop {
            let page = self.page(&url).await?;
            files.extend(page.value.into_iter().filter_map(DriveItem::remote));
            match (page.next_link, page.delta_link) {
                (Some(next), _) => url = next,
                (None, delta) => return Ok((files, delta)),
            }
        }
    }

    /// Removes a file; one already gone is fine.
    async fn delete(&self, id: &str) {
        let result = self
            .http
            .delete(format!("{}/me/drive/items/{id}", self.base))
            .bearer_auth(&self.token)
            .send()
            .await;
        if let Ok(response) = result {
            let status = response.status();
            if !status.is_success() && status != reqwest::StatusCode::NOT_FOUND {
                eprintln!("memo: OneDrive delete failed: {status}");
            }
        }
    }

    fn path(&self, remote_name: &str) -> String {
        format!("{}/me/drive/special/approot:/{remote_name}:", self.base)
    }

    async fn send_upload(&self, remote_name: &str, content_type: &str, body: &[u8]) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Created {
            id: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Session {
            upload_url: String,
        }
        let response = if body.len() <= SIMPLE_UPLOAD_MAX {
            self.http
                .put(format!("{}/content", self.path(remote_name)))
                .bearer_auth(&self.token)
                .header("Content-Type", content_type)
                .body(body.to_vec())
                .send()
                .await
        } else {
            let session = self
                .http
                .post(format!("{}/createUploadSession", self.path(remote_name)))
                .bearer_auth(&self.token)
                .json(&serde_json::json!({ "item": { "@microsoft.graph.conflictBehavior": "replace" } }))
                .send()
                .await
                .map_err(|_| cloud::ERR_NETWORK.to_string())?;
            if !session.status().is_success() {
                return Err(http_error(session.status()));
            }
            let session: Session = session.json().await.map_err(|_| cloud::ERR_NETWORK.to_string())?;
            // The upload URL carries its own authorization.
            self.http
                .put(session.upload_url)
                .header("Content-Range", format!("bytes 0-{}/{}", body.len() - 1, body.len()))
                .body(body.to_vec())
                .send()
                .await
        }
        .map_err(|_| cloud::ERR_NETWORK.to_string())?;
        if !response.status().is_success() {
            return Err(http_error(response.status()));
        }
        let created: Created = response.json().await.map_err(|_| cloud::ERR_NETWORK.to_string())?;
        Ok(created.id)
    }
}

impl Remote for OneDrive {
    async fn start_token(&self) -> Result<String, String> {
        let (_, delta) = self.pages(&format!("{}/me/drive/special/approot/delta?token=latest", self.base)).await?;
        delta.ok_or_else(|| cloud::ERR_NETWORK.into())
    }

    async fn list_all(&self) -> Result<Vec<RemoteFile>, String> {
        let url = format!("{}/me/drive/special/approot/children?$top=999&$select=id,name,file", self.base);
        let (files, _) = self.pages(&url).await?;
        // Older copies left by a run that stopped between writing a file
        // and deleting the one it replaced.
        let (files, older) = dedupe_split(files);
        for file in older {
            self.delete(&file.id).await;
        }
        Ok(files)
    }

    async fn changes(&self, token: &str) -> Result<(Vec<RemoteFile>, String), String> {
        let (files, delta) = self.pages(token).await?;
        Ok((dedupe(files), delta.ok_or(cloud::ERR_NETWORK)?))
    }

    async fn download(&self, id: &str) -> Result<String, String> {
        self.get(&format!("{}/me/drive/items/{id}/content", self.base))
            .await?
            .text()
            .await
            .map_err(|_| cloud::ERR_NETWORK.to_string())
    }

    async fn download_bytes(&self, id: &str) -> Result<Vec<u8>, String> {
        let response = self.get(&format!("{}/me/drive/items/{id}/content", self.base)).await?;
        let bytes = response.bytes().await.map_err(|_| cloud::ERR_NETWORK.to_string())?;
        Ok(bytes.to_vec())
    }

    async fn upload_bytes(
        &self,
        file_id: Option<&str>,
        name: &str,
        stamp: u64,
        content_type: &str,
        body: &[u8],
    ) -> Result<String, String> {
        let id = self.send_upload(&format!("{name}~{stamp}"), content_type, body).await?;
        if let Some(old) = file_id.filter(|old| *old != id) {
            self.delete(old).await;
        }
        Ok(id)
    }
}

// ----------------------------------------------------------------- tests
// Two computers syncing through a fake Drive and a fake OneDrive (tiny HTTP
// servers with the endpoints used above), no network or account needed.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::{
        collections::HashSet,
        io::{Read, Write},
        net::TcpListener,
        sync::Arc,
    };

    #[derive(Default)]
    struct FakeDrive {
        /// id → (name, stamp, body)
        files: HashMap<String, (String, String, String)>,
        /// ids in change order; a page token is an index in it.
        log: Vec<String>,
    }

    fn meta(id: &str, file: &(String, String, String)) -> serde_json::Value {
        serde_json::json!({ "id": id, "name": file.0, "appProperties": { "stamp": file.1 } })
    }

    fn handle(drive: &Mutex<FakeDrive>, method: &str, target: &str, headers: &str, body: &str) -> String {
        let url = reqwest::Url::parse(&format!("http://x{target}")).unwrap();
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let mut d = drive.lock().unwrap();
        let path = url.path().to_string();
        let ok = |v: serde_json::Value| v.to_string();
        if path == "/drive/v3/changes/startPageToken" {
            return ok(serde_json::json!({ "startPageToken": d.log.len().to_string() }));
        }
        if path == "/drive/v3/changes" {
            let from: usize = q["pageToken"].parse().unwrap();
            let changes: Vec<_> = d.log[from..]
                .iter()
                .map(|id| serde_json::json!({ "file": meta(id, &d.files[id]) }))
                .collect();
            return ok(serde_json::json!({ "changes": changes, "newStartPageToken": d.log.len().to_string() }));
        }
        if path == "/drive/v3/files" {
            let files: Vec<_> = d.files.iter().map(|(id, f)| meta(id, f)).collect();
            return ok(serde_json::json!({ "files": files }));
        }
        if let Some(id) = path.strip_prefix("/drive/v3/files/") {
            return d.files[id].2.clone();
        }
        // Multipart upload: metadata part, then the content part.
        let boundary = headers
            .lines()
            .find_map(|l| l.to_lowercase().starts_with("content-type: multipart/related").then(|| l.split("boundary=").nth(1).unwrap().to_string()))
            .unwrap();
        let parts: Vec<&str> = body.split(&format!("--{boundary}")).collect();
        let part = |i: usize| parts[i].split_once("\r\n\r\n").unwrap().1.trim_end_matches("\r\n").to_string();
        let m: serde_json::Value = serde_json::from_str(&part(1)).unwrap();
        let content = part(2);
        let stamp = m["appProperties"]["stamp"].as_str().unwrap().to_string();
        let id = match (method, path.strip_prefix("/upload/drive/v3/files/")) {
            ("PATCH", Some(id)) => {
                let file = d.files.get_mut(id).unwrap();
                file.1 = stamp;
                file.2 = content;
                id.to_string()
            }
            _ => {
                let id = format!("f{}", d.files.len() + 1);
                d.files.insert(id.clone(), (m["name"].as_str().unwrap().to_string(), stamp, content));
                id
            }
        };
        d.log.push(id.clone());
        ok(serde_json::json!({ "id": id }))
    }

    #[derive(Default)]
    struct FakeOneDrive {
        /// The server's address, for the delta links it hands out.
        base: String,
        /// id → (name with its stamp, body)
        files: HashMap<String, (String, String)>,
        /// (id, name) in change order (a deletion too); a delta link holds
        /// an index in it.
        log: Vec<(String, String)>,
        next_id: usize,
    }

    fn handle_onedrive(drive: &Mutex<FakeOneDrive>, method: &str, target: &str, _headers: &str, body: &str) -> String {
        let url = reqwest::Url::parse(&format!("http://x{target}")).unwrap();
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        let mut d = drive.lock().unwrap();
        let path = url.path().to_string();
        let item = |id: &str, name: &str, live: bool| {
            if live {
                serde_json::json!({ "id": id, "name": name, "file": {} })
            } else {
                serde_json::json!({ "id": id, "name": name, "deleted": {} })
            }
        };
        if path == "/me/drive/special/approot/delta" {
            assert_eq!(q.get("token").map(String::as_str), Some("latest"));
            return serde_json::json!({ "value": [], "@odata.deltaLink": format!("{}/delta/{}", d.base, d.log.len()) }).to_string();
        }
        if let Some(from) = path.strip_prefix("/delta/") {
            let from: usize = from.parse().unwrap();
            let value: Vec<_> = d.log[from..]
                .iter()
                .map(|(id, name)| item(id, name, d.files.contains_key(id)))
                .collect();
            return serde_json::json!({ "value": value, "@odata.deltaLink": format!("{}/delta/{}", d.base, d.log.len()) }).to_string();
        }
        if path == "/me/drive/special/approot/children" {
            let value: Vec<_> = d.files.iter().map(|(id, f)| item(id, &f.0, true)).collect();
            return serde_json::json!({ "value": value }).to_string();
        }
        if let Some(id) = path.strip_prefix("/me/drive/items/") {
            if let Some(id) = id.strip_suffix("/content") {
                return d.files[id].1.clone();
            }
            assert_eq!(method, "DELETE");
            if let Some((name, _)) = d.files.remove(id) {
                d.log.push((id.to_string(), name));
            }
            return String::new();
        }
        // PUT approot:/<name>:/content — replaces a file of that name.
        let name = path
            .strip_prefix("/me/drive/special/approot:/")
            .and_then(|p| p.strip_suffix(":/content"))
            .unwrap()
            .to_string();
        assert_eq!(method, "PUT");
        let id = match d.files.iter().find(|(_, f)| f.0 == name).map(|(id, _)| id.clone()) {
            Some(id) => id,
            None => {
                d.next_id += 1;
                format!("o{}", d.next_id)
            }
        };
        d.files.insert(id.clone(), (name.clone(), body.to_string()));
        d.log.push((id.clone(), name));
        serde_json::json!({ "id": id }).to_string()
    }

    /// Starts a fake cloud answering with `handle`; returns its base URL.
    fn serve<T: Send + 'static>(
        cloud: Arc<Mutex<T>>,
        handle: fn(&Mutex<T>, &str, &str, &str, &str) -> String,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let drive = cloud;
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut s = stream.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 65536];
                let (head, body) = loop {
                    let n = s.read(&mut chunk).unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if rest.len() >= len {
                            break (head.to_string(), rest.to_string());
                        }
                    }
                };
                let mut first = head.lines().next().unwrap().split(' ');
                let (method, target) = (first.next().unwrap(), first.next().unwrap());
                let reply = handle(&drive, method, target, &head, &body);
                let _ = write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            }
        });
        base
    }

    #[derive(Default)]
    struct TestUi {
        focused: Mutex<HashSet<String>>,
    }

    impl Ui for TestUi {
        fn focused(&self, note_id: &str) -> bool {
            self.focused.lock().unwrap().contains(note_id)
        }
        fn reload_note(&self, _: &str) {}
        fn close_note(&self, _: &str) {}
        fn close_group(&self, _: &str) {}
        fn changed(&self, _: bool, _: bool) {}
    }

    fn computer(name: &str) -> Shared {
        // Tests run in parallel: the counter keeps two of them from sharing a
        // folder (and its images) within the same millisecond.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("memo-sync-test-{name}-{}-{n}", crate::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        Arc::new(Store::load(dir.join("notes.json")))
    }

    fn sync_drive(store: &Shared, ui: &TestUi, base: &str) {
        let drive = Drive { http: reqwest::Client::new(), token: "test".into(), base: base.into() };
        tauri::async_runtime::block_on(run_with(store, ui, &drive, Provider::Google, "me@example.com")).unwrap();
    }

    fn sync_onedrive(store: &Shared, ui: &TestUi, base: &str) {
        let drive = OneDrive { http: reqwest::Client::new(), token: "test".into(), base: base.into() };
        tauri::async_runtime::block_on(run_with(store, ui, &drive, Provider::Microsoft, "me@outlook.com")).unwrap();
    }

    fn text_of(store: &Shared, id: &str) -> Option<String> {
        store.get(id).map(|n| n.text)
    }

    #[test]
    fn two_computers_through_google_drive() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let fake = Arc::new(Mutex::new(FakeDrive::default()));
        let base = serve(fake.clone(), handle);
        let images = || fake.lock().unwrap().files.values().filter(|f| f.0.starts_with(IMAGE_PREFIX)).count();
        two_computers(Provider::Google, &|store, ui| sync_drive(store, ui, &base), &images);
    }

    #[test]
    fn two_computers_through_onedrive() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let fake = Arc::new(Mutex::new(FakeOneDrive::default()));
        let base = serve(fake.clone(), handle_onedrive);
        fake.lock().unwrap().base = base.clone();
        let images = || fake.lock().unwrap().files.values().filter(|f| f.0.starts_with(IMAGE_PREFIX)).count();
        two_computers(Provider::Microsoft, &|store, ui| sync_onedrive(store, ui, &base), &images);
        // A file replaced by a newer stamp leaves no old copy behind.
        let names: Vec<String> = fake.lock().unwrap().files.values().map(|f| f.0.rsplit_once('~').unwrap().0.to_string()).collect();
        let unique: HashSet<&String> = names.iter().collect();
        assert_eq!(names.len(), unique.len(), "one file per name: {names:?}");
    }

    /// Both clouds at once: A syncs with Google Drive only, C with OneDrive
    /// only, B with both. B carries what each writes to the other, both
    /// ways, and nothing goes back and forth for ever.
    #[test]
    fn both_clouds_bridge_computers() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let drive = Arc::new(Mutex::new(FakeDrive::default()));
        let drive_base = serve(drive.clone(), handle);
        let onedrive = Arc::new(Mutex::new(FakeOneDrive::default()));
        let onedrive_base = serve(onedrive.clone(), handle_onedrive);
        onedrive.lock().unwrap().base = onedrive_base.clone();
        let ui = TestUi::default();
        let (a, b, c) = (computer("bridge-a"), computer("bridge-b"), computer("bridge-c"));
        let both = |store: &Shared| {
            sync_drive(store, &ui, &drive_base);
            sync_onedrive(store, &ui, &onedrive_base);
        };

        // Written on A (Drive), it reaches C (OneDrive) through B.
        let n = a.create(None);
        a.update(&n.id, |n| n.text = "from A".into());
        sync_drive(&a, &ui, &drive_base);
        both(&b);
        sync_onedrive(&c, &ui, &onedrive_base);
        assert_eq!(text_of(&c, &n.id).as_deref(), Some("from A"));

        // Edited on C, it gets back to A the same way: B brings it in from
        // OneDrive and sends it to Drive on its next round.
        c.update(&n.id, |n| n.text = "from C".into());
        sync_onedrive(&c, &ui, &onedrive_base);
        both(&b);
        both(&b);
        sync_drive(&a, &ui, &drive_base);
        assert_eq!(text_of(&a, &n.id).as_deref(), Some("from C"));

        // Settled: nothing left to send anywhere.
        both(&b);
        for (store, cloud) in [(&a, Provider::Google), (&b, Provider::Google), (&b, Provider::Microsoft), (&c, Provider::Microsoft)] {
            assert_eq!(pending_summary(store, cloud).0, 0, "{cloud:?} has nothing to send");
        }
        assert!(a.all().iter().chain(c.all().iter()).all(|x| !x.title.contains("(conf")), "no conflict copies");
    }

    /// The same story with any cloud: `sync` runs one computer's sync,
    /// `images_sent` counts the image files in the cloud.
    fn two_computers(cloud: Provider, sync: &dyn Fn(&Shared, &TestUi), images_sent: &dyn Fn() -> usize) {
        let ui = TestUi::default();
        let (a, b) = (computer("a"), computer("b"));

        // A note written on A reaches B, closed, with B's own layout.
        let n = a.create(Some((10, 10)));
        a.update(&n.id, |n| n.text = "hello".into());
        sync(&a, &ui);
        sync(&b, &ui);
        let on_b = b.get(&n.id).expect("note reached B");
        assert_eq!(on_b.text, "hello");
        assert!(on_b.hidden && on_b.x.is_none(), "arrives closed, no layout");

        // Moving it on B is layout: nothing to send.
        b.update(&n.id, |n| n.x = Some(500));
        assert_eq!(pending_summary(&b, cloud).0, 0);

        // Edited on both: the newer edit wins, the other goes to the trash.
        a.update(&n.id, |n| n.text = "from A".into());
        std::thread::sleep(Duration::from_millis(5));
        b.update(&n.id, |n| n.text = "from B".into());
        sync(&a, &ui);
        sync(&b, &ui);
        sync(&a, &ui);
        assert_eq!(text_of(&a, &n.id).as_deref(), Some("from B"));
        assert_eq!(text_of(&b, &n.id).as_deref(), Some("from B"));
        let copies: Vec<_> = b.all().into_iter().filter(|x| x.text == "from A").collect();
        assert_eq!(copies.len(), 1, "A's version kept on B");
        assert!(copies[0].trashed_at.is_some());
        assert!(copies[0].title.ends_with("(conflict)") || copies[0].title.ends_with("(conflito)"));
        sync(&a, &ui);
        assert!(a.all().iter().any(|x| x.text == "from A" && x.trashed_at.is_some()), "the copy syncs too");

        // A change to a note focused on B waits until it loses focus.
        a.update(&n.id, |n| n.text = "later".into());
        sync(&a, &ui);
        ui.focused.lock().unwrap().insert(n.id.clone());
        sync(&b, &ui);
        assert_eq!(text_of(&b, &n.id).as_deref(), Some("from B"));
        ui.focused.lock().unwrap().clear();
        sync(&b, &ui);
        assert_eq!(text_of(&b, &n.id).as_deref(), Some("later"));

        // Groups and the defaults travel; a group new to B arrives closed.
        let g = a.create_group(None);
        a.update_group(&g.id, |g| g.name = "Work".into());
        a.update(&n.id, |n| n.group_id = g.id.clone());
        a.set_default_title("Daily".into());
        sync(&a, &ui);
        sync(&b, &ui);
        let g_on_b = b.group(&g.id).expect("group reached B");
        assert_eq!(g_on_b.name, "Work");
        assert!(g_on_b.hidden);
        assert_eq!(b.get(&n.id).unwrap().group_id, g.id);
        assert_eq!(b.new_note_defaults().0, "Daily");

        // Deleted for good on A: deleted on B too, and not sent back.
        a.update(&n.id, |n| n.trashed_at = Some(1));
        a.remove(&n.id);
        sync(&a, &ui);
        sync(&b, &ui);
        assert!(b.get(&n.id).is_none(), "deleted on B");
        sync(&a, &ui);
        assert!(a.get(&n.id).is_none(), "stays deleted on A");
        assert_eq!(pending_summary(&a, cloud).0, 0);
        assert_eq!(pending_summary(&b, cloud).0, 0);

        // A blank note never sent stays local.
        let blank = b.create(None);
        sync(&b, &ui);
        sync(&a, &ui);
        assert!(a.get(&blank.id).is_none());

        // A pasted image goes once as a file of its own and arrives as a file.
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.encode(b"a tiny fake png");
        let inline = format!(r#"<div>see<img src="data:image/png;base64,{png}"></div>"#);
        let p = a.create(None);
        let html = a.store_images(&inline);
        assert!(html.contains(r#"src="images/"#));
        a.update(&p.id, |n| {
            n.text = "see[image]".into();
            n.html = html.clone();
        });
        sync(&a, &ui);
        a.update(&p.id, |n| n.text = "see the [image]".into());
        sync(&a, &ui);
        sync(&b, &ui);
        let on_b = b.get(&p.id).expect("note with an image reached B");
        assert_eq!(on_b.html, html);
        assert_eq!(b.inline_images(&on_b.html), inline, "the image file reached B");
        assert_eq!(images_sent(), 1, "the image is sent once");
    }
}
