// Sem janela de console no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;

use std::{sync::Arc, thread, time::Duration};

use store::{now_ms, Note, Store, COLLAPSED_H, COLORS};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, LogicalSize, Manager, PhysicalPosition, RunEvent, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

type Shared = Arc<Store>;

/// Cor do fundo da nota (Carbon) — evita o clarão branco enquanto a página carrega.
const CARBON: Color = Color(15, 16, 17, 255);
/// Deslocamento de uma nota nova em relação à nota que a criou.
const CASCADE: i32 = 32;

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
        .skip_taskbar(true)
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

    track_geometry(app, &window);
    window.show()?;
    Ok(window)
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
            _ => {}
        }
    });
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
fn load_note(window: WebviewWindow, store: State<'_, Shared>) -> Option<Note> {
    store.get(&id_of(&window))
}

#[tauri::command]
fn save_text(window: WebviewWindow, text: String, store: State<'_, Shared>) {
    store.update(&id_of(&window), |n| {
        if n.text != text {
            n.text = text;
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
    if !COLORS.contains(&color.as_str()) {
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
    let origin = window
        .outer_position()
        .ok()
        .map(|p| (p.x + CASCADE, p.y + CASCADE));
    create_and_open(&app, origin).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_note(window: WebviewWindow, store: State<'_, Shared>) -> Result<(), String> {
    store.remove(&id_of(&window));
    store.flush();
    window.destroy().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Ícone na bandeja / barra de menus
// ---------------------------------------------------------------------------

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let new_item = MenuItem::with_id(app, "new", "Nova nota", true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", "Mostrar todas as notas", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Sair da Taxinha", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_item, &show_item, &separator, &quit_item])?;

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
            "quit" => {
                app.state::<Shared>().flush();
                app.exit(0);
            }
            _ => {}
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
            load_note,
            save_text,
            set_pinned,
            set_color,
            set_collapsed,
            new_note,
            delete_note
        ])
        .setup(|app| {
            // No macOS a Taxinha vive na barra de menus, sem ícone no Dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store: Shared = Arc::new(Store::load(dir.join("notes.json")));
            app.manage(store.clone());

            let saver = store.clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(800));
                saver.flush();
            });

            build_tray(app)?;

            let handle = app.handle().clone();
            let notes = store.notes();
            if notes.is_empty() {
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
        _ => {}
    });
}
