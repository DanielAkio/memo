# Taxinha

Notas adesivas para Windows, macOS e Linux, inspiradas no [Stickies](https://www.zhornsoftware.co.uk/stickies/).
Cada nota é uma janela própria, e **um clique na tachinha** a mantém por cima de todos os outros aplicativos.

## Como usar

| Ação | Como |
|------|------|
| Fixar / desafixar por cima de tudo | Clique na tachinha da barra de título, ou `Ctrl+Shift+P` (`⌘⇧P` no Mac) |
| Nova nota | Botão `+`, `Ctrl+N` (`⌘N`) ou o ícone da Taxinha na bandeja |
| Mover | Arraste pela barra de título |
| Redimensionar | Pelas bordas ou pelo canto inferior direito |
| Recolher até a barra de título | Clique duplo no título |
| Cor da etiqueta, excluir | Botão `⋯` |
| Mostrar todas / Sair | Ícone na bandeja (barra de menus no macOS) |

Fechar a última nota não encerra o app: ele continua na bandeja. Texto, posição, tamanho, cor e estado de fixação
são salvos automaticamente em `notes.json`, na pasta de dados do app:

- Windows: `%APPDATA%\br.taxinha.notas\`
- macOS: `~/Library/Application Support/br.taxinha.notas/`
- Linux: `~/.local/share/br.taxinha.notas/`

## Rodar a partir do código

Pré-requisitos: [Rust](https://rustup.rs), Node.js 18+ e as dependências de sistema do Tauri
([guia oficial](https://v2.tauri.app/start/prerequisites/)). No Linux (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential
```

Depois:

```bash
npm install
npm run dev      # abre o app em modo desenvolvimento
npm run build    # gera o instalador do sistema atual em src-tauri/target/release/bundle/
```

## Instaladores para os três sistemas

O workflow em `.github/workflows/build.yml` compila no GitHub Actions para Windows (`.msi` e `.exe`),
macOS Apple Silicon e Intel (`.dmg`) e Linux (`.deb`, `.rpm`, `.AppImage`). Basta subir o projeto para um
repositório: cada push gera os instaladores como artefatos, e uma tag `v0.1.0` cria um rascunho de release.

Os builds não são assinados. No macOS, abra pela primeira vez com clique direito → Abrir; no Windows, o
SmartScreen pode pedir "Executar assim mesmo".

## Linux e Wayland

Compositores Wayland não permitem que um app se coloque "sempre no topo". Por isso a Taxinha roda via
XWayland automaticamente quando detecta Wayland, e o botão de fixar funciona no GNOME, KDE e afins.
Para forçar outro backend, defina `GDK_BACKEND` antes de abrir o app.

## Estrutura

```
src/                 interface (HTML, CSS e JS puros, sem build)
  styles.css         tokens e componentes do docs/style.md
src-tauri/src/
  main.rs            janelas, comandos, bandeja
  store.rs           persistência em notes.json
src-tauri/icons/     ícones gerados a partir de assets/icon.svg
```

Visual baseado no [`docs/style.md`](docs/style.md) do projeto: superfícies quase pretas, Inter em pesos 400–590, bordas hairline e um
único acento acid-lime (`#e4f222`) reservado para a ação de fixar.

## Licença

[MIT](LICENSE). A fonte [Inter](https://github.com/rsms/inter), incluída em `src/fonts/`, é distribuída sob a
SIL Open Font License 1.1 ([`src/fonts/OFL.txt`](src/fonts/OFL.txt)).
