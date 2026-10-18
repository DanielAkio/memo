// Memo — lógica de uma janela de nota.
// Cada nota é uma janela própria; o Rust guarda texto, posição, tamanho e estado.

(() => {
  // Modo embutido (index.html?defaults): a mesma página serve de editor do
  // texto padrão das notas novas, dentro do Gerenciador. Sem barra de título
  // nem rodapé; lê e salva o padrão em vez de uma nota. Num <iframe>, a API do
  // Tauri vem da janela de cima.
  const EMBED = new URLSearchParams(location.search).has('defaults');
  const TAURI = window.__TAURI__ || window.parent.__TAURI__;
  if (EMBED) document.documentElement.classList.add('embedded');

  const { invoke } = TAURI.core;
  const appWindow = TAURI.window.getCurrentWindow();
  const { LogicalSize } = TAURI.dpi || {};

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = (...parts) => (isMac
    ? parts.map((p) => ({ Mod: '⌘', Shift: '⇧' }[p] || p)).join('')
    : parts.map((p) => ({ Mod: 'Ctrl' }[p] || p)).join('+'));

  const $ = (id) => document.getElementById(id);
  const I18n = window.MemoI18n;
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
  // Também aceita "[]" (digitado no texto padrão das notas novas).
  // Os parâmetros não se chamam "t", que é a função de tradução.
  // Linha de lista no texto puro: recuo (2 espaços por nível) seguido de
  // "[ ]"/"[]"/"[x]" (checklist) ou "-" (marcador).
  const LIST_RE = /^( *)(?:\[([ xX]?)\]|(-))(?= |$) ?/;
  const plain = (text) => text.replace(/^(\s*)(?:\[[ xX]?\]|-)(?= |$) ?/gm, '$1');
  const MAX_LEVEL = 4;

  const firstLine = (text) => plain(text).split('\n').map((s) => s.trim()).find(Boolean) || t('emptyNote');
  const wordCount = (text) => (plain(text).trim().match(/\S+/g) || []).length;
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

    if (EMBED) return;
    // O título da janela nativa aparece na taskbar; atualiza sem pressa.
    const title = `${displayName()} — Memo`;
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
  // (marcado: "check done") e um item com marcador é <div class="bullet">,
  // os dois com data-level (1–4) quando recuados com Tab. Além do HTML, a
  // nota guarda o texto puro, com os itens como "[ ] " / "[x] " / "- "
  // precedidos de 2 espaços por nível.

  const isBlock = (n) => n !== editor && n.nodeType === 1 && (n.nodeName === 'DIV' || n.nodeName === 'P');
  const INLINE = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', CODE: 'code' };
  const LANG_RE = /[^\w+#.-]/g;
  const ZWSP = /\u200b/g; // separador invisível depois de um `código`

  // Texto de um bloco de código (ou de um pedaço dele): texto e <br> (= quebra
  // de linha). Range.toString() ignora os <br>, por isso esta função.
  function preText(pre) {
    let out = '';
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) out += n.data;
        else if (n.nodeName === 'BR') out += '\n';
        else if (n.nodeType === 1) walk(n);
      }
    };
    walk(pre);
    return out.replace(ZWSP, '').replace(/\n$/, '');
  }
  const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

  const levelOf = (block) => Number(block.dataset.level) || 0;

  // Começo da linha no texto puro: recuo + marcador do item de lista.
  function listPrefix(block) {
    const indent = '  '.repeat(levelOf(block));
    if (block.classList.contains('check')) return indent + (block.classList.contains('done') ? '[x] ' : '[ ] ');
    if (block.classList.contains('bullet')) return `${indent}- `;
    return '';
  }

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
          cur = (cur ?? '') + n.data.replace(ZWSP, '');
        } else if (n.nodeName === 'PRE') {
          flush();
          lines.push(`\`\`\`${n.dataset.lang || ''}`);
          const body = preText(n);
          if (body) lines.push(...body.split('\n'));
          lines.push('```');
        } else if (n.nodeName === 'CODE') {
          cur = `${cur ?? ''}\`${n.textContent.replace(ZWSP, '')}\``;
        } else if (n.nodeName === 'BR') {
          // O <br> final de um bloco só segura a altura de uma linha vazia.
          if (n.nextSibling || !isBlock(n.parentNode)) { lines.push(cur ?? ''); cur = ''; } else cur = cur ?? '';
        } else if (isBlock(n)) {
          flush();
          cur = listPrefix(n);
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
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Bloco de código: ```linguagem ... ```
      const fence = /^```([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
        if (end > i) {
          const body = lines.slice(i + 1, end).join('\n');
          const lang = fence[1] ? ` data-lang="${esc(fence[1])}"` : '';
          out.push(`<pre class="code"${lang}>${body ? esc(body) : '<br>'}</pre>`);
          i = end;
          continue;
        }
      }
      const m = LIST_RE.exec(line);
      if (!m) {
        out.push(`<div>${line ? inline(line) : '<br>'}</div>`);
        continue;
      }
      const body = line.slice(m[0].length);
      const cls = m[3] ? 'bullet' : `check${/x/i.test(m[2]) ? ' done' : ''}`;
      const level = Math.min(MAX_LEVEL, Math.floor(m[1].length / 2));
      const lvl = level ? ` data-level="${level}"` : '';
      out.push(`<div class="${cls}"${lvl}>${body ? inline(body) : '<br>'}</div>`);
    }
    return out.join('');
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
        } else if (n.nodeName === 'PRE') {
          const pre = document.createElement('pre');
          pre.className = 'code';
          pre.spellcheck = false;
          const lang = (n.dataset.lang || '').replace(LANG_RE, '').slice(0, 20);
          if (lang) pre.dataset.lang = lang;
          const body = preText(n);
          if (body) pre.textContent = body;
          else pre.appendChild(document.createElement('br'));
          to.appendChild(pre);
        } else if (isBlock(n)) {
          const div = document.createElement('div');
          if (n.classList.contains('check')) div.classList.add('check');
          if (n.classList.contains('done')) div.classList.add('done');
          if (n.classList.contains('bullet')) div.classList.add('bullet');
          const level = Number(n.dataset.level);
          if ((div.classList.contains('check') || div.classList.contains('bullet')) && level >= 1) {
            div.dataset.level = String(Math.min(MAX_LEVEL, level));
          }
          copy(n, div);
          to.appendChild(div);
        } else if (INLINE[n.nodeName]) {
          const el = to.appendChild(document.createElement(INLINE[n.nodeName]));
          if (el.nodeName === 'CODE') el.spellcheck = false;
          copy(n, el);
        } else if (n.nodeName === 'FONT' && SIZES.includes(n.getAttribute('size'))) {
          const font = to.appendChild(document.createElement('font'));
          font.setAttribute('size', n.getAttribute('size'));
          copy(n, font);
        } else if (n.nodeName === 'SPAN' && isHighlight(n)) {
          const span = to.appendChild(document.createElement('span'));
          span.style.backgroundColor = HIGHLIGHT;
          copy(n, span);
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
      if (n.nodeName === 'DIV' || n.nodeName === 'PRE') {
        run = null;
        if (!n.firstChild) n.appendChild(document.createElement('br'));
        wrapped.appendChild(n);
      } else {
        if (!run) run = wrapped.appendChild(document.createElement('div'));
        run.appendChild(n);
      }
    }
    // Sempre há uma linha comum depois de um bloco de código no fim, para o
    // cursor ter onde ir.
    if (!wrapped.lastChild || wrapped.lastChild.nodeName === 'PRE') {
      wrapped.appendChild(document.createElement('div')).appendChild(document.createElement('br'));
    }
    return wrapped;
  }

  function loadContent() {
    editor.replaceChildren(note.html ? sanitize(note.html) : sanitize(fromPlain(note.text)));
    syncCheckSizes();
  }

  // Item de lista (checklist ou marcador) com todo o texto num só tamanho
  // (<font size>): marca a linha com data-size, para o CSS dar esse tamanho à
  // linha inteira e a caixa/bolinha e o risco ficarem no meio do texto.
  function syncCheckSizes() {
    for (const block of editor.querySelectorAll('.check, .bullet')) {
      const sizes = new Set();
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.data.trim()) continue;
        const font = n.parentElement.closest('font[size]');
        sizes.add(font && block.contains(font) ? font.getAttribute('size') : '3');
      }
      const [size] = sizes;
      if (sizes.size === 1 && size !== '3') block.dataset.size = size;
      else delete block.dataset.size;

      // Tamanhos misturados: a caixa vai para o meio da primeira linha medida.
      if (sizes.size > 1) {
        const r = document.createRange();
        r.selectNodeContents(block);
        const rects = [...r.getClientRects()].filter((rect) => rect.width > 0);
        if (rects.length) {
          // Retângulos da primeira linha: os que se sobrepõem ao primeiro.
          const line = rects.filter((rect) => rect.top < rects[0].bottom && rect.bottom > rects[0].top);
          const lineTop = Math.min(...line.map((rect) => rect.top));
          const lineBottom = Math.max(...line.map((rect) => rect.bottom));
          const mid = (lineTop + lineBottom) / 2 - block.getBoundingClientRect().top;
          block.style.setProperty('--check-mid', `${mid}px`);
        }
      } else {
        block.style.removeProperty('--check-mid');
        if (!block.getAttribute('style')) block.removeAttribute('style');
      }
    }
  }

  // HTML salvo: o do editor sem os ajustes de exibição do syncCheckSizes
  // (data-size e --check-mid), que são recalculados ao abrir.
  function contentHtml() {
    const copy = editor.cloneNode(true);
    for (const b of copy.querySelectorAll('[data-size]')) delete b.dataset.size;
    for (const b of copy.querySelectorAll('[style]')) {
      b.style.removeProperty('--check-mid');
      if (!b.getAttribute('style')) b.removeAttribute('style');
    }
    return copy.innerHTML;
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
      await invoke(EMBED ? 'set_default_content' : 'save_text', { text: note.text, html: note.html });
    } catch (err) {
      textDirty = true;
      console.error('save_text', err);
    }
  }

  function onContentChanged() {
    syncCheckSizes();
    note.text = toPlain();
    note.html = contentHtml();
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

  // ------------------------------------------------------------- código

  function currentPre() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const pre = el && el.closest('pre');
    return pre && editor.contains(pre) ? pre : null;
  }

  function currentCode() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const n = sel.getRangeAt(0).startContainer;
    const el = n.nodeType === 1 ? n : n.parentElement;
    const code = el && el.closest('code');
    return code && editor.contains(code) ? code : null;
  }

  // Põe o cursor no começo (ou no fim) de um elemento.
  function caretIn(el, atEnd = false) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(!atEnd);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }

  function openCodeBlock(line, lang) {
    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.spellcheck = false;
    const clean = lang.replace(LANG_RE, '').slice(0, 20);
    if (clean) pre.dataset.lang = clean;
    pre.appendChild(document.createElement('br'));
    line.replaceWith(pre);
    if (!pre.nextElementSibling) {
      pre.after(document.createElement('div'));
      pre.nextElementSibling.appendChild(document.createElement('br'));
    }
    caretIn(pre);
    onContentChanged();
  }

  // Dentro do bloco: Enter quebra a linha, Tab recua; Enter numa linha vazia
  // no fim sai do bloco; Backspace num bloco vazio volta a ser linha comum.
  function onCodeBlockKeydown(e, pre, mod) {
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (!e.shiftKey) document.execCommand('insertText', false, '  ');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      const sel = getSelection();
      const after = document.createRange();
      after.setStart(sel.anchorNode, sel.anchorOffset);
      after.setEnd(pre, pre.childNodes.length);
      const before = document.createRange();
      before.setStart(pre, 0);
      before.setEnd(sel.anchorNode, sel.anchorOffset);
      const atEnd = !preText(after.cloneContents());
      const emptyLine = rawText(before.cloneContents()).endsWith('\n');
      if (atEnd && emptyLine) {
        // Sai: tira a linha vazia do fim e vai para a linha seguinte.
        pre.textContent = preText(pre).replace(/\n$/, '');
        if (!pre.textContent) pre.appendChild(document.createElement('br'));
        let next = pre.nextElementSibling;
        if (!next || next.nodeName !== 'DIV' || next.textContent) {
          next = document.createElement('div');
          next.appendChild(document.createElement('br'));
          pre.after(next);
        }
        caretIn(next);
        onContentChanged();
        return;
      }
      document.execCommand('insertLineBreak');
      return;
    }
    if (e.key === 'Backspace' && !mod && !preText(pre)) {
      e.preventDefault();
      const div = document.createElement('div');
      div.appendChild(document.createElement('br'));
      pre.replaceWith(div);
      caretIn(div);
      onContentChanged();
    }
  }

  // `texto` digitado numa linha vira código na linha.
  function expandInlineCode() {
    const sel = getSelection();
    if (!sel.isCollapsed) return false;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || node.parentElement.closest('code, pre')) return false;
    const pos = sel.anchorOffset;
    const text = node.data.slice(0, pos);
    if (!text.endsWith('`')) return false;
    const open = text.lastIndexOf('`', pos - 2);
    if (open < 0) return false;
    const inner = text.slice(open + 1, pos - 1);
    if (!inner.trim() || text[open - 1] === '`') return false;
    const r = document.createRange();
    r.setStart(node, open);
    r.setEnd(node, pos);
    insertCode(r, inner);
    return true;
  }

  // Troca o trecho `range` por <code>texto</code>, com um separador invisível
  // depois (deixa o cursor fora do código). Direto no DOM: o insertHTML do
  // Chromium copiaria estilos para dentro.
  function insertCode(range, text) {
    range.deleteContents();
    const code = document.createElement('code');
    code.spellcheck = false;
    code.textContent = text;
    const gap = document.createTextNode('\u200b');
    range.insertNode(gap);
    range.insertNode(code);
    const after = document.createRange();
    after.setStartAfter(gap);
    after.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(after);
  }

  // Texto bruto de um fragmento, com <br> como quebra (sem cortar a última).
  function rawText(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.nodeType === 1) out += rawText(n);
    }
    return out.replace(ZWSP, '');
  }

  // Ctrl+E / botão </>: põe ou tira o código na linha do trecho selecionado.
  function toggleCode() {
    editor.focus();
    const code = currentCode();
    const sel = getSelection();
    if (code) {
      // Desembrulha direto no DOM (o insertText do Chromium recria o <code>)
      // e tira o separador invisível que vinha depois dele.
      const next = code.nextSibling;
      if (next && next.nodeType === 3 && next.data.startsWith('​')) next.deleteData(0, 1);
      const text = document.createTextNode(code.textContent.replace(ZWSP, ''));
      code.replaceWith(text);
      const r = document.createRange();
      r.selectNodeContents(text);
      sel.removeAllRanges();
      sel.addRange(r);
    } else {
      const text = sel.toString();
      if (!text || text.includes('\n') || !sel.rangeCount) return;
      insertCode(sel.getRangeAt(0), text);
    }
    onContentChanged();
    scheduleFormatBar();
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
    if (mod && e.shiftKey && !e.altKey && e.code === 'KeyH') {
      e.preventDefault();
      toggleHighlight();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyE') {
      e.preventDefault();
      toggleCode();
      return;
    }

    const pre = currentPre();
    if (pre) {
      onCodeBlockKeydown(e, pre, mod);
      return;
    }

    // "```linguagem" + Enter numa linha comum abre um bloco de código.
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
      const line = currentBlock();
      const fence = line && !isListItem(line) && /^```([\w+#.-]*)$/.exec(line.textContent.trim());
      if (fence) {
        e.preventDefault();
        openCodeBlock(line, fence[1]);
        return;
      }
    }
    if (mod && e.shiftKey && !e.altKey && (e.code === 'Period' || e.code === 'Comma')) {
      e.preventDefault();
      stepSize(e.code === 'Period' ? 1 : -1);
      return;
    }

    // Tab / Shift+Tab: recua ou volta um nível os itens de lista selecionados.
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const items = selectedBlocks().filter(isListItem);
      if (!items.length) return;
      e.preventDefault();
      for (const item of items) setLevel(item, levelOf(item) + (e.shiftKey ? -1 : 1));
      onContentChanged();
      return;
    }

    const block = currentBlock();
    if (!block || !isListItem(block)) return;
    const atStart = getSelection().isCollapsed && textBeforeCaret(block).toString() === '';

    // Enter num item vazio, ou Backspace no começo do item: volta um nível
    // se estiver recuado; senão, sai da lista.
    if ((e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey && block.textContent.trim() === '')
        || (e.key === 'Backspace' && !mod && atStart)) {
      e.preventDefault();
      if (levelOf(block) > 0) {
        setLevel(block, levelOf(block) - 1);
      } else {
        block.classList.remove('check', 'done', 'bullet');
        if (!block.classList.length) block.removeAttribute('class');
      }
      onContentChanged();
    }
  }

  const isListItem = (block) => block.classList.contains('check') || block.classList.contains('bullet');

  function setLevel(block, level) {
    const next = Math.max(0, Math.min(MAX_LEVEL, level));
    if (next) block.dataset.level = String(next);
    else delete block.dataset.level;
  }

  // Linhas (filhas diretas do editor) que a seleção toca.
  function selectedBlocks() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    return [...editor.children].filter((b) => range.intersectsNode(b));
  }

  // "- " digitado no começo de uma linha transforma a linha em marcador.
  function expandBullet() {
    const sel = getSelection();
    if (!sel.isCollapsed) return false;
    let block = currentBlock();
    if (!block) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
    }
    if (!block || isListItem(block)) return false;
    const before = textBeforeCaret(block);
    if (!/^\s*-[ \u00a0]$/.test(before.toString())) return false;
    sel.removeAllRanges();
    sel.addRange(before);
    document.execCommand('delete'); // entra no desfazer
    if (!block.isConnected) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
      if (!block) return false;
    }
    block.classList.add('bullet');
    return true;
  }

  // Espaço digitado logo no começo de um item é descartado ("[] tarefa").
  function swallowLeadingSpace() {
    const block = currentBlock();
    if (!block || !block.classList.contains('check')) return;
    if (!/^[  ]$/.test(textBeforeCaret(block).toString())) return;
    document.execCommand('delete');
  }

  function onEditorInput(e) {
    if (currentPre()) {
      onContentChanged();
      return;
    }
    if (e.inputType === 'insertText' && e.data === '`') expandInlineCode();
    if (e.inputType === 'insertText' && e.data === ']') expandCheckbox();
    if (e.inputType === 'insertText' && e.data === ' ' && !expandBullet()) swallowLeadingSpace();
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

  // Marca-texto: o Chromium (hiliteColor) gera <span style="background-color">.
  // A cor gravada é uma sentinela fixa; a cor real vem do tema (--highlight).
  const HIGHLIGHT = 'rgb(255, 230, 0)';
  const isHighlight = (n) => Boolean(n.style) && n.style.backgroundColor === HIGHLIGHT;

  function currentHighlight() {
    const sel = getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    let n = range.startContainer.childNodes[range.startOffset] || range.startContainer;
    while (n.firstChild) n = n.firstChild;
    for (; n && n !== editor; n = n.parentNode) {
      if (n.nodeName === 'SPAN' && isHighlight(n)) return true;
    }
    return false;
  }

  function toggleHighlight() {
    editor.focus();
    document.execCommand('hiliteColor', false, currentHighlight() ? 'transparent' : HIGHLIGHT);
    onContentChanged();
    scheduleFormatBar();
  }

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
      const cmd = btn.dataset.cmd;
      const on = cmd === 'highlight' ? currentHighlight()
        : cmd === 'code' ? Boolean(currentCode())
          : document.queryCommandState(cmd);
      btn.setAttribute('aria-pressed', String(on));
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
    else if (btn.dataset.cmd === 'highlight') toggleHighlight();
    else if (btn.dataset.cmd === 'code') toggleCode();
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
  if (!EMBED) {
    window.MemoChrome.attach({
      frame,
      titlebar,
      grip: $('grip'),
      onDoubleClick: startRename,
      onClose: closeNote,
    });
  }

  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === 'Escape') { closeColors(); hideFormatBar(); return; }
    if (EMBED) return;
    if (mod && e.shiftKey && key === 'p') { e.preventDefault(); togglePin(); }
    else if (mod && !e.shiftKey && key === 'n') { e.preventDefault(); newNote(); }
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
    if (textDirty) invoke(EMBED ? 'set_default_content' : 'save_text', { text: note.text, html: note.html });
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
    editor.dataset.placeholder = EMBED ? t('defaultTextPlaceholder') : I18n.placeholder();
    $('newBtn').title = `${t('newNote')} (${keys('Mod', 'N')})`;
    $('closeBtn').title = t('closeToTrash');
    for (const btn of formatBar.querySelectorAll('[data-key]')) {
      const combo = btn.dataset.shift ? keys('Mod', 'Shift', btn.dataset.key) : keys('Mod', btn.dataset.key);
      btn.title = `${btn.getAttribute('aria-label')} (${combo})`;
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
    TAURI.event.listen('language-changed', (e) => applyLanguage(e.payload));

    // Formatação em tags (<b>, <i>, <u>), não em style="…".
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('defaultParagraphSeparator', false, 'div');

    // Tema escolhido na bandeja ("system" = segue o sistema, via CSS).
    applyTheme(await invoke('get_theme'));
    TAURI.event.listen('theme-changed', (e) => applyTheme(e.payload));

    if (EMBED) {
      const [, text, html] = await invoke('get_new_note_defaults');
      note = { id: 'defaults', title: '', text, html, color: '', pinned: false, collapsed: false, updatedAt: 0 };
    } else {
      note = await invoke('load_note');
    }
    if (!note) return;
    loadContent();
    render();
    if (document.hasFocus()) frame.classList.add('is-focused');
    if (!note.collapsed && !EMBED) {
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
