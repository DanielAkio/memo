// Stage for the site's demo GIFs and UI tests: a fake desktop where each
// Memo window is an iframe of the real app page (src/), backed by the fake
// Tauri API in mock.js.
(() => {
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') || 'dark';
  const lang = q.get('lang') || 'en';
  document.documentElement.dataset.theme = theme;
  const desk = document.getElementById('desk');
  const now = Date.now();

  const M = {
    theme, lang, notes: {}, groups: {}, boards: {}, wins: {}, listeners: [],
    manager: { x: null, y: null, width: 560, height: 420, pinned: false, color: 'iris', layout: 'cards' },
    view: null, hooks: {},
  };
  window.Memo = M;

  M.addNote = (n) => {
    M.notes[n.id] = Object.assign({
      seq: 1, title: '', text: '', html: '', x: null, y: null, width: 300, height: 240, pinned: false,
      color: '', createdAt: now, updatedAt: now, trashedAt: null, welcomeCopy: false, groupId: '', hidden: false,
    }, n);
    return M.notes[n.id];
  };
  M.addGroup = (g) => {
    M.groups[g.id] = Object.assign({
      name: '', x: null, y: null, width: 300, open: true, pinned: false, color: '',
      createdAt: now, updatedAt: now, trashedAt: null, hidden: false,
    }, g);
    return M.groups[g.id];
  };
  M.addBoard = (b) => {
    M.boards[b.id] = Object.assign({
      name: '', x: null, y: null, width: 760, height: 520, pinned: false, color: '',
      groupId: '',
      columns: [
        { id: 'col-1', name: 'To Do', color: '', noteIds: [] },
        { id: 'col-2', name: 'In Progress', color: '', noteIds: [] },
        { id: 'col-3', name: 'Done', color: '', noteIds: [] },
      ],
      createdAt: now, updatedAt: now, trashedAt: null, hidden: false,
    }, b);
    return M.boards[b.id];
  };

  M.listen = (ev, cb, w) => {
    const l = { ev, cb, w };
    M.listeners.push(l);
    return () => { M.listeners = M.listeners.filter((x) => x !== l); };
  };
  M.emit = (ev, payload) => {
    for (const l of M.listeners.slice()) {
      if (l.ev !== ev) continue;
      try { if (l.w.closed || !l.w.document) continue; l.cb({ payload }); } catch (e) { /* frame gone */ }
    }
  };

  const idOf = (label) => label.replace(/^(note|group|board)-/, '');
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const members = (gid) => Object.values(M.notes).filter((n) => n.groupId === gid && !n.trashedAt);
  const boardMembers = (gid) => Object.values(M.boards).filter((b) => b.groupId === gid && !b.trashedAt);
  const allMembersCount = (gid) => members(gid).length + boardMembers(gid).length;

  M.invoke = async (label, cmd, a) => {
    const id = idOf(label);
    const n = M.notes[id];
    const g = M.groups[id];
    const b = M.boards[id];
    const hook = M.hooks[cmd];
    if (hook) { const r = await hook(label, a); if (r !== undefined) return r; }
    switch (cmd) {
      case 'get_language': return [M.lang, M.lang];
      case 'get_theme': return M.theme;
      case 'get_zoom': return 1;
      case 'load_note': return n ? copy(n) : null;
      case 'get_note_group': return n ? n.groupId : '';
      case 'get_board_group': return b ? (b.groupId || '') : '';
      case 'set_board_group': if (b) { b.groupId = a.groupId; M.emit('groups-changed'); M.emit('boards-changed'); } return null;
      case 'list_groups': return Object.values(M.groups).map(copy);
      case 'list_boards': return Object.values(M.boards).map(copy);
      case 'load_board': return b ? copy(b) : null;
      case 'save_board_columns': if (b) { b.columns = a.columns; b.updatedAt = Date.now(); M.emit('boards-changed'); } return null;
      case 'new_board': {
        const nb = M.addBoard({ id: `b-${Date.now()}` });
        M.openWin(`board-${nb.id}`, '/src/windows/board/board.html', { x: 40, y: 40, w: 760, h: 520 });
        M.emit('boards-changed');
        return copy(nb);
      }
      case 'open_board': {
        const target = M.boards[a.id];
        if (target) { target.hidden = false; M.openWin(`board-${target.id}`, '/src/windows/board/board.html', { x: 40, y: 40, w: 760, h: 520 }); M.emit('boards-changed'); }
        return null;
      }
      case 'trash_board_id': {
        if (M.boards[a.id]) { M.boards[a.id].trashedAt = Date.now(); M.closeWin(`board-${a.id}`); M.emit('boards-changed'); }
        return null;
      }
      case 'restore_board_id': {
        if (M.boards[a.id]) { M.boards[a.id].trashedAt = null; M.emit('boards-changed'); }
        return null;
      }
      case 'delete_board_forever': {
        delete M.boards[a.id];
        M.emit('boards-changed');
        return null;
      }
      case 'update_board_drop_zones': return null;
      case 'list_notes_including_trash':
      case 'list_notes': return Object.values(M.notes).map((x) => Object.assign(copy(x), { html: '' }));
      case 'save_text': Object.assign(n, { text: a.text, html: a.html, updatedAt: Date.now() }); M.emit('notes-changed'); return null;
      case 'rename':
        if (n) { n.title = a.name.trim(); n.updatedAt = Date.now(); M.emit('notes-changed'); return n.title; }
        if (g) { g.name = a.name.trim(); M.emit('groups-changed'); return g.name; }
        if (b) { b.name = a.name.trim(); b.updatedAt = Date.now(); M.emit('boards-changed'); return b.name; }
        return '';
      case 'set_color':
        if (n) { n.color = a.color; M.emit('notes-changed'); }
        else if (g) { g.color = a.color; M.emit('groups-changed'); }
        else if (b) { b.color = a.color; M.emit('boards-changed'); }
        else M.manager.color = a.color;
        return null;
      case 'set_pinned': {
        const o = n || g || b || M.manager;
        o.pinned = a.pinned;
        const w = M.wins[label];
        if (w) { w.el.classList.toggle('pinned', a.pinned); M.raise(label); }
        return a.pinned;
      }
      case 'set_note_group': n.groupId = a.groupId; M.emit('groups-changed'); return null;
      case 'load_group': return g ? [copy(g), allMembersCount(g.id)] : null;
      case 'toggle_group': g.open = !g.open; M.emit('groups-changed'); return g.open;
      case 'trash_group_window':
        if (g) {
          g.trashedAt = Date.now();
          for (const m of members(g.id)) m.trashedAt = Date.now();
          for (const bm of boardMembers(g.id)) { bm.trashedAt = Date.now(); M.closeWin(`board-${bm.id}`); }
          M.closeWin(label);
          M.emit('groups-changed');
          M.emit('notes-changed');
          M.emit('boards-changed');
        }
        return null;
      case 'load_manager': return copy(M.manager);
      case 'set_manager_layout': M.manager.layout = a.layout; M.emit('layout-changed', a.layout); return null;
      case 'take_manager_view': { const v = M.view; M.view = null; return v; }
      case 'change_theme': M.theme = a.theme; M.emit('theme-changed', a.theme); return null;
      case 'change_language': M.lang = a.language === 'en' ? 'en' : 'pt'; M.emit('language-changed', M.lang); return M.lang;
      case 'get_default_color': return 'iris';
      case 'get_new_note_defaults': return ['', '', ''];
      case 'get_group_defaults': return ['random', ''];
      case 'get_data_dir': return ['C:\\Users\\ana\\AppData\\Roaming\\memo', true];
      case 'get_cloud_account': return [['google', 'microsoft'], []];
      case 'get_autostart': return true;
      case 'get_magnet': return true;
      case 'get_updates': return [true, { checking: false, available: null, progress: null, upToDate: false, error: null }];
      case 'get_ai_control': return [false, 'memo'];
      case 'get_ai_clients': return [];
      case 'move_to_trash': M.notes[a.id].trashedAt = Date.now(); M.closeWin(`note-${a.id}`); M.emit('notes-changed'); return null;
      case 'restore_note': M.notes[a.id].trashedAt = null; M.notes[a.id].hidden = true; M.emit('notes-changed'); return null;
      case 'delete_forever': delete M.notes[a.id]; M.emit('notes-changed'); return null;
      case 'delete_group_forever': delete M.groups[a.id]; M.emit('groups-changed'); return null;
      case 'empty_board_trash':
        for (const [k, v] of Object.entries(M.boards)) { if (v.trashedAt) delete M.boards[k]; }
        M.emit('boards-changed');
        return null;
      case 'empty_trash':
        for (const [k, v] of Object.entries(M.notes)) { if (v.trashedAt) delete M.notes[k]; }
        M.emit('notes-changed');
        return null;
      case 'trash_group_id':
        M.groups[a.id].trashedAt = Date.now();
        for (const m of members(a.id)) m.trashedAt = Date.now();
        for (const b of boardMembers(a.id)) { b.trashedAt = Date.now(); M.closeWin(`board-${b.id}`); }
        M.closeWin(`group-${a.id}`);
        M.emit('groups-changed');
        M.emit('notes-changed');
        M.emit('boards-changed');
        return null;
      case 'restore_group':
        M.groups[a.id].trashedAt = null;
        for (const x of Object.values(M.notes)) { if (x.groupId === a.id) x.trashedAt = null; }
        for (const x of Object.values(M.boards)) { if (x.groupId === a.id) x.trashedAt = null; }
        M.emit('groups-changed');
        M.emit('notes-changed');
        M.emit('boards-changed');
        return null;
      case 'take_note_out_of_board': {
        const x = M.notes[a.id];
        if (x) {
          x.hidden = false;
          if (a.screenX != null) x.x = a.screenX;
          if (a.screenY != null) x.y = a.screenY;
          if (!M.wins[`note-${a.id}`]) M.openNote(a.id);
          M.emit('notes-changed');
          M.emit('boards-changed');
        }
        return null;
      }
      case 'copy_share': return 'shared';
      case 'share_offer': return null;
      case 'import_share':
      case 'dismiss_share': M.emit('share-available', null); return null;
      case 'new_note': {
        const x = M.addNote({ id: `n${Date.now()}`, text: '' });
        M.openNote(x.id);
        M.emit('notes-changed');
        return null;
      }
      case 'open_board_note':
      case 'open_note': {
        const x = M.notes[a.id];
        x.hidden = false;
        if (!M.wins[`note-${a.id}`]) M.openNote(a.id);
        M.emit('notes-changed');
        return null;
      }
      // One command for every window (close_window / trash_window).
      case 'close_window':
        if (n) { n.hidden = true; M.closeWin(label); M.emit('notes-changed'); }
        else if (g) { g.hidden = true; M.closeWin(label); M.emit('groups-changed'); }
        else if (b) { b.hidden = true; M.closeWin(label); M.emit('boards-changed'); }
        else M.closeWin(label);
        return null;
      case 'trash_window':
        if (n) { n.trashedAt = Date.now(); M.closeWin(label); M.emit('notes-changed'); }
        else if (g) return M.invoke(label, 'trash_group_window', a);
        else if (b) { b.trashedAt = Date.now(); M.closeWin(label); M.emit('boards-changed'); }
        return null;
      default: return null;
    }
  };

  // ---------------------------------------------------------------- windows

  let z = 10;
  M.openWin = (label, src, { x, y, w, h }) => {
    const el = document.createElement('div');
    el.className = 'win';
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, zIndex: ++z });
    const f = document.createElement('iframe');
    f.src = `${src}${src.includes('?') ? '&' : '?'}label=${label}`;
    el.append(f);
    desk.append(el);
    M.wins[label] = { el, f };
    return new Promise((r) => f.addEventListener('load', () => {
      f.contentWindow.addEventListener('pointerdown', () => M.raise(label), true);
      setTimeout(r, 150);
    }));
  };
  M.raise = (label) => {
    const w = M.wins[label];
    if (!w) return;
    w.el.style.zIndex = w.el.classList.contains('pinned') ? 1000 + (++z) : ++z;
  };
  M.raiseEl = (el) => { el.style.zIndex = ++z; };
  M.closeWin = (label) => {
    const w = M.wins[label];
    if (!w) return;
    w.el.remove();
    delete M.wins[label];
  };
  M.openNote = (id) => {
    const n = M.notes[id];
    return M.openWin(`note-${id}`, '/src/windows/note/index.html', { x: n.x, y: n.y, w: n.width, h: n.height });
  };
  M.openGroup = (id) => {
    const g = M.groups[id];
    return M.openWin(`group-${id}`, '/src/windows/group/group.html', { x: g.x, y: g.y, w: g.width, h: 34 });
  };
  M.openManager = () => {
    const m = M.manager;
    return M.openWin('manager', '/src/windows/manager/manager.html', { x: m.x, y: m.y, w: m.width, h: m.height });
  };
  M.move = (label, x, y) => {
    const s = M.wins[label].el.style;
    s.left = `${x}px`;
    s.top = `${y}px`;
  };
  // Stage coordinates of an element inside a window (its centre by default).
  M.rectIn = (label, sel, i = 0) => {
    const w = M.wins[label];
    const el = w.f.contentDocument.querySelectorAll(sel)[i];
    const r = el.getBoundingClientRect();
    const o = w.el.getBoundingClientRect();
    const k = M.scale || 1;
    return { x: o.left + r.left * k, y: o.top + r.top * k, w: r.width * k, h: r.height * k,
      cx: o.left + (r.left + r.width / 2) * k, cy: o.top + (r.top + r.height / 2) * k };
  };
  M.zoom = (k, ox = 0, oy = 0) => {
    M.scale = k;
    desk.style.transform = `translate(${ox}px, ${oy}px) scale(${k})`;
    desk.style.background = 'transparent';
  };
  M.frameDoc = (label) => (M.wins[label] ? M.wins[label].f.contentDocument : null);
  M.frameWin = (label) => (M.wins[label] ? M.wins[label].f.contentWindow : null);

  // ----------------------------------------------------------------- cursor

  const cur = document.getElementById('cursor');
  M.cursor = (x, y, kind) => {
    cur.style.transform = `translate(${x}px, ${y}px)`;
    if (kind) cur.dataset.kind = kind;
  };
})();
