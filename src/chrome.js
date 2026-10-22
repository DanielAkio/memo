// Memo — behaviour shared by the frameless windows (note and manager):
// dragging by the titlebar and resizing by the edges, both snapping to the
// monitor edges and other windows (and, when dragging, Snap to half, quarter
// or full screen); double click, middle click (close) and the right-click
// menu on the titlebar.

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
// the swatch that asked for it. The input moves under the swatch (where
// Chromium anchors its picker) and, on Windows, where the system dialog
// opens on its own, Rust moves it next to the pointer (place_color_picker).
window.MemoColorPicker = {
  open(input, anchor) {
    const r = anchor.getBoundingClientRect();
    input.style.position = 'fixed';
    input.style.left = `${Math.round(r.left)}px`;
    input.style.top = `${Math.round(r.bottom)}px`;
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
    const appWindow = window.__TAURI__.window.getCurrentWindow();

    // Dragging is done here (not by the OS, with startDragging) so the window
    // snaps to monitor edges and other windows during the move. Rust follows
    // the cursor itself (main.rs, "Dragging and Snap"): drag_start once the
    // pointer moves past the click threshold, drag_to on each move, drag_end
    // on release, which also applies Snap if the cursor is in a Snap zone.
    let drag = null;

    // Calls run one after another. Moves made while a drag_to is waiting
    // share it: Rust reads the latest cursor position anyway.
    function send(d, cmd) {
      d.chain = d.chain.then(() => invoke(cmd)).catch((err) => console.error(cmd, err));
    }
    function moveDrag(d) {
      if (d.queued) return;
      d.queued = true;
      d.chain = d.chain
        .then(() => {
          d.queued = false;
          return invoke('drag_to');
        })
        .catch((err) => console.error('drag_to', err));
    }
    const cancelDrag = () => {
      const d = drag;
      drag = null;
      if (d && d.started) send(d, 'drag_end');
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
      titlebar.setPointerCapture(e.pointerId); // follow the mouse even outside the window
      drag = { sx: e.screenX, sy: e.screenY, started: false, queued: false, chain: Promise.resolve() };
    });

    titlebar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.started) {
        if (Math.hypot(e.screenX - drag.sx, e.screenY - drag.sy) < 3) return; // a click, not a drag
        drag.started = true;
        send(drag, 'drag_start');
      }
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
    // through Rust's resize_to, which snaps the edges being moved.
    let resize = null;

    function pumpResize(r) {
      if (r.busy || !r.origin || !r.target) return;
      const [dx, dy] = r.target;
      r.target = null;
      r.busy = true;
      let { x, y, w, h } = r.origin;
      const mx = Math.round(dx * r.scale);
      const my = Math.round(dy * r.scale);
      if (r.edges.includes('e')) w += mx;
      if (r.edges.includes('w')) { x += mx; w -= mx; }
      if (r.edges.includes('s')) h += my;
      if (r.edges.includes('n')) { y += my; h -= my; }
      invoke('resize_to', { x, y, w, h, edges: r.edges })
        .catch((err) => console.error('resize_to', err))
        .finally(() => {
          r.busy = false;
          pumpResize(r);
        });
    }

    function startResize(handle, edges) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture(e.pointerId);
        const r = { edges, sx: e.screenX, sy: e.screenY, origin: null, scale: 1, target: null, busy: false };
        resize = r;
        Promise.all([appWindow.innerPosition(), appWindow.innerSize(), appWindow.scaleFactor()])
          .then(([p, s, scale]) => {
            r.origin = { x: p.x, y: p.y, w: s.width, h: s.height };
            r.scale = scale;
            pumpResize(r);
          });
      });
      handle.addEventListener('pointermove', (e) => {
        if (!resize || resize.edges !== edges) return;
        resize.target = [e.screenX - resize.sx, e.screenY - resize.sy];
        pumpResize(resize);
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
  // [{ label, run, checked? }], null = separator. `onOpen()` closes the
  // window's own popovers first.
  titleMenu({ titlebar, more, items, onOpen }) {
    const { invoke } = window.__TAURI__.core;
    let entries = [];

    function open(at) {
      if (onOpen) onOpen();
      entries = items();
      const own = entries.map((item, i) => (item
        ? { id: String(i), label: item.label, checked: item.checked ?? null }
        : null));
      invoke('show_title_menu', { items: own, at }).catch((err) => console.error('show_title_menu', err));
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
      const item = entries[Number(e.payload)];
      if (item) item.run();
    });
  },
};
