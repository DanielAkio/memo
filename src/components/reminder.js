// Memo — a memory's reminder: when it comes, the memory opens pinned on top
// of everything, with a system notification (Rust reminders.rs; site/web.js
// on Memo Web). Here: its label ("Tomorrow 09:00"), the bell pill shown
// wherever the memory appears (note footer, manager and board cards) and the
// popover that sets it (titlebar menu "Reminder…", or a click on the pill).
// Needs i18n.js.

window.MemoReminder = (() => {
  const BELL = '<path d="M4.25 11.25V7.5a3.75 3.75 0 0 1 7.5 0v3.75l1 1h-9.5zM6.75 13.75a1.25 1.25 0 0 0 2.5 0"/>';
  const MIN = 60_000;

  // The three quick choices as Memo comes (Rust store.rs REMINDER_CHOICES);
  // Settings → Defaults → Memory changes them (get_reminder_defaults). A
  // choice is `in:<N><m|h|d|w>` (in N minutes, hours, days, weeks) or
  // `at:<day>@HH:MM`, the day being today, tomorrow, +N (in N days) or the
  // next mon…sun (store.rs `reminder_choice`).
  const CHOICES = ['in:1h', 'at:today@18:00', 'at:tomorrow@09:00'];
  const AMOUNT_MAX = 365;
  const UNITS = ['m', 'h', 'd', 'w'];
  const UNIT_MIN = { m: 1, h: 60, d: 1440, w: 10080 };
  // In Date.getDay() order.
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  const atTime = (ms, hhmm, days = 0) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(ms);
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const dayOf = (ms, offset = 0) => { const d = new Date(ms); d.setDate(d.getDate() + offset); return d.toDateString(); };
  const amountOk = (n) => Number.isInteger(n) && n >= 1 && n <= AMOUNT_MAX;

  // A choice as { kind: 'in', amount, unit } or { kind: 'at', day, days,
  // time } (day 'plus' = in `days` days), or null if it isn't one.
  function parse(spec) {
    let m = /^in:(\d{1,3})([mhdw])$/.exec(spec || '');
    if (m && amountOk(+m[1])) return { kind: 'in', amount: +m[1], unit: m[2] };
    m = /^at:(today|tomorrow|\+(\d{1,3})|mon|tue|wed|thu|fri|sat|sun)@(([01]\d|2[0-3]):[0-5]\d)$/.exec(spec || '');
    if (m && (!m[2] || amountOk(+m[2]))) return { kind: 'at', day: m[2] ? 'plus' : m[1], days: m[2] ? +m[2] : 1, time: m[3] };
    return null;
  }

  const format = (c) => (c.kind === 'in'
    ? `in:${c.amount}${c.unit}`
    : `at:${c.day === 'plus' ? `+${c.days}` : c.day}@${c.time}`);

  // When a choice falls, from `now`; null for today's time already gone.
  // A day of the week is the next one (today while its time is ahead).
  function when(c, now) {
    if (c.kind === 'in') return Math.ceil((now + c.amount * UNIT_MIN[c.unit] * MIN) / MIN) * MIN;
    const weekday = WEEKDAYS.indexOf(c.day);
    const offset = weekday >= 0 ? (weekday - new Date(now).getDay() + 7) % 7
      : { today: 0, tomorrow: 1, plus: c.days }[c.day];
    const at = atTime(now, c.time, offset);
    const ahead = at - now > 15 * MIN;
    if (ahead) return at;
    return weekday >= 0 ? atTime(now, c.time, offset + 7) : c.day === 'today' ? null : at;
  }

  // "Monday" in the UI language.
  function weekdayName(day) {
    const d = new Date(2024, 0, 7 + WEEKDAYS.indexOf(day)); // 7 Jan 2024 was a Sunday
    const name = d.toLocaleDateString(window.MemoI18n.locale(), { weekday: 'long' });
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  // "1 hora", "30 minutos", "1 h 30 min", "3 dias", "2 semanas".
  function duration(amount, unit = 'm') {
    const { t } = window.MemoI18n;
    const plural = (one, many, n) => t(n === 1 ? one : many, { n });
    if (unit === 'd') return plural('dayOne', 'dayMany', amount);
    if (unit === 'w') return plural('weekOne', 'weekMany', amount);
    const minutes = unit === 'h' ? amount * 60 : amount;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (!h) return plural('minuteOne', 'minuteMany', m);
    if (!m) return plural('hourOne', 'hourMany', h);
    return t('hourMinutes', { h, m });
  }

  // "Em 2 horas", "Hoje às 18:00", "Em 3 dias às 09:00", "Segunda às 09:00".
  function choiceLabel(c) {
    const { t } = window.MemoI18n;
    if (c.kind === 'in') return t('remindIn', { time: duration(c.amount, c.unit) });
    if (c.day === 'today') return t('remindToday', { time: c.time });
    if (c.day === 'tomorrow') return t('remindTomorrow', { time: c.time });
    if (c.day === 'plus') return t('remindInDays', { n: c.days, time: c.time });
    return t('remindWeekday', { day: weekdayName(c.day), time: c.time });
  }

  // The quick choices from `now` that are still ahead: { key, label, at };
  // `choices` from the settings (get_reminder_defaults).
  function presets(now = Date.now(), choices = CHOICES) {
    return choices.map((spec, i) => parse(spec) || parse(CHOICES[i])).filter(Boolean)
      .map((c) => ({ key: c.kind === 'in' ? 'in' : c.day, label: choiceLabel(c), at: when(c, now) }))
      .filter((p) => p.at);
  }

  // "Today 18:00", "Tomorrow 09:00", else "30 Oct 09:00".
  function label(ms, now = Date.now()) {
    const { t, locale } = window.MemoI18n;
    const time = new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    const day = new Date(ms).toDateString();
    if (day === dayOf(now)) return t('todayAt', { time });
    if (day === dayOf(now, 1)) return t('tomorrowAt', { time });
    return `${new Date(ms).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })} ${time}`;
  }

  function icon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = BELL;
    return svg;
  }

  // The bell and when (base.css .pill), or null without a reminder. A
  // button when `onClick` is given (a note's footer): there the bell shows
  // even without a reminder, alone, to set one.
  function pill(ms, onClick) {
    if (!ms && !onClick) return null;
    const { t } = window.MemoI18n;
    const el = document.createElement(onClick ? 'button' : 'span');
    el.className = 'pill reminder-pill';
    el.classList.toggle('is-unset', !ms);
    el.append(icon());
    if (ms) {
      const when = label(ms);
      el.title = t('reminderAt', { when });
      const text = document.createElement('span');
      text.textContent = when;
      el.append(text);
    } else {
      el.title = t('reminder');
      el.setAttribute('aria-label', t('reminder'));
    }
    if (onClick) {
      el.type = 'button';
      el.addEventListener('click', onClick);
    }
    return el;
  }

  // `<input type="datetime-local">` value for `ms`, in local time.
  const inputValue = (ms) => {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * MIN);
    return d.toISOString().slice(0, 16);
  };

  // The popover (base.css .menu): the quick choices, a date and time to
  // pick, and "Remove reminder" when there is one. `get()` is the current
  // reminder (ms or null), `set(ms | null)` saves it, `defaults()` resolves
  // to the quick choices' settings ([minutes, today, tomorrow]).
  class Picker {
    constructor({ get, set, defaults, onOpen }) {
      this.get = get;
      this.set = set;
      this.defaults = defaults;
      this.onOpen = onOpen;
      this.el = document.createElement('div');
      this.el.className = 'menu reminder-menu';
      this.el.tabIndex = -1;
      this.el.hidden = true;
      document.body.append(this.el);
      document.addEventListener('pointerdown', (e) => {
        if (!this.el.hidden && !this.el.contains(e.target) && !e.target.closest('.reminder-pill')) this.close();
      }, true);
      this.el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      });
    }

    get isOpen() { return !this.el.hidden; }

    close() { this.el.hidden = true; }

    toggle() { if (this.isOpen) this.close(); else this.open(); }

    pick(ms) {
      this.close();
      this.set(ms);
    }

    async open() {
      const { t } = window.MemoI18n;
      if (this.onOpen) this.onOpen();
      let choices = CHOICES;
      try {
        if (this.defaults) choices = await this.defaults();
      } catch (err) {
        console.error('get_reminder_defaults', err);
      }
      const current = this.get();
      const item = (text, run, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `menu-item ${cls}`.trim();
        const s = document.createElement('span');
        s.textContent = text;
        b.append(s);
        b.addEventListener('click', run);
        return b;
      };
      const head = document.createElement('div');
      head.className = 'menu-label';
      head.textContent = current ? t('reminderAt', { when: label(current) }) : t('reminder');
      const quick = presets(Date.now(), choices);
      const items = quick.map((p) => {
        const b = item(p.label, () => this.pick(p.at));
        b.dataset.preset = p.key;
        return b;
      });
      const row = document.createElement('div');
      row.className = 'reminder-pick';
      const input = document.createElement('input');
      input.type = 'datetime-local';
      input.value = inputValue(current || (quick[0] ? quick[0].at : Date.now() + 3_600_000));
      input.setAttribute('aria-label', t('remindPick'));
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'reminder-ok';
      ok.textContent = t('remindSet');
      const confirm = () => {
        const ms = new Date(input.value).getTime();
        if (Number.isFinite(ms)) this.pick(ms);
      };
      ok.addEventListener('click', confirm);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } });
      row.append(input, ok);
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      this.el.replaceChildren(head, ...items, sep, row);
      if (current) {
        const sep2 = document.createElement('div');
        sep2.className = 'menu-sep';
        this.el.append(sep2, item(t('remindRemove'), () => this.pick(null), 'muted reminder-remove'));
      }
      this.el.hidden = false;
      // Focus inside, for Esc, without marking the first choice.
      this.el.focus({ preventScroll: true });
    }
  }

  return { BELL, CHOICES, AMOUNT_MAX, UNITS, WEEKDAYS, parse, format, when, weekdayName, duration, choiceLabel, presets, label, pill, Picker };
})();
