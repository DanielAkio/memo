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
npm run dev      # run in development mode (also "Run in dev mode" in VS Code)
npm run build    # installer for the current OS in src-tauri/target/release/bundle/
cd src-tauri && cargo check && cargo clippy && cargo test
```

- **Windows installer without a toolchain**: with Docker running,
  `docker compose -f docker/compose.yml run --build --rm windows` puts the NSIS `*-setup.exe` in `dist/`.
- **All platforms**: the manual workflow in `.github/workflows/build.yml` (Actions → Build → Run workflow) builds
  Windows, macOS (Apple Silicon and Intel) and Linux installers; run from a version tag, it also creates a draft
  release. With SignPath set up it also signs the Windows installers ([`code-signing.md`](code-signing.md)).

## Google Drive sync

The sync section only shows in builds made with a Google OAuth client. For local builds, put it in `.env` at the
repository root (template: `.env.example`); CI reads the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets. Setting
up the Google Cloud project is in [`google-cloud.md`](google-cloud.md).

## AI control (MCP)

`src-tauri/src/mcp.rs`. With AI control on, the app listens on `127.0.0.1` (random port, bearer token, both written to
`mcp.json` in the default data folder while it runs; browser requests with an `Origin` or a foreign `Host` are
refused). MCP clients don't talk to that port: they launch `memo --mcp`, a stdio server in the same executable that
answers `initialize` / `tools/list` itself and forwards each tool call to the app, opening Memo (`--autostart`) when it
isn't running. Tools change memories through the same functions as the windows, so the screen follows.

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

## Website

`site/` is the home page and privacy policy published to GitHub Pages by `.github/workflows/pages.yml`
(<https://danielakio.github.io/memo/>), in English and Portuguese (`site/pt/`). The GIFs in `site/media/` are used by
both the site and the README; each one comes in dark and light versions and in both languages
(`<scene>-<theme>-<lang>.gif`).

## Uninstalling

- **Windows**: Settings → Apps → Installed apps → Memo → Uninstall.
- **macOS**: quit Memo from the menu bar and drag `Memo.app` from Applications to the Trash.
- **Linux**: `sudo apt remove memo` (`.deb`) or `sudo dnf remove memo` (`.rpm`); for the AppImage, delete the file.

Uninstalling keeps the data folder; delete it to remove the memories too.

## Linux and Wayland

Wayland doesn't let an app keep itself on top, so Memo forces XWayland (`GDK_BACKEND=x11`) and the pin works on
GNOME, KDE and the like.

## Code signing

The policy SignPath Foundation asks for is published at <https://danielakio.github.io/memo/code-signing.html>
(`site/code-signing.html`) and linked from the README and the site footer.
