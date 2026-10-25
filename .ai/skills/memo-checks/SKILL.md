---
name: memo-checks
description: Build, check and verify Memo across Windows, macOS and Linux. Use before saying a change compiles or works on another OS, when touching native (cfg-gated) code, Cargo deps, the Docker build or the CI workflow.
---

# Building and checking Memo

Always run `npm test` after making changes to verify nothing broke across the frontend or backend:

1. **Static & invariant checks (`npm run check` / `node tools/check.mjs`):** < 0.5 s, zero dependencies. Verifies JS syntax across `src/`, `site/` and `tools/`, matches every Tauri `invoke('...')` and `listen('...')` in JS against `generate_handler!` and `emit` in Rust, checks `STRINGS`, `PLACEHOLDERS`, `HELP` and demo icons in `src/i18n.js` (pt & en parity + every `data-i18n` / `t('...')` reference), and checks `COLORS` parity across `store.rs`, `base.css` and the HTML `.swatch` lists.
2. **Headless UI integration tests (`npm run test:ui` / `node tools/test-ui.mjs`):** ~4 s using Playwright + `tools/demos/stage.html` (falls back to system Chrome/Edge if Playwright's bundled browser isn't installed; install Playwright once with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright`). Exercises the real pages (`index.html`, `group.html`, `manager.html`): welcome note `sanitize`/`toPlain`/`fromPlain` round-trip in PT and EN, lists/checklists, code blocks + Prism, tables, links, undo/redo, format tray, titlebar pin/rename/colour/close (`✕` ≠ trash), group bar, and manager tabs/search/trash/restore/Help demos with zero console or page errors.
3. **Rust unit tests (`cargo test` in `src-tauri/`):** tests `store.rs` (content vs layout `updatedAt` invariant, selectors, pristine checks, groups, trash purge, tombstones, corrupted-file backup, export/import), `mcp.rs` (`from_plain`, links, dates, JSON-RPC protocol), `clients.rs` (JSON/TOML MCP config updates), `images.rs` (file storage, inline round-trip, migration, export/import), and `sync.rs` (two stores against a fake Drive, no network).

## Local

```bash
npm install
npm test                            # check.mjs + test-ui.mjs + cargo test
npm run check                       # static & invariant checks only (< 0.5 s)
npm run test:ui                     # Playwright headless UI suite (~4 s)
npm run dev                         # tauri dev, Rust backend in debug
npm run build                       # installers in src-tauri/target/release/bundle/
cd src-tauri && cargo check && cargo clippy
```

Keep command output short: `cargo check 2>&1 | grep -E '^(warning|error)' -A5 | head -60` instead of dumping full build logs.

## Other targets

The author's machine is Windows. Check the other targets before claiming a change works there:

- **Linux:** `cargo check` / `cargo clippy` in Docker, image `rust:1-bookworm` with `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`. Linux runs under X11 (`GDK_BACKEND=x11` is forced so always-on-top works through XWayland).
- **macOS:** `cargo check --target aarch64-apple-darwin` fails on a C build script, so compile macOS-only code in an isolated crate with the same crate versions (`objc2-app-kit` etc.; see `src-tauri/Cargo.toml`). Transparent windows need `macOSPrivateApi` (tauri feature `macos-private-api`, already on).
- **Windows installer without a toolchain:** `docker compose -f docker/compose.yml run --build --rm windows` (also in `.vscode/launch.json`). Cross-compiles with `cargo-xwin`; outputs the NSIS `*-setup.exe` to `dist/`. `node_modules`, `target` and caches live in Docker volumes.

Native code is gated with `#[cfg(windows)]` / `#[cfg(target_os = "macos")]` / `#[cfg(target_os = "linux")]`, using crates already in the tree (`windows-sys`, `objc2-app-kit`, `x11-dl`, `raw-window-handle`), always with a fallback.

## CI

`.github/workflows/build.yml` builds installers (`["nsis", "dmg", "appimage"]`) for Windows, macOS arm64 + x64 and Linux (ubuntu-22.04). It runs only via `workflow_dispatch`; run from a `v*` tag it creates a draft GitHub release via `tauri-action` (with the `TAURI_SIGNING_PRIVATE_KEY` secret the jobs also build signed update packages and `latest.json` for the in-app updater, adding `"app"` on macOS for `.app.tar.gz`, `docs/updates.md`). The Windows installer is signed through SignPath only when the `SIGNPATH_API_TOKEN` secret and `SIGNPATH_ORGANIZATION_ID` variable exist (`docs/code-signing.md`; keep the code signing policy page `site/code-signing.html`, linked from the README and the site footer, which SignPath Foundation requires); otherwise, and on macOS/Linux, builds are unsigned. Cloud sync needs the repository secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (passed to `tauri-action` as `MEMO_GOOGLE_CLIENT_ID` / `MEMO_GOOGLE_CLIENT_SECRET`; locally they come from the shell or a git-ignored `.env` at the repo root, read by `build.rs` (template `.env.example`); Docker mounts the repo, so `.env` works there too, besides the host shell); without them the build has no sync section. To compile both code paths locally: `MEMO_GOOGLE_CLIENT_ID=x cargo clippy`.
