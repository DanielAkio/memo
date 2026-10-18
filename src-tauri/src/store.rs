//! Persistência das notas: um único `notes.json` na pasta de dados do app.
//!
//! As mudanças ficam em memória e uma thread grava no disco quando há algo
//! pendente, assim arrastar ou redimensionar uma nota não escreve no disco a
//! cada pixel. A gravação é atômica (arquivo temporário + rename).

use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_W: f64 = 300.0;
pub const DEFAULT_H: f64 = 320.0;
pub const COLLAPSED_H: f64 = 36.0;

/// Etiquetas de cor aceitas (vazio = sem cor).
pub const COLORS: [&str; 8] = [
    "", "yellow", "green", "coral", "teal", "iris", "lavender", "mono",
];

/// Uma cor é válida se for uma das etiquetas acima ou uma cor personalizada
/// no formato `#rrggbb`.
pub fn is_valid_color(color: &str) -> bool {
    COLORS.contains(&color)
        || (color.len() == 7
            && color.starts_with('#')
            && color[1..].chars().all(|c| c.is_ascii_hexdigit()))
}

/// Cor com que toda nota nova nasce.
pub const DEFAULT_COLOR: &str = "yellow";

/// Tempo que uma nota fica na lixeira antes de ser apagada de vez (30 dias).
pub const TRASH_TTL_MS: u64 = 30 * 86_400_000;

/// Tamanho máximo do texto padrão das notas novas, em caracteres.
pub const DEFAULT_TEXT_MAX: usize = 5000;

/// Tamanho máximo do nome de uma nota, em caracteres.
pub const TITLE_MAX: usize = 80;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub seq: u32,
    /// Nome dado pelo usuário (vazio = sem nome).
    pub title: String,
    /// Texto puro (itens de checklist como "[ ] " / "[x] "): usado na
    /// bandeja, na contagem de palavras e para reconstruir notas antigas.
    pub text: String,
    /// Conteúdo formatado (negrito, itálico, sublinhado, checklist) gerado
    /// pelo editor. Vazio em notas anteriores à formatação.
    pub html: String,
    /// Posição física (pixels de tela) do canto superior esquerdo.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Tamanho lógico; `height` é sempre a altura expandida.
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    pub color: String,
    pub collapsed: bool,
    pub created_at: u64,
    pub updated_at: u64,
    /// Quando foi para a lixeira; `None` = nota ativa.
    pub trashed_at: Option<u64>,
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
            collapsed: false,
            created_at: 0,
            updated_at: 0,
            trashed_at: None,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileData {
    version: u32,
    next_seq: u32,
    /// Tema escolhido na janela "Gerenciador" (ver `THEMES`); vazio = "system".
    theme: String,
    /// Idioma escolhido na Configuração (ver `LANGUAGES`); vazio = "system".
    language: String,
    /// Posição, tamanho e estado da janela "Gerenciador".
    manager: ManagerState,
    /// Cor das notas novas, escolhida no gerenciador; `None` = `DEFAULT_COLOR`.
    default_color: Option<String>,
    /// Título e texto (puro, com "[ ] " para checklist) das notas novas,
    /// definidos no gerenciador. Vazios = nota em branco.
    default_title: String,
    default_text: String,
    /// O mesmo texto padrão com a formatação (HTML do editor da nota).
    default_html: String,
    notes: Vec<Note>,
}

/// Estado da janela "Gerenciador" (o gerenciador), guardado como o de uma nota.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct ManagerState {
    /// Posição física do canto superior esquerdo; `None` = centralizada.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Tamanho lógico; `height` é sempre a altura expandida.
    pub width: f64,
    pub height: f64,
    pub pinned: bool,
    pub collapsed: bool,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: 560.0,
            height: 640.0,
            pinned: false,
            collapsed: false,
        }
    }
}

/// Idiomas aceitos: seguir o sistema operacional, português ou inglês.
pub const LANGUAGES: [&str; 3] = ["system", "pt-BR", "en"];

/// Temas aceitos: seguir o sistema operacional, claro ou escuro.
pub const THEMES: [&str; 3] = ["system", "light", "dark"];

pub struct Store {
    path: PathBuf,
    data: Mutex<FileData>,
    dirty: AtomicBool,
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
        let mut data = match fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<FileData>(&raw) {
                Ok(data) => data,
                Err(err) => {
                    // Nunca sobrescreve um arquivo ilegível: guarda uma cópia antes.
                    let backup = path.with_extension(format!("corrompido-{}.json", now_ms()));
                    let _ = fs::copy(&path, &backup);
                    eprintln!("memo: notes.json ilegível ({err}); cópia em {backup:?}");
                    FileData::default()
                }
            },
            Err(_) => FileData::default(),
        };

        // Garante ids únicos e numeração contínua mesmo com arquivos editados à mão.
        data.notes.retain(|n| !n.id.is_empty());
        let max_seq = data.notes.iter().map(|n| n.seq).max().unwrap_or(0);
        data.next_seq = data.next_seq.max(max_seq + 1).max(1);

        let store = Self {
            path,
            data: Mutex::new(data),
            dirty: AtomicBool::new(false),
        };
        store.purge_trash(now_ms());
        store
    }

    /// Notas fora da lixeira.
    pub fn active(&self) -> Vec<Note> {
        let data = self.data.lock().unwrap();
        data.notes
            .iter()
            .filter(|n| n.trashed_at.is_none())
            .cloned()
            .collect()
    }

    /// Apaga de vez as notas que estão na lixeira há mais de 30 dias.
    /// Devolve `true` se alguma foi removida.
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

    /// Idioma escolhido ("system", "pt-BR" ou "en").
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

    /// Idioma efetivo da interface: "pt" ou "en". "system" usa o idioma do
    /// sistema operacional (português se for pt-*, inglês nos demais casos).
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

    /// Cor com que as notas novas nascem.
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

    /// Título, texto e HTML com que as notas novas nascem.
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

    /// A nota está como nasceu: sem nada além do título e do texto padrão.
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

    /// Aplica `f` ao estado da janela "Gerenciador" e devolve uma cópia.
    pub fn update_manager<F: FnOnce(&mut ManagerState)>(&self, f: F) -> ManagerState {
        let state = {
            let mut data = self.data.lock().unwrap();
            f(&mut data.manager);
            data.manager.clone()
        };
        self.mark_dirty();
        state
    }

    /// Todas as notas, ativas e na lixeira (para o gerenciador).
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

    /// Nenhuma nota foi criada até hoje (primeira execução do app).
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

    /// Aplica `f` à nota e devolve uma cópia atualizada.
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

    /// Grava no disco se houver mudanças pendentes.
    pub fn flush(&self) {
        if !self.dirty.swap(false, Ordering::SeqCst) {
            return;
        }
        let json = {
            let mut data = self.data.lock().unwrap();
            data.version = 1;
            serde_json::to_string_pretty(&*data)
        };
        let result = json.map_err(io::Error::other).and_then(|json| {
            let tmp = self.path.with_extension("json.tmp");
            fs::write(&tmp, json)?;
            fs::rename(&tmp, &self.path)
        });
        if let Err(err) = result {
            eprintln!("memo: falha ao salvar notas: {err}");
            self.mark_dirty();
        }
    }
}
