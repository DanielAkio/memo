// Memo — the group in a window's footer (a note's or a board's): bottom
// left, the group's folder in its colour and its name (or "No group"),
// with a soft wash of the colour at the top of the window. Clicking it
// opens a picker to move the window's object to another group, out of its
// group or into a new one; Rust does the moving and emits "groups-changed".
//   frame        the window frame (gets .menu-open while the picker is open)
//   button       the footer button (#footBtn, with its .foot-folder)
//   menu, items  the popover and the list inside it (#groupMenu, #groupItems)
//   label        the footer text (#edited); tint  the top wash (#groupTint)
//   current()    the group id now ("" = none)
//   onPick(id)   a group was chosen: an id, "" (no group) or "new"
//   onOpen()     before opening: close the window's other popovers
class GroupPicker {
  // A group's label: its name, or "Untitled" (groups start unnamed).
  static label(group) {
    return group.name || window.MemoI18n.t('untitled');
  }

  constructor({ frame, button, menu, items, label, tint, current, onPick, onOpen }) {
    Object.assign(this, { frame, button, menu, items, labelEl: label, tint, current, onOpen });
    this.groups = [];

    button.addEventListener('click', () => (menu.hidden ? this.open() : this.close()));
    items.addEventListener('click', (e) => {
      const item = e.target.closest('.menu-item');
      if (!item) return;
      this.close();
      if (item.dataset.group === this.current()) return;
      onPick(item.dataset.group);
    });
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    window.addEventListener('blur', () => this.close());
  }

  // The current groups (trashed ones left out).
  setGroups(groups) {
    this.groups = groups.filter((g) => !g.trashedAt);
    this.render();
  }

  render() {
    const { t } = window.MemoI18n;
    const id = this.current();
    const group = id ? this.groups.find((g) => g.id === id) : null;
    const color = (group && group.color) || '';
    this.button.classList.toggle('has-group', Boolean(group));
    window.MemoColor.paint(this.button.querySelector('.foot-folder'), color);
    window.MemoColor.paint(this.tint, color);
    this.button.title = group ? t('groupIs', { name: GroupPicker.label(group) }) : t('addToGroup');
    this.labelEl.textContent = group ? GroupPicker.label(group) : t('noGroup');
  }

  open() {
    const { t, locale } = window.MemoI18n;
    if (this.onOpen) this.onOpen();
    const id = this.current();
    const item = (label, value, { checked = false, muted = false } = {}) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `menu-item${muted ? ' muted' : ''}`;
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', String(checked));
      btn.dataset.group = value;
      const text = document.createElement('span');
      text.textContent = label;
      btn.append(text);
      return btn;
    };
    const groups = this.groups
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, locale(), { sensitivity: 'base', numeric: true }))
      .map((g) => item(GroupPicker.label(g), g.id, { checked: g.id === id }));
    const sep = document.createElement('div');
    sep.className = 'menu-sep';
    this.items.replaceChildren(
      ...groups,
      ...(groups.length ? [sep] : []),
      item(t('noGroup'), '', { checked: !id, muted: true }),
      item(t('newGroup'), 'new', { muted: true }),
    );
    this.menu.hidden = false;
    this.frame.classList.add('menu-open');
    this.button.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.frame.classList.remove('menu-open');
    this.button.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.menu.hidden) this.open();
    else this.close();
  }
}
window.GroupPicker = GroupPicker;
