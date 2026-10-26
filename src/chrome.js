// Memo — behaviour shared by the frameless windows (note and manager):
// dragging by the titlebar and resizing by the edges, both snapping to the
// monitor edges and other windows (and, when dragging, Snap to half, quarter
// or full screen); double click, middle click (close) and the right-click
// menu on the titlebar.

// Web version: inside the browser workspace (site/app.html) or a Document
// Picture-in-Picture window, MemoWeb supplies the Tauri API for each frame.
(() => {
  if (window.__TAURI__) return;
  const host = (window.parent && window.parent.MemoWeb) || (window.parent && window.parent.parent && window.parent.parent.MemoWeb) || (window.top && window.top.MemoWeb)
    || (window.parent && window.parent.MemoWeb)
    || (window.opener && window.opener.MemoWeb);
  if (host) window.__TAURI__ = host.createTauri(window);
})();

// Global zoom shortcuts, in every window (and the manager's embedded
// editor): Mod + / Mod − step the zoom of all windows by 10%, Mod 0 resets
// it, Mod + wheel steps it too. Rust applies it everywhere (change_zoom).
window.MemoZoom = {
  attach(invoke) {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const step = (n) => invoke('change_zoom', { step: n }).catch((err) => console.error('change_zoom', err));
    document.addEventListener('keydown', (e) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey) return;
      let n = null;
      if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') n = 1;
      else if (e.key === '-' || e.code === 'NumpadSubtract') n = -1;
      else if (e.key === '0' || e.code === 'Numpad0') n = 0;
      if (n === null) return;
      e.preventDefault();
      step(n);
    });
    // One step per wheel gesture tick (trackpads send many small events).
    let last = 0;
    document.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !(isMac && e.metaKey)) return;
      e.preventDefault();
      const now = Date.now();
      if (!e.deltaY || now - last < 120) return;
      last = now;
      step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  },
};

// Opens the system colour picker of a hidden <input type="color"> next to
// the swatch that asked for it. The (invisible) input takes the swatch's
// place and size: browsers anchor their picker to it, and on macOS WebKit
// shows a popover from it that never opens while the input has no size.
// On Windows, where the system dialog opens on its own, Rust moves it next
// to the pointer (place_color_picker).
window.MemoColorPicker = {
  open(input, anchor) {
    const r = anchor.getBoundingClientRect();
    input.style.position = 'fixed';
    input.style.left = `${Math.round(r.left)}px`;
    input.style.top = `${Math.round(r.top)}px`;
    input.style.width = `${Math.round(r.width)}px`;
    input.style.height = `${Math.round(r.height)}px`;
    const tauri = window.__TAURI__ || window.parent.__TAURI__;
    tauri.core.invoke('place_color_picker').catch((err) => console.error('place_color_picker', err));
    input.click();
  },
};

