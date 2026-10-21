//! Welcome note, created the first time the app opens (and reopened by
//! the button in the manager's Help tab), in the app's language.
//!
//! The content comes in both formats a note stores: `html` (what the editor
//! shows, using only tags that app.js's `sanitize` keeps) and `text` (the same
//! content as plain text, as app.js's `toPlain` would produce it).
//! Change one, change the other.

pub struct Welcome {
    pub title: &'static str,
    pub html: &'static str,
    pub text: &'static str,
}

/// Larger than a regular note, so most of the text fits without scrolling.
pub const WIDTH: f64 = 380.0;
pub const HEIGHT: f64 = 680.0;

pub const PT: Welcome = Welcome {
    title: "Boas-vindas ao Memo",
    html: concat!(
        r#"<div><font size="5"><b>Olá!</b></font></div>"#,
        r#"<div>Memórias rápidas que ficam <b>por cima de tudo</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Básico</b></div>"#,
        r#"<div class="check done">Instalar Memo!</div>"#,
        r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
        r#"<div class="check">Dar um título: clique duplo na barra de cima</div>"#,
        r#"<div class="check">Trocar a cor: clique na bolinha colorida ao lado do título</div>"#,
        r#"<div class="check">Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizar</b></div>"#,
        r#"<div class="bullet">Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda</div>"#,
        r#"<div class="bullet">Leve o cursor até a borda da tela para encaixar a memória</div>"#,
        r#"<div class="bullet">Encolha pela borda de baixo para deixar só a barra</div>"#,
        r#"<div class="bullet">Junte memórias num grupo em "Sem grupo", no rodapé</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Escrever</b></div>"#,
        r#"<div class="bullet">Selecione um trecho para <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u>, <span style="background-color: rgb(255, 230, 0)">marca-texto</span> ou <font size="5">tamanho</font></div>"#,
        r#"<div class="bullet">Digite <code>[]</code> ou <code>-</code> no começo da linha para criar uma caixa ou um marcador como este</div>"#,
        r#"<div class="bullet" data-level="1">Tab recua o item e Shift+Tab volta</div>"#,
        r#"<div class="bullet">Crases em volta de um trecho viram <code>código</code>; três crases e Enter abrem um bloco:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memorias where fixada = true</pre>"#,
        r#"<div class="bullet">Cole imagens e prints com Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Gerenciador do Memo</b></div>"#,
        r#"<div>Abre com o app ou pelo ícone do Memo na bandeja (o botão direito nele mostra um menu de atalhos). Lá você:</div>"#,
        r#"<div class="bullet">busca e ordena memórias e grupos</div>"#,
        r#"<div class="bullet">reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)</div>"#,
        r#"<div class="bullet">em Configurações, escolhe tema, idioma e o padrão das memórias novas</div>"#,
        r#"<div class="bullet">na Ajuda, vê tudo o que o Memo faz</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias em outros computadores.</font></div>"#,
        r#"<div><font size="2">Dica: ligue o Controle por IA em Configurações para pedir ao seu assistente de IA (Claude, Copilot, Cursor, Gemini ou outro com MCP) que crie e organize memórias por você.</font></div>"#,
    ),
    text: "Olá!
Memórias rápidas que ficam por cima de tudo.

Básico
[x] Instalar Memo!
[ ] Fixar por cima de tudo: clique na tachinha
[ ] Dar um título: clique duplo na barra de cima
[ ] Trocar a cor: clique na bolinha colorida ao lado do título
[ ] Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)

Organizar
- Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda
- Leve o cursor até a borda da tela para encaixar a memória
- Encolha pela borda de baixo para deixar só a barra
- Junte memórias num grupo em \"Sem grupo\", no rodapé

Escrever
- Selecione um trecho para negrito, itálico, sublinhado, marca-texto ou tamanho
- Digite `[]` ou `-` no começo da linha para criar uma caixa ou um marcador como este
  - Tab recua o item e Shift+Tab volta
- Crases em volta de um trecho viram `código`; três crases e Enter abrem um bloco:
```sql
select * from memorias where fixada = true
```
- Cole imagens e prints com Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho

