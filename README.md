# Taxinha

Notas adesivas para Windows, macOS e Linux, inspiradas no [Stickies](https://www.zhornsoftware.co.uk/stickies/).
Cada nota é uma janela própria, e **um clique na tachinha** a mantém por cima de todos os outros aplicativos.

## Como usar

| Ação | Como |
|------|------|
| Fixar / desafixar por cima de tudo | Clique na tachinha, à esquerda na barra de título, ou `Ctrl+Shift+P` (`⌘⇧P` no Mac) |
| Dar um título à nota | Clique duplo na barra de título; `Enter` salva, `Esc` cancela |
| Checklist | Digite `[]` no começo de uma linha; clique na caixa para marcar (o texto fica tachado) |
| Negrito, itálico, sublinhado | `Ctrl+B`, `Ctrl+I`, `Ctrl+U` (`⌘` no Mac), ou selecione o texto e use a barrinha que aparece acima da seleção |
| Tamanho do texto (pequeno, normal, grande) | Botões "A" na barrinha da seleção, ou `Ctrl+Shift+>` / `Ctrl+Shift+<` (`⌘⇧` no Mac) |
| Nova nota | Botão `+`, `Ctrl+N` (`⌘N`) ou o ícone da Taxinha na bandeja |
| Fechar | Botão `✕` ou clique do meio (rodinha) na barra de título: a nota vai para a lixeira |
| Recuperar da lixeira | Ícone na bandeja → Lixeira; notas há mais de 30 dias na lixeira são apagadas |
| Mover | Arraste pela barra de título |
| Redimensionar | Pelas bordas ou pelo canto inferior direito |
| Recolher / expandir até a barra de título | Botão de seta, ao lado do `✕` |
| Mudar a cor (padrão: amarela) | Clique na bolinha colorida à esquerda do título e escolha a cor, ou "Personalizada" para qualquer cor |
| Tema claro / escuro | Ícone na bandeja → Tema → Sistema (padrão), Claro ou Escuro |
| Rever as dicas da primeira nota | Ícone na bandeja → Como usar a Taxinha |
| Mostrar todas / Sair | Ícone na bandeja (barra de menus no macOS) |

As notas abertas aparecem na barra de tarefas (no Dock, no macOS). Fechar a última nota não encerra o app: ele
continua na bandeja. Texto, título, posição, tamanho, cor e estado de fixação são salvos automaticamente em
`notes.json`, na pasta de dados do app:

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

No VS Code, o mesmo `npm run dev` está em **Run and Debug** → **Rodar em modo dev**.

## Instalador do Windows via Docker

Para gerar o instalador do Windows sem instalar Rust, Node ou o Visual Studio, basta ter o
[Docker Desktop](https://www.docker.com/products/docker-desktop/) aberto. No VS Code, vá em **Run and Debug**,
escolha **Gerar instalador do Windows (Docker)** e clique em ▶. Pelo terminal:

```bash
docker compose -f docker/compose.yml run --build --rm windows
```

O `*-setup.exe` (NSIS) aparece em `dist/`. O primeiro build demora mais, porque monta a imagem e baixa o SDK do
Windows; os seguintes reaproveitam os caches. O `.msi` só sai pela CI, porque o WiX exige Windows.

## Instaladores para os três sistemas

O workflow em `.github/workflows/build.yml` compila no GitHub Actions para Windows (`.msi` e `.exe`),
macOS Apple Silicon e Intel (`.dmg`) e Linux (`.deb`, `.rpm`, `.AppImage`). Ele roda só manualmente, em
Actions → Build → Run workflow, e gera os instaladores como artefatos. Rodando a partir de uma tag `v0.1.0`,
cria também um rascunho de release.

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

Visual baseado no [`docs/style.md`](docs/style.md) do projeto: superfícies quase pretas, Inter em pesos 400–590, bordas hairline e, como
única cor, a etiqueta da nota (amarela por padrão).

## Licença

[MIT](LICENSE). A fonte [Inter](https://github.com/rsms/inter), incluída em `src/fonts/`, é distribuída sob a
SIL Open Font License 1.1 ([`src/fonts/OFL.txt`](src/fonts/OFL.txt)).
