# Memo

Memórias adesivas para Windows, macOS e Linux, inspiradas no [Stickies](https://www.zhornsoftware.co.uk/stickies/).
Cada memória é uma janela própria, e **um clique na tachinha** a mantém por cima de todos os outros aplicativos.

## Como usar

| Ação | Como |
|------|------|
| Fixar / desafixar por cima de tudo | Clique na tachinha, à esquerda na barra de título, ou `Ctrl+Shift+P` (`⌘⇧P` no Mac) |
| Dar um título à memória | Clique duplo na barra de título; `Enter` salva, `Esc` cancela |
| Checklist | Digite `[]` no começo de uma linha; clique na caixa para marcar (o texto fica tachado) |
| Lista com marcadores | Digite `- ` no começo de uma linha; `Tab` / `Shift+Tab` recuam e voltam o item (também no checklist) |
| Código | `` `texto` `` (ou `Ctrl+E` / botão `</>` na barrinha) para código na linha; ` ```sql ` + `Enter` abre um bloco de código (`Enter` numa linha vazia no fim sai do bloco) |
| Negrito, itálico, sublinhado, marca-texto | `Ctrl+B`, `Ctrl+I`, `Ctrl+U`, `Ctrl+Shift+H` (`⌘` no Mac), ou selecione o texto e use a barrinha que aparece acima da seleção |
| Tamanho do texto (pequeno, normal, grande) | Botões "A" na barrinha da seleção, ou `Ctrl+Shift+>` / `Ctrl+Shift+<` (`⌘⇧` no Mac) |
| Nova memória | Botão `+`, `Ctrl+N` (`⌘N`) ou o ícone do Memo na bandeja |
| Fechar | Botão `✕` ou clique do meio (rodinha) na barra de título: a memória vai para a lixeira |
| Ver todas as memórias, buscar, recuperar da lixeira | Gerenciador de Memórias: abre junto com o app, ou pelo ícone na bandeja → Gerenciador de Memórias. Memórias há mais de 30 dias na lixeira são apagadas |
| Cor, título e texto das novas memórias | Gerenciador de Memórias → Configurações → Padrão (o texto usa o mesmo editor da memória: checklist, marcadores, código e formatação) |
| Mover | Arraste pela barra de título; perto de uma borda da tela ou de outra memória, ela gruda |
| Redimensionar | Pelas bordas ou pelo canto inferior direito; perto de uma borda da tela ou de outra memória, a borda gruda |
| Recolher / expandir até a barra de título | Botão de seta, ao lado do `✕` |
| Mudar a cor (padrão: amarela) | Clique na bolinha colorida à esquerda do título e escolha a cor, ou "Personalizada" para qualquer cor |
| Idioma (português / inglês) | Gerenciador de Memórias → Configurações → Idioma: Sistema (padrão), Português ou English |
| Tema claro / escuro | Gerenciador de Memórias → Configurações → Tema: Sistema (padrão), Claro ou Escuro |
| Rever as dicas da primeira memória | Gerenciador de Memórias → Configurações → Como usar o Memo |
| Mostrar todas as memórias | Ícone na bandeja (barra de menus no macOS) |
| Sair | Ícone na bandeja → Sair do Memo, ou Gerenciador de Memórias → Configurações → Sair do Memo |

Ao abrir, o Memo mostra o Gerenciador de Memórias junto com as memórias que estavam abertas (na primeira vez, com a memória de
boas-vindas). As memórias abertas aparecem na barra de tarefas (no Dock, no macOS). Fechar a última memória não encerra o app: ele
continua na bandeja. Texto, título, posição, tamanho, cor e estado de fixação são salvos automaticamente em
`notes.json`, na pasta de dados do app:

- Windows: `%APPDATA%\br.memo.notas\`
- macOS: `~/Library/Application Support/br.memo.notas/`
- Linux: `~/.local/share/br.memo.notas/`

O app se chamava Taxinha: na primeira vez que o Memo abre, ele copia as memórias da pasta antiga (`br.taxinha.notas`),
que fica intacta como backup.

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

Compositores Wayland não permitem que um app se coloque "sempre no topo". Por isso o Memo roda via
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

Visual baseado no [`docs/style.md`](docs/style.md) do projeto: superfícies quase pretas, a fonte do sistema (Segoe UI, SF Pro…), bordas hairline e, como
única cor, a etiqueta da memória (amarela por padrão).

## Licença

[MIT](LICENSE).
