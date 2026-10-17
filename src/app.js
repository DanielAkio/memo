// Taxinha — lógica de uma janela de nota.
// Cada nota é uma janela própria; o Rust guarda texto, posição, tamanho e estado.

(() => {
  const { invoke } = window.__TAURI__.core;
  const appWindow = window.__TAURI__.window.getCurrentWindow();
  const { LogicalSize } = window.__TAURI__.dpi;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = (...parts) => (isMac
    ? parts.map((p) => ({ Mod: '⌘', Shift: '⇧' }[p] || p)).join('')
    : parts.map((p) => ({ Mod: 'Ctrl' }[p] || p)).join('+'));

  const $ = (id) => document.getElementById(id);
  const I18n = window.TaxinhaI18n;
  const { t } = I18n;
  const frame = $('frame');
  const titlebar = $('titlebar');
  const editor = $('editor');
  const pinBtn = $('pinBtn');
  const colorMenu = $('colorMenu');
  const formatBar = $('formatBar');
  const collapseBtn = $('collapseBtn');
  const colorBtn = $('colorBtn');
  const nameEl = $('noteName');
  const titleInput = $('titleInput');

  let note = null;
  let saveTimer = null;
  let textDirty = false;
  let titleTimer = null;
  let renaming = false;
  let colorsGrown = false;

  // ------------------------------------------------------------ helpers

  const customSwatch = document.querySelector('.swatch[data-color="custom"]');
  const customColor = $('customColor');
  const isCustomColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

  const colorName = (color) => document.querySelector(`.swatch[data-color="${color}"]`).getAttribute('aria-label');

  // Item de checklist no texto puro: "[ ]" ou "[x]" no começo da linha.
  const CHECK_RE = /^(\s*)\[([ xX])\](?= |$) ?/;
  const plain = (t) => t.replace(/^(\s*)\[[ xX]\](?= |$) ?/gm, '$1');

  const firstLine = (t) => plain(t).split('\n').map((s) => s.trim()).find(Boolean) || t('emptyNote');
  const wordCount = (t) => (plain(t).trim().match(/\S+/g) || []).length;
  const displayName = () => note.title || firstLine(note.text);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function editedLabel(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    const fmt = new Intl.DateTimeFormat(I18n.locale(), sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short' });
    return t('edited', { when: fmt.format(d).replace('.', '') });
  }

  // ------------------------------------------------------------- render

  function render() {
    // Cor personalizada (#rrggbb) vai direto na variável --note-color.
    const custom = isCustomColor(note.color);
    frame.dataset.color = custom ? 'custom' : note.color || '';
    if (custom) frame.style.setProperty('--note-color', note.color);
    else frame.style.removeProperty('--note-color');
    customSwatch.style.setProperty('--sw', custom ? note.color : '');
    if (!custom) customSwatch.style.removeProperty('--sw');
    frame.classList.toggle('is-collapsed', note.collapsed);

    pinBtn.setAttribute('aria-pressed', String(note.pinned));
    const pinLabel = t(note.pinned ? 'unpin' : 'pin');
    pinBtn.setAttribute('aria-label', pinLabel);
    pinBtn.title = `${pinLabel} (${keys('Mod', 'Shift', 'P')})`;

    for (const sw of document.querySelectorAll('.swatch')) {
      const checked = sw === customSwatch ? custom : sw.dataset.color === (note.color || '');
      sw.setAttribute('aria-checked', String(checked));
    }
    const collapseLabel = t(note.collapsed ? 'expandNote' : 'collapseNote');
    collapseBtn.setAttribute('aria-label', collapseLabel);
    collapseBtn.title = collapseLabel;
    colorBtn.title = custom
      ? t('colorCustomIs', { hex: note.color })
      : t('colorIs', { name: colorName(note.color || '') });
    renderMeta();
  }

  function renderMeta() {
    const n = wordCount(note.text);
    $('count').textContent = t(n === 1 ? 'wordOne' : 'wordMany', { n });
    $('edited').textContent = note.text.trim() ? editedLabel(note.updatedAt) : t('newNoteStatus');
    editor.classList.toggle('is-empty', !note.text.trim() && !editor.querySelector('.check'));
    renderName();
  }

  // Nome na barra: o título, ou "Sem título" (mesmo com a nota recolhida).
  function renderName() {
    nameEl.textContent = note.title || t('untitled');
    nameEl.classList.toggle('is-empty', !note.title);

    // O título da janela nativa aparece na taskbar; atualiza sem pressa.
    const title = `${displayName()} — Taxinha`;
    if (document.title === title) return;
    document.title = title;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      appWindow.setTitle(title).catch((err) => console.error('setTitle', err));
    }, 400);
  }

  // ------------------------------------------------- conteúdo do editor
  //
  // O editor é um contenteditable em que cada linha é um <div>. Formatação
  // fica em <b>, <i> e <u>; um item de checklist é <div class="check">
  // (marcado: "check done"). Além do HTML, a nota guarda o texto puro, com
  // os itens como "[ ] " / "[x] ", que o Rust usa na bandeja.

  const isBlock = (n) => n !== editor && n.nodeType === 1 && (n.nodeName === 'DIV' || n.nodeName === 'P');
  const INLINE = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u' };
  const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

  // Texto puro a partir do HTML do editor.
  function toPlain() {
    const lines = [];
    let cur = null;
    const flush = () => {
      if (cur !== null) lines.push(cur);
      cur = null;
    };
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          cur = (cur ?? '') + n.data;
        } else if (n.nodeName === 'BR') {
          // O <br> final de um bloco só segura a altura de uma linha vazia.
          if (n.nextSibling || !isBlock(n.parentNode)) { lines.push(cur ?? ''); cur = ''; } else cur = cur ?? '';
        } else if (isBlock(n)) {
          flush();
          cur = n.classList.contains('check') ? (n.classList.contains('done') ? '[x] ' : '[ ] ') : '';
          walk(n);
          flush();
        } else if (n.nodeType === 1) {
          walk(n);
        }
      }
    };
    walk(editor);
    flush();
    return lines.join('\n');
  }

  // HTML para notas que só têm texto puro (criadas antes da formatação).
  function fromPlain(text) {
    if (!text) return '<div><br></div>';
    return text.split('\n').map((line) => {
      const m = CHECK_RE.exec(line);
      const body = m ? line.slice(m[0].length) : line;
      const cls = m ? ` class="check${m[2] === ' ' ? '' : ' done'}"` : '';
      return `<div${cls}>${body ? esc(body) : '<br>'}</div>`;
    }).join('');
  }

  // Remonta o HTML salvo só com o que o editor usa: linhas, <br>, <b>, <i>,
  // <u> e as classes do checklist. Qualquer outra coisa vira texto.
  function sanitize(html) {
    const src = new DOMParser().parseFromString(html, 'text/html').body;
    const out = document.createDocumentFragment();
    const copy = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === 3) {
          to.appendChild(document.createTextNode(n.data));
        } else if (DROP.has(n.nodeName)) {
          continue;
        } else if (n.nodeName === 'BR') {
          to.appendChild(document.createElement('br'));
        } else if (isBlock(n)) {
          const div = document.createElement('div');
          if (n.classList.contains('check')) div.classList.add('check');
          if (n.classList.contains('done')) div.classList.add('done');
          copy(n, div);
          to.appendChild(div);
        } else if (INLINE[n.nodeName]) {
          copy(n, to.appendChild(document.createElement(INLINE[n.nodeName])));
        } else if (n.nodeName === 'FONT' && SIZES.includes(n.getAttribute('size'))) {
          const font = to.appendChild(document.createElement('font'));
          font.setAttribute('size', n.getAttribute('size'));
          copy(n, font);
        } else if (n.nodeType === 1) {
          copy(n, to);
        }
      }
    };
    copy(src, out);

    // Garante que tudo esteja dentro de linhas (<div>).
    const wrapped = document.createDocumentFragment();
    let run = null;
    for (const n of [...out.childNodes]) {
      if (n.nodeName === 'DIV') {
        run = null;
        if (!n.firstChild) n.appendChild(document.createElement('br'));
        wrapped.appendChild(n);
      } else {
        if (!run) run = wrapped.appendChild(document.createElement('div'));
        run.appendChild(n);
      }
    }
    if (!wrapped.firstChild) wrapped.appendChild(document.createElement('div')).appendChild(document.createElement('br'));
    return wrapped;
  }

  function loadContent() {
    editor.replaceChildren(note.html ? sanitize(note.html) : sanitize(fromPlain(note.text)));
  }

  // A linha (filha direta do editor) onde está o cursor.
  function currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    while (n && n.parentNode !== editor) n = n.parentNode;
    return n && n.nodeName === 'DIV' ? n : null;
  }

  // Texto entre o começo da linha e o cursor.
  function textBeforeCaret(block) {
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r;
  }

  // --------------------------------------------------------------- save

  function scheduleSave() {
    textDirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushText, 250);
  }

  async function flushText() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!textDirty) return;
    textDirty = false;
    try {
      await invoke('save_text', { text: note.text, html: note.html });
    } catch (err) {
      textDirty = true;
      console.error('save_text', err);
    }
  }

  function onContentChanged() {
    note.text = toPlain();
    note.html = editor.innerHTML;
    note.updatedAt = Date.now();
    renderMeta();
    scheduleSave();
  }

  // ---------------------------------------------------------- checklist

  // "[]" digitado no começo de uma linha transforma a linha em item.
  function expandCheckbox() {
    const sel = getSelection();
    if (!sel.isCollapsed) return false;
    let block = currentBlock();
    if (!block) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
    }
    if (!block || block.classList.contains('check')) return false;
    const before = textBeforeCaret(block);
    // "[]", "[ ]" ou "[x]" (este já marcado).
    const m = /^\s*\[([  xX]?)\]$/.exec(before.toString());
    if (!m) return false;
    const done = /x/i.test(m[1]);
    sel.removeAllRanges();
    sel.addRange(before);
    document.execCommand('delete'); // entra no desfazer
    // Se a linha ficou vazia e era a única, o Chromium remove o próprio <div>;
    // nesse caso recria a linha no lugar do cursor.
    if (!block.isConnected) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
      if (!block) return false;
    }
    block.classList.add('check');
    block.classList.toggle('done', done);
    return true;
  }

  function toggleCheck(block) {
    block.classList.toggle('done');
    onContentChanged();
  }

  // Clique na caixa (à esquerda do item) marca/desmarca sem mover o cursor.
  function checkAt(e) {
    const block = e.target.closest && e.target.closest('.check');
    if (!block || !editor.contains(block)) return null;
    return e.clientX < block.getBoundingClientRect().left + 22 ? block : null;
  }

  function onEditorKeydown(e) {
    if (e.isComposing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();

    // Atalhos de formatação no padrão de mercado.
    if (mod && !e.shiftKey && !e.altKey && FORMAT_KEYS[key]) {
      e.preventDefault();
      format(FORMAT_KEYS[key]);
      return;
    }
    if (mod && e.shiftKey && !e.altKey && (e.code === 'Period' || e.code === 'Comma')) {
      e.preventDefault();
      stepSize(e.code === 'Period' ? 1 : -1);
      return;
    }

    const block = currentBlock();
    if (!block || !block.classList.contains('check')) return;
    const atStart = getSelection().isCollapsed && textBeforeCaret(block).toString() === '';

    // Enter num item vazio, ou Backspace no começo do item, sai da lista.
    if ((e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && block.textContent.trim() === '')
        || (e.key === 'Backspace' && !mod && atStart)) {
      e.preventDefault();
      block.classList.remove('check', 'done');
      if (!block.classList.length) block.removeAttribute('class');
      onContentChanged();
    }
  }

  // Espaço digitado logo no começo de um item é descartado ("[] tarefa").
  function swallowLeadingSpace() {
    const block = currentBlock();
    if (!block || !block.classList.contains('check')) return;
    if (!/^[  ]$/.test(textBeforeCaret(block).toString())) return;
    document.execCommand('delete');
  }

  function onEditorInput(e) {
    if (e.inputType === 'insertText' && e.data === ']') expandCheckbox();
    if (e.inputType === 'insertText' && e.data === ' ') swallowLeadingSpace();
    // Enter num item cria o próximo item (o navegador copia a linha), desmarcado.
    if (e.inputType === 'insertParagraph') currentBlock()?.classList.remove('done');
    onContentChanged();
  }

  // Colar sempre como texto puro: evita trazer estilos de outros apps.
  function onPaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  }

  // ---------------------------------------------------------- formatação

  const FORMAT_KEYS = { b: 'bold', i: 'italic', u: 'underline' };

  function format(cmd) {
    editor.focus();
    document.execCommand(cmd);
    onContentChanged();
    scheduleFormatBar();
  }

  // Tamanhos de texto: o execCommand gera <font size="N"> e o CSS define o
  // tamanho real de cada N. "3" é o normal.
  const SIZES = ['2', '3', '5'];

  function currentSize() {
    const sel = getSelection();
    if (!sel.rangeCount) return '3';
    // Desce até o primeiro texto da seleção (uma linha inteira selecionada
    // começa no <div>, não dentro do <font>).
    const range = sel.getRangeAt(0);
    let n = range.startContainer.childNodes[range.startOffset] || range.startContainer;
    while (n.firstChild) n = n.firstChild;
    if (n.nodeType === 3) n = n.parentNode;
    const font = n.closest && n.closest('font[size]');
    return font && editor.contains(font) ? font.getAttribute('size') : '3';
  }

  function setSize(size) {
    editor.focus();
    document.execCommand('fontSize', false, size);
    onContentChanged();
    scheduleFormatBar();
  }

  // Ctrl+Shift+> / Ctrl+Shift+< sobem ou descem um tamanho.
  function stepSize(dir) {
    const i = SIZES.indexOf(currentSize());
    const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? 1 : i) + dir))];
    if (next !== currentSize()) setSize(next);
  }

  // ------------------------------------------- barra de formatação

  // Ao selecionar texto, uma barrinha com negrito/itálico/sublinhado aparece
  // logo acima da seleção (ou abaixo, se não couber acima).
  let selecting = false;
  let barFrame = 0;

  function selectionRange() {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  function updateFormatBar() {
    const range = !selecting && note && !note.collapsed && document.activeElement === editor && selectionRange();
    const rects = range ? [...range.getClientRects()].filter((r) => r.width || r.height) : [];
    if (!rects.length) { hideFormatBar(); return; }

    for (const btn of formatBar.querySelectorAll('[data-cmd]')) {
      btn.setAttribute('aria-pressed', String(document.queryCommandState(btn.dataset.cmd)));
    }
    const size = currentSize();
    for (const btn of formatBar.querySelectorAll('[data-size]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.size === size));
    }
    formatBar.hidden = false;

    const first = rects[0];
    const last = rects[rects.length - 1];
    const bounds = editor.getBoundingClientRect();
    const w = formatBar.offsetWidth;
    const h = formatBar.offsetHeight;
    const center = rects.length === 1 ? (first.left + first.right) / 2 : first.left + 24;
    // Acima da seleção (pode cobrir a barra de título); sem espaço, abaixo.
    let top = first.top - h - 6;
    if (top < 4) top = last.bottom + 6;
    top = Math.max(4, Math.min(top, bounds.bottom - h));
    const left = Math.max(4, Math.min(center - w / 2, window.innerWidth - w - 4));
    formatBar.style.left = `${left}px`;
    formatBar.style.top = `${top}px`;
  }

  const scheduleFormatBar = () => {
    cancelAnimationFrame(barFrame);
    barFrame = requestAnimationFrame(updateFormatBar);
  };

  function hideFormatBar() {
    formatBar.hidden = true;
  }

  // ------------------------------------------------------------ actions

  async function togglePin() {
    const next = !note.pinned;
    note.pinned = next; // resposta imediata; reverte se o sistema recusar
    render();
    try {
      note.pinned = await invoke('set_pinned', { pinned: next });
    } catch (err) {
      note.pinned = !next;
      console.error('set_pinned', err);
    }
    render();
  }

  async function toggleCollapse() {
    closeColors(false);
    hideFormatBar();
    note.collapsed = !note.collapsed;
    render();
    try {
      await invoke('set_collapsed', { collapsed: note.collapsed });
    } catch (err) {
      console.error('set_collapsed', err);
    }
    if (!note.collapsed) editor.focus();
  }

  async function newNote() {
    closeColors();
    await flushText();
    invoke('new_note').catch((err) => console.error('new_note', err));
  }

  async function setColor(color) {
    note.color = color;
    render();
    invoke('set_color', { color }).catch((err) => console.error('set_color', err));
  }

  // Fechar manda a nota para a lixeira (recuperável pela bandeja por 30 dias).
  async function closeNote() {
    closeColors();
    if (renaming) await finishRename(true);
    await flushText();
    invoke('trash_note').catch((err) => console.error('trash_note', err));
  }

  // ------------------------------------------------------------ título

  function startRename() {
    if (renaming) return;
    renaming = true;
    closeColors();
    titleInput.value = note.title;
    nameEl.hidden = true;
    titleInput.hidden = false;
    titleInput.focus();
    titleInput.select();
  }

  async function finishRename(save) {
    if (!renaming) return;
    renaming = false;
    const value = titleInput.value.trim();
    titleInput.hidden = true;
    nameEl.hidden = false;
    if (save && value !== note.title) {
      note.title = value;
      renderName();
      try {
        note.title = await invoke('set_title', { title: value });
      } catch (err) {
        console.error('set_title', err);
      }
    }
    renderName();
    if (!note.collapsed) editor.focus();
  }

  // -------------------------------------------------------- seletor de cor

  // Recolhida, a janela só tem a altura da barra de título: enquanto o
  // seletor estiver aberto ela cresce o suficiente para mostrá-lo.
  const resizeWindow = (height) => appWindow
    .setSize(new LogicalSize(window.innerWidth, height))
    .catch((err) => console.error('setSize', err));

  function openColors() {
    hideFormatBar();
    colorMenu.hidden = false;
    frame.classList.add('menu-open');
    colorBtn.setAttribute('aria-expanded', 'true');
    if (note.collapsed) {
      colorsGrown = true;
      resizeWindow(colorMenu.offsetTop + colorMenu.offsetHeight + 6);
    }
  }

  // `shrink = false` quando outra ação já vai redimensionar a janela.
  function closeColors(shrink = true) {
    if (colorMenu.hidden) return;
    colorMenu.hidden = true;
    frame.classList.remove('menu-open');
    colorBtn.setAttribute('aria-expanded', 'false');
    if (colorsGrown) {
      colorsGrown = false;
      if (shrink) resizeWindow(titlebar.offsetHeight);
    }
  }

  // ------------------------------------------------------------- events

  editor.addEventListener('input', onEditorInput);
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('blur', flushText);
  editor.addEventListener('scroll', scheduleFormatBar);

  editor.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const block = checkAt(e);
    if (!block) return;
    e.preventDefault();
    toggleCheck(block);
  });
  editor.addEventListener('mousemove', (e) => {
    editor.style.cursor = checkAt(e) ? 'default' : '';
  });

  // Durante o arraste da seleção a barra fica escondida; aparece ao soltar.
  editor.addEventListener('mousedown', (e) => {
    if (e.button === 0) { selecting = true; hideFormatBar(); }
  });
  document.addEventListener('mouseup', () => {
    if (!selecting) return;
    selecting = false;
    scheduleFormatBar();
  });
  document.addEventListener('selectionchange', scheduleFormatBar);
  new ResizeObserver(scheduleFormatBar).observe(editor);

  // mousedown com preventDefault: o clique na barra não tira a seleção do texto.
  formatBar.addEventListener('mousedown', (e) => e.preventDefault());
  formatBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd], [data-size]');
    if (!btn) return;
    if (btn.dataset.size) setSize(btn.dataset.size);
    else format(btn.dataset.cmd);
  });

  pinBtn.addEventListener('click', togglePin);
  $('newBtn').addEventListener('click', newNote);
  collapseBtn.addEventListener('click', toggleCollapse);
  $('closeBtn').addEventListener('click', closeNote);

  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
  });
  titleInput.addEventListener('blur', () => finishRename(true));

  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colorMenu.hidden ? openColors() : closeColors();
  });
  $('swatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    if (sw === customSwatch) {
      // Abre o seletor do sistema já na cor atual da nota.
      customColor.value = isCustomColor(note.color)
        ? note.color
        : (getComputedStyle(frame).getPropertyValue('--note-color').trim().match(/^#[0-9a-f]{6}$/i) || ['#f2c94c'])[0];
      customColor.click();
      return;
    }
    setColor(sw.dataset.color);
    closeColors();
  });
  // Só aplica ao confirmar no seletor; cancelar não muda nada.
  customColor.addEventListener('change', () => {
    setColor(customColor.value.toLowerCase());
    closeColors();
  });
  document.addEventListener('mousedown', (e) => {
    if (!colorMenu.hidden && !colorMenu.contains(e.target) && !colorBtn.contains(e.target)) closeColors();
  });

  // Barra de título (chrome.js): arrastar com ímã, clique duplo edita o
  // título, clique do meio fecha; alça de redimensionar no canto.
  window.TaxinhaChrome.attach({
    frame,
    titlebar,
    grip: $('grip'),
    onDoubleClick: startRename,
    onClose: closeNote,
  });

  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key === 'p') { e.preventDefault(); togglePin(); }
    else if (mod && !e.shiftKey && key === 'n') { e.preventDefault(); newNote(); }
    else if (e.key === 'Escape') { closeColors(); hideFormatBar(); }
  });

  // Menu de contexto nativo só no texto e no campo de título (copiar, colar,
  // ortografia); no resto da nota ele não faz sentido.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, #editor')) e.preventDefault();
  });

  window.addEventListener('focus', () => frame.classList.add('is-focused'));
  window.addEventListener('blur', () => {
    frame.classList.remove('is-focused');
    hideFormatBar();
    // Recolhida, o seletor aberto deixa a janela maior; fecha ao sair da nota.
    if (colorsGrown) closeColors();
    flushText();
  });
  window.addEventListener('beforeunload', () => {
    if (textDirty) invoke('save_text', { text: note.text, html: note.html });
  });

  // Atualiza o "editada às…" na virada do dia.
  setInterval(() => note && renderMeta(), 60_000);

  // --------------------------------------------------------------- init

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    renderMonoName();
  }

  // A cor "mono" é branca no tema escuro e preta no claro; o nome acompanha.
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  function renderMonoName() {
    const theme = document.documentElement.dataset.theme;
    const light = theme ? theme === 'light' : systemLight.matches;
    const name = t(light ? 'black' : 'white');
    const sw = document.querySelector('.swatch[data-color="mono"]');
    sw.setAttribute('aria-label', name);
    sw.title = name;
    if (note) render();
  }
  systemLight.addEventListener('change', renderMonoName);

  // Textos que dependem do idioma e não estão só no HTML (tooltips com
  // atalhos, placeholder, ortografia). Chamado ao abrir e ao trocar o idioma.
  function applyLanguage(lang) {
    I18n.set(lang);
    editor.lang = I18n.locale();
    editor.dataset.placeholder = I18n.placeholder();
    $('newBtn').title = `${t('newNote')} (${keys('Mod', 'N')})`;
    $('closeBtn').title = t('closeToTrash');
    for (const btn of formatBar.querySelectorAll('[data-key]')) {
      btn.title = `${btn.getAttribute('aria-label')} (${keys('Mod', btn.dataset.key)})`;
    }
    const sizeKeys = {
      2: ` (${t('smaller', { keys: keys('Mod', 'Shift', '<') })})`,
      5: ` (${t('larger', { keys: keys('Mod', 'Shift', '>') })})`,
    };
    for (const btn of formatBar.querySelectorAll('[data-size]')) {
      btn.title = btn.getAttribute('aria-label') + (sizeKeys[btn.dataset.size] || '');
    }
    renderMonoName();
  }

  async function init() {
    const [, lang] = await invoke('get_language');
    applyLanguage(lang);
    window.__TAURI__.event.listen('language-changed', (e) => applyLanguage(e.payload));

    // Formatação em tags (<b>, <i>, <u>), não em style="…".
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('defaultParagraphSeparator', false, 'div');

    // Tema escolhido na bandeja ("system" = segue o sistema, via CSS).
    applyTheme(await invoke('get_theme'));
    window.__TAURI__.event.listen('theme-changed', (e) => applyTheme(e.payload));

    note = await invoke('load_note');
    if (!note) return;
    loadContent();
    render();
    if (document.hasFocus()) frame.classList.add('is-focused');
    if (!note.collapsed) {
      editor.focus();
      const r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  }

  init().catch((err) => console.error('init', err));
})();
