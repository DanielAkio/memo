//! Cloud accounts for sync (Configurações → Sincronização): a Google account
//! (Google Drive), a Microsoft account (OneDrive), or both.
//!
//! Sign-in is OAuth 2.0 for desktop apps, the same for both: the system
//! browser opens the provider's consent page, which redirects to a one-shot
//! HTTP server on a random loopback port; the code is exchanged with PKCE.
//! The refresh token goes to the OS credential store (Windows Credential
//! Manager, macOS Keychain, Secret Service on Linux), never to a file. The
//! accounts' e-mails are kept in `config.json` (per machine).
//!
//! The OAuth clients come from the build environment
//! (`MEMO_GOOGLE_CLIENT_ID` / `MEMO_GOOGLE_CLIENT_SECRET`, see
//! docs/google-cloud.md; `MEMO_MICROSOFT_CLIENT_ID`, see docs/onedrive.md);
//! a build without one has no sync through that provider.
//!
//! Errors returned to the page are short codes (`ERR_*`) it translates.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// Credential store service holding the refresh tokens (one entry per
/// provider, `Provider::keyring_user`).
const KEYRING_SERVICE: &str = "Memo";

/// Where the memories are synced.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Provider {
    /// Google Drive, the app's hidden `appDataFolder`.
    Google,
    /// OneDrive, the app's folder (`Apps/Memo`).
    Microsoft,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Google, Provider::Microsoft];

    /// The name in `config.json` and for the pages.
    pub fn id(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Microsoft => "microsoft",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "google" => Some(Provider::Google),
            "microsoft" => Some(Provider::Microsoft),
            _ => None,
        }
    }

    /// The build's OAuth client, if it has one. Microsoft's is a public
    /// client: PKCE and no secret.
    fn client(self) -> Option<(&'static str, Option<&'static str>)> {
        match self {
            Provider::Google => {
                let id = option_env!("MEMO_GOOGLE_CLIENT_ID").filter(|s| !s.is_empty())?;
                let secret = option_env!("MEMO_GOOGLE_CLIENT_SECRET").filter(|s| !s.is_empty());
                Some((id, secret))
            }
            Provider::Microsoft => {
                let id = option_env!("MEMO_MICROSOFT_CLIENT_ID").filter(|s| !s.is_empty())?;
                Some((id, None))
            }
        }
    }

    /// This build can connect an account of this provider.
    pub fn available(self) -> bool {
        self.client().is_some()
    }

    fn auth_url(self) -> &'static str {
        match self {
            Provider::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            Provider::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }
    }

    fn token_url(self) -> &'static str {
        match self {
            Provider::Google => "https://oauth2.googleapis.com/token",
            Provider::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }

    /// Only the app's own folder (non-sensitive scopes), plus the e-mail to
    /// show which account is connected.
    fn scopes(self) -> &'static str {
        match self {
            Provider::Google => "https://www.googleapis.com/auth/drive.appdata openid email",
            Provider::Microsoft => "Files.ReadWrite.AppFolder User.Read offline_access",
        }
    }

    /// Microsoft only accepts `localhost` for a loopback redirect (any port).
    fn redirect_host(self) -> &'static str {
        match self {
            Provider::Google => "127.0.0.1",
            Provider::Microsoft => "localhost",
        }
    }

    /// Asks for a refresh token every time (an account that already
    /// consented on another computer gets one too), and lets the user pick
    /// the account.
    fn auth_params(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Provider::Google => &[("access_type", "offline"), ("prompt", "consent")],
            Provider::Microsoft => &[("prompt", "select_account")],
        }
    }

    fn keyring_user(self) -> &'static str {
        match self {
            Provider::Google => "google-drive",
            Provider::Microsoft => "onedrive",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Provider::Google => "Google",
            Provider::Microsoft => "Microsoft",
        }
    }

    /// The signed-in account's e-mail.
    async fn email(self, http: &reqwest::Client, token: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        struct Google {
            email: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Microsoft {
            mail: Option<String>,
            user_principal_name: Option<String>,
        }
        let url = match self {
            Provider::Google => "https://openidconnect.googleapis.com/v1/userinfo",
            Provider::Microsoft => "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
        };
        let response = http
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|_| ERR_NETWORK)?;
        Ok(match self {
            Provider::Google => response.json::<Google>().await.map_err(|_| ERR_NETWORK)?.email,
            Provider::Microsoft => {
                let me: Microsoft = response.json().await.map_err(|_| ERR_NETWORK)?;
                me.mail.or(me.user_principal_name).unwrap_or_else(|| "OneDrive".into())
            }
        })
    }
}

