// Memo — textos da interface em português (padrão) e inglês.
//
// O idioma efetivo ("pt" ou "en") vem do Rust (get_language), que resolve a
// escolha da Configuração ("system" segue o idioma do sistema). No HTML, os
// textos fixos usam data-i18n="chave" (conteúdo) e
// data-i18n-attr="atributo=chave,outro=chave"; no JS, MemoI18n.t("chave").

window.MemoI18n = (() => {
  const STRINGS = {
    pt: {
      // Barra de título
      pin: 'Fixar acima de tudo',
      unpin: 'Desafixar',
      newNote: 'Nova memória',
      collapseNote: 'Recolher memória',
      expandNote: 'Expandir memória',
      collapse: 'Recolher',
      expand: 'Expandir',
      closeNote: 'Fechar memória',
      closeToTrash: 'Fechar (vai para a lixeira)',
      close: 'Fechar',
      // Nota
      noteColor: 'Cor da memória',
      colorIs: 'Cor: {name}',
      colorCustomIs: 'Cor: Personalizada ({hex})',
      editTitleHint: 'Clique duplo para editar o título',
      noteTitle: 'Título da memória',
      untitled: 'Sem título',
      emptyNote: 'Memória vazia',
      noteText: 'Texto da memória',
      writeSomething: 'Escreva algo…',
      edited: 'editada {when}',
      newNoteStatus: 'memória nova',
      wordOne: '{n} palavra',
      wordMany: '{n} palavras',
      // Cores
      yellow: 'Amarelo',
      green: 'Verde',
      coral: 'Coral',
      teal: 'Azul-petróleo',
      iris: 'Íris',
      lavender: 'Lavanda',
      white: 'Branco',
      black: 'Preto',
      custom: 'Personalizada',
      customMore: 'Personalizada…',
      noColor: 'Sem cor',
      // Formatação
      formatting: 'Formatação',
      bold: 'Negrito',
      italic: 'Itálico',
      underline: 'Sublinhado',
      boldLetter: 'N',
      italicLetter: 'I',
      underlineLetter: 'S',
      highlight: 'Marca-texto',
      code: 'Código',
      textSize: 'Tamanho do texto',
      smallText: 'Texto pequeno',
      normalText: 'Texto normal',
      largeText: 'Texto grande',
      smaller: '{keys} diminui',
      larger: '{keys} aumenta',
      // Gerenciador
      manager: 'Gerenciador de Memórias',
      tabNotes: 'Memórias',
      tabTrash: 'Lixeira',
      tabSettings: 'Configurações',
      search: 'Buscar',
      searchNotes: 'Buscar memórias',
      trashInfo: 'Memórias na lixeira são excluídas de vez depois de 30 dias.',
      emptyTrash: 'Esvaziar lixeira',
      emptyTrashConfirm: 'Clique de novo para esvaziar',
      nothingFound: 'Nada encontrado para “{q}”.',
      noNotes: 'Nenhuma memória aberta.',
      trashIsEmpty: 'A lixeira está vazia.',
      openNote: 'Abrir memória',
      moveToTrash: 'Mandar para a lixeira',
      restore: 'Restaurar',
      delete: 'Excluir',
      goneTomorrow: 'some amanhã',
      goneIn: 'some em {n} dias',
      appearance: 'Aparência',
      theme: 'Tema',
      system: 'Sistema',
      light: 'Claro',
      dark: 'Escuro',
      language: 'Idioma',
      newNotes: 'Padrão',
      newNotesTip: 'Vale para as memórias criadas daqui em diante.',
      color: 'Cor',
      title: 'Título',
      text: 'Texto',
      defaultTextPlaceholder: 'Vazio (a memória mostra uma frase aleatória)',
      application: 'Aplicativo',
      helpAndQuit: 'Ajuda e saída',
      howTo: 'Como usar o Memo',
      quit: 'Sair do Memo',
      quitConfirm: 'Clique de novo para sair',
    },
    en: {
      pin: 'Keep on top',
      unpin: 'Unpin',
      newNote: 'New memory',
      collapseNote: 'Collapse memory',
      expandNote: 'Expand memory',
      collapse: 'Collapse',
      expand: 'Expand',
      closeNote: 'Close memory',
      closeToTrash: 'Close (moves to trash)',
      close: 'Close',
      noteColor: 'Memory color',
      colorIs: 'Color: {name}',
      colorCustomIs: 'Color: Custom ({hex})',
      editTitleHint: 'Double-click to edit the title',
      noteTitle: 'Memory title',
      untitled: 'Untitled',
      emptyNote: 'Empty memory',
      noteText: 'Memory text',
      writeSomething: 'Write something…',
      edited: 'edited {when}',
      newNoteStatus: 'new memory',
      wordOne: '{n} word',
      wordMany: '{n} words',
      yellow: 'Yellow',
      green: 'Green',
      coral: 'Coral',
      teal: 'Teal',
      iris: 'Iris',
      lavender: 'Lavender',
      white: 'White',
      black: 'Black',
      custom: 'Custom',
      customMore: 'Custom…',
      noColor: 'No color',
      formatting: 'Formatting',
      bold: 'Bold',
      italic: 'Italic',
      underline: 'Underline',
      boldLetter: 'B',
      italicLetter: 'I',
      underlineLetter: 'U',
      highlight: 'Highlight',
      code: 'Code',
      textSize: 'Text size',
      smallText: 'Small text',
      normalText: 'Normal text',
      largeText: 'Large text',
      smaller: '{keys} smaller',
      larger: '{keys} larger',
      manager: 'Memory Manager',
      tabNotes: 'Memories',
      tabTrash: 'Trash',
      tabSettings: 'Settings',
      search: 'Search',
      searchNotes: 'Search memories',
      trashInfo: 'Memories in the trash are permanently deleted after 30 days.',
      emptyTrash: 'Empty trash',
      emptyTrashConfirm: 'Click again to empty',
      nothingFound: 'Nothing found for “{q}”.',
      noNotes: 'No memories.',
      trashIsEmpty: 'The trash is empty.',
      openNote: 'Open memory',
      moveToTrash: 'Move to trash',
      restore: 'Restore',
      delete: 'Delete',
      goneTomorrow: 'deleted tomorrow',
      goneIn: 'deleted in {n} days',
      appearance: 'Appearance',
      theme: 'Theme',
      system: 'System',
      light: 'Light',
      dark: 'Dark',
      language: 'Language',
      newNotes: 'Defaults',
      newNotesTip: 'Applies to memories created from now on.',
      color: 'Color',
      title: 'Title',
      text: 'Text',
      defaultTextPlaceholder: 'Empty (the memory shows a random phrase)',
      application: 'App',
      helpAndQuit: 'Help and quit',
      howTo: 'How to use Memo',
      quit: 'Quit Memo',
      quitConfirm: 'Click again to quit',
    },
  };

  // Placeholder da memória vazia: uma frase sorteada a cada memória aberta.
  const PLACEHOLDERS = {
    pt: [
      'Escreva antes que esqueça…',
      'Prometo não contar pra ninguém.',
      'Lista de compras, plano secreto ou dominação mundial?',
      'Anota aí, que o cérebro tá cheio.',
      'Pode desabafar, eu sou só um papel.',
      'Uma ideia genial começa aqui. Ou não.',
      'Escreva algo antes que o café esfrie.',
      'Post-it digital, zero cola.',
      'Aquela senha não, hein.',
      'Rabisque à vontade, ninguém tá olhando.',
      'Isto não é um diário. Ou é?',
      'Lembrete: beber água.',
      'O que o você do futuro precisa saber?',
      'Escreva rápido, a tachinha tá segurando.',
      'Fofoca boa merece ser anotada.',
      'Coisas que eu ia lembrar de cabeça (mentira).',
      'Digite aqui e finja que está produtivo.',
      'Mais um post-it pra coleção.',
      'Deixa que eu seguro essa ideia pra você.',
      'Era uma vez uma memória em branco…',
    ],
    en: [
      'Write it down before you forget…',
      'I promise not to tell anyone.',
      'Shopping list, secret plan or world domination?',
      'Jot it down, your brain is full.',
      'Go ahead and vent, I’m just paper.',
      'A brilliant idea starts here. Or not.',
      'Write something before the coffee gets cold.',
      'Digital sticky note, zero glue.',
      'Not that password, please.',
      'Scribble away, nobody’s looking.',
      'This is not a diary. Or is it?',
      'Reminder: drink water.',
      'What does future you need to know?',
      'Write fast, the pin is holding on.',
      'Good gossip deserves a note.',
      'Things I’d totally remember (not).',
      'Type here and pretend to be productive.',
      'One more sticky note for the collection.',
      'Let me hold that idea for you.',
      'Once upon a time, there was a blank memory…',
    ],
  };

  let lang = 'pt';

  function t(key, vars) {
    let s = STRINGS[lang][key] ?? STRINGS.pt[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    return s;
  }

  // Aplica os textos fixos do HTML (data-i18n e data-i18n-attr).
  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split('=').map((s) => s.trim());
        el.setAttribute(attr, t(key));
      }
    }
  }

  // `next` é o idioma efetivo vindo do Rust: "pt" ou "en".
  function set(next) {
    lang = next === 'en' ? 'en' : 'pt';
    document.documentElement.lang = locale();
    apply();
  }

  const locale = () => (lang === 'en' ? 'en-US' : 'pt-BR');
  const placeholder = () => {
    const list = PLACEHOLDERS[lang];
    return list[Math.floor(Math.random() * list.length)];
  };

  return { t, set, apply, locale, placeholder, get lang() { return lang; } };
})();
