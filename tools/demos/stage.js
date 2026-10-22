// Stage for the site's demo GIFs: a fake desktop where each Memo window is
// an iframe of the real app page (src/), backed by the fake Tauri API in
// mock.js. record.mjs drives it.
(() => {
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') || 'dark';
  const lang = q.get('lang') || 'en';
  document.documentElement.dataset.theme = theme;
  const desk = document.getElementById('desk');
  const now = Date.now();

  const M = {
    theme, lang, notes: {}, groups: {}, wins: {}, listeners: [],
    manager: { x: null, y: null, width: 560, height: 420, pinned: false, color: 'iris' },
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

  const idOf = (label) => label.replace(/^(note|group)-/, '');
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const members = (gid) => Object.values(M.notes).filter((n) => n.groupId === gid && !n.trashedAt);

  M.invoke = async (label, cmd, a) => {
    const id = idOf(label);
    const n = M.notes[id];
    const g = M.groups[id];
    const hook = M.hooks[cmd];
    if (hook) { const r = await hook(label, a); if (r !== undefined) return r; }
    switch (cmd) {
      case 'get_language': return [M.lang, M.lang];
      case 'get_theme': return M.theme;
      case 'get_zoom': return 1;
      case 'load_note': return n ? copy(n) : null;
      case 'get_note_group': return n ? n.groupId : '';
      case 'list_groups': return Object.values(M.groups).map(copy);
      case 'list_notes': return Object.values(M.notes).map((x) => Object.assign(copy(x), { html: '' }));
      case 'save_text': Object.assign(n, { text: a.text, html: a.html, updatedAt: Date.now() }); M.emit('notes-changed'); return null;
      case 'set_title': n.title = a.title.trim(); n.updatedAt = Date.now(); M.emit('notes-changed'); return n.title;
      case 'set_color': n.color = a.color; M.emit('notes-changed'); return null;
      case 'set_pinned': {
        const o = n || g || M.manager;
        o.pinned = a.pinned;
        const w = M.wins[label];
        if (w) { w.el.classList.toggle('pinned', a.pinned); M.raise(label); }
        return a.pinned;
      }
      case 'set_note_group': n.groupId = a.groupId; M.emit('groups-changed'); return null;
      case 'load_group': return g ? [copy(g), members(g.id).length] : null;
      case 'rename_group': g.name = a.name.trim(); M.emit('groups-changed'); return g.name;
      case 'set_group_color': g.color = a.color; M.emit('groups-changed'); return null;
      case 'load_manager': return copy(M.manager);
      case 'take_manager_view': { const v = M.view; M.view = null; return v; }
      case 'get_default_color': return 'iris';
      case 'get_new_note_defaults': return ['', '', ''];
      case 'get_group_defaults': return ['random', ''];
      case 'get_data_dir': return ['C:\\Users\\ana\\AppData\\Roaming\\memo', true];
      case 'get_cloud_account': return [true, null, { syncing: false, lastSync: 0, pending: 0, error: null }];
      case 'get_autostart': return true;
      case 'get_updates': return [true, { checking: false, available: null, progress: null, upToDate: false, error: null }];
      case 'get_ai_control': return [false, 'memo'];
      case 'get_ai_clients': return [];
      case 'move_to_trash': M.notes[a.id].trashedAt = Date.now(); M.closeWin(`note-${a.id}`); M.emit('notes-changed'); return null;
      case 'restore_note': M.notes[a.id].trashedAt = null; M.notes[a.id].hidden = true; M.emit('notes-changed'); return null;
      case 'open_note': {
        const x = M.notes[a.id];
        x.hidden = false;
        if (!M.wins[`note-${a.id}`]) M.openNote(a.id);
        M.emit('notes-changed');
        return null;
      }
      case 'close_note': n.hidden = true; M.closeWin(label); M.emit('notes-changed'); return null;
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
    return M.openWin(`note-${id}`, '/src/index.html', { x: n.x, y: n.y, w: n.width, h: n.height });
  };
  M.openGroup = (id) => {
    const g = M.groups[id];
    return M.openWin(`group-${id}`, '/src/group.html', { x: g.x, y: g.y, w: g.width, h: 34 });
  };
  M.openManager = () => {
    const m = M.manager;
    return M.openWin('manager', '/src/manager.html', { x: m.x, y: m.y, w: m.width, h: m.height });
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
  M.frameDoc = (label) => M.wins[label].f.contentDocument;
  M.frameWin = (label) => M.wins[label].f.contentWindow;

  // ----------------------------------------------------------------- cursor

  const cur = document.getElementById('cursor');
  M.cursor = (x, y, kind) => {
    cur.style.transform = `translate(${x}px, ${y}px)`;
    if (kind) cur.dataset.kind = kind;
  };
})();
