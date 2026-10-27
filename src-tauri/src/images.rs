//! Pasted images, kept as files next to `notes.json`.
//!
//! The editor works with images inline (`<img src="data:image/...">`), but
//! the store keeps each one once in `images/<hash>.<ext>` beside
//! `notes.json` and the note's HTML refers to it as `src="images/<name>"`.
//! So `notes.json` stays small and readable, each save doesn't rewrite
//! megabytes, and the cloud sync sends an image once instead of with every
//! edit of its note. Names are the start of the SHA-256 of the bytes: the
//! same image is one file, and a file never changes once written.
//!
//! `store_images` turns data URLs into references (on save, import and when
//! loading an old file), `inline_images` the other way (when a window loads a
//! note, and for exports, which stay one self-contained file). A reference to
//! a missing file is left as it is, so nothing is lost while the file is
//! still on its way from the cloud.

use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
};

/// Folder of the images, beside `notes.json`.
pub const FOLDER: &str = "images";

const DATA_PREFIX: &str = "src=\"data:image/";
const REF_PREFIX: &str = "src=\"images/";

/// (MIME subtype, file extension) of the accepted images (as in note.js).
const KINDS: [(&str, &str); 4] = [("png", "png"), ("jpeg", "jpg"), ("webp", "webp"), ("gif", "gif")];

/// The images folder for a `notes.json` path.
pub fn dir_for(notes: &Path) -> PathBuf {
    notes.parent().unwrap_or(Path::new(".")).join(FOLDER)
}

/// A valid image file name: hex hash + known extension (never a path).
pub fn is_name(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else { return false };
    hash.len() >= 16
        && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && KINDS.iter().any(|(_, e)| *e == ext)
}

/// MIME type of an image file name.
pub fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next() {
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/png",
    }
}

/// Calls `f` with each `src="<prefix>…"` value (without the prefix) and
/// replaces it with what `f` returns (`None` keeps it).
fn replace_srcs(html: &str, prefix: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(at) = rest.find(prefix) {
        let start = at + prefix.len();
        let Some(len) = rest[start..].find('"') else { break };
        let value = &rest[start..start + len];
        out.push_str(&rest[..at]);
        match f(value) {
            Some(src) => {
                out.push_str("src=\"");
                out.push_str(&src);
                out.push('"');
            }
            None => out.push_str(&rest[at..start + len + 1]),
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out
}

/// Names of the images an HTML refers to.
pub fn refs(html: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    replace_srcs(html, REF_PREFIX, |name| {
        if is_name(name) {
            names.insert(name.to_string());
        }
        None
    });
    names
}

/// Writes `bytes` as `dir/name` unless it is already there (same name =
/// same bytes), through a temporary file so a crash leaves no half image.
pub fn write(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    let path = dir.join(name);
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, &path)
}

/// Replaces inline images (data URLs) with references to files in `dir`,
/// writing the files. An image that can't be written stays inline.
pub fn store_images(html: &str, dir: &Path) -> String {
    if !html.contains(DATA_PREFIX) {
        return html.to_string();
    }
    replace_srcs(html, DATA_PREFIX, |value| {
        let (kind, data) = value.split_once(";base64,")?;
        let (_, ext) = KINDS.iter().find(|(k, _)| *k == kind)?;
        let bytes = STANDARD.decode(data).ok()?;
        let hash = Sha256::digest(&bytes);
        let hex: String = hash[..16].iter().map(|b| format!("{b:02x}")).collect();
        let name = format!("{hex}.{ext}");
        match write(dir, &name, &bytes) {
            Ok(()) => Some(format!("{FOLDER}/{name}")),
            Err(err) => {
                eprintln!("memo: failed to save image {name}: {err}");
                None
            }
        }
    })
}

/// Replaces references to files in `dir` with inline images (data URLs).
/// References to missing files are kept.
pub fn inline_images(html: &str, dir: &Path) -> String {
    if !html.contains(REF_PREFIX) {
        return html.to_string();
    }
    replace_srcs(html, REF_PREFIX, |name| {
        if !is_name(name) {
            return None;
        }
        let bytes = fs::read(dir.join(name)).ok()?;
        Some(format!("data:{};base64,{}", mime(name), STANDARD.encode(bytes)))
    })
}

/// Copies the images `html` refers to from `from` to `to` (missing ones are
/// skipped).
pub fn copy_refs(html: &str, from: &Path, to: &Path) -> io::Result<()> {
    if from == to {
        return Ok(());
    }
    for name in refs(html) {
        if let Ok(bytes) = fs::read(from.join(&name)) {
            write(to, &name, &bytes)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("memo-images-test-{}", crate::now_ms()));
        let url = format!("data:image/png;base64,{}", STANDARD.encode(b"not really a png"));
        let html = format!(r#"<div>a<img src="{url}" width="80"></div><div><img src="{url}"></div>"#);
        let stored = store_images(&html, &dir);
        assert!(!stored.contains("data:"));
        let names = refs(&stored);
        assert_eq!(names.len(), 1, "same image, one file");
        let name = names.iter().next().unwrap();
        assert!(is_name(name) && dir.join(name).exists());
        assert_eq!(inline_images(&stored, &dir), html);
        // A missing file keeps its reference; a bad name is never read.
        let missing = r#"<img src="images/0123456789abcdef0123456789abcdef.webp"><img src="images/../x.png">"#;
        assert_eq!(inline_images(missing, &dir), missing);
        assert_eq!(store_images("<b>no images</b>", &dir), "<b>no images</b>");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_file_export_and_import() {
        use crate::store::Store;
        let root = std::env::temp_dir().join(format!("memo-images-migrate-{}", crate::now_ms()));
        fs::create_dir_all(root.join("a")).unwrap();
        let url = format!("data:image/webp;base64,{}", STANDARD.encode(b"old inline image"));
        let html = format!(r#"<div><img src="{url}"></div>"#);
        let old = serde_json::json!({ "version": 1, "nextSeq": 2,
            "notes": [{ "id": "n1", "seq": 1, "text": "[image]", "html": html, "createdAt": 1, "updatedAt": 1 }] });
        fs::write(root.join("a/notes.json"), old.to_string()).unwrap();

        // An old notes.json: the image moves to a file, the old file is kept.
        let a = Store::load(root.join("a/notes.json"));
        let stored = a.get("n1").unwrap().html;
        assert_eq!(refs(&stored).len(), 1);
        assert_eq!(a.get("n1").unwrap().updated_at, 1, "not an edit");
        assert_eq!(a.inline_images(&stored), html);
        let backups = fs::read_dir(root.join("a")).unwrap().filter(|e| {
            e.as_ref().unwrap().file_name().to_string_lossy().starts_with("notes.backup-")
        });
        assert_eq!(backups.count(), 1);
        a.flush();
        assert!(!fs::read_to_string(root.join("a/notes.json")).unwrap().contains("data:image"));

        // An export carries the image inside; importing it elsewhere makes the file there.
        a.export_to(&root.join("export.json")).unwrap();
        assert!(fs::read_to_string(root.join("export.json")).unwrap().contains("data:image/webp"));
        fs::create_dir_all(root.join("b")).unwrap();
        let b = Store::load(root.join("b/notes.json"));
        b.import_from(&root.join("export.json")).unwrap();
        assert_eq!(b.get("n1").unwrap().html, stored);
        assert_eq!(b.inline_images(&stored), html);
        let _ = fs::remove_dir_all(&root);
    }
}
