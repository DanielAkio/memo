# Memo — AI Rules & Architecture

Memo is a cross-platform (Windows/macOS/Linux) sticky-notes desktop app built on **Tauri 2**. Each note is its own frameless window; the headline feature is the pin button ("always on top"). Code, comments, docs, config labels and commit messages are in **English**; only the UI is bilingual — Portuguese (default) and English, and every new user-facing string needs both (`i18n.js`; Rust strings in `tray_labels` / `welcome.rs`). In the UI a note is a **memória** (en: *memory*); internal names stay `note` (`notes.json`, `note-*` labels, commands).

`.ai/` is the **canonical, LLM-agnostic source of truth** for project rules (`.ai/RULES.md`), skills (`.ai/skills/<name>/SKILL.md`) and hooks (`.ai/hooks/`). Tool-specific files (`CLAUDE.md` + `.claude/`, `AGENTS.md` + `.agents/`) are thin pointers to `.ai/` so any assistant's leftovers can be deleted cleanly without losing project rules or skills. When creating or editing a skill, always write the canonical file in `.ai/skills/<name>/SKILL.md` (Antigravity loads `.ai/skills` directly via `.agents/skills.json`; for Claude Code, keep a thin frontmatter + `@.ai/skills/<name>/SKILL.md` pointer in `.claude/skills/<name>/SKILL.md`).

Subsystem detail lives in `.ai/skills/` and is loaded on demand — **load the matching skill before changing that area**:

| Skill | Load it for |
| --- | --- |
| `memo-code-map` | finding code cheaply: section maps of the big files, grep recipes, what never to read |
| `memo-checks` | building/checking, cross-platform verification (Linux in Docker, macOS crate), CI |
| `memo-storage` | `Store`, `notes.json`/`config.json`, data folder, migration, backup/import, trash purge, note model |
| `memo-windows` | geometry, drag/magnet/Snap, resize, `beside`, close vs trash, startup, tray, lifecycle |
| `memo-groups` | group bars, joining/leaving, take out / put away, group trash |
| `memo-editor` | the note editor: HTML format, lists (checklist, bullets, numbered), code blocks + Prism, tables, links, undo, format bar / Format menu / "Aa" tray, embedded editor |
| `memo-manager` | the manager window: tabs, trash scopes, settings (theme, language, zoom, defaults, autostart), Help guide |

## Commands

```bash
npm install
npm test         # static invariants (check.mjs) + Playwright UI suite (test-ui.mjs) + cargo test
npm run dev      # tauri dev (also "Run in dev mode" in .vscode/launch.json)
npm run build    # installers in src-tauri/target/release/bundle/
cd src-tauri && cargo check && cargo clippy   # Rust-only checks
```

**Tests for every change:** each change or fix the user asks for comes with a regression test in the same change (a step in `tools/test-ui.mjs` on the stage or Memo Web, a `cargo test`, or a check in `tools/check.mjs`), so it stays checked from then on; the `UserPromptSubmit` hook `.ai/hooks/regression-test.mjs` reminds of this on every request. Always run `npm test` after making changes to catch regressions: `tools/check.mjs` verifies JS syntax, Tauri commands/events, `i18n.js` keys/demos and colour parity; `tools/test-ui.mjs` runs the real pages in headless Chromium/Edge via `tools/demos/stage.html`; `cargo test` runs unit tests in `store.rs`, `mcp.rs`, `clients.rs`, `images.rs`, `sync.rs` and `share.rs`. Windows installer without a toolchain: `docker compose -f docker/compose.yml run --build --rm windows` (NSIS `*-setup.exe` in `dist/`). More in `memo-checks`.

## Layout

