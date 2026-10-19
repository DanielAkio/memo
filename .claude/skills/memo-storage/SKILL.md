---
name: memo-storage
description: Memo's persistence layer. Use when changing store.rs, the Note/Group/FileData model, notes.json or config.json, the data folder (choose/reset/migrate), backup export/import, or trash purging.
---

# Storage (`store.rs` + "Data folder" in `main.rs`)

## Store

`Store` holds all data in a `Mutex<FileData>` and sets a `dirty` flag on change (`mark_dirty`). A background saver thread calls `flush()` every 800 ms (`SAVE_EVERY`); it writes atomically (`notes.json.tmp` → rename). `flush()` is also called explicitly on delete, quit and `RunEvent::Exit`. An unreadable `notes.json` is backed up as `notes.corrupted-<ms>.json` before starting fresh — never overwrite user data.

`Store.path` is a `Mutex` too and is **always locked before `data`**.

## Model

`Note`, `Group`, `ManagerState`, `FileData` use `#[serde(rename_all = "camelCase", default)]`: a new field needs a `Default` and shows up camelCase in JS (`updatedAt`, `createdAt`, `trashedAt`). File format `version: 1`. `FileData` also carries app settings: `theme`, `language`, `zoom`, `default_color`, `default_title`, `default_text`, `default_html`, `default_group_color`, `default_group_title`, `manager`, `next_seq`.

Selectors: `Store::active` (not trashed), `Store::visible()` (active, not `hidden`, not in a hidden or put-away group — what startup opens), `active_groups()` (what windows, pickers and export use). `normalize` clears links to missing groups. `is_first_run()` = no notes and `next_seq <= 1`. `is_pristine` = note still equal to the new-note defaults (or blank).

Notes and groups trashed longer than `TRASH_TTL_MS` (30 days) are purged on load and hourly by the saver thread (`PURGE_EVERY`). Permanent deletion happens only from the trash or this purge.

## Data folder

- Default folder: `<OS data folder>/memo` (`default_data_dir`, `DATA_FOLDER`) — **not** `app_data_dir()` (named after the identifier `br.memo.notas`); never use `app_data_dir()` for notes or config.
- History: it used to be the identifier's folder, and before that the app was *Taxinha* (`br.taxinha.notas`). On startup `migrate_old_data` copies `notes.json` and `config.json` from the newest of `OLD_DATA_FOLDERS` into `memo` when neither exists there yet; old folders stay as backups. WebView storage would still move if the identifier changed.
- A custom folder (manager → Configurações → Armazenamento) is stored in `config.json` (`store::Config { dataDir }`), which always stays in the default folder (`CONFIG`). `data_dir` resolves it at startup and falls back to the default for the session if the custom folder can't be created.
- `Store::relocate(path, load_existing)` flushes to the old file, then loads the destination's `notes.json` or writes the current notes there (backing up an existing file as `notes.backup-<ms>.json`). The old file is never deleted.
- `choose_data_dir` (native picker via `tauri-plugin-dialog`, called from Rust so no JS permission) and `reset_data_dir` both go through `move_data_dir`, which asks with a native 3-button dialog (open those / replace with current / cancel) when the destination has notes, and shows a native error dialog on failure. Dialog texts: `storage_text` (pt/en).
- After loading another file, `reload_windows` recreates note windows, re-applies theme/tray/title and emits `store-replaced` (the manager reloads its page).

## Backup

- `export_notes(fileName)` → `Store::export_to`: same format as `notes.json`, trashed notes left out; the page suggests `memo-YYYY-MM-DD.json`.
- `import_notes` → `Store::import_from`: unknown ids are added, known ones replaced only if the imported `updatedAt` is newer, settings ignored; then the changed notes' windows are opened/reloaded and the count is shown in `#storageStatus`.
