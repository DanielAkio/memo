---
name: memo-checks
description: Build, check and verify Memo across Windows, macOS and Linux. Use before saying a change compiles or works on another OS, when touching native (cfg-gated) code, Cargo deps, the Docker build or the CI workflow.
---

# Building and checking Memo

There are no tests, linters or JS build step. The JS is served as-is, so a JS change is checked by running the app (`npm run dev`).

## Local

```bash
npm install
npm run dev                         # tauri dev, Rust backend in debug
npm run build                       # installers in src-tauri/target/release/bundle/
cd src-tauri && cargo check && cargo clippy
```

Keep command output short: `cargo check 2>&1 | grep -E '^(warning|error)' -A5 | head -60` instead of dumping full build logs.

## Other targets

The author's machine is Windows. Check the other targets before claiming a change works there:

- **Linux:** `cargo check` / `cargo clippy` in Docker, image `rust:1-bookworm` with `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`. Linux runs under X11 (`GDK_BACKEND=x11` is forced so always-on-top works through XWayland).
- **macOS:** `cargo check --target aarch64-apple-darwin` fails on a C build script, so compile macOS-only code in an isolated crate with the same crate versions (`objc2-app-kit` etc.; see `src-tauri/Cargo.toml`). Transparent windows need `macOSPrivateApi` (tauri feature `macos-private-api`, already on).
- **Windows installer without a toolchain:** `docker compose -f docker/compose.yml run --build --rm windows` (also in `.vscode/launch.json`). Cross-compiles with `cargo-xwin`; outputs only the NSIS `*-setup.exe` to `dist/` (no `.msi`, WiX needs Windows). `node_modules`, `target` and caches live in Docker volumes.

Native code is gated with `#[cfg(windows)]` / `#[cfg(target_os = "macos")]` / `#[cfg(target_os = "linux")]`, using crates already in the tree (`windows-sys`, `objc2-app-kit`, `x11-dl`, `raw-window-handle`), always with a fallback.

## CI

`.github/workflows/build.yml` builds installers for Windows, macOS arm64 + x64 and Linux (ubuntu-22.04). It runs only via `workflow_dispatch`; run from a `v*` tag it creates a draft GitHub release via `tauri-action`. The Windows installers are signed through SignPath only when the `SIGNPATH_API_TOKEN` secret and `SIGNPATH_ORGANIZATION_ID` variable exist (`docs/code-signing.md`; keep the README's "Code signing policy" section, which SignPath Foundation requires); otherwise, and on macOS/Linux, builds are unsigned. Cloud sync needs the repository secrets `MEMO_GOOGLE_CLIENT_ID` / `MEMO_GOOGLE_CLIENT_SECRET` (passed to `tauri-action`; Docker passes them from the host shell); without them the build has no sync section. To compile both code paths locally: `MEMO_GOOGLE_CLIENT_ID=x cargo clippy`.