Gerenciador do Memo
Abre com o app ou pelo ícone do Memo na bandeja (o botão direito nele mostra um menu de atalhos). Lá você:
- busca e ordena memórias e grupos
- reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)
- em Configurações, escolhe tema, idioma e o padrão das memórias novas
- na Ajuda, vê tudo o que o Memo faz

Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias em outros computadores.
Dica: ligue o Controle por IA em Configurações para pedir ao seu assistente de IA (Claude, Copilot, Cursor, Gemini ou outro com MCP) que crie e organize memórias por você.",
};

pub const EN: Welcome = Welcome {
    title: "Welcome to Memo",
    html: concat!(
        r#"<div><font size="5"><b>Hi!</b></font></div>"#,
        r#"<div>Quick memories that stay <b>on top of everything</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Basics</b></div>"#,
        r#"<div class="check done">Install Memo!</div>"#,
        r#"<div class="check">Keep it on top: click the pin</div>"#,
        r#"<div class="check">Give it a title: double-click the top bar</div>"#,
        r#"<div class="check">Change the color: click the colored dot next to the title</div>"#,
        r#"<div class="check">Create another memory: the + button or Ctrl+N (⌘N on Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizing</b></div>"#,
        r#"<div class="bullet">Drag it by the bar: near the screen edge or another memory, it sticks</div>"#,
        r#"<div class="bullet">Move the cursor to the screen edge to snap the memory</div>"#,
        r#"<div class="bullet">Shrink it from the bottom edge to leave only the bar</div>"#,
        r#"<div class="bullet">Put memories in a group from "No group", in the footer</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Writing</b></div>"#,
        r#"<div class="bullet">Select some text for <b>bold</b>, <i>italic</i>, <u>underline</u>, <span style="background-color: rgb(255, 230, 0)">highlight</span> or <font size="5">size</font></div>"#,
        r#"<div class="bullet">Type <code>[]</code> or <code>-</code> at the start of a line for a box or a bullet like this one</div>"#,
        r#"<div class="bullet" data-level="1">Tab indents the item and Shift+Tab outdents it</div>"#,
        r#"<div class="bullet">Backticks around some text make it <code>code</code>; three backticks and Enter open a block:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memories where pinned = true</pre>"#,
        r#"<div class="bullet">Paste images and screenshots with Ctrl+V; click the image and drag its corner to resize it</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Memo Manager</b></div>"#,
        r#"<div>Opens with the app or from the Memo icon in the system tray (right-click it for a menu of shortcuts). There you can:</div>"#,
        r#"<div class="bullet">search and sort memories and groups</div>"#,
        r#"<div class="bullet">reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)</div>"#,
        r#"<div class="bullet">in Settings, choose the theme, language and defaults for new memories</div>"#,
        r#"<div class="bullet">in Help, see everything Memo does</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Tip: in Settings, sync with Google Drive to use the same memories on other computers.</font></div>"#,
        r#"<div><font size="2">Tip: turn on AI control in Settings to have your AI assistant (Claude, Copilot, Cursor, Gemini or any other with MCP) create and organize memories for you.</font></div>"#,
    ),
    text: "Hi!
Quick memories that stay on top of everything.

Basics
[x] Install Memo!
[ ] Keep it on top: click the pin
[ ] Give it a title: double-click the top bar
[ ] Change the color: click the colored dot next to the title
[ ] Create another memory: the + button or Ctrl+N (⌘N on Mac)

Organizing
- Drag it by the bar: near the screen edge or another memory, it sticks
- Move the cursor to the screen edge to snap the memory
- Shrink it from the bottom edge to leave only the bar
- Put memories in a group from \"No group\", in the footer

Writing
- Select some text for bold, italic, underline, highlight or size
- Type `[]` or `-` at the start of a line for a box or a bullet like this one
  - Tab indents the item and Shift+Tab outdents it
- Backticks around some text make it `code`; three backticks and Enter open a block:
```sql
select * from memories where pinned = true
```
- Paste images and screenshots with Ctrl+V; click the image and drag its corner to resize it

Memo Manager
Opens with the app or from the Memo icon in the system tray (right-click it for a menu of shortcuts). There you can:
- search and sort memories and groups
- reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)
- in Settings, choose the theme, language and defaults for new memories
- in Help, see everything Memo does

Tip: in Settings, sync with Google Drive to use the same memories on other computers.
Tip: turn on AI control in Settings to have your AI assistant (Claude, Copilot, Cursor, Gemini or any other with MCP) create and organize memories for you.",
};

