//! AI control setup: adds Memo (`<executable> --mcp`, see `mcp.rs`) to the
//! MCP clients found on this computer by editing their config files, so
//! connecting is one click in Settings instead of copy and paste.
//!
//! Every client keeps its servers under one key of a JSON file
//! (`mcpServers`, or `servers` in VS Code), except Codex (TOML). Only Memo's
//! own entry (`memo`) is added, updated or removed; the rest of the file is
//! kept. Before the first change Memo copies the file to
//! `<name>.before-memo`, and it writes atomically. A file it can't read
//! (comments, invalid JSON) is left alone: the user copies the setup instead.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::{json, Map, Value};

/// The entry Memo adds to a client's servers.
const KEY: &str = "memo";

/// How a client stores its servers.
#[derive(Clone, Copy)]
enum Format {
    /// `{ "mcpServers": { "memo": { "command", "args" } } }`.
    McpServers,
    /// Same, with `"type": "stdio"` (Claude Code).
    McpServersTyped,
    /// VS Code: `{ "servers": { "memo": { "type": "stdio", … } } }`.
    Servers,
    /// Codex: a `[mcp_servers.memo]` table in `config.toml`.
    Toml,
}

struct Client {
    id: &'static str,
    name: &'static str,
    /// The config file.
    file: PathBuf,
    /// A folder that exists once the client is installed (or has run).
    marker: PathBuf,
    format: Format,
}

/// A client as Settings shows it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    id: &'static str,
    name: &'static str,
    /// Memo's entry is there.
    connected: bool,
    /// …and launches this executable (not, say, an older build's).
    current: bool,
    /// The config file exists but isn't readable (comments, invalid JSON).
    unreadable: bool,
}

fn home() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = "USERPROFILE";
    #[cfg(not(windows))]
    let var = "HOME";
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_absolute())
}

/// Where desktop apps keep their settings: `%APPDATA%`, `~/Library/Application
/// Support`, `$XDG_CONFIG_HOME` (`~/.config`).
fn config_dir(home: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home.join("AppData/Roaming"))
    }
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support")
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
    }
}

/// Claude Desktop's folder. The Microsoft Store build reads `%APPDATA%`
/// through its package's private copy, so that one wins when present.
fn claude_desktop_dir(config: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let packages = PathBuf::from(local).join("Packages");
        if let Ok(entries) = fs::read_dir(&packages) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("Claude_") {
                    let dir = entry.path().join("LocalCache/Roaming/Claude");
                    if dir.is_dir() {
                        return dir;
                    }
                }
            }
        }
    }
    config.join("Claude")
}

fn clients() -> Vec<Client> {
    let Some(home) = home() else { return Vec::new() };
    let config = config_dir(&home);
    let code = config.join("Code/User");
    let claude = claude_desktop_dir(&config);
    let cline = code.join("globalStorage/saoudrizwan.claude-dev");
    let client = |id, name, file: PathBuf, marker: PathBuf, format| Client { id, name, file, marker, format };
    vec![
        client("claude-desktop", "Claude Desktop", claude.join("claude_desktop_config.json"), claude, Format::McpServers),
        client("claude-code", "Claude Code", home.join(".claude.json"), home.join(".claude"), Format::McpServersTyped),
        client("vscode", "VS Code (GitHub Copilot)", code.join("mcp.json"), code.clone(), Format::Servers),
        client("cursor", "Cursor", home.join(".cursor/mcp.json"), home.join(".cursor"), Format::McpServers),
        client(
            "windsurf",
            "Windsurf",
            home.join(".codeium/windsurf/mcp_config.json"),
            home.join(".codeium/windsurf"),
            Format::McpServers,
        ),
        client("gemini", "Gemini CLI", home.join(".gemini/settings.json"), home.join(".gemini"), Format::McpServers),
        client(
            "cline",
            "Cline CLI",
            home.join(".cline/data/settings/cline_mcp_settings.json"),
            home.join(".cline"),
            Format::McpServers,
        ),
        client(
            "cline-vscode",
            "Cline (VS Code)",
            cline.join("settings/cline_mcp_settings.json"),
            cline,
            Format::McpServers,
        ),
        client("codex", "Codex", home.join(".codex/config.toml"), home.join(".codex"), Format::Toml),
    ]
}

