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

  const $ = (id) => document.getElementById(id);
  const I18n = window.MemoI18n;
  const { t, keys, isMod } = I18n;
  const frame = $('frame');
  const titlebar = $('titlebar');
  const editor = $('editor');
  const colorMenu = $('colorMenu');
  const formatBar = $('formatBar');
  const colorBtn = $('colorBtn');
  const nameEl = $('noteName');
  const titleInput = $('titleInput');

  let note = null;
  let saveTimer = null;
  let textDirty = false;
  let titleTimer = null;

  // ------------------------------------------------------------ helpers

  // The plain-text format (lists, code, tables): components/text.js.
  const { esc, plain, LIST_RE, MAX_LEVEL, TABLE_ROW_RE, TABLE_SEP_RE, rowCells } = MemoText;
  // In the plain text (toPlain) an image is "[imagem]" / "[image]", in the
  // language it was written in, so an image-only note is not blank and the
  // manager, tray and group lists show something for it.
  const IMAGE_MARK_RE = /\[(?:imagem|image)\]/g;

  const firstLine = (text) => plain(text).split('\n').map((s) => s.trim()).find(Boolean) || t('emptyNote');
  // Table rows' "|" and "| --- |" header lines are not words.
  const TABLE_MARKS_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$|(?<=^|\s)\|(?=\s|$)/gm;
  const wordCount = (text) => (plain(text).replace(IMAGE_MARK_RE, ' ').replace(TABLE_MARKS_RE, ' ').trim().match(/\S+/g) || []).length;
  const displayName = () => note.title || firstLine(note.text);

  // ------------------------------------------------------------- render

  function render() {
    MemoColor.paint(frame, note.color);
    colors.render(note.color);
    bar.renderPin(note.pinned);
    colorBtn.title = MemoColor.isCustom(note.color)
      ? t('colorCustomIs', { hex: note.color })
      : t('colorIs', { name: MemoColor.name(note.color) });
    renderMeta();
  }

  function renderMeta() {
    const n = wordCount(note.text);
    $('count').textContent = t(n === 1 ? 'wordOne' : 'wordMany', { n });
    // Bottom left, always: the note's group, or "No group"; then the boards
    // it is on, if any.
    groups.render();
    $('footBoards').replaceChildren(...MemoPill.boardsOf(boards, note.id).map((b) => MemoPill.create('board', b)));
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
  // (checked: "check done"), a bulleted item is <div class="bullet"> and a
  // numbered one <div class="number">, all with data-level (1–4) when
  // indented with Tab. A table is <table> (class "head" when its first row is
  // a header) with <tbody>, <tr> and <td>; cells hold only inline content.
  // Besides the HTML, the note stores the plain text, with items as
  // "[ ] " / "[x] " / "- " / "1. " preceded by 2 spaces per level and table
  // rows as "| a | b |" (a header row is followed by "| --- | --- |").

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

  // Images (pasted, see "images") are inline in the editor as data URLs;
  // `width` is set once resized. Rust keeps each one as a file beside
  // notes.json (images.rs) and hands them back inline, except one whose file
  // is missing (still coming from the cloud): its "images/<name>" reference
  // is kept as it is, so saving the note doesn't lose it.
  const IMAGE_SRC_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  const IMAGE_REF_RE = /^images\/[0-9a-f]{16,64}\.(?:png|jpg|webp|gif)$/;
  const IMAGE_MIN = 24;
  const IMAGE_MAX = 4000;
  // In the plain text an image is "[imagem]" / "[image]" (see toPlain).
  const imageMark = () => `[${t('imageMark')}]`;

  // Links: <a href> with a web or mail address, opened in the system's
  // browser on click (see "links"). A bare address in the text ("https://…",
  // "www.…") is a link to itself; in the plain text a link whose text isn't
  // its address is "[text](address)".
  const BARE_URL_RE = /(?<![\w@.\/])(?:https?:\/\/[^\s<>"]+|www\.[^\s<>"./]+\.[^\s<>"]+)/gi;
  const PLAIN_LINK_RE = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gi;
  const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:)\S+$/i;

  // A bare address without the punctuation that usually follows it in a
  // sentence ("see https://x.com." or "(https://x.com)").
  function trimUrl(url) {
    while (url) {
      const last = url[url.length - 1];
      const unbalanced = (open, close) => last === close && url.split(open).length < url.split(close).length;
      if (!/[.,;:!?'"*]/.test(last) && !unbalanced('(', ')') && !unbalanced('[', ']')) break;
      url = url.slice(0, -1);
    }
    return url;
  }

  // The address a link opens: "www.x.com" → "https://www.x.com".
  const hrefOf = (url) => (/^www\./i.test(url) ? `https://${url}` : url);
  const safeHref = (href) => (href && SAFE_HREF_RE.test(href) ? href : '');

  // `text` is a whole bare address (after trimming): the address, else ''.
  function bareUrl(text) {
    const t = text.replace(ZWSP, '').trim();
    BARE_URL_RE.lastIndex = 0;
    const m = BARE_URL_RE.exec(t);
    return m && m.index === 0 && trimUrl(m[0]) === t ? t : '';
  }

  // A link in plain text: its address when that is its text, else
  // "[text](address)".
  function linkPlain(a) {
    const text = a.textContent.replace(ZWSP, '');
    const href = a.getAttribute('href') || '';
    if (!text.trim()) return '';
    return text === href || hrefOf(bareUrl(text)) === href ? text : `[${text}](${href})`;
  }

  // Escaped text with its "[text](address)" and bare addresses as links.
  function linkHtml(s) {
    let out = '';
    let last = 0;
    const re = new RegExp(`${PLAIN_LINK_RE.source}|${BARE_URL_RE.source}`, 'gi');
    for (let m; (m = re.exec(s));) {
      let text = m[0];
      let href;
      if (m[1]) {
        text = m[1];
        href = m[2];
      } else {
        text = trimUrl(text);
        if (!text) continue;
        href = hrefOf(text);
        re.lastIndex = m.index + text.length;
      }
      out += `${esc(s.slice(last, m.index))}<a href="${esc(href)}">${esc(text)}</a>`;
      last = m.index + (m[1] ? m[0].length : text.length);
    }
    return out + esc(s.slice(last));
  }

  const levelOf = (block) => Number(block.dataset.level) || 0;

  // Start of the line in plain text: indent + list item marker.
  function listPrefix(block) {
    const indent = '  '.repeat(levelOf(block));
    if (block.classList.contains('check')) return indent + (block.classList.contains('done') ? '[x] ' : '[ ] ');
    if (block.classList.contains('bullet')) return `${indent}- `;
    if (block.classList.contains('number')) return `${indent}${block.dataset.n || 1}. `;
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
        } else if (n.nodeName === 'TABLE') {
          flush();
          lines.push(...tableLines(n));
        } else if (n.nodeName === 'CODE') {
          cur = `${cur ?? ''}\`${n.textContent.replace(ZWSP, '')}\``;
        } else if (n.nodeName === 'A' && !n.querySelector('img, br')) {
          cur = (cur ?? '') + linkPlain(n);
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

  // A table's rows in plain text: "| a | b |", the header row followed by
  // "| --- | --- |". A "|" inside a cell is written "\\|".
  function tableLines(table) {
    const rows = [...table.rows].map((row) => `| ${[...row.cells].map(cellText).join(' | ')} |`);
    if (table.classList.contains('head') && rows.length) {
      rows.splice(1, 0, `| ${[...table.rows[0].cells].map(() => '---').join(' | ')} |`);
    }
    return rows;
  }

  // A cell's text on one line: inline code as `x`, images as [image].
  function cellText(cell) {
    let out = '';
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) out += n.data;
        else if (n.nodeName === 'CODE') out += `\`${n.textContent}\``;
        else if (n.nodeName === 'A' && !n.querySelector('img, br')) out += linkPlain(n);
        else if (n.nodeName === 'IMG') out += imageMark();
        else if (n.nodeName === 'BR') out += ' ';
        else if (n.nodeType === 1) walk(n);
      }
    };
    walk(cell);
    return out.replace(ZWSP, '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  }

  // HTML for notes that only have plain text (created before formatting).
  function fromPlain(text) {
    return text ? MemoText.fromPlain(text, linkHtml) : '<div><br></div>';
  }

  // Rebuilds saved HTML with only what the editor uses: lines, <br>, <b>,
  // <i>, <u>, <code>, <pre>, <img> (data URLs), links (<a href>, web and
  // mail only), sizes, highlight, the list classes and tables.
  // Anything else becomes text.
  function sanitize(html) {
    const src = new DOMParser().parseFromString(html, 'text/html').body;
    const out = document.createDocumentFragment();
    // `inCell`: inside a table cell, which only holds inline content (lines,
    // code blocks and tables there become their text).
    const copy = (from, to, inCell = false) => {
      for (const n of from.childNodes) {
        if (n.nodeType === 3) {
          to.appendChild(document.createTextNode(n.data));
        } else if (DROP.has(n.nodeName)) {
          continue;
        } else if (inCell && n.nodeName === 'PRE') {
          to.appendChild(document.createTextNode(` ${preText(n)} `));
        } else if (inCell && (isBlock(n) || n.nodeName === 'TABLE' || n.nodeName === 'TR' || n.nodeName === 'TD' || n.nodeName === 'TH')) {
          if (to.lastChild) to.appendChild(document.createTextNode(' '));
          copy(n, to, true);
        } else if (n.nodeName === 'TABLE') {
          const rows = [...n.rows].filter((row) => row.closest('table') === n && row.cells.length);
          if (!rows.length) continue;
          const cols = Math.max(...rows.map((row) => row.cells.length));
          const table = document.createElement('table');
          if (n.classList.contains('head') || [...rows[0].cells].every((c) => c.nodeName === 'TH')) table.className = 'head';
          const body = table.appendChild(document.createElement('tbody'));
          for (const row of rows) {
            const tr = body.appendChild(document.createElement('tr'));
            for (let c = 0; c < cols; c++) {
              const td = tr.appendChild(document.createElement('td'));
              if (row.cells[c]) copy(row.cells[c], td, true);
              if (!td.textContent && !td.querySelector('img')) td.replaceChildren(document.createElement('br'));
            }
          }
          to.appendChild(table);
        } else if (n.nodeName === 'BR') {
          to.appendChild(document.createElement('br'));
        } else if (n.nodeName === 'IMG') {
          const src = n.getAttribute('src') || '';
          if (!IMAGE_SRC_RE.test(src) && !IMAGE_REF_RE.test(src)) continue;
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
          if (n.classList.contains('number')) div.classList.add('number');
          const level = Number(n.dataset.level);
          if (isListItem(div) && level >= 1) {
            div.dataset.level = String(Math.min(MAX_LEVEL, level));
          }
          copy(n, div);
          to.appendChild(div);
        } else if (INLINE[n.nodeName]) {
          const el = to.appendChild(document.createElement(INLINE[n.nodeName]));
          if (el.nodeName === 'CODE') el.spellcheck = false;
          if (isHighlight(n)) el.style.backgroundColor = HIGHLIGHT;
          copy(n, el, inCell);
        } else if (n.nodeName === 'FONT' && SIZES.includes(n.getAttribute('size'))) {
          const font = to.appendChild(document.createElement('font'));
          font.setAttribute('size', n.getAttribute('size'));
          if (isHighlight(n)) font.style.backgroundColor = HIGHLIGHT;
          copy(n, font, inCell);
        } else if (n.nodeName === 'A' && safeHref(n.getAttribute('href')) && !(to.nodeType === 1 && to.closest('a'))) {
          const a = to.appendChild(document.createElement('a'));
          a.setAttribute('href', n.getAttribute('href'));
          copy(n, a, inCell);
        } else if (n.nodeName === 'SPAN' && isHighlight(n)) {
          const span = to.appendChild(document.createElement('span'));
          span.style.backgroundColor = HIGHLIGHT;
          copy(n, span, inCell);
        } else if (n.nodeType === 1) {
          copy(n, to, inCell);
        }
      }
    };
    copy(src, out);

    // Ensures everything is inside lines (<div>).
    const wrapped = document.createDocumentFragment();
    let run = null;
    for (const n of [...out.childNodes]) {
      if (n.nodeName === 'DIV' || n.nodeName === 'PRE' || n.nodeName === 'TABLE') {
        run = null;
        if (!n.firstChild) n.appendChild(document.createElement('br'));
        wrapped.appendChild(n);
      } else {
        if (!run) run = wrapped.appendChild(document.createElement('div'));
        run.appendChild(n);
      }
    }
    // There is always a regular line after a trailing code block or table,
    // so the caret has somewhere to go.
    if (!wrapped.lastChild || wrapped.lastChild.nodeName === 'PRE' || wrapped.lastChild.nodeName === 'TABLE') {
      wrapped.appendChild(document.createElement('div')).appendChild(document.createElement('br'));
    }
    return wrapped;
  }

  function loadContent() {
    editor.replaceChildren(note.html ? sanitize(note.html) : sanitize(fromPlain(note.text)));
    syncNumbers();
    syncCheckSizes();
    renderCode();
    resetHistory();
  }

  // Every line is a <div> (or a code block). Backspace on the last empty
  // line can leave the editor with no line at all, and Chromium then types
  // straight into the editor: text that isn't in a line is wrapped in one,
  // so the list and code buttons see it. The text nodes are moved, not
  // copied, so the caret stays where it was.
  function wrapLooseLines() {
    let run = null;
    for (const n of [...editor.childNodes]) {
      if (n.nodeName === 'DIV' || n.nodeName === 'PRE' || n.nodeName === 'TABLE') {
        run = null;
      } else if (n.nodeType === 3 && !n.data && !run) {
        n.remove();
      } else {
        if (!run) {
          run = document.createElement('div');
          n.before(run);
        }
        run.appendChild(n);
      }
    }
    if (!editor.firstChild) {
      const line = editor.appendChild(document.createElement('div'));
      line.appendChild(document.createElement('br'));
      if (document.activeElement === editor) caretIn(line);
    }
  }

  // Numbered items count up within a run of items at the same level (deeper
  // items in between don't break it; anything else does) and show their
  // number from data-n (presentation only, recomputed on every change).
  function syncNumbers() {
    let counts = [];
    for (const block of editor.children) {
      if (!isListItem(block)) {
        counts = [];
        if (block.dataset.n) delete block.dataset.n;
        continue;
      }
      const level = levelOf(block);
      counts.length = level + 1;
      if (block.classList.contains('number')) {
        counts[level] = (counts[level] || 0) + 1;
        if (block.dataset.n !== String(counts[level])) block.dataset.n = String(counts[level]);
      } else {
        counts[level] = 0;
        if (block.dataset.n) delete block.dataset.n;
      }
    }
  }

  // List item (checklist, bullet or numbered) whose text is all in one size
  // (<font size>): tags the line with data-size so CSS gives the whole line
  // that size and the box/dot and strike-through stay centred on the text.
  function syncCheckSizes() {
    for (const block of editor.querySelectorAll('.check, .bullet, .number')) {
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

  // Saved HTML: the editor's, without the display tweaks of syncNumbers and
  // syncCheckSizes (data-n, data-size and --check-mid), which are recomputed
  // on load, and the address shown over a link (title).
  function contentHtml() {
    const copy = editor.cloneNode(true);
    for (const b of copy.querySelectorAll('[data-size]')) delete b.dataset.size;
    for (const b of copy.querySelectorAll('[data-n]')) delete b.dataset.n;
    for (const a of copy.querySelectorAll('a[title]')) a.removeAttribute('title');
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
    syncTables();
    syncLinks();
    wrapLooseLines();
    syncNumbers();
    syncCheckSizes();
    renderCode();
    renderTableTools();
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
    if (!sel.isCollapsed || currentCell()) return false;
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

  // "Before the marker": the caret at the start of a list item (or a code
  // block), drawn left of its box or dot (#markerCaret; the real caret is
  // hidden meanwhile). There Enter pushes the item down. Set by clicking left
  // of the box or ArrowLeft at the item's start; any other key or caret move
  // clears it.
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

  // "```lang" on a regular line: the match, with the language in [1].
  function fenceOf(line) {
    return line && !isListItem(line) && /^```([\w+#.-]*)$/.exec(line.textContent.trim());
  }

  // Replaces `line` with a code block, empty or holding `text` (then the
  // caret goes to its end).
  function openCodeBlock(line, lang, text = '') {
    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.spellcheck = false;
    const clean = codeLang(lang);
    if (clean) pre.dataset.lang = clean;
    if (text) pre.textContent = text;
    else pre.appendChild(document.createElement('br'));
    line.replaceWith(pre);
    if (!pre.nextElementSibling) {
      pre.after(document.createElement('div'));
      pre.nextElementSibling.appendChild(document.createElement('br'));
    }
    caretIn(pre, Boolean(text));
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

  // Typing before the marker of a list item or code block writes on a new
  // line above it: the caret moves into that line and the browser types the
  // character (or composes a dead key) there.
  function typeAbove(e, block) {
    const typed = e.key.length === 1 || e.key === 'Dead' || e.key === 'Process';
    if (!typed || e.metaKey || (e.ctrlKey && !e.altKey)) return false;
    const line = document.createElement('div');
    line.appendChild(document.createElement('br'));
    block.before(line);
    caretIn(line);
    return true;
  }

  // Inside the block: Enter breaks the line, Tab indents; Enter on an empty
  // last line leaves the block; Backspace in an empty block turns it back
  // into a regular line.
  function onCodeBlockKeydown(e, pre, mod, before) {
    // Like a list item: ArrowLeft at the block's start puts the caret before
    // the block (the browser would jump to the line above, or nowhere when the
    // block starts the note), and Enter there pushes the block down.
    const plainKey = !e.shiftKey && !mod && !e.altKey;
    const sel = getSelection();
    const atStart = sel.isCollapsed && textBeforeCaret(pre).toString().replace(ZWSP, '') === '';
    // Before a block that starts the note there is nowhere further left:
    // stay there (the browser would put the caret back inside the block).
    if (e.key === 'ArrowLeft' && plainKey && atStart && (!before || !pre.previousSibling)) {
      e.preventDefault();
      setBeforeMarker(pre);
      return;
    }
    if (e.key === 'Enter' && plainKey && before) {
      e.preventDefault();
      const line = document.createElement('div');
      line.appendChild(document.createElement('br'));
      pre.before(line);
      caretIn(pre);
      onContentChanged();
      setBeforeMarker(pre);
      return;
    }
    if (before && typeAbove(e, pre)) return;
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

  // `text` typed in a line becomes inline code. `typed` is what the last
  // input inserted: usually just the closing backtick, but where the
  // backtick is a dead key (ABNT2, US-International) it can come with the
  // next character ("`," or "` ") or only when the composition ends.
  function expandInlineCode(typed = '`') {
    const tail = typed.length - 1 - typed.lastIndexOf('`');
    const sel = getSelection();
    if (!sel.isCollapsed || !sel.anchorNode) return false;
    // A composition can leave the line split in several text nodes.
    if (sel.anchorNode.nodeType === 3) sel.anchorNode.parentNode.normalize();
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || node.parentElement.closest('code, pre')) return false;
    const pos = sel.anchorOffset;
    const text = node.data.slice(0, pos);
    const close = pos - 1 - tail;
    if (close < 1 || text[close] !== '`') return false;
    const open = text.lastIndexOf('`', close - 1);
    if (open < 0) return false;
    const inner = text.slice(open + 1, close);
    if (!inner.trim() || text[open - 1] === '`') return false;
    const r = document.createRange();
    r.setStart(node, open);
    r.setEnd(node, pos);
    insertCode(r, inner, text.slice(close + 1));
    return true;
  }

  // Inline element the arrows stop at the edges of: an inline code, a
  // highlight, or bold / italic / underline (the outermost, when nested).
  function currentBox() {
    const code = currentCode();
    if (code) return code;
    const block = currentBlock();
    let box = null;
    for (let n = getSelection().anchorNode; n && n !== block; n = n.parentNode) {
      if (n.nodeType === 1 && (isHighlight(n) || isTextStyle(n))) box = n;
    }
    return box;
  }

  // ArrowLeft inside a box (inline code, highlight, bold...). One letter
  // from its start, stops right before that letter, still inside (the
  // browser would jump out past it); at its start, moves just before the
  // box, into the text there (an invisible separator when there is none).
  function boxArrowLeft() {
    const sel = getSelection();
    const box = sel.isCollapsed && currentBox();
    if (!box) return false;
    const r = document.createRange();
    r.setStart(box, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    const before = [...r.toString().replace(ZWSP, '')];
    if (before.length > 1) return false;
    const first = document.createTreeWalker(box, NodeFilter.SHOW_TEXT).nextNode();
    if (!first) return false;
    const at = document.createRange();
    if (before.length === 1) {
      // After an invisible separator: right at the box's start, the browser
      // would type into the text before it.
      if (!first.data.startsWith('\u200b')) first.insertData(0, '\u200b');
      at.setStart(first, 1);
    } else {
      if (first.data.startsWith('\u200b') && first.length > 1) first.deleteData(0, 1);
      let prev = box.previousSibling;
      if (!(prev && prev.nodeType === 3)) {
        prev = document.createTextNode('');
        box.before(prev);
      }
      if (!prev.length) prev.data = '\u200b';
      at.setStart(prev, prev.length);
    }
    sel.removeAllRanges();
    sel.addRange(at);
    return true;
  }

  function arrowRight(wasBeforeMarker) {
    const sel = getSelection();
    if (!sel.isCollapsed || !sel.rangeCount) return false;
    // Before a marker: the next press goes to the item's (or block's) text.
    if (wasBeforeMarker && wasBeforeMarker.isConnected) return true;
    const block = currentPre() || currentBlock();
    if (!block) return false;
    const rest = document.createRange();
    rest.setStart(sel.anchorNode, sel.anchorOffset);
    rest.setEnd(block, block.childNodes.length);
    const after = rest.toString().replace(ZWSP, '');

    // End of a line followed by a list item or code block: before its marker.
    const next = block.nextElementSibling;
    if (!after && next && (next.nodeName === 'PRE' || isListItem(next))) {
      caretIn(next);
      setBeforeMarker(next);
      return true;
    }

    // Inside a box with nothing after the caret: just after the box.
    const box = currentBox();
    if (box) {
      const r = document.createRange();
      r.setStart(sel.anchorNode, sel.anchorOffset);
      r.setEnd(box, box.childNodes.length);
      if (r.toString().replace(ZWSP, '')) return false;
      // After an invisible separator: right at the box's end, the browser
      // would type into the box.
      let gap = box.nextSibling;
      while (gap && gap.nodeType === 3 && !gap.length) gap = gap.nextSibling;
      if (!(gap && gap.nodeType === 3)) {
        gap = document.createTextNode('');
        box.after(gap);
      }
      if (!gap.data.startsWith('\u200b')) gap.insertData(0, '\u200b');
      const at = document.createRange();
      at.setStart(gap, 1);
      sel.removeAllRanges();
      sel.addRange(at);
      return true;
    }

    // Right before a box: before its first letter, inside it.
    const entering = boxAfterCaret(sel.anchorNode, sel.anchorOffset, block);
    if (!entering) return false;
    const first = document.createTreeWalker(entering, NodeFilter.SHOW_TEXT).nextNode();
    if (!first) return false;
    if (!first.data.startsWith('\u200b')) first.insertData(0, '\u200b');
    const at = document.createRange();
    at.setStart(first, 1);
    sel.removeAllRanges();
    sel.addRange(at);
    return true;
  }

  // The box (inline code, highlight, bold...) that starts right after a
  // caret position (only invisible separators in between), if any.
  function boxAfterCaret(node, offset, block) {
    let n;
    if (node.nodeType === 3) {
      if (node.data.slice(offset).replace(ZWSP, '')) return null;
      n = node;
    } else {
      n = node.childNodes[offset];
      if (!n) n = node;
      else if (isBox(n)) return n;
    }
    // Climb until there is a next sibling, skipping separators.
    while (n && n !== block) {
      let sib = n.nextSibling;
      while (sib && sib.nodeType === 3 && !sib.data.replace(ZWSP, '')) sib = sib.nextSibling;
      if (sib) {
        while (sib && sib.nodeType === 1 && !isBox(sib)) sib = sib.firstChild;
        return sib && isBox(sib) ? sib : null;
      }
      n = n.parentNode;
    }
    return null;
  }

  const TEXT_STYLES = ['B', 'STRONG', 'I', 'EM', 'U'];
  const isTextStyle = (n) => TEXT_STYLES.includes(n.nodeName);
  const isBox = (n) => n.nodeType === 1 && (n.nodeName === 'CODE' || isHighlight(n) || isTextStyle(n));

  // Replaces `range` with <code>text</code>, followed by an invisible
  // separator (keeps the caret outside the code). Straight in the DOM:
  // Chromium's insertHTML would copy styles into it.
  function insertCode(range, text, after = '') {
    range.deleteContents();
    const code = document.createElement('code');
    code.spellcheck = false;
    code.textContent = text;
    const gap = document.createTextNode('\u200b' + after);
    range.insertNode(gap);
    range.insertNode(code);
    const caret = document.createRange();
    caret.setStartAfter(gap);
    caret.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(caret);
    return code;
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
    const mod = isMod(e);
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

    // ArrowLeft walks to the first letter of an inline code, highlight or
    // bold / italic / underline text, then one more press leaves it, the way
    // it goes before a list marker: the caret stops just before the box,
    // where typing writes plain text.
    if (e.key === 'ArrowLeft' && !e.shiftKey && !mod && !e.altKey && boxArrowLeft()) {
      e.preventDefault();
      return;
    }
    // ArrowRight mirrors it: entering a list item or code block from the end
    // of the line above stops before its marker first, entering a box (inline
    // code, highlight, bold...) stops before its first letter, and leaving
    // one stops just after it.
    if (e.key === 'ArrowRight' && !e.shiftKey && !mod && !e.altKey && arrowRight(wasBeforeMarker)) {
      e.preventDefault();
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
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      openLinkBox();
      return;
    }

    const pre = currentPre();
    if (pre) {
      onCodeBlockKeydown(e, pre, mod, wasBeforeMarker === pre);
      return;
    }
    const cell = currentCell();
    if (cell) {
      onTableKeydown(e, cell, mod);
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !mod && !e.altKey && !e.shiftKey && tableEdgeKey(e)) return;

    // "```lang" + Enter on a regular line opens a code block; "| a | b |" +
    // Enter, a table.
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
      const line = currentBlock();
      const fence = fenceOf(line);
      if (fence) {
        e.preventDefault();
        openCodeBlock(line, fence[1]);
        return;
      }
      const cells = tableRowOf(line);
      if (cells) {
        e.preventDefault();
        openTable(line, [cells, Array(cells.length).fill('')], [1, 0]);
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
    const atStart = getSelection().isCollapsed && textBeforeCaret(block).toString().replace(ZWSP, '') === '';

    const plainKey = !e.shiftKey && !mod && !e.altKey;
    const before = wasBeforeMarker === block && atStart;

    // ArrowLeft at the start of an item puts the caret before its marker;
    // there, in an item that starts the note, it stays put.
    if (e.key === 'ArrowLeft' && plainKey && atStart && (!before || !block.previousSibling)) {
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
    // Typing there writes on a new line above the item.
    if (before && typeAbove(e, block)) return;
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
        block.classList.remove('check', 'done', 'bullet', 'number');
        if (!block.classList.length) block.removeAttribute('class');
      }
      onContentChanged();
    }
  }

  const LIST_TYPES = ['check', 'bullet', 'number'];
  const isListItem = (block) => LIST_TYPES.some((type) => block.classList.contains(type));

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

  // "- " typed at the start of a line turns it into a bullet, "1. " (any
  // number) into a numbered item.
  function expandBullet() {
    const sel = getSelection();
    if (!sel.isCollapsed || currentCell()) return false;
    let block = currentBlock();
    if (!block) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
    }
    if (!block || isListItem(block)) return false;
    const before = textBeforeCaret(block);
    const m = /^\s*(-|\d+\.)[ \u00a0]$/.exec(before.toString());
    if (!m) return false;
    sel.removeAllRanges();
    sel.addRange(before);
    document.execCommand('delete'); // goes into the undo stack
    if (!block.isConnected) {
      document.execCommand('formatBlock', false, 'div');
      block = currentBlock();
      if (!block) return false;
    }
    block.classList.add(m[1] === '-' ? 'bullet' : 'number');
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
  // The line (or table cell) a paste starts in, and a link to itself being
  // edited (see "links").
  let pasteFrom = null;
  let selfLink = null;
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
    // Where the backtick is a dead key (macOS), the Enter after "```" also
    // ends its composition: the keydown comes marked as composing and is
    // skipped, so the browser breaks the line. Undo that and open the block.
    if (e.inputType === 'insertParagraph') {
      const line = currentBlock();
      const prev = line?.previousElementSibling;
      const fence = !line?.textContent && prev?.nodeName === 'DIV' && fenceOf(prev);
      if (fence) {
        line.remove();
        openCodeBlock(prev, fence[1]);
        return;
      }
    }
    let converted = false;
    if (e.inputType === 'insertText' && e.data?.includes('`') && e.data !== '`') {
      // A dead-key backtick that came with the next character.
      recordHistory(typing);
      converting = true;
      try { converted = expandInlineCode(e.data); } finally { converting = false; }
    } else if (e.inputType === 'insertText' && ['`', ']', ' '].includes(e.data)) {
      // Keep the text as typed, so undo after "[]" → box (or `x` → code,
      // "- " → bullet) brings back the characters instead of skipping them.
      recordHistory(typing);
      converting = true;
      try {
        if (e.data === '`') converted = expandInlineCode();
        else if (e.data === ']') converted = expandCheckbox();
        else if (!(converted = expandBullet())) {
          swallowLeadingSpace();
          converted = linkTypedWord();
        }
      } finally {
        converting = false;
      }
    }
    // Editing the text of a link to itself keeps its address in step.
    if (selfLink?.isConnected) {
      const url = bareUrl(selfLink.textContent);
      if (url) selfLink.setAttribute('href', hrefOf(url));
    }
    selfLink = null;
    // Enter after an address makes it a link; pasted addresses too.
    if (e.inputType === 'insertParagraph') linkLineEnd(currentBlock()?.previousElementSibling);
    if (pasting && pasteFrom?.isConnected) {
      const end = currentBlock() || pasteFrom;
      for (let n = pasteFrom; n; n = n.nextElementSibling) {
        linkAddresses(n);
        if (n === end || pasteFrom.nodeName === 'TD') break;
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
    const pre = currentPre();
    if (pre) {
      const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const sel = getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      if (pre.childNodes.length === 1 && pre.firstChild.nodeName === 'BR') {
        pre.removeChild(pre.firstChild);
      }
      const node = document.createTextNode(clean);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      onContentChanged();
      return;
    }
    pasting = true;
    pasteFrom = currentCell() || currentBlock();
    try {
      // A cell holds one line: line breaks become spaces.
      const oneLine = currentCell() || currentCode();
      document.execCommand('insertText', false, oneLine ? text.replace(/\s*\n\s*/g, ' ') : text);
    } finally {
      pasting = false;
      pasteFrom = null;
    }
  }

  // ------------------------------------------------------------- tables
  //
  // A table is a <table> straight in the editor, beside the lines; its cells
  // hold inline content only (no line breaks: Enter goes to the cell below).
  // While the mouse is over a table, #tableLayer shows a "+" on its left and
  // right edges (a new column on that side) and on its bottom edge (a new
  // row), and a few tools: header row on/off, delete the caret's row or
  // column. The header row is optional (class "head" on the table).

  const TABLE_COLS = 3;
  const TABLE_ROWS = 2;
  const tableLayer = $('tableLayer');
  const tableMark = tableLayer.querySelector('.table-mark');
  let hoveredTable = null;
  let hoveredCell = null;

  function currentCell() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const cell = el && el.closest('td');
    return cell && editor.contains(cell) ? cell : null;
  }

  // Puts the caret at the end of a cell, outside a box (inline code,
  // highlight, bold...) that ends it: after an invisible separator, as
  // ArrowRight does, so typing doesn't go into the box.
  function caretInCell(cell) {
    let last = cell.lastChild;
    while (last && last.nodeName === 'BR' && last.previousSibling) last = last.previousSibling;
    if (last && last.nodeType === 1 && last.nodeName !== 'BR' && last.nodeName !== 'IMG') {
      const gap = document.createTextNode('\u200b');
      last.after(gap);
      const r = document.createRange();
      r.setStart(gap, 1);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return;
    }
    caretIn(cell, true);
  }

  // A new cell holding `content`: text, nodes or nothing (an empty cell).
  function newCell(row, content, at = -1) {
    const cell = row.insertCell(at);
    if (typeof content === 'string' && content) cell.textContent = content;
    else if (Array.isArray(content) && content.length) cell.append(...content);
    else cell.appendChild(document.createElement('br'));
    return cell;
  }

  // A table from rows of cell contents (see newCell), as wide as the widest.
  function makeTable(rows, head = false) {
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const table = document.createElement('table');
    if (head) table.className = 'head';
    const body = table.appendChild(document.createElement('tbody'));
    for (const cells of rows) {
      const row = body.insertRow();
      for (let c = 0; c < cols; c++) newCell(row, cells[c]);
    }
    return table;
  }

  const emptyRows = () => Array.from({ length: TABLE_ROWS }, () => Array(TABLE_COLS).fill(''));

  // Replaces `line` with a table and puts the caret in its cell `focus`
  // ([row, column]); a regular line always follows it.
  function openTable(line, rows, focus = [0, 0], head = false) {
    const table = makeTable(rows, head);
    line.replaceWith(table);
    lineAfter(table);
    caretInCell(table.rows[focus[0]].cells[focus[1]]);
    onContentChanged();
    return table;
  }

  // The regular line right after a table (added when there is none).
  function lineAfter(table) {
    let next = table.nextElementSibling;
    if (!next || next.nodeName !== 'DIV') {
      next = document.createElement('div');
      next.appendChild(document.createElement('br'));
      table.after(next);
    }
    return next;
  }

  // "| a | b |" + Enter on a regular line: a table whose first row has those
  // cells, and an empty row below for the caret.
  function tableRowOf(line) {
    if (!line || isListItem(line) || line.querySelector('img')) return null;
    const text = line.textContent.replace(ZWSP, '').trim();
    return TABLE_ROW_RE.test(text) && !TABLE_SEP_RE.test(text) ? rowCells(text) : null;
  }

  // Keeps every table whole after any edit: rows as wide as the widest, a
  // <br> in empty cells, no empty rows or tables, a line after the last one.
  function syncTables() {
    for (const table of editor.querySelectorAll(':scope > table')) {
      for (const row of [...table.rows]) if (!row.cells.length) row.remove();
      const rows = [...table.rows];
      if (!rows.length) {
        table.remove();
        continue;
      }
      const cols = Math.max(...rows.map((row) => row.cells.length));
      for (const row of rows) {
        while (row.cells.length < cols) newCell(row);
        for (const cell of row.cells) {
          if (!cell.textContent && !cell.querySelector('br, img')) cell.appendChild(document.createElement('br'));
        }
      }
      if (!table.nextElementSibling) lineAfter(table);
    }
  }

  // Table commands, from the "+" buttons, the tools and the Format menu. Each
  // one leaves the caret in the table (or where it was) and records a step.
  function addColumn(table, side) {
    const cell = currentCell();
    const row = cell && table.contains(cell) ? cell.parentNode : table.rows[0];
    for (const r of table.rows) newCell(r, '', side === 'left' ? 0 : -1);
    editor.focus();
    caretIn(side === 'left' ? row.cells[0] : row.cells[row.cells.length - 1]);
    onContentChanged();
  }

  function addRow(table, at = -1) {
    const row = table.tBodies[0].insertRow(at);
    for (let c = 0; c < table.rows[0].cells.length; c++) newCell(row);
    editor.focus();
    caretIn(row.cells[0]);
    onContentChanged();
  }

  function deleteRow(table, row) {
    if (table.rows.length === 1) {
      deleteTable(table);
      return;
    }
    const column = Math.min(currentCell()?.cellIndex ?? 0, row.cells.length - 1);
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    editor.focus();
    caretInCell(next.cells[column]);
    onContentChanged();
  }

  function deleteColumn(table, column) {
    if (table.rows[0].cells.length === 1) {
      deleteTable(table);
      return;
    }
    const row = currentCell()?.parentNode || table.rows[0];
    for (const r of table.rows) r.cells[column]?.remove();
    editor.focus();
    caretInCell(row.cells[Math.min(column, row.cells.length - 1)]);
    onContentChanged();
  }

  function deleteTable(table) {
    const line = document.createElement('div');
    line.appendChild(document.createElement('br'));
    table.replaceWith(line);
    editor.focus();
    caretIn(line);
    setHoveredTable(null);
    onContentChanged();
  }

  function toggleHeader(table) {
    table.classList.toggle('head');
    if (!table.classList.length) table.removeAttribute('class');
    if (!currentCell()) {
      editor.focus();
      caretIn(table.rows[0].cells[0], true);
    }
    onContentChanged();
    renderTableTools();
  }

  // The cell the row and column tools act on: the caret's, in this table,
  // or the one last under the mouse.
  function targetCell(table) {
    const cell = currentCell();
    if (cell && table.contains(cell)) return cell;
    return hoveredCell && table.contains(hoveredCell) ? hoveredCell : null;
  }

  // Table from the buttons and menus. Inside a table: back to lines, one per
  // row ("| a | b |", the cells' formatting kept). With a selection: its
  // lines become rows ("| a | b |" lines and tab-separated text are split
  // into cells). With just the caret: a new empty table on the caret's line
  // if it is empty, or on a new line below.
  function toggleTable() {
    editor.focus();
    const cell = currentCell();
    if (cell) {
      const table = cell.closest('table');
      const lines = [...table.rows].map((row) => {
        const div = document.createElement('div');
        div.append('| ');
        [...row.cells].forEach((c, i) => {
          if (i) div.append(' | ');
          div.append(...[...c.childNodes].filter((n) => n.nodeName !== 'BR'));
        });
        div.append(' |');
        return div;
      });
      table.replaceWith(...lines);
      caretIn(lines[lines.length - 1], true);
      onContentChanged();
      scheduleFormatBar();
      return;
    }
    if (getSelection().isCollapsed) {
      insertEmpty('table');
      return;
    }
    const lines = touchedLines();
    if (!lines.length) return;
    const rows = lines.map((b) => {
      const text = b.textContent.replace(ZWSP, '').trim();
      if (TABLE_ROW_RE.test(text)) return rowCells(text);
      if (text.includes('\t')) return text.split('\t').map((c) => c.trim());
      return [[...b.childNodes].filter((n) => n.nodeName !== 'BR')];
    });
    const sep = rows.length > 1 && rows[1].length && rows[1].every((c) => typeof c === 'string' && /^:?-+:?$/.test(c));
    if (sep) rows.splice(1, 1);
    for (const b of lines.slice(1)) b.remove();
    openTable(lines[0], rows, [rows.length - 1, 0], sep);
    scheduleFormatBar();
  }

  // Keys inside a cell. Tab / Shift+Tab: next / previous cell (Tab in the
  // last one adds a row). Enter: the cell below, or the line after the table.
  // Backspace at a cell's start goes to the end of the previous cell (in an
  // empty row's first cell, deletes the row); Delete at a cell's end does
  // nothing, so cells never merge. ArrowUp in the first row of a table that
  // starts the note makes a line above it.
  function onTableKeydown(e, cell, mod) {
    const table = cell.closest('table');
    const cells = [...table.querySelectorAll('td')];
    const i = cells.indexOf(cell);
    const row = cell.parentNode;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        if (i > 0) caretInCell(cells[i - 1]);
      } else if (i < cells.length - 1) {
        caretInCell(cells[i + 1]);
      } else {
        addRow(table);
      }
      return;
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      const next = row.nextElementSibling;
      if (next) {
        caretInCell(next.cells[cell.cellIndex]);
      } else {
        const line = lineAfter(table);
        caretIn(line);
        onContentChanged();
      }
      return;
    }
    const sel = getSelection();
    if (!sel.isCollapsed) return;
    const before = document.createRange();
    before.setStart(cell, 0);
    before.setEnd(sel.anchorNode, sel.anchorOffset);
    const atStart = !before.toString().replace(ZWSP, '') && !before.cloneContents().querySelector('img');
    if (e.key === 'Backspace' && !mod && !e.altKey && atStart) {
      e.preventDefault();
      if (cell.cellIndex === 0 && ![...row.cells].some((c) => c.textContent.replace(ZWSP, '').trim() || c.querySelector('img'))) {
        deleteRow(table, row);
      } else if (i > 0) {
        caretInCell(cells[i - 1]);
      }
      return;
    }
    if (e.key === 'Delete' && !mod && !e.altKey) {
      const after = document.createRange();
      after.setStart(sel.anchorNode, sel.anchorOffset);
      after.setEnd(cell, cell.childNodes.length);
      if (!after.toString().replace(ZWSP, '') && !after.cloneContents().querySelector('img')) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp' && !mod && !e.altKey && !e.shiftKey && row.rowIndex === 0 && !table.previousElementSibling) {
      e.preventDefault();
      const line = document.createElement('div');
      line.appendChild(document.createElement('br'));
      table.before(line);
      caretIn(line);
      onContentChanged();
    }
  }

  // Backspace at the start of the line after a table, or Delete at the end
  // of the line before one: into the table's last (first) cell instead of
  // merging the line into it, taking an empty line away.
  function tableEdgeKey(e) {
    const sel = getSelection();
    const line = currentBlock();
    if (!sel.isCollapsed || !line || isListItem(line)) return false;
    const empty = !line.textContent.replace(ZWSP, '') && !line.querySelector('img');
    if (e.key === 'Backspace') {
      const table = line.previousElementSibling;
      if (table?.nodeName !== 'TABLE' || textBeforeCaret(line).toString().replace(ZWSP, '')) return false;
      e.preventDefault();
      if (empty && line.nextElementSibling) line.remove();
      const last = table.rows[table.rows.length - 1];
      caretInCell(last.cells[last.cells.length - 1]);
      if (!line.isConnected) onContentChanged();
      return true;
    }
    const table = line.nextElementSibling;
    if (table?.nodeName !== 'TABLE') return false;
    const rest = document.createRange();
    rest.setStart(sel.anchorNode, sel.anchorOffset);
    rest.setEnd(line, line.childNodes.length);
    if (rest.toString().replace(ZWSP, '')) return false;
    e.preventDefault();
    if (empty) line.remove();
    caretIn(table.rows[0].cells[0]);
    if (!line.isConnected) onContentChanged();
    return true;
  }

  // The "+" buttons and tools of the table under the mouse.
  function setHoveredTable(table, x = 0, y = 0) {
    hoveredTable = table && table.isConnected ? table : null;
    tableLayer.hidden = !hoveredTable;
    if (!hoveredTable) {
      hoveredCell = null;
      tableMark.hidden = true;
      return;
    }
    renderTableTools();
  }

  // Where the table's controls go (on every change, scroll and resize).
  function renderTableTools() {
    if (!hoveredTable) return;
    if (!hoveredTable.isConnected) {
      setHoveredTable(null);
      return;
    }
    const box = tableLayer.getBoundingClientRect();
    const r = hoveredTable.getBoundingClientRect();
    const place = (el, x, y) => {
      el.style.left = `${x - box.left - el.offsetWidth / 2}px`;
      el.style.top = `${y - box.top - el.offsetHeight / 2}px`;
    };
    const midY = (r.top + r.bottom) / 2;
    for (const btn of tableLayer.querySelectorAll('[data-add]')) {
      if (btn.dataset.add === 'left') place(btn, r.left, midY);
      else if (btn.dataset.add === 'right') place(btn, r.right, midY);
      else place(btn, (r.left + r.right) / 2, r.bottom);
    }
    const tools = tableLayer.querySelector('.table-tools');
    tools.style.left = `${r.right - box.left - tools.offsetWidth}px`;
    tools.style.top = `${r.bottom - box.top - tools.offsetHeight / 2}px`;
    const header = tools.querySelector('[data-tool="header"]');
    header.setAttribute('aria-pressed', String(hoveredTable.classList.contains('head')));
    const target = targetCell(hoveredTable);
    for (const btn of tools.querySelectorAll('[data-tool^="delete"]')) btn.disabled = !target;
  }

  // While a delete tool is hovered, the row or column it would delete is
  // tinted.
  function markTarget(tool) {
    const cell = tool && hoveredTable && targetCell(hoveredTable);
    tableMark.hidden = !cell;
    if (!cell) return;
    const box = tableLayer.getBoundingClientRect();
    const t0 = hoveredTable.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    const rect = tool === 'deleteRow'
      ? { left: t0.left, right: t0.right, top: c.top, bottom: c.bottom }
      : { left: c.left, right: c.right, top: t0.top, bottom: t0.bottom };
    tableMark.style.left = `${rect.left - box.left}px`;
    tableMark.style.top = `${rect.top - box.top}px`;
    tableMark.style.width = `${rect.right - rect.left}px`;
    tableMark.style.height = `${rect.bottom - rect.top}px`;
  }

  // The table near the pointer (within the reach of its "+" buttons).
  function tableNear(x, y) {
    for (const table of editor.querySelectorAll(':scope > table')) {
      const r = table.getBoundingClientRect();
      if (x >= r.left - 16 && x <= r.right + 16 && y >= r.top - 4 && y <= r.bottom + 16) return table;
    }
    return null;
  }

  function runTableTool(tool) {
    const table = hoveredTable;
    if (!table) return;
    const cell = targetCell(table);
    if (tool === 'header') toggleHeader(table);
    else if (tool === 'deleteRow' && cell) deleteRow(table, cell.parentNode);
    else if (tool === 'deleteColumn' && cell) deleteColumn(table, cell.cellIndex);
    markTarget(null);
    renderTableTools();
  }

  // Table commands for the Format menu, while the caret is in a table.
  function tableMenuItems() {
    const cell = currentCell();
    if (!cell) return [];
    const table = cell.closest('table');
    const run = (fn) => withMenuSelection(() => {
      if (table.isConnected && cell.isConnected) fn();
    });
    return [
      null,
      { label: t('tableHeader'), checked: table.classList.contains('head'), run: run(() => toggleHeader(table)) },
      { label: t('addRow'), run: run(() => addRow(table)) },
      { label: t('addColumnLeft'), run: run(() => addColumn(table, 'left')) },
      { label: t('addColumnRight'), run: run(() => addColumn(table, 'right')) },
      { label: t('deleteRow'), run: run(() => deleteRow(table, cell.parentNode)) },
      { label: t('deleteColumn'), run: run(() => deleteColumn(table, cell.cellIndex)) },
      { label: t('deleteTable'), run: run(() => deleteTable(table)) },
    ];
  }

  // ------------------------------------------------------------- images
  //
  // A pasted image is re-encoded on a canvas (at most IMAGE_SIDE px on its
  // longest side) into a data URL (saved as a file by Rust): lossless PNG when that is
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

  // -------------------------------------------------------------- links
  //
  // A link is <a href> around text (web or mail addresses only). Clicking
  // it opens the address in the system's browser (open_link in Rust); a
  // drag that starts on it still selects text. An address typed (followed
  // by a space or Enter) or pasted becomes a link to itself, and editing
  // such a link's text keeps its address in step. The link button, Mod+K
  // and the Format menu open #linkBox to add, change, open or remove the
  // link of the selection (or insert one at the caret).

  const linkBox = $('linkBox');
  const linkInput = $('linkInput');
  let linkRange = null;
  let editingLink = null;

  // A link whose text is its own address ("https://x.com", "www.x.com").
  const isSelfLink = (a) => {
    const url = bareUrl(a.textContent);
    return Boolean(url) && hrefOf(url) === a.getAttribute('href');
  };

  // The link holding the caret, or the first one the selection touches.
  function currentLink() {
    const sel = getSelection();
    if (!sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const n = range.startContainer;
    const el = n.nodeType === 1 ? n : n.parentElement;
    const a = el && el.closest('a');
    if (a && editor.contains(a)) return a;
    if (range.collapsed) return null;
    return [...editor.querySelectorAll('a')].find((link) => range.intersectsNode(link)) || null;
  }

  function openLink(a) {
    const url = safeHref(a.getAttribute('href'));
    if (url) invoke('open_link', { url }).catch((err) => console.error('open_link', err));
  }

  // What was typed in #linkBox as an address: "x.com" → "https://x.com",
  // "a@b.com" → "mailto:a@b.com"; '' when it can't be one.
  function linkAddress(text) {
    const url = text.trim();
    if (!url) return '';
    if (/^[a-z][\w+.-]*:/i.test(url)) return safeHref(url);
    if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
    return /^[^\s/]+\.[^\s/]+/.test(url) ? `https://${url}` : '';
  }

  // Wraps text[start, end) of a text node in a link to `href`.
  function wrapLink(node, start, end, href) {
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const a = document.createElement('a');
    a.setAttribute('href', href);
    r.surroundContents(a);
    return a;
  }

  // An address that ends right before `offset` in a text node (just typed,
  // followed by a space or Enter) becomes a link; the caret, if given (an
  // offset in the same node), stays where it was. Returns whether it did.
  function linkWordBefore(node, offset, caret = null) {
    if (!node || node.nodeType !== 3 || node.parentElement.closest('a, code, pre')) return false;
    const before = node.data.slice(0, offset);
    const m = /(?:https?:\/\/|www\.)\S*$/i.exec(before);
    if (!m || /[\w@./]/.test(before[m.index - 1] || '')) return false;
    const url = trimUrl(m[0]);
    if (!url || bareUrl(url) !== url) return false;
    const a = wrapLink(node, m.index, m.index + url.length, hrefOf(url));
    const tail = caret === null ? 0 : caret - m.index - url.length;
    if (tail > 0 && a.nextSibling) {
      const r = document.createRange();
      r.setStart(a.nextSibling, tail);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
    return true;
  }

  // A space typed after an address: the address before it becomes a link.
  // Typed right after a link to itself ("www.x.com" + "/page"), it extends
  // that link.
  function linkTypedWord() {
    const sel = getSelection();
    const node = sel.anchorNode;
    if (!sel.isCollapsed || !node || node.nodeType !== 3) return false;
    const end = sel.anchorOffset - 1;
    const prev = node.previousSibling;
    const word = node.data.slice(0, Math.max(0, end));
    if (prev?.nodeName === 'A' && isSelfLink(prev) && word && !/\s/.test(word)) {
      const url = trimUrl(prev.textContent + word);
      if (url.length <= prev.textContent.length || bareUrl(url) !== url) return false;
      const moved = url.length - prev.textContent.length;
      const rest = node.splitText(moved);
      prev.appendChild(node);
      prev.normalize();
      prev.setAttribute('href', hrefOf(url));
      const r = document.createRange();
      r.setStart(rest, end - moved + 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    }
    return linkWordBefore(node, Math.max(0, end), sel.anchorOffset);
  }

  // Enter after an address: the end of the line it left becomes a link.
  function linkLineEnd(line) {
    if (!line || line.nodeName !== 'DIV') return;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) last = n;
    if (last) linkWordBefore(last, last.data.replace(/\s+$/, '').length);
  }

  // Every address in the text under `root` (outside links and code)
  // becomes a link: used on pasted lines.
  function linkAddresses(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.parentElement.closest('a, code, pre')) nodes.push(n);
    }
    // The caret as a number of characters into `root`, put back afterwards
    // (wrapping moves the text it was in).
    const sel = getSelection();
    let caret = -1;
    if (sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode)) {
      const r = document.createRange();
      r.setStart(root, 0);
      r.setEnd(sel.anchorNode, sel.anchorOffset);
      caret = r.toString().length;
    }
    let changed = false;
    for (const node of nodes) {
      // From the end, so earlier matches keep their offsets.
      BARE_URL_RE.lastIndex = 0;
      const found = [...node.data.matchAll(BARE_URL_RE)].map((m) => [m.index, trimUrl(m[0])]).filter(([, url]) => url);
      for (const [start, url] of found.reverse()) {
        wrapLink(node, start, start + url.length, hrefOf(url));
        changed = true;
      }
    }
    if (changed && caret >= 0) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const r = document.createRange();
      r.selectNodeContents(root);
      r.collapse(false);
      for (let n = walk.nextNode(), left = caret; n; n = walk.nextNode()) {
        if (left > n.length) { left -= n.length; continue; }
        // At the end of a link: after it, so typing goes on outside.
        const a = left === n.length && n.parentElement.closest('a');
        if (a && root.contains(a)) r.setStartAfter(a);
        else r.setStart(n, left);
        r.collapse(true);
        break;
      }
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return changed;
  }

  // Links left without text are removed (keeping what they hold).
  function syncLinks() {
    for (const a of editor.querySelectorAll('a')) {
      if (!a.textContent.replace(ZWSP, '') && !a.querySelector('img')) a.replaceWith(...a.childNodes);
    }
  }

  // #linkBox: floats below the selection (or above, if it doesn't fit),
  // like the format bar.
  function placeLinkBox(range) {
    let rects = [...range.getClientRects()].filter((r) => r.width || r.height);
    if (!rects.length) {
      const n = range.startContainer;
      const el = n.nodeType === 1 ? n : n.parentElement;
      rects = [el.getBoundingClientRect()];
    }
    const first = rects[0];
    const last = rects[rects.length - 1];
    const w = linkBox.offsetWidth;
    const h = linkBox.offsetHeight;
    let top = last.bottom + 6;
    if (top + h > window.innerHeight - 4) top = first.top - h - 6;
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
    const left = Math.max(4, Math.min(first.left, window.innerWidth - w - 4));
    linkBox.style.left = `${left}px`;
    linkBox.style.top = `${top}px`;
  }

  // Link button / Mod+K / Format menu: asks for the address of the
  // selection's link (a new one, or the one at the caret).
  function openLinkBox() {
    const sel = getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode) || currentPre()) return;
    linkRange = sel.getRangeAt(0).cloneRange();
    editingLink = currentLink();
    const selected = bareUrl(sel.toString());
    linkInput.value = editingLink ? editingLink.getAttribute('href').replace(/^mailto:/i, '') : selected;
    linkBox.classList.toggle('editing', Boolean(editingLink));
    hideFormatBar();
    linkBox.hidden = false;
    placeLinkBox(linkRange);
    linkInput.focus();
    linkInput.select();
  }

  function closeLinkBox(restore) {
    if (linkBox.hidden) return;
    linkBox.hidden = true;
    if (restore && linkRange) {
      editor.focus();
      getSelection().removeAllRanges();
      getSelection().addRange(linkRange);
    }
    linkRange = null;
    editingLink = null;
  }

  // Enter in #linkBox: the address applies to the link being edited, to the
  // selected text, or goes in at the caret as a link to itself. Empty, it
  // removes the link.
  function applyLinkBox() {
    const href = linkAddress(linkInput.value);
    if (linkInput.value.trim() && !href) {
      linkInput.select();
      return;
    }
    const link = editingLink;
    const range = linkRange;
    closeLinkBox(true);
    if (!href) {
      if (link) unlink(link);
      return;
    }
    if (link) {
      link.setAttribute('href', href);
    } else if (range.collapsed) {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = linkInput.value.trim();
      // After the link, plain text again.
      const gap = document.createTextNode('​');
      range.insertNode(gap);
      range.insertNode(a);
      const r = document.createRange();
      r.setStartAfter(gap);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    } else {
      document.execCommand('createLink', false, href);
    }
    onContentChanged();
    scheduleFormatBar();
  }

  // Turns a link back into its text (and formatting).
  function unlink(a) {
    const parent = a.parentNode;
    const kids = [...a.childNodes];
    a.replaceWith(...kids);
    parent.normalize();
    onContentChanged();
    scheduleFormatBar();
  }

  linkBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLinkBox(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeLinkBox(true); }
  });
  linkInput.addEventListener('blur', () => {
    // A click on the box's own buttons keeps it (they don't take focus).
    setTimeout(() => { if (document.activeElement !== linkInput) closeLinkBox(false); });
  });
  linkBox.addEventListener('mousedown', (e) => { if (e.target !== linkInput) e.preventDefault(); });
  $('linkOpen').addEventListener('click', () => {
    if (editingLink) openLink(editingLink);
    closeLinkBox(true);
  });
  $('linkRemove').addEventListener('click', () => {
    const link = editingLink;
    closeLinkBox(true);
    if (link) unlink(link);
  });

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

  // Highlight: Chromium (hiliteColor) produces <span style="background-color">;
  // WebKit (macOS, Linux) puts the style on an existing <b>/<i>/<u>/<font>
  // when the selection is exactly one, so those keep it too. The stored colour
  // is a fixed sentinel; the real one comes from the theme (--highlight).
  const HIGHLIGHT = 'rgb(255, 230, 0)';
  const isHighlight = (n) => Boolean(n.style) && n.style.backgroundColor === HIGHLIGHT;

  function currentHighlight() {
    const sel = getSelection();
    if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    let n = range.startContainer.childNodes[range.startOffset] || range.startContainer;
    while (n.firstChild) n = n.firstChild;
    for (; n && n !== editor; n = n.parentNode) {
      if (isHighlight(n)) return true;
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

  // Lines (not code blocks) the selection touches, or the caret's line. A
  // selection ending at the very start of a line (a triple click) leaves
  // that line out, and so does one starting at the very end of a line (a
  // drag begun past the end of the line above).
  function touchedLines() {
    const sel = getSelection();
    if (!sel.rangeCount) return [];
    wrapLooseLines();
    const range = sel.getRangeAt(0);
    const lines = selectedBlocks().filter((b) => b.nodeName === 'DIV');
    if (range.collapsed) return lines;
    const touched = lines.filter((b, i) => {
      const r = document.createRange();
      if (i === 0) {
        r.setStart(range.startContainer, range.startOffset);
        r.setEnd(b, b.childNodes.length);
      } else {
        r.setStart(b, 0);
        r.setEnd(range.endContainer, range.endOffset);
      }
      return r.toString().replace(ZWSP, '') !== '' || b.querySelector('img') || lines.length === 1;
    });
    return touched.length ? touched : lines.slice(0, 1);
  }

  // Checklist / bulleted / numbered list from the buttons and menus: the
  // touched lines become items of that type, or plain lines again when they
  // all are already.
  function toggleList(type) {
    editor.focus();
    const lines = touchedLines();
    if (!lines.length) return;
    const off = lines.every((b) => b.classList.contains(type));
    for (const b of lines) {
      b.classList.remove(...LIST_TYPES, 'done');
      if (off) delete b.dataset.level;
      else b.classList.add(type);
      if (!b.classList.length) b.removeAttribute('class');
    }
    onContentChanged();
    scheduleFormatBar();
  }

  // Code block from the buttons and menus: the touched lines become one
  // block with their text (an empty line, an empty block); inside a block,
  // its text goes back to plain lines.
  function toggleCodeBlock() {
    editor.focus();
    const pre = currentPre();
    if (pre) {
      const lines = preText(pre).split('\n').map((text) => {
        const div = document.createElement('div');
        if (text) div.textContent = text;
        else div.appendChild(document.createElement('br'));
        return div;
      });
      pre.replaceWith(...lines);
      caretIn(lines[lines.length - 1], true);
      onContentChanged();
      scheduleFormatBar();
      return;
    }
    const lines = touchedLines();
    if (!lines.length || lines.some((b) => b.querySelector('img'))) return;
    const text = lines.map((b) => b.textContent.replace(ZWSP, '')).join('\n');
    for (const b of lines.slice(1)) b.remove();
    openCodeBlock(lines[0], '', text);
    scheduleFormatBar();
  }

  // Every formatting command by name, for the format bar, the titlebar menu
  // and the format tray.
  const FORMAT_COMMANDS = {
    bold: () => format('bold'),
    italic: () => format('italic'),
    underline: () => format('underline'),
    highlight: toggleHighlight,
    code: toggleCode,
    check: () => toggleList('check'),
    bullet: () => toggleList('bullet'),
    number: () => toggleList('number'),
    codeBlock: toggleCodeBlock,
    table: toggleTable,
    link: openLinkBox,
  };

  // Whether a command is on for the selection or the caret's line.
  function formatState(cmd) {
    if (cmd === 'highlight') return currentHighlight();
    if (cmd === 'code') return Boolean(currentCode());
    if (cmd === 'codeBlock') return Boolean(currentPre());
    if (cmd === 'table') return Boolean(currentCell());
    if (cmd === 'link') return Boolean(currentLink());
    if (LIST_TYPES.includes(cmd)) {
      const lines = touchedLines();
      return lines.length > 0 && lines.every((b) => b.classList.contains(cmd));
    }
    return document.queryCommandState(cmd);
  }

  // Pressed state of a toolbar's buttons (format bar, format tray).
  function renderFormatState(bar) {
    for (const btn of bar.querySelectorAll('[data-cmd]')) {
      btn.setAttribute('aria-pressed', String(formatState(btn.dataset.cmd)));
    }
    const size = currentSize();
    for (const btn of bar.querySelectorAll('[data-size]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.size === size));
    }
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
    if (!formatTray.hidden) renderFormatState(formatTray);
    // A selected image has its resize frame instead.
    const range = !selecting && note && document.activeElement === editor && !selectedImage() && selectionRange();
    const rects = range ? [...range.getClientRects()].filter((r) => r.width || r.height) : [];
    if (!rects.length) { hideFormatBar(); return; }

    renderFormatState(formatBar);
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

  // ------------------------------------------------------- format tray

  // The footer's "Aa" shows the format bar's buttons above the footer, for
  // the selection or the caret's line. Like a menu, picking one of its
  // buttons, any click outside it (or on "Aa" again), Esc or leaving the
  // window folds it away.
  const formatTray = $('formatTray');
  const trayBtn = $('trayBtn');
  formatTray.append(...[...formatBar.children].map((n) => n.cloneNode(true)));

  function showTray(on) {
    formatTray.hidden = !on;
    trayBtn.setAttribute('aria-pressed', String(on));
    if (on) renderFormatState(formatTray);
  }

  const toggleTray = () => showTray(formatTray.hidden);

  // With just the caret (nothing selected), the tray's buttons add a new,
  // empty element instead of formatting what is there: a list item or code
  // block on a new line below (or on the caret's line, if it is an empty
  // plain line), an empty inline code at the caret, and bold, italic,
  // underline, highlight or size for what is typed next.
  function insertEmpty(cmd) {
    editor.focus();
    if (LIST_TYPES.includes(cmd) || cmd === 'codeBlock' || cmd === 'table') {
      const line = currentPre() || currentCell()?.closest('table') || currentBlock() || editor.lastElementChild;
      let target = line;
      const emptyLine = line && line.nodeName === 'DIV' && !isListItem(line)
        && !line.textContent.replace(ZWSP, '') && !line.querySelector('img');
      if (!emptyLine) {
        target = document.createElement('div');
        target.appendChild(document.createElement('br'));
        if (line) line.after(target);
        else editor.append(target);
      }
      if (cmd === 'codeBlock') {
        openCodeBlock(target, '');
      } else if (cmd === 'table') {
        openTable(target, emptyRows());
      } else {
        target.className = cmd;
        // Under a list item, the new item takes its level.
        if (line && isListItem(line) && levelOf(line)) target.dataset.level = line.dataset.level;
        caretIn(target);
        onContentChanged();
      }
    } else if (cmd === 'code') {
      const sel = getSelection();
      if (!sel.rangeCount || currentPre() || currentCode()) return;
      // Caret inside, after the invisible character that keeps it open.
      const code = insertCode(sel.getRangeAt(0), '\u200b');
      const r = document.createRange();
      r.setStart(code.firstChild, 1);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      onContentChanged();
    } else {
      FORMAT_COMMANDS[cmd]();
      return;
    }
    scheduleFormatBar();
  }

  // ------------------------------------------------------- format menu

  // "Format" in the titlebar menu (… / right click): every formatting
  // command, applied to the selection (or the caret's line) the editor had
  // when the menu opened.
  let menuRange = null;

  function saveMenuSelection() {
    const sel = getSelection();
    const range = sel.rangeCount && sel.getRangeAt(0);
    menuRange = range && editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
  }

  function withMenuSelection(run) {
    return () => {
      editor.focus();
      if (menuRange && editor.contains(menuRange.commonAncestorContainer)) {
        getSelection().removeAllRanges();
        getSelection().addRange(menuRange);
      }
      run();
    };
  }

  function formatMenuItems() {
    const cmd = (name, key) => ({ label: t(key), run: withMenuSelection(FORMAT_COMMANDS[name]) });
    const size = (value, key) => ({ label: t(key), run: withMenuSelection(() => setSize(value)) });
    return [
      cmd('bold', 'bold'),
      cmd('italic', 'italic'),
      cmd('underline', 'underline'),
      cmd('highlight', 'highlight'),
      cmd('code', 'code'),
      cmd('link', 'link'),
      null,
      cmd('check', 'checklist'),
      cmd('bullet', 'bulletList'),
      cmd('number', 'numberedList'),
      cmd('codeBlock', 'codeBlock'),
      cmd('table', 'table'),
      ...tableMenuItems(),
      null,
      size('2', 'smallText'),
      size('3', 'normalText'),
      size('5', 'largeText'),
      null,
      { label: t('formatTray'), checked: !formatTray.hidden, run: toggleTray },
    ];
  }

  // ------------------------------------------------------------ actions

  async function newNote() {
    colors.close();
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
    colors.close();
    await bar.finishRename(true);
    await flushText();
    invoke('close_note').catch((err) => console.error('close_note', err));
  }

  async function trashNote() {
    colors.close();
    await bar.finishRename(true);
    await flushText();
    invoke('trash_note').catch((err) => console.error('trash_note', err));
  }

  // ------------------------------------------------------------- events

  editor.addEventListener('input', onEditorInput);
  // Dead keys (the backtick on ABNT2 / US-International keyboards) can
  // arrive as a composition, which the input handler doesn't convert.
  editor.addEventListener('compositionend', (e) => {
    if (!e.data?.includes('`') || currentPre()) return;
    recordHistory(false);
    converting = true;
    let converted;
    try { converted = expandInlineCode(e.data); } finally { converting = false; }
    if (converted) onContentChanged();
  });
  // Undo/Redo from the context menu (or any other source) also go through
  // the editor's own history.
  editor.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') return;
    e.preventDefault();
    restoreHistory(e.inputType === 'historyUndo' ? -1 : 1);
  });
  editor.addEventListener('beforeinput', () => {
    const a = currentLink();
    selfLink = a && isSelfLink(a) ? a : null;
  });
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('paste', onPaste);
  // A click on a link opens it in the browser (a drag from it selects text);
  // hovering shows its address.
  editor.addEventListener('click', (e) => {
    const a = e.target.closest?.('a');
    if (!a || !editor.contains(a) || e.button !== 0) return;
    e.preventDefault();
    if (getSelection().isCollapsed) openLink(a);
  });
  editor.addEventListener('mouseover', (e) => {
    const a = e.target.closest?.('a');
    if (a && editor.contains(a)) a.title = a.getAttribute('href').replace(/^mailto:/i, '');
  });
  editor.addEventListener('mouseout', (e) => {
    const a = e.target.closest?.('a');
    if (a && !a.contains(e.relatedTarget)) a.removeAttribute('title');
  });
  editor.addEventListener('blur', () => {
    flushText();
    renderImageFrame();
  });
  editor.addEventListener('scroll', () => {
    renderCode();
    renderTableTools();
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
  // Tables: the "+" buttons and tools of the one under the mouse. The layer
  // sits on top of the editor, so the whole body is watched.
  const body = editor.parentElement;
  body.addEventListener('mousemove', (e) => {
    const cell = e.target.closest && e.target.closest('td');
    if (cell && editor.contains(cell)) hoveredCell = cell;
    setHoveredTable(tableNear(e.clientX, e.clientY), e.clientX, e.clientY);
  });
  body.addEventListener('mouseleave', () => setHoveredTable(null));
  tableLayer.addEventListener('mousedown', (e) => e.preventDefault());
  tableLayer.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !hoveredTable) return;
    if (btn.dataset.add === 'bottom') addRow(hoveredTable);
    else if (btn.dataset.add) addColumn(hoveredTable, btn.dataset.add);
    else runTableTool(btn.dataset.tool);
    renderTableTools();
  });
  tableLayer.addEventListener('mouseover', (e) => markTarget(e.target.closest('[data-tool^="delete"]:not(:disabled)')?.dataset.tool));
  tableLayer.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget?.closest?.('[data-tool^="delete"]')) markTarget(null);
  });
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
    renderTableTools();
    // The caret left the start of the item: no longer before its marker.
    if (beforeMarker) {
      const block = currentPre() || currentBlock();
      if (!getSelection().isCollapsed || block !== beforeMarker || textBeforeCaret(block).toString().replace(ZWSP, '') !== '') {
        setBeforeMarker(null);
      }
    }
  });
  editor.addEventListener('blur', () => setBeforeMarker(null));
  editor.addEventListener('scroll', renderMarkerCaret);
  new ResizeObserver(() => {
    renderCode();
    renderTableTools();
    renderImageFrame();
    renderMarkerCaret();
    scheduleFormatBar();
  }).observe(editor);

  // mousedown with preventDefault: clicking the bar keeps the text selection.
  for (const bar of [formatBar, formatTray]) {
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cmd], [data-size]');
      if (!btn) return;
      const sel = getSelection();
      const caretOnly = !sel.rangeCount || sel.isCollapsed || !editor.contains(sel.anchorNode);
      if (btn.dataset.size) setSize(btn.dataset.size);
      else if (bar === formatTray && caretOnly) insertEmpty(btn.dataset.cmd);
      else FORMAT_COMMANDS[btn.dataset.cmd]();
      // A tray button is used once, like a menu item: the tray folds away.
      if (bar === formatTray) showTray(false);
    });
  }
  // mousedown preventDefault: the text keeps its selection for the tray.
  trayBtn.addEventListener('mousedown', (e) => e.preventDefault());
  trayBtn.addEventListener('click', toggleTray);

  // Colour picker under the titlebar (components/color-menu.js). It stays
  // open when the window loses focus: the system picker takes it.
  const colors = new ColorMenu({
    frame,
    button: colorBtn,
    menu: colorMenu,
    input: $('customColor'),
    current: () => note && note.color,
    onPick: setColor,
    // The system picker opens on the colour the note shows now.
    customStart: () => (getComputedStyle(frame).getPropertyValue('--note-color').trim().match(/^#[0-9a-f]{6}$/i) || [])[0],
    onOpen: hideFormatBar,
    closeOnBlur: false,
  });

  document.addEventListener('mousedown', (e) => {
    if (!formatTray.hidden && !formatTray.contains(e.target) && !trayBtn.contains(e.target)) showTray(false);
  });

  // -------------------------------------------------------------- groups
  // The footer shows the note's group; clicking it opens a picker to move
  // the note to another group, out of its group or into a new one. Rust does
  // the moving (set_note_group) and emits "groups-changed".

  const groups = new GroupPicker({
    frame,
    button: $('footBtn'),
    menu: $('groupMenu'),
    items: $('groupItems'),
    label: $('edited'),
    tint: $('groupTint'),
    current: () => note && note.groupId,
    onPick(groupId) {
      flushText();
      invoke('set_note_group', { groupId }).catch((err) => console.error('set_note_group', err));
    },
    onOpen: () => { colors.close(); hideFormatBar(); },
  });

  // The boards, for the pills of those the note is on (renderMeta).
  let boards = [];

  async function loadGroups() {
    if (EMBED || !note) return;
    try {
      const [list, groupId, boardList] = await Promise.all([
        invoke('list_groups'), invoke('get_note_group'), invoke('list_boards'),
      ]);
      note.groupId = groupId;
      boards = boardList;
      groups.setGroups(list);
    } catch (err) {
      console.error('list_groups', err);
    }
    renderMeta();
  }


  // Titlebar (components/titlebar.js): pin, double-click edits the title,
  // drag with snapping, middle click closes, resize grip in the corner, and
  // the right-click / "…" menu with the note's commands, then all the app's.
  const bar = new TitleBar({
    frame,
    titlebar,
    grip: $('grip'),
    embedded: EMBED,
    pin: {
      get: () => note && note.pinned,
      set: (pinned) => { note.pinned = pinned; render(); },
    },
    rename: {
      name: nameEl,
      input: titleInput,
      get: () => note && note.title,
      onStart: () => colors.close(),
      async save(title) {
        note.title = title;
        renderName();
        try {
          note.title = await invoke('set_title', { title });
        } catch (err) {
          console.error('set_title', err);
        }
      },
      onEnd: () => { renderName(); editor.focus(); },
    },
    buttons: { newBtn: newNote, trashBtn: trashNote, closeBtn: closeNote },
    onClose: closeNote,
    onNew: newNote,
    menuItems: () => (note ? [
      { label: t('format'), items: formatMenuItems() },
      null,
      { label: t('rename'), run: () => bar.startRename() },
      { label: t('pin'), checked: !!note.pinned, run: () => bar.togglePin() },
      { label: t('noteColor'), run: () => colors.open() },
      { label: t('moveToTrash'), run: trashNote },
      { label: t('closeNote'), run: closeNote },
    ] : []),
    onMenuOpen: () => { saveMenuSelection(); colors.close(); groups.close(); hideFormatBar(); },
    // Native context menu only in the text and the title field (copy,
    // paste, spellcheck); elsewhere in the note it makes no sense.
    nativeMenuIn: 'input, #editor',
    onBlur: () => {
      hideFormatBar();
      showTray(false);
      flushText();
    },
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideFormatBar(); showTray(false); }
  });
  window.addEventListener('beforeunload', () => {
    if (textDirty) invoke(EMBED ? 'set_default_content' : 'save_text', { text: note.text, html: note.html });
  });


  // --------------------------------------------------------------- init

  // The colour button's tooltip names the colour, and "mono" is named after
  // the theme (white or black).
  MemoTheme.onChange(() => { if (note) render(); });

  // Language-dependent text that isn't just in the HTML (tooltips with
  // shortcuts, placeholder, spellcheck). Called on load and on language change.
  function applyLanguage(lang) {
    I18n.set(lang);
    editor.lang = I18n.locale();
    editor.dataset.placeholder = EMBED ? t('defaultTextPlaceholder') : I18n.placeholder();
    $('newBtn').title = `${t('newNote')} (${keys('Mod', 'N')})`;
    $('trashBtn').title = t('moveToTrash');
    $('closeBtn').title = t('minimizeNote');
    const bars = [formatBar, formatTray];
    for (const btn of bars.flatMap((bar) => [...bar.querySelectorAll('[data-key]')])) {
      const combo = btn.dataset.shift ? keys('Mod', 'Shift', btn.dataset.key) : keys('Mod', btn.dataset.key);
      btn.title = `${btn.getAttribute('aria-label')} (${combo})`;
    }
    for (const btn of bars.flatMap((bar) => [...bar.querySelectorAll('[data-hint]')])) {
      btn.title = `${btn.getAttribute('aria-label')} (${t('typeHint', { hint: btn.dataset.hint })})`;
    }
    const sizeKeys = {
      2: ` (${t('smaller', { keys: keys('Mod', 'Shift', '<') })})`,
      5: ` (${t('larger', { keys: keys('Mod', 'Shift', '>') })})`,
    };
    for (const btn of bars.flatMap((bar) => [...bar.querySelectorAll('[data-size]')])) {
      btn.title = btn.getAttribute('aria-label') + (sizeKeys[btn.dataset.size] || '');
    }
    MemoTheme.renderMono();
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
    MemoTheme.apply(await invoke('get_theme'));
    TAURI.event.listen('theme-changed', (e) => MemoTheme.apply(e.payload));

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
      TAURI.event.listen('boards-changed', loadGroups);
      await loadGroups();
    }
    if (!EMBED && !new URLSearchParams(location.search).has('nofocus')) {
      editor.focus({ preventScroll: true });
      const r = document.createRange();
      r.selectNodeContents(editor);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  }

  init().catch((err) => console.error('init', err));
})();
