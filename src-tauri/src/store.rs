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
    /// Nome para listas (bandeja): o título, ou a primeira linha do texto.
    pub fn display_name(&self) -> String {
        if !self.title.trim().is_empty() {
            return self.title.trim().to_string();
        }
        self.text
            .lines()
            .map(|l| strip_checkbox(l).trim())
            .find(|l| !l.is_empty())
            .unwrap_or("Nota vazia")
            .to_string()
    }

    pub fn is_blank(&self) -> bool {
        self.title.trim().is_empty() && self.text.trim().is_empty()
    }
}

/// Tira o marcador de checklist (`[ ]` / `[x]`) do começo de uma linha.
fn strip_checkbox(line: &str) -> &str {
    let rest = line.trim_start();
    for mark in ["[ ]", "[x]", "[X]"] {
        if let Some(after) = rest.strip_prefix(mark) {
            if after.is_empty() || after.starts_with(' ') {
                return after;
            }
        }
    }
    line
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
    /// Tema escolhido na bandeja (ver `THEMES`); vazio = "system".
    theme: String,
    notes: Vec<Note>,
}

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
                    eprintln!("taxinha: notes.json ilegível ({err}); cópia em {backup:?}");
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

    /// Notas na lixeira, da mais recente para a mais antiga.
    pub fn trashed(&self) -> Vec<Note> {
        let mut notes: Vec<Note> = {
            let data = self.data.lock().unwrap();
            data.notes
                .iter()
                .filter(|n| n.trashed_at.is_some())
                .cloned()
                .collect()
        };
        notes.sort_by_key(|n| std::cmp::Reverse(n.trashed_at));
        notes
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
            eprintln!("taxinha: falha ao salvar notas: {err}");
            self.mark_dirty();
        }
    }
}
