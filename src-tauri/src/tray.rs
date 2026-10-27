//! Tray / menu bar icon, and the app part of every titlebar menu.

use crate::*;

/// Tray menu: the app's commands that make sense without a window (creating,
/// showing, the manager's tabs, appearance, sync) and "Quit". Rebuilt by
/// `refresh_tray` whenever a checked item or a label changes.
pub(crate) fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let items = app_menu_items(app, "")?;
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    Menu::with_items(app, &refs)
}

/// The app's commands, as in the tray menu: also the bottom part of every
/// titlebar menu (`show_title_menu`), with the item ids behind `prefix`.
pub(crate) fn app_menu_items(app: &AppHandle, prefix: &str) -> tauri::Result<Vec<MenuItemKind<tauri::Wry>>> {
    let store = app.state::<Shared>();
    let l = tray_labels(store.effective_language());
    let id = |id: &str| format!("{prefix}{id}");
    let item = |key: &str, text: &str| MenuItem::with_id(app, id(key), text, true, None::<&str>);
    let check = |key: &str, text: &str, on: bool| CheckMenuItem::with_id(app, id(key), text, true, on, None::<&str>);

    let theme = store.theme();
    let theme_menu = Submenu::with_items(
        app,
        l.theme,
        true,
        &[
            &check("theme:system", l.system, theme == "system")?,
            &check("theme:light", l.light, theme == "light")?,
            &check("theme:dark", l.dark, theme == "dark")?,
        ],
    )?;
    // Language names stay in their own language, as in Settings.
    let language = store.language();
    let language_menu = Submenu::with_items(
        app,
        l.language,
        true,
        &[
            &check("language:system", l.system, language == "system")?,
            &check("language:pt-BR", "Português", language == "pt-BR")?,
            &check("language:en", "English", language == "en")?,
        ],
    )?;
    let layout = store.manager_layout();
    let layout_menu = Submenu::with_items(
        app,
        l.layout,
        true,
        &[
            &check("layout:cards", l.cards, layout == "cards")?,
            &check("layout:list", l.list, layout == "list")?,
        ],
    )?;
    let autostart = {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled()
    };
    let autostart_item = CheckMenuItem::with_id(
        app,
        id("autostart"),
        l.autostart,
        autostart.is_ok(),
        autostart.unwrap_or(false),
        None::<&str>,
    )?;

    let ai_control = default_data_dir(app).is_ok_and(|dir| mcp::enabled(&dir));
    let separator = || PredefinedMenuItem::separator(app).map(|s| s.kind());
    let mut items = vec![
        item("new", l.new_note)?.kind(),
        item("new-group", l.new_group)?.kind(),
        item("new-board", l.new_board)?.kind(),
        item("show", l.show)?.kind(),
    ];
    // While a shared item is in the clipboard (share.rs).
    if share::pending() {
        items.push(item("import-share", l.import_share)?.kind());
    }
    items.extend([
        separator()?,
        item("manager", l.manager)?.kind(),
        item("trash", l.trash)?.kind(),
        item("settings", l.settings)?.kind(),
        item("help", l.help)?.kind(),
        separator()?,
        theme_menu.kind(),
        language_menu.kind(),
        layout_menu.kind(),
        autostart_item.kind(),
        check("magnet", l.magnet, store.magnet())?.kind(),
        check("ai-control", l.ai_control, ai_control)?.kind(),
    ]);
    // "Sync now" only with a Google account connected on this computer.
    if cloud_account(app).is_some() {
        items.push(item("sync", l.sync)?.kind());
    }
    items.push(separator()?);
    // A newer version found (updater.rs) replaces "Check for updates".
    items.push(
        match updater::status().available {
            Some(version) => item("update", &format!("{} {version}", l.update_to))?,
            None => item("check-updates", l.check_updates)?,
        }
        .kind(),
    );
    // The running version, greyed out: shows at a glance which build is open.
    items.push(
        MenuItem::with_id(
            app,
            id("version"),
            format!("Memo {}", app.package_info().version),
            false,
            None::<&str>,
        )?
        .kind(),
    );
    items.push(item("quit", l.quit)?.kind());
    Ok(items)
}

