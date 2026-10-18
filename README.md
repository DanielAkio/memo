# Memo

Sticky memories for Windows, macOS and Linux, inspired by [Stickies](https://www.zhornsoftware.co.uk/stickies/).
Each memory is its own window, and **one click on the pin** keeps it on top of every other app.

The interface is available in English and Portuguese.

## How to use

| Action | How |
|--------|-----|
| Pin / unpin on top of everything | Click the pin on the left of the titlebar, or `Ctrl+Shift+P` (`⌘⇧P` on Mac) |
| Give the memory a title | Double-click the titlebar; `Enter` saves, `Esc` cancels |
| Checklist | Type `[]` at the start of a line; click the box to check it (the text gets struck through) |
| Bulleted list | Type `- ` at the start of a line; `Tab` / `Shift+Tab` indent and outdent the item (also in checklists) |
| Code | `` `text` `` (or `Ctrl+E` / the `</>` button in the format bar) for inline code; ` ```sql ` + `Enter` opens a code block (`Enter` on an empty last line leaves the block) |
| Bold, italic, underline, highlight | `Ctrl+B`, `Ctrl+I`, `Ctrl+U`, `Ctrl+Shift+H` (`⌘` on Mac), or select text and use the bar that appears above the selection |
| Text size (small, normal, large) | The "A" buttons in the format bar, or `Ctrl+Shift+>` / `Ctrl+Shift+<` (`⌘⇧` on Mac) |
| New memory | The `+` button, `Ctrl+N` (`⌘N`) or the Memo tray icon |
| Close | The `✕` button or a middle click (wheel) on the titlebar: the memory goes to the trash |
| See all memories, search, sort, restore from the trash | Memory Manager: opens with the app, or from the tray icon → Memory Manager. The sort box next to the search orders the list by most recent or by title (A–Z). Memories in the trash for over 30 days are deleted |
| Colour, title and text for new memories | Memory Manager → Settings → Defaults (the text uses the same editor as a memory: checklist, bullets, code and formatting) |
| Move | Drag by the titlebar; near a screen edge or another memory, it snaps |
| Resize | By the edges or the bottom-right corner; near a screen edge or another memory, the edge snaps |
| Collapse / expand to the titlebar | The arrow button next to `✕` |
| Change the colour (default: yellow) | Click the coloured dot left of the title and pick a colour, or "Custom" for any colour |
| Language (Portuguese / English) | Memory Manager → Settings → Language: System (default), Português or English |
| Folder where memories are saved | Memory Manager → Settings → Storage → Change… |
| Back up / restore memories | Memory Manager → Settings → Storage → Export… (a `.json` with every memory not in the trash) / Import… (adds the file's memories; an existing one is only replaced if the file's copy is newer) |
| Light / dark theme | Memory Manager → Settings → Theme: System (default), Light or Dark |
| See the first memory's tips again | Memory Manager → Settings → How to use Memo |
| Show all memories | Tray icon (menu bar on macOS) |
| Quit | Tray icon → Quit Memo, or Memory Manager → Settings → Quit Memo |

On launch, Memo shows the Memory Manager together with the memories that were open (the first time, with the welcome
memory). Open memories appear in the taskbar (in the Dock, on macOS). Closing the last memory doesn't quit the app: it
stays in the tray. Text, title, position, size, colour and pin state are saved automatically to `notes.json`, in the
app data folder:

- Windows: `%APPDATA%\memo\`
- macOS: `~/Library/Application Support/memo/`
- Linux: `~/.local/share/memo/`

You can pick another folder in Memory Manager → Settings → Storage (for example a Dropbox or OneDrive folder, to share
memories between computers). The current memories are copied there and the old file is kept as a backup; if the folder
already has Memo memories, Memo asks whether to open those or replace them with the current ones. "Use default folder"
moves them back.

Older versions saved to a folder named `br.memo.notas` (or `br.taxinha.notas`, when the app was called Taxinha):
the first time this version opens, it copies the memories and settings from there into `memo`, leaving the old folder
intact as a backup.

## Running from source

Prerequisites: [Rust](https://rustup.rs), Node.js 18+ and Tauri's system dependencies
([official guide](https://v2.tauri.app/start/prerequisites/)). On Linux (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential
```

Then:

```bash
npm install
npm run dev      # opens the app in development mode
npm run build    # builds the installer for the current OS in src-tauri/target/release/bundle/
```

In VS Code, the same `npm run dev` is under **Run and Debug** → **Run in dev mode**.

## Windows installer via Docker

To build the Windows installer without installing Rust, Node or Visual Studio, you only need
[Docker Desktop](https://www.docker.com/products/docker-desktop/) running. In VS Code, go to **Run and Debug**,
choose **Build Windows installer (Docker)** and click ▶. From the terminal:

```bash
docker compose -f docker/compose.yml run --build --rm windows
```

The `*-setup.exe` (NSIS) shows up in `dist/`. The first build takes longer, because it builds the image and downloads
the Windows SDK; later builds reuse the caches. The `.msi` only comes out of CI, because WiX requires Windows.

## Installers for all three platforms

The workflow in `.github/workflows/build.yml` builds on GitHub Actions for Windows (`.msi` and `.exe`),
macOS Apple Silicon and Intel (`.dmg`) and Linux (`.deb`, `.rpm`, `.AppImage`). It only runs manually, from
Actions → Build → Run workflow, and uploads the installers as artifacts. Run from a `v0.1.0` tag, it also
creates a draft release.

Builds are unsigned. On macOS, open the app the first time with right-click → Open; on Windows,
SmartScreen may ask you to "Run anyway".

## Linux and Wayland

Wayland compositors don't let an app put itself "always on top". So Memo automatically runs through
XWayland when it detects Wayland, and the pin button works on GNOME, KDE and the like.
To force a different backend, set `GDK_BACKEND` before launching the app.

## Layout

```
src/                 interface (plain HTML, CSS and JS, no build step)
  styles.css         tokens and components from docs/style.md
src-tauri/src/
  main.rs            windows, commands, tray
  store.rs           persistence to notes.json
src-tauri/icons/     icons generated from assets/icon.svg
```

The look follows the project's [`docs/style.md`](docs/style.md): near-black surfaces, the system font (Segoe UI,
SF Pro…), hairline borders and, as the only colour, the memory's label (yellow by default).

## License

[MIT](LICENSE).
