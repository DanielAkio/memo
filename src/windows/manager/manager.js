// Memo — manager window: lists notes and the trash, with search, and holds
// the settings (theme, language, new-note defaults). The window behaves like a
// note (titlebar with pin, new note and close; drag with snapping;
// grip), with no editable title or text. Data comes from Rust (list_notes)
// and the list reloads whenever a note changes ("notes-changed" event).

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const $ = (id) => document.getElementById(id);
  const I18n = window.MemoI18n;
  const { t, keys, isMod } = I18n;
  const frame = $('frame');
  const list = $('list');
  const empty = $('empty');
  const search = $('search');
  const trashBar = $('trashBar');
  const emptyTrashBtn = $('emptyTrash');

  const DAY_MS = 86_400_000;
  const TRASH_DAYS = 30;

  let notes = [];
  let groups = []; // active groups
  let trashedGroups = [];
  let boards = [];
  let trashedBoards = [];
  let view = 'notes';
  // Memories, Groups and Boards each list either the current ones or the trash.
  const scopes = { notes: 'current', groups: 'current', boards: 'current' };
  // The tray's update items open Settings scrolled to the version row.
  let scrollToUpdate = false;
  const inTrash = () => scopes[view] === 'trash';
  let defaultColor = '';
  let reloadTimer = null;
  // State of this window itself (pinned), saved by Rust.
  let win = { pinned: false };
  // Memories and Groups as "cards" or as a "list" (Settings → Appearance).
  let layout = 'cards';

  // ------------------------------------------------------------ helpers

  // Plain text without the list markers ("[ ] " / "[x] " / "- ").
  const { plain } = MemoText;
  // For search: lower case, without accents.
  const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();


  function editedLabel(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const fmt = new Intl.DateTimeFormat(I18n.locale(), d.toDateString() === new Date().toDateString()
      ? { hour: '2-digit', minute: '2-digit' }
      : { day: 'numeric', month: 'short' });
    return fmt.format(d).replace('.', '');
  }

  function purgeLabel(trashedAt) {
    const left = TRASH_DAYS - Math.floor((Date.now() - trashedAt) / DAY_MS);
    if (left <= 1) return t('goneTomorrow');
    return t('goneIn', { n: left });
  }

  function lines(note) {
    return plain(note.text).split('\n').map((s) => s.trim()).filter(Boolean);
  }

  // Title: the note's name, else its first line; the preview is the rest of
  // the text, one line per line (the card shows the first few), or on one
  // line with " · " between them in the list layout.
  function titleAndPreview(note) {
    const ls = lines(note);
    const sep = layout === 'list' ? ' · ' : '\n';
    if (note.title) return { title: note.title, preview: ls.join(sep), named: true };
    return { title: ls[0] || t('emptyNote'), preview: ls.slice(1).join(sep), named: Boolean(ls[0]) };
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function icon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = path;
    return svg;
  }

  // Same folder as a group bar and a note's footer.
  const FOLDER_ICON = MemoPill.ICONS.group;
  const BOARD_ICON = MemoPill.ICONS.board;
  // Trash: an X, the same as the trash button in the titlebars.
  const TRASH_ICON = '<path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/>';

  // ------------------------------------------------------------- render

  // Sort order of both lists: "updated" (most recent first — by edit date, or
  // by trash date in the trash) or "title" (alphabetical, empty memories
  // last). Remembered on this machine.
  let sort = 'updated';
  try {
    if (localStorage.getItem('memo.sort') === 'title') sort = 'title';
  } catch { /* storage unavailable: use the default */ }

  function sortNotes(items, dateKey) {
    const byDate = (a, b) => b[dateKey] - a[dateKey];
    if (sort !== 'title') return items.sort(byDate);
    const collator = new Intl.Collator(I18n.locale(), { sensitivity: 'base', numeric: true });
    return items
      .map((n) => ({ n, ...titleAndPreview(n) }))
      .sort((a, b) => {
        if (a.named !== b.named) return a.named ? -1 : 1;
        return collator.compare(a.title, b.title) || byDate(a.n, b.n);
      })
      .map((k) => k.n);
  }

  // The sort button shows only its icon: the tooltip says the current order.
  function renderSort() {
    const select = $('sortSelect');
    select.value = sort;
    const label = `${t('sortBy')}: ${select.selectedOptions[0].textContent}`;
    select.closest('.sort').title = label;
    select.setAttribute('aria-label', label);
  }

  function render() {
    swapQuery();
    renderSort();
    const active = sortNotes(notes.filter((n) => !n.trashedAt), 'updatedAt');
    const trashed = sortNotes(notes.filter((n) => n.trashedAt), 'trashedAt');
    for (const tab of document.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    }
    // The narrow-window select mirrors the tabs.
    const labels = {
      notes: t('tabNotes'),
      groups: t('tabGroups'),
      boards: t('tabBoards'),
      settings: t('tabSettings'),
      help: t('tabHelp'),
    };
    for (const option of $('viewSelect').options) option.textContent = labels[option.value];
    $('viewSelect').value = view;
    fitTabs();
    const listView = view === 'notes' || view === 'groups' || view === 'boards';
    for (const seg of document.querySelectorAll('#scopeSwitch .seg')) {
      seg.setAttribute('aria-checked', String(listView && seg.dataset.scope === scopes[view]));
    }
    trashBar.hidden = !(listView && inTrash());
    $('trashInfo').textContent = t(view === 'groups' ? 'groupTrashInfo' : view === 'boards' ? 'boardTrashInfo' : 'trashInfo');
    emptyTrashBtn.disabled = (view === 'groups' ? trashedGroups : view === 'boards' ? trashedBoards : trashed).length === 0;
    document.body.classList.toggle('notes-view', listView && !inTrash());

    // Settings and Help tabs: no list, no scope and no sort, but sections.
    const panel = view === 'settings' || view === 'help';
    $('settingsView').hidden = view !== 'settings';
    $('helpView').hidden = view !== 'help';
    $('listWrap').hidden = panel;
    $('scopeSwitch').hidden = panel;
    $('sortSelect').closest('.sort').hidden = panel;
    const placeholder = { settings: 'searchSettings', help: 'searchHelp' }[view] || 'search';
    search.placeholder = t(placeholder);
    search.setAttribute('aria-label', t(panel ? placeholder : 'searchNotes'));
    // The tray's update items show the answer in Settings: open its section.
    const toUpdate = view === 'settings' && scrollToUpdate;
    if (toUpdate) showSection('application');
    renderSections();
    notePane.show(defaultColor);
    if (view === 'settings') fitSettings();
    if (toUpdate) {
      scrollToUpdate = false;
      $('updateStatus').closest('.setting').scrollIntoView({ block: 'center' });
    }
    if (panel) return;

    const q = fold(search.value.trim());
    if (view === 'groups') {
      const source = inTrash() ? trashedGroups : groups;
      const shownGroups = sortGroups(source.filter((g) => !q || fold(g.name || t('untitled')).includes(q)));
      list.replaceChildren(...shownGroups.map((g) => (inTrash() ? groupTrashCard(g, trashed) : groupCard(g, active))));
      empty.hidden = shownGroups.length > 0;
      if (q) empty.textContent = t('nothingFound', { q: search.value.trim() });
      else empty.textContent = t(inTrash() ? 'trashIsEmpty' : 'noGroups');
      return;
    }
    if (view === 'boards') {
      const source = inTrash() ? trashedBoards : boards;
      const shownBoards = source.filter((b) => !q || fold(b.name || t('untitled')).includes(q));
      list.replaceChildren(...shownBoards.map((b) => (inTrash() ? boardTrashCard(b) : boardCard(b))));
      empty.hidden = shownBoards.length > 0;
      if (q) empty.textContent = t('nothingFound', { q: search.value.trim() });
      else empty.textContent = t(inTrash() ? 'trashIsEmpty' : 'noBoards');
      return;
    }
    const source = inTrash() ? trashed : active;
    // The group's and boards' names count for the search too.
    const shown = q
      ? source.filter((n) => fold(`${n.title}\n${plain(n.text)}\n${groupName(n)}\n${boardsOf(n).map((b) => b.name).join('\n')}`).includes(q))
      : source;

    list.replaceChildren(...shown.map(inTrash() ? noteTrashCard : noteCard));
    empty.hidden = shown.length > 0;
    if (q) empty.textContent = t('nothingFound', { q: search.value.trim() });
    else empty.textContent = t(inTrash() ? 'trashIsEmpty' : 'noNotes');
  }

  // A card: a head (colour dot or folder, title), the preview, and a foot with
  // the date (or days left in the trash) and the actions, always visible.
  function card(mark, title, named, preview, meta, actions) {
    const item = el('li', 'card');
    const head = el('div', 'card-head');
    head.append(mark, el('div', `card-title${named ? '' : ' is-empty'}`, title));
    item.append(head);
    if (preview) {
      if (typeof preview === 'string') {
        item.append(el('div', 'card-preview', preview));
      } else {
        item.append(preview);
      }
    }
    const foot = el('div', 'card-foot');
    foot.append(el('span', 'card-meta', meta), actions);
    item.append(foot);
    // The trash X goes to the card's upper right corner (the end of the
    // row in the list layout), out of the actions.
    const x = actions.querySelector(':scope > .card-x');
    if (x) {
      item.append(x);
      item.classList.add('has-x');
    }
    return item;
  }

  function noteBase(note, meta, actions) {
    const dot = el('span', 'card-dot');
    MemoColor.paint(dot, note.color);
    const { title, preview, named } = titleAndPreview(note);
    const prev = layout === 'cards' && window.MemoCard
      ? (window.MemoCard.render(note, { skipFirst: !named, className: 'card-preview' }) || '')
      : preview;
    const item = card(dot, title, named, prev, meta, actions);
    item.dataset.id = note.id;
    return item;
  }

  const groupName = (note) => ([...groups, ...trashedGroups].find((g) => g.id === note.groupId) || {}).name || '';
  // The boards a memory is on (in one of their columns).
  const boardsOf = (note) => MemoPill.boardsOf(boards, note.id);

  // Pills in a card's footer that only show where the item is
  // (components/pill.js, as in a note's footer).
  const groupPill = (groupId) => {
    const group = groups.find((g) => g.id === groupId);
    return group ? [MemoPill.create('group', group)] : [];
  };
  const boardPill = (board) => MemoPill.create('board', board);

  // -------------------------------------------------------- groups tab
  // Groups shown like memories: same search, same sort box, a card per group
  // (folder in its colour, name, how many memories, out or put away), click
  // to bring its bar to the front, and its actions always visible.

  function sortGroups(items) {
    const list = items.slice();
    if (sort === 'title') {
      return list.sort((a, b) => {
        if (Boolean(a.name) !== Boolean(b.name)) return a.name ? -1 : 1; // unnamed last
        return a.name.localeCompare(b.name, I18n.locale(), { sensitivity: 'base', numeric: true });
      });
    }
    return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function groupBase(group, preview, meta, actions) {
    const item = card(groupFolder(group), group.name || t('untitled'), Boolean(group.name), preview, meta, actions);
    item.classList.add('group-card');
    item.dataset.gid = group.id;
    return item;
  }

  function groupCard(group, active) {
    const count = active.filter((n) => n.groupId === group.id).length
                + boards.filter((b) => b.groupId === group.id).length;
    const state = t(group.hidden ? 'stateClosed' : group.open ? 'groupStateOut' : 'groupStateIn');
    const toggle = el('button', `icon-btn out-in${group.open ? ' is-open' : ''}`);
    toggle.type = 'button';
    toggle.dataset.gact = 'toggle';
    const toggleLabel = t(group.open ? 'groupHideHint' : 'groupShowHint');
    toggle.title = toggleLabel;
    toggle.setAttribute('aria-label', toggleLabel);
    toggle.append(icon(OUT_IN_ICON));
    const del = el('button', 'icon-btn trash card-x');
    del.type = 'button';
    del.dataset.gact = 'trash';
    del.title = t('groupToTrash');
    del.setAttribute('aria-label', t('groupToTrash'));
    del.append(icon(TRASH_ICON));
    const actions = el('div', 'card-actions');
    actions.append(toggle, del);
    const item = groupBase(group, state,
      t(count === 1 ? 'groupCountOne' : 'groupCountMany', { n: count }), actions);
    item.classList.toggle('is-closed', Boolean(group.hidden));
    item.title = t('showGroup');
    item.tabIndex = 0;
    return item;
  }

  function groupFolder(group) {
    const folder = icon(FOLDER_ICON);
    folder.classList.add('card-folder', 'group-card-folder');
    MemoColor.paint(folder, group.color);
    return folder;
  }

  function boardIcon(board) {
    const bIcon = icon(BOARD_ICON);
    bIcon.classList.add('card-board-icon');
    MemoColor.paint(bIcon, board.color);
    return bIcon;
  }

  // A group in the trash, as a trashed memory's card: the memories that went
  // with it (they come back when it is restored), days left, restore / delete.
  function groupTrashCard(group, trashed) {
    const count = trashed.filter((n) => n.groupId === group.id && n.trashedAt >= group.trashedAt).length
                + trashedBoards.filter((b) => b.groupId === group.id && b.trashedAt >= group.trashedAt).length;
    const restore = el('button', 'btn', t('restore'));
    restore.type = 'button';
    restore.dataset.gact = 'restore';
    const del = el('button', 'btn danger', t('delete'));
    del.type = 'button';
    del.dataset.gact = 'forever';
    del.title = t('deleteGroupForever');
    const actions = el('div', 'card-actions');
    actions.append(restore, del);
    return groupBase(group, t(count === 1 ? 'groupCountOne' : 'groupCountMany', { n: count }),
      purgeLabel(group.trashedAt), actions);
  }

  function boardCard(board) {
    const title = board.name ? board.name : t('untitled');
    const named = Boolean(board.name);
    const colCount = (board.columns || []).length;
    const memoryCount = (board.columns || []).reduce((acc, col) => acc + (col.noteIds || []).length, 0);
    const count = (n, one, many) => t(n === 1 ? one : many, { n });
    const preview = `${count(colCount, 'columnCountOne', 'columnCountMany')} · ${count(memoryCount, 'groupCountOne', 'groupCountMany')}`;

    const del = el('button', 'icon-btn trash card-x');
    del.type = 'button';
    del.title = t('moveToTrash');
    del.setAttribute('aria-label', t('moveToTrash'));
    del.append(icon(TRASH_ICON));
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      invoke('trash_board_id', { id: board.id }).catch((err) => console.error(err));
    });

    const actions = el('div', 'card-actions');
    actions.append(...groupPill(board.groupId), del);

    const item = card(boardIcon(board), title, named, preview, editedLabel(board.updatedAt), actions);
    item.classList.add('board-card');
    item.dataset.bid = board.id;
    item.classList.toggle('is-closed', Boolean(board.hidden));
    item.tabIndex = 0;
    return item;
  }

  function boardTrashCard(board) {
    const title = board.name ? board.name : t('untitled');
    const named = Boolean(board.name);

    const restore = el('button', 'btn', t('restore'));
    restore.type = 'button';
    restore.addEventListener('click', (e) => {
      e.stopPropagation();
      invoke('restore_board_id', { id: board.id }).catch((err) => console.error(err));
    });

    const del = el('button', 'btn danger', t('delete'));
    del.type = 'button';
    del.title = t('deleteBoardForever');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      invoke('delete_board_forever', { id: board.id }).catch((err) => console.error(err));
    });

    const actions = el('div', 'card-actions');
    actions.append(restore, del);

    const item = card(boardIcon(board), title, named, '', purgeLabel(board.trashedAt), actions);
    item.classList.add('board-card');
    item.dataset.bid = board.id;
    return item;
  }

  const OUT_IN_ICON = '<path d="M4.5 9.75 8 6.25l3.5 3.5"/>';

  async function groupAct(btn, id) {
    try {
      const action = btn.dataset.gact;
      if (action === 'toggle') await invoke('toggle_group_id', { id });
      else if (action === 'trash') await invoke('trash_group_id', { id });
      else if (action === 'restore') await invoke('restore_group', { id });
      else if (action === 'forever') await invoke('delete_group_forever', { id });
    } catch (err) {
      console.error(btn.dataset.gact, err);
    }
  }

  const showGroup = (id) => invoke('focus_group', { id }).catch((err) => console.error('focus_group', err));

  function noteCard(note) {
    const trashBtn = el('button', 'icon-btn trash card-x');
    trashBtn.type = 'button';
    trashBtn.dataset.act = 'trash';
    trashBtn.title = t('moveToTrash');
    trashBtn.setAttribute('aria-label', t('moveToTrash'));
    trashBtn.append(icon(TRASH_ICON));
    const actions = el('div', 'card-actions');
    // The group and the boards it is on, as pills (only those it has); the
    // trash X goes to the card's corner (card()).
    actions.append(...groupPill(note.groupId), ...boardsOf(note).map(boardPill), trashBtn);
    const item = noteBase(note, editedLabel(note.updatedAt), actions);
    // Closed with ✕: dimmed, a click reopens it.
    item.classList.toggle('is-closed', Boolean(note.hidden));
    item.title = t('openNote');
    item.tabIndex = 0;
    return item;
  }

  function noteTrashCard(note) {
    const restore = el('button', 'btn', t('restore'));
    restore.type = 'button';
    restore.dataset.act = 'restore';
    const del = el('button', 'btn danger', t('delete'));
    del.type = 'button';
    del.dataset.act = 'delete';
    const actions = el('div', 'card-actions');
    actions.append(restore, del);
    return noteBase(note, purgeLabel(note.trashedAt), actions);
  }

  // ----------------------------------------------------------------- data

  async function load() {
    try {
      let all, allB;
      [notes, defaultColor, all, allB] = await Promise.all([
        invoke('list_notes'), invoke('get_default_color'), invoke('list_groups'), invoke('list_boards'),
      ]);
      groups = all.filter((g) => !g.trashedAt);
      trashedGroups = all.filter((g) => g.trashedAt);
      boards = (allB || []).filter((b) => !b.trashedAt);
      trashedBoards = (allB || []).filter((b) => b.trashedAt);
    } catch (err) {
      console.error('list_notes', err);
    }
    render();
  }

  // ----------------------------------------------------------- defaults
  // Settings → Defaults: what new memories, groups and boards start with,
  // one pane each with the same rows (colour, title, then their own). The
  // memory's text is the note editor itself, embedded in an <iframe>
  // (index.html?defaults), which loads and saves on its own.

  // A pane's colour swatches and title field: the colour shows at once and
  // is saved; the title shortly after typing stops, and when leaving it.
  function defaultsPane({ swatches, input, title, setColor, setTitle, onColor }) {
    const custom = swatches.querySelector('.swatch[data-color="custom"]');
    const pane = {
      color: '',
      show(color) {
        pane.color = color;
        MemoColor.mark(swatches, color);
      },
    };
    const pick = (color) => {
      pane.show(color);
      if (onColor) onColor(color);
      invoke(setColor, { color }).catch((err) => console.error(setColor, err));
    };
    swatches.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      if (sw === custom) {
        input.value = MemoColor.isCustom(pane.color) ? pane.color : '#f2c94c';
        MemoColorPicker.open(input, sw);
        return;
      }
      pick(sw.dataset.color);
    });
    input.addEventListener('change', () => pick(input.value.toLowerCase()));
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      invoke(setTitle, { title: title.value }).catch((err) => console.error(setTitle, err));
    };
    title.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(flush, 400);
    });
    title.addEventListener('change', flush);
    return pane;
  }

  // Memories: no colour by default (the colour comes with list_notes).
  const notePane = defaultsPane({
    swatches: $('defaultSwatches'),
    input: $('customColor'),
    title: $('defaultTitle'),
    setColor: 'set_default_color',
    setTitle: 'set_default_title',
    onColor: (color) => { defaultColor = color; },
  });
  // Groups: a random label for each by default.
  const groupPane = defaultsPane({
    swatches: $('groupSwatches'),
    input: $('groupCustomColor'),
    title: $('groupDefaultTitle'),
    setColor: 'set_default_group_color',
    setTitle: 'set_default_group_title',
  });
  // Boards: no colour by default, and their columns.
  const boardPane = defaultsPane({
    swatches: $('boardSwatches'),
    input: $('boardCustomColor'),
    title: $('boardDefaultTitle'),
    setColor: 'set_default_board_color',
    setTitle: 'set_default_board_title',
  });

  async function loadDefaults() {
    try {
      let groupColor, boardColor;
      [[$('defaultTitle').value], [groupColor, $('groupDefaultTitle').value], [boardColor, $('boardDefaultTitle').value, defColumns.list]] =
        await Promise.all([invoke('get_new_note_defaults'), invoke('get_group_defaults'), invoke('get_board_defaults')]);
      groupPane.show(groupColor);
      boardPane.show(boardColor);
    } catch (err) {
      console.error('defaults', err);
    }
    renderDefColumns();
  }

  // The columns new boards start with: `list` null = the language's own
  // (To Do, In Progress, Done), shown as such until one is changed; then
  // Restore goes back to them.
  const defColumns = { list: null };
  const langColumns = () => (I18n.lang === 'en'
    ? ['To Do', 'In Progress', 'Done']
    : ['A Fazer', 'Em Andamento', 'Concluído']).map((name) => ({ name, color: '' }));
  const columnsNow = () => defColumns.list || langColumns();
  let columnsTimer = null;

  function saveDefColumns(list) {
    defColumns.list = list;
    clearTimeout(columnsTimer);
    columnsTimer = setTimeout(() => {
      invoke('set_default_board_columns', { columns: defColumns.list })
        .catch((err) => console.error('set_default_board_columns', err));
    }, list ? 300 : 0);
  }

  function renderDefColumns() {
    const ol = $('boardDefaultColumns');
    const cols = columnsNow();
    ol.replaceChildren(...cols.map((col, i) => {
      const li = el('li', 'def-column');
      li.dataset.index = i;
      const dot = el('button', 'col-dot card-dot');
      dot.type = 'button';
      dot.dataset.act = 'color';
      MemoColor.paint(dot, col.color);
      dot.setAttribute('aria-label', t('columnColor'));
      const name = el('input', 'field');
      name.type = 'text';
      name.maxLength = 60;
      name.spellcheck = false;
      name.value = col.name;
      name.placeholder = t('untitled');
      name.dataset.act = 'name';
      const btn = (act, text, label, off) => {
        const b = el('button', 'btn', text);
        b.type = 'button';
        b.dataset.act = act;
        b.disabled = off;
        b.setAttribute('aria-label', t(label));
        b.title = t(label);
        return b;
      };
      li.append(dot, name, btn('up', '↑', 'moveUp', i === 0), btn('down', '↓', 'moveDown', i === cols.length - 1),
        btn('remove', '✕', 'delete', false));
      return li;
    }));
    $('restoreDefaultColumns').hidden = !defColumns.list;
  }

  $('boardDefaultColumns').addEventListener('input', (e) => {
    const li = e.target.closest('.def-column');
    if (!li || e.target.dataset.act !== 'name') return;
    const list = columnsNow().map((c) => ({ ...c }));
    list[li.dataset.index].name = e.target.value;
    saveDefColumns(list);
    $('restoreDefaultColumns').hidden = false;
  });
  $('boardDefaultColumns').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const li = e.target.closest('.def-column');
    if (!btn || !li) return;
    const i = Number(li.dataset.index);
    const list = columnsNow().map((c) => ({ ...c }));
    const act = btn.dataset.act;
    if (act === 'color') {
      openDefColumnColor(i, btn);
      return;
    }
    if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else if (act === 'remove') list.splice(i, 1);
    else return;
    saveDefColumns(list);
    renderDefColumns();
  });
  $('addDefaultColumn').addEventListener('click', () => {
    // A new column starts unnamed, like one added on a board.
    saveDefColumns([...columnsNow().map((c) => ({ ...c })), { name: '', color: '' }]);
    renderDefColumns();
    const names = $('boardDefaultColumns').querySelectorAll('input');
    names[names.length - 1].focus();
  });
  $('restoreDefaultColumns').addEventListener('click', () => {
    saveDefColumns(null);
    renderDefColumns();
  });

  // A default column's colour: the same swatches as a board column's.
  let colorColumn = -1;
  const defColumnColors = new ColorMenu({
    frame,
    menu: $('defColumnMenu'),
    input: $('defColumnCustomColor'),
    current: () => (colorColumn < 0 ? null : columnsNow()[colorColumn].color),
    onPick: (color) => {
      const list = columnsNow().map((c) => ({ ...c }));
      list[colorColumn].color = color;
      saveDefColumns(list);
      renderDefColumns();
    },
    save: () => {},
  });

  function openDefColumnColor(i, dot) {
    if (defColumnColors.isOpen && colorColumn === i) {
      defColumnColors.close();
      return;
    }
    colorColumn = i;
    defColumnColors.render(columnsNow()[i].color);
    const menu = $('defColumnMenu');
    const f = frame.getBoundingClientRect();
    const r = dot.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom - f.top + 6)}px`;
    menu.style.left = `${Math.max(6, Math.round(r.left - f.left - 6))}px`;
    defColumnColors.open(dot);
  }

  // Memória · Grupo · Quadro: one pane at a time (the last one chosen is
  // remembered here); a search shows the rows that match in all of them.
  let defPane = 'note';
  try {
    defPane = localStorage.getItem('memo.defaultsPane') || 'note';
  } catch {}

  function renderDefPanes() {
    const searching = Boolean(search.value.trim());
    for (const pane of document.querySelectorAll('.def-pane')) {
      pane.hidden = !searching && pane.dataset.pane !== defPane;
    }
    $('defaultsSwitch').hidden = searching;
    for (const seg of $('defaultsSwitch').querySelectorAll('.seg')) {
      seg.setAttribute('aria-checked', String(seg.dataset.pane === defPane));
    }
  }

  $('defaultsSwitch').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    defPane = seg.dataset.pane;
    try {
      localStorage.setItem('memo.defaultsPane', defPane);
    } catch {}
    renderDefPanes();
    fitSettings();
  });

  // Several changes in a row (typing in a note) become a single reload.
  function scheduleLoad() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
  }

  // "Empty trash" and "Quit" require a second click within 3 s
  // (components/confirm.js).
  const confirmFirst = (btn, label) => MemoConfirm.ask(btn, label);

  async function act(action, id) {
    try {
      if (action === 'open') await invoke('open_note', { id });
      else if (action === 'trash') await invoke('move_to_trash', { id });
      else if (action === 'restore') await invoke('restore_note', { id });
      else if (action === 'delete') await invoke('delete_forever', { id });
    } catch (err) {
      console.error(action, err);
    }
  }

  // -------------------------------------------------------------- theme

  function applyTheme(theme) {
    MemoTheme.apply(theme);
    for (const seg of document.querySelectorAll('#themeSwitch .seg')) {
      seg.setAttribute('aria-checked', String(seg.dataset.theme === (theme || 'system')));
    }
  }

  // -------------------------------------------------------------- events

  // Settings: labels stay left of their controls unless one control can't
  // fit beside its label (it wraps below); then every row stacks (.stacked).
  const settingsView = $('settingsView');
  function fitSettings() {
    if (settingsView.hidden) return;
    settingsView.classList.remove('stacked');
    // Label column: the widest label's natural width (labels don't wrap).
    const widest = Math.max(...[...settingsView.querySelectorAll('.setting-label')].map((label) => {
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getBoundingClientRect().width;
    }));
    settingsView.style.setProperty('--label-w', `${Math.ceil(widest) + 2}px`);
    const tight = [...settingsView.querySelectorAll('.setting')].some((row) => {
      const label = row.querySelector('.setting-label');
      const control = label && label.nextElementSibling;
      return Boolean(control) && control.offsetTop > label.offsetTop + 4;
    });
    settingsView.classList.toggle('stacked', tight);
  }
  new ResizeObserver(fitSettings).observe(settingsView);

  // ------------------------------------------- sections (Settings, Help)
  // Both tabs are split in sections (.sec, each starting with its
  // .settings-title), opened and closed by a click on the title; the first
  // one starts open. A search shows every setting or Help topic that
  // matches, from all of them, with their sections open.

  const panels = { settings: settingsView, help: $('helpView') };
  // The open sections of each tab, by data-sec (kept when Sync comes and goes).
  const openSecs = { settings: new Set(), help: new Set() };
  // Memories and Groups share one search; Settings and Help keep their own.
  const queries = { list: '', settings: '', help: '' };
  let queryKey = 'list';

  function swapQuery() {
    const key = panels[view] ? view : 'list';
    if (key === queryKey) return;
    queries[queryKey] = search.value;
    queryKey = key;
    search.value = queries[key];
  }

  // The sections a tab offers now (Sync only in builds that have it).
  const sectionsOf = (panel) => [...panel.querySelectorAll('.sec')].filter((sec) => !sec.hidden);
  const secTitle = (sec) => sec.querySelector('.sec-toggle').textContent.trim();

  // The title's text (its first span) goes in a button that opens and closes
  // the section; a click anywhere on the title row but its "i" does too.
  function makeToggle(sec, tab) {
    const title = sec.querySelector('.settings-title');
    const button = el('button', 'sec-toggle');
    button.type = 'button';
    button.append(title.firstElementChild);
    title.prepend(button);
    title.addEventListener('click', (e) => {
      if (e.target.closest('.info') || search.value.trim()) return;
      const open = openSecs[tab];
      if (!open.delete(sec.dataset.sec)) open.add(sec.dataset.sec);
      renderSections();
      if (tab === 'settings') fitSettings();
    });
  }
  for (const sec of settingsView.querySelectorAll('.sec')) makeToggle(sec, 'settings');

  function showSection(name) {
    search.value = '';
    openSecs.settings.add(name);
  }

  function renderSections() {
    const panel = panels[view];
    if (!panel) return;
    const q = fold(search.value.trim());
    renderDefPanes();
    // The Help intro and welcome button only above the sections, not results.
    $('helpView').querySelector('.help-top').hidden = Boolean(q);
    let found = 0;
    for (const sec of sectionsOf(panel)) {
      // A section whose title matches shows whole; otherwise only the
      // settings (or Help topics, with their text) that match.
      const whole = !q || fold(secTitle(sec)).includes(q);
      let hits = 0;
      for (const unit of sec.querySelectorAll('.setting, dt')) {
        const hit = whole || fold(unit.dataset.find || unit.textContent).includes(q);
        unit.classList.toggle('is-off', !hit);
        if (unit.tagName === 'DT') unit.nextElementSibling.classList.toggle('is-off', !hit);
        if (hit && !unit.hidden) hits++;
      }
      const shown = !q || hits > 0;
      const open = q ? shown : openSecs[view].has(sec.dataset.sec);
      sec.classList.toggle('is-off', !shown);
      sec.classList.toggle('is-open', open);
      sec.querySelector('.sec-toggle').setAttribute('aria-expanded', String(open));
      if (shown) found++;
    }
    const empty = panel.querySelector('.sec-empty');
    empty.hidden = found > 0;
    if (!found) empty.textContent = t('nothingFound', { q: search.value.trim() });
  }

  // Tabs or select: show the tabs, and fall back to the select only if a tab
  // can't fit its label. Re-measured on resize (window, zoom), language and
  // count changes.
  const mgrHead = document.querySelector('.mgr-head');
  function fitTabs() {
    mgrHead.classList.remove('compact');
    const tight = [...document.querySelectorAll('.tab')].some((tab) => tab.scrollWidth > tab.clientWidth + 1);
    mgrHead.classList.toggle('compact', tight);
  }
  new ResizeObserver(fitTabs).observe(mgrHead);

  $('viewSelect').addEventListener('change', (e) => {
    view = e.target.value;
    render();
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      view = tab.dataset.view;
      render();
    });
  }

  $('scopeSwitch').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg || !(view in scopes)) return;
    scopes[view] = seg.dataset.scope;
    render();
  });

  search.addEventListener('input', render);

  $('sortSelect').addEventListener('change', (e) => {
    sort = e.target.value;
    try {
      localStorage.setItem('memo.sort', sort);
    } catch { /* not remembered, still applied */ }
    render();
  });
  renderSort();

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.card');
    if (item && item.dataset.gid) {
      const btn = e.target.closest('[data-gact]');
      if (btn) groupAct(btn, item.dataset.gid);
      else if (!inTrash()) showGroup(item.dataset.gid);
      return;
    }
    if (item && item.dataset.bid) {
      if (!inTrash()) invoke('open_board', { id: item.dataset.bid }).catch((err) => console.error(err));
      return;
    }
    if (!item) return;
    const btn = e.target.closest('[data-act]');
    if (btn) act(btn.dataset.act, item.dataset.id);
    else if (!inTrash()) act('open', item.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const item = e.target.closest('.card');
    if (!item || e.target !== item || e.key !== 'Enter' || inTrash()) return;
    if (view === 'groups') showGroup(item.dataset.gid);
    else if (view === 'boards') invoke('open_board', { id: item.dataset.bid }).catch((err) => console.error(err));
    else act('open', item.dataset.id);
  });
  // Middle click (wheel button) on a memory or group moves it to the trash
  // or deletes it forever if already in the trash, like its trash/delete button.
  // Same in the list and in cards.
  list.addEventListener('mousedown', (e) => {
    if (e.button === 1 && e.target.closest('.card')) e.preventDefault(); // no autoscroll
  });
  list.addEventListener('auxclick', (e) => {
    const item = e.target.closest('.card');
    if (e.button !== 1 || !item) return;
    e.preventDefault();
    if (item.dataset.gid) {
      const command = inTrash() ? 'delete_group_forever' : 'trash_group_id';
      invoke(command, { id: item.dataset.gid }).catch((err) => console.error(command, err));
    } else if (item.dataset.bid) {
      const command = inTrash() ? 'delete_board_forever' : 'trash_board_id';
      invoke(command, { id: item.dataset.bid }).catch((err) => console.error(command, err));
    } else {
      act(inTrash() ? 'delete' : 'trash', item.dataset.id);
    }
  });

  emptyTrashBtn.addEventListener('click', async () => {
    if (!confirmFirst(emptyTrashBtn, t('emptyTrashConfirm'))) return;
    const command = { groups: 'empty_group_trash', boards: 'empty_board_trash' }[view] || 'empty_trash';
    try {
      await invoke(command);
    } catch (err) {
      console.error(command, err);
    }
  });

  $('helpBtn').addEventListener('click', () => {
    invoke('show_welcome').catch((err) => console.error('show_welcome', err));
  });
  // Quit closes the whole app (every note); requires a second click.
  $('quitBtn').addEventListener('click', () => {
    if (!confirmFirst($('quitBtn'), t('quitConfirm'))) return;
    invoke('quit_app').catch((err) => console.error('quit_app', err));
  });

  // Layout of the Memories and Groups tabs: cards (the default) or a list,
  // one row per item. Same items either way; `.as-list` restyles the cards.
  function applyLayout(value, redraw = true) {
    layout = value === 'list' ? 'list' : 'cards';
    list.classList.toggle('as-list', layout === 'list');
    for (const seg of document.querySelectorAll('#layoutSwitch .seg')) {
      seg.setAttribute('aria-checked', String(seg.dataset.layout === layout));
    }
    if (redraw) render();
  }
  $('layoutSwitch').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg || seg.dataset.layout === layout) return;
    applyLayout(seg.dataset.layout);
    invoke('set_manager_layout', { layout }).catch((err) => console.error('set_manager_layout', err));
  });

  // Theme: applies to every window; Rust notifies them all with "theme-changed".
  $('themeSwitch').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    applyTheme(seg.dataset.theme);
    invoke('change_theme', { theme: seg.dataset.theme }).catch((err) => console.error('change_theme', err));
  });

  document.addEventListener('keydown', (e) => {
    if (isMod(e) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus({ preventScroll: true });
      search.select();
    } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = '';
      render();
    }
  });

  // ------------------------------------------- window (like a note)

  function renderWindow() {
    // Colour: stripe and manager icon, as in a note or group.
    MemoColor.paint(frame, win.color);
    colors.render(win.color);
    bar.renderPin(win.pinned);
  }

  // ------------------------------------------------- window colour picker

  const colors = new ColorMenu({
    frame,
    button: $('mgrColorBtn'),
    menu: $('mgrColorMenu'),
    input: $('mgrCustomColor'),
    current: () => win.color,
    onPick: (color) => { win.color = color; renderWindow(); },
  });


  function isMobileWeb() {
    const host = (window.top && window.top.MemoWeb) || (window.opener && window.opener.MemoWeb);
    if (!host) return false;
    if (typeof host.isMobile === 'function') return host.isMobile();
    return window.innerWidth < 680;
  }

  function syncMobileState() {
    const mobile = isMobileWeb();
    document.documentElement.classList.toggle('is-mobile', mobile);
    $('closeBtn').hidden = mobile;
  }

  const newNote = () => invoke('new_note').catch((err) => console.error('new_note', err));

  // Titlebar (components/titlebar.js), as in a note: pin, drag, resize,
  // middle click closes, and the right-click / "…" menu with the manager's
  // commands, then all the app's. No rename: its title is fixed.
  const bar = new TitleBar({
    frame,
    titlebar: $('titlebar'),
    grip: $('grip'),
    pin: {
      get: () => win.pinned,
      set: (pinned) => { win.pinned = pinned; renderWindow(); },
    },
    buttons: {
      newBtn: newNote,
      newGroupBtn: () => invoke('new_group').catch((err) => console.error('new_group', err)),
      newBoardBtn: () => invoke('new_board').catch((err) => console.error('new_board', err)),
    },
    // In Memo Web on a phone the manager is the main view: it never closes.
    beforeLeave: () => !isMobileWeb(),
    onNew: newNote,
    menuItems: () => [
      { label: t('pin'), checked: !!win.pinned, run: () => bar.togglePin() },
      { label: t('managerColor'), run: () => colors.open() },
      { label: t('bringAllToFront'), run: () => invoke('bring_notes_to_front').catch((err) => console.error('bring_notes_to_front', err)) },
    ],
    onMenuOpen: () => colors.close(),
    // Native context menu only in text fields.
    nativeMenuIn: 'input, textarea',
  });
  document.querySelector('.mgr-head').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    invoke('new_board').catch((err) => console.error('new_board', err));
  });
  syncMobileState();
  window.addEventListener('resize', syncMobileState);
  window.addEventListener('memo-mobile-changed', syncMobileState);


  // --------------------------------------------------------- data folder
  // The folder picker and the "folder already has notes" question are native
  // dialogs opened by Rust; here we only show the current folder.

  async function loadDataDir() {
    try {
      const [dir, isDefault] = await invoke('get_data_dir');
      $('dataDir').textContent = dir;
      $('resetDirBtn').hidden = isDefault;
    } catch (err) {
      console.error('get_data_dir', err);
    }
  }

  async function changeDataDir(cmd) {
    try {
      if (await invoke(cmd)) await loadDataDir();
    } catch (err) {
      console.error(cmd, err);
    }
  }

  $('chooseDirBtn').addEventListener('click', () => changeDataDir('choose_data_dir'));
  $('resetDirBtn').addEventListener('click', () => changeDataDir('reset_data_dir'));

  // ---------------------------------------------------------- backup
  // Save/open dialogs and error messages are native (Rust); the outcome is
  // shown here, under the buttons, for a few seconds.

  let statusTimer = null;
  function showStatus(message) {
    const status = $('storageStatus');
    status.textContent = message;
    status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; }, 6000);
  }

  // Suggested file name with the local date: memo-2026-10-17.json.
  function exportFileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `memo-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  }

  $('exportBtn').addEventListener('click', async () => {
    try {
      if (await invoke('export_notes', { fileName: exportFileName() })) showStatus(t('exported'));
    } catch (err) {
      console.error('export_notes', err);
    }
  });

  $('importBtn').addEventListener('click', async () => {
    try {
      const n = await invoke('import_notes');
      if (n === null) return;
      showStatus(n === 0 ? t('importedNone') : t(n === 1 ? 'importedOne' : 'importedMany', { n }));
    } catch (err) {
      console.error('import_notes', err);
    }
  });

  // ------------------------------------------------------------- cloud
  // Cloud accounts for sync (cloud.rs): Google Drive, OneDrive or both,
  // one row each. The section only shows in builds with an OAuth client;
  // each row only with its own. Errors come back as short codes.

  const cloud = { providers: [], accounts: [], waiting: '', errors: {} };
  const cloudRows = [...document.querySelectorAll('[data-cloud-row]')];
  const CLOUD_ERRORS = {
    denied: 'cloudErrDenied',
    timeout: 'cloudErrTimeout',
    network: 'cloudErrNetwork',
    keyring: 'cloudErrKeyring',
  };
  const accountOf = (p) => cloud.accounts.find((a) => a.provider === p);

  // One line per cloud: who is connected, then how syncing goes.
  function cloudStatusText(p) {
    if (cloud.waiting === p) return t('cloudWaiting');
    if (cloud.errors[p]) return t(CLOUD_ERRORS[cloud.errors[p]] || 'cloudErrOther');
    const account = accountOf(p);
    if (!account) return t(cloud.accounts.length ? 'cloudNotConnected' : 'cloudOff');
    const st = account.status || {};
    if (st.error === 'reauth') return t('cloudErrReauth');
    const parts = [t('cloudOn', { email: account.email })];
    if (st.syncing) parts.push(t('cloudSyncing'));
    else if (st.error) parts.push(t('cloudOffline'));
    else if (st.lastSync) parts.push(t('cloudSynced', { time: editedLabel(st.lastSync) }));
    if (st.pending && !st.syncing) parts.push(st.pending === 1 ? t('cloudPendingOne') : t('cloudPending', { n: st.pending }));
    return parts.join(' ');
  }

  function renderCloud() {
    document.querySelectorAll('[data-cloud]').forEach((el) => { el.hidden = !cloud.providers.length; });
    if (panels[view]) renderSections(); // the Sync section comes and goes with it
    for (const row of cloudRows) {
      const p = row.dataset.cloudRow;
      const account = accountOf(p);
      const st = (account && account.status) || {};
      const reauth = st.error === 'reauth';
      const waiting = cloud.waiting === p;
      const btn = (act) => row.querySelector(`[data-cloud-act="${act}"]`);
      row.hidden = !cloud.providers.includes(p);
      // One sign-in at a time: the other row's Connect waits.
      btn('connect').hidden = (!!account && !reauth) || waiting;
      btn('connect').disabled = !!cloud.waiting;
      btn('cancel').hidden = !waiting;
      btn('sync').hidden = !account || reauth || waiting;
      btn('sync').disabled = !!st.syncing;
      btn('disconnect').hidden = !account || waiting;
      row.querySelector('[data-cloud-status]').textContent = cloudStatusText(p);
    }
  }

  async function loadCloud() {
    try {
      [cloud.providers, cloud.accounts] = await invoke('get_cloud_account');
    } catch (err) {
      console.error('get_cloud_account', err);
    }
    renderCloud();
  }

  async function cloudAct(p, act) {
    if (act === 'connect') {
      cloud.waiting = p;
      cloud.errors[p] = null;
      renderCloud();
      try {
        await invoke('connect_cloud', { provider: p });
      } catch (err) {
        if (err !== 'cancelled' && err !== 'busy') cloud.errors[p] = err;
        console.error('connect_cloud', err);
      }
      cloud.waiting = '';
    } else if (act === 'cancel') {
      invoke('cancel_cloud_connect').catch((err) => console.error('cancel_cloud_connect', err));
      return;
    } else if (act === 'sync') {
      invoke('sync_cloud').catch((err) => console.error('sync_cloud', err));
      return;
    } else if (act === 'disconnect') {
      cloud.errors[p] = null;
      try {
        await invoke('disconnect_cloud', { provider: p });
      } catch (err) {
        console.error('disconnect_cloud', err);
      }
    }
    await loadCloud();
  }

  for (const row of cloudRows) {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cloud-act]');
      if (btn) cloudAct(row.dataset.cloudRow, btn.dataset.cloudAct);
    });
  }

  // ---------------------------------------------------------------- help
  // Each group is a title and [topic, how, demo?] items. In "how", {{…}}
  // marks a key or something to type, shown as <kbd>; "Mod"/"Shift" inside it
  // become ⌘/⇧ on macOS and Ctrl/Shift elsewhere (keys()). "demo" is a static
  // example from i18n.js, drawn like the real thing (see demoBox).

  // Titlebar icons for <i data-icon="…"> in the demos (same paths as the
  // windows' buttons).
  const PIN_SVG = '<g transform="translate(-.4 .4) rotate(45 8 8)"><path class="pin-needle" d="M8 11.1v4.4"/>'
    + '<path class="pin-body" d="M5.45 8.35V2.4a1.5 1.5 0 0 1 1.5-1.5h2.1a1.5 1.5 0 0 1 1.5 1.5v5.95h1.55a1.35 1.35 0 0 1 0 2.7H3.9a1.35 1.35 0 0 1 0-2.7z"/></g>';
  const DEMO_ICONS = {
    pin: PIN_SVG,
    'pin-on': PIN_SVG,
    plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
    share: '<path d="M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 0 0-3.54-3.54l-.75.75"/><path d="M9.25 6.75a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 0 0 3.54 3.54l.75-.75"/>',
    manager: '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2"/><path d="M5.25 6h5.5M5.25 8.25h5.5M5.25 10.5h3.25"/>',
    toggle: '<path d="M4.5 9.75 8 6.25l3.5 3.5"/>',
    'folder-plus': '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.9l1.5 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M8 7.25v3.5M6.25 9h3.5"/>',
    folder: '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.9l1.5 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    board: BOARD_ICON,
    more: '<path class="dots" d="M3.75 8h0M8 8h0M12.25 8h0"/>',
    close: '<path d="M3.5 8h9"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/>',
    sort: '<path d="M5 3v10M2.75 10.75 5 13l2.25-2.25M11 13V3M8.75 5.25 11 3l2.25 2.25"/>',
    trash: TRASH_ICON,
  };

  function helpText(text) {
    const out = document.createDocumentFragment();
    text.split(/\{\{(.+?)\}\}/).forEach((part, i) => {
      if (!part) return;
      if (i % 2) out.append(el('kbd', '', keys(...part.split(/(?<=.)\+(?=.)/))));
      else out.append(part);
    });
    return out;
  }

  // The demo HTML is a constant from i18n.js (never user content). Icons are
  // filled in here, and code blocks are highlighted like in a note.
  function demoBox(html) {
    const box = el('div', 'help-demo');
    box.setAttribute('aria-hidden', 'true');
    box.innerHTML = html;
    for (const slot of box.querySelectorAll('i[data-icon]')) {
      const name = slot.dataset.icon;
      const btn = el('span', `icon-btn${name.startsWith('pin') ? ' pin' : ''} ${slot.className}`.trim());
      if (name === 'pin-on') btn.setAttribute('aria-pressed', 'true');
      btn.append(icon(DEMO_ICONS[name] || ''));
      slot.replaceWith(btn);
    }
    for (const pre of box.querySelectorAll('pre[data-lang]')) {
      const grammar = window.Prism && window.Prism.languages[pre.dataset.lang];
      if (grammar) pre.innerHTML = window.Prism.highlight(pre.textContent, grammar, pre.dataset.lang);
    }
    return box;
  }

  function renderHelp() {
    const groups = I18n.help().map(({ title, items }, i) => {
      const list = el('dl', 'help-list');
      for (const [topic, how, demo] of items) {
        const dt = el('dt', '', topic);
        // What the search looks at: the topic and its text, not the demo.
        dt.dataset.find = fold(`${topic} ${how.replace(/[{}]/g, '')}`);
        const dd = el('dd');
        dd.append(helpText(how));
        if (demo) dd.append(demoBox(demo));
        list.append(dt, dd);
      }
      const sec = el('div', 'sec');
      sec.dataset.sec = String(i);
      const heading = el('h2', 'settings-title');
      heading.append(el('span', '', title));
      sec.append(heading, list);
      makeToggle(sec, 'help');
      return sec;
    });
    $('helpGroups').replaceChildren(...groups);
  }

  // ------------------------------------------------------------ language

  function applyLanguage(setting, lang) {
    I18n.set(lang);
    document.title = t('manager');
    $('newBtn').title = `${t('newNote')} (${keys('Mod', 'N')})`;
    $('languageSelect').value = setting;
    renderWindow();
    MemoTheme.renderMono();
    renderHelp();
    renderCloud();
    renderUpdate();
    renderAi(aiSwitch.getAttribute('aria-checked') === 'true');
    renderDefColumns();
    render();
  }

  let languageSetting = 'system';
  $('languageSelect').addEventListener('change', (e) => {
    languageSetting = e.target.value;
    invoke('change_language', { language: languageSetting })
      .catch((err) => console.error('change_language', err));
  });

  // --------------------------------------------------------------- init

  // -------------------------------------------------------------- zoom
  // Global zoom of every window, also changed by Mod +/−, Mod 0 and Mod +
  // wheel anywhere (MemoZoom in chrome.js); Rust emits "zoom-changed".

  function renderZoom(zoom) {
    const pct = Math.round(zoom * 100);
    $('zoomValue').textContent = `${pct}%`;
    $('zoomReset').hidden = pct === 100;
    $('zoomOut').title = `${t('zoomOut')} (${keys('Mod', '-')})`;
    $('zoomIn').title = `${t('zoomIn')} (${keys('Mod', '+')})`;
    $('zoomReset').title = `${t('zoomReset')} (${keys('Mod', '0')})`;
  }

  const stepZoom = (n) => invoke('change_zoom', { step: n }).catch((err) => console.error('change_zoom', err));
  $('zoomOut').addEventListener('click', () => stepZoom(-1));
  $('zoomIn').addEventListener('click', () => stepZoom(1));
  $('zoomReset').addEventListener('click', () => stepZoom(0));
  window.MemoZoom.attach(invoke);

  // Magnet: windows stick to screen edges and to each other (on by default).
  const magnetSwitch = $('magnetSwitch');
  const renderMagnet = (on) => magnetSwitch.setAttribute('aria-checked', String(on));
  magnetSwitch.addEventListener('click', async () => {
    const on = magnetSwitch.getAttribute('aria-checked') !== 'true';
    renderMagnet(on);
    try {
      renderMagnet(await invoke('set_magnet', { on }));
    } catch (err) {
      renderMagnet(!on);
      console.error('set_magnet', err);
    }
  });
  // The tray's "Window magnet" item.
  listen('magnet-changed', (e) => renderMagnet(e.payload));
  invoke('get_magnet').then(renderMagnet).catch((err) => console.error('get_magnet', err));

  // Start with the system (the Windows installer asks; elsewhere it starts on).
  const autostartSwitch = $('autostartSwitch');
  const renderAutostart = (on) => autostartSwitch.setAttribute('aria-checked', String(on));
  autostartSwitch.addEventListener('click', async () => {
    const on = autostartSwitch.getAttribute('aria-checked') !== 'true';
    renderAutostart(on);
    try {
      renderAutostart(await invoke('set_autostart', { on }));
    } catch (err) {
      renderAutostart(!on);
      console.error('set_autostart', err);
    }
  });
  // The tray's "Start with the system" item.
  listen('autostart-changed', (e) => renderAutostart(e.payload));
  invoke('get_autostart').then(renderAutostart).catch((err) => {
    autostartSwitch.disabled = true;
    console.error('get_autostart', err);
  });

  // The running version, from tauri.conf.json.
  window.__TAURI__.app.getVersion()
    .then((v) => { $('appVersion').textContent = v; })
    .catch((err) => console.error('getVersion', err));
  // Updates (updater.rs): "Check for updates", the version found with its
  // "Update and restart", the download, and the automatic checks switch.
  // The tray's items answer here too ("update-changed").
  let update = {};
  function renderUpdate() {
    const installing = update.progress != null;
    $('updateCheckBtn').hidden = !!update.available;
    $('updateCheckBtn').disabled = !!update.checking;
    $('updateInstallBtn').hidden = !update.available;
    $('updateInstallBtn').disabled = installing;
    let text = '';
    if (installing) text = t('updateDownloading', { percent: update.progress });
    else if (update.error) text = t(update.error === 'install' ? 'updateErrInstall' : 'updateErrCheck');
    else if (update.checking) text = t('updateChecking');
    else if (update.available) text = t('updateAvailable', { version: update.available });
    else if (update.upToDate) text = t('updateUpToDate');
    $('updateStatus').textContent = text;
    $('updateStatus').hidden = !text;
  }
  $('updateCheckBtn').addEventListener('click', () => {
    invoke('check_update').catch((err) => console.error('check_update', err));
  });
  $('updateInstallBtn').addEventListener('click', () => {
    invoke('install_update').catch((err) => console.error('install_update', err));
  });
  const autoUpdateSwitch = $('autoUpdateSwitch');
  const renderAutoUpdate = (on) => autoUpdateSwitch.setAttribute('aria-checked', String(on));
  autoUpdateSwitch.addEventListener('click', async () => {
    const on = autoUpdateSwitch.getAttribute('aria-checked') !== 'true';
    renderAutoUpdate(on);
    try {
      renderAutoUpdate(await invoke('set_auto_update', { on }));
    } catch (err) {
      renderAutoUpdate(!on);
      console.error('set_auto_update', err);
    }
  });
  listen('update-changed', (e) => { update = e.payload; renderUpdate(); });
  invoke('get_updates')
    .then(([on, status]) => { renderAutoUpdate(on); update = status; renderUpdate(); })
    .catch((err) => console.error('get_updates', err));

  // AI control (MCP, mcp.rs): the switch; the MCP clients installed here,
  // which Connect sets up by editing their config (clients.rs); and, for any
  // other client, which launches "<Memo's executable> --mcp" (stdio): pick
  // its config format, copy, paste.
  const aiSwitch = $('aiControlSwitch');
  let aiExe = '';
  let aiCopied = '';
  const quoteArg = (s) => (/^[\w./:\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
  const aiCommand = () => `${quoteArg(aiExe)} --mcp`;
  const AI_SETUPS = {
    json: { hint: 'aiHintJson', text: () => JSON.stringify({ mcpServers: { memo: { command: aiExe, args: ['--mcp'] } } }, null, 2) },
    vscode: { hint: 'aiHintVscode', text: () => JSON.stringify({ servers: { memo: { type: 'stdio', command: aiExe, args: ['--mcp'] } } }, null, 2) },
    claude: { hint: 'aiHintTerminal', text: () => `claude mcp add --scope user memo -- ${aiCommand()}` },
    codex: { hint: 'aiHintTerminal', text: () => `codex mcp add memo -- ${aiCommand()}` },
    command: { hint: 'aiHintCommand', text: aiCommand },
  };
  let aiClients = [];
  let aiClientsNote = { key: 'aiAppsHint' };
  function renderAi(on) {
    aiSwitch.setAttribute('aria-checked', String(on));
    $('aiSetup').hidden = !on || !aiExe;
    $('aiClientsRow').hidden = !on || !aiExe;
    $('aiStatus').textContent = t(aiCopied || 'aiPickApp', { cmd: aiCommand() });
    renderAiClients();
  }
  function renderAiClients() {
    const list = $('aiClients');
    list.replaceChildren(...aiClients.map((client) => {
      const row = document.createElement('li');
      row.className = 'ai-client';
      const name = document.createElement('span');
      name.className = 'ai-client-name';
      name.textContent = client.name;
      const state = document.createElement('span');
      state.className = 'ai-client-state';
      state.textContent = client.unreadable ? t('aiUnreadable')
        : client.current ? t('aiConnected')
        : client.connected ? t('aiOtherCopy') : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.disabled = client.unreadable;
      btn.textContent = t(client.current ? 'aiDisconnect' : client.connected ? 'aiUpdate' : 'aiConnect');
      btn.addEventListener('click', () => connectAiClient(client, !client.current));
      const text = document.createElement('span');
      text.className = 'ai-client-text';
      text.append(name, state);
      row.append(text, btn);
      return row;
    }));
    const note = aiClients.length ? aiClientsNote : { key: 'aiNoApps' };
    $('aiClientsStatus').textContent = t(note.key, { app: note.app });
  }
  async function loadAiClients() {
    try {
      aiClients = await invoke('get_ai_clients');
    } catch (err) {
      console.error('get_ai_clients', err);
    }
    renderAiClients();
  }
  async function connectAiClient(client, on) {
    try {
      aiClients = await invoke('connect_ai_client', { id: client.id, on });
      aiClientsNote = { key: on ? 'aiDidConnect' : 'aiDidDisconnect', app: client.name };
    } catch (err) {
      aiClientsNote = { key: 'aiConnectFailed', app: client.name };
      console.error('connect_ai_client', err);
    }
    renderAiClients();
  }
  aiSwitch.addEventListener('click', async () => {
    const on = aiSwitch.getAttribute('aria-checked') !== 'true';
    aiCopied = '';
    aiClientsNote = { key: 'aiAppsHint' };
    if (on) loadAiClients();
    renderAi(on);
    try {
      renderAi(await invoke('set_ai_control', { on }));
    } catch (err) {
      renderAi(!on);
      console.error('set_ai_control', err);
    }
  });
  // The tray's "AI control" item.
  listen('ai-control-changed', (e) => {
    renderAi(e.payload);
    if (e.payload) loadAiClients();
  });
  // An app installed, or its config edited, while the manager was away.
  window.addEventListener('focus', () => {
    if (aiSwitch.getAttribute('aria-checked') === 'true') loadAiClients();
  });
  invoke('get_ai_control').then(([on, exe]) => {
    aiExe = exe;
    renderAi(on);
    if (on) loadAiClients();
  }).catch((err) => {
    aiSwitch.disabled = true;
    console.error('get_ai_control', err);
  });

  async function copyText(text) {
    const fill = (e) => {
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    document.addEventListener('copy', fill, { once: true });
    const copied = document.execCommand('copy');
    document.removeEventListener('copy', fill);
    if (!copied) await navigator.clipboard.writeText(text);
  }
  $('aiAppSelect').addEventListener('change', () => {
    aiCopied = '';
    renderAi(true);
  });
  $('aiCopyBtn').addEventListener('click', async () => {
    const setup = AI_SETUPS[$('aiAppSelect').value];
    try {
      await copyText(setup.text());
      aiCopied = setup.hint;
    } catch (err) {
      aiCopied = 'aiCopyFailed';
      console.error('copy', err);
    }
    renderAi(true);
  });

  // The tray's Trash, Settings and Help items open the manager on that tab.
  function setView(target) {
    if (!target) return;
    view = target.view;
    if (target.scope === 'update') scrollToUpdate = true;
    if (target.scope && view in scopes) scopes[view] = target.scope;
  }

  async function init() {
    if ((window.top && window.top.MemoWeb) || (window.opener && window.opener.MemoWeb)) {
      const aiSec = settingsView.querySelector('[data-sec="aiControl"]');
      if (aiSec) aiSec.hidden = true;
      for (const id of ['chooseDirBtn', 'autostartSwitch', 'updateCheckBtn', 'autoUpdateSwitch', 'quitBtn']) {
        const row = $(id)?.closest('.setting');
        if (row) row.hidden = true;
      }
      syncMobileState();
    }
    win = await invoke('load_manager');
    applyLayout(win.layout, false);
    // The tray's layout items.
    listen('layout-changed', (e) => applyLayout(e.payload));
    setView(await invoke('take_manager_view'));
    listen('manager-view', (e) => {
      setView(e.payload);
      render();
    });
    renderZoom(await invoke('get_zoom'));
    listen('zoom-changed', (e) => renderZoom(e.payload));
    let lang;
    [languageSetting, lang] = await invoke('get_language');
    applyLanguage(languageSetting, lang);
    listen('language-changed', (e) => applyLanguage(languageSetting, e.payload));
    renderWindow();
    applyTheme(await invoke('get_theme'));
    listen('theme-changed', (e) => applyTheme(e.payload));
    loadCloud();
    listen('cloud-changed', loadCloud);
    listen('notes-changed', scheduleLoad);
    listen('groups-changed', scheduleLoad);
    listen('boards-changed', scheduleLoad);
    // Switched to another folder's notes file: its theme, language and
    // defaults may differ, so start over.
    listen('store-replaced', () => location.reload());
    await Promise.all([load(), loadDefaults(), loadDataDir()]);
    if (!new URLSearchParams(location.search).has('nofocus')) {
      search.focus({ preventScroll: true });
    }
  }

  // Notices (components/toast.js): a new version.
  MemoUpdate.attach({ invoke, listen });

  init().catch((err) => console.error('init', err));
})();