/// The installed clients and whether each one has Memo.
pub fn list(exe: &str) -> Vec<Status> {
    clients()
        .into_iter()
        .filter(|c| c.marker.is_dir() || c.file.is_file())
        .map(|c| {
            let (connected, current, unreadable) = match read(&c.file) {
                Ok(text) => match entry(c.format, &text) {
                    Some(found) => (found.is_some(), found.is_some_and(|cmd| cmd == exe), false),
                    None => (false, false, true),
                },
                Err(_) => (false, false, false),
            };
            Status { id: c.id, name: c.name, connected, current, unreadable }
        })
        .collect()
}

/// Adds (or points at `exe`) Memo's entry in client `id`'s config, or
/// removes it.
pub fn connect(id: &str, exe: &str, on: bool) -> Result<(), String> {
    let client = clients().into_iter().find(|c| c.id == id).ok_or("unknown MCP client")?;
    let text = match read(&client.file) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        other => other.map_err(|e| e.to_string())?,
    };
    let next = edit(client.format, &text, exe, on).ok_or("unreadable MCP client config")?;
    if next == text {
        return Ok(());
    }
    write(&client.file, &next).map_err(|e| e.to_string())
}

fn read(file: &Path) -> io::Result<String> {
    fs::read_to_string(file)
}

/// Keeps the original once (`<name>.before-memo`), then replaces the file
/// through a temporary one.
fn write(file: &Path, text: &str) -> io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let backup = file.with_file_name(format!("{name}.before-memo"));
    if file.is_file() && !backup.exists() {
        fs::copy(file, &backup)?;
    }
    let tmp = file.with_file_name(format!("{name}.memo-tmp"));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, file)
}

/// The command of Memo's entry: `Some(None)` when there is none, `None` when
/// the file can't be read.
fn entry(format: Format, text: &str) -> Option<Option<String>> {
    if let Format::Toml = format {
        return Some(toml_block(text).map(|(start, end)| {
            text[start..end]
                .lines()
                .find_map(|l| l.trim().strip_prefix("command").map(|v| v.trim().trim_start_matches('=').trim()))
                .map(toml_unquote)
                .unwrap_or_default()
        }));
    }
    let doc = parse(text)?;
    Some(
        doc.get(servers_key(format))
            .and_then(|s| s.get(KEY))
            .map(|e| e.get("command").and_then(Value::as_str).unwrap_or_default().to_string()),
    )
}

fn servers_key(format: Format) -> &'static str {
    match format {
        Format::Servers => "servers",
        _ => "mcpServers",
    }
}