```
src/                     frontend: plain HTML/CSS/JS, no bundler (frontendDist = ../src); paths
                         between files are relative (a page in windows/x/ loads ../../lib/…)
  windows/               one folder per window: its page, script and styles
    note/                index.html, note.js, note.css — ONE note window (note.js ~3.3k lines:
                         use memo-code-map, don't read it whole); index.html?defaults is the
                         manager's embedded defaults editor
    group/               group.html/.js/.css — a group bar (one window per group)
    board/               board.html/.js/.css — a board (columns of memories, one per board)
    manager/             manager.html/.js/.css — the manager window ("Gerenciador do Memo")
    snap/                snap.html — Snap preview (transparent, click-through)
  components/            bases shared by the windows (plain scripts, loaded with <script>):
    titlebar.js          TitleBar: pin, rename, close/trash, buttons, shortcuts, drag/resize, title menu, focus
    color-menu.js        MemoColor (isCustom, paint, mark, name), MemoTheme, ColorMenu (swatch popover)
    group-picker.js      GroupPicker: the footer group button and its picker (notes, boards)
    pill.js              MemoPill: where an item is (group / board), shown only (manager cards, note footer)
    text.js              MemoText: the plain-text format (lists, code, tables), fromPlain
    card.js              MemoCard: a note's preview on a card (manager, boards)
    toast.js             MemoToast: notices at the bottom of every window, one per key (text, action, ✕)
    confirm.js           MemoConfirm: "Empty trash" and "Quit" act on a second click within 3 s
    share.js             MemoShare: the titlebar's share button copies the item's link ("Link copied" toast)
    update.js            MemoUpdate: a newer Memo as a toast in every window (Update and restart, progress, ✕)
    reminder.js          MemoReminder: a memory's reminder — label, bell pill (note footer, manager/board cards), popover
  assets/                no-image-pt/en.png: what an image becomes in an imported shared memory
  lib/
    chrome.js            window behaviour: drag, resize handles, snapping, title menu (MemoChrome), zoom (MemoZoom)
    i18n.js              UI strings pt/en (MemoI18n.t), shortcut labels (MemoI18n.keys / isMod), Help guide data (HELP)
  styles/base.css        shared tokens, light/dark themes, label colours, swatches, window chrome,
                         popovers (.menu), footer group picker, pills, group tint, titlebar name / rename field
  vendor/prism.js        vendored Prism 1.29 — never read or edit
src-tauri/
  src/main.rs            shared constants and helpers, setup, lifecycle, generate_handler!
  src/windows.rs         building, opening, placing and tracking windows; themes, zoom, screen geometry
  src/drag.rs            dragging, magnet, Snap, resizing
  src/notes.rs           commands called by note windows
  src/manager.rs         manager commands: lists, trash, settings, defaults
  src/groups.rs          group bars, membership, take out / put away, group trash
  src/boards.rs          board windows, columns, board trash (a trashed board takes its memories; restoring brings them back)
  src/data.rs            data folder (choose, reset, migrate), backup export / import
  src/tray.rs            tray menu and the app part of every titlebar menu
  src/color_picker.rs    places the system colour dialog next to the pointer
  src/desk.rs            desktop units: positions that compare across monitors and OSes
  src/store.rs           Note/Group/Board model + persistence
  src/images.rs          pasted images as files in images/ beside notes.json (inline data URLs only in the editor and exports)
  src/cloud.rs           cloud sign-in, Google or Microsoft (`Provider`; OAuth loopback + PKCE, token in the OS credential store)
  src/mcp.rs             AI control: MCP tools; local HTTP endpoint in the app + `memo --mcp` stdio bridge (opt-in)
  src/clients.rs         AI control setup: finds MCP clients here and adds/removes Memo in their config files
  src/reminders.rs       reminders: a due `remindAt` opens its memory pinned, with a system notification (checked every 20 s and at launch)
  src/updater.rs         in-app updates (tauri-plugin-updater): checks, download + install, status for Settings/tray
  src/sync.rs            sync engine over a `Remote` (Google Drive, OneDrive): pull (changes / delta), apply, push; conflicts; fake-cloud tests
  src/share.rs           sharing by link: Memo Web's address with a `memo:v1:` code after `#` (deflate + base64url, same
                         in site/web.js; `memo://` opens it in the app), import as new copies, the import offer in every window
  src/welcome.rs         first-run welcome note (HTML + matching plain text)
  tauri.conf.json        app id br.memo.notas, CSP, bundle config (no static windows)
  capabilities/default.json  permissions for note-*, group-*, board-* and manager windows
site/                    GitHub Pages home page + privacy policy (en + pt in each page) for Google's consent screen
  media/                 demo GIFs (<scene>-<dark|light>-<en|pt>.gif); the README shows only the pitch one
tools/
  check.mjs              fast static & invariant checks (JS syntax, Tauri commands/events, i18n, colours)
  test-ui.mjs            headless Playwright UI tests on the real pages via tools/demos/stage.html
  demos/                 records the site/README GIFs from the real pages (Playwright + fake Tauri API; docs/development.md)
