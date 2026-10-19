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

## Content vs layout (groundwork for cloud sync)

`Note::content` (title, text, html, colour, group, `trashedAt`) and `Group::content` (name, colour, `trashedAt`) are what a note or group *is* and would be the same on every device; everything else (position, size, pin, `hidden`, a group's `open`) is this computer's layout. `Store::update` / `update_group` bump `updatedAt` only when the content changes (layout-only changes never do), so `updatedAt` is the "last real edit" that merges compare (`import_from`, and later sync); old files get `updatedAt = createdAt` in `normalize`. Changing a new-note/new-group default sets `FileData.defaults_updated_at`. Every permanent removal (`remove`, `empty_trash`, `remove_group`, the trash purge) leaves a `Tombstone { id, deletedAt }` in `FileData.deleted` (`bury`), pruned after `TOMBSTONE_TTL_MS` (90 days), so a future sync can tell "deleted here" from "new there"; an import that brings an id back drops its tombstone, and exports leave tombstones out. Keep new content fields inside `content()` and route mutations through `update`/`update_group`.

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

## Cloud sync

`cloud.rs` signs in with Google (desktop OAuth: system browser via `tauri-plugin-opener`, one-shot loopback server on `127.0.0.1:<random>`, PKCE, `access_type=offline` + `prompt=consent`); scope `drive.appdata` + `openid email`. The refresh token lives in the OS credential store (`keyring`, service `Memo`, user `google-drive`), never in a file; `access_token()` refreshes and caches it (`ERR_REAUTH` when Google refuses: revoked, or the 7-day expiry of "Testing" apps). The account e-mail is `Config.google_account` in `config.json` (per machine). Disconnecting only deletes the local token (revoking would drop the grant on the user's other computers) and clears `FileData.sync`. The OAuth client is compiled in from `MEMO_GOOGLE_CLIENT_ID` / `MEMO_GOOGLE_CLIENT_SECRET` (`option_env!`); without it `cloud::available()` is false and the manager hides the section. TLS is rustls with the `ring` provider (installed in `main()`). Setup: `docs/google-cloud.md`.

`sync.rs` is the engine. Drive format (types in store.rs): one file per note `note-<id>.json` (`NoteDoc`) and group `group-<id>.json` (`GroupDoc`), plus `settings.json` (`SettingsDoc`: new-note/new-group defaults, `defaults_updated_at`), in `appDataFolder`; deletions keep the file as a tombstone (`deleted: true, deletedAt`). Each file's `appProperties.stamp` = `updatedAt` / `deletedAt`. `FileData.sync` (`SyncState`): account, changes page token, per file name `{fileId, synced}` (last stamp sent/received), `deferred` notes, `lastSync`. A run: pull (`changes.list`, or full list + start token the first time), apply groups then notes (`Store::apply_note_doc` / `apply_group_doc` write content *with* the cloud's stamps, so nothing echoes back; new or restored notes and new groups arrive `hidden`), then push everything whose stamp > synced (never-sent pristine/welcome notes and never-sent tombstones are skipped). Conflicts: newer wins, the loser becomes a trashed copy titled "… (conflito/conflict)" (`add_conflict_copy`); an edit beats a deletion; a cloud change to a focused note is deferred. Window effects go through the `Ui` trait (reload/close note, close group bar, events). Schedule: on start/connect, `SETTLE_MS` after local changes, on window focus (≥ 30 s since last), every 5 min, "Sync now" (`sync_cloud`); a minute's backoff after a failure; `ERR_REAUTH` stops the loop until reconnect. Status for the manager: `sync::status()` (syncing, lastSync, pending, error) via `get_cloud_account` + `cloud-changed`. The test in sync.rs runs two stores against a fake Drive: keep it passing.
