// Memo — UI strings in Portuguese (default) and English.
//
// The effective language ("pt" or "en") comes from Rust (get_language), which
// resolves the Settings choice ("system" follows the OS language). In HTML,
// static text uses data-i18n="key" (content) and
// data-i18n-attr="attr=key,other=key"; in JS, MemoI18n.t("key").

window.MemoI18n = (() => {
  const STRINGS = {
    pt: {
      // Titlebar
      pin: 'Fixar acima de tudo',
      unpin: 'Desafixar',
      newNote: 'Nova memória',
      closeNote: 'Fechar memória',
      closeToTrash: 'Fechar (vai para a lixeira)',
      close: 'Fechar',
      // Note
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
      // Colours
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
      // Formatting
      formatting: 'Formatação',
      bold: 'Negrito',
      italic: 'Itálico',
      underline: 'Sublinhado',
      boldLetter: 'N',
      italicLetter: 'I',
      underlineLetter: 'S',
      highlight: 'Marca-texto',
      code: 'Código',
      codeLanguage: 'Linguagem do código',
      plainText: 'Texto puro',
      textSize: 'Tamanho do texto',
      smallText: 'Texto pequeno',
      normalText: 'Texto normal',
      largeText: 'Texto grande',
      smaller: '{keys} diminui',
      larger: '{keys} aumenta',
      // Manager
      manager: 'Gerenciador de Memórias',
      tabNotes: 'Memórias',
      tabTrash: 'Lixeira',
      tabSettings: 'Configurações',
      search: 'Buscar',
      searchNotes: 'Buscar memórias',
      sortBy: 'Ordenar por',
      sortRecent: 'Mais recentes',
      sortTitle: 'Título (A–Z)',
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
      storage: 'Armazenamento',
      storageTip: 'As memórias atuais são copiadas para a nova pasta; o arquivo antigo fica como backup. Uma pasta sincronizada (Dropbox, OneDrive…) leva as memórias para outros computadores.',
      dataFolder: 'Pasta das memórias',
      changeFolder: 'Alterar…',
      useDefaultFolder: 'Usar a pasta padrão',
      backup: 'Backup',
      backupTip: 'Exportar salva as memórias (as da lixeira ficam de fora) num arquivo .json. Importar junta as memórias do arquivo às atuais: uma memória que já existe só é trocada se a do arquivo for mais recente.',
      exportNotes: 'Exportar…',
      importNotes: 'Importar…',
      exported: 'Memórias exportadas.',
      importedNone: 'Nenhuma memória nova ou mais recente no arquivo.',
      importedOne: '1 memória importada.',
      importedMany: '{n} memórias importadas.',
      application: 'Aplicativo',
      exit: 'Saída',
      tabHelp: 'Ajuda',
      helpIntro: 'Como usar o Memo.',
      openWelcome: 'Abrir a memória de boas-vindas',
      quit: 'Sair do Memo',
      quitConfirm: 'Clique de novo para sair',
    },
    en: {
      pin: 'Keep on top',
      unpin: 'Unpin',
      newNote: 'New memory',
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
      codeLanguage: 'Code language',
      plainText: 'Plain text',
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
      sortBy: 'Sort by',
      sortRecent: 'Most recent',
      sortTitle: 'Title (A–Z)',
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
      storage: 'Storage',
      storageTip: 'The current memories are copied to the new folder; the old file is kept as a backup. A synced folder (Dropbox, OneDrive…) brings your memories to other computers.',
      dataFolder: 'Memories folder',
      changeFolder: 'Change…',
      useDefaultFolder: 'Use default folder',
      backup: 'Backup',
      backupTip: 'Export saves your memories (not the ones in the trash) to a .json file. Import merges the file’s memories into the current ones: an existing memory is only replaced if the file’s copy is newer.',
      exportNotes: 'Export…',
      importNotes: 'Import…',
      exported: 'Memories exported.',
      importedNone: 'No new or newer memories in the file.',
      importedOne: '1 memory imported.',
      importedMany: '{n} memories imported.',
      application: 'App',
      exit: 'Exit',
      tabHelp: 'Help',
      helpIntro: 'How to use Memo.',
      openWelcome: 'Open the welcome memory',
      quit: 'Quit Memo',
      quitConfirm: 'Click again to quit',
    },
  };

  // Placeholder for an empty memory: a random phrase each time one opens.
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

  // Help tab content: groups of [topic, how, demo?]. In "how", {{…}} is a key
  // or something to type (shown as <kbd>; Mod = Ctrl, or ⌘ on macOS). "demo"
  // is an optional example drawn like the real thing (manager.js, renderHelp):
  // static HTML using the note editor's markup (b, i, u, .hl, .sz-2/.sz-5,
  // .check, .bullet, code, pre.code[data-lang] — highlighted with Prism),
  // <i data-icon="…"> for titlebar icons and the .demo-* classes in
  // manager.css for small mock-ups of the window chrome.
  const HELP = {
    pt: [
      {
        title: 'Básico',
        items: [
          ['Fixar por cima', 'Clique na tachinha, à esquerda na barra de título, ou {{Mod+Shift+P}}.',
            '<span class="demo-row"><span class="demo-pair"><i data-icon="pin"></i><span class="demo-note">solta</span></span>'
            + '<span class="demo-pair"><i data-icon="pin-on"></i><span class="demo-note">fixada por cima de tudo</span></span></span>'],
          ['Nova memória', 'Botão + na barra, {{Mod+N}} ou o ícone do Memo na bandeja.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-name">Lista de compras</span><i data-icon="plus" class="demo-hot"></i><i data-icon="close"></i></span>'],
          ['Título', 'Clique duplo na barra de título; {{Enter}} salva e {{Esc}} cancela.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-input">Lista de compras</span></span>'],
          ['Cor', 'Clique na bolinha colorida ao lado do título. "Personalizada" abre qualquer cor.',
            '<span class="demo-dots"><span class="demo-dot" data-color="yellow"></span><span class="demo-dot" data-color="green"></span>'
            + '<span class="demo-dot" data-color="coral"></span><span class="demo-dot" data-color="teal"></span>'
            + '<span class="demo-dot" data-color="iris"></span><span class="demo-dot" data-color="lavender"></span>'
            + '<span class="demo-dot" data-color="mono"></span><span class="demo-dot demo-rainbow"></span><span class="demo-dot" data-color=""></span></span>'],
          ['Mover e redimensionar', 'Arraste pela barra de título ou pelas bordas. Perto da borda da tela ou de outra memória, ela gruda.'],
          ['Fechar', 'Botão ✕ ou clique do meio na barra de título: a memória vai para a lixeira.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-name">Lista de compras</span><i data-icon="plus"></i><i data-icon="close" class="demo-hot"></i></span>'],
        ],
      },
      {
        title: 'Escrever',
        items: [
          ['Formatação', 'Selecione um trecho e use a barrinha que aparece, ou {{Mod+B}}, {{Mod+I}} e {{Mod+U}}.',
            '<b>negrito</b>, <i>itálico</i> e <u>sublinhado</u>'],
          ['Marca-texto', '{{Mod+Shift+H}} ou o marcador na barrinha.',
            'Um <span class="hl">trecho importante</span> no meio do texto.'],
          ['Tamanho do texto', 'Botões "A" na barrinha, ou {{Mod+Shift+>}} e {{Mod+Shift+<}}.',
            '<span class="sz-2">pequeno</span> · normal · <span class="sz-5">grande</span>'],
          ['Checklist', 'Digite {{[]}} no começo da linha. Clique na caixa para marcar.',
            '<div class="check done">Comprar café</div><div class="check">Ligar para o dentista</div>'],
          ['Marcadores', 'Digite {{-}} e espaço no começo da linha.',
            '<div class="bullet">Frutas</div><div class="bullet">Verduras</div>'],
          ['Recuo de itens', '{{Tab}} recua e {{Shift+Tab}} volta. {{Enter}} num item vazio sai da lista.',
            '<div class="bullet">Viagem</div><div class="check done" data-level="1">reservar hotel</div>'
            + '<div class="check" data-level="1">renovar passaporte</div>'],
          ['Código na linha', 'Texto entre crases, como {{`código`}}, ou {{Mod+E}}.',
            'Rode <code>npm run dev</code> no terminal.'],
          ['Bloco de código', 'Digite {{```}} (ou {{```sql}}) e {{Enter}}. Passe o mouse sobre o bloco para escolher a linguagem. {{Enter}} numa linha vazia no fim sai do bloco.',
            '<pre class="code" data-lang="sql">select titulo\nfrom memorias\nwhere fixada = true; -- só as fixadas</pre>'],
          ['Colar', 'O texto colado entra sempre sem formatação.'],
        ],
      },
      {
        title: 'Gerenciador de Memórias',
        items: [
          ['Abrir', 'Abre junto com o app, ou pelo ícone do Memo na bandeja.'],
          ['Buscar', 'Campo de busca nas abas Memórias e Lixeira, ou {{Mod+F}}.',
            '<span class="demo-field"><i data-icon="search"></i>compras</span>'],
          ['Ordenar', 'Caixa ao lado da busca: mais recentes ou título (A–Z).',
            '<span class="demo-field"><i data-icon="sort"></i>Mais recentes</span>'
            + '<span class="demo-field"><i data-icon="sort"></i>Título (A–Z)</span>'],
          ['Lixeira', 'Restaure ou exclua de vez. Memórias com mais de 30 dias na lixeira são apagadas.',
            '<span class="demo-list-row"><span class="demo-dot" data-color="coral"></span>'
            + '<span class="demo-name">Rascunho antigo</span><span class="demo-meta">some em 29 dias</span></span>'],
        ],
      },
      {
        title: 'Configurações',
        items: [
          ['Aparência', 'Tema (sistema, claro ou escuro) e idioma.',
            '<span class="demo-seg"><span>Sistema</span><span class="on">Claro</span><span>Escuro</span></span>'],
          ['Padrão', 'Cor, título e texto com que as memórias novas começam.'],
          ['Armazenamento', 'Pasta onde as memórias ficam salvas (uma pasta do Dropbox ou OneDrive leva para outros computadores) e backup: exportar e importar.'],
          ['Sair', 'Fechar as memórias não encerra o app, que continua na bandeja. Use "Sair do Memo" na bandeja ou em Configurações.'],
        ],
      },
    ],
    en: [
      {
        title: 'Basics',
        items: [
          ['Keep on top', 'Click the pin on the left of the titlebar, or {{Mod+Shift+P}}.',
            '<span class="demo-row"><span class="demo-pair"><i data-icon="pin"></i><span class="demo-note">loose</span></span>'
            + '<span class="demo-pair"><i data-icon="pin-on"></i><span class="demo-note">pinned on top of everything</span></span></span>'],
          ['New memory', 'The + button in the titlebar, {{Mod+N}} or the Memo tray icon.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-name">Shopping list</span><i data-icon="plus" class="demo-hot"></i><i data-icon="close"></i></span>'],
          ['Title', 'Double-click the titlebar; {{Enter}} saves and {{Esc}} cancels.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-input">Shopping list</span></span>'],
          ['Color', 'Click the colored dot next to the title. "Custom" opens any color.',
            '<span class="demo-dots"><span class="demo-dot" data-color="yellow"></span><span class="demo-dot" data-color="green"></span>'
            + '<span class="demo-dot" data-color="coral"></span><span class="demo-dot" data-color="teal"></span>'
            + '<span class="demo-dot" data-color="iris"></span><span class="demo-dot" data-color="lavender"></span>'
            + '<span class="demo-dot" data-color="mono"></span><span class="demo-dot demo-rainbow"></span><span class="demo-dot" data-color=""></span></span>'],
          ['Move and resize', 'Drag by the titlebar or the edges. Near a screen edge or another memory, it snaps.'],
          ['Close', 'The ✕ button or a middle click on the titlebar: the memory goes to the trash.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-name">Shopping list</span><i data-icon="plus"></i><i data-icon="close" class="demo-hot"></i></span>'],
        ],
      },
      {
        title: 'Writing',
        items: [
          ['Formatting', 'Select some text and use the bar that appears, or {{Mod+B}}, {{Mod+I}} and {{Mod+U}}.',
            '<b>bold</b>, <i>italic</i> and <u>underline</u>'],
          ['Highlight', '{{Mod+Shift+H}} or the marker in the bar.',
            'An <span class="hl">important bit</span> in the middle of the text.'],
          ['Text size', 'The "A" buttons in the bar, or {{Mod+Shift+>}} and {{Mod+Shift+<}}.',
            '<span class="sz-2">small</span> · normal · <span class="sz-5">large</span>'],
          ['Checklist', 'Type {{[]}} at the start of a line. Click the box to check it.',
            '<div class="check done">Buy coffee</div><div class="check">Call the dentist</div>'],
          ['Bullets', 'Type {{-}} and a space at the start of a line.',
            '<div class="bullet">Fruit</div><div class="bullet">Vegetables</div>'],
          ['Indenting items', '{{Tab}} indents and {{Shift+Tab}} outdents. {{Enter}} on an empty item leaves the list.',
            '<div class="bullet">Trip</div><div class="check done" data-level="1">book the hotel</div>'
            + '<div class="check" data-level="1">renew passport</div>'],
          ['Inline code', 'Text between backticks, like {{`code`}}, or {{Mod+E}}.',
            'Run <code>npm run dev</code> in the terminal.'],
          ['Code block', 'Type {{```}} (or {{```sql}}) and {{Enter}}. Hover over the block to pick its language. {{Enter}} on an empty last line leaves the block.',
            '<pre class="code" data-lang="sql">select title\nfrom memories\nwhere pinned = true; -- pinned only</pre>'],
          ['Paste', 'Pasted text always comes in without formatting.'],
        ],
      },
      {
        title: 'Memory Manager',
        items: [
          ['Open', 'Opens with the app, or from the Memo tray icon.'],
          ['Search', 'The search box in the Memories and Trash tabs, or {{Mod+F}}.',
            '<span class="demo-field"><i data-icon="search"></i>shopping</span>'],
          ['Sort', 'The box next to the search: most recent or title (A–Z).',
            '<span class="demo-field"><i data-icon="sort"></i>Most recent</span>'
            + '<span class="demo-field"><i data-icon="sort"></i>Title (A–Z)</span>'],
          ['Trash', 'Restore or delete for good. Memories in the trash for over 30 days are deleted.',
            '<span class="demo-list-row"><span class="demo-dot" data-color="coral"></span>'
            + '<span class="demo-name">Old draft</span><span class="demo-meta">deleted in 29 days</span></span>'],
        ],
      },
      {
        title: 'Settings',
        items: [
          ['Appearance', 'Theme (system, light or dark) and language.',
            '<span class="demo-seg"><span>System</span><span class="on">Light</span><span>Dark</span></span>'],
          ['Defaults', 'Color, title and text that new memories start with.'],
          ['Storage', 'Folder where memories are saved (a Dropbox or OneDrive folder takes them to other computers) and backup: export and import.'],
          ['Quit', 'Closing memories doesn’t quit the app, which stays in the tray. Use "Quit Memo" in the tray or in Settings.'],
        ],
      },
    ],
  };

  let lang = 'pt';

  function t(key, vars) {
    let s = STRINGS[lang][key] ?? STRINGS.pt[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
    return s;
  }

  // Applies the static HTML text (data-i18n and data-i18n-attr).
  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
      for (const pair of el.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split('=').map((s) => s.trim());
        el.setAttribute(attr, t(key));
      }
    }
  }

  // `next` is the effective language from Rust: "pt" or "en".
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

  const help = () => HELP[lang];

  return { t, set, apply, locale, placeholder, help, get lang() { return lang; } };
})();
