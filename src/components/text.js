// Memo — a note's plain-text format, shared by the editor (app.js) and the
// note previews (card.js in the manager and boards): list lines, ``` code
// blocks and "| a | b |" tables, and how they become the editor's HTML.
// Parameters are never named "t", which is the translation function.

window.MemoText = (() => {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // List line in plain text: indent (2 spaces per level) followed by
  // "[ ]"/"[]"/"[x]" (checklist), "-" (bullet) or "1." (numbered; the
  // number itself is recomputed). "[]" is accepted because it can be typed
  // in the new-note default text.
  const LIST_RE = /^( *)(?:\[([ xX]?)\]|(-)|(\d+)\.)(?= |$) ?/;
  const MAX_LEVEL = 4;
  // The text without list markers.
  const plain = (text) => (text || '').replace(/^(\s*)(?:\[[ xX]?\]|-|\d+\.)(?= |$) ?/gm, '$1');

  // Table rows in plain text: "| a | b |" lines; a "| --- |" line right
  // after the first one makes it a header.
  const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
  const TABLE_SEP_RE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
  // The cells of a "| a | b |" line ("\\|" is a "|" inside a cell).
  const rowCells = (line) => line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

  // HTML for plain text, in the editor's format. `textHtml(s)` turns a run
  // of text outside `code` into HTML (the editor also makes links there).
  function fromPlain(text, textHtml = esc) {
    const inline = (s) => s.split(/(`[^`]+`)/).map((part, i) => (i % 2 ? `<code>${esc(part.slice(1, -1))}</code>` : textHtml(part))).join('');
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
      // Table: a run of "| a | b |" lines.
      if (TABLE_ROW_RE.test(line)) {
        let end = i;
        while (end + 1 < lines.length && TABLE_ROW_RE.test(lines[end + 1])) end++;
        const rows = lines.slice(i, end + 1);
        const head = rows.length > 1 && TABLE_SEP_RE.test(rows[1]);
        if (head) rows.splice(1, 1);
        const cells = rows.map(rowCells);
        const cols = Math.max(...cells.map((r) => r.length));
        const tr = cells.map((r) => `<tr>${Array.from({ length: cols }, (_, c) => `<td>${r[c] ? inline(r[c]) : '<br>'}</td>`).join('')}</tr>`);
        out.push(`<table${head ? ' class="head"' : ''}><tbody>${tr.join('')}</tbody></table>`);
        i = end;
        continue;
      }
      const m = LIST_RE.exec(line);
      if (!m) {
        out.push(`<div>${line ? inline(line) : '<br>'}</div>`);
        continue;
      }
      const body = line.slice(m[0].length);
      const cls = m[3] ? 'bullet' : m[4] ? 'number' : `check${/x/i.test(m[2]) ? ' done' : ''}`;
      const level = Math.min(MAX_LEVEL, Math.floor(m[1].length / 2));
      const lvl = level ? ` data-level="${level}"` : '';
      out.push(`<div class="${cls}"${lvl}>${body ? inline(body) : '<br>'}</div>`);
    }
    return out.join('');
  }

  return { esc, plain, LIST_RE, MAX_LEVEL, TABLE_ROW_RE, TABLE_SEP_RE, rowCells, fromPlain };
})();
