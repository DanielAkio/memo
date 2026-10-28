/// Build-time variables that may come from `.env` at the repository root
/// (see `.env.example`). A variable already set in the environment wins.
const DOTENV_VARS: &[&str] = &["MEMO_GOOGLE_CLIENT_ID", "MEMO_GOOGLE_CLIENT_SECRET", "MEMO_MICROSOFT_CLIENT_ID"];

fn main() {
    // The icons are embedded in the executable (window/taskbar icon and the
    // Windows .ico resource), but tauri-build doesn't watch the folder: without
    // this, changing an icon doesn't rebuild the app and it keeps the old one.
    println!("cargo:rerun-if-changed=icons");
    load_dotenv();
    tauri_build::build()
}

/// Passes the known variables from `../.env` to rustc, so `option_env!` sees
/// them. Plain `KEY=value` lines; `#` comments and surrounding quotes allowed.
fn load_dotenv() {
    println!("cargo:rerun-if-changed=../.env");
    for var in DOTENV_VARS {
        println!("cargo:rerun-if-env-changed={var}");
    }
    let Ok(text) = std::fs::read_to_string("../.env") else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !DOTENV_VARS.contains(&key) {
            continue;
        }
        if std::env::var(key).is_ok_and(|v| !v.is_empty()) {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        println!("cargo:rustc-env={key}={value}");
    }
}