/// The providers this build can connect (`Provider::id`s).
pub fn providers() -> Vec<&'static str> {
    Provider::ALL.into_iter().filter(|p| p.available()).map(Provider::id).collect()
}

/// How long the browser sign-in may take before giving up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

pub const ERR_UNAVAILABLE: &str = "unavailable";
pub const ERR_BUSY: &str = "busy";
pub const ERR_CANCELLED: &str = "cancelled";
pub const ERR_TIMEOUT: &str = "timeout";
pub const ERR_DENIED: &str = "denied";
pub const ERR_NETWORK: &str = "network";
pub const ERR_KEYRING: &str = "keyring";
/// The sign-in is no longer valid (revoked, or expired: in Google's
/// "Testing" mode a sign-in lasts 7 days). The user connects again.
pub const ERR_REAUTH: &str = "reauth";

/// A sign-in is waiting for the browser.
static SIGNING_IN: AtomicBool = AtomicBool::new(false);
/// Set by `cancel_sign_in`; the waiting loop checks it.
static CANCEL: AtomicBool = AtomicBool::new(false);


pub fn random_b64(len: usize) -> String {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).expect("no OS random source");
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct RefreshResponse {
    access_token: String,
    expires_in: u64,
    /// Microsoft sends a new one with every refresh.
    refresh_token: Option<String>,
}

/// Current access tokens: provider, token, when it expires.
static ACCESS: Mutex<Vec<(Provider, String, Instant)>> = Mutex::new(Vec::new());

/// An access token for the provider's API, refreshed from the stored
/// sign-in when the cached one is about to expire.
pub async fn access_token(provider: Provider) -> Result<String, String> {
    let cached = ACCESS.lock().unwrap().iter().find(|(p, ..)| *p == provider).cloned();
    if let Some((_, token, expires)) = cached {
        if expires > Instant::now() + Duration::from_secs(60) {
            return Ok(token);
        }
    }
    let (client_id, client_secret) = provider.client().ok_or(ERR_UNAVAILABLE)?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider.keyring_user()).map_err(|_| ERR_REAUTH)?;
    let refresh = entry.get_password().map_err(|_| ERR_REAUTH)?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(provider.token_url())
        .form(&form)
        .send()
        .await
        .map_err(|_| ERR_NETWORK)?;
    // 400 invalid_grant / 401: the sign-in was revoked or expired.
    if matches!(response.status().as_u16(), 400 | 401) {
        return Err(ERR_REAUTH.into());
    }
    let tokens: RefreshResponse = response
        .error_for_status()
        .map_err(|_| ERR_NETWORK)?
        .json()
        .await
        .map_err(|_| ERR_NETWORK)?;
    if let Some(rotated) = tokens.refresh_token.as_deref().filter(|r| *r != refresh) {
        if let Err(err) = entry.set_password(rotated) {
            eprintln!("memo: can't store the {} sign-in: {err}", provider.name());
        }
    }
    let expires = Instant::now() + Duration::from_secs(tokens.expires_in);
    let mut access = ACCESS.lock().unwrap();
    access.retain(|(p, ..)| *p != provider);
    access.push((provider, tokens.access_token.clone(), expires));
    Ok(tokens.access_token)
}

/// Drops the cached access tokens (after a 401, or on sign-out).
pub fn forget_access_token() {
    ACCESS.lock().unwrap().clear();
}

