// Memo — behaviour shared by the frameless windows (note and manager):
// dragging by the titlebar and resizing by the edges, both snapping to the
// monitor edges and other windows (and, when dragging, Snap to half, quarter
// or full screen); double click and middle click (close) on the titlebar.

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
};
