//! Nota de boas-vindas, criada na primeira vez que o app abre (e reaberta por
//! "Como usar o Memo"), no idioma do app.
//!
//! O conteúdo vem nos dois formatos que a nota guarda: `html` (o que o
//! editor mostra, só com as tags que o `sanitize` do app.js aceita) e `text`
//! (o mesmo conteúdo em texto puro, como o `toPlain` do app.js geraria).
//! Mudou um, mude o outro.

pub struct Welcome {
    pub title: &'static str,
    pub html: &'static str,
    pub text: &'static str,
}

/// Um pouco maior que uma nota comum, para caber o texto todo.
pub const WIDTH: f64 = 340.0;
pub const HEIGHT: f64 = 560.0;

pub const PT: Welcome = Welcome {
    title: "Boas-vindas ao Memo",
    html: concat!(
        r#"<div><font size="5"><b>Olá!</b></font></div>"#,
        r#"<div>Memórias rápidas que ficam <b>por cima de tudo</b>. Experimente:</div>"#,
        r#"<div><br></div>"#,
        r#"<div class="check done">Ler esta memória</div>"#,
        r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
        r#"<div class="check">Mudar o título: clique duplo na barra de cima</div>"#,
        r#"<div class="check">Trocar a cor: clique na bolinha amarela</div>"#,
        r#"<div class="check">Formatar: selecione um trecho e escolha <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u> ou <font size="5">tamanho</font></div>"#,
        r#"<div class="check">Criar uma caixa como estas: digite [] no começo da linha</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">O ✕ manda a memória para a lixeira. Todas as memórias e a lixeira ficam no Gerenciador de Memórias, que abre com o app ou pelo ícone do Memo na bandeja.</font></div>"#,
    ),
    text: "Olá!
Memórias rápidas que ficam por cima de tudo. Experimente:

[x] Ler esta memória
[ ] Fixar por cima de tudo: clique na tachinha
[ ] Mudar o título: clique duplo na barra de cima
[ ] Trocar a cor: clique na bolinha amarela
[ ] Formatar: selecione um trecho e escolha negrito, itálico, sublinhado ou tamanho
[ ] Criar uma caixa como estas: digite [] no começo da linha

O ✕ manda a memória para a lixeira. Todas as memórias e a lixeira ficam no Gerenciador de Memórias, que abre com o app ou pelo ícone do Memo na bandeja.",
};

pub const EN: Welcome = Welcome {
    title: "Welcome to Memo",
    html: concat!(
        r#"<div><font size="5"><b>Hi!</b></font></div>"#,
        r#"<div>Quick memories that stay <b>on top of everything</b>. Try it:</div>"#,
        r#"<div><br></div>"#,
        r#"<div class="check done">Read this memory</div>"#,
        r#"<div class="check">Keep it on top: click the pin</div>"#,
        r#"<div class="check">Change the title: double-click the top bar</div>"#,
        r#"<div class="check">Change the color: click the yellow dot</div>"#,
        r#"<div class="check">Format: select some text and pick <b>bold</b>, <i>italic</i>, <u>underline</u> or <font size="5">size</font></div>"#,
        r#"<div class="check">Make a box like these: type [] at the start of a line</div>"#,
        r#"<div><br></div>"#,
        r#"<div><font size="2">The ✕ moves the memory to the trash. All memories and the trash are in the Memory Manager, which opens with the app or from the Memo icon in the system tray.</font></div>"#,
    ),
    text: "Hi!
Quick memories that stay on top of everything. Try it:

[x] Read this memory
[ ] Keep it on top: click the pin
[ ] Change the title: double-click the top bar
[ ] Change the color: click the yellow dot
[ ] Format: select some text and pick bold, italic, underline or size
[ ] Make a box like these: type [] at the start of a line

The ✕ moves the memory to the trash. All memories and the trash are in the Memory Manager, which opens with the app or from the Memo icon in the system tray.",
};

/// A nota de boas-vindas no idioma efetivo ("pt" ou "en").
pub fn for_lang(lang: &str) -> &'static Welcome {
    if lang == "en" {
        &EN
    } else {
        &PT
    }
}

/// `true` se a nota é uma das versões intactas da nota de boas-vindas.
pub fn is_untouched(title: &str, html: &str) -> bool {
    [&PT, &EN]
        .iter()
        .any(|w| w.title == title && w.html == html)
}
