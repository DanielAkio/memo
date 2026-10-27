// MemoToast: notices at the bottom of every window, one per key (the import
// offer of components/share.js, the new version of components/update.js,
// a short "Copied"), stacked in the order they came. Each is a text with an
// optional action button and ✕. A window too short for them (a group bar)
// grows while they show, through the `onResize(height | null)` given to
// `init`.
(function () {
  const t = (k, v) => window.MemoI18n.t(k, v);
  const notices = new Map(); // key → element
  let box = null;
  let onResize = null;

  function container() {
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      box.hidden = true;
      document.body.append(box);
    }
    return box;
  }

  function layout() {
    const any = notices.size > 0;
    container().hidden = !any;
    // Above a window's status bar (a note's or board's footer), not on it.
    const bar = document.querySelector('.statusbar');
    box.style.bottom = `${(bar && bar.offsetHeight) + 8 || 8}px`;
    if (onResize) onResize(any ? box.offsetHeight + 16 : null);
  }

  // `notice` = { text, action?: { label, run }, onClose? }; null removes it.
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
    if (notice.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.textContent = notice.action.label;
      b.addEventListener('click', notice.action.run);
      el.append(b);
    }
    if (notice.onClose) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'toast-close';
      b.title = t('dismiss');
      b.setAttribute('aria-label', t('dismiss'));
      b.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/></svg>';
      b.addEventListener('click', notice.onClose);
      el.append(b);
    }
    if (old) old.replaceWith(el);
    else container().append(el);
    notices.set(key, el);
    layout();
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
