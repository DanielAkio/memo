# CLAUDE.md

Memo is a cross-platform (Windows/macOS/Linux) sticky-notes desktop app built on **Tauri 2**. Each note is its own frameless window; the headline feature is the pin button ("always on top"). Code, comments, docs, config labels and commit messages are in **English**; only the UI is bilingual — Portuguese (default) and English, and every new user-facing string needs both (`i18n.js`; Rust strings in `tray_labels` / `welcome.rs`). In the UI a note is a **memória** (en: *memory*); internal names stay `note` (`notes.json`, `note-*` labels, commands).

This file holds only what every task needs. Subsystem detail lives in skills under `.claude/skills/` and is loaded on demand — **load the matching skill before changing that area**:

| Skill | Load it for |
| --- | --- |
| `memo-code-map` | finding code cheaply: section maps of the big files, grep recipes, what never to read |
| `memo-checks` | building/checking, cross-platform verification (Linux in Docker, macOS crate), CI |
| `memo-storage` | `Store`, `notes.json`/`config.json`, data folder, migration, backup/import, trash purge, note model |
| `memo-windows` | geometry, drag/magnet/Snap, resize, `beside`, close vs trash, startup, tray, lifecycle |
| `memo-groups` | group bars, joining/leaving, take out / put away, group trash |
| `memo-editor` | the note editor: HTML format, checklists, code blocks + Prism, undo, format bar, embedded editor |
| `memo-manager` | the manager window: tabs, trash scopes, settings (theme, language, zoom, defaults, autostart), Help guide |

## Commands

```bash
npm install
npm run dev      # tauri dev (also "Run in dev mode" in .vscode/launch.json)
npm run build    # installers in src-tauri/target/release/bundle/
cd src-tauri && cargo check && cargo clippy   # Rust-only checks
```

No linters or JS build step; the only tests are the sync one (a fake Drive, no network) and the image-file ones in `images.rs` (`cargo test`). Windows installer without a toolchain: `docker compose -f docker/compose.yml run --build --rm windows` (NSIS `*-setup.exe` in `dist/`). More in `memo-checks`.

## Layout

```
src/                     frontend: plain HTML/CSS/JS, no bundler (frontendDist = ../src)
  index.html, app.js     ONE note window (app.js ~60 KB: use memo-code-map, don't read it whole)
  base.css               shared tokens, light/dark themes, label colours, swatches, window chrome
  styles.css             note window components
  chrome.js              shared window behaviour: drag, resize handles, snapping, zoom (MemoZoom)
  i18n.js                UI strings pt/en (MemoI18n.t), Help guide data (HELP)
  manager.html/.js/.css  the manager window ("Gerenciador do Memo")
  group.html/.js/.css    a group bar (one window per group)
  snap.html              Snap preview (transparent, click-through)
  vendor/prism.js        vendored Prism 1.29 — never read or edit
src-tauri/
  src/main.rs            windows, commands, tray, lifecycle (~94 KB: grep by section, see memo-code-map)
  src/store.rs           Note/Group model + persistence
  src/images.rs          pasted images as files in images/ beside notes.json (inline data URLs only in the editor and exports)
  src/cloud.rs           Google sign-in for cloud sync (OAuth loopback + PKCE, token in the OS credential store)
  src/mcp.rs             AI control: MCP tools; local HTTP endpoint in the app + `memo --mcp` stdio bridge (opt-in)
  src/clients.rs         AI control setup: finds MCP clients here and adds/removes Memo in their config files
  src/sync.rs            Drive sync engine: pull (changes API), apply, push; conflicts; has the repo's only test (fake Drive)
  src/welcome.rs         first-run welcome note (HTML + matching plain text)
  tauri.conf.json        app id br.memo.notas, CSP, bundle config (no static windows)
  capabilities/default.json  permissions for note-*, group-* and manager windows
site/                    GitHub Pages home page + privacy policy (en, pt/) for Google's consent screen
  media/                 demo GIFs (<scene>-<dark|light>-<en|pt>.gif), also used by README.md
docs/google-cloud.md     Google Cloud project / OAuth client setup for cloud sync
docs/development.md      building, running, installers, sync builds (moved out of the README)
docs/code-signing.md     Windows installer signing through SignPath Foundation (CI setup)
docs/style.md            visual reference ("Linear"-style dark system); base.css tokens are what the app uses
```

## Working cheaply

Tokens spent on things that don't help understand or change the project are waste. `.claude/settings.json` enforces part of this:

- **Never read** `src/vendor/**`, `src-tauri/icons/**`, `assets/**`, `Cargo.lock`, `package-lock.json`, `src-tauri/target/**`, `src-tauri/gen/**`, `node_modules/**`, `dist/**` (Read is denied). For a dependency version use `cargo tree -i <crate>` or grep `Cargo.toml`.
- **Big files are read by section.** A hook (`.claude/hooks/large-read-guard.js`) refuses a whole-file Read over 40 KB (`main.rs`, `app.js`): grep for the symbol, then Read with `offset`/`limit`. `memo-code-map` lists the sections.
- **Command output is capped** (`bashOutputMaxChars`). Filter long output yourself: `cargo check 2>&1 | grep -E '^(warning|error)' -A5 | head -60`, `git diff --stat` before a full diff, `git log --oneline -n 10`.
- Don't re-read a file you just edited or read; don't paste whole files or logs into replies; load only the skill the task needs.