/// Earlier versions of the welcome note's HTML (pt, en), so an untouched copy
/// made by an older version still counts as untouched (`is_untouched`).
const PREVIOUS_HTML: [&str; 8] = [
    concat!(
        r#"<div><font size="5"><b>Olá!</b></font></div>"#,
        r#"<div>Memórias rápidas que ficam <b>por cima de tudo</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Básico</b></div>"#,
        r#"<div class="check done">Instalar Memo!</div>"#,
        r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
        r#"<div class="check">Dar um título: clique duplo na barra de cima</div>"#,
        r#"<div class="check">Trocar a cor: clique na bolinha colorida ao lado do título</div>"#,
        r#"<div class="check">Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizar</b></div>"#,
        r#"<div class="bullet">Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda</div>"#,
        r#"<div class="bullet">Leve o cursor até a borda da tela para encaixar a memória</div>"#,
        r#"<div class="bullet">Encolha pela borda de baixo para deixar só a barra</div>"#,
        r#"<div class="bullet">Junte memórias num grupo em "Sem grupo", no rodapé</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Escrever</b></div>"#,
        r#"<div class="bullet">Selecione um trecho para <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u>, <span style="background-color: rgb(255, 230, 0)">marca-texto</span> ou <font size="5">tamanho</font></div>"#,
        r#"<div class="bullet">Digite <code>[]</code> ou <code>-</code> no começo da linha para criar uma caixa ou um marcador como este</div>"#,
        r#"<div class="bullet" data-level="1">Tab recua o item e Shift+Tab volta</div>"#,
        r#"<div class="bullet">Crases em volta de um trecho viram <code>código</code>; três crases e Enter abrem um bloco:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memorias where fixada = true</pre>"#,
        r#"<div class="bullet">Cole imagens e prints com Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Gerenciador do Memo</b></div>"#,
        r#"<div>Abre com o app ou pelo ícone do Memo na bandeja (o botão direito nele mostra um menu de atalhos). Lá você:</div>"#,
        r#"<div class="bullet">busca e ordena memórias e grupos</div>"#,
        r#"<div class="bullet">reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)</div>"#,
        r#"<div class="bullet">em Configurações, escolhe tema, idioma e o padrão das memórias novas</div>"#,
        r#"<div class="bullet">na Ajuda, vê tudo o que o Memo faz</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias em outros computadores.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Hi!</b></font></div>"#,
        r#"<div>Quick memories that stay <b>on top of everything</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Basics</b></div>"#,
        r#"<div class="check done">Install Memo!</div>"#,
        r#"<div class="check">Keep it on top: click the pin</div>"#,
        r#"<div class="check">Give it a title: double-click the top bar</div>"#,
        r#"<div class="check">Change the color: click the colored dot next to the title</div>"#,
        r#"<div class="check">Create another memory: the + button or Ctrl+N (⌘N on Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizing</b></div>"#,
        r#"<div class="bullet">Drag it by the bar: near the screen edge or another memory, it sticks</div>"#,
        r#"<div class="bullet">Move the cursor to the screen edge to snap the memory</div>"#,
        r#"<div class="bullet">Shrink it from the bottom edge to leave only the bar</div>"#,
        r#"<div class="bullet">Put memories in a group from "No group", in the footer</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Writing</b></div>"#,
        r#"<div class="bullet">Select some text for <b>bold</b>, <i>italic</i>, <u>underline</u>, <span style="background-color: rgb(255, 230, 0)">highlight</span> or <font size="5">size</font></div>"#,
        r#"<div class="bullet">Type <code>[]</code> or <code>-</code> at the start of a line for a box or a bullet like this one</div>"#,
        r#"<div class="bullet" data-level="1">Tab indents the item and Shift+Tab outdents it</div>"#,
        r#"<div class="bullet">Backticks around some text make it <code>code</code>; three backticks and Enter open a block:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memories where pinned = true</pre>"#,
        r#"<div class="bullet">Paste images and screenshots with Ctrl+V; click the image and drag its corner to resize it</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Memo Manager</b></div>"#,
        r#"<div>Opens with the app or from the Memo icon in the system tray (right-click it for a menu of shortcuts). There you can:</div>"#,
        r#"<div class="bullet">search and sort memories and groups</div>"#,
        r#"<div class="bullet">reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)</div>"#,
        r#"<div class="bullet">in Settings, choose the theme, language and defaults for new memories</div>"#,
        r#"<div class="bullet">in Help, see everything Memo does</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Tip: in Settings, sync with Google Drive to use the same memories on other computers.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Olá!</b></font></div>"#,
        r#"<div>Memórias rápidas que ficam <b>por cima de tudo</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Básico</b></div>"#,
        r#"<div class="check done">Instalar Memo!</div>"#,
        r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
        r#"<div class="check">Dar um título: clique duplo na barra de cima</div>"#,
        r#"<div class="check">Trocar a cor: clique na bolinha colorida ao lado do título</div>"#,
        r#"<div class="check">Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizar</b></div>"#,
        r#"<div class="bullet">Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda</div>"#,
        r#"<div class="bullet">Leve o cursor até a borda da tela para encaixar a memória</div>"#,
        r#"<div class="bullet">Encolha pela borda de baixo para deixar só a barra</div>"#,
        r#"<div class="bullet">Junte memórias num grupo em "Sem grupo", no rodapé</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Escrever</b></div>"#,
        r#"<div class="bullet">Selecione um trecho para <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u>, <span style="background-color: rgb(255, 230, 0)">marca-texto</span> ou <font size="5">tamanho</font></div>"#,
        r#"<div class="bullet">Digite <code>[]</code> ou <code>-</code> no começo da linha para criar uma caixa ou um marcador como este</div>"#,
        r#"<div class="bullet" data-level="1">Tab recua o item e Shift+Tab volta</div>"#,
        r#"<div class="bullet">Crases em volta de um trecho viram <code>código</code>; três crases e Enter abrem um bloco:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memorias where fixada = true</pre>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Gerenciador do Memo</b></div>"#,
        r#"<div>Abre com o app ou pelo ícone do Memo na bandeja. Lá você:</div>"#,
        r#"<div class="bullet">busca e ordena memórias e grupos</div>"#,
        r#"<div class="bullet">reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)</div>"#,
        r#"<div class="bullet">em Configurações, escolhe tema, idioma e o padrão das memórias novas</div>"#,
        r#"<div class="bullet">na Ajuda, vê tudo o que o Memo faz</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias em outros computadores.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Hi!</b></font></div>"#,
        r#"<div>Quick memories that stay <b>on top of everything</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Basics</b></div>"#,
        r#"<div class="check done">Install Memo!</div>"#,
        r#"<div class="check">Keep it on top: click the pin</div>"#,
        r#"<div class="check">Give it a title: double-click the top bar</div>"#,
        r#"<div class="check">Change the color: click the colored dot next to the title</div>"#,
        r#"<div class="check">Create another memory: the + button or Ctrl+N (⌘N on Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizing</b></div>"#,
        r#"<div class="bullet">Drag it by the bar: near the screen edge or another memory, it sticks</div>"#,
        r#"<div class="bullet">Move the cursor to the screen edge to snap the memory</div>"#,
        r#"<div class="bullet">Shrink it from the bottom edge to leave only the bar</div>"#,
        r#"<div class="bullet">Put memories in a group from "No group", in the footer</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Writing</b></div>"#,
        r#"<div class="bullet">Select some text for <b>bold</b>, <i>italic</i>, <u>underline</u>, <span style="background-color: rgb(255, 230, 0)">highlight</span> or <font size="5">size</font></div>"#,
        r#"<div class="bullet">Type <code>[]</code> or <code>-</code> at the start of a line for a box or a bullet like this one</div>"#,
        r#"<div class="bullet" data-level="1">Tab indents the item and Shift+Tab outdents it</div>"#,
        r#"<div class="bullet">Backticks around some text make it <code>code</code>; three backticks and Enter open a block:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memories where pinned = true</pre>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Memo Manager</b></div>"#,
        r#"<div>Opens with the app or from the Memo icon in the system tray. There you can:</div>"#,
        r#"<div class="bullet">search and sort memories and groups</div>"#,
        r#"<div class="bullet">reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)</div>"#,
        r#"<div class="bullet">in Settings, choose the theme, language and defaults for new memories</div>"#,
        r#"<div class="bullet">in Help, see everything Memo does</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Tip: in Settings, sync with Google Drive to use the same memories on other computers.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Olá!</b></font></div>"#,
        r#"<div>Memórias rápidas que ficam <b>por cima de tudo</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Básico</b></div>"#,
        r#"<div class="check done">Instalar Memo!</div>"#,
        r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
        r#"<div class="check">Dar um título: clique duplo na barra de cima</div>"#,
        r#"<div class="check">Trocar a cor: clique na bolinha colorida ao lado do título</div>"#,
        r#"<div class="check">Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Escrever</b></div>"#,
        r#"<div class="bullet">Selecione um trecho para <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u>, <span style="background-color: rgb(255, 230, 0)">marca-texto</span> ou <font size="5">tamanho</font></div>"#,
        r#"<div class="bullet">Digite <code>[]</code> ou <code>-</code> no começo da linha para criar uma caixa ou um marcador como este</div>"#,
        r#"<div class="bullet" data-level="1">Tab recua o item e Shift+Tab volta</div>"#,
        r#"<div class="bullet">Crases em volta de um trecho viram <code>código</code>; três crases e Enter abrem um bloco:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memorias where fixada = true</pre>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Gerenciador do Memo</b></div>"#,
        r#"<div>Abre com o app ou pelo ícone do Memo na bandeja. Lá você:</div>"#,
        r#"<div class="bullet">busca e ordena as memórias (mais recentes ou A–Z)</div>"#,
        r#"<div class="bullet">reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)</div>"#,
        r#"<div class="bullet">em Configurações, escolhe tema, idioma e o padrão das memórias novas</div>"#,
        r#"<div class="bullet">em Armazenamento, muda a pasta das memórias e exporta ou importa um backup</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Dica: guarde as memórias numa pasta do Dropbox ou do OneDrive para usá-las em outro computador.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Hi!</b></font></div>"#,
        r#"<div>Quick memories that stay <b>on top of everything</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Basics</b></div>"#,
        r#"<div class="check done">Install Memo!</div>"#,
        r#"<div class="check">Keep it on top: click the pin</div>"#,
        r#"<div class="check">Give it a title: double-click the top bar</div>"#,
        r#"<div class="check">Change the color: click the colored dot next to the title</div>"#,
        r#"<div class="check">Create another memory: the + button or Ctrl+N (⌘N on Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Writing</b></div>"#,
        r#"<div class="bullet">Select some text for <b>bold</b>, <i>italic</i>, <u>underline</u>, <span style="background-color: rgb(255, 230, 0)">highlight</span> or <font size="5">size</font></div>"#,
        r#"<div class="bullet">Type <code>[]</code> or <code>-</code> at the start of a line for a box or a bullet like this one</div>"#,
        r#"<div class="bullet" data-level="1">Tab indents the item and Shift+Tab outdents it</div>"#,
        r#"<div class="bullet">Backticks around some text make it <code>code</code>; three backticks and Enter open a block:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memories where pinned = true</pre>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Memo Manager</b></div>"#,
        r#"<div>Opens with the app or from the Memo icon in the system tray. There you can:</div>"#,
        r#"<div class="bullet">search and sort all memories (most recent or A–Z)</div>"#,
        r#"<div class="bullet">reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)</div>"#,
        r#"<div class="bullet">in Settings, choose the theme, language and defaults for new memories</div>"#,
        r#"<div class="bullet">in Storage, change the memories folder and export or import a backup</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Tip: keep your memories in a Dropbox or OneDrive folder to use them on another computer.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Olá!</b></font></div>"#,
        r#"<div>Memórias rápidas que ficam <b>por cima de tudo</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Básico</b></div>"#,
        r#"<div class="check done">Instalar Memo!</div>"#,
        r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
        r#"<div class="check">Dar um título: clique duplo na barra de cima</div>"#,
        r#"<div class="check">Trocar a cor: clique na bolinha colorida ao lado do título</div>"#,
        r#"<div class="check">Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizar</b></div>"#,
        r#"<div class="bullet">Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda</div>"#,
        r#"<div class="bullet">Leve o cursor até a borda da tela para encaixar a memória</div>"#,
        r#"<div class="bullet">Encolha pela borda de baixo para deixar só a barra</div>"#,
        r#"<div class="bullet">Junte memórias num grupo em "Sem grupo", no rodapé</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Escrever</b></div>"#,
        r#"<div class="bullet">Selecione um trecho para <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u>, <span style="background-color: rgb(255, 230, 0)">marca-texto</span> ou <font size="5">tamanho</font></div>"#,
        r#"<div class="bullet">Digite <code>[]</code> ou <code>-</code> no começo da linha para criar uma caixa ou um marcador como este</div>"#,
        r#"<div class="bullet" data-level="1">Tab recua o item e Shift+Tab volta</div>"#,
        r#"<div class="bullet">Crases em volta de um trecho viram <code>código</code>; três crases e Enter abrem um bloco:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memorias where fixada = true</pre>"#,
        r#"<div class="bullet">Cole imagens e prints com Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Gerenciador do Memo</b></div>"#,
        r#"<div>Abre com o app ou pelo ícone do Memo na bandeja. Lá você:</div>"#,
        r#"<div class="bullet">busca e ordena memórias e grupos</div>"#,
        r#"<div class="bullet">reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)</div>"#,
        r#"<div class="bullet">em Configurações, escolhe tema, idioma e o padrão das memórias novas</div>"#,
        r#"<div class="bullet">na Ajuda, vê tudo o que o Memo faz</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias em outros computadores.</font></div>"#,
    ),
    concat!(
        r#"<div><font size="5"><b>Hi!</b></font></div>"#,
        r#"<div>Quick memories that stay <b>on top of everything</b>.</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Basics</b></div>"#,
        r#"<div class="check done">Install Memo!</div>"#,
        r#"<div class="check">Keep it on top: click the pin</div>"#,
        r#"<div class="check">Give it a title: double-click the top bar</div>"#,
        r#"<div class="check">Change the color: click the colored dot next to the title</div>"#,
        r#"<div class="check">Create another memory: the + button or Ctrl+N (⌘N on Mac)</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Organizing</b></div>"#,
        r#"<div class="bullet">Drag it by the bar: near the screen edge or another memory, it sticks</div>"#,
        r#"<div class="bullet">Move the cursor to the screen edge to snap the memory</div>"#,
        r#"<div class="bullet">Shrink it from the bottom edge to leave only the bar</div>"#,
        r#"<div class="bullet">Put memories in a group from "No group", in the footer</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Writing</b></div>"#,
        r#"<div class="bullet">Select some text for <b>bold</b>, <i>italic</i>, <u>underline</u>, <span style="background-color: rgb(255, 230, 0)">highlight</span> or <font size="5">size</font></div>"#,
        r#"<div class="bullet">Type <code>[]</code> or <code>-</code> at the start of a line for a box or a bullet like this one</div>"#,
        r#"<div class="bullet" data-level="1">Tab indents the item and Shift+Tab outdents it</div>"#,
        r#"<div class="bullet">Backticks around some text make it <code>code</code>; three backticks and Enter open a block:</div>"#,
        r#"<pre class="code" data-lang="sql">select * from memories where pinned = true</pre>"#,
        r#"<div class="bullet">Paste images and screenshots with Ctrl+V; click the image and drag its corner to resize it</div>"#,
        r#"<div><br></div>"#,
        r#"<div><b>Memo Manager</b></div>"#,
        r#"<div>Opens with the app or from the Memo icon in the system tray. There you can:</div>"#,
        r#"<div class="bullet">search and sort memories and groups</div>"#,
        r#"<div class="bullet">reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)</div>"#,
        r#"<div class="bullet">in Settings, choose the theme, language and defaults for new memories</div>"#,
        r#"<div class="bullet">in Help, see everything Memo does</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">Tip: in Settings, sync with Google Drive to use the same memories on other computers.</font></div>"#,
    ),
];

/// The welcome note in the effective language ("pt" or "en").
pub fn for_lang(lang: &str) -> &'static Welcome {
    if lang == "en" {
        &EN
    } else {
        &PT
    }
}

/// `true` if the note is one of the untouched versions of the welcome note.
pub fn is_untouched(title: &str, html: &str) -> bool {
    [&PT, &EN].iter().any(|w| w.title == title)
        && ([PT.html, EN.html].contains(&html) || PREVIOUS_HTML.contains(&html))
}