/// One of a window's own commands in its titlebar menu (`null` in JS = a
/// separator). `checked` makes it a check item (pin); `items` a submenu
/// (a note's "Format").
#[derive(serde::Deserialize)]
pub(crate) struct TitleMenuItem {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) checked: Option<bool>,
    pub(crate) items: Option<Vec<Option<TitleMenuItem>>>,
}

/// The native entry for a `TitleMenuItem` (recursive for submenus), with
/// its id behind `prefix`.
pub(crate) fn title_menu_entry(app: &AppHandle, prefix: &str, item: Option<TitleMenuItem>) -> tauri::Result<MenuItemKind<tauri::Wry>> {
    Ok(match item {
        None => PredefinedMenuItem::separator(app)?.kind(),
        Some(TitleMenuItem { id, label, items: Some(items), .. }) => {
            let sub = Submenu::with_id(app, format!("{prefix}own:{id}"), label, true)?;
            for item in items {
                sub.append(&title_menu_entry(app, prefix, item)?)?;
            }
            sub.kind()
        }
        Some(TitleMenuItem { id, label, checked: Some(on), .. }) => {
            CheckMenuItem::with_id(app, format!("{prefix}own:{id}"), label, true, on, None::<&str>)?.kind()
        }
        Some(TitleMenuItem { id, label, .. }) => {
            MenuItem::with_id(app, format!("{prefix}own:{id}"), label, true, None::<&str>)?.kind()
        }
    })
}

/// Right click on a titlebar, or its "…" button: a native menu with the
/// window's own commands on top and all the app's commands (the tray menu's)
/// below, so any window reaches every command. Native, so it is never cut
/// by a small window. `at` is the button's bottom-left corner (CSS pixels);
/// without it the menu opens at the pointer. Clicks come back in
/// `on_tray_menu` as `win:<label>:<id>`.
#[tauri::command]
pub(crate) async fn show_title_menu(
    app: AppHandle,
    window: WebviewWindow,
    items: Vec<Option<TitleMenuItem>>,
    at: Option<(f64, f64)>,
) -> Result<(), String> {
    let prefix = format!("win:{}:", window.label());
    let menu = Menu::new(&app).map_err(|e| e.to_string())?;
    let mut own = Vec::new();
    for item in items {
        own.push(title_menu_entry(&app, &prefix, item).map_err(|e| e.to_string())?);
    }
    if !own.is_empty() {
        own.push(PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?.kind());
    }
    own.extend(app_menu_items(&app, &prefix).map_err(|e| e.to_string())?);
    for item in &own {
        menu.append(item).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    set_menu_theme(&app.state::<Shared>().theme());
    match at {
        Some((x, y)) => {
            let zoom = app.state::<Shared>().zoom();
            window.popup_menu_at(&menu, LogicalPosition::new(x * zoom, y * zoom))
        }
        None => window.popup_menu(&menu),
    }
    .map_err(|e| e.to_string())
}

/// Windows draws popup menus light or dark from the process-wide "preferred
/// app mode", not from the window's theme: set it to Memo's theme before a
/// titlebar menu opens. uxtheme's SetPreferredAppMode (ordinal 135) and
/// FlushMenuThemes (136) are undocumented but stable since Windows 10 1903.
#[cfg(windows)]
pub(crate) fn set_menu_theme(theme: &str) {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    // 1 = follow the system, 2 = force dark, 3 = force light.
    let mode: i32 = match theme {
        "dark" => 2,
        "light" => 3,
        _ => 1,
    };
    let name: Vec<u16> = "uxtheme.dll\0".encode_utf16().collect();
    unsafe {
        let lib = LoadLibraryW(name.as_ptr());
        if lib.is_null() {
            return;
        }
        if let Some(set) = GetProcAddress(lib, 135 as *const u8) {
            let set: unsafe extern "system" fn(i32) -> i32 = std::mem::transmute(set);
            set(mode);
        }
        if let Some(flush) = GetProcAddress(lib, 136 as *const u8) {
            let flush: unsafe extern "system" fn() = std::mem::transmute(flush);
            flush();
        }
    }
}

/// A click in a titlebar menu (`show_title_menu`), from window `label`: its
/// own commands go back to the window ("title-menu" event); new memories and
/// groups open beside it, as with its buttons; the rest is the tray's.
pub(crate) fn on_title_menu(app: &AppHandle, label: &str, id: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return on_tray_menu(app, id);
    };
    if let Some(own) = id.strip_prefix("own:") {
        let _ = window.emit_to(label, "title-menu", own);
        return;
    }
    match id {
        "new" => {
            let _ = create_and_open(app, beside(&window));
        }
        "new-group" => {
            let group = app.state::<Shared>().create_group(beside(&window));
            if let Ok(window) = open_group_window(app, &group) {
                let _ = window.set_focus();
            }
            groups_changed(app);
        }
        "new-board" => {
            let store = app.state::<Shared>();
            let lang = store.effective_language();
            let default_cols = if lang == "en" {
                vec!["To Do".into(), "In Progress".into(), "Done".into()]
            } else {
                vec!["A Fazer".into(), "Em Andamento".into(), "Concluído".into()]
            };
            let board = store.create_board(None, default_cols, beside(&window));
            if let Ok(w) = open_board_window(app, &board) {
                let _ = w.set_focus();
            }
            boards_changed(app);
        }
        _ => on_tray_menu(app, id),
    }
}

