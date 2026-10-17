//! Nota de boas-vindas, criada só na primeira vez que o app abre.
//!
//! O conteúdo vem nos dois formatos que a nota guarda: `HTML` (o que o
//! editor mostra, só com as tags que o `sanitize` do app.js aceita) e `TEXT`
//! (o mesmo conteúdo em texto puro, como o `toPlain` do app.js geraria).
//! Mudou um, mude o outro.

pub const TITLE: &str = "Boas-vindas à Taxinha";

/// Um pouco maior que uma nota comum, para caber o texto todo.
pub const WIDTH: f64 = 340.0;
pub const HEIGHT: f64 = 560.0;

pub const HTML: &str = concat!(
    r#"<div><font size="5"><b>Olá!</b></font></div>"#,
    r#"<div>Notas rápidas que ficam <b>por cima de tudo</b>. Experimente:</div>"#,
    r#"<div><br></div>"#,
    r#"<div class="check done">Ler esta nota</div>"#,
    r#"<div class="check">Fixar por cima de tudo: clique na tachinha</div>"#,
    r#"<div class="check">Mudar o título: clique duplo na barra de cima</div>"#,
    r#"<div class="check">Trocar a cor: clique na bolinha amarela</div>"#,
    r#"<div class="check">Formatar: selecione um trecho e escolha <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u> ou <font size="5">tamanho</font></div>"#,
    r#"<div class="check">Criar uma caixa como estas: digite [] no começo da linha</div>"#,
    r#"<div><br></div>"#,
    r#"<div><font size="2">O ✕ manda a nota para a lixeira. Lixeira e tema claro/escuro ficam no ícone da Taxinha, na bandeja.</font></div>"#,
);

pub const TEXT: &str = "Olá!
Notas rápidas que ficam por cima de tudo. Experimente:

[x] Ler esta nota
[ ] Fixar por cima de tudo: clique na tachinha
[ ] Mudar o título: clique duplo na barra de cima
[ ] Trocar a cor: clique na bolinha amarela
[ ] Formatar: selecione um trecho e escolha negrito, itálico, sublinhado ou tamanho
[ ] Criar uma caixa como estas: digite [] no começo da linha

O ✕ manda a nota para a lixeira. Lixeira e tema claro/escuro ficam no ícone da Taxinha, na bandeja.";
