// Sem janela de console no Windows em builds de release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;
mod welcome;

use std::{sync::Arc, thread, time::Duration};

use store::{
    is_valid_color, now_ms, ManagerState, Note, Store, COLLAPSED_H, DEFAULT_H, DEFAULT_TEXT_MAX,
    DEFAULT_W, LANGUAGES, THEMES, TITLE_MAX,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    window::Color,
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, State,
    Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

type Shared = Arc<Store>;

/// Cor do fundo da nota no tema escuro (Carbon) e no claro — usada como fundo
/// nativo da janela para evitar um clarão enquanto a página carrega.
const CARBON: Color = Color(15, 16, 17, 255);
const PAPER: Color = Color(251, 251, 250, 255);
/// De quanto em quanto tempo a lixeira é verificada com o app aberto (1 h).
const PURGE_EVERY: Duration = Duration::from_secs(3600);
const SAVE_EVERY: Duration = Duration::from_millis(800);
/// Distância (lógica) de uma borda do monitor em que a nota gruda nela
/// durante o arraste.
const SNAP_DISTANCE: f64 = 16.0;
/// Espaço (lógico) entre duas notas grudadas, igual nos quatro lados; também
/// é o espaço entre uma nota nova e a nota que a criou.
const SNAP_GAP: f64 = 6.0;
/// Larguras mínimas (lógicas) de uma nota e do "Gerenciador".
const MIN_W: f64 = 180.0;
const MANAGER_MIN_W: f64 = 380.0;
/// Rótulo da janela "Gerenciador" (gerenciador de notas e lixeira).
const MANAGER: &str = "manager";

fn label_for(id: &str) -> String {
    format!("note-{id}")
}

fn id_of(window: &WebviewWindow) -> String {
    window.label().trim_start_matches("note-").to_string()
}

fn is_note(window: &WebviewWindow) -> bool {
    window.label().starts_with("note-")
}

/// Janelas de nota abertas (sem o gerenciador).
fn note_windows(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .filter(is_note)
        .collect()
}

/// Avisa as janelas (o gerenciador) que a lista de notas mudou.
fn notify(app: &AppHandle) {
    let _ = app.emit("notes-changed", ());
}

// ---------------------------------------------------------------------------
// Janelas
// ---------------------------------------------------------------------------

/// Abre a janela de uma nota (ou traz para frente, se já estiver aberta).
fn open_note_window(app: &AppHandle, note: &Note) -> tauri::Result<WebviewWindow> {
    let label = label_for(&note.id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
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
        .decorations(false)
        // Redimensiona pelas alças da página (resize_to), com ímã.
        .resizable(false)
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

/// Abre a janela "Gerenciador", onde se gerenciam as notas e a lixeira. Ela se
/// comporta como uma nota (sem moldura, barra própria, ímã, fixar, recolher),
/// mas sem título nem texto. Também é onde ficam o tema, a ajuda e o "Sair".
fn open_manager(app: &AppHandle) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(MANAGER) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let store = app.state::<Shared>();
    let state = store.manager();
    let height = if state.collapsed {
        COLLAPSED_H
    } else {
        state.height
    };
    let window = WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App("manager.html".into()))
        .title(manager_title(store.effective_language()))
        .inner_size(state.width, height)
        .decorations(false)
        // Redimensiona pelas alças da página (resize_to), com ímã.
        .resizable(false)
        .always_on_top(state.pinned)
        .background_color(CARBON)
        .visible(false)
        .build()?;
    match (state.x, state.y) {
        (Some(x), Some(y)) if is_on_screen(&window, x, y) => {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = window.center();
        }
    }
    apply_background(&window, &store.theme());
    track_geometry(app, &window);
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Título da janela "Gerenciador" (barra de tarefas) no idioma da interface.
fn manager_title(lang: &str) -> &'static str {
    if lang == "en" {
        "Manager — Taxinha"
    } else {
        "Gerenciador — Taxinha"
    }
}

/// Textos do menu da bandeja no idioma da interface.
fn tray_labels(lang: &str) -> [&'static str; 4] {
    if lang == "en" {
        ["New note", "Show all notes", "Manager", "Quit Taxinha"]
    } else {
        [
            "Nova nota",
            "Mostrar todas as notas",
            "Gerenciador",
            "Sair da Taxinha",
        ]
    }
}

/// Troca o idioma de todas as janelas (escolhido na Configuração).
fn set_language(app: &AppHandle, language: &str) {
    let store = app.state::<Shared>();
    store.set_language(language);
    store.flush();
    let lang = store.effective_language();
    if let Some(manager) = app.get_webview_window(MANAGER) {
        let _ = manager.set_title(manager_title(lang));
    }
    let _ = app.emit("language-changed", lang);
    refresh_tray(app);
}

/// Remonta o menu da bandeja (o idioma mudou). Menus só podem ser alterados
/// na thread principal (exigência do macOS).
fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let (Some(tray), Ok(menu)) = (handle.tray_by_id("taxinha"), build_tray_menu(&handle)) {
            let _ = tray.set_menu(Some(menu));
        }
    });
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

