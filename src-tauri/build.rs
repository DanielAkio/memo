fn main() {
    // Os ícones entram no executável (ícone da janela/taskbar e recurso .ico do
    // Windows), mas o tauri-build não observa a pasta: sem isto, trocar um
    // ícone não recompila o app e ele continua com o antigo.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
