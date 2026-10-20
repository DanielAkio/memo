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
  window.MemoZoom.attach(invoke);
  const appWindow = TAURI.window.getCurrentWindow();

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
  const colorBtn = $('colorBtn');
  const nameEl = $('noteName');
  const titleInput = $('titleInput');
  const footBtn = $('footBtn');
  const groupMenu = $('groupMenu');

  let note = null;
  let saveTimer = null;
  let textDirty = false;
  let titleTimer = null;
  let renaming = false;

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
  // In the plain text (toPlain) an image is "[imagem]" / "[image]", in the
  // language it was written in, so an image-only note is not blank and the
  // manager, tray and group lists show something for it.
  const IMAGE_MARK_RE = /\[(?:imagem|image)\]/g;
  const plain = (text) => text.replace(/^(\s*)(?:\[[ xX]?\]|-)(?= |$) ?/gm, '$1');
  const MAX_LEVEL = 4;

  const firstLine = (text) => plain(text).split('\n').map((s) => s.trim()).find(Boolean) || t('emptyNote');
  const wordCount = (text) => (plain(text).replace(IMAGE_MARK_RE, ' ').trim().match(/\S+/g) || []).length;
  const displayName = () => note.title || firstLine(note.text);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // A group's label: its name, or "Untitled" (groups start unnamed).
  const groupLabel = (g) => g.name || t('untitled');

  // ------------------------------------------------------------- render

  function render() {
    // A custom colour (#rrggbb) goes straight into the --note-color variable.
    const custom = isCustomColor(note.color);
    frame.dataset.color = custom ? 'custom' : note.color || '';
    if (custom) frame.style.setProperty('--note-color', note.color);
    else frame.style.removeProperty('--note-color');
    customSwatch.style.setProperty('--sw', custom ? note.color : '');
    if (!custom) customSwatch.style.removeProperty('--sw');

    pinBtn.setAttribute('aria-pressed', String(note.pinned));
    const pinLabel = t(note.pinned ? 'unpin' : 'pin');
    pinBtn.setAttribute('aria-label', pinLabel);
    pinBtn.title = `${pinLabel} (${keys('Mod', 'Shift', 'P')})`;

    for (const sw of document.querySelectorAll('.swatch')) {
      const checked = sw === customSwatch ? custom : sw.dataset.color === (note.color || '');
      sw.setAttribute('aria-checked', String(checked));
    }
    colorBtn.title = custom
      ? t('colorCustomIs', { hex: note.color })
      : t('colorIs', { name: colorName(note.color || '') });
    renderMeta();
  }

  function renderMeta() {
    const n = wordCount(note.text);
    $('count').textContent = t(n === 1 ? 'wordOne' : 'wordMany', { n });
    // Bottom left, always: the note's group, or "No group".
    const group = groups.find((g) => g.id === note.groupId);
    footBtn.classList.toggle('has-group', Boolean(group));
    // The footer's folder takes the group's colour.
    const folder = footBtn.querySelector('.foot-folder');
    const groupColor = (group && group.color) || '';
    folder.dataset.color = isCustomColor(groupColor) ? 'custom' : groupColor;
    if (isCustomColor(groupColor)) folder.style.setProperty('--note-color', groupColor);
    else folder.style.removeProperty('--note-color');
    // The top of the window takes a soft wash of the same colour.
    const tint = $('groupTint');
    tint.dataset.color = isCustomColor(groupColor) ? 'custom' : groupColor;
    if (isCustomColor(groupColor)) tint.style.setProperty('--note-color', groupColor);
    else tint.style.removeProperty('--note-color');
    footBtn.title = group ? t('groupIs', { name: groupLabel(group) }) : t('addToGroup');
    $('edited').textContent = group ? groupLabel(group) : t('noGroup');
    editor.classList.toggle('is-empty', !note.text.trim() && !editor.querySelector('.check, img'));
    renderName();
  }

  // Name in the titlebar: the title, or "Untitled".
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

  // Images (pasted, see "images") are kept inline in the HTML as data URLs,
  // so they travel with the note (backup, sync); `width` is set once resized.
  const IMAGE_SRC_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  const IMAGE_MIN = 24;
  const IMAGE_MAX = 4000;
  // In the plain text an image is "[imagem]" / "[image]" (see toPlain).
  const imageMark = () => `[${t('imageMark')}]`;

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
        } else if (n.nodeName === 'IMG') {
          cur = (cur ?? '') + imageMark();
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
  // <i>, <u>, <code>, <pre>, <img> (data URLs), sizes, highlight and the list
  // classes.
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
        } else if (n.nodeName === 'IMG') {
          const src = n.getAttribute('src') || '';
          if (!IMAGE_SRC_RE.test(src)) continue;
          const img = to.appendChild(document.createElement('img'));
          img.src = src;
          const width = Math.round(Number(n.getAttribute('width')));
          if (width) img.width = Math.min(IMAGE_MAX, Math.max(IMAGE_MIN, width));
        } else if (n.nodeName === 'PRE') {
          const pre = document.createElement('pre');
          pre.className = 'code';
          pre.spellcheck = false;
          const lang = codeLang(n.dataset.lang);
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
    renderCode();
    resetHistory();
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

  // After any edit: refresh what derives from the content, save it and record
  // an undo step (`typing` merges consecutive typing into one step).
  function onContentChanged(typing = false) {
    applyContent();
    recordHistory(typing);
    renderMarkerCaret();
  }

  function applyContent() {
    syncCheckSizes();
    renderCode();
    renderImageFrame();
    note.text = toPlain();
    note.html = contentHtml();
    note.updatedAt = Date.now();
    renderMeta();
    scheduleSave();
  }

  // ---------------------------------------------------------------- undo
  //
  // Many edits change the DOM directly (inline code, code blocks, checklist
  // boxes, list levels), which the browser's undo stack never sees, so its
  // Ctrl+Z skipped or garbled them. The editor keeps its own history instead:
  // a snapshot (HTML + selection) after every change, restored by Mod+Z,
  // Mod+Shift+Z / Mod+Y and the context menu's Undo/Redo. Typing within a
  // second of the last keystroke extends the same step, up to the end of the
  // word: a space or a line break closes the step (it belongs to the word
  // before it), so undo goes back word by word.

  const HISTORY_MAX = 200;
  const TYPING_MS = 1000;
  let history = [];
  let historyAt = -1;
  let lastTyping = 0;

  // Child-index path from the editor to `node`, so a selection can be put
  // back after the HTML is restored.
  function nodePath(node) {
    const path = [];
    for (let n = node; n !== editor; n = n.parentNode) path.unshift([...n.parentNode.childNodes].indexOf(n));
    return path;
  }

  function nodeAt(path) {
    let n = editor;
    for (const i of path) {
      n = n && n.childNodes[i];
    }
    return n || null;
  }

  // Snapshots keep each image's data URL once (`imageRefs`) and refer to it
  // by a short key, so 200 undo steps don't hold 200 copies of every image.
  const imageRefs = new Map(); // data URL → key
  const imageData = new Map(); // key → data URL
  const IMAGE_ATTR_RE = /src="(data:image\/[^"]+)"/g;
  const IMAGE_KEY_RE = /src="memo-image:(\d+)"/g;
  function internImages(html) {
    return html.replace(IMAGE_ATTR_RE, (_, url) => {
      let key = imageRefs.get(url);
      if (!key) {
        key = String(imageRefs.size + 1);
        imageRefs.set(url, key);
        imageData.set(key, url);
      }
      return `src="memo-image:${key}"`;
    });
  }
  const expandImages = (html) => html.replace(IMAGE_KEY_RE, (_, key) => `src="${imageData.get(key) || ''}"`);

  function snapshot() {
    const sel = getSelection();
    let range = null;
    if (sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer) && editor.contains(sel.getRangeAt(0).endContainer)) {
      const r = sel.getRangeAt(0);
      range = [nodePath(r.startContainer), r.startOffset, nodePath(r.endContainer), r.endOffset];
    }
    return { html: internImages(editor.innerHTML), range, typing: false };
  }

  function resetHistory() {
    history = [snapshot()];
    historyAt = 0;
    lastTyping = 0;
  }

  function recordHistory(typing = false) {
    const state = snapshot();
    const top = history[historyAt];
    if (top && top.html === state.html) {
      top.range = state.range;
      return;
    }
    history.length = historyAt + 1; // a new edit drops what could be redone
    const now = Date.now();
    if (typing && top && top.typing && now - lastTyping < TYPING_MS) {
      history[historyAt] = { ...state, typing: true };
    } else {
      history.push({ ...state, typing });
      if (history.length > HISTORY_MAX) history.shift();
      historyAt = history.length - 1;
    }
    lastTyping = typing ? now : 0;
  }

  // Keeps the current step's selection up to date as the caret moves, so
  // undoing the next edit puts the caret back where it was just before it.
  document.addEventListener('selectionchange', () => {
    const top = history[historyAt];
    if (!top || document.activeElement !== editor) return;
    const state = snapshot();
    if (state.range && state.html === top.html) top.range = state.range;
  });

  // step = -1 undoes, +1 redoes.
  function restoreHistory(step) {
    const target = historyAt + step;
    if (target < 0 || target >= history.length) return;
    historyAt = target;
    lastTyping = 0;
    const { html, range } = history[target];
    editor.innerHTML = expandImages(html);
    const start = range && nodeAt(range[0]);
    const end = range && nodeAt(range[2]);
    let placed = false;
    if (start && end) {
      try {
        const r = document.createRange();
        r.setStart(start, range[1]);
        r.setEnd(end, range[3]);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        placed = true;
      } catch { /* stale offsets: fall back below */ }
    }
    if (!placed) caretIn(editor, true);
    applyContent();
    scheduleFormatBar();
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

  // "Before the marker": the caret at the start of a list item, drawn left of
  // its box or dot (#markerCaret; the real caret is hidden meanwhile). There
  // Enter pushes the item down. Set by clicking left of the box or ArrowLeft
  // at the item's start; any other key or caret move clears it.
  const markerCaret = $('markerCaret');
  let beforeMarker = null;

  function setBeforeMarker(block) {
    beforeMarker = block;
    editor.classList.toggle('caret-before-marker', !!block);
    renderMarkerCaret();
  }

  function renderMarkerCaret() {
    const block = beforeMarker && beforeMarker.isConnected ? beforeMarker : null;
    markerCaret.hidden = !block;
    if (!block) return;
    const box = markerCaret.parentElement.getBoundingClientRect();
    const r = block.getBoundingClientRect();
    // Same height and top as the real caret at the start of the item.
    const at = document.createRange();
    at.selectNodeContents(block);
    at.collapse(true);
    let caret = at.getClientRects()[0];
    if (!caret || !caret.height) {
      const probe = document.createRange();
      probe.selectNode(block.firstChild || block);
      caret = probe.getBoundingClientRect();
    }
    const layer = markerCaret.parentElement; // positioned inside its border
    markerCaret.style.left = `${r.left - box.left - layer.clientLeft - 4}px`;
    markerCaret.style.top = `${caret.top - box.top - layer.clientTop}px`;
    markerCaret.style.height = `${caret.height}px`;
    // Restart the blink, as the real caret does when it moves.
    markerCaret.style.animation = 'none';
    void markerCaret.offsetWidth;
    markerCaret.style.animation = '';
  }

  // List item whose marker area (the margin left of the box or dot, the marker
  // and the gap up to the text) is under the pointer, on the item's first line.
  function listMarkerAt(e) {
    for (const block of editor.children) {
      if (!isListItem(block)) continue;
      const r = block.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(block).lineHeight) || 20;
      if (e.clientY < r.top || e.clientY >= Math.min(r.bottom, r.top + lineHeight)) continue;
      return e.clientX < r.left + 24 ? block : null;
    }
    return null;
  }

  // Clicking the box toggles it without moving the caret.
  function checkAt(e) {
    const block = listMarkerAt(e);
    if (!block || !block.classList.contains('check')) return null;
    const x = e.clientX - block.getBoundingClientRect().left;
    return x >= -2 && x < 17 ? block : null;
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
    const clean = codeLang(lang);
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

  // ------------------------------------------------- code highlighting
  //
  // Code blocks stay plain text in the editor, so typing, undo and saving work
  // as before. #codeLayer, a sibling on top of the editor, holds one item per
  // block: a copy of its text highlighted by Prism (vendor/prism.js), laid
  // exactly over it while the block's own text is transparent (CSS), and a
  // language picker in its top-right corner. None of it is saved.

  // Languages in the picker: [data-lang value, label]; '' = plain text.
  const CODE_LANGS = [
    ['', null], ['bash', 'Bash'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'], ['css', 'CSS'],
    ['go', 'Go'], ['html', 'HTML'], ['java', 'Java'], ['javascript', 'JavaScript'], ['json', 'JSON'],
    ['markdown', 'Markdown'], ['php', 'PHP'], ['python', 'Python'], ['ruby', 'Ruby'], ['rust', 'Rust'],
    ['sql', 'SQL'], ['typescript', 'TypeScript'], ['xml', 'XML'], ['yaml', 'YAML'],
  ];
  const LANG_ALIASES = {
    js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash',
    rs: 'rust', yml: 'yaml', md: 'markdown', cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp',
    golang: 'go', rb: 'ruby', htm: 'html',
  };

  // Typed language ("```JS") → picker value ("javascript") when known; an
  // unknown one is kept as typed (shown, but not highlighted).
  function codeLang(lang) {
    const clean = (lang || '').replace(LANG_RE, '').slice(0, 20);
    const id = LANG_ALIASES[clean.toLowerCase()] || clean.toLowerCase();
    return CODE_LANGS.some(([value]) => value === id) ? id : clean;
  }

  // Computed styles the copy takes from its block, so both wrap identically.
  const MIRROR = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'whiteSpace', 'overflowWrap', 'wordBreak'];
  const codeLayer = $('codeLayer');
  // Block under the mouse: only its picker is shown.
  let hoveredPre = null;

  function highlighted(text, lang) {
    const grammar = window.Prism && window.Prism.languages[lang];
    return grammar ? window.Prism.highlight(text, grammar, lang) : esc(text);
  }

  function codeItem() {
    const item = document.createElement('div');
    item.className = 'code-hl';
    const copy = item.appendChild(document.createElement('div'));
    copy.className = 'code-hl-text';
    copy.setAttribute('aria-hidden', 'true');
    const picker = item.appendChild(document.createElement('select'));
    picker.className = 'code-lang';
    picker.addEventListener('change', () => setCodeLang(item.pre, picker.value));
    const copyBtn = item.appendChild(document.createElement('button'));
    copyBtn.type = 'button';
    copyBtn.className = 'code-copy';
    copyBtn.innerHTML = COPY_ICON;
    // mousedown: keep the caret in the editor; click copies the block's text.
    copyBtn.addEventListener('mousedown', (e) => e.preventDefault());
    copyBtn.addEventListener('click', () => copyCode(item.pre, copyBtn));
    return item;
  }

  const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.5"/><path d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-4.5a1.5 1.5 0 0 0-1.5 1.5v4.5a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>';
  const COPIED_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>';

  // Copies a code block's text (as plain text, line breaks kept); the button
  // shows a check for a moment.
  async function copyCode(pre, btn) {
    if (!pre || !editor.contains(pre)) return;
    const text = preText(pre);
    // A synchronous "copy" whose event carries the text: works within the
    // click and leaves the editor's focus and selection alone. The async
    // clipboard API is the fallback.
    const fill = (e) => {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', fill, { once: true });
    const copied = document.execCommand('copy');
    document.removeEventListener('copy', fill);
    if (!copied) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.error('copyCode', err);
        return;
      }
    }
    btn.innerHTML = COPIED_ICON;
    btn.classList.add('copied');
    btn.title = t('copied');
    clearTimeout(btn.resetTimer);
    btn.resetTimer = setTimeout(() => {
      btn.innerHTML = COPY_ICON;
      btn.classList.remove('copied');
      btn.title = t('copyCode');
    }, 1500);
  }

  // Lays one item over each code block (position, size, highlighted text,
  // picker). Cheap when nothing changed, so it runs on every edit and scroll.
  function renderCode() {
    const blocks = [...editor.querySelectorAll(':scope > pre.code')];
    while (codeLayer.children.length > blocks.length) codeLayer.lastChild.remove();
    while (codeLayer.children.length < blocks.length) codeLayer.append(codeItem());
    blocks.forEach((pre, i) => {
      const item = codeLayer.children[i];
      const [copy, picker, copyBtn] = item.children;
      item.pre = pre;
      item.classList.toggle('is-hovered', pre === hoveredPre);
      item.style.top = `${pre.offsetTop - editor.scrollTop}px`;
      item.style.left = `${pre.offsetLeft - editor.scrollLeft}px`;
      item.style.width = `${pre.offsetWidth}px`;
      item.style.height = `${pre.offsetHeight}px`;
      const style = getComputedStyle(pre);
      for (const prop of MIRROR) copy.style[prop] = style[prop];

      const lang = pre.dataset.lang || '';
      const text = preText(pre);
      const key = `${lang}\n${text}`;
      if (copy.key !== key) {
        copy.key = key;
        copy.innerHTML = highlighted(text, lang);
      }

      const optionsKey = `${I18n.lang}|${lang}`;
      if (picker.optionsKey !== optionsKey) {
        picker.optionsKey = optionsKey;
        const known = CODE_LANGS.some(([value]) => value === lang);
        const langs = known ? CODE_LANGS : [...CODE_LANGS, [lang, lang]];
        picker.replaceChildren(...langs.map(([value, label]) => new Option(label || t('plainText'), value)));
        picker.value = lang;
        picker.title = t('codeLanguage');
        if (!copyBtn.classList.contains('copied')) copyBtn.title = t('copyCode');
        copyBtn.setAttribute('aria-label', t('copyCode'));
        picker.setAttribute('aria-label', t('codeLanguage'));
      }
    });
  }

  function setHoveredPre(pre) {
    if (pre === hoveredPre) return;
    hoveredPre = pre;
    for (const item of codeLayer.children) item.classList.toggle('is-hovered', item.pre === pre);
  }

  // Leaving a block for its picker (which sits on top of it, in the layer)
  // or back keeps the picker shown; leaving for anywhere else hides it.
  function leaveCode(e) {
    const to = e.relatedTarget;
    if (!(to && (codeLayer.contains(to) || (to.closest && to.closest('pre.code'))))) setHoveredPre(null);
  }

  function setCodeLang(pre, lang) {
    if (!pre || !editor.contains(pre)) return;
    if (lang) pre.dataset.lang = lang;
    else delete pre.dataset.lang;
    onContentChanged();
    editor.focus();
    caretIn(pre, true);
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
    // Any key but a modifier leaves "before the marker" (see "lists").
    const wasBeforeMarker = beforeMarker;
    if (beforeMarker && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) setBeforeMarker(null);

    // Esc on a selected image puts the caret after it.
    if (e.key === 'Escape' && selectedImage()) {
      e.preventDefault();
      getSelection().collapseToEnd();
      return;
    }

    // Undo / redo through the editor's own history (see "undo").
    if (mod && !e.altKey && key === 'z') {
      e.preventDefault();
      restoreHistory(e.shiftKey ? 1 : -1);
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && key === 'y') {
      e.preventDefault();
      restoreHistory(1);
      return;
    }

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

    const plainKey = !e.shiftKey && !mod && !e.altKey;
    const before = wasBeforeMarker === block && atStart;

    // ArrowLeft at the start of an item puts the caret before its marker.
    if (e.key === 'ArrowLeft' && plainKey && atStart && !before) {
      e.preventDefault();
      setBeforeMarker(block);
      return;
    }
    // Before the marker, Enter pushes the item down, leaving a plain line above
    // (the way to get text above a list that starts the note).
    if (e.key === 'Enter' && plainKey && before) {
      e.preventDefault();
      const line = document.createElement('div');
      line.appendChild(document.createElement('br'));
      block.before(line);
      caretIn(block);
      onContentChanged();
      setBeforeMarker(block);
      return;
    }
    // Enter on an empty first item adds the next item (a list just started).
    const prev = block.previousElementSibling;
    if (e.key === 'Enter' && plainKey && block.textContent.trim() === '' && !(prev && isListItem(prev))) {
      e.preventDefault();
      const item = block.cloneNode(false);
      item.classList.remove('done');
      item.appendChild(document.createElement('br'));
      block.after(item);
      caretIn(item);
      onContentChanged();
      return;
    }

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

  const TYPING_RE = /^(insertText|insertCompositionText|insertParagraph|insertLineBreak|deleteContent)/;
  let pasting = false;
  let converting = false;

  function onEditorInput(e) {
    // Edits made by a conversion below fire their own input events; the
    // conversion records the result once.
    if (converting) return;
    const typing = !pasting && TYPING_RE.test(e.inputType);
    const wordEnd = typing && (/^insert(Paragraph|LineBreak)$/.test(e.inputType) || /\s/.test(e.data || ''));
    if (currentPre()) {
      onContentChanged(typing);
      if (wordEnd) lastTyping = 0;
      return;
    }
    let converted = false;
    if (e.inputType === 'insertText' && ['`', ']', ' '].includes(e.data)) {
      // Keep the text as typed, so undo after "[]" → box (or `x` → code,
      // "- " → bullet) brings back the characters instead of skipping them.
      recordHistory(typing);
      converting = true;
      try {
        if (e.data === '`') converted = expandInlineCode();
        else if (e.data === ']') converted = expandCheckbox();
        else if (!(converted = expandBullet())) swallowLeadingSpace();
      } finally {
        converting = false;
      }
    }
    // Enter on an item creates the next item (the browser clones the line), unchecked.
    if (e.inputType === 'insertParagraph') currentBlock()?.classList.remove('done');
    onContentChanged(typing && !converted);
    // The next keystroke starts a new undo step.
    if (wordEnd) lastTyping = 0;
  }

  // Text is always pasted as plain text: avoids bringing in styles from other
  // apps. Images (a screenshot, "Copy image") go in as images. A paste is its
  // own undo step, never merged with typing.
  function onPaste(e) {
    e.preventDefault();
    const data = e.clipboardData;
    const text = data.getData('text/plain');
    if (!currentPre()) {
      const files = [...data.items]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (files.length) {
        pasteImages(files);
        return;
      }
      // An image copied from a note comes back as HTML with its data URL.
      if (!text.trim()) {
        const doc = new DOMParser().parseFromString(data.getData('text/html') || '', 'text/html');
        const imgs = [...doc.images].filter((img) => IMAGE_SRC_RE.test(img.getAttribute('src') || ''));
        if (imgs.length) {
          insertImages(imgs.map((img) => ({ src: img.getAttribute('src'), width: Number(img.getAttribute('width')) || 0 })));
          return;
        }
      }
    }
    if (!text) return;
    pasting = true;
    try {
      document.execCommand('insertText', false, text);
    } finally {
      pasting = false;
    }
  }

  // ------------------------------------------------------------- images
  //
  // A pasted image is re-encoded on a canvas (at most IMAGE_SIDE px on its
  // longest side) and stored inline as a data URL: lossless PNG when that is
  // small (screenshots of text stay sharp), else WebP (JPEG where WebP can't
  // be encoded; PNG if it has transparency), shrunk until it fits
  // IMAGE_CHARS. A note keeps under NOTE_CHARS in all, so it still syncs as
  // one file to Google Drive. Clicking an image selects it and shows a frame
  // with a handle in the bottom-right corner: dragging it sets the image's
  // `width` (the height follows, keeping the proportion).

  const IMAGE_SIDE = 1600;
  const IMAGE_PNG_CHARS = 350000;
  const IMAGE_CHARS = 700000;
  const NOTE_CHARS = 4000000;
  const imageLayer = $('imageLayer');
  const imageFrame = $('imageFrame');
  const imageHandle = $('imageHandle');
  let resizing = null;
  let alertTimer = null;

  function readImage(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('unreadable image'));
        img.src = reader.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  function isOpaque(ctx, w, h) {
    const px = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 255) return false;
    return true;
  }

  // { src, width } for an image file, or null if it can't be read or made small enough.
  async function encodeImage(blob) {
    const img = await readImage(blob);
    const w0 = img.naturalWidth;
    const h0 = img.naturalHeight;
    if (!w0 || !h0) return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let scale = Math.min(1, IMAGE_SIDE / Math.max(w0, h0));
    let opaque = null;
    for (let i = 0; i < 8; i++) {
      canvas.width = Math.max(1, Math.round(w0 * scale));
      canvas.height = Math.max(1, Math.round(h0 * scale));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (opaque === null) opaque = blob.type === 'image/jpeg' || isOpaque(ctx, canvas.width, canvas.height);
      let src = canvas.toDataURL('image/png');
      if (src.length > IMAGE_PNG_CHARS) {
        // toDataURL falls back to PNG where WebP can't be encoded (WebKit).
        const webp = canvas.toDataURL('image/webp', 0.86);
        if (webp.startsWith('data:image/webp')) src = webp;
        else if (opaque) src = canvas.toDataURL('image/jpeg', 0.86);
      }
      // Shown at the size it had on screen (a screenshot on a 150% display
      // is 1.5× larger in pixels); CSS keeps it within the note's width.
      if (src.length <= IMAGE_CHARS) return { src, width: Math.round(w0 / (window.devicePixelRatio || 1)) };
      scale *= 0.75;
    }
    return null;
  }

  async function pasteImages(files) {
    const range = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
    const images = [];
    for (const file of files) {
      try {
        const image = await encodeImage(file);
        if (image) images.push(image);
      } catch (err) {
        console.error('paste image', err);
      }
    }
    if (!images.length) { showAlert(t('imageUnreadable')); return; }
    insertImages(images, range);
  }

  // Inserts images at `range` (default: the selection), replacing what it selects.
  function insertImages(images, range = null) {
    const sel = getSelection();
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      if (!sel.rangeCount || !editor.contains(sel.getRangeAt(0).commonAncestorContainer)) caretIn(editor, true);
      range = sel.getRangeAt(0);
    }
    let size = editor.innerHTML.length;
    const fit = images.filter((image) => (size += image.src.length) <= NOTE_CHARS);
    if (fit.length < images.length) showAlert(t('imageTooBig'));
    if (!fit.length) return;
    editor.focus();
    range.deleteContents();
    for (const image of fit) {
      const img = document.createElement('img');
      img.src = image.src;
      if (image.width) img.width = Math.min(IMAGE_MAX, Math.max(IMAGE_MIN, Math.round(image.width)));
      range.insertNode(img);
      // Never straight in the editor: everything lives inside a line.
      if (img.parentNode === editor) {
        const line = document.createElement('div');
        img.replaceWith(line);
        line.appendChild(img);
      }
      range.setStartAfter(img);
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    onContentChanged();
  }

  // A message in the footer for a few seconds, in place of the word count.
  function showAlert(text) {
    const count = $('count');
    count.textContent = text;
    count.classList.add('is-alert');
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      count.classList.remove('is-alert');
      renderMeta();
    }, 4000);
  }

  // The image the selection holds exactly (clicked, or selected with Shift+arrow).
  function selectedImage() {
    if (resizing) return resizing.img;
    if (document.activeElement !== editor) return null;
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (r.startContainer !== r.endContainer || r.endOffset - r.startOffset !== 1) return null;
    const n = r.startContainer.childNodes[r.startOffset];
    return n && n.nodeName === 'IMG' && editor.contains(n) ? n : null;
  }

  function selectImage(img) {
    editor.focus();
    const r = document.createRange();
    r.selectNode(img);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    renderImageFrame();
  }

  function renderImageFrame() {
    const img = selectedImage();
    imageFrame.hidden = !img;
    if (!img) return;
    const box = imageLayer.getBoundingClientRect();
    const r = img.getBoundingClientRect();
    imageFrame.style.left = `${r.left - box.left}px`;
    imageFrame.style.top = `${r.top - box.top}px`;
    imageFrame.style.width = `${r.width}px`;
    imageFrame.style.height = `${r.height}px`;
  }

  // Widest an image can be: the editor's text width.
  function imageMaxWidth() {
    const style = getComputedStyle(editor);
    return editor.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  imageHandle.addEventListener('mousedown', (e) => e.preventDefault());
  imageHandle.addEventListener('pointerdown', (e) => {
    const img = selectedImage();
    if (e.button !== 0 || !img) return;
    e.preventDefault();
    e.stopPropagation();
    imageHandle.setPointerCapture(e.pointerId);
    resizing = { img, x: e.clientX, width: img.getBoundingClientRect().width };
    imageFrame.classList.add('is-resizing');
  });
  imageHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const max = Math.max(IMAGE_MIN, imageMaxWidth());
    const width = Math.min(max, Math.max(IMAGE_MIN, resizing.width + e.clientX - resizing.x));
    resizing.img.width = Math.round(width);
    renderImageFrame();
  });
  const endResize = () => {
    if (!resizing) return;
    const { img } = resizing;
    resizing = null;
    imageFrame.classList.remove('is-resizing');
    selectImage(img);
    onContentChanged();
  };
  imageHandle.addEventListener('pointerup', endResize);
  imageHandle.addEventListener('pointercancel', endResize);

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
    // A selected image has its resize frame instead.
    const range = !selecting && note && document.activeElement === editor && !selectedImage() && selectionRange();
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

  // Closing only closes the window: the note stays among the current ones
  // and the manager reopens it (the trash is the manager's trash button).
  async function closeNote() {
    closeColors();
    if (renaming) await finishRename(true);
    await flushText();
    invoke('close_note').catch((err) => console.error('close_note', err));
  }

  // ------------------------------------------------------------- title

  // Double-click on the titlebar opens the title field.
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
    editor.focus();
  }

  // ------------------------------------------------------- colour picker

  function openColors() {
    hideFormatBar();
    colorMenu.hidden = false;
    frame.classList.add('menu-open');
    colorBtn.setAttribute('aria-expanded', 'true');
  }

  function closeColors() {
    if (colorMenu.hidden) return;
    colorMenu.hidden = true;
    frame.classList.remove('menu-open');
    colorBtn.setAttribute('aria-expanded', 'false');
  }

  // ------------------------------------------------------------- events

  editor.addEventListener('input', onEditorInput);
  // Undo/Redo from the context menu (or any other source) also go through
  // the editor's own history.
  editor.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    e.preventDefault();
    restoreHistory(e.inputType === 'historyUndo' ? -1 : 1);
  });
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('paste', onPaste);
  editor.addEventListener('blur', () => {
    flushText();
    renderImageFrame();
  });
  editor.addEventListener('scroll', () => {
    renderCode();
    renderImageFrame();
    scheduleFormatBar();
  });

  // Clicking an image selects it, showing its resize frame.
  editor.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.nodeName !== 'IMG') return;
    e.preventDefault();
    selectImage(e.target);
  });

  editor.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const block = listMarkerAt(e);
    if (!block) return;
    e.preventDefault();
    if (checkAt(e)) {
      toggleCheck(block);
    } else {
      // Beside the box or dot: caret before the marker, so Enter can push the
      // list down.
      editor.focus();
      caretIn(block);
      setBeforeMarker(block);
    }
  });
  editor.addEventListener('mousemove', (e) => setHoveredPre(e.target.closest('pre.code')));
  editor.addEventListener('mouseleave', leaveCode);
  codeLayer.addEventListener('mouseout', leaveCode);
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
  document.addEventListener('selectionchange', () => {
    scheduleFormatBar();
    renderImageFrame();
    // The caret left the start of the item: no longer before its marker.
    if (beforeMarker) {
      const block = currentBlock();
      if (!getSelection().isCollapsed || block !== beforeMarker || textBeforeCaret(block).toString() !== '') {
        setBeforeMarker(null);
      }
    }
  });
  editor.addEventListener('blur', () => setBeforeMarker(null));
  editor.addEventListener('scroll', renderMarkerCaret);
  new ResizeObserver(() => {
    renderCode();
    renderImageFrame();
    renderMarkerCaret();
    scheduleFormatBar();
  }).observe(editor);

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
    if (!groupMenu.hidden && !groupMenu.contains(e.target) && !footBtn.contains(e.target)) closeGroupMenu();
  });

  // -------------------------------------------------------------- groups
  // The footer shows the note's group; clicking it opens a picker to move
  // the note to another group, out of its group or into a new one. Rust does
  // the moving (set_note_group) and emits "groups-changed".

  let groups = [];

  async function loadGroups() {
    if (EMBED || !note) return;
    try {
      [groups, note.groupId] = await Promise.all([invoke('list_groups'), invoke('get_note_group')]);
      groups = groups.filter((g) => !g.trashedAt);
    } catch (err) {
      console.error('list_groups', err);
    }
    renderMeta();
  }

  function groupItem(label, value, { checked = false, muted = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${muted ? ' muted' : ''}`;
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', String(checked));
    btn.dataset.group = value;
    const text = document.createElement('span');
    text.textContent = label;
    btn.append(text);
    return btn;
  }

  function openGroupMenu() {
    closeColors();
    hideFormatBar();
    const items = groups
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, I18n.locale(), { sensitivity: 'base', numeric: true }))
      .map((g) => groupItem(groupLabel(g), g.id, { checked: g.id === note.groupId }));
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    $('groupItems').replaceChildren(
      ...items,
      ...(items.length ? [sep] : []),
      groupItem(t('noGroup'), '', { checked: !note.groupId, muted: true }),
      groupItem(t('newGroup'), 'new', { muted: true }),
    );
    groupMenu.hidden = false;
    frame.classList.add('menu-open');
    footBtn.setAttribute('aria-expanded', 'true');
  }

  function closeGroupMenu() {
    if (groupMenu.hidden) return;
    groupMenu.hidden = true;
    frame.classList.remove('menu-open');
    footBtn.setAttribute('aria-expanded', 'false');
  }

  footBtn.addEventListener('click', () => (groupMenu.hidden ? openGroupMenu() : closeGroupMenu()));
  $('groupItems').addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    closeGroupMenu();
    if (item.dataset.group === note.groupId) return;
    flushText();
    invoke('set_note_group', { groupId: item.dataset.group })
      .catch((err) => console.error('set_note_group', err));
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
    if (e.key === 'Escape') { closeColors(); closeGroupMenu(); hideFormatBar(); return; }
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
    finishRename(true);
    hideFormatBar();
    closeGroupMenu();
    flushText();
  });
  window.addEventListener('beforeunload', () => {
    if (textDirty) invoke(EMBED ? 'set_default_content' : 'save_text', { text: note.text, html: note.html });
  });


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
    $('closeBtn').title = t('close');
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
    renderCode();
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
      note = { id: 'defaults', title: '', text, html, color: '', pinned: false, updatedAt: 0 };
    } else {
      note = await invoke('load_note');
    }
    if (!note) return;
    loadContent();
    render();
    if (!EMBED) {
      TAURI.event.listen('groups-changed', loadGroups);
      await loadGroups();
    }
    if (document.hasFocus()) frame.classList.add('is-focused');
    if (!EMBED) {
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