/// Troca o tema de todas as janelas (escolhido na janela "Gerenciador").
fn set_theme(app: &AppHandle, theme: &str) {
    let store = app.state::<Shared>();
    store.set_theme(theme);
    store.flush();
    for window in app.webview_windows().values() {
        apply_background(window, theme);
    }
    let _ = app.emit("theme-changed", theme);
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

/// Guarda posição e tamanho sempre que o usuário move ou redimensiona uma
/// janela (nota ou "Gerenciador").
fn track_geometry(app: &AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let win = window.clone();
    let id = id_of(window);
    let note = is_note(window);
    window.on_window_event(move |event| {
        let store = app.state::<Shared>();
        match event {
            WindowEvent::Moved(pos) => {
                // O Windows reporta -32000 ao minimizar; ignora.
                if pos.x <= -30_000 || pos.y <= -30_000 {
                    return;
                }
                let (x, y) = (Some(pos.x), Some(pos.y));
                if note {
                    store.update(&id, |n| (n.x, n.y) = (x, y));
                } else {
                    store.update_manager(|m| (m.x, m.y) = (x, y));
                }
            }
            WindowEvent::Resized(size) => {
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let scale = win.scale_factor().unwrap_or(1.0);
                let logical = size.to_logical::<f64>(scale);
                // Enquanto recolhida, a altura salva continua sendo a expandida.
                let keep = |collapsed: bool| !collapsed && logical.height > COLLAPSED_H + 8.0;
                if note {
                    store.update(&id, |n| {
                        n.width = logical.width;
                        if keep(n.collapsed) {
                            n.height = logical.height;
                        }
                    });
                } else {
                    store.update_manager(|m| {
                        m.width = logical.width;
                        if keep(m.collapsed) {
                            m.height = logical.height;
                        }
                    });
                }
            }
            WindowEvent::ThemeChanged(_) => apply_background(&win, &store.theme()),
            _ => {}
        }
    });
}

/// Abre a nota de boas-vindas (primeira execução ou "Como usar a Taxinha" na
/// janela "Gerenciador"). Se uma cópia intacta já estiver aberta, só traz ela para frente.
///
/// `pos` posiciona a nota quando ela é criada (ao lado do Gerenciador).
fn open_welcome(app: &AppHandle, pos: Option<(i32, i32)>) -> tauri::Result<()> {
    let store = app.state::<Shared>();
    let existing = store
        .active()
        .into_iter()
        .find(|n| welcome::is_untouched(&n.title, &n.html));
    let content = welcome::for_lang(store.effective_language());
    let note = match existing {
        Some(note) => note,
        None => {
            let note = store.create(pos);
            store
                .update(&note.id, |n| {
                    n.title = content.title.into();
                    n.text = content.text.into();
                    n.html = content.html.into();
                    n.width = welcome::WIDTH;
                    n.height = welcome::HEIGHT;
                })
                .unwrap_or(note)
        }
    };
    let window = open_note_window(app, &note)?;
    let _ = window.unminimize();
    let _ = window.set_focus();
    notify(app);
    Ok(())
}

/// Alvos do "ímã" para cada borda de uma janela com a área visível
/// `l`,`t`,`r`,`b` (esquerda, topo, direita, base, em pixels físicos):
/// - as bordas da área útil do monitor (sem a barra de tarefas) onde está o
///   centro da janela;
/// - as bordas das outras janelas visíveis (notas e "Gerenciador") que
///   estejam na mesma faixa: lado a lado, com `SNAP_GAP` entre elas, ou
///   alinhada com elas.
///
/// Tudo usa a área visível (`inner_*`): no Windows, a janela sem moldura tem
/// uma borda invisível nas laterais e embaixo, que deixaria vãos desiguais.
struct SnapTargets {
    left: Vec<i32>,
    right: Vec<i32>,
    top: Vec<i32>,
    bottom: Vec<i32>,
    /// Alcance do ímã, em pixels físicos.
    reach: i32,
    scale: f64,
}

impl SnapTargets {
    fn new(window: &WebviewWindow, l: i32, t: i32, r: i32, b: i32) -> Self {
        let (cx, cy) = ((l + r) / 2, (t + b) / 2);
        let monitor = window.available_monitors().ok().and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let a = m.work_area();
                cx >= a.position.x
                    && cx < a.position.x + a.size.width as i32
                    && cy >= a.position.y
                    && cy < a.position.y + a.size.height as i32
            })
        });
        let scale = match &monitor {
            Some(m) => m.scale_factor(),
            None => window.scale_factor().unwrap_or(1.0),
        };
        let reach = (SNAP_DISTANCE * scale).round() as i32;
        let gap = (SNAP_GAP * scale).round() as i32;
        let mut t_ = Self {
            left: Vec::new(),
            right: Vec::new(),
            top: Vec::new(),
            bottom: Vec::new(),
            reach,
            scale,
        };
        if let Some(m) = &monitor {
            let a = m.work_area();
            t_.left.push(a.position.x);
            t_.right.push(a.position.x + a.size.width as i32);
            t_.top.push(a.position.y);
            t_.bottom.push(a.position.y + a.size.height as i32);
        }
        for other in window.app_handle().webview_windows().into_values() {
            if other.label() == window.label() || !other.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(p), Ok(s)) = (other.inner_position(), other.inner_size()) else {
                continue;
            };
            let (ol, ot) = (p.x, p.y);
            let (or, ob) = (ol + s.width as i32, ot + s.height as i32);
            // Só gruda numa janela que esteja na mesma faixa (com folga do alcance).
            if t < ob + reach && b > ot - reach {
                t_.left.extend([or + gap, ol]);
                t_.right.extend([ol - gap, or]);
            }
            if l < or + reach && r > ol - reach {
                t_.top.extend([ob + gap, ot]);
                t_.bottom.extend([ot - gap, ob]);
            }
        }
        t_
    }

    /// O alvo mais próximo de `v` dentro do alcance, ou o próprio `v`.
    fn pick(&self, v: i32, targets: &[i32]) -> i32 {
        targets
            .iter()
            .copied()
            .filter(|t| (t - v).abs() <= self.reach)
            .min_by_key(|t| (t - v).abs())
            .unwrap_or(v)
    }
}

