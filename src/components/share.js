// MemoShare: sharing memories, boards and groups through the clipboard
// (share.rs). One small toast at the bottom of any window, for two things:
// "Copied" after "Share (copy)", and the offer to import a shared item the
// clipboard holds (share-available, sent to the focused window), with
// Import and ✕. A window too short for it (a group bar) grows while it
// shows, through `onResize(height | null)`.
(function () {
  const t = (k, v) => window.MemoI18n.t(k, v);
  let el = null;
  let opts = null;
  let timer = 0;

  function toast() {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'share-toast';
    el.hidden = true;
    el.setAttribute('role', 'status');
    document.body.append(el);
    return el;
  }

  function hide() {
    clearTimeout(timer);
    if (!el || el.hidden) return;
    el.hidden = true;
    el.replaceChildren();
    if (opts && opts.onResize) opts.onResize(null);
  }

  function show(children, ms) {
    const box = toast();
    clearTimeout(timer);
    box.replaceChildren(...children);
    box.hidden = false;
    if (opts && opts.onResize) opts.onResize(box.offsetHeight + 16);
    if (ms) timer = setTimeout(hide, ms);
  }

  function text(s, className) {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.textContent = s;
    return span;
  }

  function button(label, run, className) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = label;
    b.addEventListener('click', run);
    return b;
  }

  // "Shared memory “X”", "Shared board “X” · 3 memories", ...
  function offerText(s) {
    const name = s.name && s.name.trim() ? s.name.trim() : t('untitled');
    const key = s.kind === 'board' ? 'shareOfferBoard' : s.kind === 'group' ? 'shareOfferGroup' : 'shareOfferNote';
    let line = t(key, { name });
    if (s.kind !== 'note' && s.notes) line += ` · ${t(s.notes === 1 ? 'shareOneMemory' : 'shareMemories', { n: s.notes })}`;
    return line;
  }

  function offer(summary) {
    if (!summary) {
      hide();
      return;
    }
    const close = button('', () => {
      hide();
      opts.invoke('dismiss_share').catch((err) => console.error('dismiss_share', err));
    }, 'share-close');
    close.title = t('shareDismiss');
    close.setAttribute('aria-label', t('shareDismiss'));
    close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5"/></svg>';
    show([
      text(offerText(summary), 'share-text'),
      button(t('shareImport'), () => {
        hide();
        opts.invoke('import_share').catch((err) => console.error('import_share', err));
      }, 'share-import'),
      close,
    ]);
  }

  window.MemoShare = {
    // Listens for offers in this window: { invoke, listen, onResize? }.
    attach(options) {
      opts = options;
      options.listen('share-available', (e) => offer(e.payload));
      // The offer follows the focus: another window shows it next.
      window.addEventListener('blur', () => {
        if (el && el.querySelector('.share-import')) hide();
      });
    },
    // "Share (copy)": the text goes to the clipboard (share.rs writes it),
    // `args` = { kind, id } outside the item's own window.
    async copy(args) {
      try {
        await opts.invoke('copy_share', args || {});
        show([text(t('shareCopied'), 'share-text')], 3500);
      } catch (err) {
        console.error('copy_share', err);
        show([text(t(String(err).includes('too big') ? 'shareTooBig' : 'shareFailed'), 'share-text')], 4500);
      }
    },
  };
})();
