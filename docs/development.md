# Developing Memo

Memo is built with [Tauri 2](https://v2.tauri.app): a Rust backend (`src-tauri/`) and a plain HTML/CSS/JS frontend
(`src/`, no bundler). [`CLAUDE.md`](../CLAUDE.md) describes the architecture and conventions, and
[`style.md`](style.md) is the visual reference.

## Prerequisites

- [Rust](https://rustup.rs)
- Node.js 18+
- [Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/). On Debian/Ubuntu:
  `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential`

## Run and build

```bash
npm install
npm run dev      # run in development mode (also "Run in dev mode" in VS Code, which first
                 # ends a dev Memo still running, so Restart works)
npm run web      # serve the website and browser web app at http://localhost:3000/memo/app.html
                 # (as in production; 127.0.0.1 and /site/ redirect there: one address for Google,
                 # OneDrive and the browser's storage)
npm run build    # installer for the current OS in src-tauri/target/release/bundle/
cd src-tauri && cargo check && cargo clippy && cargo test
```

- **Windows installer without a toolchain**: with Docker running,
  `docker compose -f docker/compose.yml run --build --rm windows` puts the NSIS `*-setup.exe` in `dist/`.
- **All platforms**: the manual workflow in `.github/workflows/build.yml` (Actions → Build → Run workflow) builds
  Windows, macOS (Apple Silicon and Intel) and Linux installers; run from a version tag, it also creates a draft
  release. With SignPath set up it also signs the Windows installers ([`code-signing.md`](code-signing.md)); with the
  `TAURI_SIGNING_PRIVATE_KEY` secret it also publishes the signed update packages the app updates itself from
  ([`updates.md`](updates.md)).

## Cloud sync (Google Drive, OneDrive)

The sync section only shows in builds made with a Google OAuth client or a Microsoft app id, and offers each cloud
whose client the build has. For local builds, put them in `.env` at the repository root (template: `.env.example`);
CI reads the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` secrets. Setting up the Google
Cloud project is in [`google-cloud.md`](google-cloud.md), the Microsoft app registration in
[`onedrive.md`](onedrive.md).

## AI control (MCP)

`src-tauri/src/mcp.rs`. With AI control on, the app listens on `127.0.0.1` (random port, bearer token, both written to
`mcp.json` in the default data folder while it runs; browser requests with an `Origin` or a foreign `Host` are
refused). MCP clients don't talk to that port: they launch `memo --mcp`, a stdio server in the same executable that
answers `initialize` / `tools/list` itself and forwards each tool call to the app, opening Memo (`--autostart`) when it
isn't running. Tools change memories through the same functions as the windows, so the screen follows.

Settings → AI control → **Connect** (`src-tauri/src/clients.rs`) adds a `memo` entry pointing at the running
executable to the config file of each MCP client found (Claude Desktop, including the Microsoft Store build's folder,
Claude Code `~/.claude.json`, VS Code `mcp.json`, Cursor, Windsurf, Gemini CLI, Cline CLI and VS Code extension, Codex
`config.toml`). Only that entry changes; the first change keeps the original as `<file>.before-memo`, and a file that
isn't plain JSON (comments) is left alone, so the user copies the setup instead. "Connected to another copy" means the
entry launches a different executable (say, the installed app while you run `npm run dev`); Update repoints it.

Try it without a client:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_memories","arguments":{}}}' \
  | src-tauri/target/debug/memo --mcp
```

or with the MCP Inspector: `npx @modelcontextprotocol/inspector src-tauri/target/debug/memo --mcp`.

## Data folder

Memories, groups and settings live in `notes.json` and `config.json` in the data folder (pasted images as files in its `images/` subfolder): Windows `%APPDATA%\memo\`,
macOS `~/Library/Application Support/memo/`, Linux `~/.local/share/memo/`, or the folder picked in Settings → Storage. Older versions saved to a folder named `br.memo.notas` (or `br.taxinha.notas`); on
first launch Memo copies that data into `memo` and keeps the old folder as a backup.

## App icon

The icon is a minimal iris pushpin. Its sources are `assets/icon.svg` (app icon, also copied to `site/media/icon.svg`)
and `assets/tray.svg` (tray glyph). Every file in `src-tauri/icons/` is rendered from them: the PNGs at their
sizes, `icon.ico` (16–256 px), `icon.icns` (PNG entries 16@2x–1024), `tray.png` and `tray-template.png` (the tray
glyph in black, used as a macOS template image). Change the SVGs first, then regenerate all of them together.

## Website

`site/` is the home page and privacy policy published to GitHub Pages by `.github/workflows/pages.yml`
(<https://danielakio.github.io/memo/>), in English and Portuguese. The GIFs in `site/media/` are used by
both the site and the README; each one comes in dark and light versions and in both languages
(`<scene>-<theme>-<lang>.gif`).

Each page holds both languages: every translated element appears twice, marked `lang="en"` and `lang="pt-BR"`, and
`style.css` shows the ones matching `<html lang>`. The page's title and description, which can't be doubled, keep the
Portuguese text in `data-pt`. A bilingual page has `data-bilingual` on `<html>`; `code-signing.html` is English only.
The old `site/pt/` addresses redirect to `?lang=pt`.

`site/prefs.js`, loaded in every page's `<head>`, picks the language and theme: Portuguese when the browser prefers it,
English otherwise, and the system's light/dark setting. The nav's language link (`?lang=pt|en`, switched in place) and
theme button override both; the choice is kept in `localStorage` (`memo-lang`, `memo-theme`).

The GIFs are recorded from the app's own pages, so re-record them whenever the windows change:

```bash
npm install --no-save playwright         # once; ffmpeg must be on the PATH
node tools/demos/record.mjs              # every scene, theme and language (a few minutes)
node tools/demos/record.mjs write dark en  # just one
```

`tools/demos/stage.html` is a fake desktop where each Memo window is an `<iframe>` of `src/windows/note/index.html`,
`group.html` or `manager.html`; `mock.js` stands in for the Tauri API (the state lives in `stage.js`), and
`record.mjs` scripts each scene with a real mouse and keyboard, one screenshot per frame. A new Tauri command the
pages call at startup may need a case in `stage.js`'s `invoke`.

## Uninstalling

- **Windows**: Settings → Apps → Installed apps → Memo → Uninstall.
- **macOS**: quit Memo from the menu bar and drag `Memo.app` from Applications to the Trash.
- **Linux**: delete the `.AppImage` file.

Uninstalling keeps the data folder; delete it to remove the memories too.

## Linux and Wayland

Wayland doesn't let an app keep itself on top, so Memo forces XWayland (`GDK_BACKEND=x11`) and the pin works on
GNOME, KDE and the like.

## Code signing

The policy SignPath Foundation asks for is published at <https://danielakio.github.io/memo/code-signing.html>
(`site/code-signing.html`) and linked from the README and the site footer.