/// Posição com "ímã" para a janela (canto visível `x`,`y`, tamanho `w`×`h`)
/// sendo arrastada: em cada eixo, a borda (de qualquer lado) que estiver mais
/// perto de um alvo puxa a janela.
fn snapped(window: &WebviewWindow, x: i32, y: i32, w: i32, h: i32) -> (i32, i32) {
    let t = SnapTargets::new(window, x, y, x + w, y + h);
    let xs: Vec<i32> = t
        .left
        .iter()
        .copied()
        .chain(t.right.iter().map(|r| r - w))
        .collect();
    let ys: Vec<i32> = t
        .top
        .iter()
        .copied()
        .chain(t.bottom.iter().map(|b| b - h))
        .collect();
    (t.pick(x, &xs), t.pick(y, &ys))
}

/// Diferença entre o canto visível e o canto da janela (borda invisível).
fn frame_offset(window: &WebviewWindow) -> Option<(i32, i32)> {
    let outer = window.outer_position().ok()?;
    let inner = window.inner_position().ok()?;
    Some((inner.x - outer.x, inner.y - outer.y))
}

/// Arraste feito pela página: move a janela para (`x`, `y`) físicos, já com o
/// ímã das bordas do monitor e das outras janelas. O arraste nativo
/// (`startDragging`) não permite isso, porque o sistema controla a janela até
/// o botão ser solto.
#[tauri::command]
fn drag_to(window: WebviewWindow, x: i32, y: i32) {
    let (Some((dx, dy)), Ok(size)) = (frame_offset(&window), window.inner_size()) else {
        return;
    };
    // `x`,`y` são do canto da janela; o ímã trabalha com a área visível.
    let (vx, vy) = snapped(
        &window,
        x + dx,
        y + dy,
        size.width as i32,
        size.height as i32,
    );
    let _ = window.set_position(PhysicalPosition::new(vx - dx, vy - dy));
}

