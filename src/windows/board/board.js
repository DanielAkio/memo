// Board window (src/windows/board/board.js): Trello-like kanban board for memories.

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const I18n = window.MemoI18n;
  const t = (k, v) => I18n.t(k, v);
  const $ = (id) => document.getElementById(id);
  const frame = $('frame');
  const titlebar = $('titlebar');
  const colorBtn = $('colorBtn');
  const colorMenu = $('colorMenu');
  const boardName = $('boardName');
  const nameInput = $('nameInput');

  const columnsTrack = $('columnsTrack');
  const boardBody = $('boardBody');
  const grip = $('grip');

  let currentBoard = null;
  let allNotes = [];
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

      activeDrag.height = rect.height;
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

      showSkeleton(targetColEl, targetColEl && cardBelow(targetColEl, e.clientY, activeDrag.noteId), activeDrag.height);
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

      // It lands where the skeleton shows it (none: dragged out of the board).
      const landing = skeletonSpot(drag.noteId);
      hideSkeleton();

      if (e.type === 'pointercancel') {
        renderColumns();
        setTimeout(() => { dragJustEnded = false; }, 150);
        return;
      }

      const targetCol = landing && currentBoard.columns.find((c) => c.id === landing.colId);
      if (targetCol) {
        for (const c of currentBoard.columns) {
          c.noteIds = c.noteIds.filter((id) => id !== drag.noteId);
        }
        const at = landing.before ? targetCol.noteIds.indexOf(landing.before) : -1;
        if (at === -1) targetCol.noteIds.push(drag.noteId);
        else targetCol.noteIds.splice(at, 0, drag.noteId);
        renderColumns();
        saveColumns();
      } else if (!landing) {
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

  // ------------------------------------------------------------- Setup & Init

  // Sharing (components/share.js): "Copied", and offers to import.
  MemoShare.attach({ invoke, listen });

  async function init() {
    const [, lang] = await invoke('get_language').catch(() => ['', 'en']);
    if (lang) I18n.set(lang);
    I18n.apply(document);
    MemoTheme.renderMono();

    window.addEventListener('resize', updateDropZones);
    boardBody.addEventListener('scroll', updateDropZones);

    listen('theme-changed', (e) => MemoTheme.apply(e.payload));
    listen('language-changed', (e) => {
      I18n.set(e.payload);
      MemoTheme.renderMono();
      reloadBoard(true);
    });
    listen('boards-changed', () => reloadBoard());
    listen('notes-changed', () => reloadNotes());
    listen('groups-changed', () => loadGroups());

    listen('board-drop-hover', (e) => {
      const [bid, cid, on, before] = e.payload;
      if (!currentBoard || bid !== currentBoard.id) return;
      const colEl = columnsTrack.querySelector(`.board-column[data-col-id="${cid}"]`);
      const card = colEl && before && colEl.querySelector(`.board-card[data-note-id="${before}"]`);
      if (on) showSkeleton(colEl, card || null);
      else if (colEl && skeleton.closest('.board-column') === colEl) hideSkeleton();
    });

    const theme = await invoke('get_theme').catch(() => '');
    if (theme) MemoTheme.apply(theme);

    await reloadNotes();
    await reloadBoard();
  }

  // ------------------------------------------------------------- Window Chrome

  const colors = new ColorMenu({
    frame,
    button: colorBtn,
    menu: colorMenu,
    input: $('customColor'),
    current: () => currentBoard && currentBoard.color,
    onPick: (color) => { currentBoard.color = color; renderColor(); },
    onOpen: () => groups.close(),
  });

  // "+" and Mod+N: a new memory beside the board, not on it.
  const newNote = () => invoke('new_note').catch((err) => console.error('new_note', err));

  // Titlebar (components/titlebar.js): pin, double-click renames, drag,
  // resize, middle click closes, and the right-click / "…" menu with the
  // board's commands, then all the app's.
  const bar = new TitleBar({
    frame,
    titlebar,
    grip,
    pin: {
      get: () => currentBoard && currentBoard.pinned,
      set: (pinned) => {
        currentBoard.pinned = pinned;
        bar.renderPin(pinned);
      },
    },
    rename: {
      name: boardName,
      input: nameInput,
      get: () => currentBoard && currentBoard.name,
      set: (name) => { currentBoard.name = name; renderTitle(); },
    },

    buttons: { newBtn: newNote },
    onNew: newNote,
    menuItems: () => [
      { label: t('rename'), run: () => bar.startRename() },
      { label: t('pin'), checked: !!(currentBoard && currentBoard.pinned), run: () => bar.togglePin() },
      { label: t('boardColor'), run: () => colors.open() },
      { label: t('newNote'), run: newNote },
      { label: t('addColumn'), run: () => onAddColumn('right') },
      { label: t('groupMenuTitle'), run: () => groups.toggle() },
      { label: t('share'), run: () => MemoShare.copy() },
      { label: t('bringAllToFront'), run: () => invoke('bring_notes_to_front').catch((err) => console.error(err)) },
      { label: t('moveToTrash'), run: () => bar.trash() },
      { label: t('close'), run: () => bar.close() },
    ],
    onMenuOpen: () => {
      colors.close();
      groups.close();
    },
    nativeMenuIn: 'input, textarea',
  });

  // ------------------------------------------------------------- Group Menu

  // The board's group in the footer, as in a note (components/group-picker.js).
  const groups = new GroupPicker({
    frame,
    button: $('footBtn'),
    menu: $('groupMenu'),
    items: $('groupItems'),
    label: $('edited'),
    tint: $('groupTint'),
    current: () => currentBoard && currentBoard.groupId,
    onPick(groupId) {
      if (!currentBoard) return;
      invoke('set_board_group', { groupId }).catch((err) => console.error('set_board_group', err));
    },
    onOpen: () => colors.close(),
  });

  async function loadGroups() {
    if (!currentBoard) return;
    try {
      const [list, groupId] = await Promise.all([invoke('list_groups'), invoke('get_board_group')]);
      currentBoard.groupId = groupId;
      groups.setGroups(list);
    } catch (err) {
      console.error('list_groups', err);
      groups.render();
    }
  }


  function renderColor() {
    if (!currentBoard) return;
    MemoColor.paint(frame, currentBoard.color);
    colors.render(currentBoard.color);
  }

  function renderTitle() {
    if (!currentBoard) return;
    const name = currentBoard.name || '';
    boardName.textContent = name || t('untitled');
    boardName.classList.toggle('is-empty', !name);
    $('newBtn').title = `${t('newNote')} (${I18n.keys('Mod', 'N')})`;
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

  // `force`: redraw the columns even if they didn't change (language). The
  // echo of this window's own save leaves them alone, so a column name being
  // edited stays open.
  async function reloadBoard(force = false) {
    try {
      const b = await invoke('load_board');
      if (b) {
        const same = currentBoard && JSON.stringify(currentBoard.columns) === JSON.stringify(b.columns);
        // Not redrawn: keep the column objects the drawn columns and cards
        // change (a copy here would leave their next change unsaved).
        if (same && !force) b.columns = currentBoard.columns;
        currentBoard = b;
        bar.renderPin(b.pinned);
        renderTitle();
        renderColor();
        if (force || !same) renderColumns();
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

  // A new column at the end ("right", the menu's "Add column") or at the
  // start ("left"), scrolled into view.
  function onAddColumn(side = 'right') {
    if (!currentBoard) return;
    const count = currentBoard.columns.length + 1;
    const newCol = {
      id: `col-${Date.now()}-${count}`,
      name: '',
      color: '',
      noteIds: [],
    };
    if (side === 'left') currentBoard.columns.unshift(newCol);
    else currentBoard.columns.push(newCol);
    renderColumns();
    saveColumns();
    const added = columnsTrack.querySelector(`.board-column[data-col-id="${newCol.id}"]`);
    if (added) added.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // A column to create, always at the far left and right of the columns.
  function addGhost(side) {
    const ghost = document.createElement('button');
    ghost.type = 'button';
    ghost.className = 'col-add';
    ghost.dataset.side = side;
    const label = t(side === 'left' ? 'addColumnLeft' : 'addColumnRight');
    ghost.title = label;
    ghost.setAttribute('aria-label', label);
    ghost.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5"/></svg>';
    ghost.addEventListener('click', () => onAddColumn(side));
    return ghost;
  }

  // ------------------------------------------------------------- Drop skeleton

  // Where a dragged memory will land: a card-sized placeholder in the column
  // under the pointer, before the first card whose middle is below it (the
  // same rule drag.rs / web.js apply to a memory window dragged in from the
  // desktop, with the cards sent in updateDropZones).
  const skeleton = document.createElement('div');
  skeleton.className = 'card-skeleton';

  // The card a drop at `y` in `colEl` goes before (null: the end).
  function cardBelow(colEl, y, skipId) {
    return [...colEl.querySelectorAll('.board-card')].find((c) => {
      if (c.dataset.noteId === skipId) return false;
      const r = c.getBoundingClientRect();
      return y < r.top + r.height / 2;
    }) || null;
  }

  function showSkeleton(colEl, before, height) {
    if (!colEl) {
      hideSkeleton();
      return;
    }
    const list = colEl.querySelector('.col-cards');
    skeleton.style.height = `${Math.round(height || 64)}px`;
    if (skeleton.parentNode !== list || skeleton.nextElementSibling !== before) {
      list.insertBefore(skeleton, before);
    }
    for (const c of columnsTrack.querySelectorAll('.board-column')) {
      c.classList.toggle('drag-over', c === colEl);
    }
  }

  function hideSkeleton() {
    skeleton.remove();
    for (const c of columnsTrack.querySelectorAll('.board-column.drag-over')) {
      c.classList.remove('drag-over');
    }
  }

  // The skeleton's place: its column and the memory after it (null = end).
  function skeletonSpot(skipId) {
    const colEl = skeleton.isConnected && skeleton.closest('.board-column');
    if (!colEl) return null;
    let next = skeleton.nextElementSibling;
    while (next && next.dataset.noteId === skipId) next = next.nextElementSibling;
    return { colId: colEl.dataset.colId, before: next ? next.dataset.noteId : null };
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
        cards: [...colEl.querySelectorAll('.board-card')].map((c) => {
          const cr = c.getBoundingClientRect();
          return { id: c.dataset.noteId, mid: (cr.top + cr.bottom) / 2 };
        }),
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
      // An empty name reads "Untitled", dimmed, as a window's name.
      const renderColTitle = () => {
        title.textContent = col.name || t('untitled');
        title.classList.toggle('is-empty', !col.name);
      };
      renderColTitle();

      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.className = 'col-input';
      titleInput.maxLength = 50;
      titleInput.placeholder = t('columnName');
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
        col.name = titleInput.value.trim();
        renderColTitle();
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
        MemoColor.paint(cardDot, note.color);

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

    columnsTrack.prepend(addGhost('left'));
    columnsTrack.append(addGhost('right'));
    setTimeout(updateDropZones, 50);
  }

  window.MemoZoom.attach(invoke);
  document.addEventListener('DOMContentLoaded', init);
})();