//! Data folder: choosing, resetting and migrating it; backup export / import.

use crate::*;

/// Default data folder: `<OS data folder>/memo`.
pub(crate) fn default_data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().data_dir()?.join(DATA_FOLDER))
}

/// Folder holding `notes.json`: the one set in `config.json`, or the default
/// data folder. A custom folder that can't be created (e.g. on an
/// unplugged drive) falls back to the default for this session.
pub(crate) fn data_dir(default: &Path) -> PathBuf {
    match Config::load(&default.join(CONFIG)).data_dir {
        Some(dir) => match std::fs::create_dir_all(&dir) {
            Ok(()) => dir,
            Err(err) => {
                eprintln!("memo: data folder {dir:?} unavailable ({err}); using {default:?}");
                default.to_path_buf()
            }
        },
        None => default.to_path_buf(),
    }
}

/// Texts of the data folder dialogs in the UI language.
pub(crate) struct StorageText {
    pub(crate) pick_title: &'static str,
    pub(crate) existing: &'static str,
    pub(crate) open_existing: &'static str,
    pub(crate) replace_existing: &'static str,
    pub(crate) cancel: &'static str,
    pub(crate) failed: &'static str,
    pub(crate) export_title: &'static str,
    pub(crate) export_failed: &'static str,
    pub(crate) import_title: &'static str,
    pub(crate) import_failed: &'static str,
}

pub(crate) fn storage_text(lang: &str) -> StorageText {
    if lang == "en" {
        StorageText {
            pick_title: "Choose the memories folder",
            existing: "This folder already has Memo memories.\n\nOpen them in place of the current ones (which stay saved in the previous folder), or replace them with the current memories (the file there is kept as a backup)?",
            open_existing: "Open those",
            replace_existing: "Replace with current",
            cancel: "Cancel",
            failed: "Couldn't use this folder.",
            export_title: "Export memories",
            export_failed: "Couldn't export the memories.",
            import_title: "Import memories",
            import_failed: "Couldn't import this file. It must be a Memo export or notes.json.",
        }
    } else {
        StorageText {
            pick_title: "Escolha a pasta das memórias",
            existing: "Esta pasta já tem memórias do Memo.\n\nAbrir essas memórias no lugar das atuais (que continuam salvas na pasta anterior) ou substituí-las pelas memórias atuais (o arquivo de lá fica como backup)?",
            open_existing: "Abrir as de lá",
            replace_existing: "Substituir pelas atuais",
            cancel: "Cancelar",
            failed: "Não foi possível usar esta pasta.",
            export_title: "Exportar memórias",
            export_failed: "Não foi possível exportar as memórias.",
            import_title: "Importar memórias",
            import_failed: "Não foi possível importar este arquivo. Ele precisa ser uma exportação do Memo ou um notes.json.",
        }
    }
}

/// Moves the notes to `dir`. If it already has a `notes.json`, asks whether to
/// switch to those notes (reopening the windows with them) or to replace them
/// with the current ones; otherwise the current notes are copied there. The
/// old file stays as a backup. Returns `false` if nothing changed (same folder
/// or cancelled).
pub(crate) fn move_data_dir(app: &AppHandle, window: &WebviewWindow, dir: PathBuf) -> Result<bool, String> {
    let store = app.state::<Shared>();
    let default = default_data_dir(app).map_err(|e| e.to_string())?;
    let text = storage_text(store.effective_language());
    let target = dir.join("notes.json");
    if store.path() == target {
        return Ok(false);
    }
    let mut load_existing = false;
    if target.exists() {
        let choice = app
            .dialog()
            .message(text.existing)
            .title("Memo")
            .parent(window)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                text.open_existing.into(),
                text.replace_existing.into(),
                text.cancel.into(),
            ))
            .blocking_show_with_result();
        // Depending on the OS, custom buttons come back as Yes/No or as their label.
        load_existing = match choice {
            MessageDialogResult::Yes => true,
            MessageDialogResult::No => false,
            MessageDialogResult::Custom(label) if label == text.open_existing => true,
            MessageDialogResult::Custom(label) if label == text.replace_existing => false,
            _ => return Ok(false),
        };
    }
    let mut config = Config::load(&default.join(CONFIG));
    config.data_dir = (dir != default).then(|| dir.clone());
    let result = store
        .relocate(target, load_existing)
        .and_then(|loaded| config.save(&default.join(CONFIG)).map(|()| loaded));
    let loaded = match result {
        Ok(loaded) => loaded,
        Err(err) => {
            storage_error(app, window, text.failed, &err);
            return Err(err.to_string());
        }
    };
    if loaded {
        reload_windows(app);
    }
    notify(app);
    Ok(true)
}

