// Memo — manager window: lists notes and the trash, with search, and holds
// the settings (theme, language, new-note defaults). The window behaves like a
// note (titlebar with pin, new note and close; drag with snapping;
// grip), with no editable title or text. Data comes from Rust (list_notes)
// and the list reloads whenever a note changes ("notes-changed" event).

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = (...parts) => (isMac
    ? parts.map((p) => ({ Mod: '⌘', Shift: '⇧' }[p] || p)).join('')
    : parts.map((p) => ({ Mod: 'Ctrl' }[p] || p)).join('+'));

  const $ = (id) => document.getElementById(id);
  const I18n = window.MemoI18n;
  const { t } = I18n;
  const frame = $('frame');
  const pinBtn = $('pinBtn');
  const list = $('list');
  const empty = $('empty');
  const search = $('search');
  const trashBar = $('trashBar');
  const emptyTrashBtn = $('emptyTrash');
  const customColor = $('customColor');
  const customSwatch = document.querySelector('#defaultSwatches .swatch[data-color="custom"]');

  const DAY_MS = 86_400_000;
  const TRASH_DAYS = 30;

  let notes = [];
  let groups = []; // active groups
  let trashedGroups = [];
  let view = 'notes';
  // Memories and Groups each list either the current ones or the trash.
  const scopes = { notes: 'current', groups: 'current' };
  const inTrash = () => scopes[view] === 'trash';
  let defaultColor = '';
  let reloadTimer = null;
  // State of this window itself (pinned), saved by Rust.
  let win = { pinned: false };

  // ------------------------------------------------------------ helpers

  const isCustomColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  // Plain text without the list markers ("[ ] " / "[x] " / "- ").
  const plain = (text) => (text || '').replace(/^(\s*)(?:\[[ xX]?\]|-)(?= |$) ?/gm, '$1');
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

  // Title: the note's name, else its first line; the preview is the rest of the text.
  function titleAndPreview(note) {
    const ls = lines(note);
    if (note.title) return { title: note.title, preview: ls.join(' · '), named: true };
    return { title: ls[0] || t('emptyNote'), preview: ls.slice(1).join(' · '), named: Boolean(ls[0]) };
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
  const FOLDER_ICON = '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.9l1.5 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>';
  const TRASH_ICON = '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>';

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
      settings: t('tabSettings'),
      help: t('tabHelp'),
    };
    for (const option of $('viewSelect').options) option.textContent = labels[option.value];
    $('viewSelect').value = view;
    fitTabs();
    const listView = view === 'notes' || view === 'groups';
    for (const seg of document.querySelectorAll('#scopeSwitch .seg')) {
      seg.setAttribute('aria-checked', String(listView && seg.dataset.scope === scopes[view]));
    }
    trashBar.hidden = !(listView && inTrash());
    $('trashInfo').textContent = t(view === 'groups' ? 'groupTrashInfo' : 'trashInfo');
    emptyTrashBtn.disabled = (view === 'groups' ? trashedGroups : trashed).length === 0;
    document.body.classList.toggle('notes-view', listView && !inTrash());

    // Settings and Help tabs: no list and no search.
    const panel = view === 'settings' || view === 'help';
    $('settingsView').hidden = view !== 'settings';
    $('helpView').hidden = view !== 'help';
    $('listWrap').hidden = panel;
    $('searchBox').hidden = panel;
    renderDefaultColor();
    if (view === 'settings') fitSettings();
    if (panel) return;

    const q = fold(search.value.trim());
    if (view === 'groups') {
      const source = inTrash() ? trashedGroups : groups;
      const shownGroups = sortGroups(source.filter((g) => !q || fold(g.name || t('untitled')).includes(q)));
      list.replaceChildren(...shownGroups.map((g) => (inTrash() ? groupTrashRow(g, trashed) : groupRow(g, active))));
      empty.hidden = shownGroups.length > 0;
      if (q) empty.textContent = t('nothingFound', { q: search.value.trim() });
      else empty.textContent = t(inTrash() ? 'trashIsEmpty' : 'noGroups');
      return;
    }
    const source = inTrash() ? trashed : active;
    // The group's name counts for the search too.
    const shown = q
      ? source.filter((n) => fold(`${n.title}\n${plain(n.text)}\n${groupName(n)}`).includes(q))
      : source;

    list.replaceChildren(...shown.map(inTrash() ? trashRow : noteRow));
    empty.hidden = shown.length > 0;
    if (q) empty.textContent = t('nothingFound', { q: search.value.trim() });
    else empty.textContent = t(inTrash() ? 'trashIsEmpty' : 'noNotes');
  }

  function baseRow(note) {
    const row = el('li', 'row');
    row.dataset.id = note.id;
    const dot = el('span', 'row-dot');
    dot.dataset.color = isCustomColor(note.color) ? 'custom' : note.color || '';
    if (isCustomColor(note.color)) dot.style.setProperty('--note-color', note.color);
    const { title, preview, named } = titleAndPreview(note);
    const main = el('div', 'row-main');
    main.append(el('div', `row-title${named ? '' : ' is-empty'}`, title));
    if (preview) main.append(el('div', 'row-preview', preview));
    row.append(dot, main);
    return row;
  }

  const groupName = (note) => ([...groups, ...trashedGroups].find((g) => g.id === note.groupId) || {}).name || '';

  // Group of a memory, changed right in the list: no group, a group or a new
  // one. Rust moves it (move_note_to_group) and emits "groups-changed".
  function groupSelect(note) {
    const select = el('select', 'row-group');
    select.title = t('moveToGroup');
    select.setAttribute('aria-label', t('moveToGroup'));
    const sorted = groups.slice()
      .sort((a, b) => a.name.localeCompare(b.name, I18n.locale(), { sensitivity: 'base', numeric: true }));
    select.append(
      new Option(t('noGroup'), ''),
      ...sorted.map((g) => new Option(g.name || t('untitled'), g.id)),
      new Option(`${t('newGroup')}…`, 'new'),
    );
    select.value = note.groupId || '';
    select.addEventListener('change', () => {
      invoke('move_note_to_group', { id: note.id, groupId: select.value })
        .catch((err) => console.error('move_note_to_group', err));
    });
    return select;
  }

  // -------------------------------------------------------- groups tab
  // Groups listed like memories: same search, same sort box, a row per group
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

  function groupRow(group, active) {
    const count = active.filter((n) => n.groupId === group.id).length;
    const row = el('li', `row group-row${group.hidden ? ' is-closed' : ''}`);
    row.dataset.gid = group.id;
    row.title = t('showGroup');
    row.tabIndex = 0;
    const main = el('div', 'row-main');
    main.append(el('div', `row-title${group.name ? '' : ' is-empty'}`, group.name || t('untitled')));
    const state = t(group.hidden ? 'stateClosed' : group.open ? 'groupStateOut' : 'groupStateIn');
    main.append(el('div', 'row-preview', `${t(count === 1 ? 'groupCountOne' : 'groupCountMany', { n: count })} · ${state}`));
    const toggle = el('button', `icon-btn out-in${group.open ? ' is-open' : ''}`);
    toggle.type = 'button';
    toggle.dataset.gact = 'toggle';
    const toggleLabel = t(group.open ? 'groupHideHint' : 'groupShowHint');
    toggle.title = toggleLabel;
    toggle.setAttribute('aria-label', toggleLabel);
    toggle.append(icon(OUT_IN_ICON));
    const del = el('button', 'icon-btn');
    del.type = 'button';
    del.dataset.gact = 'trash';
    del.title = t('groupToTrash');
    del.setAttribute('aria-label', t('groupToTrash'));
    del.append(icon(TRASH_ICON));
    const actions = el('div', 'row-actions');
    actions.append(toggle, del);
    row.append(groupFolder(group), main, actions);
    return row;
  }

  function groupFolder(group) {
    const folder = icon(FOLDER_ICON);
    folder.classList.add('row-folder', 'group-row-folder');
    folder.dataset.color = isCustomColor(group.color) ? 'custom' : group.color || '';
    if (isCustomColor(group.color)) folder.style.setProperty('--note-color', group.color);
    return folder;
  }

  // A group in the trash, as a trashed memory's row: the memories that went
  // with it (they come back when it is restored), days left, restore / delete.
  function groupTrashRow(group, trashed) {
    const count = trashed.filter((n) => n.groupId === group.id && n.trashedAt >= group.trashedAt).length;
    const row = el('li', 'row group-row');
    row.dataset.gid = group.id;
    const main = el('div', 'row-main');
    main.append(el('div', `row-title${group.name ? '' : ' is-empty'}`, group.name || t('untitled')));
    main.append(el('div', 'row-preview', t(count === 1 ? 'groupCountOne' : 'groupCountMany', { n: count })));
    const restore = el('button', 'btn', t('restore'));
    restore.type = 'button';
    restore.dataset.gact = 'restore';
    const del = el('button', 'btn danger', t('delete'));
    del.type = 'button';
    del.dataset.gact = 'forever';
    del.title = t('deleteGroupForever');
    const actions = el('div', 'row-actions');
    actions.append(restore, del);
    row.append(groupFolder(group), main, el('span', 'row-meta', purgeLabel(group.trashedAt)), actions);
    return row;
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

  function noteRow(note) {
    const row = baseRow(note);
    // Closed with ✕: dimmed, a click reopens it.
    row.classList.toggle('is-closed', Boolean(note.hidden));
    row.title = t('openNote');
    row.tabIndex = 0;
    const trashBtn = el('button', 'icon-btn');
    trashBtn.type = 'button';
    trashBtn.dataset.act = 'trash';
    trashBtn.title = t('moveToTrash');
    trashBtn.setAttribute('aria-label', t('moveToTrash'));
    trashBtn.append(icon(TRASH_ICON));
    const actions = el('div', 'row-actions');
    // Always visible: the group select (which shows the group's name),
    // preceded by the group's folder icon in its colour (grey without a
    // group, as in the note's footer), and the trash button.
    const group = groups.find((g) => g.id === note.groupId);
    const folder = icon(FOLDER_ICON);
    folder.classList.add('row-folder');
    const color = group ? group.color || '' : '';
    folder.dataset.color = isCustomColor(color) ? 'custom' : color;
    if (isCustomColor(color)) folder.style.setProperty('--note-color', color);
    actions.append(folder, groupSelect(note), trashBtn);
    row.append(el('span', 'row-meta', editedLabel(note.updatedAt)), actions);
    return row;
  }

  function trashRow(note) {
    const row = baseRow(note);
    const restore = el('button', 'btn', t('restore'));
    restore.type = 'button';
    restore.dataset.act = 'restore';
    const del = el('button', 'btn danger', t('delete'));
    del.type = 'button';
    del.dataset.act = 'delete';
    const actions = el('div', 'row-actions');
    actions.append(restore, del);
    row.append(el('span', 'row-meta', purgeLabel(note.trashedAt)), actions);
    return row;
  }

  // ---------------------------------------------------- default colour

  function renderDefaultColor() {
    const custom = isCustomColor(defaultColor);
    for (const sw of document.querySelectorAll('#defaultSwatches .swatch')) {
      const checked = sw === customSwatch ? custom : sw.dataset.color === defaultColor;
      sw.setAttribute('aria-checked', String(checked));
    }
    if (custom) customSwatch.style.setProperty('--sw', defaultColor);
    else customSwatch.style.removeProperty('--sw');
  }

  async function setDefaultColor(color) {
    defaultColor = color;
    renderDefaultColor();
    try {
      await invoke('set_default_color', { color });
    } catch (err) {
      console.error('set_default_color', err);
    }
  }

  // ----------------------------------------------------------------- data

  async function load() {
    try {
      let all;
      [notes, defaultColor, all] = await Promise.all([
        invoke('list_notes'), invoke('get_default_color'), invoke('list_groups'),
      ]);
      groups = all.filter((g) => !g.trashedAt);
      trashedGroups = all.filter((g) => g.trashedAt);
    } catch (err) {
      console.error('list_notes', err);
    }
    render();
  }

  // ------------------------------------------- default title and text
  // The default text is edited with the note editor itself, embedded in an
  // <iframe> (index.html?defaults) that loads and saves the content on its
  // own. Only the title is handled here.

  // ----------------------------------------------------- group defaults
  // Colour and name new groups start with (by default a random label for
  // each group, 'random', and unnamed like a new note).

  const groupSwatches = $('groupSwatches');
  const groupCustomSwatch = groupSwatches.querySelector('.swatch[data-color="custom"]');
  const groupCustomColor = $('groupCustomColor');
  const groupDefaultTitle = $('groupDefaultTitle');
  let groupDefaultColor = 'random';
  let groupTitleTimer = null;

  function renderGroupDefaultColor() {
    const custom = isCustomColor(groupDefaultColor);
    for (const sw of groupSwatches.querySelectorAll('.swatch')) {
      const checked = sw === groupCustomSwatch ? custom : sw.dataset.color === groupDefaultColor;
      sw.setAttribute('aria-checked', String(checked));
    }
    if (custom) groupCustomSwatch.style.setProperty('--sw', groupDefaultColor);
    else groupCustomSwatch.style.removeProperty('--sw');
  }

  function setGroupDefaultColor(color) {
    groupDefaultColor = color;
    renderGroupDefaultColor();
    invoke('set_default_group_color', { color }).catch((err) => console.error('set_default_group_color', err));
  }

  async function loadGroupDefaults() {
    try {
      [groupDefaultColor, groupDefaultTitle.value] = await invoke('get_group_defaults');
    } catch (err) {
      console.error('get_group_defaults', err);
    }
    renderGroupDefaultColor();
  }

  function flushGroupTitle() {
    clearTimeout(groupTitleTimer);
    invoke('set_default_group_title', { title: groupDefaultTitle.value })
      .catch((err) => console.error('set_default_group_title', err));
  }

  groupSwatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    if (sw === groupCustomSwatch) {
      groupCustomColor.value = isCustomColor(groupDefaultColor) ? groupDefaultColor : '#f2c94c';
      MemoColorPicker.open(groupCustomColor, sw);
      return;
    }
    setGroupDefaultColor(sw.dataset.color);
  });
  groupCustomColor.addEventListener('change', () => setGroupDefaultColor(groupCustomColor.value.toLowerCase()));
  groupDefaultTitle.addEventListener('input', () => {
    clearTimeout(groupTitleTimer);
    groupTitleTimer = setTimeout(flushGroupTitle, 400);
  });
  groupDefaultTitle.addEventListener('change', flushGroupTitle);

  const defaultTitle = $('defaultTitle');
  let defaultsTimer = null;

  async function loadDefaults() {
    try {
      [defaultTitle.value] = await invoke('get_new_note_defaults');
    } catch (err) {
      console.error('get_new_note_defaults', err);
    }
  }

  function flushDefaults() {
    clearTimeout(defaultsTimer);
    invoke('set_default_title', { title: defaultTitle.value })
      .catch((err) => console.error('set_default_title', err));
  }

  // Saves on its own, shortly after typing stops, and when leaving the field.
  defaultTitle.addEventListener('input', () => {
    clearTimeout(defaultsTimer);
    defaultsTimer = setTimeout(flushDefaults, 400);
  });
  defaultTitle.addEventListener('change', flushDefaults);

  // Several changes in a row (typing in a note) become a single reload.
  function scheduleLoad() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
  }

  // "Empty trash" and "Quit" require a second click within 3 s. The second
  // click restores the button at once instead of waiting for the timer.
  const confirmStates = new Map();
  function confirmFirst(btn, label) {
    const state = confirmStates.get(btn);
    const restore = (s) => {
      clearTimeout(s.timer);
      confirmStates.delete(btn);
      btn.classList.remove('confirming');
      btn.textContent = s.original;
    };
    if (state) {
      restore(state);
      return true;
    }
    const next = { original: btn.textContent };
    next.timer = setTimeout(() => restore(next), 3000);
    confirmStates.set(btn, next);
    btn.classList.add('confirming');
    btn.textContent = label;
    return false;
  }

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

  const systemLight = matchMedia('(prefers-color-scheme: light)');

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    for (const seg of document.querySelectorAll('#themeSwitch .seg')) {
      seg.setAttribute('aria-checked', String(seg.dataset.theme === (theme || 'system')));
    }
    renderMonoName();
  }

  // The "mono" colour is white in the dark theme and black in the light one; its name follows.
  function renderMonoName() {
    const theme = document.documentElement.dataset.theme;
    const light = theme ? theme === 'light' : systemLight.matches;
    const name = t(light ? 'black' : 'white');
    for (const sw of document.querySelectorAll('.settings .swatch[data-color="mono"], #mgrSwatches .swatch[data-color="mono"]')) {
      sw.setAttribute('aria-label', name);
      sw.title = name;
    }
  }
  systemLight.addEventListener('change', renderMonoName);

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
    const row = e.target.closest('.row');
    if (row && row.dataset.gid) {
      const btn = e.target.closest('[data-gact]');
      if (btn) groupAct(btn, row.dataset.gid);
      else if (!inTrash()) showGroup(row.dataset.gid);
      return;
    }
    if (!row || e.target.closest('select')) return;
    const btn = e.target.closest('[data-act]');
    if (btn) act(btn.dataset.act, row.dataset.id);
    else if (!inTrash()) act('open', row.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target !== row || e.key !== 'Enter' || inTrash()) return;
    if (view === 'groups') showGroup(row.dataset.gid);
    else act('open', row.dataset.id);
  });

  emptyTrashBtn.addEventListener('click', async () => {
    if (!confirmFirst(emptyTrashBtn, t('emptyTrashConfirm'))) return;
    const command = view === 'groups' ? 'empty_group_trash' : 'empty_trash';
    try {
      await invoke(command);
    } catch (err) {
      console.error(command, err);
    }
  });

  $('defaultSwatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    if (sw === customSwatch) {
      customColor.value = isCustomColor(defaultColor) ? defaultColor : '#f2c94c';
      MemoColorPicker.open(customColor, sw);
      return;
    }
    setDefaultColor(sw.dataset.color);
  });
  customColor.addEventListener('change', () => setDefaultColor(customColor.value.toLowerCase()));

  $('helpBtn').addEventListener('click', () => {
    invoke('show_welcome').catch((err) => console.error('show_welcome', err));
  });
  // Quit closes the whole app (every note); requires a second click.
  $('quitBtn').addEventListener('click', () => {
    if (!confirmFirst($('quitBtn'), t('quitConfirm'))) return;
    invoke('quit_app').catch((err) => console.error('quit_app', err));
  });

  // Theme: applies to every window; Rust notifies them all with "theme-changed".
  $('themeSwitch').addEventListener('click', (e) => {
    const seg = e.target.closest('.seg');
    if (!seg) return;
    applyTheme(seg.dataset.theme);
    invoke('change_theme', { theme: seg.dataset.theme }).catch((err) => console.error('change_theme', err));
  });

  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key === 'p') { e.preventDefault(); togglePin(); return; }
    if (mod && !e.shiftKey && key === 'n') { e.preventDefault(); newNote(); return; }
    if (mod && key === 'f') {
      e.preventDefault();
      if (view === 'settings' || view === 'help') { view = 'notes'; render(); }
      search.focus();
      search.select();
    } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = '';
      render();
    }
  });

  // Native context menu only in text fields.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });

  // ------------------------------------------- window (like a note)

  function renderWindow() {
    // Colour: stripe and manager icon, as in a note or group.
    const color = win.color || '';
    const custom = isCustomColor(color);
    frame.dataset.color = custom ? 'custom' : color;
    if (custom) frame.style.setProperty('--note-color', color);
    else frame.style.removeProperty('--note-color');
    if (custom) mgrCustomSwatch.style.setProperty('--sw', color);
    else mgrCustomSwatch.style.removeProperty('--sw');
    for (const sw of mgrColorMenu.querySelectorAll('.swatch')) {
      const checked = sw === mgrCustomSwatch ? custom : sw.dataset.color === color;
      sw.setAttribute('aria-checked', String(checked));
    }
    pinBtn.setAttribute('aria-pressed', String(win.pinned));
    const pinLabel = t(win.pinned ? 'unpin' : 'pin');
    pinBtn.setAttribute('aria-label', pinLabel);
    pinBtn.title = `${pinLabel} (${keys('Mod', 'Shift', 'P')})`;
  }

  // ------------------------------------------------- window colour picker

  const mgrColorBtn = $('mgrColorBtn');
  const mgrColorMenu = $('mgrColorMenu');
  const mgrCustomColor = $('mgrCustomColor');
  const mgrCustomSwatch = mgrColorMenu.querySelector('.swatch[data-color="custom"]');

  function openMgrColors() {
    mgrColorMenu.hidden = false;
    frame.classList.add('menu-open');
    mgrColorBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMgrColors() {
    if (mgrColorMenu.hidden) return;
    mgrColorMenu.hidden = true;
    frame.classList.remove('menu-open');
    mgrColorBtn.setAttribute('aria-expanded', 'false');
  }

  function setMgrColor(color) {
    win.color = color;
    renderWindow();
    invoke('set_manager_color', { color }).catch((err) => console.error('set_manager_color', err));
  }

  mgrColorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mgrColorMenu.hidden ? openMgrColors() : closeMgrColors();
  });
  $('mgrSwatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    if (sw === mgrCustomSwatch) {
      mgrCustomColor.value = isCustomColor(win.color) ? win.color : '#f2c94c';
      MemoColorPicker.open(mgrCustomColor, sw);
      return;
    }
    setMgrColor(sw.dataset.color);
    closeMgrColors();
  });
  mgrCustomColor.addEventListener('change', () => {
    setMgrColor(mgrCustomColor.value.toLowerCase());
    closeMgrColors();
  });
  document.addEventListener('mousedown', (e) => {
    if (!mgrColorMenu.hidden && !mgrColorMenu.contains(e.target) && !mgrColorBtn.contains(e.target)) closeMgrColors();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMgrColors();
  });
  window.addEventListener('blur', closeMgrColors);

  async function togglePin() {
    const next = !win.pinned;
    win.pinned = next; // immediate feedback; reverts if the OS refuses
    renderWindow();
    try {
      win.pinned = await invoke('set_pinned', { pinned: next });
    } catch (err) {
      win.pinned = !next;
      console.error('set_pinned', err);
    }
    renderWindow();
  }

  const newNote = () => invoke('new_note').catch((err) => console.error('new_note', err));
  const closeWindow = () => invoke('close_manager').catch((err) => console.error('close_manager', err));

  window.MemoChrome.attach({
    frame,
    titlebar: $('titlebar'),
    grip: $('grip'),
    onClose: closeWindow,
  });
  // Right click on the titlebar: its commands in a menu, as in a note.
  window.MemoChrome.titleMenu({
    frame,
    titlebar: $('titlebar'),
    items: () => [
      { label: t(win.pinned ? 'unpin' : 'pin'), run: togglePin },
      { label: t('managerColor'), run: openMgrColors },
      null,
      { label: t('newNote'), run: newNote },
      { label: t('newGroup'), run: () => invoke('new_group').catch((err) => console.error('new_group', err)) },
      { label: t('bringAllToFront'), run: () => invoke('bring_notes_to_front').catch((err) => console.error('bring_notes_to_front', err)) },
      null,
      { label: t('close'), run: closeWindow },
    ],
    onOpen: closeMgrColors,
  });
  pinBtn.addEventListener('click', togglePin);
  $('newBtn').addEventListener('click', newNote);
  $('raiseBtn').addEventListener('click', () => {
    invoke('bring_notes_to_front').catch((err) => console.error('bring_notes_to_front', err));
  });
  $('newGroupBtn').addEventListener('click', () => {
    invoke('new_group').catch((err) => console.error('new_group', err));
  });
  $('closeBtn').addEventListener('click', closeWindow);

  window.addEventListener('focus', () => frame.classList.add('is-focused'));
  window.addEventListener('blur', () => frame.classList.remove('is-focused'));

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
  // Google account for cloud sync (cloud.rs). The section only shows in
  // builds with an OAuth client. Errors come back as short codes.

  const cloud = { available: false, email: null, waiting: false, error: null, status: {} };
  const CLOUD_ERRORS = {
    denied: 'cloudErrDenied',
    timeout: 'cloudErrTimeout',
    network: 'cloudErrNetwork',
    keyring: 'cloudErrKeyring',
  };

  // One line: who is connected, then how syncing goes.
  function cloudStatusText() {
    if (cloud.waiting) return t('cloudWaiting');
    if (cloud.error) return t(CLOUD_ERRORS[cloud.error] || 'cloudErrOther');
    if (!cloud.email) return t('cloudOff');
    const st = cloud.status || {};
    if (st.error === 'reauth') return t('cloudErrReauth');
    const parts = [t('cloudOn', { email: cloud.email })];
    if (st.syncing) parts.push(t('cloudSyncing'));
    else if (st.error) parts.push(t('cloudOffline'));
    else if (st.lastSync) parts.push(t('cloudSynced', { time: editedLabel(st.lastSync) }));
    if (st.pending && !st.syncing) parts.push(st.pending === 1 ? t('cloudPendingOne') : t('cloudPending', { n: st.pending }));
    return parts.join(' ');
  }

  function renderCloud() {
    document.querySelectorAll('[data-cloud]').forEach((el) => { el.hidden = !cloud.available; });
    const reauth = (cloud.status || {}).error === 'reauth';
    $('cloudConnectBtn').hidden = (!!cloud.email && !reauth) || cloud.waiting;
    $('cloudCancelBtn').hidden = !cloud.waiting;
    $('cloudSyncBtn').hidden = !cloud.email || reauth || cloud.waiting;
    $('cloudSyncBtn').disabled = !!(cloud.status || {}).syncing;
    $('cloudDisconnectBtn').hidden = !cloud.email || cloud.waiting;
    $('cloudStatus').textContent = cloudStatusText();
  }

  async function loadCloud() {
    try {
      [cloud.available, cloud.email, cloud.status] = await invoke('get_cloud_account');
    } catch (err) {
      console.error('get_cloud_account', err);
    }
    renderCloud();
  }

  $('cloudConnectBtn').addEventListener('click', async () => {
    Object.assign(cloud, { waiting: true, error: null });
    renderCloud();
    try {
      cloud.email = await invoke('connect_cloud');
    } catch (err) {
      if (err !== 'cancelled' && err !== 'busy') cloud.error = err;
      console.error('connect_cloud', err);
    }
    cloud.waiting = false;
    await loadCloud();
  });

  $('cloudSyncBtn').addEventListener('click', () => {
    invoke('sync_cloud').catch((err) => console.error('sync_cloud', err));
  });

  $('cloudCancelBtn').addEventListener('click', () => {
    invoke('cancel_cloud_connect').catch((err) => console.error('cancel_cloud_connect', err));
  });

  $('cloudDisconnectBtn').addEventListener('click', async () => {
    cloud.error = null;
    try {
      await invoke('disconnect_cloud');
    } catch (err) {
      console.error('disconnect_cloud', err);
    }
    await loadCloud();
  });

  // ---------------------------------------------------------------- help
  // Each group is a title and [topic, how, demo?] items. In "how", {{…}}
  // marks a key or something to type, shown as <kbd>; "Mod"/"Shift" inside it
  // become ⌘/⇧ on macOS and Ctrl/Shift elsewhere (keys()). "demo" is a static
  // example from i18n.js, drawn like the real thing (see demoBox).

  // Titlebar icons for <i data-icon="…"> in the demos (same paths as the
  // windows' buttons).
  const PIN_SVG = '<g transform="rotate(45 8 8)"><path class="pin-needle" d="M8 10.4V15"/>'
    + '<path class="pin-body" d="M5.7 3.6h4.6l.7 5.1H5z"/>'
    + '<rect class="pin-body" x="3.6" y="8.4" width="8.8" height="2" rx=".9"/>'
    + '<rect class="pin-body" x="4.9" y="1.6" width="6.2" height="2" rx=".9"/></g>';
  const DEMO_ICONS = {
    pin: PIN_SVG,
    'pin-on': PIN_SVG,
    plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
    manager: '<rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2"/><path d="M5.25 6h5.5M5.25 8.25h5.5M5.25 10.5h3.25"/>',
    toggle: '<path d="M4.5 9.75 8 6.25l3.5 3.5"/>',
    'folder-plus': '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.9l1.5 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/><path d="M8 7.25v3.5M6.25 9h3.5"/>',
    folder: '<path d="M2.5 4.25a1 1 0 0 1 1-1h2.9l1.5 1.5h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
    // Layers: the top one is "in front" (not the copy icon's two sheets).
    raise: '<path d="M8 2.5 13.75 5.5 8 8.5 2.25 5.5z"/><path d="M2.25 8.25 8 11.25l5.75-3"/><path d="M2.25 11 8 14l5.75-3"/>',
    close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
    search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/>',
    sort: '<path d="M5 3v10M2.75 10.75 5 13l2.25-2.25M11 13V3M8.75 5.25 11 3l2.25 2.25"/>',
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
    const groups = I18n.help().map(({ title, items }) => {
      const list = el('dl', 'help-list');
      for (const [topic, how, demo] of items) {
        const dd = el('dd');
        dd.append(helpText(how));
        if (demo) dd.append(demoBox(demo));
        list.append(el('dt', '', topic), dd);
      }
      return [el('h2', 'settings-title', title), list];
    });
    $('helpGroups').replaceChildren(...groups.flat());
  }

  // ------------------------------------------------------------ language

  function applyLanguage(setting, lang) {
    I18n.set(lang);
    document.title = t('manager');
    $('newBtn').title = `${t('newNote')} (${keys('Mod', 'N')})`;
    $('languageSelect').value = setting;
    renderWindow();
    renderMonoName();
    renderHelp();
    renderCloud();
    renderAi(aiSwitch.getAttribute('aria-checked') === 'true');
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
    if (target.scope && view in scopes) scopes[view] = target.scope;
  }

  async function init() {
    win = await invoke('load_manager');
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
    if (document.hasFocus()) frame.classList.add('is-focused');
    applyTheme(await invoke('get_theme'));
    listen('theme-changed', (e) => applyTheme(e.payload));
    loadCloud();
    listen('cloud-changed', loadCloud);
    listen('notes-changed', scheduleLoad);
    listen('groups-changed', scheduleLoad);
    // Switched to another folder's notes file: its theme, language and
    // defaults may differ, so start over.
    listen('store-replaced', () => location.reload());
    await Promise.all([load(), loadDefaults(), loadGroupDefaults(), loadDataDir()]);
    search.focus();
  }

  init().catch((err) => console.error('init', err));
})();
