//! In-app updates (tauri-plugin-updater).
//!
//! The app reads `latest.json` from the newest published GitHub release
//! (endpoint and public key in tauri.conf.json; the release workflow signs
//! the installers and writes that file). A newer version shows in Settings
//! and in the tray menu ("Update to X"); one click downloads it, checks its
//! signature, installs it and starts Memo again. On Windows the installer
//! runs in passive mode (a progress bar, no questions) and closes the app
//! itself.
//!
//! When it checks: a few seconds after launch and then every few hours,
//! unless turned off in Settings (`Config.updates_off`); always on "Check for
//! updates". Debug builds (`npm run dev`) only check when asked. Automatic
//! checks fail silently (offline); a manual one shows its error.

use crate::{refresh_tray, Config, Shared, CONFIG};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// First automatic check after launch (the windows open first).
const FIRST_CHECK: Duration = Duration::from_secs(10);
/// Automatic checks while the app runs.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);

/// What the manager shows (`get_updates`, `update-changed`).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub checking: bool,
    /// The newer version found, if any.
    pub available: Option<String>,
    /// Download progress (0–100) while an update installs.
    pub progress: Option<u8>,
    /// The last manual check found nothing newer.
    pub up_to_date: bool,
    /// The step that failed last: "check" or "install".
    pub error: Option<String>,
    /// The windows' notice of this version was dismissed (its ✕).
    pub dismissed: bool,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);
static PENDING: Mutex<Option<Update>> = Mutex::new(None);
static BUSY: AtomicBool = AtomicBool::new(false);

/// The windows' notice's ✕ (components/update.js).
pub fn dismiss(app: &AppHandle) {
    set_status(app, |s| s.dismissed = true);
}

pub fn status() -> Status {
    STATUS.lock().unwrap().clone().unwrap_or_default()
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    {
        let mut status = STATUS.lock().unwrap();
        f(status.get_or_insert_with(Status::default));
    }
    let _ = app.emit("update-changed", status());
}

/// Whether automatic checks are on (Settings), from `config.json`.
pub fn auto_enabled(app: &AppHandle) -> bool {
    crate::default_data_dir(app).is_ok_and(|dir| !Config::load(&dir.join(CONFIG)).updates_off)
}

pub fn set_auto(app: &AppHandle, on: bool) -> Result<(), String> {
    let path = crate::default_data_dir(app).map_err(|e| e.to_string())?.join(CONFIG);
    let mut config = Config::load(&path);
    config.updates_off = !on;
    config.save(&path).map_err(|e| e.to_string())
}

/// Starts the automatic checks (release builds only).
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if auto_enabled(&app) {
                check(&app, false).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Looks for a newer version. `manual`: "Check for updates" (shows "up to
/// date" or the error).
pub async fn check(app: &AppHandle, manual: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    set_status(app, |s| {
        s.checking = true;
        s.up_to_date = false;
        s.error = None;
    });
    let result = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(err) => Err(err),
    };
    if let Err(err) = &result {
        eprintln!("memo: update check: {err}");
    }
    let found = result.as_ref().ok().and_then(|u| u.as_ref()).map(|u| u.version.clone());
    let changed = found != status().available;
    if let Ok(update) = result.as_ref() {
        *PENDING.lock().unwrap() = update.clone();
    }
    set_status(app, |s| {
        s.checking = false;
        match &result {
            Ok(_) => {
                // A newer version, or asking again, shows the notice again.
                if changed || manual {
                    s.dismissed = false;
                }
                s.available = found;
                s.up_to_date = manual && s.available.is_none();
            }
            Err(_) if manual => s.error = Some("check".into()),
            Err(_) => {}
        }
    });
    BUSY.store(false, Ordering::SeqCst);
    // The tray's "Update to X" item.
    if changed && result.is_ok() {
        refresh_tray(app);
    }
}

/// Downloads and installs the update found (checking first if none was),
/// then starts the new version.
pub async fn install(app: &AppHandle) {
    if PENDING.lock().unwrap().is_none() {
        check(app, true).await;
    }
    let Some(update) = PENDING.lock().unwrap().clone() else {
        return;
    };
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    set_status(app, |s| {
        s.progress = Some(0);
        s.error = None;
    });
    let mut done = 0u64;
    let mut shown = 0u8;
    let bytes = update
        .download(
            |chunk, total| {
                done += chunk as u64;
                let percent = total.map_or(0, |t| (done * 100 / t.max(1)).min(100) as u8);
                if percent != shown {
                    shown = percent;
                    set_status(app, |s| s.progress = Some(percent));
                }
            },
            || {},
        )
        .await;
    // Nothing typed is lost: Windows closes the app while the installer runs.
    app.state::<Shared>().flush();
    let result = bytes.and_then(|bytes| update.install(bytes));
    match result {
        Ok(()) => app.restart(),
        Err(err) => {
            eprintln!("memo: update install: {err}");
            set_status(app, |s| {
                s.progress = None;
                s.error = Some("install".into());
            });
            BUSY.store(false, Ordering::SeqCst);
        }
    }
}
