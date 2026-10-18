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
      // Groups
      groupMenuTitle: 'Grupo',
      noGroup: 'Sem grupo',
      newGroup: 'Novo grupo',
      addToGroup: 'Adicionar a um grupo',
      groupIs: 'Grupo: {name} (clique para mudar)',
      moveToGroup: 'Grupo da memória',
      groupName: 'Nome do grupo',
      groupRename: 'Renomear grupo',
      groupColor: 'Cor do grupo',
      newNoteInGroup: 'Nova memória no grupo',
      groupShowHint: 'Clique duplo para soltar as memórias',
      groupHideHint: 'Clique duplo para recolher as memórias',
      groupCountOne: '1 memória',
      groupCountMany: '{n} memórias',
      deleteGroup: 'Excluir grupo',
      deleteGroupConfirm: 'Clique de novo: o grupo some e as memórias dele vão para a lixeira',
      bringAllToFront: 'Trazer todas as memórias para a frente',
      closeNote: 'Fechar memória',
      closeToTrash: 'Fechar (vai para a lixeira)',
      close: 'Fechar',
      // Note
      noteColor: 'Cor da memória',
      colorIs: 'Cor: {name}',
      colorCustomIs: 'Cor: Personalizada ({hex})',
      editTitle: 'Editar título',
      noteTitle: 'Título da memória',
      untitled: 'Sem título',
      emptyNote: 'Memória vazia',
      noteText: 'Texto da memória',
      writeSomething: 'Escreva algo…',
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
      copyCode: 'Copiar código',
      copied: 'Copiado',
      plainText: 'Texto puro',
      textSize: 'Tamanho do texto',
      smallText: 'Texto pequeno',
      normalText: 'Texto normal',
      largeText: 'Texto grande',
      smaller: '{keys} diminui',
      larger: '{keys} aumenta',
      // Manager
      manager: 'Gerenciador do Memo',
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
      newNotes: 'Padrão das memórias',
      newNotesTip: 'Vale para as memórias criadas daqui em diante.',
      groupDefaults: 'Padrão dos grupos',
      groupDefaultsTip: 'Vale para os grupos criados daqui em diante. Começa em amarelo e sem título, como uma memória nova.',
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
      groupMenuTitle: 'Group',
      noGroup: 'No group',
      newGroup: 'New group',
      addToGroup: 'Add to a group',
      groupIs: 'Group: {name} (click to change)',
      moveToGroup: 'Memory group',
      groupName: 'Group name',
      groupRename: 'Rename group',
      groupColor: 'Group color',
      newNoteInGroup: 'New memory in this group',
      groupShowHint: 'Double-click to take the memories out',
      groupHideHint: 'Double-click to put the memories away',
      groupCountOne: '1 memory',
      groupCountMany: '{n} memories',
      deleteGroup: 'Delete group',
      deleteGroupConfirm: 'Click again: the group is deleted and its memories go to the trash',
      bringAllToFront: 'Bring all memories to the front',
      closeNote: 'Close memory',
      closeToTrash: 'Close (moves to trash)',
      close: 'Close',
      noteColor: 'Memory color',
      colorIs: 'Color: {name}',
      colorCustomIs: 'Color: Custom ({hex})',
      editTitle: 'Edit title',
      noteTitle: 'Memory title',
      untitled: 'Untitled',
      emptyNote: 'Empty memory',
      noteText: 'Memory text',
      writeSomething: 'Write something…',
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
      copyCode: 'Copy code',
      copied: 'Copied',
      plainText: 'Plain text',
      textSize: 'Text size',
      smallText: 'Small text',
      normalText: 'Normal text',
      largeText: 'Large text',
      smaller: '{keys} smaller',
      larger: '{keys} larger',
      manager: 'Memo Manager',
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
      newNotes: 'Memory defaults',
      newNotesTip: 'Applies to memories created from now on.',
      groupDefaults: 'Group defaults',
      groupDefaultsTip: 'Applies to groups created from now on. Starts yellow and untitled, like a new memory.',
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
          ['Título', 'Passe o mouse sobre o título e clique no lápis que aparece à esquerda dele; {{Enter}} salva e {{Esc}} cancela.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<i data-icon="pencil" class="demo-hot"></i><span class="demo-name">Lista de compras</span></span>'],
          ['Recolher', 'Clique duplo na barra de título: a memória fica só com a barra; outro clique duplo a expande.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-name">Lista de compras</span><i data-icon="plus"></i><i data-icon="close"></i></span>'],
          ['Cor', 'Clique na bolinha colorida ao lado do título. "Personalizada" abre qualquer cor.',
            '<span class="demo-dots"><span class="demo-dot" data-color="yellow"></span><span class="demo-dot" data-color="green"></span>'
            + '<span class="demo-dot" data-color="coral"></span><span class="demo-dot" data-color="teal"></span>'
            + '<span class="demo-dot" data-color="iris"></span><span class="demo-dot" data-color="lavender"></span>'
            + '<span class="demo-dot" data-color="mono"></span><span class="demo-dot demo-rainbow"></span><span class="demo-dot" data-color=""></span></span>'],
          ['Mover e redimensionar', 'Arraste pela barra de título ou pelas bordas. Perto da borda da tela ou de outra memória, ela gruda.'],
          ['Encaixar na tela', 'Arraste até encostar o cursor na borda da tela: aparece uma prévia da metade (laterais), de um quarto (cantos) ou da tela inteira (topo). Solte para encaixar; ao arrastar de novo, ela volta ao tamanho anterior.'],
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
          ['Bloco de código', 'Digite {{```}} (ou {{```sql}}) e {{Enter}}. Passe o mouse sobre o bloco: à esquerda escolhe a linguagem, à direita copia o código. {{Enter}} numa linha vazia no fim sai do bloco.',
            '<pre class="code" data-lang="sql">select titulo\nfrom memorias\nwhere fixada = true; -- só as fixadas</pre>'],
          ['Colar', 'O texto colado entra sempre sem formatação.'],
        ],
      },
      {
        title: 'Grupos',
        items: [
          ['O que é', 'Uma barrinha que guarda várias memórias. Clique duplo nela: as memórias saem para onde estavam; outro clique duplo as recolhe para dentro dela.',
            '<span class="demo-bar"><i data-icon="pin"></i><i data-icon="folder"></i><span class="demo-name">Trabalho</span>'
            + '<span class="demo-meta">3</span><i data-icon="close"></i></span>'],
          ['Criar', 'Botão de pasta com + na barra do Gerenciador, ou no rodapé de uma memória (onde aparece "Sem grupo") escolha "Novo grupo": ele começa sem nome, como uma memória nova. Também pela caixa de grupo na lista do Gerenciador.'],
          ['Nova memória no grupo', 'O botão + da barra (ou {{Mod+N}} com o grupo em foco) cria uma memória já dentro do grupo, ao lado dele.',
            '<span class="demo-bar" data-color="coral"><i data-icon="pin"></i><i data-icon="folder" class="demo-tint"></i>'
            + '<span class="demo-name">Trabalho</span><span class="demo-meta">3</span><i data-icon="plus" class="demo-hot"></i><i data-icon="close"></i></span>'],
          ['Adicionar memórias', 'Arraste uma memória e solte sobre o grupo, ou escolha o grupo no rodapé da memória ou no Gerenciador. O nome do grupo aparece no rodapé.',
            '<span class="demo-foot"><i data-icon="folder"></i>Trabalho</span><span class="demo-foot-meta">12 palavras</span>'],
          ['Renomear', 'Passe o mouse sobre o nome do grupo e clique no lápis; {{Enter}} salva e {{Esc}} cancela.'],
          ['Cor', 'Clique no ícone de pasta do grupo e escolha a cor: ela pinta a pasta, a faixa da barra e o ícone do grupo no rodapé das memórias.',
            '<span class="demo-bar" data-color="coral"><i data-icon="pin"></i><i data-icon="folder" class="demo-tint demo-hot"></i>'
            + '<span class="demo-name">Trabalho</span><span class="demo-meta">3</span><i data-icon="close"></i></span>'],
          ['Fixar', 'A tachinha do grupo o mantém por cima de tudo, como numa memória ({{Mod+Shift+P}}).',
            '<span class="demo-bar"><i data-icon="pin-on"></i><i data-icon="folder"></i><span class="demo-name">Trabalho</span>'
            + '<span class="demo-meta">3</span><i data-icon="close"></i></span>'],
          ['Tirar do grupo', 'No rodapé da memória ou no Gerenciador, escolha "Sem grupo".'],
          ['Excluir', 'Clique duas vezes no ✕ do grupo: ele some e as memórias dele vão para a lixeira.'],
        ],
      },
      {
        title: 'Gerenciador do Memo',
        items: [
          ['Abrir', 'Abre junto com o app, ou pelo ícone do Memo na bandeja.'],
          ['Recolher', 'Clique duplo na barra do Gerenciador: ele fica só com a barra; outro clique duplo o expande (como nas memórias).'],
          ['Novo grupo', 'O botão de pasta com + na barra do Gerenciador cria um grupo vazio ao lado dele.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-name">Gerenciador do Memo</span>'
            + '<i data-icon="raise"></i><i data-icon="folder-plus" class="demo-hot"></i><i data-icon="plus"></i><i data-icon="close"></i></span>'],
          ['Trazer para a frente', 'O botão ao lado do + na barra do Gerenciador traz todas as memórias abertas para a frente das outras janelas, inclusive as minimizadas.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-name">Gerenciador do Memo</span>'
            + '<i data-icon="raise" class="demo-hot"></i><i data-icon="plus"></i><i data-icon="close"></i></span>'],
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
          ['Padrão', 'Cor, título e texto com que as memórias novas começam; cor e título dos grupos novos.'],
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
          ['Title', 'Hover over the title and click the pencil that appears to its left; {{Enter}} saves and {{Esc}} cancels.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<i data-icon="pencil" class="demo-hot"></i><span class="demo-name">Shopping list</span></span>'],
          ['Collapse', 'Double-click the titlebar: the memory shrinks to its bar; double-click again to expand it.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-dot" data-color="yellow"></span>'
            + '<span class="demo-name">Shopping list</span><i data-icon="plus"></i><i data-icon="close"></i></span>'],
          ['Color', 'Click the colored dot next to the title. "Custom" opens any color.',
            '<span class="demo-dots"><span class="demo-dot" data-color="yellow"></span><span class="demo-dot" data-color="green"></span>'
            + '<span class="demo-dot" data-color="coral"></span><span class="demo-dot" data-color="teal"></span>'
            + '<span class="demo-dot" data-color="iris"></span><span class="demo-dot" data-color="lavender"></span>'
            + '<span class="demo-dot" data-color="mono"></span><span class="demo-dot demo-rainbow"></span><span class="demo-dot" data-color=""></span></span>'],
          ['Move and resize', 'Drag by the titlebar or the edges. Near a screen edge or another memory, it snaps.'],
          ['Snap to the screen', 'Drag until the cursor touches a screen edge: a preview shows half the screen (sides), a quarter (corners) or the whole screen (top). Release to snap; drag it again to get its previous size back.'],
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
          ['Code block', 'Type {{```}} (or {{```sql}}) and {{Enter}}. Hover over the block: pick its language on the left, copy the code on the right. {{Enter}} on an empty last line leaves the block.',
            '<pre class="code" data-lang="sql">select title\nfrom memories\nwhere pinned = true; -- pinned only</pre>'],
          ['Paste', 'Pasted text always comes in without formatting.'],
        ],
      },
      {
        title: 'Groups',
        items: [
          ['What it is', 'A small bar that holds several memories. Double-click it: the memories come out where they were; double-click again to put them back in.',
            '<span class="demo-bar"><i data-icon="pin"></i><i data-icon="folder"></i><span class="demo-name">Work</span>'
            + '<span class="demo-meta">3</span><i data-icon="close"></i></span>'],
          ['Create', 'The folder-with-+ button in the Manager’s titlebar, or "New group" in a memory’s footer (where it says "No group"): it starts unnamed, like a new memory. Also from the group box in the Manager’s list.'],
          ['New memory in the group', 'The bar’s + button (or {{Mod+N}} with the group focused) creates a memory already in the group, next to it.',
            '<span class="demo-bar" data-color="coral"><i data-icon="pin"></i><i data-icon="folder" class="demo-tint"></i>'
            + '<span class="demo-name">Work</span><span class="demo-meta">3</span><i data-icon="plus" class="demo-hot"></i><i data-icon="close"></i></span>'],
          ['Add memories', 'Drag a memory and drop it on the group, or pick the group in the memory’s footer or in the Manager. The group’s name shows in the footer.',
            '<span class="demo-foot"><i data-icon="folder"></i>Work</span><span class="demo-foot-meta">12 words</span>'],
          ['Rename', 'Hover over the group’s name and click the pencil; {{Enter}} saves and {{Esc}} cancels.'],
          ['Color', 'Click the group’s folder icon and pick a color: it tints the folder, the bar’s stripe and the group icon in its memories’ footer.',
            '<span class="demo-bar" data-color="coral"><i data-icon="pin"></i><i data-icon="folder" class="demo-tint demo-hot"></i>'
            + '<span class="demo-name">Work</span><span class="demo-meta">3</span><i data-icon="close"></i></span>'],
          ['Pin', 'The group’s pin keeps it on top of everything, like a memory’s ({{Mod+Shift+P}}).',
            '<span class="demo-bar"><i data-icon="pin-on"></i><i data-icon="folder"></i><span class="demo-name">Work</span>'
            + '<span class="demo-meta">3</span><i data-icon="close"></i></span>'],
          ['Remove from group', 'In the memory’s footer or in the Manager, choose "No group".'],
          ['Delete', 'Click the group’s ✕ twice: it goes away and its memories go to the trash.'],
        ],
      },
      {
        title: 'Memo Manager',
        items: [
          ['Open', 'Opens with the app, or from the Memo tray icon.'],
          ['Collapse', 'Double-click the Manager’s titlebar: it shrinks to its bar; double-click again to expand it (as for memories).'],
          ['New group', 'The folder-with-+ button in the Manager’s titlebar creates an empty group next to it.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-name">Memo Manager</span>'
            + '<i data-icon="raise"></i><i data-icon="folder-plus" class="demo-hot"></i><i data-icon="plus"></i><i data-icon="close"></i></span>'],
          ['Bring to front', 'The button next to + in the Manager’s titlebar brings every open memory in front of other windows, minimized ones included.',
            '<span class="demo-bar"><i data-icon="pin"></i><span class="demo-name">Memo Manager</span>'
            + '<i data-icon="raise" class="demo-hot"></i><i data-icon="plus"></i><i data-icon="close"></i></span>'],
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
          ['Defaults', 'Color, title and text that new memories start with; color and title of new groups.'],
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