docs/google-cloud.md     Google Cloud project / OAuth client setup for cloud sync
docs/onedrive.md         Microsoft app registration for OneDrive sync (desktop and web)
docs/development.md      building, running, installers, sync builds (moved out of the README)
docs/code-signing.md     Windows installer signing through SignPath Foundation (CI setup)
docs/updates.md          in-app updates: the updater signing key (secret, never committed), latest.json, releasing
docs/style.md            visual reference ("Linear"-style dark system); base.css tokens are what the app uses
```

## Working cheaply

Tokens spent on things that don't help understand or change the project are waste. `.claude/settings.json` enforces part of this:

- **Never read** `src/vendor/**`, `src-tauri/icons/**`, `assets/**`, `Cargo.lock`, `package-lock.json`, `src-tauri/target/**`, `src-tauri/gen/**`, `node_modules/**`, `dist/**` (Read is denied). For a dependency version use `cargo tree -i <crate>` or grep `Cargo.toml`.
- **Big files:** `memo-code-map` lists section maps of the big files (`note.js`, `manager.js`, `store.rs`) and which Rust module holds what, to find symbols and line numbers cheaply.
- **Command output is capped** (`bashOutputMaxChars`). Filter long output yourself: `cargo check 2>&1 | grep -E '^(warning|error)' -A5 | head -60`, `git diff --stat` before a full diff, `git log --oneline -n 10`.
- Don't re-read a file you just edited or read; don't paste whole files or logs into replies; load only the skill the task needs.

## Core architecture

- **One window per note.** Labels: `note-{id}`, `group-{id}`, `board-{id}`, `manager`, plus the hidden `snap-preview`. Rust derives the note id from the calling window's label (`Kind::Note.id_of`), so note commands take no id (`invoke('save_text', { text, html })`); manager commands take explicit ids. All note windows load `index.html`, which calls `load_note`. Code that iterates windows tells them apart with `Kind` (`Kind::of(window)`, `Kind::Group.is(window)`, `Kind::Board.label(id)` — the one place that knows the labels) and `is_app_window` (excludes the Snap preview).
- **Rust is the source of truth.** `Store` (`store.rs`) holds everything in a `Mutex`, marks it dirty, and a saver thread flushes atomically every 800 ms. Never overwrite user data: unreadable files are backed up, old files are never deleted. Default data folder is `<OS data folder>/memo` — **never** use Tauri's `app_data_dir()` for notes or config.
- **Tauri commands** live in the module of their area (`notes.rs`, `manager.rs`, `groups.rs`, …; each module does `use crate::*` and its items are `pub(crate)`) and must be registered in `generate_handler!` in `main.rs`; a new JS window API needs its permission in `capabilities/default.json`. Commands that create/destroy windows are `async` on purpose (sync ones can deadlock on Windows). Rust errors returned to JS are English `String`s (logged, not shown).
- **Events** keep windows in step: `notes-changed`, `groups-changed`, `boards-changed`, `store-replaced`, `theme-changed`, `language-changed`, `zoom-changed`, `drop-hover`, `board-drop-hover`, `cloud-changed`, `ai-control-changed`, `magnet-changed`, `layout-changed`, `update-changed`.
- **Content vs layout (sync groundwork):** `Note::content` / `Group::content` hold what is the same on every device; position, size, pin, `hidden`, `open` are local layout. Keep new content fields inside `content()` and route mutations through `Store::update` / `update_group` (they bump `updatedAt` only on content changes); permanent removals leave tombstones. Details in `memo-storage`.
- **AI control (MCP)** (`mcp.rs`): tools are the outside view of the same features; a new user-facing feature that an assistant could use (create, edit, organise) gets a tool or a field there, calling the same functions as the windows. Off by default (`Config.ai_control`); `memo --mcp` must stay a plain stdio process (no Tauri).
- **Close ≠ trash.** ✕ / middle click only close (`Note.hidden`); only the manager's trash buttons trash. Details in `memo-windows`.

## Conventions

- **Cohesive components, shared code.** Notes, group bars, boards and the manager share as much code as possible, to keep bugs from creeping into one copy: one base per piece of UI (`src/components/`, `styles/base.css`), one command per action for every window (`set_pinned`, `set_color`, `rename`, `close_window`, `trash_window` dispatch on `Kind`), one path per rule (`Kind` for labels; `join_group` / `leave_group` for notes and boards alike; `Store::visible` / `visible_boards` with the same rule). Before adding a second copy of anything, extract it.
- **Memo Web is practically identical to the desktop app.** `site/web.js` implements the same commands with the same rules (pristine checks, trash, pin layers, which windows open); `check.mjs` fails when a desktop command has no web case, except the desktop-only ones it lists with their reason. A change to a command's behaviour changes both, in the same change, with a UI test that runs the web version when it can.
- **Every feature works on Windows, macOS and Linux.** Native APIs get an implementation per OS (`#[cfg(windows)]` / `target_os = "macos"` / `"linux"`, crates already in the tree) plus a fallback. Linux runs under X11 (XWayland forced); macOS transparency needs `macos-private-api`. Verify other targets before claiming they work (`memo-checks`).
- **Consistent usability across components — always.** Notes, group bars and the manager are the same kind of window: same titlebar order (pin far left, colour control, name, action buttons on the right — share link far left of them, then the window's own (+, −, ✕…) — shown only while the window is in use — the pointer anywhere over it, or it has the focus — or one of them has the keyboard focus; always on touch screens), same icons for the same action (Help demos included), same gestures (`chrome.js` drag/Snap/resize; a click on the titlebar's name (or a double-click on the bar) renames notes, groups and boards, looking and working like a board column's name; middle click = ✕; Mod+Shift+P pins; Mod+N new note; Esc cancels, Enter confirms), same outcomes (anything new — memory, group, board, column, any future item — starts with an empty name, never a generated default like "Column 4", and reads a dimmed "Sem título"/"Untitled" (`t('untitled')` + `.is-empty`) until named; same colour labels and picker; trash only from the manager; emptying the trash and quitting ask for a second click (`MemoConfirm`), while a ✕ acts on one click; reuse existing `i18n.js` keys). A change to one component applies to all where it makes sense, in the same change — or say why not. What the windows share is built once: `src/components/` (`TitleBar`, `ColorMenu`, `GroupPicker`, `MemoText`, `MemoCard`) and the shared rules in `base.css`; change it there and let each window pass options, and extract a new base as soon as a second window needs the same piece. A feature shown in one place shows wherever that object appears (e.g. a group's name and colour in its bar, note footers, pickers and the manager).
- **Release descriptions** hold the changes: the Build workflow drafts each release with the commits since the last published one (version bumps left out), and before it is published the description is rewritten for users with every change and fix since that release (`gh release edit vX.Y.Z --notes-file`), grouped as New / Fixes / Website and README. So write commit messages that say what changed for the user.
- Keep the Help tab (`HELP` in `i18n.js`, with demos), `welcome.rs`, README, `.ai/RULES.md` and `.ai/skills/` in step with feature changes. The README and `site/` speak to users, not developers: benefits and usage first, technical detail in `docs/development.md`.
- **Tray menu:** every new feature that makes sense as a command (no window needed: create, open a tab, toggle a setting, run an action) also goes in the tray icon's right-click menu (`build_tray_menu` / `on_tray_menu`, labels in `tray_labels`; see `memo-windows`). A titlebar menu (… button / right click, `show_title_menu`) stays short: the window's own commands on top (none that duplicate an always-visible button such as ✕), then only the app's most used ones (`app_menu_items(.., full: false)`: new memory / group / board, the manager, a newer version); settings and the rest live in the tray and the manager. Its titlebar keeps only the most used buttons.
- **Colour labels** stay in sync in three places: `COLORS` in `store.rs`, the `.swatch` buttons in the windows' pages (`windows/note/index.html`, `group.html`, `board.html`, `manager.html`), and `[data-color=...]` rules in `styles/base.css`. `lavender` is legacy (valid, not offered). `""` = no colour; `mono` = `--color-paper` (white in dark, black in light); `#rrggbb` = custom (`is_valid_color`, inline `--note-color`, `data-color="custom"`); new notes start with `DEFAULT_NOTE_COLOR` = `""` (none) unless the default is `"random"`, new groups with a random label from `RANDOM_COLORS` (default group colour `"random"`); `DEFAULT_COLOR` = `iris` is the manager's. The custom swatch is an eyedropper (mask icon in `base.css`).
- **Model:** `#[serde(rename_all = "camelCase", default)]` — new fields need a `Default` and appear camelCase in JS. File format `version: 1`.
- **Design:** follow the tokens in `base.css`/`note.css` (from `docs/style.md`): near-black surfaces (Carbon `#0f1011`, also the native window background), system UI font, weights 400 / 500 (titles, labels) / 700 (editor bold, needed for `queryCommandState('bold')`), hairline borders. The only colour on screen is the note's label; the pin is colourless. Light theme redefines the grey tokens: never use raw white/black overlays, use `--overlay-*`, `--selection`, `--shadow-popover`.
- **CSP** is `default-src 'self'`: no CDNs, remote fonts or inline scripts.
- **Don't bring back collapse** (removed twice): a titlebar double-click renames.
- **Memo Web on a phone** (< 680 px): one window at a time, full screen. A group opens on its own (`openGroupOnMobile`): its bar on top and its memories listed below (group.js `renderMembers`); a tap opens one, Back returns to the group, then to the manager.

