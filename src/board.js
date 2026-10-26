// Board window (src/board.js): Trello-like kanban board for memories.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const I18n = window.MemoI18n;
  const t = (k, v) => I18n.t(k, v);

  const $ = (id) => document.getElementById(id);
  const frame = $('frame');
  const titlebar = $('titlebar');
  const pinBtn = $('pinBtn');
  const colorBtn = $('colorBtn');
  const colorMenu = $('colorMenu');
  const customColorInput = $('customColor');
  const customSwatch = colorMenu.querySelector('.swatch[data-color="custom"]');
  const boardName = $('boardName');
  const nameInput = $('nameInput');
  const moreBtn = $('moreBtn');
  const closeBtn = $('closeBtn');
  const columnsTrack = $('columnsTrack');
  const boardBody = $('boardBody');
  const groupTint = $('groupTint');
  const groupMenu = $('groupMenu');
  const groupItems = $('groupItems');
  const footBtn = $('footBtn');
  const edited = $('edited');
  const grip = $('grip');

  let currentBoard = null;
  let groups = [];
  let allNotes = [];
  let draggedCard = null;
  let dragJustEnded = false;
  let activeDrag = null;

  window.addEventListener('pointermove', (e) => {
    if (!activeDrag) return;

    if (!activeDrag.isDragging) {
      const dist = Math.hypot(e.clientX - activeDrag.startX, e.clientY - activeDrag.startY);
      if (dist < 4) return;

      activeDrag.isDragging = true;
      dragJustEnded = true;

      const rect = activeDrag.cardEl.getBoundingClientRect();
      activeDrag.offsetX = e.clientX - rect.left;
      activeDrag.offsetY = e.clientY - rect.top;

      const avatar = activeDrag.cardEl.cloneNode(true);
      avatar.classList.add('card-drag-avatar');
      avatar.style.width = rect.width + 'px';
      avatar.style.left = (e.clientX - activeDrag.offsetX) + 'px';
      avatar.style.top = (e.clientY - activeDrag.offsetY) + 'px';
      document.body.appendChild(avatar);
      activeDrag.avatar = avatar;

      activeDrag.cardEl.classList.add('is-dragging');
      document.body.classList.add('is-card-dragging');
    }

    if (activeDrag.isDragging && activeDrag.avatar) {
      activeDrag.avatar.style.left = (e.clientX - activeDrag.offsetX) + 'px';
      activeDrag.avatar.style.top = (e.clientY - activeDrag.offsetY) + 'px';

      const isOutside = e.clientX < 0 || e.clientX > window.innerWidth ||
                        e.clientY < 0 || e.clientY > window.innerHeight;
      let targetColEl = null;
      if (!isOutside) {
        const els = document.elementsFromPoint(e.clientX, e.clientY);
        targetColEl = els.find((el) => el.classList.contains('board-column'));
      }

      for (const c of columnsTrack.querySelectorAll('.board-column')) {
        c.classList.toggle('drag-over', c === targetColEl);
      }
    }
  });

  const endPointerDrag = (e) => {
    if (!activeDrag) return;
    const drag = activeDrag;
    activeDrag = null;

    try { drag.cardEl.releasePointerCapture(drag.pointerId); } catch (_) {}

    if (drag.isDragging) {
      if (drag.avatar) drag.avatar.remove();
      drag.cardEl.classList.remove('is-dragging');
      document.body.classList.remove('is-card-dragging');

      for (const c of columnsTrack.querySelectorAll('.board-column.drag-over')) {
        c.classList.remove('drag-over');
      }

      if (e.type === 'pointercancel') {
        renderColumns();
        setTimeout(() => { dragJustEnded = false; }, 150);
        return;
      }

      const isOutsideWindow = e.clientX < 0 || e.clientX > window.innerWidth ||
                              e.clientY < 0 || e.clientY > window.innerHeight;
      let targetColEl = null;
      if (!isOutsideWindow) {
        const els = document.elementsFromPoint(e.clientX, e.clientY);
        targetColEl = els.find((el) => el.classList.contains('board-column'));
      }

      if (targetColEl) {
        const targetColId = targetColEl.dataset.colId;
        const sourceCol = currentBoard.columns.find((c) => c.id === drag.sourceColId);
        const targetCol = currentBoard.columns.find((c) => c.id === targetColId);
        if (targetCol) {
          if (sourceCol) {
            sourceCol.noteIds = sourceCol.noteIds.filter((id) => id !== drag.noteId);
          }
          const els = document.elementsFromPoint(e.clientX, e.clientY);
          const targetCardEl = els.find((el) => el.classList.contains('board-card') && el !== drag.cardEl);
          if (targetCardEl && targetCardEl.dataset.noteId && targetCardEl.dataset.noteId !== drag.noteId) {
            const r = targetCardEl.getBoundingClientRect();
            const idx = targetCol.noteIds.indexOf(targetCardEl.dataset.noteId);
            if (idx !== -1) {
              const at = e.clientY > (r.top + r.height / 2) ? idx + 1 : idx;
              targetCol.noteIds.splice(at, 0, drag.noteId);
            } else {
              targetCol.noteIds.push(drag.noteId);
            }
          } else {
            targetCol.noteIds.push(drag.noteId);
          }
          targetCol.noteIds = Array.from(new Set(targetCol.noteIds));
          renderColumns();
          saveColumns();
        }
      } else {
        // Dragged OUT of the board: immediately remove from board and open where placed on desktop
        const sourceCol = currentBoard.columns.find((c) => c.id === drag.sourceColId);
        if (sourceCol) {
          sourceCol.noteIds = sourceCol.noteIds.filter((id) => id !== drag.noteId);
        }
        renderColumns();
        saveColumns();

        const sx = typeof e.screenX === 'number' && e.screenX > 0
          ? Math.round(e.screenX - 80)
          : Math.round(window.screenX + e.clientX - 80);
        const sy = typeof e.screenY === 'number' && e.screenY > 0
          ? Math.round(e.screenY - 20)
          : Math.round(window.screenY + e.clientY - 20);
        invoke('take_note_out_of_board', { id: drag.noteId, screenX: sx, screenY: sy })
          .catch((err) => console.error('take_note_out_of_board', err));
      }

      setTimeout(() => { dragJustEnded = false; }, 150);
    }
  };

  window.addEventListener('pointerup', endPointerDrag);
  window.addEventListener('pointercancel', endPointerDrag);

  function isCustomColor(c) {
    return typeof c === 'string' && c.startsWith('#');
  }

  // ------------------------------------------------------------- Setup & Init

  async function init() {
    const [, lang] = await invoke('get_language').catch(() => ['', 'en']);
    if (lang) I18n.set(lang);
    I18n.apply(document);

    MemoChrome.attach({
      frame,
      titlebar,
      grip,
      resizeEdges: ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'],
    });

    MemoChrome.titleMenu({
      more: moreBtn,
      titlebar,
      items: () => [
        { label: t('addColumn'), run: onAddColumn },
        { label: t('groupMenuTitle'), run: () => (groupMenu.hidden ? openGroupMenu() : closeGroupMenu()) },
        { label: t('bringAllToFront'), run: () => invoke('bring_notes_to_front').catch((err) => console.error(err)) },
        { label: t('close'), run: closeBoard },
      ],
      onOpen: () => {
        closeColors();
        closeGroupMenu();
      },
    });

    pinBtn.addEventListener('click', togglePin);
    closeBtn.addEventListener('click', closeBoard);

    setupRename();
    setupColorMenu();
    setupGroupMenu();

    window.addEventListener('focus', () => frame.classList.add('is-focused'));
    window.addEventListener('blur', () => frame.classList.remove('is-focused'));
    window.addEventListener('resize', updateDropZones);
    boardBody.addEventListener('scroll', updateDropZones);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeColors();
        closeGroupMenu();
      }
    });

    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('input, textarea')) e.preventDefault();
    });

    listen('theme-changed', (e) => applyTheme(e.payload));
    listen('boards-changed', () => reloadBoard());
    listen('notes-changed', () => reloadNotes());
    listen('groups-changed', () => loadGroups());

    listen('board-drop-hover', (e) => {
      const [bid, cid, on] = e.payload;
      if (currentBoard && bid === currentBoard.id) {
        for (const colEl of columnsTrack.querySelectorAll('.board-column')) {
          if (colEl.dataset.colId === cid) {
            colEl.classList.toggle('drag-over', on);
          } else if (on) {
            colEl.classList.remove('drag-over');
          }
        }
      }
    });

    const theme = await invoke('get_theme').catch(() => '');
    if (theme) applyTheme(theme);

    await reloadNotes();
    await reloadBoard();
  }

  function applyTheme(theme) {
    if (theme && theme !== 'system') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  // ------------------------------------------------------------- Window Chrome

  async function togglePin() {
    if (!currentBoard) return;
    const next = !currentBoard.pinned;
    try {
      await invoke('set_pinned', { pinned: next });
      currentBoard.pinned = next;
      pinBtn.setAttribute('aria-pressed', String(next));
      pinBtn.title = t(next ? 'unpin' : 'pin');
    } catch (err) {
      console.error('set_pinned', err);
    }
  }

  async function closeBoard() {
    try {
      await invoke('close_board');
    } catch (err) {
      console.error('close_board', err);
    }
  }

  function openColors() {
    closeGroupMenu();
    colorMenu.hidden = false;
    colorBtn.setAttribute('aria-expanded', 'true');
    renderMonoName();
  }

  function closeColors() {
    colorMenu.hidden = true;
    colorBtn.setAttribute('aria-expanded', 'false');
  }

  const systemLight = matchMedia('(prefers-color-scheme: light)');
  function renderMonoName() {
    const theme = document.documentElement.dataset.theme;
    const light = theme ? theme === 'light' : systemLight.matches;
    const sw = document.querySelector('.swatch[data-color="mono"]');
    if (sw) {
      const name = t(light ? 'black' : 'white');
      sw.setAttribute('aria-label', name);
      sw.title = name;
    }
  }

  function setupColorMenu() {
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      colorMenu.hidden ? openColors() : closeColors();
    });

    $('swatches').addEventListener('click', async (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw || !currentBoard) return;
      if (sw === customSwatch) {
        customColorInput.value = isCustomColor(currentBoard.color) ? currentBoard.color : '#f2c94c';
        MemoColorPicker.open(customColorInput, sw);
        return;
      }
      await setBoardColor(sw.dataset.color || '');
      closeColors();
    });

    customColorInput.addEventListener('change', async () => {
      await setBoardColor(customColorInput.value.toLowerCase());
      closeColors();
    });

    document.addEventListener('mousedown', (e) => {
      if (!colorMenu.hidden && !colorMenu.contains(e.target) && !colorBtn.contains(e.target)) {
        closeColors();
      }
      if (!groupMenu.hidden && !groupMenu.contains(e.target) && (!footBtn || !footBtn.contains(e.target))) {
        closeGroupMenu();
      }
    });

    systemLight.addEventListener('change', renderMonoName);
  }

  // ------------------------------------------------------------- Group Menu

  const groupLabel = (g) => g.name || t('untitled');

  async function loadGroups() {
    if (!currentBoard) return;
    try {
      [groups, currentBoard.groupId] = await Promise.all([
        invoke('list_groups'),
        invoke('get_board_group'),
      ]);
      groups = groups.filter((g) => !g.trashedAt);
    } catch (err) {
      console.error('list_groups', err);
    }
    updateGroupTint();
  }

  function updateGroupTint() {
    if (!currentBoard) return;
    const group = currentBoard.groupId ? groups.find((g) => g.id === currentBoard.groupId) : null;
    const groupColor = group ? group.color || '' : '';
    groupTint.dataset.color = isCustomColor(groupColor) ? 'custom' : groupColor;
    if (isCustomColor(groupColor)) groupTint.style.setProperty('--note-color', groupColor);
    else groupTint.style.removeProperty('--note-color');

    if (footBtn) {
      footBtn.classList.toggle('has-group', Boolean(group));
      const folder = footBtn.querySelector('.foot-folder');
      if (folder) {
        folder.dataset.color = isCustomColor(groupColor) ? 'custom' : groupColor;
        if (isCustomColor(groupColor)) folder.style.setProperty('--note-color', groupColor);
        else folder.style.removeProperty('--note-color');
      }
      footBtn.title = group ? t('groupIs', { name: groupLabel(group) }) : t('addToGroup');
    }
    if (edited) {
      edited.textContent = group ? groupLabel(group) : t('noGroup');
    }
  }

  function groupItem(label, value, { checked = false, muted = false } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${muted ? ' muted' : ''}`;
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', String(checked));
    btn.dataset.group = value;
    const text = document.createElement('span');
    text.textContent = label;
    btn.append(text);
    return btn;
  }

  function openGroupMenu() {
    closeColors();
    const items = groups
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, I18n.locale(), { sensitivity: 'base', numeric: true }))
      .map((g) => groupItem(groupLabel(g), g.id, { checked: g.id === currentBoard.groupId }));
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    groupItems.replaceChildren(
      ...items,
      ...(items.length ? [sep] : []),
      groupItem(t('noGroup'), '', { checked: !currentBoard.groupId, muted: true }),
      groupItem(t('newGroup'), 'new', { muted: true }),
    );
    groupMenu.hidden = false;
    frame.classList.add('menu-open');
    if (footBtn) footBtn.setAttribute('aria-expanded', 'true');
  }

  function closeGroupMenu() {
    if (groupMenu.hidden) return;
    groupMenu.hidden = true;
    frame.classList.remove('menu-open');
    if (footBtn) footBtn.setAttribute('aria-expanded', 'false');
  }

  function setupGroupMenu() {
    if (footBtn) {
      footBtn.addEventListener('click', () => (groupMenu.hidden ? openGroupMenu() : closeGroupMenu()));
    }

    groupItems.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item || !currentBoard) return;
      closeGroupMenu();
      if (item.dataset.group === currentBoard.groupId) return;
      invoke('set_board_group', { groupId: item.dataset.group })
        .catch((err) => console.error('set_board_group', err));
    });
  }

  async function setBoardColor(color) {
    if (!currentBoard) return;
    try {
      await invoke('set_board_color', { color });
      currentBoard.color = color;
      renderColor();
    } catch (err) {
      console.error('set_board_color', err);
    }
  }

  function renderColor() {
    if (!currentBoard) return;
    const color = currentBoard.color || '';
    const custom = isCustomColor(color);
    frame.dataset.color = custom ? 'custom' : color;
    if (custom) frame.style.setProperty('--note-color', color);
    else frame.style.removeProperty('--note-color');

    if (custom && customSwatch) customSwatch.style.setProperty('--sw', color);
    else if (customSwatch) customSwatch.style.removeProperty('--sw');

    for (const sw of colorMenu.querySelectorAll('.swatch')) {
      const active = sw === customSwatch ? custom : sw.dataset.color === color;
      sw.setAttribute('aria-checked', String(active));
    }
  }

  function setupRename() {
    boardName.addEventListener('dblclick', startRename);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitRename();
      else if (e.key === 'Escape') cancelRename();
    });
    nameInput.addEventListener('blur', commitRename);
  }

  function startRename() {
    nameInput.value = currentBoard ? currentBoard.name : '';
    boardName.hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  async function commitRename() {
    if (nameInput.hidden) return;
    const clean = nameInput.value.trim();
    nameInput.hidden = true;
    boardName.hidden = false;
    if (currentBoard && clean !== currentBoard.name) {
      try {
        const saved = await invoke('rename_board', { name: clean });
        currentBoard.name = saved;
        renderTitle();
      } catch (err) {
        console.error('rename_board', err);
      }
    }
  }

  function cancelRename() {
    nameInput.hidden = true;
    boardName.hidden = false;
  }

  function renderTitle() {
    if (!currentBoard) return;
    const name = currentBoard.name || '';
    boardName.textContent = name || t('untitled');
    boardName.classList.toggle('is-empty', !name);
  }

  // ------------------------------------------------------------- Board Data & Render

  async function reloadNotes() {
    try {
      allNotes = await invoke('list_notes');
      renderColumns();
    } catch (err) {
      console.error('list_notes', err);
    }
  }

  async function reloadBoard() {
    try {
      const b = await invoke('load_board');
      if (b) {
        currentBoard = b;
        pinBtn.setAttribute('aria-pressed', String(b.pinned));
        pinBtn.title = t(b.pinned ? 'unpin' : 'pin');
        renderTitle();
        renderColor();
        renderColumns();
        await loadGroups();
      }
    } catch (err) {
      console.error('load_board', err);
    }
  }

  function saveColumns() {
    if (!currentBoard) return;
    invoke('save_board_columns', { columns: currentBoard.columns })
      .catch((err) => console.error('save_board_columns', err));
  }

  function onAddColumn() {
    if (!currentBoard) return;
    const count = currentBoard.columns.length + 1;
    const newCol = {
      id: `col-${Date.now()}-${count}`,
      name: `${t('columnName')} ${count}`,
      color: '',
      noteIds: [],
    };
    currentBoard.columns.push(newCol);
    renderColumns();
    saveColumns();
  }

  function updateDropZones() {
    if (!currentBoard) return;
    const cols = columnsTrack.querySelectorAll('.board-column');
    const zones = [];
    for (const colEl of cols) {
      const r = colEl.getBoundingClientRect();
      zones.push({
        id: colEl.dataset.colId,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
      });
    }
    invoke('update_board_drop_zones', { zones }).catch(() => {});
  }

  function renderColumns() {
    if (!currentBoard) return;
    columnsTrack.innerHTML = '';
    const noteMap = new Map(allNotes.map((n) => [n.id, n]));

    for (const col of currentBoard.columns) {
      const colEl = document.createElement('div');
      colEl.className = 'board-column';
      colEl.dataset.colId = col.id;

      // Header
      const head = document.createElement('div');
      head.className = 'col-head';

      const dot = document.createElement('span');
      dot.className = 'col-dot';

      const titleWrap = document.createElement('div');
      titleWrap.className = 'col-title-wrap';

      const title = document.createElement('span');
      title.className = 'col-title';
      title.textContent = col.name || t('columnName');

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'col-input';
      titleInput.maxLength = 50;
      titleInput.hidden = true;

      title.addEventListener('click', () => {
        titleInput.value = col.name;
        title.hidden = true;
        titleInput.hidden = false;
        titleInput.focus();
        titleInput.select();
      });

      const commitColTitle = () => {
        if (titleInput.hidden) return;
        const clean = titleInput.value.trim() || t('columnName');
        col.name = clean;
        title.textContent = clean;
        titleInput.hidden = true;
        title.hidden = false;
        saveColumns();
      };

      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitColTitle();
        else if (e.key === 'Escape') {
          titleInput.hidden = true;
          title.hidden = false;
        }
      });
      titleInput.addEventListener('blur', commitColTitle);

      titleWrap.append(title, titleInput);

      const count = document.createElement('span');
      count.className = 'col-count';
      count.textContent = String(col.noteIds.length);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'col-menu-btn';
      deleteBtn.title = t('deleteColumn');
      deleteBtn.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5"/></svg>';
      deleteBtn.addEventListener('click', () => {
        currentBoard.columns = currentBoard.columns.filter((c) => c.id !== col.id);
        renderColumns();
        saveColumns();
      });

      head.append(dot, titleWrap, count, deleteBtn);

      // Column drop handling for dragging cards between columns
      colEl.addEventListener('dragover', (e) => {
        if (draggedCard || e.dataTransfer.types.includes('text/plain') || e.dataTransfer.types.includes('application/x-memo-card')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          colEl.classList.add('drag-over');
        }
      });

      colEl.addEventListener('dragleave', (e) => {
        if (!colEl.contains(e.relatedTarget)) {
          colEl.classList.remove('drag-over');
        }
      });

      colEl.addEventListener('drop', (e) => {
        e.preventDefault();
        colEl.classList.remove('drag-over');

        let payload = draggedCard;
        if (!payload) {
          try {
            const raw = e.dataTransfer.getData('text/plain');
            if (raw) payload = JSON.parse(raw);
          } catch (_) {}
        }
        if (!payload || !payload.noteId) return;

        const { noteId, sourceColId } = payload;
        const targetColId = col.id;

        const sourceCol = currentBoard.columns.find((c) => c.id === sourceColId);
        const targetCol = currentBoard.columns.find((c) => c.id === targetColId);
        if (!targetCol) return;

        if (sourceCol) {
          sourceCol.noteIds = sourceCol.noteIds.filter((id) => id !== noteId);
        }

        const targetCardEl = e.target.closest('.board-card');
        if (targetCardEl && targetCardEl.dataset.noteId && targetCardEl.dataset.noteId !== noteId) {
          const rect = targetCardEl.getBoundingClientRect();
          const relY = e.clientY - rect.top;
          const targetNoteId = targetCardEl.dataset.noteId;
          const insertIdx = targetCol.noteIds.indexOf(targetNoteId);
          if (insertIdx !== -1) {
            const at = relY > rect.height / 2 ? insertIdx + 1 : insertIdx;
            targetCol.noteIds.splice(at, 0, noteId);
          } else {
            targetCol.noteIds.push(noteId);
          }
        } else {
          if (!targetCol.noteIds.includes(noteId)) {
            targetCol.noteIds.push(noteId);
          }
        }

        targetCol.noteIds = Array.from(new Set(targetCol.noteIds));

        renderColumns();
        saveColumns();
      });

      // Cards list
      const cardsList = document.createElement('div');
      cardsList.className = 'col-cards';

      // Render cards
      for (const noteId of col.noteIds) {
        const note = noteMap.get(noteId);
        if (!note || note.trashedAt) continue;

        const card = document.createElement('div');
        card.className = 'board-card';
        card.dataset.noteId = note.id;

        card.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          if (e.target.closest('.card-del-btn')) return;
          try { card.setPointerCapture(e.pointerId); } catch (_) {}
          activeDrag = {
            cardEl: card,
            pointerId: e.pointerId,
            noteId: note.id,
            sourceColId: col.id,
            startX: e.clientX,
            startY: e.clientY,
            offsetX: 0,
            offsetY: 0,
            avatar: null,
            isDragging: false,
          };
        });

        card.addEventListener('dragstart', (e) => {
          draggedCard = { noteId: note.id, sourceColId: col.id };
          dragJustEnded = true;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', JSON.stringify({
              noteId: note.id,
              sourceColId: col.id,
            }));
            e.dataTransfer.setData('application/x-memo-card', note.id);
          }
        });

        card.addEventListener('dragend', () => {
          for (const c of columnsTrack.querySelectorAll('.board-column.drag-over')) {
            c.classList.remove('drag-over');
          }
          setTimeout(() => {
            draggedCard = null;
            dragJustEnded = false;
          }, 120);
        });

        // Left click opens the note; clicking outside note returns it to the board
        card.addEventListener('click', (e) => {
          if (dragJustEnded) return;
          if (e.target.closest('.card-del-btn')) return;
          invoke('open_board_note', { id: note.id }).catch((err) => console.error('open_board_note', err));
        });

        // Top: dot, title, remove button
        const cardTop = document.createElement('div');
        cardTop.className = 'card-top';

        const cardDot = document.createElement('span');
        cardDot.className = 'card-dot';
        cardDot.dataset.color = isCustomColor(note.color) ? 'custom' : note.color || '';
        if (isCustomColor(note.color)) cardDot.style.setProperty('--note-color', note.color);

        const cardTitle = document.createElement('span');
        cardTitle.className = 'card-title';
        const displayTitle = (note.title || '').trim();
        cardTitle.textContent = displayTitle || t('untitled');
        cardTitle.classList.toggle('is-empty', !displayTitle);

        const cardDel = document.createElement('button');
        cardDel.type = 'button';
        cardDel.className = 'card-del-btn';
        cardDel.title = t('removeFromBoard');
        cardDel.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5"/></svg>';
        cardDel.addEventListener('pointerdown', (e) => e.stopPropagation());
        cardDel.addEventListener('click', (e) => {
          e.stopPropagation();
          col.noteIds = col.noteIds.filter((id) => id !== note.id);
          renderColumns();
          saveColumns();
        });

        cardTop.append(cardDot, cardTitle, cardDel);
        card.append(cardTop);

        // Preview snippet rendering text components with limited height
        const cardSnippet = window.MemoCard
          ? window.MemoCard.render(note, { skipFirst: false, className: 'card-snippet' })
          : null;
        if (cardSnippet) {
          card.append(cardSnippet);
        } else {
          const textSnippet = (note.text || '').trim();
          if (textSnippet) {
            const fallback = document.createElement('div');
            fallback.className = 'card-snippet';
            fallback.textContent = textSnippet;
            card.append(fallback);
          }
        }

        cardsList.append(card);
      }

      colEl.append(head, cardsList);
      columnsTrack.append(colEl);
    }

    setTimeout(updateDropZones, 50);
  }

  window.MemoZoom.attach(invoke);
  document.addEventListener('DOMContentLoaded', init);
})();