/// Redimensionamento feito pela página (alças nas bordas e cantos): a área
/// visível pedida (`x`,`y`,`w`,`h` físicos) tem as bordas que se mexem
/// (`edges`: "n", "s", "e", "w" ou combinações) puxadas pelo mesmo ímã do
/// arraste. O redimensionamento nativo fica desligado (`resizable(false)`):
/// o sistema não deixaria ajustar o tamanho no meio do movimento.
#[tauri::command]
fn resize_to(window: WebviewWindow, x: i32, y: i32, w: i32, h: i32, edges: String) {
    let Some((dx, dy)) = frame_offset(&window) else {
        return;
    };
    let (mut l, mut t, mut r, mut b) = (x, y, x + w, y + h);
    let targets = SnapTargets::new(&window, l, t, r, b);
    if edges.contains('w') {
        l = targets.pick(l, &targets.left);
    }
    if edges.contains('e') {
        r = targets.pick(r, &targets.right);
    }
    if edges.contains('n') {
        t = targets.pick(t, &targets.top);
    }
    if edges.contains('s') {
        b = targets.pick(b, &targets.bottom);
    }

    // Tamanho mínimo (o mesmo de quando a janela era redimensionável).
    let min_w = if is_note(&window) {
        MIN_W
    } else {
        MANAGER_MIN_W
    };
    let min_w = (min_w * targets.scale).round() as i32;
    let min_h = (COLLAPSED_H * targets.scale).round() as i32;
    if r - l < min_w {
        if edges.contains('w') {
            l = r - min_w;
        } else {
            r = l + min_w;
        }
    }
    if b - t < min_h {
        if edges.contains('n') {
            t = b - min_h;
        } else {
            b = t + min_h;
        }
    }

    if edges.contains('w') || edges.contains('n') {
        let _ = window.set_position(PhysicalPosition::new(l - dx, t - dy));
    }
    let _ = window.set_size(PhysicalSize::new((r - l) as u32, (b - t) as u32));
}

fn create_and_open(app: &AppHandle, pos: Option<(i32, i32)>) -> tauri::Result<()> {
    let note = app.state::<Shared>().create(pos);
    let window = open_note_window(app, &note)?;
    let _ = window.set_focus();
    notify(app);
    Ok(())
}

