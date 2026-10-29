// Memo — the titlebar every window shares (note, group bar, board and
// manager): pin far left, colour control, name, action buttons on the
// right. It wires what is the same everywhere: the pin (button and
// Mod+Shift+P), rename (a click on the name or a double click on the bar),
// Mod+N, the buttons, dragging /
// resizing / Snap / middle-click close (MemoChrome.attach), the … and
// right-click menu (MemoChrome.titleMenu), the focused look, and the
// browser's context menu kept to text fields. The window keeps its data and
// rendering; it passes:
//   frame, titlebar, grip, resizeEdges  for MemoChrome.attach
//   pin: { get(), set(pinned) }  the window's pinned state (null = not
//                loaded yet); set() stores it and re-renders, which calls
//                renderPin()
//   rename: { name, input, get(), set(name), onStart(), onEnd() }
//                optional: the name element, its field, the saved name (null
//                = can't rename yet), how to show a new one (the bar saves it
//                with `rename`, the same command for every window), and hooks
//                around the editing (onEnd runs after, saved or not)
//   buttons      { elementId: onClick } (✕ #closeBtn, #trashBtn and the
//                share link #shareBtn are wired by the bar: close() / trash()
//                / MemoShare.copy())
//   beforeLeave() before closing or trashing (save pending text…); false
//                keeps the window open
//   onNew        Mod+N (ignored while renaming)
//   menuItems()  the window's own commands on top of the titlebar menu
//   onMenuOpen() before the menu opens: close the window's popovers
//   nativeMenuIn selector where the browser's context menu stays
//   onBlur()     the window lost focus (a name being edited is saved first)
//   embedded     a note's page used as the manager's defaults editor: no
//                chrome, menu or window shortcuts
class TitleBar {
  constructor(options) {
    const o = Object.assign({ nativeMenuIn: 'input', buttons: {} }, options);
    this.o = o;
    this.renaming = false;
    this.invoke = (window.__TAURI__ || window.parent.__TAURI__).core.invoke;
    this.pinBtn = o.titlebar.querySelector('.pin');

    this.pinBtn.addEventListener('click', () => this.togglePin());
    for (const [id, onClick] of Object.entries(o.buttons)) {
      document.getElementById(id).addEventListener('click', onClick);
    }
    const closeBtn = o.titlebar.querySelector('#closeBtn');
    const trashBtn = o.titlebar.querySelector('#trashBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());
    if (trashBtn) trashBtn.addEventListener('click', () => this.trash());
    // Notes, boards and group bars: the item's link to the clipboard.
    const shareBtn = o.titlebar.querySelector('#shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', () => window.MemoShare.copy());
    if (o.rename) {
      o.rename.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.finishRename(true); }
        else if (e.key === 'Escape') { e.preventDefault(); this.finishRename(false); }
      });
      o.rename.input.addEventListener('blur', () => this.finishRename(true));
    }

    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest(o.nativeMenuIn)) e.preventDefault();
    });
    window.addEventListener('focus', () => o.frame.classList.add('is-focused'));
    window.addEventListener('blur', () => {
      o.frame.classList.remove('is-focused');
      this.finishRename(true);
      if (o.onBlur) o.onBlur();
    });
    if (document.hasFocus()) o.frame.classList.add('is-focused');

    if (o.embedded) return;
    window.MemoChrome.attach({
      frame: o.frame,
      titlebar: o.titlebar,
      grip: o.grip,
      resizeEdges: o.resizeEdges,
      onDoubleClick: o.rename ? () => this.startRename() : undefined,
      onClose: () => this.close(),
    });
    if (o.menuItems) {
      window.MemoChrome.titleMenu({ titlebar: o.titlebar, items: o.menuItems, onOpen: o.onMenuOpen });
    }
    // A click on the name renames, as a board column's name does (a drag
    // that starts on it still moves the window). The bar captures the
    // pointer while dragging, so the release is heard there.
    if (o.rename) {
      o.rename.name.classList.add('can-rename');
      let down = null;
      const at = (e) => [e.screenX || e.clientX, e.screenY || e.clientY];
      o.rename.name.addEventListener('pointerdown', (e) => { down = e.button === 0 ? at(e) : null; });
      o.titlebar.addEventListener('pointerup', (e) => {
        const from = down;
        down = null;
        if (!from || e.button !== 0) return;
        const [x, y] = at(e);
        if (Math.hypot(x - from[0], y - from[1]) < 3) this.startRename();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (!window.MemoI18n.isMod(e)) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey && key === 'p') {
        e.preventDefault();
        this.togglePin();
      } else if (!e.shiftKey && key === 'n' && o.onNew && !this.renaming) {
        e.preventDefault();
        o.onNew();
      }
    });
  }

  // ✕ / middle click, and the trash button: the same commands for every
  // window (close_window / trash_window), after the name being edited is
  // saved and the window's own `beforeLeave`.
  close() {
    return this.leave('close_window');
  }

  // The ✕ trashes (the – only closes), so until "Don't show again" is
  // checked it first says so in a notice: ✕ cancels, the action trashes.
  trash() {
    if (TitleBar.trashHintOff()) return this.leave('trash_window');
    const t = window.MemoI18n.t;
    const done = ({ checked }) => {
      if (checked) TitleBar.trashHintOff(true);
      window.MemoToast.set('trash-hint', null);
    };
    window.MemoToast.set('trash-hint', {
      text: t('trashHint'),
      check: t('dontShowAgain'),
      top: true,
      outside: true,
      action: { label: t('proceed'), run: (s) => { done(s); this.leave('trash_window'); } },
      onClose: done,
    });
  }

  // Shared by every window (same origin), in this device's storage.
  static trashHintOff(set) {
    const key = 'memo.trashHintOff';
    try {
      if (set) localStorage.setItem(key, '1');
      return localStorage.getItem(key) === '1';
    } catch {
      return Boolean(set);
    }
  }

  async leave(command) {
    await this.finishRename(true);
    if (this.o.beforeLeave && (await this.o.beforeLeave()) === false) return;
    this.invoke(command).catch((err) => console.error(command, err));
  }

  // Immediate feedback; reverts if the OS refuses.
  async togglePin() {
    const { get, set } = this.o.pin;
    const pinned = get();
    if (pinned == null) return;
    const next = !pinned;
    set(next);
    try {
      set(await this.invoke('set_pinned', { pinned: next }));
    } catch (err) {
      set(!next);
      console.error('set_pinned', err);
    }
  }

  renderPin(pinned) {
    const { t, keys } = window.MemoI18n;
    const label = t(pinned ? 'unpin' : 'pin');
    this.pinBtn.setAttribute('aria-pressed', String(Boolean(pinned)));
    this.pinBtn.setAttribute('aria-label', label);
    this.pinBtn.title = `${label} (${keys('Mod', 'Shift', 'P')})`;
  }

  startRename() {
    const r = this.o.rename;
    if (!r || this.renaming) return;
    const name = r.get();
    if (name == null) return;
    this.renaming = true;
    if (r.onStart) r.onStart();
    r.input.value = name;
    r.name.hidden = true;
    r.input.hidden = false;
    r.input.focus();
    r.input.select();
  }

  // Enter, blur and clicks elsewhere save; Esc cancels.
  async finishRename(save) {
    const r = this.o.rename;
    if (!this.renaming) return;
    this.renaming = false;
    const value = r.input.value.trim();
    r.input.hidden = true;
    r.name.hidden = false;
    if (save && value !== r.get()) {
      // Immediate feedback, then the name as saved.
      r.set(value);
      try {
        r.set(await this.invoke('rename', { name: value }));
      } catch (err) {
        console.error('rename', err);
      }
    }
    if (r.onEnd) r.onEnd();
  }
}
window.TitleBar = TitleBar;
