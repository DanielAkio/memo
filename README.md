# Memo

**Sticky memories you pin on top of everything.**

Memo is a sticky-notes app for **Windows, macOS and Linux**. Each memory is its own little window on your screen,
and **one click on the pin** keeps it on top of every other app: the to-do list next to the spreadsheet, the command
you always forget above the terminal, the reminder that must not hide behind the browser. It is free, open source and
works fully offline.

## What it does

- **Pin on top of everything**: the pin in the memory's corner (or `Ctrl+Shift+P`) keeps it always visible.
- **Quick, formatted writing**: checklists with `[]`, bullets with `- `, bold, italic, underline, highlight, three
  text sizes, code blocks with syntax highlighting and pasted images you resize by their corner.
- **Colours and titles**: name and colour each memory to find it at a glance.
- **Groups**: gather memories in a small bar, put them all away at once and take them back out where they were.
- **Tidy screen**: drag a memory and it snaps to screen edges and other memories; push it against a screen edge to
  fit it to half, a quarter or the whole screen.
- **Manager**: see, search and sort every memory and group; restore from the trash for up to 30 days.
- **Your data stays with you**: everything is saved automatically on your computer. You can choose another folder
  (a Dropbox or OneDrive one, for example) and export or import a backup.
- **Your way**: light or dark theme, text size, default colour and text for new memories, and start with the system.
- Interface in **English and Portuguese**.

## Download

