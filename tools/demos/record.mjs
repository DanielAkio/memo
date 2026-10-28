// Records the demo GIFs in site/media/ from the real app pages (src/), in a
// fake desktop (stage.html) with a fake Tauri API (mock.js).
//   node tools/demos/record.mjs [pin|write|group|manager|all] [dark|light|all] [en|pt|all]
//   node tools/demos/record.mjs pitch dark pt   (presentation GIF, into dist/)
// Needs Playwright (npm install --no-save playwright) and ffmpeg.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { serve, open, Rec, ROOT } from './lib.mjs';

let page;
let rec;
let lang;
const L = (en, pt) => (lang === 'pt' ? pt : en);
const ev = (fn, arg) => page.evaluate(fn, arg);
const at = async (label, sel, i = 0) => ev(([l, s, k]) => window.Memo.rectIn(l, s, k), [label, sel, i]);

// ------------------------------------------------------------------- pin

// The budget spreadsheet and the "Today" checklist of the pin scenes.
const budget = () => ({
  title: L('Budget 2027.xlsx', 'Orçamento 2027.xlsx'),
  rows: [
    [L('Category', 'Categoria'), ...L('Jan Feb Mar Apr May Jun Jul', 'Jan Fev Mar Abr Mai Jun Jul').split(' ')],
    [L('Rent', 'Aluguel'), 5214, 5847, 1839, 2904, 3120, 4410, 3807],
    [L('Team', 'Equipe'), 8710, 6105, 4497, 3352, 6620, 2981, 5039],
    ['Marketing', 5287, 2916, 6848, 2218, 4093, 3367, 4636],
    ['Software', 1251, 9252, 9529, 1840, 2210, 6115, 2702],
    [L('Travel', 'Viagens'), 4573, 5753, 6847, 3327, 2333, 9671, 4811],
    [L('Events', 'Eventos'), 2893, 5723, 3773, 2182, 7756, 3965, 3951],
    [L('Supplies', 'Materiais'), 1517, 9136, 2948, 8757, 5036, 2924, 6227],
    [L('Consulting', 'Consultoria'), 4416, 7630, 6675, 2024, 2815, 4853, 1612],
  ],
});
const todayNote = () => ({
  title: L('Today', 'Hoje'),
  text: L('[ ] Send the report\n[ ] Review the budget\n[ ] Call Ana', '[ ] Enviar o relatório\n[ ] Revisar o orçamento\n[ ] Ligar para a Ana'),
});
const cell = (r, c) => ev(([r, c]) => window.Memo.cell(r, c), [r, c]);

async function pin() {
  await ev(async ({ sheet, note }) => {
    const M = window.Memo;
    M.sheetApp({ ...sheet, box: 'left:36px;top:22px;width:888px;height:442px' });
    document.getElementById('desk').insertAdjacentHTML('beforeend',
      '<div class="dock"><i></i><i></i><i class="on" id="memoIcon"></i><i></i><i></i></div>');
    document.getElementById('memoIcon').addEventListener('pointerdown', () => M.raise('note-today'));
    M.addNote({ id: 'today', title: note.title, color: 'yellow', x: 600, y: 74, width: 300, height: 250, text: note.text });
    await M.openNote('today');
  }, { sheet: budget(), note: todayNote() });
  const dock = await ev(() => { const b = document.getElementById('memoIcon').getBoundingClientRect(); return { cx: b.left + 15, cy: b.top + 15 }; });

  rec.x = 330; rec.y = 470;
  await rec.cursor('arrow');
  await rec.hold(900);
  // Clicking the spreadsheet buries the memory.
  let c = await cell(5, 3);
  await rec.move(c.cx, c.cy, 700);
  await rec.click({ after: 1100 });
  // Bring it back from the taskbar, and pin it.
  await rec.move(dock.cx, dock.cy, 800);
  await rec.click({ after: 500 });
  const p = await at('note-today', '#pinBtn');
  await rec.move(p.cx, p.cy, 900);
  await rec.hold(300);
  await rec.click({ after: 900 });
  // Work in the spreadsheet: the memory stays on top.
  c = await cell(5, 3);
  await rec.move(c.cx, c.cy, 800);
  await rec.click({ after: 300 });
  await rec.type('4200', 110);
  await rec.press('Enter', 500);
  const box = await at('note-today', '.check', 0);
  await rec.move(box.x + 9, box.cy, 800);
  await rec.click({ after: 700 });
  c = await cell(7, 3);
  await rec.move(c.cx, c.cy, 700);
  await rec.click({ after: 300 });
  await rec.type('3150', 110);
  await rec.press('Enter', 400);
  const box2 = await at('note-today', '.check', 1);
  await rec.move(box2.x + 9, box2.cy, 800);
  await rec.click({ after: 700 });
  await rec.move(c.cx + 120, c.cy + 60, 600);
  await rec.hold(2200);
}

