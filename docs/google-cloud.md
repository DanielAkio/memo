# Google Drive sync: Google Cloud setup

Memo's cloud sync signs in with Google and keeps the memories in the app's hidden
folder of the user's own Drive (`appDataFolder`, scope `drive.appdata`). There is no
Memo server: each install talks to Google directly. Signing in needs an OAuth client
that belongs to a Google Cloud project; a build without one has no cloud sync, and
the "Sync" section of Settings stays hidden.

## 1. Project and API

In the [Google Cloud console](https://console.cloud.google.com/), with the project
selected (here: `memo`):

1. **APIs & Services → Library**: enable the **Google Drive API**.

## 2. Consent screen (Google Auth Platform)

1. **Google Auth Platform → Get started**: app name `Memo`, a support e-mail,
   audience **External**, a contact e-mail.
2. **Data access → Add or remove scopes**: add
   - `https://www.googleapis.com/auth/drive.appdata`
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`

   All three are non-sensitive: publishing needs only Google's basic verification.
3. **Audience → Test users**: add the Google accounts that will try it. While the app
   is in *Testing*, only these accounts can sign in (up to 100), and a sign-in
   expires after 7 days.

## 3. OAuth client

**Clients → Create client**: application type **Desktop app**, name `Memo desktop`.
Copy the **client ID** and **client secret**.

For desktop apps Google does not treat the secret as confidential (it ships inside
the app), but keep both out of the repository and of chats anyway: they are read
from the build environment.

## 4. Building with the client

The IDs are compiled in from two environment variables (`option_env!` in
`src-tauri/src/cloud.rs`):

| Variable | Value |
| --- | --- |
| `MEMO_GOOGLE_CLIENT_ID` | `….apps.googleusercontent.com` |
| `MEMO_GOOGLE_CLIENT_SECRET` | the client secret |

- **Local** (`npm run dev` / `npm run build`): set them in the shell first. PowerShell:
  `$env:MEMO_GOOGLE_CLIENT_ID="…"; $env:MEMO_GOOGLE_CLIENT_SECRET="…"`. Cargo
  rebuilds when they change.
- **Docker** (Windows installer): `docker/compose.yml` passes both through from the
  host shell.
- **GitHub Actions**: add them as repository secrets named `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` (Settings → Secrets and variables → Actions); `build.yml`
  passes them to the build as the two variables above.

## 5. Publishing

Before real users, move the app from *Testing* to *In production* (Audience →
Publish app). Google asks for a home page and a privacy policy on a domain you own
(a GitHub Pages site works), verified in Search Console. The privacy policy must
say what Memo accesses (its own hidden Drive folder and the account's e-mail), that
the memories go only to the user's own Drive, and that nobody else, the developer
included, receives them.

Both pages live in `site/` (English, with Portuguese under `site/pt/`) and are
published by `.github/workflows/pages.yml` once Settings → Pages → Source is
**GitHub Actions**:

| Field | URL |
| --- | --- |
| Application home page | `https://danielakio.github.io/memo/` |
| Privacy policy | `https://danielakio.github.io/memo/privacy.html` |
| Authorized domain | `danielakio.github.io` |

Search Console verifies `https://danielakio.github.io/` (URL-prefix property), which
needs the verification file at the root of that host, i.e. in a
`DanielAkio/danielakio.github.io` repository with Pages on. Keep the pages in step
with what the app accesses: a new scope means a new section in both policies.
