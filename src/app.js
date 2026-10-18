// Memo — logic for one note window.
// Each note is its own window; Rust stores text, position, size and state.

(() => {
  // Embedded mode (index.html?defaults): the same page doubles as the editor
  // for the new-note default text, inside the manager. No titlebar or status
  // bar; it loads and saves the defaults instead of a note. Inside an
  // <iframe>, the Tauri API comes from the parent window.
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

  // List line in plain text: indent (2 spaces per level) followed by
  // "[ ]"/"[]"/"[x]" (checklist) or "-" (bullet). "[]" is accepted because
  // it can be typed in the new-note default text.
  // Parameters are never named "t", which is the translation function.
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
    // A custom colour (#rrggbb) goes straight into the --note-color variable.
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

  // Name in the titlebar: the title, or "Untitled" (even when collapsed).
  function renderName() {
    nameEl.textContent = note.title || t('untitled');
    nameEl.classList.toggle('is-empty', !note.title);

    if (EMBED) return;
    // The native window title shows in the taskbar; update it lazily.
    const title = `${displayName()} — Memo`;
    if (document.title === title) return;
    document.title = title;
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      appWindow.setTitle(title).catch((err) => console.error('setTitle', err));
    }, 400);
  }

  // ---------------------------------------------------- editor content
  //
  // The editor is a contenteditable where each line is a <div>. Formatting
  // lives in <b>, <i> and <u>; a checklist item is <div class="check">
  // (checked: "check done") and a bulleted item is <div class="bullet">,
  // both with data-level (1–4) when indented with Tab. Besides the HTML, the
  // note stores the plain text, with items as "[ ] " / "[x] " / "- "
  // preceded by 2 spaces per level.

  const isBlock = (n) => n !== editor && n.nodeType === 1 && (n.nodeName === 'DIV' || n.nodeName === 'P');
  const INLINE = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', CODE: 'code' };
  const LANG_RE = /[^\w+#.-]/g;
  const ZWSP = /\u200b/g; // invisible separator after an inline `code`

  // Text of a code block (or part of one): text and <br> (= line break).
  // Range.toString() ignores <br>, hence this function.
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

  // Start of the line in plain text: indent + list item marker.
  function listPrefix(block) {
    const indent = '  '.repeat(levelOf(block));
    if (block.classList.contains('check')) return indent + (block.classList.contains('done') ? '[x] ' : '[ ] ');
    if (block.classList.contains('bullet')) return `${indent}- `;
    return '';
  }

  // Plain text from the editor's HTML.
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
          // A block's trailing <br> only holds the height of an empty line.
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

  // HTML for notes that only have plain text (created before formatting).
  function fromPlain(text) {
    if (!text) return '<div><br></div>';
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Code block: ```lang ... ```
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

  // Rebuilds saved HTML with only what the editor uses: lines, <br>, <b>,
  // <i>, <u>, <code>, <pre>, sizes, highlight and the list classes.
  // Anything else becomes text.
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

    // Ensures everything is inside lines (<div>).
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
    // There is always a regular line after a trailing code block, so the
    // caret has somewhere to go.
    if (!wrapped.lastChild || wrapped.lastChild.nodeName === 'PRE') {
      wrapped.appendChild(document.createElement('div')).appendChild(document.createElement('br'));
    }
    return wrapped;
  }

  function loadContent() {
    editor.replaceChildren(note.html ? sanitize(note.html) : sanitize(fromPlain(note.text)));
    syncCheckSizes();
  }

  // List item (checklist or bullet) whose text is all in one size
  // (<font size>): tags the line with data-size so CSS gives the whole line
  // that size and the box/dot and strike-through stay centred on the text.
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

      // Mixed sizes: the box goes to the middle of the measured first line.
      if (sizes.size > 1) {
        const r = document.createRange();
        r.selectNodeContents(block);
        const rects = [...r.getClientRects()].filter((rect) => rect.width > 0);
        if (rects.length) {
          // Rects of the first line: those overlapping the first one.
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

  // Saved HTML: the editor's, without syncCheckSizes' display tweaks
  // (data-size and --check-mid), which are recomputed on load.
  function contentHtml() {
    const copy = editor.cloneNode(true);
    for (const b of copy.querySelectorAll('[data-size]')) delete b.dataset.size;
    for (const b of copy.querySelectorAll('[style]')) {
      b.style.removeProperty('--check-mid');
      if (!b.getAttribute('style')) b.removeAttribute('style');
    }
    return copy.innerHTML;
  }

  // The line (direct child of the editor) holding the caret.
  function currentBlock() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.anchorNode;
    while (n && n.parentNode !== editor) n = n.parentNode;
    return n && n.nodeName === 'DIV' ? n : null;
  }

  // Range from the start of the line to the caret.
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

  // "[]" typed at the start of a line turns it into an item.
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
    // "[]", "[ ]" or "[x]" (the latter already checked).
    const m = /^\s*\[([  xX]?)\]$/.exec(before.toString());
    if (!m) return false;
    const done = /x/i.test(m[1]);
    sel.removeAllRanges();
    sel.addRange(before);
    document.execCommand('delete'); // goes into the undo stack
    // If the line became empty and was the only one, Chromium removes the
    // <div> itself; in that case recreate the line at the caret.
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

  // Clicking the box (left of the item) toggles it without moving the caret.
  function checkAt(e) {
    const block = e.target.closest && e.target.closest('.check');
    if (!block || !editor.contains(block)) return null;
    return e.clientX < block.getBoundingClientRect().left + 22 ? block : null;
  }

  // --------------------------------------------------------------- code

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

  // Puts the caret at the start (or end) of an element.
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

  // Inside the block: Enter breaks the line, Tab indents; Enter on an empty
  // last line leaves the block; Backspace in an empty block turns it back
  // into a regular line.
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
        // Leave: drop the trailing empty line and move to the next line.
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

  // `text` typed in a line becomes inline code.
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

  // Replaces `range` with <code>text</code>, followed by an invisible
  // separator (keeps the caret outside the code). Straight in the DOM:
  // Chromium's insertHTML would copy styles into it.
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

  // Raw text of a fragment, with <br> as a line break (keeps the last one).
  function rawText(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.nodeType === 1) out += rawText(n);
    }
    return out.replace(ZWSP, '');
  }

  // Ctrl+E / </> button: toggles inline code on the selection.
  function toggleCode() {
    editor.focus();
    const code = currentCode();
    const sel = getSelection();
    if (code) {
      // Unwrap straight in the DOM (Chromium's insertText recreates the
      // <code>) and remove the invisible separator that followed it.
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

    // Standard formatting shortcuts.
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

    // "```lang" + Enter on a regular line opens a code block.
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

    // Tab / Shift+Tab: indents or outdents the selected list items.
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

    // Enter on an empty item, or Backspace at its start: outdent if indented;
    // otherwise leave the list.
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

  // Lines (direct children of the editor) touched by the selection.
  function selectedBlocks() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    return [...editor.children].filter((b) => range.intersectsNode(b));
  }

  // "- " typed at the start of a line turns it into a bullet.
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
    document.execCommand('delete'); // goes into the undo stack
    if (!block.isConnected) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
      if (!block) return false;
    }
    block.classList.add('bullet');
    return true;
  }

  // A space typed right at the start of an item is dropped ("[] task").
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
    // Enter on an item creates the next item (the browser clones the line), unchecked.
    if (e.inputType === 'insertParagraph') currentBlock()?.classList.remove('done');
    onContentChanged();
  }

  // Always paste as plain text: avoids bringing in styles from other apps.
  function onPaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  }

  // ---------------------------------------------------------- formatting

  const FORMAT_KEYS = { b: 'bold', i: 'italic', u: 'underline' };

  function format(cmd) {
    editor.focus();
    document.execCommand(cmd);
    onContentChanged();
    scheduleFormatBar();
  }

  // Text sizes: execCommand produces <font size="N"> and CSS sets the real
  // size of each N. "3" is normal.
  const SIZES = ['2', '3', '5'];

  // Highlight: Chromium (hiliteColor) produces <span style="background-color">.
  // The stored colour is a fixed sentinel; the real one comes from the theme
  // (--highlight).
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
    // Walk down to the first text of the selection (a fully selected line
    // starts at the <div>, not inside the <font>).
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

  // Ctrl+Shift+> / Ctrl+Shift+< step one size up or down.
  function stepSize(dir) {
    const i = SIZES.indexOf(currentSize());
    const next = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i < 0 ? 1 : i) + dir))];
    if (next !== currentSize()) setSize(next);
  }

  // ------------------------------------------------- format bar

  // When text is selected, a small bar with bold/italic/underline/etc.
  // appears just above the selection (or below, if it doesn't fit above).
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
    // Above the selection (may cover the titlebar); below if there's no room.
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
    note.pinned = next; // immediate feedback; reverts if the OS refuses
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

  // Closing moves the note to the trash (recoverable from the manager for 30 days).
  async function closeNote() {
    closeColors();
    if (renaming) await finishRename(true);
    await flushText();
    invoke('trash_note').catch((err) => console.error('trash_note', err));
  }

  // ------------------------------------------------------------- title

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

  // ------------------------------------------------------- colour picker

  // When collapsed, the window is only as tall as the titlebar: while the
  // picker is open it grows enough to show it.
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

  // `shrink = false` when another action is about to resize the window anyway.
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

  // The bar stays hidden while a selection is being dragged; it shows on release.
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

  // mousedown with preventDefault: clicking the bar keeps the text selection.
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
      // Open the system picker on the note's current colour.
      customColor.value = isCustomColor(note.color)
        ? note.color
        : (getComputedStyle(frame).getPropertyValue('--note-color').trim().match(/^#[0-9a-f]{6}$/i) || ['#f2c94c'])[0];
      customColor.click();
      return;
    }
    setColor(sw.dataset.color);
    closeColors();
  });
  // Only applied when confirmed in the picker; cancelling changes nothing.
  customColor.addEventListener('change', () => {
    setColor(customColor.value.toLowerCase());
    closeColors();
  });
  document.addEventListener('mousedown', (e) => {
    if (!colorMenu.hidden && !colorMenu.contains(e.target) && !colorBtn.contains(e.target)) closeColors();
  });

  // Titlebar (chrome.js): drag with snapping, double-click edits the title,
  // middle click closes; resize grip in the corner.
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

  // Native context menu only in the text and the title field (copy, paste,
  // spellcheck); elsewhere in the note it makes no sense.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, #editor')) e.preventDefault();
  });

  window.addEventListener('focus', () => frame.classList.add('is-focused'));
  window.addEventListener('blur', () => {
    frame.classList.remove('is-focused');
    hideFormatBar();
    // When collapsed, an open picker enlarges the window; close it on blur.
    if (colorsGrown) closeColors();
    flushText();
  });
  window.addEventListener('beforeunload', () => {
    if (textDirty) invoke(EMBED ? 'set_default_content' : 'save_text', { text: note.text, html: note.html });
  });

  // Refreshes the "edited at…" label when the day rolls over.
  setInterval(() => note && renderMeta(), 60_000);

  // --------------------------------------------------------------- init

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    renderMonoName();
  }

  // The "mono" colour is white in the dark theme and black in the light one; its name follows.
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

  // Language-dependent text that isn't just in the HTML (tooltips with
  // shortcuts, placeholder, spellcheck). Called on load and on language change.
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

    // Formatting as tags (<b>, <i>, <u>), not style="…".
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('defaultParagraphSeparator', false, 'div');

    // Theme chosen in the manager ("system" = follow the OS, via CSS).
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