/// After switching to another notes file: closes the note, group and board
/// windows, opens those of the new file (as at startup) and applies its theme
/// and language. The manager reloads itself on "store-replaced".
pub(crate) fn reload_windows(app: &AppHandle) {
    for window in app.webview_windows().into_values() {
        if Kind::Note.is(&window) || Kind::Group.is(&window) || Kind::Board.is(&window) {
            let _ = window.destroy();
        }
    }
    let store = app.state::<Shared>();
    for group in store.active_groups().iter().filter(|g| !g.hidden) {
        let _ = open_group_window(app, group);
    }
    for board in store.visible_boards() {
        let _ = open_board_window(app, &board);
    }
    for note in store.visible() {
        let _ = open_note_window(app, &note);
    }
    let theme = store.theme();
    for window in app.webview_windows().values().filter(|w| is_app_window(w)) {
        apply_theme(window, &theme);
    }
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let _ = manager.set_title(manager_title(store.effective_language()));
    }
    refresh_tray(app);
    let _ = app.emit("store-replaced", ());
}

/// Folder where the notes are saved and whether it is the default one.
/// Start with the system, set up once: on Windows the installer asked
/// (windows/hooks.nsh); on macOS and Linux, which have no installer step for
/// it, it is turned on by the first run of a release build.
pub(crate) fn init_autostart(app: &AppHandle, default_dir: &Path) {
    use tauri_plugin_autostart::ManagerExt;
    let path = default_dir.join(CONFIG);
    let mut config = Config::load(&path);
    if config.autostart_init {
        return;
    }
    if cfg!(not(windows)) && !cfg!(debug_assertions) {
        let _ = app.autolaunch().enable();
    }
    config.autostart_init = true;
    let _ = config.save(&path);
}

/// Configurações → "Start with the system".
#[tauri::command]
pub(crate) fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if on {
        manager.enable()
    } else {
        manager.disable()
    }
    .map_err(|e| e.to_string())?;
    refresh_tray(&app);
    manager.is_enabled().map_err(|e| e.to_string())
}

/// Settings → Magnet: whether windows stick to screen edges and to each
/// other while dragged or resized (and notes fold onto their titlebar).
#[tauri::command]
pub(crate) fn get_magnet(store: State<'_, Shared>) -> bool {
    store.magnet()
}

#[tauri::command]
pub(crate) fn set_magnet(app: AppHandle, on: bool) -> bool {
    toggle_magnet(&app, on);
    on
}

/// Turns the magnet on or off (Settings switch or tray item); the manager's
/// switch and the tray follow.
pub(crate) fn toggle_magnet(app: &AppHandle, on: bool) {
    let store = app.state::<Shared>();
    store.set_magnet(on);
    store.flush();
    let _ = app.emit("magnet-changed", on);
    refresh_tray(app);
}

/// Settings → AI control: whether it is on, and the executable MCP clients
/// launch (`<path> --mcp`), for the setup snippets.
#[tauri::command]
pub(crate) fn get_ai_control(app: AppHandle) -> Result<(bool, String), String> {
    let dir = default_data_dir(&app).map_err(|e| e.to_string())?;
    Ok((mcp::enabled(&dir), ai_exe()))
}

/// Settings → AI control: the MCP clients installed here and whether each
/// one has Memo.
#[tauri::command]
pub(crate) fn get_ai_clients() -> Vec<clients::Status> {
    clients::list(&ai_exe())
}