// ----------------------------------------------------------------- write

async function write() {
  await ev(async () => {
    const M = window.Memo;
    M.zoom(1.7, 206, 22);
    M.addNote({ id: 'new', x: 0, y: 0, width: 322, height: 292 });
    await M.openNote('new');
  });
  const mod = 'Control';
  rec.x = 700; rec.y = 380;
  await rec.cursor('arrow');
  await rec.hold(1000);
  // Name it.
  const name = await at('note-new', '#noteName');
  await rec.move(name.cx + 30, name.cy, 700);
  await rec.hold(200);
  await page.mouse.dblclick(rec.x, rec.y);
  await page.waitForTimeout(150);
  await rec.shot(400);
  await rec.type(L('Launch day', 'Dia do lançamento'), 75);
  await rec.press('Enter', 500);
  // A checklist.
  const ed = await at('note-new', '#editor');
  await rec.move(ed.x + 60, ed.y + 30, 600);
  await rec.cursor('text');
  await page.mouse.click(rec.x, rec.y);
  await rec.shot(300);
  await rec.type('[]', 160);
  await rec.hold(300);
  await rec.type(L('Send the newsletter', 'Enviar a newsletter'), 55);
  await rec.press('Enter', 200);
  await rec.type(L('Update the website', 'Atualizar o site'), 55);
  await rec.press('Enter', 200);
  await rec.type(L('Tell the team', 'Avisar o time'), 55);
  await rec.press('Enter', 200);
  await rec.press('Enter', 300);
  await rec.type(L('Press call at 3pm', 'Coletiva às 15h'), 55);
  await rec.press('Enter', 200);
  // Inline code between backticks.
  await rec.type(L('Then run ', 'Depois rode '), 55);
  await rec.type('`npm run deploy`', 75);
  await rec.hold(700);
  // Highlight a line.
  await rec.press('ArrowUp', 200);
  await rec.press('End', 200);
  await rec.press('Shift+Home', 700);
  await rec.press(`${mod}+Shift+KeyH`, 500);
  await rec.press('ArrowDown', 200);
  await rec.hold(900);
  // Tick two items.
  for (const i of [0, 1]) {
    const b = await at('note-new', '.check', i);
    await rec.cursor('arrow');
    await rec.move(b.x + 9, b.cy, 600);
    await rec.click({ after: 450 });
  }
  // Pick a colour.
  const dot = await at('note-new', '#colorBtn');
  await rec.move(dot.cx, dot.cy, 700);
  await rec.click({ after: 700 });
  const y = await at('note-new', '.swatch[data-color="yellow"]');
  await rec.move(y.cx, y.cy, 600);
  await rec.hold(300);
  await rec.click({ after: 400 });
  await rec.move(860, 430, 800);
  await rec.hold(2500);
}

// ----------------------------------------------------------------- group

