// Memo — colour labels, shared by every window (note, group, board and
// manager): painting an element in a label or custom colour, the theme
// (the "mono" swatch's name follows it), and the swatch popover under the
// titlebar (ColorMenu). Loaded after i18n.js and chrome.js.

window.MemoColor = {
  // A custom colour is "#rrggbb"; a label is a name ("" = no colour).
  isCustom: (c) => /^#[0-9a-f]{6}$/i.test(c || ''),

  // data-color picks the label's CSS (base.css); a custom colour goes
  // straight into --note-color, with data-color="custom".
  paint(el, color) {
    const custom = window.MemoColor.isCustom(color);
    el.dataset.color = custom ? 'custom' : color || '';
    if (custom) el.style.setProperty('--note-color', color);
    else el.style.removeProperty('--note-color');
  },

  // A label's name as its swatch shows it ("mono" follows the theme); a
  // legacy label with no swatch (lavender) by its translated name.
  name(color) {
    const sw = document.querySelector(`.swatch[data-color="${color || ''}"]`);
    return (sw && sw.getAttribute('aria-label')) || window.MemoI18n.t(color || 'noColor');
  },

  // Marks `color` among the .swatch buttons in `root` (a custom one tints
  // the "custom" swatch).
  mark(root, color) {
    const custom = window.MemoColor.isCustom(color);
    const customSwatch = root.querySelector('.swatch[data-color="custom"]');
    if (custom) customSwatch.style.setProperty('--sw', color);
    else customSwatch.style.removeProperty('--sw');
    for (const sw of root.querySelectorAll('.swatch')) {
      const checked = sw === customSwatch ? custom : sw.dataset.color === (color || '');
      sw.setAttribute('aria-checked', String(checked));
    }
  },
};

window.MemoTheme = (() => {
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  const listeners = [];

  // "mono" is white in the dark theme and black in the light one: every
  // mono swatch's name follows, then whoever shows it (`onChange`).
  function renderMono() {
    const theme = document.documentElement.dataset.theme;
    const light = theme ? theme === 'light' : systemLight.matches;
    const name = window.MemoI18n.t(light ? 'black' : 'white');
    for (const sw of document.querySelectorAll('.swatch[data-color="mono"]')) {
      sw.setAttribute('aria-label', name);
      sw.title = name;
    }
    for (const fn of listeners) fn();
  }
  systemLight.addEventListener('change', renderMono);

  return {
    // The theme chosen in the manager: "light", "dark", or anything else to
    // follow the OS (through CSS).
    apply(theme) {
      if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
      else delete document.documentElement.dataset.theme;
      renderMono();
    },
    renderMono,
    onChange: (fn) => listeners.push(fn),
  };
})();

// The swatch popover opened by a window's colour control (a note's dot, a
// group's folder, a board's or the manager's icon). The window keeps its
// colour; the menu only shows and picks:
//   button       the titlebar control that opens and closes it
//   menu         the popover holding the .swatch buttons
//   input        the hidden <input type="color"> behind the "custom" swatch
//   current()    the window's colour now
//   onPick(c)    a swatch was chosen, or a custom colour confirmed
//   customStart() the colour the system picker opens on when the current one
//                isn't custom (default: yellow)
//   onOpen()     before opening: close the window's other popovers
//   onChange(open) after opening or closing (a group bar resizes)
//   closeOnBlur  close when the window loses focus (not a note's: the
//                system picker itself takes the focus on some platforms)
class ColorMenu {
  constructor({ frame, button, menu, input, current, onPick, customStart, onOpen, onChange, closeOnBlur = true }) {
    Object.assign(this, { frame, button, menu, onOpen, onChange });
    this.customSwatch = menu.querySelector('.swatch[data-color="custom"]');

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) this.open();
      else this.close();
    });
    menu.addEventListener('click', (e) => {
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      if (sw === this.customSwatch) {
        // The system picker opens on the current colour.
        const color = current();
        input.value = window.MemoColor.isCustom(color) ? color : (customStart && customStart()) || '#f2c94c';
        window.MemoColorPicker.open(input, sw);
        return;
      }
      onPick(sw.dataset.color);
      this.close();
    });
    // Only applied when confirmed in the picker; cancelling changes nothing.
    input.addEventListener('change', () => {
      onPick(input.value.toLowerCase());
      this.close();
    });
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    if (closeOnBlur) window.addEventListener('blur', () => this.close());
  }

  get isOpen() {
    return !this.menu.hidden;
  }

  open() {
    if (this.onOpen) this.onOpen();
    this.menu.hidden = false;
    this.frame.classList.add('menu-open');
    this.button.setAttribute('aria-expanded', 'true');
    if (this.onChange) this.onChange(true);
  }

  close() {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.frame.classList.remove('menu-open');
    this.button.setAttribute('aria-expanded', 'false');
    if (this.onChange) this.onChange(false);
  }

  render(color) {
    window.MemoColor.mark(this.menu, color);
  }
}
window.ColorMenu = ColorMenu;
