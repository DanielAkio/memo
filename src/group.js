// Memo — group bar: a compact window that holds notes (label group-{id};
// Rust has the logic, main.rs "Groups"). The arrow button takes all the
// notes out (back where they were) or puts them all back in; double-click
// on the titlebar renames; a click brings an open group's notes to the
// front; ✕ twice deletes the group and sends its notes
// to the trash; the pin keeps the bar above other apps, like a note's; the
// folder icon picks the group's colour (folder and stripe); +
// (or Mod+N) adds a new note straight into the group.
// Notes join by being dropped on the bar (Rust emits "drop-hover" with the
// group id while one is over it), from their footer or from the manager.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const $ = (id) => document.getElementById(id);
  const I18n = window.MemoI18n;
  const { t } = I18n;
  const frame = $('frame');
  const titlebar = $('titlebar');
  const nameEl = $('groupName');
  const nameInput = $('nameInput');
  const closeBtn = $('closeBtn');
  const pinBtn = $('pinBtn');
  const toggleBtn = $('toggleBtn');
  const colorBtn = $('colorBtn');
  const colorMenu = $('colorMenu');
  const customColor = $('customColor');
  const customSwatch = document.querySelector('.swatch[data-color="custom"]');
  const isCustomColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const pinKeys = isMac ? '⌘⇧P' : 'Ctrl+Shift+P';
  const newKeys = isMac ? '⌘N' : 'Ctrl+N';

  let group = null;
  let renaming = false;

  function render() {
    if (!group) return;
    // Unnamed (the default, as for notes): "Untitled", greyed out.
    nameEl.textContent = group.name || t('untitled');
    nameEl.classList.toggle('is-empty', !group.name);
    frame.classList.toggle('is-open', group.open);
    pinBtn.setAttribute('aria-pressed', String(group.pinned));
    const pinLabel = t(group.pinned ? 'unpin' : 'pin');
    pinBtn.setAttribute('aria-label', pinLabel);
    pinBtn.title = `${pinLabel} (${pinKeys})`;
    const toggleLabel = t(group.open ? 'groupHideHint' : 'groupShowHint');
    toggleBtn.title = toggleLabel;
    toggleBtn.setAttribute('aria-label', toggleLabel);
    // Colour: a label, or a custom #rrggbb straight into --note-color.
    const custom = isCustomColor(group.color);
    frame.dataset.color = custom ? 'custom' : group.color || '';
    if (custom) frame.style.setProperty('--note-color', group.color);
    else frame.style.removeProperty('--note-color');
    if (custom) customSwatch.style.setProperty('--sw', group.color);
    else customSwatch.style.removeProperty('--sw');
    for (const sw of document.querySelectorAll('.swatch')) {
      const checked = sw === customSwatch ? custom : sw.dataset.color === (group.color || '');
      sw.setAttribute('aria-checked', String(checked));
    }
    colorBtn.title = t('groupColor');
    $('newBtn').title = `${t('newNoteInGroup')} (${newKeys})`;
    document.title = group.name ? `${group.name} — Memo` : 'Memo';
    closeBtn.title = t('close');
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
  toggleBtn.addEventListener('click', toggle);
  const newNote = () => invoke('new_note_in_group').catch((err) => console.error('new_note_in_group', err));
  $('newBtn').addEventListener('click', newNote);

  // Same as a note's pin: immediate feedback, reverted if the OS refuses.
  async function togglePin() {
    if (!group) return;
    const next = !group.pinned;
    group.pinned = next;
    render();
    try {
      group.pinned = await invoke('set_pinned', { pinned: next });
    } catch (err) {
      group.pinned = !next;
      console.error('set_pinned', err);
    }
    render();
  }
  pinBtn.addEventListener('click', togglePin);
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') closeColors();
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n' && !renaming) {
      e.preventDefault();
      newNote();
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      togglePin();
    }
  });

  // ------------------------------------------------------------- rename

  function startRename() {
    if (renaming || !group) return;
    renaming = true;
    nameInput.value = group.name;
    nameEl.hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  async function finishRename(save) {
    if (!renaming) return;
    renaming = false;
    const value = nameInput.value.trim();
    nameInput.hidden = true;
    nameEl.hidden = false;
    if (save && value !== group.name) {
      group.name = value;
      render();
      try {
        group.name = await invoke('rename_group', { name: value });
      } catch (err) {
        console.error('rename_group', err);
      }
    }
    render();
  }

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
  });
  nameInput.addEventListener('blur', () => finishRename(true));

  // -------------------------------------------------------------- colour

  // The bar is a titlebar tall: the window grows (Rust, not saved) while the
  // picker is open and shrinks back when it closes.
  const setHeight = (height) => invoke('set_group_height', { height })
    .catch((err) => console.error('set_group_height', err));

  function openColors() {
    if (renaming) finishRename(true);
    colorMenu.hidden = false;
    frame.classList.add('menu-open');
    colorBtn.setAttribute('aria-expanded', 'true');
    setHeight(colorMenu.offsetTop + colorMenu.offsetHeight + 6);
  }

  function closeColors() {
    if (colorMenu.hidden) return;
    colorMenu.hidden = true;
    frame.classList.remove('menu-open');
    colorBtn.setAttribute('aria-expanded', 'false');
    setHeight(titlebar.offsetHeight);
  }

  async function setColor(color) {
    group.color = color;
    render();
    invoke('set_group_color', { color }).catch((err) => console.error('set_group_color', err));
  }

  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    colorMenu.hidden ? openColors() : closeColors();
  });
  $('swatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw || !group) return;
    if (sw === customSwatch) {
      // The system picker opens on the current colour.
      customColor.value = isCustomColor(group.color) ? group.color : '#f2c94c';
      MemoColorPicker.open(customColor, sw);
      return;
    }
    setColor(sw.dataset.color);
    closeColors();
  });
  customColor.addEventListener('change', () => {
    setColor(customColor.value.toLowerCase());
    closeColors();
  });
  document.addEventListener('mousedown', (e) => {
    if (!colorMenu.hidden && !colorMenu.contains(e.target) && !colorBtn.contains(e.target)) closeColors();
  });

  // "mono" is white in the dark theme and black in the light one.
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  function renderMonoName() {
    const theme = document.documentElement.dataset.theme;
    const light = theme ? theme === 'light' : systemLight.matches;
    const sw = document.querySelector('.swatch[data-color="mono"]');
    const name = t(light ? 'black' : 'white');
    sw.setAttribute('aria-label', name);
    sw.title = name;
  }
  systemLight.addEventListener('change', renderMonoName);

  // -------------------------------------------------------------- close

  // Like a note's ✕: closes the bar and its memories' windows; the group stays
  // among the current ones and the manager reopens it. An empty unnamed group
  // is just removed.
  function closeGroup() {
    invoke('close_group').catch((err) => console.error('close_group', err));
  }
  closeBtn.addEventListener('click', closeGroup);

  // ------------------------------------------------------------- window

  window.MemoChrome.attach({
    frame,
    titlebar,
    resizeEdges: ['e', 'w'],
    onDoubleClick: startRename,
    onClose: closeGroup,
  });
  // A click on the bar (not a drag, not a button) brings an open group's
  // memories to the front with it. Only single clicks: the second click of
  // a double-click renames, and raising the notes would blur the name field.
  let downAt = null;
  titlebar.addEventListener('pointerdown', (e) => { downAt = [e.screenX, e.screenY]; });
  titlebar.addEventListener('click', (e) => {
    if (!group || !group.open || renaming || e.detail > 1 || !downAt) return;
    if (e.target.closest('button, input')) return;
    if (Math.hypot(e.screenX - downAt[0], e.screenY - downAt[1]) >= 3) return; // a drag
    invoke('show_group_notes').catch((err) => console.error('show_group_notes', err));
  });

  // Right click on the bar or its "…" button: the group's commands, then
  // all the app's (chrome.js).
  window.MemoChrome.titleMenu({
    titlebar,
    more: $('moreBtn'),
    items: () => (group ? [
      { label: t('rename'), run: startRename },
      { label: t('pin'), checked: !!group.pinned, run: togglePin },
      { label: t('groupColor'), run: openColors },
      { label: t(group.open ? 'groupHideHint' : 'groupShowHint'), run: toggle },
      { label: t('newNoteInGroup'), run: newNote },
      { label: t('close'), run: closeGroup },
    ] : []),
    onOpen: closeColors,
  });

  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input')) e.preventDefault();
  });
  window.addEventListener('focus', () => frame.classList.add('is-focused'));
  window.addEventListener('blur', () => {
    frame.classList.remove('is-focused');
    finishRename(true);
    closeColors();
  });

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    renderMonoName();
  }

  function applyLanguage(lang) {
    I18n.set(lang);
    renderMonoName();
    render();
  }

  async function init() {
    const [, lang] = await invoke('get_language');
    applyLanguage(lang);
    applyTheme(await invoke('get_theme'));
    listen('language-changed', (e) => applyLanguage(e.payload));
    listen('theme-changed', (e) => applyTheme(e.payload));
    // Name and open state come from load_group.
    listen('groups-changed', load);
    listen('notes-changed', load);
    // [groupId, on]: a note dragged over (or away from) one of the bars.
    listen('drop-hover', (e) => {
      const [id, on] = e.payload;
      if (group && id === group.id) frame.classList.toggle('drop-hover', on);
    });
    if (document.hasFocus()) frame.classList.add('is-focused');
    await load();
  }

  window.MemoZoom.attach(invoke);
  init().catch((err) => console.error('init', err));
})();