async function group() {
  await ev(async (t) => {
    const M = window.Memo;
    M.addGroup({ id: 'work', name: t.work, color: 'teal', x: 60, y: 44, width: 312 });
    M.addNote({ id: 'q4', title: t.q4, color: 'teal', groupId: 'work', x: 60, y: 96, width: 300, height: 200, text: t.q4text });
    M.addNote({ id: 'meet', title: t.meet, color: 'yellow', groupId: 'work', x: 372, y: 96, width: 300, height: 200, text: t.meettext });
    M.addNote({ id: 'ideas', title: t.ideas, color: 'coral', x: 560, y: 318, width: 320, height: 176, text: t.ideastext });
    await M.openGroup('work');
    for (const id of ['q4', 'meet', 'ideas']) await M.openNote(id);
    M.hooks.toggle_group = (label) => {
      const g = M.groups.work;
      g.open = !g.open;
      for (const n of Object.values(M.notes)) {
        if (n.groupId === 'work') M.wins[`note-${n.id}`].el.classList.toggle('gone', !g.open);
      }
      M.emit('groups-changed');
      return null;
    };
  }, {
    work: L('Work', 'Trabalho'),
    q4: L('Q4 plan', 'Plano do T4'), q4text: L('[ ] Hire a designer\n[ ] New pricing page\n[ ] Customer survey', '[ ] Contratar designer\n[ ] Nova página de preços\n[ ] Pesquisa com clientes'),
    meet: L('Meeting notes', 'Notas da reunião'), meettext: L('- Ship 0.4 on Friday\n- Ana owns the release notes\n- Next sync: Tuesday', '- Lançar a 0.4 na sexta\n- Ana cuida das notas da versão\n- Próxima reunião: terça'),
    ideas: L('Ideas', 'Ideias'), ideastext: L('Dark mode for the website\nA shortcut to duplicate a memory', 'Modo escuro no site\nAtalho para duplicar uma memória'),
  });
  const toggle = async (after) => {
    const b = await at('group-work', '#toggleBtn');
    await rec.move(b.cx, b.cy, 700);
    await rec.hold(200);
    await rec.click({ after: 120 });
    for (let i = 0; i < 4; i++) await rec.shot(40);
    await rec.hold(after);
  };
  rec.x = 470; rec.y = 470;
  await rec.cursor('arrow');
  await rec.hold(1000);
  await toggle(1300);
  await toggle(1100);
  // Drag "Ideas" onto the bar: it joins the group and goes back where it was.
  const n = await at('note-ideas', '#noteName');
  await rec.move(n.cx + 40, n.cy, 800);
  await rec.hold(200);
  await page.mouse.down();
  const start = { x: 560, y: 318 };
  let over = false;
  const bar = await ev(() => window.Memo.wins['group-work'].el.getBoundingClientRect().toJSON());
  const drag = async (dx, dy) => {
    const inBar = rec.x > bar.left && rec.x < bar.right && rec.y > bar.top && rec.y < bar.bottom;
    await ev(([x, y, on, changed]) => {
      const M = window.Memo;
      M.move('note-ideas', x, y);
      if (changed) M.emit('drop-hover', ['work', on]);
    }, [start.x + dx, start.y + dy, inBar, inBar !== over]);
    over = inBar;
  };
  await rec.move(bar.left + 210, bar.top + 18, 1300, { drag });
  await rec.hold(500);
  await page.mouse.up();
  await ev(() => {
    const M = window.Memo;
    M.emit('drop-hover', ['work', false]);
    M.notes.ideas.groupId = 'work';
    M.emit('groups-changed');
    M.emit('notes-changed');
    const el = M.wins['note-ideas'].el;
    el.style.transition = 'left .35s ease, top .35s ease, opacity .18s';
    M.move('note-ideas', 560, 318);
  });
  for (let i = 0; i < 12; i++) await rec.shot(40);
  await rec.hold(1100);
  await toggle(1500);
  await toggle(1200);
  await rec.move(480, 500, 700);
  await rec.hold(1800);
}

// --------------------------------------------------------------- manager

