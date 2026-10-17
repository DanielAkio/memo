// Taxinha — janela "Gerenciador": lista as notas e a lixeira, com busca, e define a
// cor das notas novas e o tema. A janela se comporta como uma nota (barra com
// tachinha, nova nota, recolher e fechar; arraste com ímã; alça), sem título
// editável nem texto. Os dados vêm do Rust (list_notes) e a lista é
// recarregada sempre que alguma nota muda (evento "notes-changed").

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = (...parts) => (isMac
    ? parts.map((p) => ({ Mod: '⌘', Shift: '⇧' }[p] || p)).join('')
    : parts.map((p) => ({ Mod: 'Ctrl' }[p] || p)).join('+'));

  const $ = (id) => document.getElementById(id);
  const I18n = window.TaxinhaI18n;
  const { t } = I18n;
  const frame = $('frame');
  const pinBtn = $('pinBtn');
  const collapseBtn = $('collapseBtn');
  const list = $('list');
  const empty = $('empty');
  const search = $('search');
  const trashBar = $('trashBar');
  const emptyTrashBtn = $('emptyTrash');
  const customColor = $('customColor');
  const customSwatch = document.querySelector('.swatch[data-color="custom"]');

  const DAY_MS = 86_400_000;
  const TRASH_DAYS = 30;

  let notes = [];
  let view = 'notes';
  let defaultColor = 'yellow';
  let reloadTimer = null;
  // Estado da própria janela (fixada por cima, recolhida), salvo pelo Rust.
  let win = { pinned: false, collapsed: false };

  // ------------------------------------------------------------ helpers

  const isCustomColor = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  // Texto puro sem os marcadores de checklist ("[ ] " / "[x] ").
  const plain = (t) => (t || '').replace(/^(\s*)\[[ xX]\](?= |$) ?/gm, '$1');
  // Para a busca: minúsculas e sem acentos.
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

  // Título: o nome da nota, senão a primeira linha; a prévia é o resto do texto.
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

  const TRASH_ICON = '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>';

  // ------------------------------------------------------------- render

  function render() {
    const active = notes.filter((n) => !n.trashedAt).sort((a, b) => b.updatedAt - a.updatedAt);
    const trashed = notes.filter((n) => n.trashedAt).sort((a, b) => b.trashedAt - a.trashedAt);
    $('countNotes').textContent = active.length;
    $('countTrash').textContent = trashed.length;
    for (const tab of document.querySelectorAll('.tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    }
    trashBar.hidden = view !== 'trash';
    emptyTrashBtn.disabled = trashed.length === 0;
    document.body.classList.toggle('notes-view', view === 'notes');

    // Aba "Configuração": sem lista e sem busca.
    const settings = view === 'settings';
    $('settingsView').hidden = !settings;
    $('listWrap').hidden = settings;
    $('searchBox').hidden = settings;
    renderDefaultColor();
    if (settings) return;

    const q = fold(search.value.trim());
    const source = view === 'notes' ? active : trashed;
    const shown = q ? source.filter((n) => fold(`${n.title}\n${plain(n.text)}`).includes(q)) : source;

    list.replaceChildren(...shown.map(view === 'notes' ? noteRow : trashRow));
    empty.hidden = shown.length > 0;
    if (q) empty.textContent = t('nothingFound', { q: search.value.trim() });
    else empty.textContent = t(view === 'notes' ? 'noNotes' : 'trashIsEmpty');
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

  function noteRow(note) {
    const row = baseRow(note);
    row.title = t('openNote');
    row.tabIndex = 0;
    const trashBtn = el('button', 'icon-btn');
    trashBtn.type = 'button';
    trashBtn.dataset.act = 'trash';
    trashBtn.title = t('moveToTrash');
    trashBtn.setAttribute('aria-label', t('moveToTrash'));
    trashBtn.append(icon(TRASH_ICON));
    const actions = el('div', 'row-actions');
    actions.append(trashBtn);
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

  // ----------------------------------------------------- cor padrão

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

  // ---------------------------------------------------------------- dados

  async function load() {
    try {
      [notes, defaultColor] = await Promise.all([invoke('list_notes'), invoke('get_default_color')]);
    } catch (err) {
      console.error('list_notes', err);
    }
    render();
  }

  // ------------------------------------------- título e texto padrão

  const defaultTitle = $('defaultTitle');
  const defaultText = $('defaultText');
  let defaultsTimer = null;

  async function loadDefaults() {
    try {
      [defaultTitle.value, defaultText.value] = await invoke('get_new_note_defaults');
    } catch (err) {
      console.error('get_new_note_defaults', err);
    }
  }

  function flushDefaults() {
    clearTimeout(defaultsTimer);
    invoke('set_new_note_defaults', { title: defaultTitle.value, text: defaultText.value })
      .catch((err) => console.error('set_new_note_defaults', err));
  }

  // Salva sozinho, um pouco depois de parar de digitar, e ao sair do campo.
  function saveDefaults() {
    clearTimeout(defaultsTimer);
    defaultsTimer = setTimeout(flushDefaults, 400);
  }
  for (const field of [defaultTitle, defaultText]) {
    field.addEventListener('input', saveDefaults);
    field.addEventListener('change', flushDefaults);
  }

  // Várias mudanças seguidas (digitação numa nota) viram um só recarregamento.
  function scheduleLoad() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 150);
  }

  // "Esvaziar lixeira" e "Sair" pedem um segundo clique em até 3 s.
  function confirmFirst(btn, label) {
    if (btn.classList.contains('confirming')) return true;
    const original = btn.textContent;
    btn.classList.add('confirming');
    btn.textContent = label;
    setTimeout(() => {
      btn.classList.remove('confirming');
      btn.textContent = original;
    }, 3000);
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

  // --------------------------------------------------------------- tema

  const systemLight = matchMedia('(prefers-color-scheme: light)');

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    for (const seg of document.querySelectorAll('#themeSwitch .seg')) {
      seg.setAttribute('aria-checked', String(seg.dataset.theme === (theme || 'system')));
    }
    renderMonoName();
  }

  // A cor "mono" é branca no tema escuro e preta no claro; o nome acompanha.
  function renderMonoName() {
    const theme = document.documentElement.dataset.theme;
    const light = theme ? theme === 'light' : systemLight.matches;
    const sw = document.querySelector('#defaultSwatches .swatch[data-color="mono"]');
    const name = t(light ? 'black' : 'white');
    sw.setAttribute('aria-label', name);
    sw.title = name;
  }
  systemLight.addEventListener('change', renderMonoName);

  // ------------------------------------------------------------- eventos

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      view = tab.dataset.view;
      render();
    });
  }

  search.addEventListener('input', render);

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const btn = e.target.closest('[data-act]');
    if (btn) act(btn.dataset.act, row.dataset.id);
    else if (view === 'notes') act('open', row.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.row');
    if (row && e.target === row && e.key === 'Enter' && view === 'notes') act('open', row.dataset.id);
  });

  emptyTrashBtn.addEventListener('click', async () => {
    if (!confirmFirst(emptyTrashBtn, t('emptyTrashConfirm'))) return;
    try {
      await invoke('empty_trash');
    } catch (err) {
      console.error('empty_trash', err);
    }
  });

  $('defaultSwatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    if (sw === customSwatch) {
      customColor.value = isCustomColor(defaultColor) ? defaultColor : '#f2c94c';
      customColor.click();
      return;
    }
    setDefaultColor(sw.dataset.color);
  });
  customColor.addEventListener('change', () => setDefaultColor(customColor.value.toLowerCase()));

  $('helpBtn').addEventListener('click', () => {
    invoke('show_welcome').catch((err) => console.error('show_welcome', err));
  });
  // Sair fecha o app inteiro (todas as notas); pede um segundo clique.
  $('quitBtn').addEventListener('click', () => {
    if (!confirmFirst($('quitBtn'), t('quitConfirm'))) return;
    invoke('quit_app').catch((err) => console.error('quit_app', err));
  });

  // Tema: vale para todas as janelas; o Rust avisa todas com "theme-changed".
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
      if (view === 'settings') { view = 'notes'; render(); }
      search.focus();
      search.select();
    } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
      search.value = '';
      render();
    }
  });

  // Menu de contexto nativo só nos campos de texto.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });

  // ----------------------------------------------- janela (como uma nota)

  function renderWindow() {
    frame.classList.toggle('is-collapsed', win.collapsed);
    pinBtn.setAttribute('aria-pressed', String(win.pinned));
    const pinLabel = t(win.pinned ? 'unpin' : 'pin');
    pinBtn.setAttribute('aria-label', pinLabel);
    pinBtn.title = `${pinLabel} (${keys('Mod', 'Shift', 'P')})`;
    const collapseLabel = t(win.collapsed ? 'expand' : 'collapse');
    collapseBtn.setAttribute('aria-label', collapseLabel);
    collapseBtn.title = collapseLabel;
  }

  async function togglePin() {
    const next = !win.pinned;
    win.pinned = next; // resposta imediata; reverte se o sistema recusar
    renderWindow();
    try {
      win.pinned = await invoke('set_pinned', { pinned: next });
    } catch (err) {
      win.pinned = !next;
      console.error('set_pinned', err);
    }
    renderWindow();
  }

  async function toggleCollapse() {
    win.collapsed = !win.collapsed;
    renderWindow();
    try {
      await invoke('set_collapsed', { collapsed: win.collapsed });
    } catch (err) {
      console.error('set_collapsed', err);
    }
  }

  const newNote = () => invoke('new_note').catch((err) => console.error('new_note', err));
  const closeWindow = () => invoke('close_manager').catch((err) => console.error('close_manager', err));

  window.TaxinhaChrome.attach({ frame, titlebar: $('titlebar'), grip: $('grip'), onClose: closeWindow });
  pinBtn.addEventListener('click', togglePin);
  collapseBtn.addEventListener('click', toggleCollapse);
  $('newBtn').addEventListener('click', newNote);
  $('closeBtn').addEventListener('click', closeWindow);

  window.addEventListener('focus', () => frame.classList.add('is-focused'));
  window.addEventListener('blur', () => frame.classList.remove('is-focused'));

  // -------------------------------------------------------------- idioma

  function applyLanguage(setting, lang) {
    I18n.set(lang);
    document.title = `${t('manager')} — Taxinha`;
    $('defaultText').lang = I18n.locale();
    $('newBtn').title = `${t('newNote')} (${keys('Mod', 'N')})`;
    $('languageSelect').value = setting;
    renderWindow();
    renderMonoName();
    render();
  }

  let languageSetting = 'system';
  $('languageSelect').addEventListener('change', (e) => {
    languageSetting = e.target.value;
    invoke('change_language', { language: languageSetting })
      .catch((err) => console.error('change_language', err));
  });

  // --------------------------------------------------------------- init

  async function init() {
    win = await invoke('load_manager');
    let lang;
    [languageSetting, lang] = await invoke('get_language');
    applyLanguage(languageSetting, lang);
    listen('language-changed', (e) => applyLanguage(languageSetting, e.payload));
    renderWindow();
    if (document.hasFocus()) frame.classList.add('is-focused');
    applyTheme(await invoke('get_theme'));
    listen('theme-changed', (e) => applyTheme(e.payload));
    listen('notes-changed', scheduleLoad);
    await Promise.all([load(), loadDefaults()]);
    if (!win.collapsed) search.focus();
  }

  init().catch((err) => console.error('init', err));
})();
