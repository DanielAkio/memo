//! Google account for cloud sync (Configurações → Sincronização).
//!
//! Sign-in is OAuth 2.0 for desktop apps: the system browser opens Google's
//! consent page, which redirects to a one-shot HTTP server on
//! `127.0.0.1:<random port>`; the code is exchanged with PKCE. The refresh
//! token goes to the OS credential store (Windows Credential Manager, macOS
//! Keychain, Secret Service on Linux), never to a file. The account's e-mail
//! is kept in `config.json` (per machine).
//!
//! The OAuth client comes from the build environment
//! (`MEMO_GOOGLE_CLIENT_ID` / `MEMO_GOOGLE_CLIENT_SECRET`, see
//! docs/google-cloud.md); a build without it has no cloud sync.
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

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
/// Only the app's own hidden folder in the user's Drive (a non-sensitive
/// scope), plus the e-mail to show which account is connected.
const SCOPES: &str = "https://www.googleapis.com/auth/drive.appdata openid email";

/// Credential store entry holding the refresh token.
const KEYRING_SERVICE: &str = "Memo";
const KEYRING_USER: &str = "google-drive";

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

/// The build's OAuth client, if it has one.
fn client() -> Option<(&'static str, Option<&'static str>)> {
    let id = option_env!("MEMO_GOOGLE_CLIENT_ID").filter(|s| !s.is_empty())?;
    let secret = option_env!("MEMO_GOOGLE_CLIENT_SECRET").filter(|s| !s.is_empty());
    Some((id, secret))
}

/// This build can connect a Google account.
pub fn available() -> bool {
    client().is_some()
}

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
}

/// Current access token and when it expires.
static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// An access token for the Drive API, refreshed from the stored sign-in
/// when the cached one is about to expire.
pub async fn access_token() -> Result<String, String> {
    if let Some((token, expires)) = ACCESS.lock().unwrap().clone() {
        if expires > Instant::now() + Duration::from_secs(60) {
            return Ok(token);
        }
    }
    let (client_id, client_secret) = client().ok_or(ERR_UNAVAILABLE)?;
    let refresh = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|entry| entry.get_password())
        .map_err(|_| ERR_REAUTH)?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", client_id),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(TOKEN_URL)
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
    let expires = Instant::now() + Duration::from_secs(tokens.expires_in);
    *ACCESS.lock().unwrap() = Some((tokens.access_token.clone(), expires));
    Ok(tokens.access_token)
}

/// Drops the cached access token (after a 401, or on sign-out).
pub fn forget_access_token() {
    *ACCESS.lock().unwrap() = None;
}

#[derive(Deserialize)]
struct UserInfo {
    email: String,
}

/// Signs in with the browser, stores the refresh token and returns the
/// account's e-mail.
pub async fn sign_in(app: &AppHandle, lang: &'static str) -> Result<String, String> {
    let (client_id, client_secret) = client().ok_or(ERR_UNAVAILABLE)?;
    if SIGNING_IN.swap(true, Ordering::SeqCst) {
        return Err(ERR_BUSY.into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = sign_in_inner(app, lang, client_id, client_secret).await;
    SIGNING_IN.store(false, Ordering::SeqCst);
    result
}

async fn sign_in_inner(
    app: &AppHandle,
    lang: &'static str,
    client_id: &str,
    client_secret: Option<&str>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_b64(32);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);

    let url = reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            // Always return a refresh token, even for an account that
            // already consented on another computer.
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &state, lang))
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
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| ERR_NETWORK)?
        .json()
        .await
        .map_err(|_| ERR_NETWORK)?;
    let refresh = tokens.refresh_token.ok_or(ERR_DENIED)?;
    let user: UserInfo = http
        .get(USERINFO_URL)
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|_| ERR_NETWORK)?
        .json()
        .await
        .map_err(|_| ERR_NETWORK)?;

    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|entry| entry.set_password(&refresh))
        .map_err(|err| {
            eprintln!("memo: can't store the Google sign-in: {err}");
            ERR_KEYRING
        })?;
    forget_access_token();
    Ok(user.email)
}

/// Stops a sign-in waiting for the browser.
pub fn cancel_sign_in() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Accepts connections on the loopback server until Google's redirect
/// arrives (other requests, like a favicon, get a 404), the user cancels or
/// the time runs out. Returns the authorization code.
fn wait_for_code(listener: TcpListener, state: &str, lang: &str) -> Result<String, String> {
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
        respond(&mut stream, "200 OK", &done_page(lang, code.is_some()));
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
fn done_page(lang: &str, ok: bool) -> String {
    let (title, text) = match (lang, ok) {
        ("pt", true) => ("Memo conectado", "Sua conta Google foi conectada ao Memo. Pode fechar esta aba."),
        ("pt", false) => ("Memo não conectado", "O acesso não foi permitido. Pode fechar esta aba e tentar de novo no Memo."),
        (_, true) => ("Memo connected", "Your Google account is now connected to Memo. You can close this tab."),
        (_, false) => ("Memo not connected", "Access was not allowed. You can close this tab and try again in Memo."),
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
/// credential store. The token is not revoked at Google: that would revoke
/// the grant itself and disconnect the user's other computers too.
pub fn sign_out() {
    forget_access_token();
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_credential();
    }
}