/// A tray menu click.
pub(crate) fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "new" => {
            let _ = create_and_open(app, None);
        }
        "new-group" => {
            let group = app.state::<Shared>().create_group(None);
            if let Ok(window) = open_group_window(app, &group) {
                let _ = window.set_focus();
            }
            groups_changed(app);
        }
        "new-board" => {
            let store = app.state::<Shared>();
            let lang = store.effective_language();
            let default_cols = if lang == "en" {
                vec!["To Do".into(), "In Progress".into(), "Done".into()]
            } else {
                vec!["A Fazer".into(), "Em Andamento".into(), "Concluído".into()]
            };
            let board = store.create_board(None, default_cols, None);
            if let Ok(w) = open_board_window(app, &board) {
                let _ = w.set_focus();
            }
            boards_changed(app);
        }
        "show" => show_all(app),
        "import-share" => share::import_pending(app, None),
        "manager" => {
            let _ = open_manager(app);
        }
        "trash" => open_manager_view(app, "notes", Some("trash")),
        "settings" => open_manager_view(app, "settings", None),
        "help" => open_manager_view(app, "help", None),
        "autostart" => {
            use tauri_plugin_autostart::ManagerExt;
            let manager = app.autolaunch();
            let result = match manager.is_enabled() {
                Ok(true) => manager.disable(),
                Ok(false) => manager.enable(),
                Err(err) => Err(err),
            };
            if let Err(err) = result {
                eprintln!("memo: autostart: {err}");
            }
            // The manager's switch follows.
            let _ = app.emit("autostart-changed", manager.is_enabled().unwrap_or(false));
            refresh_tray(app);
        }
        "magnet" => {
            let on = !app.state::<Shared>().magnet();
            toggle_magnet(app, on);
        }
        "ai-control" => {
            let on = default_data_dir(app).is_ok_and(|dir| !mcp::enabled(&dir));
            if let Err(err) = toggle_ai_control(app, on) {
                eprintln!("memo: ai control: {err}");
                refresh_tray(app);
            }
        }
        "sync" => sync::sync_now(app),
        // Both answer in Settings, which shows the check and the download.
        "check-updates" => {
            open_manager_view(app, "settings", Some("update"));
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::check(&app, true).await });
        }
        "update" => {
            open_manager_view(app, "settings", Some("update"));
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::install(&app).await });
        }
        "quit" => {
            app.state::<Shared>().flush();
            app.exit(0);
        }
        _ => {
            if let Some((label, id)) = id.strip_prefix("win:").and_then(|rest| rest.split_once(':')) {
                on_title_menu(app, label, id);
            } else if let Some(theme) = id.strip_prefix("theme:") {
                set_theme(app, theme);
            } else if let Some(language) = id.strip_prefix("language:") {
                set_language(app, language);
            } else if let Some(layout) = id.strip_prefix("layout:") {
                set_layout(app, layout);
            }
        }
    }
}

pub(crate) fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;

    // On macOS the icon is a "template" (monochrome, adapts to the menu bar theme).
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::include_image!("icons/tray.png");

    TrayIconBuilder::with_id("memo")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Memo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
        // A click on the tray icon opens the manager (Linux trays send no
        // clicks: the menu has the manager item).
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = open_manager(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