/// Signs in with the browser, stores the refresh token and returns the
/// account's e-mail.
pub async fn sign_in(app: &AppHandle, provider: Provider, lang: &'static str) -> Result<String, String> {
    let (client_id, client_secret) = provider.client().ok_or(ERR_UNAVAILABLE)?;
    if SIGNING_IN.swap(true, Ordering::SeqCst) {
        return Err(ERR_BUSY.into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = sign_in_inner(app, provider, lang, client_id, client_secret).await;
    SIGNING_IN.store(false, Ordering::SeqCst);
    result
}

async fn sign_in_inner(
    app: &AppHandle,
    provider: Provider,
    lang: &'static str,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://{}:{port}", provider.redirect_host());
    let verifier = random_b64(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);

    let mut params = vec![
        ("client_id", client_id),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", provider.scopes()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
    ];
    params.extend_from_slice(provider.auth_params());
    let url = reqwest::Url::parse_with_params(provider.auth_url(), &params).map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;

    let name = provider.name();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state, lang, name))
        .await
        .map_err(|e| e.to_string())??;

    let mut form = vec![
        ("code", code.as_str()),
        ("client_id", client_id),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect.as_str()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let http = http()?;
    let tokens: TokenResponse = http
        .post(provider.token_url())
        .form(&form)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| ERR_NETWORK)?
        .json()
        .await
        .map_err(|_| ERR_NETWORK)?;
    let refresh = tokens.refresh_token.ok_or(ERR_DENIED)?;
    let email = provider.email(&http, &tokens.access_token).await?;

    keyring::Entry::new(KEYRING_SERVICE, provider.keyring_user())
        .and_then(|entry| entry.set_password(&refresh))
        .map_err(|err| {
            eprintln!("memo: can't store the {} sign-in: {err}", provider.name());
            ERR_KEYRING
        })?;
    forget_access_token();
    Ok(email)
}

/// Stops a sign-in waiting for the browser.
pub fn cancel_sign_in() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Accepts connections on the loopback server until the provider's
/// redirect arrives (other requests, like a favicon, get a 404), the user
/// cancels or the time runs out. Returns the authorization code.
fn wait_for_code(listener: TcpListener, state: &str, lang: &str, provider: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(ERR_CANCELLED.into());
        }
        if Instant::now() > deadline {
            return Err(ERR_TIMEOUT.into());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(err) => return Err(err.to_string()),
        };
        let Some(query) = read_query(&mut stream) else {
            respond(&mut stream, "404 Not Found", "");
            continue;
        };
        let get = |key: &str| {
            query
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_str())
        };
        if get("state") != Some(state) {
            respond(&mut stream, "400 Bad Request", "");
            continue;
        }
        let code = get("code").map(str::to_string);
        respond(&mut stream, "200 OK", &done_page(lang, provider, code.is_some()));
        return code.ok_or_else(|| ERR_DENIED.into());
    }
}

/// The query of a `GET /?…` request, if it is one.
fn read_query(stream: &mut TcpStream) -> Option<Vec<(String, String)>> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).ok()?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let target = request.lines().next()?.strip_prefix("GET ")?.split(' ').next()?;
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    (url.path() == "/" && url.query().is_some())
        .then(|| url.query_pairs().into_owned().collect())
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// The page the browser shows after the redirect.
fn done_page(lang: &str, provider: &str, ok: bool) -> String {
    let (title, text) = match (lang, ok) {
        ("pt", true) => ("Memo conectado", format!("Sua conta {provider} foi conectada ao Memo. Pode fechar esta aba.")),
        ("pt", false) => ("Memo não conectado", "O acesso não foi permitido. Pode fechar esta aba e tentar de novo no Memo.".into()),
        (_, true) => ("Memo connected", format!("Your {provider} account is now connected to Memo. You can close this tab.")),
        (_, false) => ("Memo not connected", "Access was not allowed. You can close this tab and try again in Memo.".into()),
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:system-ui,sans-serif;background:#0f1011;color:#f7f8f8;\
         display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"max-width:420px;text-align:center\"><h1 style=\"font-weight:500;font-size:20px\">{title}</h1>\
         <p style=\"color:#8a8f98\">{text}</p></div></body></html>"
    )
}

/// Forgets the account on this computer by removing its token from the
/// credential store. The token is not revoked at the provider: that would
/// revoke the grant itself and disconnect the user's other computers too.
pub fn sign_out(provider: Provider) {
    forget_access_token();
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, provider.keyring_user()) {
        let _ = entry.delete_credential();
    }
}
