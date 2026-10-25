# In-app updates

Memo updates itself with [Tauri's updater](https://v2.tauri.app/plugin/updater/) (`src-tauri/src/updater.rs`). The
app reads `latest.json` from the newest **published** GitHub release:

```
https://github.com/DanielAkio/memo/releases/latest/download/latest.json
```

That file lists, per platform, the update package's URL and its signature. The app only installs a package whose
signature matches the public key in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), so a release can only
reach users when it was signed with the matching private key. This signature is free and separate from the
Windows/macOS code signing in [`code-signing.md`](code-signing.md): unsigned installers still warn on the first
download, but updates install without warnings.

## The signing key

The key pair was made on the maintainer's computer, in the repository folder, with
`npx tauri signer generate -w memo-updater.key`. The public key (`memo-updater.key.pub`) is in `tauri.conf.json`;
the private key is **never committed** (`*.key` and `*.key.pub` are git-ignored). It lives in two places:

1. The repository secret **`TAURI_SIGNING_PRIVATE_KEY`** (GitHub → Settings → Secrets and variables → Actions →
   New repository secret), holding the whole content of the key file. If the key has a password, also add
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
2. A backup you keep (a password manager, say). **If the private key is lost, installed copies can no longer be
   updated**: a new key means a new public key in the app, and users must download that version by hand once.

## Releasing

Unchanged: bump the version (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`), push a `v*` tag
and run the Build workflow from it. With the secret present, the workflow also:

- turns on `bundle.createUpdaterArtifacts`, so each job also builds signed update packages (macOS `.app.tar.gz`,
  Linux `.AppImage`, the Windows `*-setup.exe`) with a `.sig` beside them;
- has `tauri-action` upload them and add each platform to `latest.json` in the draft release;
- with SignPath on, signs the SignPath-signed Windows installers again for the updater and rewrites latest.json's
  Windows entries to point at them.

Users get the update once the draft is **published** (`releases/latest` ignores drafts and pre-releases). Local
builds (`npm run build`, Docker) make no update packages and need no key.

## In the app

- Release builds check 10 s after launch and every 6 h, unless Settings → App → "Tell me about new versions" is off
  (`Config.updatesOff`). Debug builds (`npm run dev`) only check when asked. Automatic checks fail silently.
- A newer version turns the tray's (and every titlebar menu's) "Check for updates" into "Update to version X", and
  Settings → App shows it with "Update and restart". Installing downloads the package, checks the signature, saves
  pending changes, installs and restarts. On Windows the NSIS installer runs in passive mode (a progress bar, no
  questions) and closes the app itself.
- Linux: the AppImage replaces itself.
- Testing the whole flow needs two releases: install the older one, publish the newer one, then "Check for updates".
