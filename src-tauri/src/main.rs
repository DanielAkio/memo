// Sem janela de console no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;
mod welcome;

use std::{sync::Arc, thread, time::Duration};

use store::{
    is_valid_color, now_ms, Note, Store, COLLAPSED_H, DEFAULT_H, DEFAULT_W, THEMES, TITLE_MAX,
};
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

type Shared = Arc<Store>;

/// Cor do fundo da nota no tema escuro (Carbon) e no claro — usada como fundo
/// nativo da janela para evitar um clarão enquanto a página carrega.
const CARBON: Color = Color(15, 16, 17, 255);
const PAPER: Color = Color(251, 251, 250, 255);
/// Espaço (lógico) entre uma nota nova e a nota que a criou.
const GAP: f64 = 12.0;
/// De quanto em quanto tempo a lixeira é verificada com o app aberto (1 h).
const PURGE_EVERY: Duration = Duration::from_secs(3600);
const SAVE_EVERY: Duration = Duration::from_millis(800);
const DAY_MS: u64 = 86_400_000;

fn label_for(id: &str) -> String {
    format!("note-{id}")
}

fn id_of(window: &WebviewWindow) -> String {
    window.label().trim_start_matches("note-").to_string()
}

// ---------------------------------------------------------------------------
// Janelas
// ---------------------------------------------------------------------------

/// Abre a janela de uma nota (ou traz para frente, se já estiver aberta).
fn open_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    let label = label_for(&note.id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(existing);
    }

    let height = if note.collapsed {
        COLLAPSED_H
    } else {
        note.height
    };
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Taxinha")
        .inner_size(note.width, height)
        .min_inner_size(180.0, COLLAPSED_H)
        .decorations(false)
        .resizable(true)
        .always_on_top(note.pinned)
        .background_color(CARBON)
        .visible(false)
        .build()?;

    match (note.x, note.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = window.center();
        }
    }

    apply_background(&window, &app.state::<Shared>().theme());
    track_geometry(app, &window);
    window.show()?;
    Ok(window)
}

/// Fundo nativo da janela no tema efetivo ("system" segue o sistema).
fn apply_background(window: &WebviewWindow, theme: &str) {
    let light = match theme {
        "light" => true,
        "dark" => false,
        _ => matches!(window.theme(), Ok(Theme::Light)),
    };
    let _ = window.set_background_color(Some(if light { PAPER } else { CARBON }));
}

/// Troca o tema de todas as notas (escolhido na bandeja).
fn set_theme(app: &AppHandle, theme: &str) {
    let store = app.state::<Shared>();
    store.set_theme(theme);
    store.flush();
    for window in app.webview_windows().values() {
        apply_background(window, theme);
    }
    let _ = app.emit("theme-changed", theme);
    refresh_tray(app);
}

/// Uma posição salva só é usada se a barra de título continuar visível em
/// algum monitor (evita notas "perdidas" depois de desconectar uma tela).
fn is_on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    match window.available_monitors() {
        Ok(monitors) if !monitors.is_empty() => monitors.iter().any(|m| {
            let p = m.position();
            let s = m.size();
            let (px, py) = (x + 48, y + 12);
            px >= p.x && px < p.x + s.width as i32 && py >= p.y && py < p.y + s.height as i32
        }),
        _ => true,
    }
}

/// Guarda posição e tamanho sempre que o usuário move ou redimensiona a nota.
fn track_geometry(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let win = window.clone();
    let id = id_of(window);
    window.on_window_event(move |event| {
        let store = app.state::<Shared>();
        match event {
            WindowEvent::Moved(pos) => {
                // O Windows reporta -32000 ao minimizar; ignora.
                if pos.x <= -30_000 || pos.y <= -30_000 {
                    return;
                }
                let (x, y) = (pos.x, pos.y);
                store.update(&id, |n| {
                    n.x = Some(x);
                    n.y = Some(y);
                });
            }
            WindowEvent::Resized(size) => {
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let scale = win.scale_factor().unwrap_or(1.0);
                let logical = size.to_logical::<f64>(scale);
                store.update(&id, |n| {
                    n.width = logical.width;
                    // Enquanto recolhida, a altura salva continua sendo a expandida.
                    if !n.collapsed && logical.height > COLLAPSED_H + 8.0 {
                        n.height = logical.height;
                    }
                });
            }
            WindowEvent::ThemeChanged(_) => apply_background(&win, &store.theme()),
            _ => {}
        }
    });
}