## Core architecture

- **One window per note.** Labels: `note-{id}`, `group-{id}`, `manager`, plus the hidden `snap-preview`. Rust derives the note id from the calling window's label (`id_of`), so note commands take no id (`invoke('save_text', { text, html })`); manager commands take explicit ids. All note windows load `index.html`, which calls `load_note`. Code that iterates windows tells them apart with `is_note` / `is_group` / `is_app_window` (the last excludes the Snap preview).
- **Rust is the source of truth.** `Store` (`store.rs`) holds everything in a `Mutex`, marks it dirty, and a saver thread flushes atomically every 800 ms. Never overwrite user data: unreadable files are backed up, old files are never deleted. Default data folder is `<OS data folder>/memo` — **never** use Tauri's `app_data_dir()` for notes or config.
- **Tauri commands** live in `main.rs` and must be registered in `generate_handler!`; a new JS window API needs its permission in `capabilities/default.json`. Commands that create/destroy windows are `async` on purpose (sync ones can deadlock on Windows). Rust errors returned to JS are English `String`s (logged, not shown).
- **Events** keep windows in step: `notes-changed`, `groups-changed`, `store-replaced`, `theme-changed`, `language-changed`, `zoom-changed`, `drop-hover`, `cloud-changed`, `ai-control-changed`.
- **Content vs layout (sync groundwork):** `Note::content` / `Group::content` hold what is the same on every device; position, size, pin, `hidden`, `open` are local layout. Keep new content fields inside `content()` and route mutations through `Store::update` / `update_group` (they bump `updatedAt` only on content changes); permanent removals leave tombstones. Details in `memo-storage`.
- **AI control (MCP)** (`mcp.rs`): tools are the outside view of the same features; a new user-facing feature that an assistant could use (create, edit, organise) gets a tool or a field there, calling the same functions as the windows. Off by default (`Config.ai_control`); `memo --mcp` must stay a plain stdio process (no Tauri).
- **Close ≠ trash.** ✕ / middle click only close (`Note.hidden`); only the manager's trash buttons trash. Details in `memo-windows`.

## Conventions

- **Every feature works on Windows, macOS and Linux.** Native APIs get an implementation per OS (`#[cfg(windows)]` / `target_os = "macos"` / `"linux"`, crates already in the tree) plus a fallback. Linux runs under X11 (XWayland forced); macOS transparency needs `macos-private-api`. Verify other targets before claiming they work (`memo-checks`).
- **Consistent usability across components — always.** Notes, group bars and the manager are the same kind of window: same titlebar order (pin far left, colour control, name, action buttons on the right, always visible), same icons for the same action (Help demos included), same gestures (`chrome.js` drag/Snap/resize; titlebar double-click renames notes and groups; middle click = ✕; Mod+Shift+P pins; Mod+N new note; Esc cancels, Enter confirms), same outcomes (names start empty and read "Sem título"/"Untitled"; same colour labels and picker; trash only from the manager; emptying the trash and quitting ask for a second click; reuse existing `i18n.js` keys). A change to one component applies to all where it makes sense, in the same change — or say why not. A feature shown in one place shows wherever that object appears (e.g. a group's name and colour in its bar, note footers, pickers and the manager).
- Keep the Help tab (`HELP` in `i18n.js`, with demos), `welcome.rs`, README, this file and the skills in step with feature changes. The README and `site/` speak to users, not developers: benefits and usage first, technical detail in `docs/development.md`.
- **Tray menu:** every new feature that makes sense as a command (no window needed: create, open a tab, toggle a setting, run an action) also goes in the tray icon's right-click menu (`build_tray_menu` / `on_tray_menu`, labels in `tray_labels`; see `memo-windows`).
- **Colour labels** stay in sync in three places: `COLORS` in `store.rs`, the `.swatch` buttons in `index.html` / `group.html` / `manager.html`, and `[data-color=...]` rules in `base.css`. `lavender` is legacy (valid, not offered). `""` = no colour; `mono` = `--color-paper` (white in dark, black in light); `#rrggbb` = custom (`is_valid_color`, inline `--note-color`, `data-color="custom"`); new notes start with `DEFAULT_NOTE_COLOR` = `""` (none) unless the default is `"random"`, new groups with a random label from `RANDOM_COLORS` (default group colour `"random"`); `DEFAULT_COLOR` = `iris` is the manager's. The custom swatch is an eyedropper (mask icon in `base.css`).
- **Model:** `#[serde(rename_all = "camelCase", default)]` — new fields need a `Default` and appear camelCase in JS. File format `version: 1`.
- **Design:** follow the tokens in `base.css`/`styles.css` (from `docs/style.md`): near-black surfaces (Carbon `#0f1011`, also the native window background), system UI font, weights 400 / 500 (titles, labels) / 700 (editor bold, needed for `queryCommandState('bold')`), hairline borders. The only colour on screen is the note's label; the pin is colourless. Light theme redefines the grey tokens: never use raw white/black overlays, use `--overlay-*`, `--selection`, `--shadow-popover`.
- **CSP** is `default-src 'self'`: no CDNs, remote fonts or inline scripts.
- **Don't bring back collapse** (removed twice): a titlebar double-click renames.
