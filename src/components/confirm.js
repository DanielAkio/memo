// MemoConfirm: a button whose action can't be undone ("Empty trash",
// "Quit") acts only on a second click within 3 s. The first click arms it
// (red, `.confirming`) and shows `label` ("Click again to …"): as its text
// when it has no icon, else as its tooltip. The second click restores the button at once.
(function () {
  const armed = new Map(); // button → { timer, text, title }

  function disarm(btn) {
    const s = armed.get(btn);
    if (!s) return;
    clearTimeout(s.timer);
    armed.delete(btn);
    btn.classList.remove('confirming');
    if (s.text != null) btn.textContent = s.text;
    btn.title = s.title;
    if (s.title) btn.setAttribute('aria-label', s.title);
  }

  // true on the second click: go ahead.
  function ask(btn, label) {
    if (armed.has(btn)) {
      disarm(btn);
      return true;
    }
    const icon = Boolean(btn.querySelector('svg'));
    const s = { text: icon ? null : btn.textContent, title: btn.title };
    s.timer = setTimeout(() => disarm(btn), 3000);
    armed.set(btn, s);
    btn.classList.add('confirming');
    if (icon) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    } else {
      btn.textContent = label;
    }
    return false;
  }

  window.MemoConfirm = { ask, disarm };
})();