window.MemoChrome = {
  // `resizeEdges`: which edges/corners get a resize handle (a group bar only
  // changes width). `onDoubleClick` receives the mousedown event.
  attach({ frame, titlebar, grip, onDoubleClick, onClose, resizeEdges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] }) {
    const { invoke } = window.__TAURI__.core;

    // Dragging is done here (not by the OS, with startDragging) so the window
    // snaps to monitor edges and other windows during the move. Rust follows
    // the cursor itself (main.rs, "Dragging and Snap"): drag_start once the
    // pointer moves past the click threshold, drag_to on each move, drag_end
    // on release, which also applies Snap if the cursor is in a Snap zone.
    let drag = null;

    // Calls run one after another. Moves made while a drag_to is waiting
    // share it: Rust reads the latest cursor position anyway.
    function send(d, cmd, args) {
      d.chain = d.chain.then(() => invoke(cmd, args)).catch((err) => console.error(cmd, err));
    }
    function moveDrag(d) {
      if (d.queued) return;
      d.queued = true;
      d.chain = d.chain
        .then(() => {
          d.queued = false;
          return invoke('drag_to', { cx: d.cx, cy: d.cy });
        })
        .catch((err) => console.error('drag_to', err));
    }
    const cancelDrag = () => {
      const d = drag;
      drag = null;
      if (d && d.started) send(d, 'drag_end', { cx: d.cx, cy: d.cy });
    };

    titlebar.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); return; } // no autoscroll
      if (e.button !== 0 || e.target.closest('button, input')) return;
      // preventDefault keeps the focus where it is, so a name being edited
      // would stay open: blur it, which confirms it like Enter.
      const active = document.activeElement;
      if (active && active.matches('input') && titlebar.contains(active)) active.blur();
      e.preventDefault();
      if (e.detail === 2 && onDoubleClick) { cancelDrag(); onDoubleClick(e); }
    });

    titlebar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input')) return;
      const active = document.activeElement;
      if (active && active.matches('input') && titlebar.contains(active)) active.blur();
      try { titlebar.setPointerCapture(e.pointerId); } catch (_) {}
      drag = { sx: e.screenX || e.clientX, sy: e.screenY || e.clientY, cx: e.clientX, cy: e.clientY, started: false, queued: false, chain: Promise.resolve() };
    });

    titlebar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.started) {
        const sx = e.screenX || e.clientX;
        const sy = e.screenY || e.clientY;
        if (Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return; // a click, not a drag
        drag.started = true;
        send(drag, 'drag_start', { cx: drag.cx, cy: drag.cy });
      }
      drag.cx = e.clientX;
      drag.cy = e.clientY;
      moveDrag(drag);
    });

    titlebar.addEventListener('pointerup', cancelDrag);
    titlebar.addEventListener('pointercancel', cancelDrag);
    titlebar.addEventListener('lostpointercapture', cancelDrag);

    // Middle click (wheel button) closes, like a browser tab.
    titlebar.addEventListener('auxclick', (e) => {
      if (e.button !== 1 || e.target.closest('input')) return;
      e.preventDefault();
      onClose();
    });

    // Resizing: thin handles on the edges and corners (plus the visible grip
    // in the bottom-right corner). Native resizing is off, and each size goes
    // through Rust's resize_to, which follows the cursor (like dragging, so it
    // stays right across monitors with different scales) and snaps the edges
    // being moved. Calls are chained like drag_to.
    let resize = null;

    function moveResize(r) {
      if (r.queued) return;
      r.queued = true;
      r.chain = r.chain
        .then(() => {
          r.queued = false;
          return invoke('resize_to', { edges: r.edges, cx: r.cx, cy: r.cy });
        })
        .catch((err) => console.error('resize_to', err));
    }

    function startResize(handle, edges) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        const r = {
          edges,
          cx: e.clientX,
          cy: e.clientY,
          queued: false,
          chain: invoke('resize_start', { cx: e.clientX, cy: e.clientY }).catch((err) => console.error('resize_start', err)),
        };
        resize = r;
      });
      handle.addEventListener('pointermove', (e) => {
        if (!resize || resize.edges !== edges) return;
        resize.cx = e.clientX;
        resize.cy = e.clientY;
        moveResize(resize);
      });
      const end = () => { resize = null; };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
      handle.addEventListener('lostpointercapture', end);
    }

    for (const edges of resizeEdges) {
      const handle = document.createElement('div');
      handle.className = `rs rs-${edges}`;
      handle.setAttribute('aria-hidden', 'true');
      frame.append(handle);
      startResize(handle, edges);
    }
    if (grip) startResize(grip, 'se');

    return { cancelDrag };
  },

  // Right click on the titlebar, or its "…" button (`more`): a native menu
  // with the window's own commands on top and all the app's commands below
  // (Rust adds those, the same as the tray menu: show_title_menu). `items()`
  // is called on each opening, so labels follow the current state:
  // [{ label, run, checked? } | { label, items: [...] }], null = separator;
  // `items` makes a submenu. `onOpen()` closes the window's own popovers first.
  titleMenu({ titlebar, more, items, onOpen }) {
    const { invoke } = window.__TAURI__.core;
    let entries = {};

    function open(at) {
      if (onOpen) onOpen();
      entries = {};
      const native = (list, path) => list.map((item, i) => {
        if (!item) return null;
        const id = path + i;
        if (item.items) return { id, label: item.label, items: native(item.items, `${id}.`) };
        entries[id] = item;
        return { id, label: item.label, checked: item.checked ?? null };
      });
      invoke('show_title_menu', { items: native(items(), ''), at })
        .catch((err) => console.error('show_title_menu', err));
    }

    titlebar.addEventListener('contextmenu', (e) => {
      if (e.target.closest('input')) return;
      e.preventDefault();
      open(null);
    });
    if (more) {
      more.addEventListener('click', () => {
        const r = more.getBoundingClientRect();
        open([r.left, r.bottom]);
      });
    }
    window.__TAURI__.event.listen('title-menu', (e) => {
      const item = entries[e.payload];
      if (item) item.run();
    });
  },
};
// Shared rendering for note cards (Manager and Board):
// Renders the note's text components (checklists, bullets, numbers, formatting,
// code blocks, tables) with limited height.
window.MemoCard = {
  render(note, options = {}) {
    if (!note) return null;
    const { skipFirst = false, className = 'card-preview' } = options;
    const rawHtml = (note.html || '').trim();
    const rawText = (note.text || '').trim();
    if (!rawHtml && !rawText) return null;

    let html = rawHtml;
    if (!html) {
      html = window.MemoCard.fromPlain(rawText);
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const nodes = Array.from(doc.body.childNodes);

    let start = 0;
    if (skipFirst) {
      for (let i = 0; i < nodes.length; i++) {
        if ((nodes[i].textContent || '').trim()) {
          start = i + 1;
          break;
        }
      }
    }

    const container = document.createElement('div');
    container.className = className;

    let hasVisibleContent = false;
    for (let i = start; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 1) {
        container.appendChild(n.cloneNode(true));
        hasVisibleContent = true;
      } else if (n.nodeType === 3) {
        if (n.textContent && n.textContent.trim()) {
          const div = document.createElement('div');
          div.textContent = n.textContent;
          container.appendChild(div);
          hasVisibleContent = true;
        }
      }
    }

    if (!hasVisibleContent) return null;

    let num = 0;
    for (const child of container.children) {
      if (child.classList && child.classList.contains('number')) {
        num++;
        if (!child.getAttribute('data-n')) {
          child.setAttribute('data-n', String(num));
        }
      } else {
        num = 0;
      }
    }

    return container;
  },

  fromPlain(text) {
    if (!text) return '';
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const inline = (s) => s.split(/(`[^`]+`)/).map((part, i) => (i % 2 ? '<code>' + esc(part.slice(1, -1)) + '</code>' : esc(part))).join('');
    const listRe = /^( *)(?:\[([ xX]?)\]|(-)|(\d+)\.)(?= |$) ?/;
    const lines = text.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^```([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        const end = lines.findIndex((l, j) => j > i && /^```\s*$/.test(l));
        if (end > i) {
          const body = lines.slice(i + 1, end).join('\n');
          const lang = fence[1] ? ' data-lang="' + esc(fence[1]) + '"' : '';
          out.push('<pre class="code"' + lang + '>' + (body ? esc(body) : '<br>') + '</pre>');
          i = end;
          continue;
        }
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        let end = i;
        while (end + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[end + 1])) end++;
        const rows = lines.slice(i, end + 1);
        const head = rows.length > 1 && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(rows[1]);
        if (head) rows.splice(1, 1);
        const rowCells = (l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        const cells = rows.map(rowCells);
        const cols = Math.max(...cells.map((r) => r.length));
        const tr = cells.map((r) => '<tr>' + Array.from({ length: cols }, (_, c) => '<td>' + (r[c] ? inline(r[c]) : '<br>') + '</td>').join('') + '</tr>');
        out.push('<table' + (head ? ' class="head"' : '') + '><tbody>' + tr.join('') + '</tbody></table>');
        i = end;
        continue;
      }
      const m = listRe.exec(line);
      if (!m) {
        out.push('<div>' + (line ? inline(line) : '<br>') + '</div>');
        continue;
      }
      const body = line.slice(m[0].length);
      const cls = m[3] ? 'bullet' : m[4] ? 'number' : ('check' + (/x/i.test(m[2]) ? ' done' : ''));
      const level = Math.min(4, Math.floor(m[1].length / 2));
      const lvl = level ? (' data-level="' + level + '"') : '';
      out.push('<div class="' + cls + '"' + lvl + '>' + (body ? inline(body) : '<br>') + '</div>');
    }
    return out.join('');
  },
};
