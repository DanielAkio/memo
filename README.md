# Memo

**Memórias adesivas que você fixa por cima de tudo.**
*Sticky memories you pin on top of everything.*

[Português](#português) · [English](#english) · [Para desenvolvedores / For developers](#for-developers)

---

## Português

O Memo é um app de notas adesivas para **Windows, macOS e Linux**. Cada memória é uma janelinha própria na sua tela
e, com **um clique no alfinete**, ela fica por cima de qualquer outro programa: a lista de tarefas ao lado da
planilha, o comando que você sempre esquece em cima do terminal, o recado que não pode sumir atrás do navegador.
É gratuito, de código aberto e funciona totalmente offline.

### O que ele faz

- **Fixar por cima de tudo**: o alfinete no canto da memória (ou `Ctrl+Shift+P`) a mantém sempre visível.
- **Escrita rápida e formatada**: listas de tarefas com `[]`, marcadores com `- `, negrito, itálico, sublinhado,
  marca-texto, três tamanhos de texto e blocos de código com destaque de sintaxe.
- **Cores e títulos**: dê um nome e uma cor a cada memória para achá-la de relance.
- **Grupos**: junte memórias numa barrinha, guarde todas de uma vez e tire-as de volta onde estavam.
- **Organização na tela**: arraste e ela gruda nas bordas e nas outras memórias; empurre contra a borda da tela para
  encaixar em meia tela, num quarto ou em tela cheia.
- **Gerenciador**: veja, busque e ordene todas as memórias e grupos; restaure da lixeira por até 30 dias.
- **Seus dados ficam com você**: tudo é salvo automaticamente no seu computador. Dá para escolher outra pasta
  (por exemplo do Dropbox ou OneDrive) e exportar ou importar um backup.
- **Do seu jeito**: tema claro ou escuro, tamanho do texto, cor e texto padrão das novas memórias, e iniciar com o
  sistema.
- Interface em **português e inglês**.

### Baixar

Os instaladores ficam na página de **[Releases](https://github.com/DanielAkio/memo/releases)**. Escolha o arquivo
do seu sistema:

| Sistema | Arquivo |
| --- | --- |
| Windows 10/11 | `…-setup.exe` (recomendado) ou `.msi` |
| macOS com Apple Silicon (M1, M2…) | `.dmg` com `aarch64` no nome |
| macOS com Intel | `.dmg` com `x64` no nome |
| Linux (Ubuntu, Debian, Mint…) | `.deb` |
| Linux (Fedora, openSUSE…) | `.rpm` |
| Linux (qualquer distribuição) | `.AppImage` |

> Ainda não há uma versão publicada? Ela está a caminho: acompanhe a página de Releases (no GitHub, **Watch →
> Custom → Releases** avisa quando sair).

### Primeira abertura

Os instaladores ainda **não são assinados digitalmente**, então o sistema pode desconfiar na primeira vez. É
esperado e só acontece uma vez:

- **Windows**: se o SmartScreen mostrar "O Windows protegeu o computador", clique em **Mais informações → Executar
  assim mesmo**. O instalador pergunta se o Memo deve iniciar com o sistema.
- **macOS**: arraste o Memo para Aplicativos. Na primeira vez, clique com o botão direito no app → **Abrir**; se o
  macOS bloquear mesmo assim, vá em **Ajustes do Sistema → Privacidade e Segurança** e clique em **Abrir Mesmo
  Assim**. Se aparecer "o app está danificado", rode `xattr -cr /Applications/Memo.app` no Terminal e abra de novo.
- **Linux**: instale o `.deb` ou o `.rpm` pelo gerenciador de pacotes, ou torne o `.AppImage` executável
  (`chmod +x Memo*.AppImage`) e abra-o.

Ao abrir, o Memo mostra o **Gerenciador do Memo** e uma memória de boas-vindas que explica o básico. Fechar a última
memória não encerra o app: ele continua no ícone da bandeja (barra de menus, no Mac).

### Primeiros passos

| Para… | Faça |
| --- | --- |
| Criar uma memória | Botão `+`, `Ctrl+N` (`⌘N` no Mac) ou o ícone do Memo na bandeja |
| Fixar por cima de tudo | Clique no alfinete à esquerda da barra de título, ou `Ctrl+Shift+P` (`⌘⇧P`) |
| Dar um título | Clique duas vezes na barra de título; `Enter` salva, `Esc` cancela |
| Mudar a cor | Clique na bolinha colorida ao lado do título |
| Lista de tarefas | Digite `[]` no começo da linha; clique na caixinha para marcar |
| Lista com marcadores | Digite `- ` no começo da linha; `Tab` / `Shift+Tab` mudam o recuo |
| Formatar | Selecione o texto e use a barra que aparece, ou `Ctrl+B`, `Ctrl+I`, `Ctrl+U`, `Ctrl+Shift+H` |
| Código | `` `texto` `` para código na linha; ` ```sql ` + `Enter` abre um bloco de código |
| Fechar | `✕` ou clique com o botão do meio na barra de título; ela continua no Gerenciador, de onde você reabre |
| Apagar | Só pelo botão de lixeira do Gerenciador (dá para restaurar por 30 dias) |
| Agrupar | No Gerenciador, botão de pasta com `+`, ou "Novo grupo" no rodapé de uma memória; depois solte memórias na barra |
| Ver tudo, buscar, ajustar | Gerenciador do Memo: abas Memórias, Grupos, Configurações e Ajuda |
| Sair | Ícone da bandeja → Sair do Memo |

A aba **Ajuda** do Gerenciador tem um guia completo de cada recurso, com demonstrações e atalhos.

### Onde ficam suas memórias

Tudo é salvo sozinho, no seu computador:

- Windows: `%APPDATA%\memo\`
- macOS: `~/Library/Application Support/memo/`
- Linux: `~/.local/share/memo/`

Em **Configurações → Armazenamento** você pode trocar a pasta (uma pasta sincronizada do Dropbox ou OneDrive leva
as memórias para outros computadores), exportar um backup `.json` e importá-lo de volta.

### Linux e Wayland

O Wayland não deixa um app se colocar "sempre por cima". Por isso o Memo roda via XWayland automaticamente, e o
alfinete funciona no GNOME, KDE e afins.

### Encontrou um problema ou tem uma ideia?

Toda sugestão e relato de bug ajuda o Memo a melhorar:

- **[Reportar um bug](https://github.com/DanielAkio/memo/issues/new?template=bug_report.yml)**: conte o que você fez,
  o que esperava e o que aconteceu, e qual sistema e versão do Memo você usa.
- **[Sugerir uma melhoria](https://github.com/DanielAkio/memo/issues/new?template=feature_request.yml)**: descreva a
  ideia e o problema que ela resolve.

Antes de abrir, dê uma olhada nas [issues já abertas](https://github.com/DanielAkio/memo/issues): se alguém já pediu
o mesmo, um 👍 nela já ajuda. É preciso uma conta gratuita do GitHub. Pode escrever em português ou em inglês.

---

## English

Memo is a sticky-notes app for **Windows, macOS and Linux**. Each memory is its own little window on your screen,
and **one click on the pin** keeps it on top of every other app: the to-do list next to the spreadsheet, the command
you always forget above the terminal, the reminder that must not hide behind the browser. It is free, open source and
works fully offline.

### What it does

- **Pin on top of everything**: the pin in the memory's corner (or `Ctrl+Shift+P`) keeps it always visible.
- **Quick, formatted writing**: checklists with `[]`, bullets with `- `, bold, italic, underline, highlight, three
  text sizes and code blocks with syntax highlighting.
- **Colours and titles**: name and colour each memory to find it at a glance.
- **Groups**: gather memories in a small bar, put them all away at once and take them back out where they were.
- **Tidy screen**: drag a memory and it snaps to screen edges and other memories; push it against a screen edge to
  fit it to half, a quarter or the whole screen.
- **Manager**: see, search and sort every memory and group; restore from the trash for up to 30 days.
- **Your data stays with you**: everything is saved automatically on your computer. You can choose another folder
  (a Dropbox or OneDrive one, for example) and export or import a backup.
- **Your way**: light or dark theme, text size, default colour and text for new memories, and start with the system.
- Interface in **English and Portuguese**.

### Download

Installers are on the **[Releases](https://github.com/DanielAkio/memo/releases)** page. Pick the file for your
system:

| System | File |
| --- | --- |
| Windows 10/11 | `…-setup.exe` (recommended) or `.msi` |
| macOS on Apple Silicon (M1, M2…) | `.dmg` with `aarch64` in its name |
| macOS on Intel | `.dmg` with `x64` in its name |
| Linux (Ubuntu, Debian, Mint…) | `.deb` |
| Linux (Fedora, openSUSE…) | `.rpm` |
| Linux (any distribution) | `.AppImage` |

> No release yet? One is on its way: on GitHub, **Watch → Custom → Releases** tells you when it is out.

### First launch

The installers are **not code-signed** yet, so your system may be wary the first time. That is expected and only
happens once:

- **Windows**: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**. The installer asks
  whether Memo should start with the system.
- **macOS**: drag Memo to Applications. The first time, right-click the app → **Open**; if macOS still blocks it, go
  to **System Settings → Privacy & Security** and click **Open Anyway**. If it says the app "is damaged", run
  `xattr -cr /Applications/Memo.app` in Terminal and open it again.
- **Linux**: install the `.deb` or `.rpm` with your package manager, or make the `.AppImage` executable
  (`chmod +x Memo*.AppImage`) and run it.

On launch, Memo shows the **Memo Manager** and a welcome memory that explains the basics. Closing the last memory
doesn't quit the app: it stays in the tray (the menu bar, on Mac).

### Getting started

| To… | Do |
| --- | --- |
| Create a memory | The `+` button, `Ctrl+N` (`⌘N` on Mac) or the Memo tray icon |
| Pin it on top of everything | Click the pin on the left of the titlebar, or `Ctrl+Shift+P` (`⌘⇧P`) |
| Give it a title | Double-click the titlebar; `Enter` saves, `Esc` cancels |
| Change its colour | Click the coloured dot next to the title |
| Checklist | Type `[]` at the start of a line; click the box to check it |
| Bulleted list | Type `- ` at the start of a line; `Tab` / `Shift+Tab` change the indent |
| Format | Select text and use the bar that appears, or `Ctrl+B`, `Ctrl+I`, `Ctrl+U`, `Ctrl+Shift+H` |
| Code | `` `text` `` for inline code; ` ```sql ` + `Enter` opens a code block |
| Close | `✕` or a middle click on the titlebar; it stays in the Manager, where you reopen it |
| Delete | Only with the Manager's trash button (restorable for 30 days) |
| Group | In the Manager, the folder-with-`+` button, or "New group" in a memory's footer; then drop memories on the bar |
| See everything, search, settings | Memo Manager: Memories, Groups, Settings and Help tabs |
| Quit | Tray icon → Quit Memo |

The Manager's **Help** tab has a full guide to every feature, with demos and shortcuts.

### Where your memories live

Everything is saved automatically, on your computer:

- Windows: `%APPDATA%\memo\`
- macOS: `~/Library/Application Support/memo/`
- Linux: `~/.local/share/memo/`

In **Settings → Storage** you can change the folder (a synced Dropbox or OneDrive folder takes your memories to other
computers), export a `.json` backup and import it back.

### Linux and Wayland

Wayland doesn't let an app put itself "always on top", so Memo runs through XWayland automatically and the pin works
on GNOME, KDE and the like.

### Found a problem or have an idea?

Every suggestion and bug report helps Memo get better:

- **[Report a bug](https://github.com/DanielAkio/memo/issues/new?template=bug_report.yml)**: tell what you did, what
  you expected and what happened, and which system and Memo version you use.
- **[Suggest an improvement](https://github.com/DanielAkio/memo/issues/new?template=feature_request.yml)**: describe
  the idea and the problem it solves.

Before opening one, check the [open issues](https://github.com/DanielAkio/memo/issues): if someone already asked for
the same thing, a 👍 on it helps. You need a free GitHub account. Write in English or Portuguese.

---

## For developers

Memo is built with [Tauri 2](https://v2.tauri.app): a Rust backend (`src-tauri/`) and a plain HTML/CSS/JS frontend
(`src/`, no bundler). Prerequisites: [Rust](https://rustup.rs), Node.js 18+ and
[Tauri's system dependencies](https://v2.tauri.app/start/prerequisites/) (on Debian/Ubuntu:
`sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential`).

```bash
npm install
npm run dev      # run in development mode (also "Run in dev mode" in VS Code)
npm run build    # installer for the current OS in src-tauri/target/release/bundle/
```

- **Windows installer without a toolchain**: with Docker running,
  `docker compose -f docker/compose.yml run --build --rm windows` puts the NSIS `*-setup.exe` in `dist/`.
- **All platforms**: the manual workflow in `.github/workflows/build.yml` (Actions → Build → Run workflow) builds
  Windows, macOS (Apple Silicon and Intel) and Linux installers; run from a version tag, it also creates a draft
  release.
- The visual reference is [`docs/style.md`](docs/style.md); [`CLAUDE.md`](CLAUDE.md) describes the architecture and
  conventions.

Older versions saved to a folder named `br.memo.notas` (or `br.taxinha.notas`); on first launch Memo copies that data
into `memo` and keeps the old folder as a backup.

## License

[MIT](LICENSE).