/// Adds Memo to MCP client `id` (or removes it); returns the new list.
#[tauri::command]
pub(crate) fn connect_ai_client(id: String, on: bool) -> Result<Vec<clients::Status>, String> {
    let exe = ai_exe();
    if exe.is_empty() {
        return Err("no executable path".into());
    }
    clients::connect(&id, &exe, on)?;
    Ok(clients::list(&exe))
}

pub(crate) fn ai_exe() -> String {
    mcp::app_path().map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
pub(crate) fn set_ai_control(app: AppHandle, on: bool) -> Result<bool, String> {
    toggle_ai_control(&app, on)?;
    Ok(on)
}

/// Turns AI control on or off (Settings switch or tray item); the manager's
/// switch and the tray follow.
pub(crate) fn toggle_ai_control(app: &AppHandle, on: bool) -> Result<(), String> {
    let dir = default_data_dir(app).map_err(|e| e.to_string())?;
    mcp::set_enabled(app, &dir, on)?;
    let _ = app.emit("ai-control-changed", on);
    refresh_tray(app);
    Ok(())
}

/// Settings → Updates: whether automatic checks are on, and the update
/// status (`updater::Status`).
#[tauri::command]
pub(crate) fn get_updates(app: AppHandle) -> (bool, updater::Status) {
    (updater::auto_enabled(&app), updater::status())
}

#[tauri::command]
pub(crate) fn set_auto_update(app: AppHandle, on: bool) -> Result<bool, String> {
    updater::set_auto(&app, on)?;
    Ok(on)
}

/// "Check for updates": the answer comes as `update-changed`.
#[tauri::command]
pub(crate) async fn check_update(app: AppHandle) {
    updater::check(&app, true).await;
}

/// Hides the windows' notice of the version found (Settings and the tray
/// still offer it).
#[tauri::command]
pub(crate) fn dismiss_update(app: AppHandle) {
    updater::dismiss(&app);
}

/// Downloads and installs the update found, then restarts Memo.
#[tauri::command]
pub(crate) async fn install_update(app: AppHandle) {
    updater::install(&app).await;
}

/// Configurações → Sincronização: whether this build can connect a Google
/// account, the one connected on this computer and how syncing goes.
#[tauri::command]
pub(crate) fn get_cloud_account(app: AppHandle) -> (bool, Option<String>, sync::Status) {
    (cloud::available(), cloud_account(&app), sync::status())
}

/// The Google account connected on this computer, if this build can sync.
pub(crate) fn cloud_account(app: &AppHandle) -> Option<String> {
    if !cloud::available() {
        return None;
    }
    let dir = default_data_dir(app).ok()?;
    Config::load(&dir.join(CONFIG)).google_account
}

/// "Sync now".
#[tauri::command]
pub(crate) fn sync_cloud(app: AppHandle) {
    sync::sync_now(&app);
}

/// Signs in with Google in the browser and remembers the account. Errors are
/// `cloud::ERR_*` codes the page translates.
#[tauri::command]
pub(crate) async fn connect_cloud(app: AppHandle) -> Result<String, String> {
    let lang = app.state::<Shared>().effective_language();
    let email = cloud::sign_in(&app, lang).await?;
    let path = default_data_dir(&app).map_err(|e| e.to_string())?.join(CONFIG);
    let mut config = Config::load(&path);
    config.google_account = Some(email.clone());
    config.save(&path).map_err(|e| e.to_string())?;
    sync::on_connected(&app);
    let _ = app.emit("cloud-changed", ());
    refresh_tray(&app);
    Ok(email)
}

/// Stops a sign-in still waiting for the browser.
#[tauri::command]
pub(crate) fn cancel_cloud_connect() {
    cloud::cancel_sign_in();
}

/// Forgets the Google account on this computer; the memories stay here.
#[tauri::command]
pub(crate) fn disconnect_cloud(app: AppHandle) -> Result<(), String> {
    cloud::sign_out();
    let path = default_data_dir(&app).map_err(|e| e.to_string())?.join(CONFIG);
    let mut config = Config::load(&path);
    config.google_account = None;
    config.save(&path).map_err(|e| e.to_string())?;
    sync::reset(&app);
    let _ = app.emit("cloud-changed", ());
    refresh_tray(&app);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_data_dir(app: AppHandle, store: State<'_, Shared>) -> (String, bool) {
    let path = store.path();
    let dir = path.parent().unwrap_or(&path);
    let is_default = default_data_dir(&app).is_ok_and(|d| d == dir);
    (dir.display().to_string(), is_default)
}

/// Lets the user pick another folder for the notes and moves them there.
/// Returns `false` if cancelled or unchanged.
#[tauri::command]
pub(crate) async fn choose_data_dir(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    let store = app.state::<Shared>();
    let text = storage_text(store.effective_language());
    let current = store.path();
    let mut picker = app
        .dialog()
        .file()
        .set_title(text.pick_title)
        .set_parent(&window);
    if let Some(dir) = current.parent() {
        picker = picker.set_directory(dir);
    }
    let Some(picked) = picker.blocking_pick_folder() else {
        return Ok(false);
    };
    let dir = picked.into_path().map_err(|e| e.to_string())?;
    move_data_dir(&app, &window, dir)
}

/// Moves the notes back to the default data folder.
#[tauri::command]
pub(crate) async fn reset_data_dir(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    let dir = default_data_dir(&app).map_err(|e| e.to_string())?;
    move_data_dir(&app, &window, dir)
}

/// Native error dialog for a failed storage action, with the OS error below.
pub(crate) fn storage_error(app: &AppHandle, window: &WebviewWindow, message: &str, err: &std::io::Error) {
    app.dialog()
        .message(format!("{message}\n\n{err}"))
        .title("Memo")
        .kind(MessageDialogKind::Error)
        .parent(window)
        .blocking_show();
}

/// Exports the notes not in the trash to a `.json` file picked by the user.
/// `file_name` is the suggested name (the page knows the local date).
/// Returns `false` if cancelled.
#[tauri::command]
pub(crate) async fn export_notes(
    app: AppHandle,
    window: WebviewWindow,
    file_name: String,
) -> Result<bool, String> {
    let store = app.state::<Shared>();
    let text = storage_text(store.effective_language());
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(text.export_title)
        .set_parent(&window)
        .set_file_name(file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    store.export_to(&path).map_err(|err| {
        storage_error(&app, &window, text.export_failed, &err);
        err.to_string()
    })?;
    Ok(true)
}

/// Imports the notes of a `.json` file picked by the user (see
/// `Store::import_from`) and opens or refreshes the windows of the notes that
/// changed. Returns how many notes were added or replaced; `None` if
/// cancelled.
#[tauri::command]
pub(crate) async fn import_notes(app: AppHandle, window: WebviewWindow) -> Result<Option<usize>, String> {
    let store = app.state::<Shared>();
    let text = storage_text(store.effective_language());
    let Some(picked) = app
        .dialog()
        .file()
        .set_title(text.import_title)
        .set_parent(&window)
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let ids = store.import_from(&path).map_err(|err| {
        storage_error(&app, &window, text.import_failed, &err);
        err.to_string()
    })?;
    store.flush();
    for id in &ids {
        let note = store.get(id);
        let open = app.get_webview_window(&Kind::Note.label(id));
        match (note, open) {
            // Window already open: reload it with the imported content.
            (Some(note), Some(w)) if note.trashed_at.is_none() => {
                let _ = w.set_always_on_top(note.pinned);
                let _ = w.reload();
            }
            (Some(note), None) if note.trashed_at.is_none() => {
                let _ = open_note_window(&app, &note);
            }
            // Imported as trashed (or purged): close its window.
            (_, Some(w)) => {
                let _ = w.destroy();
            }
            _ => {}
        }
    }
    notify(&app);
    Ok(Some(ids.len()))
}
