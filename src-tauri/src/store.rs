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
pub const COLORS: [&str; 6] = ["", "green", "coral", "teal", "iris", "lavender"];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Note {
    pub id: String,
    pub seq: u32,
    pub text: String,
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
}

impl Default for Note {
    fn default() -> Self {
        Self {
            id: String::new(),
            seq: 0,
            text: String::new(),
            x: None,
            y: None,
            width: DEFAULT_W,
            height: DEFAULT_H,
            pinned: false,
            color: String::new(),
            collapsed: false,
            created_at: 0,
            updated_at: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileData {
    version: u32,
    next_seq: u32,
    notes: Vec<Note>,
}

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

        Self {
            path,
            data: Mutex::new(data),
            dirty: AtomicBool::new(false),
        }
    }

    pub fn notes(&self) -> Vec<Note> {
        self.data.lock().unwrap().notes.clone()
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