fn show_all(app: &AppHandle) {
    let windows = note_windows(app);
    if windows.is_empty() {
        let _ = create_and_open(app, None);
        return;
    }
    for window in windows {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Manda uma nota para a lixeira (fechando a janela, se aberta). Uma nota que
/// ninguém mexeu (vazia, ou só com o título e o texto padrão) é apagada de
/// vez, para não lotar a lixeira.
fn trash(app: &AppHandle, id: &str) {
    let store = app.state::<Shared>();
    match store.get(id) {
        Some(note) if store.is_pristine(&note) => store.remove(id),
        Some(_) => {
            store.update(id, |n| n.trashed_at = Some(now_ms()));
        }
        None => {}
    }
    store.flush();
    if let Some(window) = app.get_webview_window(&label_for(id)) {
        let _ = window.destroy();
    }
    notify(app);
}

// ---------------------------------------------------------------------------
// Comandos chamados pelas notas
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
fn set_title(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
    store: State<'_, Shared>,
) -> String {
    let title: String = title.trim().chars().take(TITLE_MAX).collect();
    store.update(&id_of(&window), |n| n.title = title.clone());
    notify(&app);
    title
}

#[tauri::command]
fn save_text(
    app: AppHandle,
    window: WebviewWindow,
    text: String,
    html: String,
    store: State<'_, Shared>,
) {
    let mut changed = false;
    store.update(&id_of(&window), |n| {
        if n.text != text || n.html != html {
            n.text = text;
            n.html = html;
            n.updated_at = now_ms();
            changed = true;
        }
    });
    if changed {
        notify(&app);
    }
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
    if is_note(&window) {
        store.update(&id_of(&window), |n| n.pinned = pinned);
    } else {
        store.update_manager(|m| m.pinned = pinned);
    }
    Ok(pinned)
}

#[tauri::command]
fn set_color(
    app: AppHandle,
    window: WebviewWindow,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("cor desconhecida: {color}"));
    }
    store.update(&id_of(&window), |n| n.color = color);
    notify(&app);
    Ok(())
}

