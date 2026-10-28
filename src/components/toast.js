// MemoToast: notices at the bottom of every window, one per key (the import
// offer of components/share.js, the new version of components/update.js,
// a short "Copied"), stacked in the order they came; one with `top` shows
// under the titlebar instead (the ✕'s notice, next to the ✕). Each is a text
// with an optional action button and ✕. A window too short for them (a
// group bar) grows while they show, through the `onResize(height | null)`
// given to `init`.
(function () {
  const t = (k, v) => window.MemoI18n.t(k, v);
  const notices = new Map(); // key → element
  const boxes = {}; // 'top' | 'bottom' → container
  let onResize = null;

  function container(side) {
    if (!boxes[side]) {
      const box = document.createElement('div');
      box.className = `toasts is-${side}`;
      box.hidden = true;
      document.body.append(box);
      boxes[side] = box;
    }
    return boxes[side];
  }

  function layout() {
    let height = 0;
    for (const side of ['top', 'bottom']) {
      const box = container(side);
      box.hidden = !box.childElementCount;
      if (!box.hidden) height += box.offsetHeight + 16;
    }
    // Above a window's status bar (a note's or board's footer), not on it.
    const bar = document.querySelector('.statusbar');
    boxes.bottom.style.bottom = `${(bar && bar.offsetHeight) + 8 || 8}px`;
    if (onResize) onResize(height || null);
  }

  // `notice` = { text, action?: { label, run }, onClose?, check?, top?, outside? };
  // null removes it. With `check` (a label), the text wraps above a row with
  // that checkbox, and `run` / `onClose` get `{ checked }`.
  function set(key, notice) {
    const old = notices.get(key);
    if (!notice) {
      if (!old) return;
      old.remove();
      notices.delete(key);
      layout();
      return;
    }
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.key = key;
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = notice.text;
    text.title = notice.text;
    el.append(text);
    let row = el;
    let head = el;
    let box = null;
    if (notice.check) {
      // The text with the ✕ at the top right; the checkbox and action below.
      el.classList.add('has-check');
      head = document.createElement('div');
      head.className = 'toast-row toast-head';
      head.append(text);
      el.append(head);
      row = document.createElement('div');
      row.className = 'toast-row';
      const label = document.createElement('label');
      label.className = 'toast-check';
      box = document.createElement('input');
      box.type = 'checkbox';
      label.append(box, notice.check);
      row.append(label);
      el.append(row);
    }
    const state = () => ({ checked: Boolean(box && box.checked) });
    if (notice.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = notice.action.label;
      b.addEventListener('click', () => notice.action.run(state()));
      row.append(b);
    }
    if (notice.onClose) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-close';
      b.title = t('dismiss');
      b.setAttribute('aria-label', t('dismiss'));
      b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/></svg>';
      b.addEventListener('click', () => notice.onClose(state()));
      head.append(b);
    }
    if (old) old.replaceWith(el);
    else container(notice.top ? 'top' : 'bottom').append(el);
    notices.set(key, el);
    layout();
    if (notice.outside && notice.onClose) closeOutside(key, el, () => notice.onClose(state()));
  }

  // `outside`: a click anywhere else, in this window or another, closes it
  // as its ✕ does.
  function closeOutside(key, el, close) {
    const stop = () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
    const live = () => notices.get(key) === el || (stop(), false);
    const onDown = (e) => { if (live() && !el.contains(e.target)) close(); };
    const onBlur = () => { if (live()) close(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
  }

  // A notice that goes by itself after `ms`.
  function flash(key, text, ms) {
    set(key, { text });
    const el = notices.get(key);
    setTimeout(() => {
      if (notices.get(key) === el) set(key, null);
    }, ms);
  }

  window.MemoToast = {
    init(options) {
      onResize = options.onResize || null;
    },
    set,
    flash,
  };
})();