/// Abre a nota de boas-vindas (primeira execução ou "Como usar a Taxinha" na
/// bandeja). Se uma cópia intacta já estiver aberta, só traz ela para frente.
fn open_welcome(app: &AppHandle) -> tauri::Result<()> {
    let store = app.state::<Shared>();
    let existing = store
        .active()
        .into_iter()
        .find(|n| n.html == welcome::HTML && n.title == welcome::TITLE);
    let note = match existing {
        Some(note) => note,
        None => {
            let note = store.create(None);
            store
                .update(&note.id, |n| {
                    n.title = welcome::TITLE.into();
                    n.text = welcome::TEXT.into();
                    n.html = welcome::HTML.into();
                    n.width = welcome::WIDTH;
                    n.height = welcome::HEIGHT;
                })
                .unwrap_or(note)
        }
    };
    let window = open_note_window(app, &note)?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(())
}

fn create_and_open(app: &AppHandle, pos: Option<(i32, i32)>) -> tauri::Result<()> {
    let note = app.state::<Shared>().create(pos);
    let window = open_note_window(app, &note)?;
    let _ = window.set_focus();
    Ok(())
}

fn show_all(app: &AppHandle) {
    let windows = app.webview_windows();
    if windows.is_empty() {
        let _ = create_and_open(app, None);
        return;
    }
    for window in windows.values() {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// ---------------------------------------------------------------------------
// Comandos chamados pela interface
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_theme(store: State<'_, Shared>) -> String {
    store.theme()
}

#[tauri::command]
fn load_note(window: WebviewWindow, store: State<'_, Shared>) -> Option<Note> {
    store.get(&id_of(&window))
}

/// Dá um nome à nota; devolve o nome como ficou salvo.
#[tauri::command]
fn set_title(window: WebviewWindow, title: String, store: State<'_, Shared>) -> String {
    let title: String = title.trim().chars().take(TITLE_MAX).collect();
    store.update(&id_of(&window), |n| n.title = title.clone());
    title
}

#[tauri::command]
fn save_text(window: WebviewWindow, text: String, html: String, store: State<'_, Shared>) {
    store.update(&id_of(&window), |n| {
        if n.text != text || n.html != html {
            n.text = text;
            n.html = html;
            n.updated_at = now_ms();
        }
    });
}

/// O recurso principal: mantém (ou não) a nota por cima de todos os aplicativos.
#[tauri::command]
fn set_pinned(
    window: WebviewWindow,
    pinned: bool,
    store: State<'_, Shared>,
) -> Result<bool, String> {
    window
        .set_always_on_top(pinned)
        .map_err(|e| e.to_string())?;
    store.update(&id_of(&window), |n| n.pinned = pinned);
    Ok(pinned)
}

#[tauri::command]
fn set_color(window: WebviewWindow, color: String, store: State<'_, Shared>) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("cor desconhecida: {color}"));
    }
    store.update(&id_of(&window), |n| n.color = color);
    Ok(())
}

/// Recolhe a nota até ficar só a barra de título (como no Stickies).
#[tauri::command]
fn set_collapsed(
    window: WebviewWindow,
    collapsed: bool,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let note = store
        .update(&id_of(&window), |n| n.collapsed = collapsed)
        .ok_or("nota não encontrada")?;
    let height = if collapsed { COLLAPSED_H } else { note.height };
    window
        .set_size(LogicalSize::new(note.width, height))
        .map_err(|e| e.to_string())
}

// Criar e destruir janelas a partir de comandos síncronos pode travar no
// Windows, por isso estes dois são assíncronos.
#[tauri::command]
async fn new_note(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    create_and_open(&app, beside(&window)).map_err(|e| e.to_string())
}

/// Posição (física) para uma nota nova ao lado da nota `parent`, sem
/// sobrepor: à direita se couber na área útil do monitor, senão à esquerda.
/// Sobrepor faria a nota nova sumir atrás de uma nota fixada. Sem espaço
/// dos dois lados, encosta na borda do lado com mais espaço. Se o lugar já
/// estiver ocupado por outra nota (vários "+" seguidos), desce em degraus.
fn beside(parent: &WebviewWindow) -> Option<(i32, i32)> {
    let pos = parent.outer_position().ok()?;
    let size = parent.outer_size().ok()?;
    let monitor = parent.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (left_edge, top_edge) = (area.position.x, area.position.y);
    let right_edge = left_edge + area.size.width as i32;
    let bottom_edge = top_edge + area.size.height as i32;

    let w = (DEFAULT_W * scale).round() as i32;
    let h = (DEFAULT_H * scale).round() as i32;
    let gap = (GAP * scale).round() as i32;
    let parent_right = pos.x + size.width as i32;

    let x = if parent_right + gap + w <= right_edge {
        parent_right + gap
    } else if pos.x - gap - w >= left_edge {
        pos.x - gap - w
    } else if right_edge - parent_right >= pos.x - left_edge {
        right_edge - w
    } else {
        left_edge
    };
    let x = x.max(left_edge);
    let max_y = (bottom_edge - h).max(top_edge);
    let mut y = pos.y.clamp(top_edge, max_y);

    // Vários "+" seguidos na mesma nota cairiam todos no mesmo lugar: se já
    // há uma nota ali, desce um degrau (barra de título + folga) até achar
    // um lugar livre, para todas continuarem visíveis.
    let step = ((COLLAPSED_H + 8.0) * scale).round() as i32;
    let taken: Vec<PhysicalPosition<i32>> = parent
        .app_handle()
        .webview_windows()
        .values()
        .filter(|w| w.is_visible().unwrap_or(false))
        .filter_map(|w| w.outer_position().ok())
        .collect();
    let occupied = |y: i32| {
        taken
            .iter()
            .any(|p| (p.x - x).abs() < step / 2 && (p.y - y).abs() < step / 2)
    };
    while occupied(y) && y + step <= max_y {
        y += step;
    }
    Some((x, y))
}

/// Fecha a nota mandando-a para a lixeira. Uma nota vazia é apagada de vez.
#[tauri::command]
async fn trash_note(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let id = id_of(&window);
    match store.get(&id) {
        Some(note) if note.is_blank() => store.remove(&id),
        Some(_) => {
            store.update(&id, |n| n.trashed_at = Some(now_ms()));
        }
        None => {}
    }
    store.flush();
    window.destroy().map_err(|e| e.to_string())?;
    refresh_tray(&app);
    Ok(())
}

fn restore_note(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    if let Some(note) = store.update(id, |n| n.trashed_at = None) {
        if let Ok(window) = open_note_window(app, &note) {
            let _ = window.set_focus();
        }
    }
    refresh_tray(app);
}

// ---------------------------------------------------------------------------
// Ícone na bandeja / barra de menus
// ---------------------------------------------------------------------------

const TRASH_PREFIX: &str = "restore:";
const THEME_PREFIX: &str = "theme:";

/// "hoje", "ontem" ou "há N dias".
fn age_label(trashed_at: u64) -> String {
    match now_ms().saturating_sub(trashed_at) / DAY_MS {
        0 => "hoje".into(),
        1 => "ontem".into(),
        n => format!("há {n} dias"),
    }
}

fn trash_item_label(note: &Note) -> String {
    const MAX: usize = 32;
    let name = note.display_name();
    let name = if name.chars().count() > MAX {
        format!(
            "{}…",
            name.chars().take(MAX - 1).collect::<String>().trim_end()
        )
    } else {
        name
    };
    let label = format!("{name} · {}", age_label(note.trashed_at.unwrap_or(0)));
    // No Windows, "&" no texto de um menu vira atalho de teclado.
    if cfg!(target_os = "windows") {
        label.replace('&', "&&")
    } else {
        label
    }
}

/// Menu da bandeja; a lixeira é montada a partir das notas atuais.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new_item = MenuItem::with_id(app, "new", "Nova nota", true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", "Mostrar todas as notas", true, None::<&str>)?;
    let help_item = MenuItem::with_id(app, "help", "Como usar a Taxinha", true, None::<&str>)?;

    let trashed = app.state::<Shared>().trashed();
    let mut trash_items = Vec::with_capacity(trashed.len() + 1);
    for note in &trashed {
        let id = format!("{TRASH_PREFIX}{}", note.id);
        trash_items.push(MenuItem::with_id(
            app,
            id,
            trash_item_label(note),
            true,
            None::<&str>,
        )?);
    }
    if trashed.is_empty() {
        trash_items.push(MenuItem::with_id(
            app,
            "trash-empty",
            "Lixeira vazia",
            false,
            None::<&str>,
        )?);
    }
    let trash_sep = PredefinedMenuItem::separator(app)?;
    let empty_item = MenuItem::with_id(
        app,
        "empty-trash",
        "Esvaziar lixeira",
        !trashed.is_empty(),
        None::<&str>,
    )?;
    let mut trash_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = trash_items
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    trash_refs.push(&trash_sep);
    trash_refs.push(&empty_item);
    let trash_menu = Submenu::with_items(app, "Lixeira", true, &trash_refs)?;

    let separator = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let current = app.state::<Shared>().theme();
    let theme_items = THEMES
        .iter()
        .map(|&t| {
            let label = match t {
                "light" => "Claro",
                "dark" => "Escuro",
                _ => "Sistema",
            };
            CheckMenuItem::with_id(
                app,
                format!("{THEME_PREFIX}{t}"),
                label,
                true,
                t == current,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<Vec<_>>>()?;
    let theme_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = theme_items
        .iter()
        .map(|i| i as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    let theme_menu = Submenu::with_items(app, "Tema", true, &theme_refs)?;

    let quit_item = MenuItem::with_id(app, "quit", "Sair da Taxinha", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &new_item,
            &show_item,
            &separator,
            &trash_menu,
            &theme_menu,
            &help_item,
            &separator2,
            &quit_item,
        ],
    )
}

/// Remonta o menu da bandeja (a lista da lixeira mudou). Menus só podem ser
/// alterados na thread principal (exigência do macOS).
fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("taxinha"), build_tray_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;

    // No macOS o ícone é "template" (monocromático, se adapta ao tema da barra).
    #[cfg(target_os = "macos")]
    let icon = tauri::include_image!("icons/tray-template.png");
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::include_image!("icons/tray.png");

    TrayIconBuilder::with_id("taxinha")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Taxinha")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new" => {
                let _ = create_and_open(app, None);
            }
            "show" => show_all(app),
            "help" => {
                let _ = open_welcome(app);
            }
            "quit" => {
                app.state::<Shared>().flush();
                app.exit(0);
            }
            "empty-trash" => {
                let store = app.state::<Shared>();
                store.empty_trash();
                store.flush();
                refresh_tray(app);
            }
            id => {
                if let Some(note_id) = id.strip_prefix(TRASH_PREFIX) {
                    restore_note(app, note_id);
                } else if let Some(theme) = id.strip_prefix(THEME_PREFIX) {
                    set_theme(app, theme);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_all(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------

fn main() {
    // No Wayland o compositor ignora "sempre no topo". Rodando via XWayland o
    // recurso de fixar funciona em GNOME, KDE e afins.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            && std::env::var_os("GDK_BACKEND").is_none()
        {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    let app = tauri::Builder::default()
        // Abrir o app de novo só traz as notas para frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_all(app)
        }))
        .invoke_handler(tauri::generate_handler![
            get_theme,
            load_note,
            save_text,
            set_pinned,
            set_color,
            set_collapsed,
            set_title,
            new_note,
            trash_note
        ])
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store: Shared = Arc::new(Store::load(dir.join("notes.json")));
            app.manage(store.clone());

            // Grava as mudanças pendentes e, de hora em hora, esvazia da
            // lixeira o que passou de 30 dias.
            let saver = store.clone();
            let saver_app = app.handle().clone();
            thread::spawn(move || {
                let ticks_per_purge = (PURGE_EVERY.as_millis() / SAVE_EVERY.as_millis()) as u32;
                let mut tick = 0u32;
                loop {
                    thread::sleep(SAVE_EVERY);
                    tick = (tick + 1) % ticks_per_purge;
                    if tick == 0 && saver.purge_trash(now_ms()) {
                        refresh_tray(&saver_app);
                    }
                    saver.flush();
                }
            });

            let handle = app.handle().clone();
            build_tray(&handle)?;

            let notes = store.active();
            if store.is_first_run() {
                open_welcome(&handle)?;
            } else if notes.is_empty() {
                create_and_open(&handle, None)?;
            } else {
                for note in &notes {
                    open_note_window(&handle, note)?;
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("não foi possível iniciar a Taxinha");

    app.run(|app, event| match event {
        // Fechar a última nota não encerra o app: ele continua na bandeja.
        RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => app.state::<Shared>().flush(),
        // Clique no ícone do Dock traz as notas para frente.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_all(app),
        _ => {}
    });
}
