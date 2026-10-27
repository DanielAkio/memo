// Memo — a note's preview on a card (manager cards and board columns): its
// text components (checklists, bullets, numbers, formatting, code blocks,
// tables) as the editor draws them, in a box of limited height (CSS).
// Needs components/text.js.
window.MemoCard = {
  render(note, options = {}) {
    if (!note) return null;
    const { skipFirst = false, className = 'card-preview' } = options;
    const rawHtml = (note.html || '').trim();
    const rawText = (note.text || '').trim();
    if (!rawHtml && !rawText) return null;

    let html = rawHtml;
    if (!html) {
      html = window.MemoText.fromPlain(rawText);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const nodes = Array.from(doc.body.childNodes);

    let start = 0;
    if (skipFirst) {
      for (let i = 0; i < nodes.length; i++) {
        if ((nodes[i].textContent || '').trim()) {
          start = i + 1;
          break;
        }
      }
    }

    const container = document.createElement('div');
    container.className = className;

    let hasVisibleContent = false;
    for (let i = start; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 1) {
        container.appendChild(n.cloneNode(true));
        hasVisibleContent = true;
      } else if (n.nodeType === 3) {
        if (n.textContent && n.textContent.trim()) {
          const div = document.createElement('div');
          div.textContent = n.textContent;
          container.appendChild(div);
          hasVisibleContent = true;
        }
      }
    }

    if (!hasVisibleContent) return null;

    let num = 0;
    for (const child of container.children) {
      if (child.classList && child.classList.contains('number')) {
        num++;
        if (!child.getAttribute('data-n')) {
          child.setAttribute('data-n', String(num));
        }
      } else {
        num = 0;
      }
    }

    return container;
  },
};