async function manager() {
  await ev(async (t) => {
    const M = window.Memo;
    const day = 86400000;
    const now = Date.now();
    M.addGroup({ id: 'work', name: t.work, color: 'teal' });
    t.notes.forEach(([id, title, text, color, extra], i) => {
      M.addNote(Object.assign({ id, title, text, color, updatedAt: now - (i ? i * day + 3600000 : 600000), x: 634, y: 70, width: 290, height: 200 }, extra || {}));
    });
    Object.assign(M.manager, { x: 36, y: 20, width: 568, height: 500, color: 'iris' });
    await M.openManager();
  }, {
    work: L('Work', 'Trabalho'),
    notes: [
      ['groceries', L('Groceries', 'Compras'), L('Coffee\nBread\nMilk', 'Café\nPão\nLeite'), 'yellow'],
      ['q4', L('Q4 plan', 'Plano do T4'), L('[ ] Hire a designer\n[ ] New pricing page', '[ ] Contratar designer\n[ ] Nova página de preços'), 'teal', { groupId: 'work' }],
      ['meet', L('Meeting notes', 'Notas da reunião'), L('- Ship 0.4 on Friday', '- Lançar a 0.4 na sexta'), 'yellow', { groupId: 'work' }],
      ['wifi', L('Wi-Fi password', 'Senha do Wi-Fi'), 'memo-2026', 'iris'],
      ['ideas', L('Ideas', 'Ideias'), L('Dark mode for the website\nA shortcut to duplicate a memory', 'Modo escuro no site\nAtalho para duplicar uma memória'), 'coral', { hidden: true }],
      ['books', L('Books to read', 'Livros para ler'), L('The Hobbit\nDune', 'O Hobbit\nDuna'), 'green'],
      ['trip', L('Trip budget', 'Orçamento da viagem'), L('Hotel 1,300\nFlights 900', 'Hotel 1.300\nPassagens 900'), ''],
    ],
  });
  const row = (id, sel = '') => at('manager', `.card[data-id="${id}"] ${sel}`.trim());
  rec.x = 760; rec.y = 470;
  await rec.cursor('arrow');
  await rec.hold(1000);
  // Search.
  const s = await at('manager', '#search');
  await rec.move(s.x + 60, s.cy, 700);
  await rec.cursor('text');
  await rec.click({ after: 200 });
  await rec.type(L('pass', 'senha'), 120);
  await rec.hold(1200);
  await page.keyboard.press('Control+A');
  await rec.press('Backspace', 600);
  // Trash a memory.
  await rec.cursor('arrow');
  let b = await row('books', '[data-act="trash"]');
  await rec.move(b.cx, b.cy, 800);
  await rec.hold(400);
  await rec.click({ after: 900 });
  // Restore it from the trash.
  const seg = await at('manager', '#scopeSwitch .seg[data-scope="trash"]');
  await rec.move(seg.cx, seg.cy, 700);
  await rec.click({ after: 800 });
  b = await row('books', '[data-act="restore"]');
  await rec.move(b.cx, b.cy, 700);
  await rec.hold(300);
  await rec.click({ after: 700 });
  const cur = await at('manager', '#scopeSwitch .seg[data-scope="current"]');
  await rec.move(cur.cx, cur.cy, 700);
  await rec.click({ after: 900 });
  // Reopen a closed memory.
  const r = await row('ideas', '.card-title');
  await rec.move(r.cx, r.cy, 800);
  await rec.hold(300);
  await rec.click({ after: 400 });
  await page.waitForTimeout(300);
  await rec.shot(1200);
  await rec.move(780, 440, 700);
  await rec.hold(2000);
}

// ----------------------------------------------------------------- pitch

