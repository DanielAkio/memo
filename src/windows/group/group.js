// Memo — group bar: a compact window that holds notes (label group-{id};
// Rust has the logic, groups.rs). The arrow button takes all the
// notes out (back where they were) or puts them all back in; double-click
// on the titlebar renames; a click brings an open group's notes to the
// front; ✕ closes the bar and its notes' windows (the trash button trashes
// it); the pin keeps the bar above other apps, like a note's; the
// folder icon picks the group's colour (folder and stripe); +
// (or Mod+N) adds a new note straight into the group.
// Notes join by being dropped on the bar (Rust emits "drop-hover" with the
// group id while one is over it), from their footer or from the manager.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const $ = (id) => document.getElementById(id);
  const I18n = window.MemoI18n;
  const { t, keys } = I18n;
  const frame = $('frame');
  const titlebar = $('titlebar');
  const trashBtn = $('trashBtn');
  const closeBtn = $('closeBtn');
  const toggleBtn = $('toggleBtn');
  const colorBtn = $('colorBtn');
  const colorMenu = $('colorMenu');

  let group = null;

  function render() {
    if (!group) return;
    // Unnamed (the default, as for notes): "Untitled", greyed out.
    $('groupName').textContent = group.name || t('untitled');
    $('groupName').classList.toggle('is-empty', !group.name);
    frame.classList.toggle('is-open', group.open);
    bar.renderPin(group.pinned);
    const toggleLabel = t(group.open ? 'groupHideHint' : 'groupShowHint');
    toggleBtn.title = toggleLabel;
    toggleBtn.setAttribute('aria-label', toggleLabel);
    // Colour: a label, or a custom #rrggbb straight into --note-color.
    MemoColor.paint(frame, group.color);
    colors.render(group.color);
    colorBtn.title = t('groupColor');
    $('newBtn').title = `${t('newNoteInGroup')} (${keys('Mod', 'N')})`;
    document.title = group.name ? `${group.name} — Memo` : 'Memo';
    trashBtn.title = t('groupToTrash');
    closeBtn.title = t('minimize');
  }

  async function load() {
    try {
      const data = await invoke('load_group');
      if (!data) return;
      [group] = data;
      render();
    } catch (err) {
      console.error('load_group', err);
    }
  }

  const toggle = () => invoke('toggle_group').catch((err) => console.error('toggle_group', err));
  const newNote = () => invoke('new_note_in_group').catch((err) => console.error('new_note_in_group', err));

  // ------------------------------------------------------------- colour

  // The bar is a titlebar tall: the window grows (Rust, not saved) while the
  // picker is open and shrinks back when it closes.
  const setHeight = (height) => invoke('set_group_height', { height })
    .catch((err) => console.error('set_group_height', err));

  const colors = new ColorMenu({
    frame,
    button: colorBtn,
    menu: colorMenu,
    input: $('customColor'),
    current: () => group && group.color,
    onPick: (color) => { group.color = color; render(); },
    onOpen: () => bar.finishRename(true),
    onChange: (open) => setHeight(open ? colorMenu.offsetTop + colorMenu.offsetHeight + 6 : titlebar.offsetHeight),
  });

  // -------------------------------------------------------------- close

  // Like a note's ✕: closes the bar and its memories' windows; the group stays
  // among the current ones and the manager reopens it. An empty unnamed group
  // is just removed.

  // ------------------------------------------------------------- window

  // Titlebar (components/titlebar.js): pin, double-click renames, drag,
  // middle click closes, width-only resizing, and the right-click / "…"
  // menu with the group's commands, then all the app's.
  const bar = new TitleBar({
    frame,
    titlebar,
    resizeEdges: ['e', 'w'],
    pin: {
      get: () => group && group.pinned,
      set: (pinned) => { group.pinned = pinned; render(); },
    },
    rename: {
      name: $('groupName'),
      input: $('nameInput'),
      get: () => group && group.name,
      set: (name) => { group.name = name; render(); },
      onEnd: render,
    },
    buttons: { toggleBtn: toggle, newBtn: newNote },
    onNew: newNote,
    menuItems: () => (group ? [
      { label: t('rename'), run: () => bar.startRename() },
      { label: t('pin'), checked: !!group.pinned, run: () => bar.togglePin() },
      { label: t('groupColor'), run: () => colors.open() },
      { label: t(group.open ? 'groupHideHint' : 'groupShowHint'), run: toggle },
      { label: t('newNoteInGroup'), run: newNote },
      { label: t('share'), run: () => MemoShare.copy() },
      { label: t('groupToTrash'), run: () => bar.trash() },
    ] : []),
    onMenuOpen: () => colors.close(),
  });
  // A click on the bar (not a drag, not a button) brings an open group's
  // memories to the front with it. Only single clicks: the second click of
  // a double-click renames, and raising the notes would blur the name field.
  let downAt = null;
  titlebar.addEventListener('pointerdown', (e) => { downAt = [e.screenX || e.clientX, e.screenY || e.clientY]; });
  titlebar.addEventListener('click', (e) => {
    if (!group || !group.open || bar.renaming || e.detail > 1 || !downAt) return;
    if (e.target.closest('button, input')) return;
    const sx = e.screenX || e.clientX;
    const sy = e.screenY || e.clientY;
    if (Math.hypot(sx - downAt[0], sy - downAt[1]) >= 3) return; // a drag
    invoke('show_group_notes').catch((err) => console.error('show_group_notes', err));
  });

  function applyLanguage(lang) {
    I18n.set(lang);
    MemoTheme.renderMono();
    render();
  }

  async function init() {
    const [, lang] = await invoke('get_language');
    applyLanguage(lang);
    MemoTheme.apply(await invoke('get_theme'));
    listen('language-changed', (e) => applyLanguage(e.payload));
    listen('theme-changed', (e) => MemoTheme.apply(e.payload));
    // Name and open state come from load_group.
    listen('groups-changed', load);
    listen('notes-changed', load);
    // [groupId, on]: a note dragged over (or away from) one of the bars.
    listen('drop-hover', (e) => {
      const [id, on] = e.payload;
      if (group && id === group.id) frame.classList.toggle('drop-hover', on);
    });
    await load();
  }

  window.MemoZoom.attach(invoke);
  // Notices (components/toast.js): sharing and a new version; the bar
  // grows to hold them.
  MemoToast.init({ onResize: (height) => setHeight(titlebar.offsetHeight + (height || 0)) });
  MemoShare.attach({ invoke, listen });
  MemoUpdate.attach({ invoke, listen });

  init().catch((err) => console.error('init', err));
})();
