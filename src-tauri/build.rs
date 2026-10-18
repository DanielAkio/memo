fn main() {
    // The icons are embedded in the executable (window/taskbar icon and the
    // Windows .ico resource), but tauri-build doesn't watch the folder: without
    // this, changing an icon doesn't rebuild the app and it keeps the old one.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