Installers are on the **[Releases](https://github.com/DanielAkio/memo/releases)** page. Pick the file for your
system:

| System | File |
| --- | --- |
| Windows 10/11 | `…-setup.exe` (recommended) or `.msi` |
| macOS on Apple Silicon (M1, M2…) | `.dmg` with `aarch64` in its name |
| macOS on Intel | `.dmg` with `x64` in its name |
| Linux (Ubuntu, Debian, Mint…) | `.deb` |
| Linux (Fedora, openSUSE…) | `.rpm` |
| Linux (any distribution) | `.AppImage` |

> No release yet? One is on its way: on GitHub, **Watch → Custom → Releases** tells you when it is out.

## First launch

The installers are **not code-signed** yet, so your system may be wary the first time. That is expected and only
happens once:

- **Windows**: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**. The installer asks
  whether Memo should start with the system.
- **macOS**: drag Memo to Applications. The first time, right-click the app → **Open**; if macOS still blocks it, go
  to **System Settings → Privacy & Security** and click **Open Anyway**. If it says the app "is damaged", run
  `xattr -cr /Applications/Memo.app` in Terminal and open it again.
- **Linux**: install the `.deb` or `.rpm` with your package manager, or make the `.AppImage` executable
  (`chmod +x Memo*.AppImage`) and run it.

On launch, Memo shows the **Memo Manager** and a welcome memory that explains the basics. Closing the last memory
doesn't quit the app: it stays in the tray (the menu bar, on Mac).

## Getting started

| To… | Do |
| --- | --- |
| Create a memory | The `+` button, `Ctrl+N` (`⌘N` on Mac) or the Memo tray icon |
| Pin it on top of everything | Click the pin on the left of the titlebar, or `Ctrl+Shift+P` (`⌘⇧P`) |
| Give it a title | Double-click the titlebar; `Enter` saves, `Esc` cancels |
| Change its colour | Click the coloured dot next to the title |
| Titlebar commands | Right-click the titlebar: rename, pin, colour, new memory, close (groups and the manager too) |
| Checklist | Type `[]` at the start of a line; click the box to check it |
| Bulleted list | Type `- ` at the start of a line; `Tab` / `Shift+Tab` change the indent |
| Format | Select text and use the bar that appears, or `Ctrl+B`, `Ctrl+I`, `Ctrl+U`, `Ctrl+Shift+H` |
| Code | `` `text` `` for inline code; ` ```sql ` + `Enter` opens a code block |
| Image | Paste it with `Ctrl+V` (`⌘V`); click it and drag its bottom-right corner to resize it |
| Close | `✕` or a middle click on the titlebar; it stays in the Manager, where you reopen it |
| Delete | Only with the Manager's trash button (restorable for 30 days) |
| Group | In the Manager, the folder-with-`+` button, or "New group" in a memory's footer; then drop memories on the bar |
| See everything, search, settings | Memo Manager: Memories, Groups, Settings and Help tabs |
| Tray menu | Right-click the Memo tray icon: new memory or group, show all, Manager, Trash, Settings, Help, theme, language, start with the system, sync now, quit |
| Quit | Tray icon → Quit Memo |

The Manager's **Help** tab has a full guide to every feature, with demos and shortcuts.

## Where your memories live

Everything is saved automatically, on your computer:

- Windows: `%APPDATA%\memo\`
- macOS: `~/Library/Application Support/memo/`
- Linux: `~/.local/share/memo/`

In **Settings → Storage** you can change the folder (a synced Dropbox or OneDrive folder takes your memories to other
computers), export a `.json` backup and import it back.

### Google Drive sync

Memo can connect a Google account in Memo Manager → Settings → Sync, to keep the memories in a hidden Memo folder of
your own Google Drive and use them on several computers. Only the content syncs (text, title, colour, group, trash);
window positions, size and pin stay on each computer, and without connecting everything stays local. A memory created
on another computer shows up closed in the Manager; if the same memory is edited in two places before syncing, the newer
version wins and the other is kept in the trash with "(conflict)" in its title. The section only shows in builds made
with a Google OAuth client (for local builds, put it in `.env`, see `.env.example`) — see [`docs/google-cloud.md`](docs/google-cloud.md).

## Uninstalling

- **Windows**: Settings → Apps → Installed apps → Memo → Uninstall.
- **macOS**: quit Memo from the menu bar and drag `Memo.app` from Applications to the Trash.
- **Linux**: `sudo apt remove memo` (`.deb`) or `sudo dnf remove memo` (`.rpm`); for the AppImage, delete the file.

Uninstalling keeps your memories. To remove them too, delete the folder listed above (or the one you chose in
Settings → Storage).

## Linux and Wayland

Wayland doesn't let an app put itself "always on top", so Memo runs through XWayland automatically and the pin works
on GNOME, KDE and the like.

## Found a problem or have an idea?

Every suggestion and bug report helps Memo get better:

- **[Report a bug](https://github.com/DanielAkio/memo/issues/new?template=bug_report.yml)**: tell what you did, what
  you expected and what happened, and which system and Memo version you use.
- **[Suggest an improvement](https://github.com/DanielAkio/memo/issues/new?template=feature_request.yml)**: describe
  the idea and the problem it solves.

Before opening one, check the [open issues](https://github.com/DanielAkio/memo/issues): if someone already asked for
the same thing, a 👍 on it helps. You need a free GitHub account. Write in English or Portuguese.

## For developers

Memo is built with [Tauri 2](https://v2.tauri.app): a Rust backend (`src-tauri/`) and a plain HTML/CSS/JS frontend
(`src/`, no bundler). Prerequisites: [Rust](https://rustup.rs), Node.js 18+ and
[Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/) (on Debian/Ubuntu:
`sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential`).

```bash
npm install
npm run dev      # run in development mode (also "Run in dev mode" in VS Code)
npm run build    # installer for the current OS in src-tauri/target/release/bundle/
```

- **Windows installer without a toolchain**: with Docker running,
  `docker compose -f docker/compose.yml run --build --rm windows` puts the NSIS `*-setup.exe` in `dist/`.
- **All platforms**: the manual workflow in `.github/workflows/build.yml` (Actions → Build → Run workflow) builds
  Windows, macOS (Apple Silicon and Intel) and Linux installers; run from a version tag, it also creates a draft
  release. With SignPath set up it also signs the Windows installers ([`docs/code-signing.md`](docs/code-signing.md)).
- The visual reference is [`docs/style.md`](docs/style.md); [`CLAUDE.md`](CLAUDE.md) describes the architecture and
  conventions.

Older versions saved to a folder named `br.memo.notas` (or `br.taxinha.notas`); on first launch Memo copies that data
into `memo` and keeps the old folder as a backup.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

- Committers and reviewers: [Daniel Akio Teixeira](https://github.com/DanielAkio)
- Approvers: [Daniel Akio Teixeira](https://github.com/DanielAkio)

Only the Windows installers built from this repository by its GitHub Actions workflow are signed, and each signing
request is approved by hand.

Privacy: this program will not transfer any information to other networked systems unless specifically requested
by the user or the person installing or operating it. Cloud sync only talks to Google after you connect a Google
account in the Manager.

## License

[MIT](LICENSE).
