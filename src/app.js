// Taxinha — lógica de uma janela de nota.
// Cada nota é uma janela própria; o Rust guarda texto, posição, tamanho e estado.

(() => {
  const { invoke } = window.__TAURI__.core;
  const appWindow = window.__TAURI__.window.getCurrentWindow();

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const keys = (...parts) => (isMac
    ? parts.map((p) => ({ Mod: '⌘', Shift: '⇧' }[p] || p)).join('')
    : parts.map((p) => ({ Mod: 'Ctrl' }[p] || p)).join('+'));

  const $ = (id) => document.getElementById(id);
  const frame = $('frame');
  const titlebar = $('titlebar');
  const text = $('text');
  const pinBtn = $('pinBtn');
  const menu = $('menu');
  const menuBtn = $('menuBtn');
  const deleteItem = $('deleteItem');
  const deleteLabel = $('deleteLabel');

  let note = null;
  let saveTimer = null;
  let textDirty = false;
  let confirmTimer = null;

  // ------------------------------------------------------------ helpers

  const firstLine = (t) => t.split('\n').map((s) => s.trim()).find(Boolean) || 'Nota vazia';
  const wordCount = (t) => (t.trim().match(/\S+/g) || []).length;

  const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });

  function editedLabel(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return `editada ${sameDay ? timeFmt.format(d) : dateFmt.format(d).replace('.', '')}`;
  }

  // ------------------------------------------------------------- render

  function render() {
    frame.dataset.color = note.color || '';
    frame.classList.toggle('is-collapsed', note.collapsed);

    $('noteId').textContent = `TXN-${note.seq}`;
    $('noteTitle').textContent = firstLine(note.text);
    document.title = `${firstLine(note.text)} — Taxinha`;

    pinBtn.setAttribute('aria-pressed', String(note.pinned));
    const pinLabel = note.pinned ? 'Desafixar' : 'Fixar acima de tudo';
    pinBtn.setAttribute('aria-label', pinLabel);
    pinBtn.title = `${pinLabel} (${keys('Mod', 'Shift', 'P')})`;

    for (const sw of document.querySelectorAll('.swatch')) {
      sw.setAttribute('aria-checked', String(sw.dataset.color === (note.color || '')));
    }
    $('collapseItem').firstElementChild.textContent = note.collapsed ? 'Expandir nota' : 'Recolher nota';
    renderMeta();
  }

  function renderMeta() {
    const n = wordCount(note.text);
    $('count').textContent = `${n} ${n === 1 ? 'palavra' : 'palavras'}`;
    $('edited').textContent = note.text.trim() ? editedLabel(note.updatedAt) : 'nota nova';
    $('noteTitle').textContent = firstLine(note.text);
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
      await invoke('save_text', { text: note.text });
    } catch (err) {
      textDirty = true;
      console.error('save_text', err);
    }
  }

  // ------------------------------------------------------------ actions

  async function togglePin() {
    const next = !note.pinned;
    note.pinned = next; // resposta imediata; reverte se o sistema recusar
    render();
    try {
      note.pinned = await invoke('set_pinned', { pinned: next });
    } catch (err) {
      note.pinned = !next;
      console.error('set_pinned', err);
    }
    render();
  }

  async function toggleCollapse() {
    closeMenu();
    note.collapsed = !note.collapsed;
    render();
    try {
      await invoke('set_collapsed', { collapsed: note.collapsed });
    } catch (err) {
      console.error('set_collapsed', err);
    }
    if (!note.collapsed) text.focus();
  }

  async function newNote() {
    closeMenu();
    await flushText();
    invoke('new_note').catch((err) => console.error('new_note', err));
  }

  async function setColor(color) {
    note.color = color;
    render();
    invoke('set_color', { color }).catch((err) => console.error('set_color', err));
  }

  function resetDelete() {
    clearTimeout(confirmTimer);
    deleteItem.classList.remove('confirming');
    deleteLabel.textContent = 'Excluir nota';
  }

  function requestDelete() {
    // Nota vazia sai direto; com texto, pede um segundo clique.
    if (note.text.trim() && !deleteItem.classList.contains('confirming')) {
      deleteItem.classList.add('confirming');
      deleteLabel.textContent = 'Clique de novo para excluir';
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(resetDelete, 3000);
      return;
    }
    clearTimeout(saveTimer);
    textDirty = false;
    invoke('delete_note').catch((err) => console.error('delete_note', err));
  }

  // --------------------------------------------------------------- menu

  function openMenu() {
    menu.hidden = false;
    frame.classList.add('menu-open');
    menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    frame.classList.remove('menu-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    resetDelete();
  }

  // ------------------------------------------------------------- events

  text.addEventListener('input', () => {
    note.text = text.value;
    note.updatedAt = Date.now();
    renderMeta();
    document.title = `${firstLine(note.text)} — Taxinha`;
    scheduleSave();
  });
  text.addEventListener('blur', flushText);

  pinBtn.addEventListener('click', togglePin);
  $('newBtn').addEventListener('click', newNote);
  $('newItem').addEventListener('click', newNote);
  $('collapseItem').addEventListener('click', toggleCollapse);
  deleteItem.addEventListener('click', requestDelete);

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden ? openMenu() : closeMenu();
  });
  $('swatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (sw) setColor(sw.dataset.color);
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
  });

  // Barra de título: arrastar move a nota, clique duplo recolhe/expande.
  titlebar.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.actions')) return;
    e.preventDefault();
    if (e.detail === 2) toggleCollapse();
    else appWindow.startDragging();
  });

  $('grip').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    appWindow.startResizeDragging('SouthEast');
  });

  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && e.shiftKey && key === 'p') { e.preventDefault(); togglePin(); }
    else if (mod && !e.shiftKey && key === 'n') { e.preventDefault(); newNote(); }
    else if (e.key === 'Escape') closeMenu();
  });

  // Menu de contexto nativo só dentro do texto (copiar, colar, ortografia).
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('textarea')) e.preventDefault();
  });

  window.addEventListener('focus', () => frame.classList.add('is-focused'));
  window.addEventListener('blur', () => { frame.classList.remove('is-focused'); flushText(); });
  window.addEventListener('beforeunload', () => { if (textDirty) invoke('save_text', { text: note.text }); });

  // Atualiza o "editada às…" na virada do dia.
  setInterval(() => note && renderMeta(), 60_000);

  // --------------------------------------------------------------- init

  async function init() {
    for (const k of document.querySelectorAll('kbd[data-shortcut]')) {
      k.textContent = keys('Mod', k.dataset.shortcut);
    }
    $('newBtn').title = `Nova nota (${keys('Mod', 'N')})`;
    $('menuBtn').title = 'Mais opções';

    note = await invoke('load_note');
    if (!note) return;
    text.value = note.text;
    render();
    if (document.hasFocus()) frame.classList.add('is-focused');
    if (!note.collapsed) {
      text.focus();
      text.setSelectionRange(text.value.length, text.value.length);
    }
  }

  init().catch((err) => console.error('init', err));
})();