// For presentations, not the site (dist/): a pinned memory stays on top of
// every app that comes forward — a spreadsheet, a browser, a terminal.
async function pitch() {
  await ev(async ({ sheet, note, page }) => {
    const M = window.Memo;
    const desk = document.getElementById('desk');
    const box = 'left:24px;top:16px;width:912px;height:462px';
    M.sheetApp({ ...sheet, box }).hidden = true;
    desk.insertAdjacentHTML('beforeend', `
      <div class="app browser" id="browser" style="${box}" hidden>
        <div class="tabs"><span class="dots" style="display:flex;gap:7px;margin:0 12px 10px 2px"><i></i><i></i><i></i></span>
          <span class="tab on">${page.tab}</span><span class="tab">Docs</span></div>
        <div class="url">${page.url}</div>
        <div class="page" id="browserPage" style="height:360px;overflow:hidden">
          <i class="h"></i><i class="img"></i><i></i><i style="width:92%"></i><i style="width:80%"></i><i></i>
          <i class="img"></i><i style="width:70%"></i><i></i><i style="width:85%"></i><i class="img"></i><i></i>
        </div>
      </div>
      <div class="app term" id="term" style="${box}" hidden>
        <div class="bar"><span class="dots"><i></i><i></i><i></i></span>Terminal</div>
        <div class="out" id="termOut"><b>~/projects/site $</b> <span id="termLine"></span></div>
      </div>
      <div class="dock"><i data-app="sheet">X</i><i data-app="browser">W</i><i data-app="term">&gt;_</i><i class="on"></i></div>`);
    for (const icon of document.querySelectorAll('.dock i[data-app]')) {
      icon.addEventListener('pointerdown', () => {
        const app = document.getElementById(icon.dataset.app);
        app.hidden = false;
        M.raiseEl(app);
        for (const i of document.querySelectorAll('.dock i')) i.classList.toggle('front', i === icon);
      });
    }
    const term = document.getElementById('term');
    term.addEventListener('pointerdown', () => M.raiseEl(term));
    document.addEventListener('keydown', (e) => {
      if (M.front !== term) return;
      const line = document.getElementById('termLine');
      if (e.key.length === 1) line.textContent += e.key;
      else if (e.key === 'Enter') {
        document.getElementById('termOut').insertAdjacentHTML('beforeend',
          '\n✓ build ok (1.2s)\n<b>~/projects/site $</b> ');
        line.removeAttribute('id');
        document.getElementById('termOut').insertAdjacentHTML('beforeend', '<span id="termLine"></span>');
      }
    });
    M.addNote({ id: 'today', title: note.title, color: 'yellow', x: 600, y: 60, width: 300, height: 230, text: note.text });
    await M.openNote('today');
  }, { sheet: budget(), note: todayNote(), page: { tab: L('Project plan', 'Plano do projeto'), url: 'example.com/plan' } });

  const dockIcon = (app) => ev((a) => {
    const b = document.querySelector(`.dock i[data-app="${a}"]`).getBoundingClientRect();
    return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  }, app);
  // Brings an app forward from the dock.
  const bring = async (app) => {
    const d = await dockIcon(app);
    await rec.move(d.cx, d.cy, 900);
    await rec.click({ after: 900 });
  };
  const tick = async (i) => {
    const box = await at('note-today', '.check', i);
    await rec.move(box.x + 9, box.cy, 900);
    await rec.click({ after: 800 });
  };

  rec.x = 300; rec.y = 300;
  await rec.cursor('arrow');
  // 1. Pin it.
  await rec.hold(900);
  const p = await at('note-today', '#pinBtn');
  await rec.move(p.cx, p.cy, 1100);
  await rec.hold(400);
  await ev(([x, y]) => window.Memo.ring(x, y), [p.cx, p.cy]);
  await rec.click({ after: 120 });
  await rec.hold(1300);
  // 2. A spreadsheet comes forward: the memory stays on top.
  await bring('sheet');
  const c = await cell(4, 4);
  await rec.move(c.cx, c.cy, 900);
  await rec.click({ after: 300 });
  await rec.type('4200', 110);
  await rec.press('Enter', 500);
  await tick(0);
  // 3. A browser.
  await bring('browser');
  await rec.move(360, 300, 800);
  for (let i = 0; i < 8; i++) {
    await ev(() => { document.getElementById('browserPage').scrollTop += 22; });
    await rec.shot(60);
  }
  await rec.hold(300);
  await tick(1);
  // 4. A terminal; the memory moves anywhere and stays on top.
  await bring('term');
  await rec.move(300, 120, 800);
  await rec.click({ after: 200 });
  await rec.type('npm run build', 85);
  await rec.press('Enter', 700);
  const n = await at('note-today', '#noteName');
  await rec.move(n.cx + 40, n.cy, 800);
  await rec.hold(200);
  await page.mouse.down();
  const start = await ev(() => { const s = window.Memo.wins['note-today'].el.style; return { x: parseInt(s.left, 10), y: parseInt(s.top, 10) }; });
  const drag = (dx, dy) => ev(([x, y]) => window.Memo.move('note-today', x, y), [start.x + dx, start.y + dy]);
  await rec.move(n.cx - 60, n.cy + 110, 1000, { drag });
  await page.mouse.up();
  await rec.hold(300);
  await tick(2);
  await rec.hold(1800);
}

const scenes = { pin, write, group, manager, pitch };
// Scenes for presentations only: recorded by name, into dist/.
const extra = ['pitch'];
const pick = (arg, all) => (!arg || arg === 'all' ? all : [arg]);
const [sceneArg, themeArg, langArg] = process.argv.slice(2);
const server = await serve();
for (const scene of pick(sceneArg, Object.keys(scenes).filter((s) => !extra.includes(s)))) {
  for (const theme of pick(themeArg, ['dark', 'light'])) {
    for (lang of pick(langArg, ['en', 'pt'])) {
      const name = `${scene}-${theme}-${lang}`;
      const opened = await open({ port: server.address().port, theme, lang });
      page = opened.page;
      rec = new Rec(page, path.join(os.tmpdir(), `memo-demo-${name}`));
      await scenes[scene]();
      const outDir = extra.includes(scene) ? path.join(ROOT, 'dist') : path.join(ROOT, 'site', 'media');
      fs.mkdirSync(outDir, { recursive: true });
      rec.encode(path.join(outDir, `${name}.gif`));
      await opened.browser.close();
      console.log(name);
    }
  }
}
server.close();
