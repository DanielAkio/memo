# OneDrive sync: Microsoft app registration

Memo syncs with OneDrive through Microsoft Graph, in the app's own folder (`Apps/Memo` in the user's OneDrive). It
needs one app registration in Microsoft Entra (free, no review). The same registration serves the desktop app and
Memo Web. Without it, a build simply doesn't offer OneDrive (Google Drive still works if configured, see
[`google-cloud.md`](google-cloud.md)).

## 1. Register the app

1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **App registrations** → **New registration** (any
   Microsoft account works; a personal one gets a default directory).
2. Name: `Memo`.
3. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   (`common`), so both personal OneDrive and OneDrive for work or school can connect.
4. Leave the redirect URI empty for now and create it.
5. Copy the **Application (client) ID**: that is `MEMO_MICROSOFT_CLIENT_ID`. There is no secret: Memo is a public
   client and signs in with PKCE.

## 2. Platforms (Authentication)

- **Mobile and desktop applications** → custom redirect URI `http://localhost`. Microsoft accepts any port on
  `localhost`, which is what the desktop app's one-shot sign-in server uses.
- **Single-page application** (for Memo Web) → `https://danielakio.github.io/memo/app.html` and, for local tests,
  `http://localhost:3000/memo/app.html` (Microsoft only takes `https://` or `http://localhost` here; `npm run web`
  serves Memo Web there, as in production, and redirects `127.0.0.1` and `/site/` to it). Under **Implicit grant and hybrid flows**, tick **Access tokens**: Memo Web
  gets its token in the popup's redirect, as it does with Google. In the newer portal this checkbox may be hidden:
  set it in **Manifest** instead (`web.implicitGrantSettings.enableAccessTokenIssuance: true`, or
  `oauth2AllowImplicitFlow: true` in the older manifest format).
- "Allow public client flows" is not needed (that is for device-code and password flows).

## 3. API permissions

Microsoft Graph, **delegated**:

| Permission | Why |
| --- | --- |
| `Files.ReadWrite.AppFolder` | only Memo's folder in OneDrive; Memo can't see any other file |
| `User.Read` | the account's e-mail, shown in Settings |
| `offline_access` | a refresh token, so the desktop app keeps syncing without signing in again |

None needs admin consent.

## 4. Builds

| Where | Variable |
| --- | --- |
| local desktop builds | `MEMO_MICROSOFT_CLIENT_ID` in `.env` at the repository root (template `.env.example`) |
| CI (`build.yml`, `pages.yml`) | repository secret `MICROSOFT_CLIENT_ID` |
| local Memo Web (`tools/serve-web.mjs`) | `MEMO_MICROSOFT_CLIENT_ID` in `.env` |

`build.rs` passes it to `option_env!` (Cargo rebuilds when it changes); `pages.yml` writes it into
`site/app.html`'s `memo-microsoft-client-id` meta tag.

## How the files look

OneDrive has no custom file properties on personal accounts, so a file's version stamp is part of its name:
`note-<id>.json~<updatedAt>`, `group-<id>.json~<…>`, `settings.json~<…>`, `image-<name>~1`. Writing a newer version
writes a new file and deletes the one it replaces; a first full listing removes older copies left by a sync that
stopped halfway. Changes come from Graph's `delta` on the app folder. The logic is the same as Google Drive's
(`sync.rs`, `Remote`); see `memo-storage`.