/// The file's JSON object; an empty file counts as `{}`.
fn parse(text: &str) -> Option<Map<String, Value>> {
    if text.trim().is_empty() {
        return Some(Map::new());
    }
    match serde_json::from_str(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// The file's text with Memo's entry set to `exe` (or removed); `None` when
/// the file can't be read.
fn edit(format: Format, text: &str, exe: &str, on: bool) -> Option<String> {
    let crlf = text.contains("\r\n");
    let next = match format {
        Format::Toml => toml_edit(text, exe, on),
        _ => {
            let mut doc = parse(text)?;
            let key = servers_key(format);
            let servers = doc.entry(key).or_insert_with(|| json!({}));
            let servers = servers.as_object_mut()?;
            if on {
                let mut server = Map::new();
                if !matches!(format, Format::McpServers) {
                    server.insert("type".into(), json!("stdio"));
                }
                server.insert("command".into(), json!(exe));
                server.insert("args".into(), json!([crate::mcp::ARG]));
                servers.insert(KEY.into(), Value::Object(server));
            } else {
                servers.remove(KEY);
                if servers.is_empty() {
                    doc.remove(key);
                }
            }
            serde_json::to_string_pretty(&doc).ok()? + "\n"
        }
    };
    Some(if crlf { next.replace("\r\n", "\n").replace('\n', "\r\n") } else { next })
}

/// Byte range of the `[mcp_servers.memo]` table (with its subtables).
fn toml_block(text: &str) -> Option<(usize, usize)> {
    let header = format!("[mcp_servers.{KEY}]");
    let sub = format!("[mcp_servers.{KEY}.");
    let mut start = None;
    let mut at = 0;
    for line in text.split_inclusive('\n') {
        let head = line.trim();
        if start.is_none() {
            if head == header {
                start = Some(at);
            }
        } else if head.starts_with('[') && !head.starts_with(&sub) {
            return start.map(|s| (s, at));
        }
        at += line.len();
    }
    start.map(|s| (s, text.len()))
}

fn toml_edit(text: &str, exe: &str, on: bool) -> String {
    let mut out = text.to_string();
    if let Some((start, end)) = toml_block(text) {
        out.replace_range(start..end, "");
    }
    if on {
        let quoted = if exe.contains('\'') {
            format!("\"{}\"", exe.replace('\\', "\\\\").replace('"', "\\\""))
        } else {
            format!("'{exe}'")
        };
        let trimmed = out.trim_end().len();
        out.truncate(trimmed);
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("[mcp_servers.{KEY}]\ncommand = {quoted}\nargs = [\"{}\"]\n", crate::mcp::ARG));
    }
    out
}

/// A TOML string value without its quotes (literal or basic).
fn toml_unquote(value: &str) -> String {
    if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.split('\'').next()) {
        return inner.to_string();
    }
    let Some(inner) = value.strip_prefix('"') else { return value.to_string() };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => break,
            '\\' => {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Program Files\Memo\memo.exe";

    #[test]
    fn json_keeps_other_servers() {
        let text = "{\r\n  \"theme\": 1,\r\n  \"mcpServers\": { \"x\": { \"command\": \"x\" } }\r\n}";
        let on = edit(Format::McpServers, text, EXE, true).unwrap();
        assert!(on.contains("\r\n"));
        assert_eq!(entry(Format::McpServers, &on), Some(Some(EXE.to_string())));
        let doc: Value = serde_json::from_str(&on).unwrap();
        assert_eq!(doc["mcpServers"]["x"]["command"], "x");
        assert_eq!(doc["theme"], 1);
        let off = edit(Format::McpServers, &on, EXE, false).unwrap();
        assert_eq!(entry(Format::McpServers, &off), Some(None));
        assert_eq!(serde_json::from_str::<Value>(&off).unwrap()["mcpServers"]["x"]["command"], "x");
    }

    #[test]
    fn json_new_and_unreadable() {
        let on = edit(Format::Servers, "", EXE, true).unwrap();
        let doc: Value = serde_json::from_str(&on).unwrap();
        assert_eq!(doc["servers"]["memo"]["type"], "stdio");
        assert_eq!(doc["servers"]["memo"]["args"][0], "--mcp");
        let off = edit(Format::Servers, &on, EXE, false).unwrap();
        assert_eq!(off.trim(), "{}");
        assert!(edit(Format::McpServers, "{ // comment\n}", EXE, true).is_none());
        assert_eq!(entry(Format::McpServers, "{ // comment\n}"), None);
    }

    #[test]
    fn toml() {
        let text = "model = \"o3\"\n\n[mcp_servers.memo]\ncommand = \"old\"\n\n[mcp_servers.memo.env]\nA = \"1\"\n\n[mcp_servers.x]\ncommand = \"x\"\n";
        assert_eq!(entry(Format::Toml, text), Some(Some("old".into())));
        let on = toml_edit(text, EXE, true);
        assert_eq!(entry(Format::Toml, &on), Some(Some(EXE.to_string())));
        assert!(on.contains("[mcp_servers.x]\ncommand = \"x\"") && on.starts_with("model = \"o3\""));
        assert!(!on.contains("old") && !on.contains("A = \"1\""));
        let off = toml_edit(&on, EXE, false);
        assert_eq!(entry(Format::Toml, &off), Some(None));
        assert!(off.contains("[mcp_servers.x]"));
        assert_eq!(entry(Format::Toml, &toml_edit("", "/a'b", true)), Some(Some("/a'b".into())));
    }
}
