// Memo — a pill that shows where an item is: its group's folder or a
// board's icon in that colour, and the name (manager cards, a note's
// footer). Display only: groups and boards are changed from their own
// controls (footer pickers, dragging). Needs i18n.js and color-menu.js.

window.MemoPill = (() => {
  const ICONS = {
    group: '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.9l1.5 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    board: '<rect x="2" y="2.5" width="3.5" height="11" rx="1" stroke-width="1.3"/><rect x="6.25" y="2.5" width="3.5" height="7.5" rx="1" stroke-width="1.3"/><rect x="10.5" y="2.5" width="3.5" height="9.5" rx="1" stroke-width="1.3"/>',
  };

  // `kind` is "group" or "board"; `item` the group or board.
  function create(kind, item) {
    const { t } = window.MemoI18n;
    const name = item.name || t('untitled');
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.title = t(kind === 'group' ? 'inGroup' : 'onBoard', { name });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[kind];
    window.MemoColor.paint(svg, item.color);
    const label = document.createElement('span');
    label.textContent = name;
    pill.append(svg, label);
    return pill;
  }

  // The boards (not in the trash) holding note `id` in one of their columns.
  const boardsOf = (boards, id) => boards.filter((b) => !b.trashedAt
    && (b.columns || []).some((c) => (c.noteIds || []).includes(id)));

  return { ICONS, create, boardsOf };
})();