/// Recolhe a nota (ou a janela "Gerenciador") até ficar só a barra de título.
#[tauri::command]
fn set_collapsed(
    window: WebviewWindow,
    collapsed: bool,
    store: State<'_, Shared>,
) -> Result<(), String> {
    let (width, expanded) = if is_note(&window) {
        let note = store
            .update(&id_of(&window), |n| n.collapsed = collapsed)
            .ok_or("nota não encontrada")?;
        (note.width, note.height)
    } else {
        let state = store.update_manager(|m| m.collapsed = collapsed);
        (state.width, state.height)
    };
    let height = if collapsed { COLLAPSED_H } else { expanded };
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

// Criar e destruir janelas a partir de comandos síncronos pode travar no
// Windows, por isso os comandos que fazem isso são assíncronos.
#[tauri::command]
async fn new_note(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    create_and_open(&app, beside(&window)).map_err(|e| e.to_string())
}

/// Posição (física) para uma nota nova ao lado da nota `parent`, sem
/// sobrepor: à direita se couber na área útil do monitor, senão à esquerda.
/// Sobrepor faria a nota nova sumir atrás de uma nota fixada. Sem espaço
/// dos dois lados, encosta na borda do lado com mais espaço. Se o lugar já
/// estiver ocupado por outra nota (vários "+" seguidos), desce em degraus.
///
/// Como no ímã do arraste, as contas usam a área visível (`inner_*`), para o
/// espaço entre as notas ser o `SNAP_GAP` de verdade, sem a borda invisível
/// do Windows. A nota nova tem as mesmas bordas da nota pai.
fn beside(parent: &WebviewWindow) -> Option<(i32, i32)> {
    let outer = parent.outer_position().ok()?;
    let pos = parent.inner_position().ok()?;
    let size = parent.inner_size().ok()?;
    let (dx, dy) = (pos.x - outer.x, pos.y - outer.y);
    let monitor = parent.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (left_edge, top_edge) = (area.position.x, area.position.y);
    let right_edge = left_edge + area.size.width as i32;
    let bottom_edge = top_edge + area.size.height as i32;

    let w = (DEFAULT_W * scale).round() as i32;
    let h = (DEFAULT_H * scale).round() as i32;
    let gap = (SNAP_GAP * scale).round() as i32;
    let parent_right = pos.x + size.width as i32;

    // Canto visível da nota nova.
    let vx = if parent_right + gap + w <= right_edge {
        parent_right + gap
    } else if pos.x - gap - w >= left_edge {
        pos.x - gap - w
    } else if right_edge - parent_right >= pos.x - left_edge {
        right_edge - w
    } else {
        left_edge
    };
    let vx = vx.max(left_edge);
    let vy = pos.y.clamp(top_edge, (bottom_edge - h).max(top_edge));

    // Canto da janela (com as bordas invisíveis), que é o que se posiciona.
    let x = vx - dx;
    let max_y = (bottom_edge - h).max(top_edge) - dy;
    let mut y = vy - dy;

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

/// Fecha a nota (botão ✕ ou clique do meio) mandando-a para a lixeira.
#[tauri::command]
async fn trash_note(app: AppHandle, window: WebviewWindow) {
    trash(&app, &id_of(&window));
}

// ---------------------------------------------------------------------------
// Comandos do gerenciador ("Gerenciador")
// ---------------------------------------------------------------------------

/// Estado da janela "Gerenciador" (fixada, recolhida) ao abrir.
#[tauri::command]
fn load_manager(store: State<'_, Shared>) -> ManagerState {
    store.manager()
}

/// Fecha a janela "Gerenciador" (✕ ou clique do meio na barra).
#[tauri::command]
async fn close_manager(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Todas as notas, ativas e na lixeira, sem o HTML (o gerenciador só mostra
/// título, prévia do texto, cor e datas).
#[tauri::command]
fn list_notes(store: State<'_, Shared>) -> Vec<Note> {
    store
        .all()
        .into_iter()
        .map(|mut n| {
            n.html = String::new();
            n
        })
        .collect()
}

/// Abre uma nota ativa (ou traz para frente, se já estiver aberta).
#[tauri::command]
async fn open_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .get(&id)
        .filter(|n| n.trashed_at.is_none())
        .ok_or("nota não encontrada")?;
    open_note_window(&app, &note).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn move_to_trash(app: AppHandle, id: String) {
    trash(&app, &id);
}

/// Tira a nota da lixeira e abre a janela dela.
#[tauri::command]
async fn restore_note(app: AppHandle, id: String) -> Result<(), String> {
    let note = app
        .state::<Shared>()
        .update(&id, |n| n.trashed_at = None)
        .ok_or("nota não encontrada")?;
    open_note_window(&app, &note).map_err(|e| e.to_string())?;
    notify(&app);
    Ok(())
}

/// Exclui de vez uma nota da lixeira.
#[tauri::command]
fn delete_forever(app: AppHandle, id: String, store: State<'_, Shared>) {
    if store.get(&id).is_some_and(|n| n.trashed_at.is_some()) {
        store.remove(&id);
        store.flush();
        notify(&app);
    }
}

#[tauri::command]
fn empty_trash(app: AppHandle, store: State<'_, Shared>) {
    store.empty_trash();
    store.flush();
    notify(&app);
}

/// Troca o tema de todas as janelas (escolhido na janela "Gerenciador").
/// Idioma escolhido e o efetivo ("pt" ou "en"), para as páginas.
#[tauri::command]
fn get_language(store: State<'_, Shared>) -> (String, &'static str) {
    (store.language(), store.effective_language())
}

/// Troca o idioma da interface (escolhido no "Gerenciador").
#[tauri::command]
fn change_language(app: AppHandle, language: String) -> Result<(), String> {
    if !LANGUAGES.contains(&language.as_str()) {
        return Err(format!("idioma desconhecido: {language}"));
    }
    set_language(&app, &language);
    Ok(())
}

#[tauri::command]
fn change_theme(app: AppHandle, theme: String) -> Result<(), String> {
    if !THEMES.contains(&theme.as_str()) {
        return Err(format!("tema desconhecido: {theme}"));
    }
    set_theme(&app, &theme);
    Ok(())
}

/// Reabre a nota de boas-vindas ("Como usar a Taxinha").
#[tauri::command]
async fn show_welcome(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    open_welcome(&app, beside(&window)).map_err(|e| e.to_string())
}

/// Encerra o app (o único jeito de sair: fechar as notas não encerra).
#[tauri::command]
fn quit_app(app: AppHandle, store: State<'_, Shared>) {
    store.flush();
    app.exit(0);
}

#[tauri::command]
fn get_default_color(store: State<'_, Shared>) -> String {
    store.default_color()
}

/// Título e texto padrão das notas novas, para o gerenciador.
#[tauri::command]
fn get_new_note_defaults(store: State<'_, Shared>) -> (String, String) {
    store.new_note_defaults()
}

#[tauri::command]
fn set_new_note_defaults(title: String, text: String, store: State<'_, Shared>) {
    let title: String = title.trim().chars().take(TITLE_MAX).collect();
    let text: String = text.chars().take(DEFAULT_TEXT_MAX).collect();
    store.set_new_note_defaults(title, text);
}

#[tauri::command]
fn set_default_color(
    app: AppHandle,
    color: String,
    store: State<'_, Shared>,
) -> Result<(), String> {
    if !is_valid_color(&color) {
        return Err(format!("cor desconhecida: {color}"));
    }
    store.set_default_color(&color);
    notify(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// Ícone na bandeja / barra de menus
// ---------------------------------------------------------------------------

/// Menu da bandeja: atalhos e "Sair". Tema e ajuda ficam no "Gerenciador".
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let [new_label, show_label, manager_label, quit_label] =
        tray_labels(app.state::<Shared>().effective_language());
    let new_item = MenuItem::with_id(app, "new", new_label, true, None::<&str>)?;
    let show_item = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let manager_item = MenuItem::with_id(app, "manager", manager_label, true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &new_item,
            &show_item,
            &separator,
            &manager_item,
            &separator2,
            &quit_item,
        ],
    )
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
            "manager" => {
                let _ = open_manager(app);
            }
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
        // Abrir o app de novo traz as notas para frente e abre o Gerenciador.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_all(app);
            let _ = open_manager(app);
        }))
        .invoke_handler(tauri::generate_handler![
            get_theme,
            drag_to,
            resize_to,
            load_note,
            save_text,
            set_pinned,
            set_color,
            set_collapsed,
            set_title,
            new_note,
            trash_note,
            load_manager,
            close_manager,
            list_notes,
            open_note,
            move_to_trash,
            restore_note,
            delete_forever,
            empty_trash,
            change_theme,
            get_language,
            change_language,
            show_welcome,
            quit_app,
            get_default_color,
            set_default_color,
            get_new_note_defaults,
            set_new_note_defaults
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
                        notify(&saver_app);
                    }
                    saver.flush();
                }
            });

            let handle = app.handle().clone();
            build_tray(&handle)?;

            // O Gerenciador abre em toda inicialização; na primeira, a nota de
            // boas-vindas abre ao lado dele.
            open_manager(&handle)?;
            let notes = store.active();
            if store.is_first_run() {
                let pos = handle.get_webview_window(MANAGER).and_then(|m| beside(&m));
                open_welcome(&handle, pos)?;
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
        // Clique no ícone do Dock traz as notas para frente e abre o Gerenciador.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            show_all(app);
            let _ = open_manager(app);
        }
        _ => {}
    });
}
