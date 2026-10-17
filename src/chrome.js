// Taxinha — comportamento comum às janelas sem moldura (nota e "Gerenciador"):
// arrastar pela barra de título e redimensionar pelas bordas, os dois com ímã
// nas bordas do monitor e das outras janelas; clique duplo e clique do meio
// (fechar) na barra.

window.TaxinhaChrome = {
  attach({ frame, titlebar, grip, onDoubleClick, onClose }) {
    const { invoke } = window.__TAURI__.core;
    const appWindow = window.__TAURI__.window.getCurrentWindow();

    // Arraste feito aqui (e não pelo sistema, com startDragging) para a janela
    // ir grudando nas bordas do monitor e nas outras janelas durante o
    // movimento: cada posição passa pelo drag_to do Rust, que aplica o ímã.
    let drag = null;
    const cancelDrag = () => { drag = null; };

    // Uma chamada ao Rust por vez; se o mouse andou nesse meio-tempo, vai só a
    // posição mais recente. A última posição é enviada mesmo depois de soltar.
    function pumpDrag(d) {
      if (d.busy || !d.origin || !d.target) return;
      const [dx, dy] = d.target;
      d.target = null;
      d.busy = true;
      invoke('drag_to', { x: Math.round(d.origin.x + dx * d.scale), y: Math.round(d.origin.y + dy * d.scale) })
        .catch((err) => console.error('drag_to', err))
        .finally(() => {
          d.busy = false;
          pumpDrag(d);
        });
    }

    titlebar.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); return; } // sem rolagem automática
      if (e.button !== 0 || e.target.closest('button, input')) return;
      e.preventDefault();
      if (e.detail === 2 && onDoubleClick) { cancelDrag(); onDoubleClick(); }
    });

    titlebar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input')) return;
      titlebar.setPointerCapture(e.pointerId); // segue o mouse mesmo fora da janela
      const d = { sx: e.screenX, sy: e.screenY, origin: null, scale: 1, target: null, busy: false, moved: false };
      drag = d;
      Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]).then(([pos, scale]) => {
        d.origin = pos;
        d.scale = scale;
        pumpDrag(d);
      });
    });

    titlebar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.sx;
      const dy = e.screenY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return; // clique, não arraste
      drag.moved = true;
      drag.target = [dx, dy];
      pumpDrag(drag);
    });

    titlebar.addEventListener('pointerup', cancelDrag);
    titlebar.addEventListener('pointercancel', cancelDrag);
    titlebar.addEventListener('lostpointercapture', cancelDrag);

    // Clique do meio (botão da rodinha) fecha, como uma aba do navegador.
    titlebar.addEventListener('auxclick', (e) => {
      if (e.button !== 1 || e.target.closest('input')) return;
      e.preventDefault();
      onClose();
    });

    // Redimensionar: alças finas nas bordas e cantos (mais a alça visível do
    // canto inferior direito). O redimensionamento nativo está desligado, e
    // cada tamanho passa pelo resize_to do Rust, que aplica o ímã nas bordas
    // que estão se mexendo.
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

    for (const edges of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
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
