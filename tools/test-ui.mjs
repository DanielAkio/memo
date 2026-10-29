// Fast headless UI / integration tests for Memo using Playwright + stage.html.
// Exercises note editor (welcome round-trip, lists, code/Prism, tables, links,
// sanitize, undo/redo, format tray), window chrome (pin, rename, colour,
// close != trash), group bar, and manager (search, groups, trash/restore, tabs,
// Help demos) with zero console/page errors.
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { serve, open, ROOT } from './demos/lib.mjs';

function parseWelcomeRs() {
  const src = fs.readFileSync(path.join(ROOT, 'src-tauri/src/welcome.rs'), 'utf8');
  const extract = (constName) => {
    const start = src.indexOf(`pub const ${constName}: Welcome`);
    const end = src.indexOf('};', start);
    const block = src.slice(start, end);
    const title = block.match(/title:\s*"([^"]+)"/)[1];
    const htmlMatch = block.match(/html:\s*concat!\(([\s\S]*?)\),\s*text:/);
    const html = [...htmlMatch[1].matchAll(/r#"([\s\S]*?)"#/g)].map((m) => m[1]).join('');
    const textMatch = block.match(/text:\s*"([\s\S]*)"\s*,?\s*$/);
    const text = textMatch[1].replace(/\\"/g, '"').replace(/\r\n/g, '\n');
    return { title, html, text };
  };
  return { pt: extract('PT'), en: extract('EN') };
}

const server = await serve();
const port = server.address().port;
let passed = 0;

async function step(name, fn) {
  await fn();
  console.log(`  ok: ${name}`);
  passed++;
}

const { browser, page, errors } = await open({ port, theme: 'dark', lang: 'pt' });
// The ✕'s first-time notice (TitleBar.trash) is off, so a ✕ trashes at once;
// its own step turns it on.
await page.evaluate(() => localStorage.setItem('memo.trashHintOff', '1'));

try {
  // ------------------------------------------------ 1. Welcome note round-trip
  await step('Welcome note HTML sanitize & toPlain/fromPlain round-trip (PT & EN)', async () => {
    const welcomes = parseWelcomeRs();
    for (const [lang, w] of Object.entries(welcomes)) {
      const id = `welcome-${lang}`;
      await page.evaluate(async ({ id, w, lang }) => {
        window.Memo.lang = lang;
        window.Memo.addNote({ id, title: w.title, html: w.html, text: w.text, x: 20, y: 20, width: 380, height: 500 });
        await window.Memo.openNote(id);
      }, { id, w, lang });

      // Trigger an input event in the editor so note.js runs sanitize/toPlain and saves
      const saved = await page.evaluate(async (id) => {
        const doc = window.Memo.frameDoc(`note-${id}`);
        const ed = doc.getElementById('editor');
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        ed.dispatchEvent(new Event('blur'));
        await new Promise((r) => setTimeout(r, 50));
        const n = window.Memo.notes[id];
        window.Memo.closeWin(`note-${id}`);
        return { html: n.html, text: n.text };
      }, id);

      const normHtml = (h) => h.replace(/ spellcheck="false"/g, '').replace(/rgb\(255, 230, 0\);/g, 'rgb(255, 230, 0)');
      assert.equal(normHtml(saved.html), w.html, `Welcome (${lang}) HTML had tags/attributes stripped by sanitize`);
      assert.equal(saved.text, w.text, `Welcome (${lang}) toPlain() text mismatch`);

      // Also verify rebuilding from plain text (html: '') produces the exact same plain text
      const idPlain = `welcome-plain-${lang}`;
      const rebuilt = await page.evaluate(async ({ id, w }) => {
        window.Memo.addNote({ id, title: w.title, html: '', text: w.text, x: 20, y: 20, width: 380, height: 500 });
        await window.Memo.openNote(id);
        const doc = window.Memo.frameDoc(`note-${id}`);
        const ed = doc.getElementById('editor');
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        ed.dispatchEvent(new Event('blur'));
        await new Promise((r) => setTimeout(r, 50));
        const n = window.Memo.notes[id];
        window.Memo.closeWin(`note-${id}`);
        return { text: n.text, html: n.html };
      }, { id: idPlain, w });

      assert.equal(rebuilt.text, w.text, `Welcome (${lang}) fromPlain -> toPlain round-trip mismatch`);
      assert.equal(normHtml(rebuilt.html).includes('<pre class="code" data-lang="sql">'), true, `Welcome (${lang}) fromPlain did not rebuild SQL code block`);
    }
    await page.evaluate(() => { window.Memo.lang = 'pt'; });
  });

  // ------------------------------------------------ 2. Editor features
  await step('Note editor: lists, checklist toggle, code block + Prism, table, sanitize, undo/redo, format tray', async () => {
    await page.evaluate(async () => {
      window.Memo.addNote({
        id: 'ed1',
        title: '',
        html: '',
        text: '[ ] Comprar café\n- Item A\n1. Primeiro\n2. Segundo\n```js\nconst x = 1;\n```\n| Col 1 | Col 2 |\n| --- | --- |\n| val 1 | val 2 |',
        x: 40, y: 30, width: 340, height: 420,
      });
      await window.Memo.openNote('ed1');
    });

    const state1 = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('note-ed1');
      const ed = doc.getElementById('editor');
      const checks = ed.querySelectorAll('.check').length;
      const bullets = ed.querySelectorAll('.bullet').length;
      const nums = [...ed.querySelectorAll('.number')].map((el) => el.dataset.n);
      const codeLayerHtml = doc.getElementById('codeLayer').innerHTML;
      const hasTableHead = Boolean(ed.querySelector('table.head'));

      // Toggle the checklist item by clicking its checkbox area (offsetX = 10)
      const checkEl = ed.querySelector('.check');
      const rect = checkEl.getBoundingClientRect();
      checkEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + 8, clientY: rect.top + 8 }));
      ed.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 50));

      return {
        checks,
        bullets,
        nums,
        hasPrismToken: codeLayerHtml.includes('token'),
        hasTableHead,
        checkedDone: checkEl.classList.contains('done'),
        savedTextAfterCheck: window.Memo.notes.ed1.text,
      };
    });

    assert.equal(state1.checks, 1);
    assert.equal(state1.bullets, 1);
    assert.deepEqual(state1.nums, ['1', '2']);
    assert.equal(state1.hasPrismToken, true, 'Prism should highlight JS code block in #codeLayer');
    assert.equal(state1.hasTableHead, true, 'Table with separator row should have .head class');
    assert.equal(state1.checkedDone, true, 'Clicking check marker should toggle .done');
    assert.ok(state1.savedTextAfterCheck.startsWith('[x] Comprar café\n'), 'Toggled check should save as [x]');

    // Test undo / redo and Format Tray ("Aa")
    const trayAndUndo = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('note-ed1');
      const ed = doc.getElementById('editor');
      // Undo the checkbox toggle via Ctrl+Z
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      ed.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 40));
      const textAfterUndo = window.Memo.notes.ed1.text;

      // Redo via Ctrl+Y
      ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
      ed.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 40));
      const textAfterRedo = window.Memo.notes.ed1.text;

      // Format tray ("Aa") open and Escape close
      const trayBtn = doc.getElementById('trayBtn');
      const formatTray = doc.getElementById('formatTray');
      trayBtn.click();
      const openAfterClick = !formatTray.hidden;
      doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closedAfterEsc = formatTray.hidden;

      return { textAfterUndo, textAfterRedo, openAfterClick, closedAfterEsc };
    });

    assert.ok(trayAndUndo.textAfterUndo.startsWith('[ ] Comprar café\n'), 'Ctrl+Z should undo check toggle');
    assert.ok(trayAndUndo.textAfterRedo.startsWith('[x] Comprar café\n'), 'Ctrl+Y should redo check toggle');
    assert.equal(trayAndUndo.openAfterClick, true, '#trayBtn should open #formatTray');
    assert.equal(trayAndUndo.closedAfterEsc, true, 'Escape should close #formatTray');

    // The tray's button for what the caret's line already is takes it away
    const trayToggle = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('note-ed1');
      const ed = doc.getElementById('editor');
      const win = doc.defaultView;
      const caretAt = (node) => {
        const r = doc.createRange();
        r.selectNodeContents(node);
        r.collapse(false);
        win.getSelection().removeAllRanges();
        win.getSelection().addRange(r);
      };
      const tray = (cmd) => {
        doc.getElementById('trayBtn').click();
        doc.querySelector(`#formatTray [data-cmd="${cmd}"]`).click();
      };
      ed.focus();
      const out = {};
      for (const type of ['check', 'bullet', 'number']) {
        const line = doc.createElement('div');
        line.className = type;
        line.textContent = `item ${type}`;
        ed.append(line);
        const count = ed.children.length;
        caretAt(line);
        tray(type);
        out[type] = !line.classList.contains(type) && line.isConnected && ed.children.length === count;
      }
      // A plain line with text becomes the item itself, no new line.
      for (const type of ['check', 'bullet', 'number']) {
        const line = doc.createElement('div');
        line.textContent = `plain ${type}`;
        ed.append(line);
        const count = ed.children.length;
        caretAt(line);
        tray(type);
        out[`${type}Wraps`] = line.classList.contains(type) && line.textContent === `plain ${type}` && ed.children.length === count;
      }
      const plain = doc.createElement('div');
      plain.textContent = 'plain';
      ed.append(plain);
      const pres = () => ed.querySelectorAll('pre.code').length;
      const before = pres();
      caretAt(plain);
      tray('codeBlock'); // the line becomes a block with its text
      const pre = [...ed.querySelectorAll('pre.code')].find((p) => p.textContent.includes('plain'));
      const made = Boolean(pre) && pres() === before + 1;
      if (pre) {
        caretAt(pre);
        tray('codeBlock'); // and back to a plain line
      }
      out.codeBlock = made && pres() === before && [...ed.children].some((c) => c.nodeName === 'DIV' && c.textContent === 'plain');
      return out;
    });
    assert.deepEqual(trayToggle, {
      check: true, bullet: true, number: true, checkWraps: true, bulletWraps: true, numberWraps: true, codeBlock: true,
    },
      'With just the caret, a tray list / code block button makes the caret line that element, or a plain line again when it already is one');

    // Test pasting multiline text inside a code block stays in one code block
    const pasteCodeTest = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('note-ed1');
      const ed = doc.getElementById('editor');
      const pre = ed.querySelector('pre.code');
      const sel = doc.defaultView.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(pre);
      sel.removeAllRanges();
      sel.addRange(range);

      const dt = new DataTransfer();
      dt.setData('text/plain', 'line 1\nline 2\nline 3');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));

      const preCount = ed.querySelectorAll('pre.code').length;
      const preContent = pre.textContent;
      return { preCount, preContent };
    });

    assert.equal(pasteCodeTest.preCount, 1, 'Pasting multiline text in a code block must NOT create multiple code blocks');
    assert.equal(pasteCodeTest.preContent, 'line 1\nline 2\nline 3', 'Code block content should contain all pasted lines');

    // Test HTML sanitizer (strips <script> and unsafe javascript: links, keeps https:// and mailto:)
    const sanitized = await page.evaluate(async () => {
      window.Memo.addNote({
        id: 'san1',
        html: '<div><script>window.__XSS=1</script><a href="javascript:alert(1)">Bad</a> <a href="https://memo.app">Good</a></div>',
        text: '',
        x: 40, y: 30, width: 300, height: 240,
      });
      await window.Memo.openNote('san1');
      const doc = window.Memo.frameDoc('note-san1');
      const ed = doc.getElementById('editor');
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      ed.dispatchEvent(new Event('blur'));
      await new Promise((r) => setTimeout(r, 40));
      const n = window.Memo.notes.san1;
      window.Memo.closeWin('note-san1');
      return { html: n.html, text: n.text };
    });

    assert.equal(sanitized.html, '<div>Bad <a href="https://memo.app">Good</a></div>');
    assert.equal(sanitized.text, 'Bad [Good](https://memo.app)');
  });

  // ------------------------------------------------ 3. Note window chrome
  await step('Note window chrome: pin, double-click rename, colour picker, touch drag, close != trash', async () => {
    const res = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('note-ed1');
      // 1. Pin
      doc.getElementById('pinBtn').click();
      await new Promise((r) => setTimeout(r, 30));
      const pinned = window.Memo.notes.ed1.pinned;

      // 2. Double-click titlebar to rename
      const titlebar = doc.getElementById('titlebar');
      titlebar.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true }));
      const titleInput = doc.getElementById('titleInput');
      titleInput.value = 'Lista da semana';
      titleInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
      const title = window.Memo.notes.ed1.title;
      const shownName = doc.getElementById('noteName').textContent;

      // 3. Colour picker
      doc.getElementById('colorBtn').click();
      doc.querySelector('#swatches .swatch[data-color="coral"]').click();
      await new Promise((r) => setTimeout(r, 30));
      const color = window.Memo.notes.ed1.color;
      const frameColor = doc.getElementById('frame').dataset.color;

      // 4. Touch action & touch drag
      const titlebarTouchAction = doc.defaultView.getComputedStyle(titlebar).touchAction;
      const gripTouchAction = doc.defaultView.getComputedStyle(doc.getElementById('grip')).touchAction;
      const rsTouchAction = doc.defaultView.getComputedStyle(doc.querySelector('.rs-se')).touchAction;

      const calls = [];
      window.Memo.hooks.drag_start = (label) => { calls.push(['drag_start', label]); };
      window.Memo.hooks.drag_to = (label) => { calls.push(['drag_to', label]); };
      window.Memo.hooks.drag_end = (label) => { calls.push(['drag_end', label]); };

      titlebar.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 50, clientY: 10, screenX: 50, screenY: 10, bubbles: true }));
      titlebar.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 60, clientY: 20, screenX: 60, screenY: 20, bubbles: true }));
      titlebar.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 60, clientY: 20, screenX: 60, screenY: 20, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));

      delete window.Memo.hooks.drag_start;
      delete window.Memo.hooks.drag_to;
      delete window.Memo.hooks.drag_end;

      // 5. Minimize/close button closes (hidden=true) and does NOT trash (trashedAt=null)
      const hasTrashBtn = !!doc.getElementById('trashBtn');
      doc.getElementById('closeBtn').click();
      await new Promise((r) => setTimeout(r, 30));
      const { hidden, trashedAt } = window.Memo.notes.ed1;

      // 6. Trash button sends to trash
      window.Memo.notes.ed1.hidden = false;
      await window.Memo.openNote('ed1');
      const doc2 = window.Memo.frameDoc('note-ed1');
      doc2.getElementById('trashBtn').click();
      await new Promise((r) => setTimeout(r, 30));
      const trashedAfterTrashBtn = !!window.Memo.notes.ed1.trashedAt;
      window.Memo.notes.ed1.trashedAt = null;
      window.Memo.notes.ed1.hidden = true;

      return { pinned, title, shownName, color, frameColor, hidden, trashedAt, hasTrashBtn, trashedAfterTrashBtn, titlebarTouchAction, gripTouchAction, rsTouchAction, calls };
    });

    assert.equal(res.pinned, true);
    assert.equal(res.title, 'Lista da semana');
    assert.equal(res.shownName, 'Lista da semana');
    assert.equal(res.color, 'coral');
    assert.equal(res.frameColor, 'coral');
    assert.equal(res.titlebarTouchAction, 'none', 'Titlebar must have touch-action: none');
    assert.equal(res.gripTouchAction, 'none', 'Grip must have touch-action: none');
    assert.equal(res.rsTouchAction, 'none', 'Resize handle must have touch-action: none');
    assert.ok(res.calls.some((c) => c[0] === 'drag_start'), 'Touch drag must call drag_start');
    assert.ok(res.calls.some((c) => c[0] === 'drag_to'), 'Touch drag must call drag_to');
    assert.ok(res.calls.some((c) => c[0] === 'drag_end'), 'Touch drag must call drag_end');
    assert.equal(res.hidden, true, 'Closing with ✕ must set hidden=true');
    assert.equal(res.trashedAt, null, 'Closing with ✕ must NOT trash the note');
    assert.equal(res.hasTrashBtn, true, 'Note must have #trashBtn');
    assert.equal(res.trashedAfterTrashBtn, true, 'Clicking #trashBtn must send note to trash');
  });

  // ------------------------------------------------ The ✕'s notice: it trashes
  await step('Titlebar ✕: a notice says it trashes; its ✕ cancels, the action trashes, "Don\'t show again" sticks', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = [];
      M.hooks.trash_window = (label) => { calls.push(label); return null; };
      const heights = [];
      M.hooks.set_group_height = (label, a) => { heights.push(a.height); return null; };
      localStorage.removeItem('memo.trashHintOff');
      M.addNote({ id: 'th-note', text: 'x' });
      M.addGroup({ id: 'th-group', name: 'G' });
      await M.openWin('note-th-note', '/src/windows/note/index.html', { x: 40, y: 40, w: 300, h: 260 });
      await M.openWin('group-th-group', '/src/windows/group/group.html', { x: 40, y: 340, w: 300, h: 40 });
      await wait(300);
      const doc = (l) => M.frameDoc(l);
      const notice = (l) => doc(l).querySelector('.toast[data-key="trash-hint"]');
      const out = {};
      // ✕ shows the notice instead of trashing; its own ✕ cancels.
      doc('note-th-note').getElementById('trashBtn').click();
      await wait(30);
      out.text = notice('note-th-note') && notice('note-th-note').textContent;
      out.hasCheck = Boolean(notice('note-th-note') && notice('note-th-note').querySelector('input[type=checkbox]'));
      // In the upper part, right under the titlebar (next to the ✕).
      {
        const d = doc('note-th-note');
        const gap = notice('note-th-note').getBoundingClientRect().top - d.querySelector('.titlebar').getBoundingClientRect().bottom;
        out.underTitlebar = gap >= 0 && gap <= 12;
        // Its ✕ at the top right: level with the text, right of everything.
        const n = notice('note-th-note').getBoundingClientRect();
        const x = notice('note-th-note').querySelector('.toast-close').getBoundingClientRect();
        const go = notice('note-th-note').querySelector('.toast-action').getBoundingClientRect();
        out.closeTopRight = x.top - n.top <= 10 && n.right - x.right <= 10 && x.bottom <= go.top;
      }
      notice('note-th-note').querySelector('.toast-close').click();
      await wait(30);
      out.afterCancel = { notice: Boolean(notice('note-th-note')), calls: calls.length };
      // A click inside it keeps it; one anywhere else closes it, as its ✕.
      const down = (target) => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      doc('note-th-note').getElementById('trashBtn').click();
      await wait(30);
      down(notice('note-th-note').querySelector('.toast-text'));
      out.keptOnInside = Boolean(notice('note-th-note'));
      down(doc('note-th-note').getElementById('editor'));
      await wait(30);
      out.afterOutside = { notice: Boolean(notice('note-th-note')), calls: calls.length };
      // A group bar (too short for it) shows it too; proceeding trashes, once.
      doc('group-th-group').getElementById('trashBtn').click();
      await wait(30);
      out.groupGrew = heights.some((h) => h > 80);
      notice('group-th-group').querySelector('.toast-action').click();
      await wait(30);
      out.afterGo = calls.slice();
      out.offAfterGo = localStorage.getItem('memo.trashHintOff');
      // Checked "Don't show again": the next ✕ trashes at once, in any window.
      doc('note-th-note').getElementById('trashBtn').click();
      await wait(30);
      const n = notice('note-th-note');
      n.querySelector('input[type=checkbox]').click();
      n.querySelector('.toast-action').click();
      await wait(30);
      doc('note-th-note').getElementById('trashBtn').click();
      await wait(30);
      out.direct = { notice: Boolean(notice('note-th-note')), calls: calls.length, off: localStorage.getItem('memo.trashHintOff') };
      M.closeWin('note-th-note');
      M.closeWin('group-th-group');
      delete M.notes['th-note'];
      delete M.groups['th-group'];
      delete M.hooks.trash_window;
      delete M.hooks.set_group_height;
      return out;
    });
    assert.ok(res.text.includes('O ✕ manda para a lixeira.') && !res.text.includes('–') && res.text.includes('Não mostrar de novo') && res.text.includes('Continuar'), `The notice explains the ✕ (${res.text})`);
    assert.equal(res.hasCheck, true, 'It has a "Don\'t show again" checkbox');
    assert.equal(res.underTitlebar, true, 'It shows in the upper part, under the titlebar');
    assert.equal(res.closeTopRight, true, 'Its ✕ is at the top right');
    assert.deepEqual(res.afterCancel, { notice: false, calls: 0 }, 'Its ✕ cancels: nothing trashed');
    assert.equal(res.keptOnInside, true, 'A click inside it keeps it');
    assert.deepEqual(res.afterOutside, { notice: false, calls: 0 }, 'A click outside closes it: nothing trashed');
    assert.equal(res.groupGrew, true, 'A group bar grows for it');
    assert.deepEqual(res.afterGo, ['group-th-group'], 'The action trashes');
    assert.equal(res.offAfterGo, null, 'Unchecked, it shows again next time');
    assert.deepEqual(res.direct, { notice: false, calls: 3, off: '1' }, 'Checked, the next ✕ trashes at once');
  });

  // ------------------------------------------------ 4. Group bar window
  await step('Group bar window: rename, colour, pin, take out / put away toggle', async () => {
    await page.evaluate(async () => {
      window.Memo.addGroup({ id: 'g1', name: '', color: 'teal', open: true, x: 50, y: 50, width: 300 });
      window.Memo.notes.ed1.groupId = 'g1';
      await window.Memo.openGroup('g1');
    });

    const gRes = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('group-g1');
      const initialUntitled = doc.getElementById('groupName').classList.contains('is-empty');

      // Double-click titlebar to rename group
      doc.getElementById('titlebar').dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true }));
      const nameInput = doc.getElementById('nameInput');
      nameInput.value = 'Trabalho';
      nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));

      // Change colour to yellow
      doc.getElementById('colorBtn').click();
      doc.querySelector('#swatches .swatch[data-color="yellow"]').click();
      await new Promise((r) => setTimeout(r, 30));

      // Toggle open/put away
      doc.getElementById('toggleBtn').click();
      await new Promise((r) => setTimeout(r, 30));

      // Pin group
      doc.getElementById('pinBtn').click();
      await new Promise((r) => setTimeout(r, 30));

      const g = window.Memo.groups.g1;
      return {
        initialUntitled,
        name: g.name,
        shownName: doc.getElementById('groupName').textContent,
        color: g.color,
        frameColor: doc.getElementById('frame').dataset.color,
        open: g.open,
        pinned: g.pinned,
        hasTrashBtn: !!doc.getElementById('trashBtn'),
      };
    });

    assert.equal(gRes.initialUntitled, true);
    assert.equal(gRes.name, 'Trabalho');
    assert.equal(gRes.shownName, 'Trabalho');
    assert.equal(gRes.color, 'yellow');
    assert.equal(gRes.frameColor, 'yellow');
    assert.equal(gRes.open, false);
    assert.equal(gRes.pinned, true);
    assert.equal(gRes.hasTrashBtn, true, 'Group must have #trashBtn');
  });

  // ------------------------------------------------ 5. Manager window
  await step('Manager window: cards, search, trash & restore, groups tab, settings, Help demos', async () => {
    await page.evaluate(async () => {
      // Keep only our test notes (ed1 + a second note n2)
      for (const k of Object.keys(window.Memo.notes)) {
        if (k !== 'ed1') delete window.Memo.notes[k];
      }
      window.Memo.addNote({ id: 'n2', title: 'Reunião', text: 'Pauta de orçamento', color: 'green', x: 80, y: 80 });
      await window.Memo.openManager();
    });

    const mgrRes = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('manager');
      const initialCards = doc.querySelectorAll('#list .card').length;
      const ed1ClosedClass = doc.querySelector('#list .card[data-id="ed1"]').classList.contains('is-closed');
      const defaultLayoutCards = doc.querySelector('#layoutSwitch [data-layout="cards"]').getAttribute('aria-checked') === 'true';
      const listHasNoAsList = !doc.getElementById('list').classList.contains('as-list');
      const ed1HasCheckComponent = Boolean(doc.querySelector('#list .card[data-id="ed1"] .card-preview .check'));
      const ed1PreviewLimitedHeight = parseInt(doc.defaultView.getComputedStyle(doc.querySelector('#list .card[data-id="ed1"] .card-preview')).maxHeight, 10) <= 150;

      // Search by group name ("Trabalho" -> matches ed1)
      const search = doc.getElementById('search');
      search.value = 'Trabalho';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const searchByGroupCount = doc.querySelectorAll('#list .card').length;

      // Clear search
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));

      // Trash n2 from the manager card
      doc.querySelector('#list .card[data-id="n2"] [data-act="trash"]').click();
      await new Promise((r) => setTimeout(r, 180));
      const afterTrashActiveCount = doc.querySelectorAll('#list .card').length;

      // Switch to Trash scope and restore n2
      doc.querySelector('#scopeSwitch [data-scope="trash"]').click();
      const trashCount = doc.querySelectorAll('#list .card').length;
      doc.querySelector('#list .card[data-id="n2"] [data-act="restore"]').click();
      await new Promise((r) => setTimeout(r, 180));
      const trashCountAfterRestore = doc.querySelectorAll('#list .card').length;

      // Switch back to Current scope
      doc.querySelector('#scopeSwitch [data-scope="current"]').click();
      const restoredCount = doc.querySelectorAll('#list .card').length;

      // Middle click n2 in Current scope -> moves to trash
      const n2Card = doc.querySelector('#list .card[data-id="n2"]');
      n2Card.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
      await new Promise((r) => setTimeout(r, 180));
      const afterMiddleTrashCount = doc.querySelectorAll('#list .card').length;

      // Switch to Trash scope
      doc.querySelector('#scopeSwitch [data-scope="trash"]').click();
      const trashCountBeforeMiddleDel = doc.querySelectorAll('#list .card').length;

      // Middle click n2 in Trash scope -> deletes forever
      const n2TrashCard = doc.querySelector('#list .card[data-id="n2"]');
      n2TrashCard.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
      await new Promise((r) => setTimeout(r, 180));
      const trashCountAfterMiddleDel = doc.querySelectorAll('#list .card').length;
      const n2DeletedForever = !window.Memo.notes.n2;

      // Switch back to Current scope
      doc.querySelector('#scopeSwitch [data-scope="current"]').click();

      // Switch to Groups tab
      doc.getElementById('tabGroups').click();
      const groupCardsCount = doc.querySelectorAll('#list .group-card').length;

      // Middle click group in Current scope -> moves to trash, then middle click in Trash scope -> deletes forever
      const gCard = doc.querySelector('#list .group-card[data-gid="g1"]');
      if (gCard) {
        gCard.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
        await new Promise((r) => setTimeout(r, 180));
        doc.querySelector('#scopeSwitch [data-scope="trash"]').click();
        const gTrashCard = doc.querySelector('#list .group-card[data-gid="g1"]');
        if (gTrashCard) {
          gTrashCard.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
          await new Promise((r) => setTimeout(r, 180));
        }
      }
      const g1DeletedForever = !window.Memo.groups.g1;

      // Switch back to Current scope and Groups tab
      doc.querySelector('#scopeSwitch [data-scope="current"]').click();

      // Switch to Settings tab
      doc.getElementById('tabSettings').click();
      const settingsVisible = !doc.getElementById('settingsView').hidden;
      const openSettingsCount = doc.querySelectorAll('#settingsView .sec.is-open').length;

      // Switch to Help tab and check rendered sections + demos
      doc.getElementById('tabHelp').click();
      const helpSections = doc.querySelectorAll('#helpView .sec').length;
      const openHelpCount = doc.querySelectorAll('#helpView .sec.is-open').length;
      const helpDemos = doc.querySelectorAll('#helpView .help-demo').length;

      return {
        initialCards,
        ed1ClosedClass,
        defaultLayoutCards,
        listHasNoAsList,
        ed1HasCheckComponent,
        ed1PreviewLimitedHeight,
        searchByGroupCount,
        afterTrashActiveCount,
        trashCount,
        trashCountAfterRestore,
        restoredCount,
        afterMiddleTrashCount,
        trashCountBeforeMiddleDel,
        trashCountAfterMiddleDel,
        n2DeletedForever,
        groupCardsCount,
        g1DeletedForever,
        settingsVisible,
        openSettingsCount,
        helpSections,
        openHelpCount,
        helpDemos,
      };
    });

    assert.equal(mgrRes.initialCards, 2);
    assert.equal(mgrRes.ed1ClosedClass, true, 'Closed note should have .is-closed in manager');
    assert.equal(mgrRes.defaultLayoutCards, true, 'Cards appearance should be the default in manager');
    assert.equal(mgrRes.listHasNoAsList, true, 'List should not have .as-list by default');
    assert.equal(mgrRes.ed1HasCheckComponent, true, 'Note cards in manager should render text components like .check');
    assert.equal(mgrRes.ed1PreviewLimitedHeight, true, 'Note card preview should have limited height');
    assert.equal(mgrRes.searchByGroupCount, 1, 'Search should match by group name');
    assert.equal(mgrRes.afterTrashActiveCount, 1);
    assert.equal(mgrRes.trashCount, 1);
    assert.equal(mgrRes.trashCountAfterRestore, 0);
    assert.equal(mgrRes.restoredCount, 2);
    assert.equal(mgrRes.afterMiddleTrashCount, 1, 'Middle click in active list should move note to trash');
    assert.equal(mgrRes.trashCountBeforeMiddleDel, 1);
    assert.equal(mgrRes.trashCountAfterMiddleDel, 0, 'Middle click in trash should permanently delete note');
    assert.equal(mgrRes.n2DeletedForever, true, 'Note should be deleted forever from store');
    assert.equal(mgrRes.groupCardsCount, 1);
    assert.equal(mgrRes.g1DeletedForever, true, 'Middle click on group in trash should permanently delete group');
    assert.equal(mgrRes.settingsVisible, true);
    assert.equal(mgrRes.openSettingsCount, 0, 'Settings sections should all be closed by default');
    assert.equal(mgrRes.helpSections, 5);
    assert.equal(mgrRes.openHelpCount, 0, 'Help sections should all be closed by default');
    assert.ok(mgrRes.helpDemos > 10, 'Help tab should render interactive demo elements');
  });

  // ------------------------------------------------ 6. Mobile web: no manager close option
  await step('Mobile web: manager close option is omitted (✕ button hidden, close action excluded)', async () => {
    const res = await page.evaluate(async () => {
      const doc = window.Memo.frameDoc('manager');
      const win = doc.defaultView;
      const closeBtn = doc.getElementById('closeBtn');

      // Desktop: close button is visible
      const desktopHidden = closeBtn.hidden || getComputedStyle(closeBtn).display === 'none';

      // Simulate mobile web
      window.MemoWeb = { isMobile: () => true };
      win.dispatchEvent(new Event('memo-mobile-changed'));
      await new Promise((r) => setTimeout(r, 30));

      const mobileHidden = closeBtn.hidden || getComputedStyle(closeBtn).display === 'none';
      const rootHasMobileClass = doc.documentElement.classList.contains('is-mobile');

      // Check title menu items via show_title_menu mock/capture
      let capturedItems = null;
      window.Memo.hooks.show_title_menu = (label, a) => {
        capturedItems = a.items;
        return null;
      };

      doc.getElementById('titlebar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 30));
      delete window.Memo.hooks.show_title_menu;

      const hasCloseMenuItem = capturedItems && capturedItems.some((it) => it && (it.label === 'Fechar' || it.label === 'Close'));

      // Restore
      delete window.MemoWeb;
      win.dispatchEvent(new Event('memo-mobile-changed'));
      await new Promise((r) => setTimeout(r, 30));

      return {
        desktopHidden,
        mobileHidden,
        rootHasMobileClass,
        hasCloseMenuItem,
      };
    });

    assert.equal(res.desktopHidden, false, 'Close button should be visible on desktop');
    assert.equal(res.mobileHidden, true, 'Close button should be hidden on mobile web');
    assert.equal(res.rootHasMobileClass, true, 'Manager root element should have is-mobile class');
    assert.equal(res.hasCloseMenuItem, false, 'Title menu should not have Fechar/Close on mobile web');
  });

  // ------------------------------------------------ 7. Board component
  await step('Board component: creation via manager button, right-click on upper tab, and board window column management', async () => {
    const res = await page.evaluate(async () => {
      const mgrDoc = window.Memo.frameDoc('manager');
      const newBoardBtn = mgrDoc.getElementById('newBoardBtn');
      const mgrHead = mgrDoc.querySelector('.mgr-head');

      const initialBoardCount = Object.keys(window.Memo.boards).length;

      // 1. Click button next to folder creator
      newBoardBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const countAfterBtn = Object.keys(window.Memo.boards).length;

      // 2. Right-click on upper tab
      mgrHead.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 300));
      const countAfterRightClick = Object.keys(window.Memo.boards).length;

      // 3. Inspect opened board window
      const boardIds = Object.keys(window.Memo.boards);
      const latestBoardId = boardIds[boardIds.length - 1];
      const boardDoc = window.Memo.frameDoc(`board-${latestBoardId}`);

      let columnsCount = 0;
      let noAddColBtn = false;
      let hasFooterStatusbar = false;
      let hasFootBtn = false;
      let hasTrashBtn = false;
      let footBtnOpensMenu = false;
      if (boardDoc) {
        columnsCount = boardDoc.querySelectorAll('.board-column').length;
        hasTrashBtn = Boolean(boardDoc.getElementById('trashBtn'));
        noAddColBtn = !boardDoc.getElementById('addColumnBtn') && !boardDoc.getElementById('addColBtn');
        const foot = boardDoc.querySelector('footer.statusbar');
        const fBtn = boardDoc.getElementById('footBtn');
        const gMenu = boardDoc.getElementById('groupMenu');
        hasFooterStatusbar = Boolean(foot);
        hasFootBtn = Boolean(fBtn);
        if (fBtn && gMenu) {
          fBtn.click();
          footBtnOpensMenu = !gMenu.hidden;
          // A click elsewhere closes it.
          boardDoc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          footBtnOpensMenu = footBtnOpensMenu && gMenu.hidden;
        }
      }

      // 4. Test dragging a card between columns and rendering text components
      window.Memo.addNote({ id: 'bn1', title: 'Card 1', text: '[ ] Task 1\n- Item 2', trashedAt: null });
      const testNoteId = 'bn1';
      const targetBoard = window.Memo.boards[latestBoardId];
      let cardMovedToCol1 = false;
      let card = null;
      let targetCol = null;
      let boardCardSnippetHasCheck = false;
      let boardCardSnippetLimitedHeight = false;
      let noteWindowOpenedOnClick = false;
      if (targetBoard && targetBoard.columns.length >= 2) {
        targetBoard.columns[0].noteIds = [testNoteId];
        targetBoard.columns[1].noteIds = [];
        window.Memo.emit('notes-changed');
        window.Memo.emit('boards-changed');
        await new Promise((r) => setTimeout(r, 250));

        card = boardDoc.querySelector(`.board-card[data-note-id="${testNoteId}"]`);
        if (card) {
          const snippet = card.querySelector('.card-snippet');
          boardCardSnippetHasCheck = Boolean(snippet && snippet.querySelector('.check'));
          if (snippet) {
            boardCardSnippetLimitedHeight = parseInt(boardDoc.defaultView.getComputedStyle(snippet).maxHeight, 10) <= 150;
          }
        }
        if (card) {
          card.click();
          await new Promise((r) => setTimeout(r, 100));
          noteWindowOpenedOnClick = Boolean(window.Memo.wins[`note-${testNoteId}`]);
        }

        targetCol = boardDoc.querySelectorAll('.board-column')[1];
        if (card && targetCol) {
          const bwin = boardDoc.defaultView;
          const ev = (type, target, x, y) => target.dispatchEvent(new bwin.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }));
          const from = card.getBoundingClientRect();
          const to = targetCol.querySelector('.col-cards').getBoundingClientRect();
          ev('pointerdown', card, from.left + 10, from.top + 10);
          ev('pointermove', bwin, from.left + 30, from.top + 30);
          ev('pointermove', bwin, to.left + 20, to.top + 20);
          ev('pointerup', bwin, to.left + 20, to.top + 20);
          await new Promise((r) => setTimeout(r, 250));
          cardMovedToCol1 = targetBoard.columns[1].noteIds.includes(testNoteId) &&
                            !targetBoard.columns[0].noteIds.includes(testNoteId);
        }
      }

        let boardRenameOnDblClick = false;
        let boardPinnedViaShortcut = false;
        let boardClosedOnMiddleClick = false;
        const bTitlebar = boardDoc.getElementById('titlebar');
        const bNameInput = boardDoc.getElementById('nameInput');
        if (bTitlebar && bNameInput) {
          bTitlebar.dispatchEvent(new MouseEvent('mousedown', { button: 0, detail: 2, bubbles: true }));
          boardRenameOnDblClick = !bNameInput.hidden;
          bNameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }

        boardDoc.defaultView.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, shiftKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        boardPinnedViaShortcut = Boolean(targetBoard && targetBoard.pinned);

        if (bTitlebar) {
          bTitlebar.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));
          boardClosedOnMiddleClick = Boolean(targetBoard && targetBoard.hidden);
        }

        return {
          initialBoardCount,
          countAfterBtn,
          countAfterRightClick,
          hasBoardDoc: Boolean(boardDoc),
          columnsCount,
          noAddColBtn,
          hasFooterStatusbar,
          hasFootBtn,
          hasTrashBtn,
          footBtnOpensMenu,
          cardMovedToCol1,
          noteWindowOpenedOnClick,
          boardCardSnippetHasCheck,
          boardCardSnippetLimitedHeight,
          boardRenameOnDblClick,
          boardPinnedViaShortcut,
          boardClosedOnMiddleClick,
        };
      });

      assert.equal(res.countAfterBtn, res.initialBoardCount + 1, 'Clicking new board button should create a board');
      assert.equal(res.countAfterRightClick, res.initialBoardCount + 2, 'Right-clicking upper tab should create a board');
      assert.equal(res.hasBoardDoc, true, 'Board window should be opened in stage');
      assert.equal(res.hasTrashBtn, true, 'Board must have #trashBtn');
      assert.ok(res.columnsCount >= 3, 'Board window should render default columns');
      assert.equal(res.noAddColBtn, true, 'Add column buttons should be removed from board');
      assert.equal(res.hasFooterStatusbar, true, 'Board window should have a statusbar footer at the bottom');
      assert.equal(res.hasFootBtn, true, 'Board statusbar should contain a footBtn group selector');
      assert.equal(res.footBtnOpensMenu, true, 'Clicking board footBtn should open group picker menu, and a click elsewhere close it');
      assert.equal(res.cardMovedToCol1, true, 'Dragging a memory card from one column to another should move it');
      assert.equal(res.noteWindowOpenedOnClick, true, 'One left click on a memory card should open its note window');
      assert.equal(res.boardCardSnippetHasCheck, true, 'Board cards should render text components like .check');
      assert.equal(res.boardCardSnippetLimitedHeight, true, 'Board card snippet should have limited height');
      assert.equal(res.boardRenameOnDblClick, true, 'Double-clicking board titlebar should enter rename mode');
      assert.equal(res.boardPinnedViaShortcut, true, 'Ctrl+Shift+P should toggle pin on board window');
      assert.equal(res.boardClosedOnMiddleClick, true, 'Scroll click (middle click) on board titlebar should minimize/close board');
  });

  // ------------------------------------------------ 7b. Manager shows a memory's boards
  await step('Manager: a memory card shows its group and boards as pills (name, colour, search, no picker)', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      M.addGroup({ id: 'chip-group', name: 'Chip group', color: 'teal' });
      M.addNote({ id: 'chip-note', title: 'Chip test', text: 'Chip test', groupId: 'chip-group' });
      M.addBoard({ id: 'chip-board', name: 'Chip board', color: 'coral' });
      M.boards['chip-board'].columns[0].noteIds.push('chip-note');
      M.closeWin('manager');
      await M.openManager();
      const doc = M.frameDoc('manager');
      const card = doc.querySelector('#list .card[data-id="chip-note"]');
      const pills = card ? [...card.querySelectorAll('.pill')] : [];
      const chip = pills.find((p) => p.textContent === 'Chip board');
      const groupChip = pills.find((p) => p.textContent === 'Chip group');
      const search = doc.getElementById('search');
      search.value = 'chip board';
      search.dispatchEvent(new Event('input'));
      const found = [...doc.querySelectorAll('#list .card')].map((c) => c.dataset.id);
      search.value = '';
      search.dispatchEvent(new Event('input'));
      const out = {
        name: chip && chip.textContent,
        color: chip && chip.querySelector('svg').dataset.color,
        groupColor: groupChip && groupChip.querySelector('svg').dataset.color,
        pickers: doc.querySelectorAll('#list select, #list .pill button').length,
        found,
        // A chip exactly on the memories that some board holds.
        chipMismatches: [...doc.querySelectorAll('#list .card')].filter((c) => {
          const onBoard = Object.values(M.boards).some((b) => !b.trashedAt
            && b.columns.some((col) => col.noteIds.includes(c.dataset.id)));
          const pillCount = c.querySelectorAll('.pill').length;
          const expected = (onBoard ? 1 : 0) + (M.notes[c.dataset.id] && M.notes[c.dataset.id].groupId ? 1 : 0);
          return c.dataset.id && pillCount < expected;
        }).length,
      };
      return out;
    });
    assert.equal(res.name, 'Chip board', 'The memory card should show the board name');
    assert.equal(res.color, 'coral', 'The board icon should take the board colour');
    assert.deepEqual(res.found, ['chip-note'], 'Searching a board name should find its memories');
    // The memory's own footer shows the board too (same pill).
    const foot = await page.evaluate(async () => {
      await window.Memo.openNote('chip-note');
      await new Promise((r) => setTimeout(r, 200));
      const doc = window.Memo.frameDoc('note-chip-note');
      const pills = [...doc.querySelectorAll('#footBoards .pill')].map((p) => p.textContent);
      window.Memo.closeWin('note-chip-note');
      return pills;
    });
    assert.deepEqual(foot, ['Chip board'], 'A memory on a board shows it as a pill in its footer');
    assert.equal(res.groupColor, 'teal', 'The group pill should show the group colour');
    assert.equal(res.pickers, 0, 'The manager list should not offer a group picker');
    assert.equal(res.chipMismatches, 0, 'Every memory on a board or in a group should show its pills');
  });

  // ------------------------------------------------ 7c. Legacy colour, board card counts
  await step('Legacy lavender memory renders; board cards count columns and memories', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      M.addNote({ id: 'lavender-note', title: 'Old', text: 'Old', color: 'lavender', x: 20, y: 20 });
      await M.openNote('lavender-note');
      const colorTitle = M.frameDoc('note-lavender-note').getElementById('colorBtn').title;
      M.closeWin('note-lavender-note');
      M.addBoard({ id: 'count-board', name: 'Count board' });
      M.boards['count-board'].columns[0].noteIds.push('lavender-note');
      M.closeWin('manager');
      await M.openManager();
      const doc = M.frameDoc('manager');
      doc.getElementById('tabBoards').click();
      await new Promise((r) => setTimeout(r, 100));
      const card = doc.querySelector('#list .card[data-bid="count-board"]');
      const preview = card && card.querySelector('.card-preview').textContent;
      doc.getElementById('tabNotes').click();
      return { colorTitle, preview };
    });
    assert.equal(res.colorTitle, 'Cor: Lavanda', 'A legacy lavender memory names its colour (no swatch for it)');
    assert.equal(res.preview, '3 colunas · 1 memória', 'Board cards count columns and memories in words');
  });

  // ------------------------------------------------ 7d. Board: add a column at either end, "+" adds a memory
  await step('Board: "add column" sits at both ends; the titlebar "+" opens a new memory off the board', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      M.addBoard({ id: 'edge-board', name: 'Edges' });
      await M.openWin('board-edge-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 820, h: 360 });
      const doc = M.frameDoc('board-edge-board');
      const shown = (side) => doc.querySelector(`.col-add[data-side="${side}"]`).getBoundingClientRect().width > 0;
      const out = { left: shown('left'), right: shown('right') };
      doc.querySelector('.col-add[data-side="right"]').click();
      await new Promise((r) => setTimeout(r, 200)); // saved and reloaded
      doc.querySelector('.col-add[data-side="left"]').click();
      await new Promise((r) => setTimeout(r, 100));
      out.names = M.boards['edge-board'].columns.map((c) => c.name);
      out.editing = Boolean(doc.activeElement && doc.activeElement.classList.contains('col-input'));
      const before = Object.keys(M.notes);
      doc.getElementById('newBtn').click();
      await new Promise((r) => setTimeout(r, 300));
      const added = Object.keys(M.notes).filter((id) => !before.includes(id));
      out.added = added.length;
      out.onBoard = M.boards['edge-board'].columns.some((c) => c.noteIds.includes(added[0]));
      out.opened = Boolean(added[0] && M.wins[`note-${added[0]}`]);
      if (added[0]) M.closeWin(`note-${added[0]}`);
      M.closeWin('board-edge-board');
      return out;
    });
    assert.equal(res.left && res.right, true, 'Both "add column" strips are always shown');
    assert.deepEqual(res.names, ['', 'To Do', 'In Progress', 'Done', ''],
      'Clicking adds a column at that side');
    assert.equal(res.editing, false, 'The new column is just added, its name not opened for editing');
    assert.equal(res.added, 1, 'The "+" creates one memory');
    assert.equal(res.onBoard, false, 'The new memory is not put on the board');
    assert.equal(res.opened, true, 'The new memory opens');
  });

  // ------------------------------------------------ 7d2. Board: no columns left, one place to add the first
  await step('Board: with every column deleted, one wide "Add column" replaces the edge strips and adds the first', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      M.addBoard({ id: 'empty-board', name: 'Empty' });
      M.boards['empty-board'].columns = [];
      await M.openWin('board-empty-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 620, h: 320 });
      await new Promise((r) => setTimeout(r, 200));
      const doc = M.frameDoc('board-empty-board');
      const first = doc.querySelector('.col-first');
      const track = doc.querySelector('.columns-track').getBoundingClientRect();
      const r = first && first.getBoundingClientRect();
      const out = {
        strips: doc.querySelectorAll('.col-add').length,
        label: first && first.textContent,
        fills: Boolean(r) && r.width > track.width * 0.9,
        firstLook: first && ((cs) => [cs.backgroundColor, cs.borderTopStyle, cs.borderTopColor])(getComputedStyle(first)),
      };
      first.click();
      await new Promise((r) => setTimeout(r, 200));
      out.columns = M.boards['empty-board'].columns.length;
      out.firstGone = !doc.querySelector('.col-first');
      out.stripsAfter = doc.querySelectorAll('.col-add').length;
      const look = (el) => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.borderTopStyle, cs.borderTopColor]; };
      out.sameLook = [...doc.querySelectorAll('.col-add')].every((el) => JSON.stringify(look(el)) === JSON.stringify(out.firstLook));
      M.closeWin('board-empty-board');
      return out;
    });
    assert.equal(res.strips, 0, 'No edge strip (which sat at the left) on an empty board');
    assert.equal(res.label, 'Adicionar coluna');
    assert.equal(res.fills, true, 'It fills the board');
    assert.equal(res.columns, 1, 'Clicking it adds the first column');
    assert.equal(res.firstGone && res.stripsAfter === 2, true, 'Then the edge strips come back');
    assert.equal(res.firstLook[0], 'rgba(0, 0, 0, 0)', 'Unfilled');
    assert.equal(res.sameLook, true, 'The edge strips look like it: unfilled, dashed');
  });

  // ------------------------------------------------ 7d4. Demo stage: the presentation helpers (record.mjs pitch)
  await step('Demo stage: no captions or closing card, and a pinned memory above an app brought forward', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const out = {};
      out.noCaption = !('caption' in M);
      out.noEndCard = !('endCard' in M);
      M.addNote({ id: 'pitch-note', text: 'x', x: 600, y: 60 });
      await M.openNote('pitch-note');
      await M.invoke('note-pitch-note', 'set_pinned', { pinned: true });
      const sheet = M.sheetApp({ rows: [['A', 1]], title: 'S', box: 'left:0;top:0;width:900px;height:460px' });
      sheet.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      out.front = M.front === sheet;
      out.noteAbove = Number(M.wins['note-pitch-note'].el.style.zIndex) > Number(sheet.style.zIndex);
      sheet.remove();
      await M.invoke('note-pitch-note', 'set_pinned', { pinned: false });
      M.closeWin('note-pitch-note');
      // The click pulse is drawn at the progress the recorder asks for, so
      // every frame of the GIF shows a step of it.
      const ring = (t) => { M.ring(100, 100, t); const el = document.querySelector('.ring'); return el && { scale: parseFloat(el.style.transform.slice(6)), opacity: Number(el.style.opacity), anim: getComputedStyle(el).animationName }; };
      out.ring = [ring(0), ring(0.5), ring(1)];
      return out;
    });
    const [r0, r5, r1] = res.ring;
    assert.ok(r0.scale < r5.scale && r0.opacity > r5.opacity, `The click pulse grows and fades step by step (${JSON.stringify(res.ring)})`);
    assert.equal(r5.anim, 'none', 'The click pulse runs on no wall-clock animation');
    assert.equal(r1, null, 'The click pulse is gone at its end');
    assert.equal(res.noCaption, true, 'The presentation GIF has no captions');
    assert.equal(res.front, true, 'A clicked app comes forward');
    assert.equal(res.noteAbove, true, 'A pinned memory stays above it');
    assert.equal(res.noEndCard, true, 'It loops on the app in use, with no closing card');
  });

  // ------------------------------------------------ 7d3. Board: "New memory" at the bottom of a column
  await step('Board: each column ends with "New memory", which adds one at its bottom and opens it', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      M.addBoard({ id: 'add-board', name: 'Add' });
      await M.openWin('board-add-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 820, h: 360 });
      await new Promise((r) => setTimeout(r, 200));
      const doc = M.frameDoc('board-add-board');
      const cols = [...doc.querySelectorAll('.board-column')];
      const out = { buttons: cols.map((c) => c.lastElementChild.matches('.col-add-note')) };
      out.label = cols[1].querySelector('.col-add-note').textContent;
      const before = Object.keys(M.notes);
      cols[1].querySelector('.col-add-note').click();
      await new Promise((r) => setTimeout(r, 300));
      const added = Object.keys(M.notes).filter((id) => !before.includes(id));
      const b = M.boards['add-board'];
      out.added = added.length;
      out.inColumn = b.columns[1].noteIds.at(-1) === added[0];
      out.others = b.columns[0].noteIds.length + b.columns[2].noteIds.length;
      out.opened = Boolean(added[0] && M.wins['note-' + added[0]]);
      out.cards = doc.querySelectorAll('.board-column')[1].querySelectorAll('.board-card').length;
      // The column header shows no count of its memories (only dot, name, ✕).
      const head = doc.querySelectorAll('.board-column')[1].querySelector('.col-head');
      out.headText = [...head.querySelectorAll('*')].filter((el) => !el.children.length && /^\d+$/.test(el.textContent.trim())).length;
      out.countEl = doc.querySelectorAll('.col-count').length;
      if (added[0]) M.closeWin('note-' + added[0]);
      M.closeWin('board-add-board');
      return out;
    });
    assert.deepEqual(res.buttons, [true, true, true], 'Every column ends with the button');
    assert.equal(res.label, 'Nova memória');
    assert.equal(res.added, 1, 'One memory is created');
    assert.equal(res.inColumn && res.others === 0, true, 'At the bottom of that column only');
    assert.equal(res.opened, true, 'It opens to be written');
    assert.equal(res.cards, 1, 'Its card shows in the column');
    assert.deepEqual([res.countEl, res.headText], [0, 0], 'A column header shows no memory count');
  });

  // ------------------------------------------------ 7e. Card preview: long lines don't overlap
  await step('Card preview: long checklist lines wrap without overlapping the next', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const long = 'x'.repeat(90);
      M.addNote({ id: 'long-note', text: [1, 2, 3, 4, 5].map((i) => `[ ] ${long}${i}`).join(String.fromCharCode(10)) });
      M.addBoard({ id: 'long-board', name: 'Long', columns: [{ id: 'c1', name: '', noteIds: ['long-note'] }] });
      await M.openWin('board-long-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 420, h: 360 });
      await new Promise((r) => setTimeout(r, 300));
      const lines = [...M.frameDoc('board-long-board').querySelectorAll('.card-snippet > *')];
      const overlap = lines.some((el, i) => i > 0 && el.getBoundingClientRect().top < lines[i - 1].getBoundingClientRect().bottom - 0.5);
      M.closeWin('board-long-board');
      return { count: lines.length, overlap };
    });
    assert.ok(res.count > 1, 'The card shows the checklist lines');
    assert.equal(res.overlap, false, 'Each line starts below the previous one');
  });

  // ------------------------------------------------ 7f. Board: a skeleton shows where a dragged memory lands
  await step('Board: dragging a memory shows a skeleton where it will land, and it lands there', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      for (const id of ['sk-a', 'sk-b', 'sk-c']) M.addNote({ id, text: id });
      M.addBoard({ id: 'sk-board', name: 'Skeleton', columns: [
        { id: 'c1', name: 'One', noteIds: ['sk-a'] },
        { id: 'c2', name: 'Two', noteIds: ['sk-b', 'sk-c'] },
      ] });
      await M.openWin('board-sk-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 640, h: 420 });
      await new Promise((r) => setTimeout(r, 300));
      const doc = M.frameDoc('board-sk-board');
      const win = doc.defaultView;
      const card = (id) => doc.querySelector(`.board-card[data-note-id="${id}"]`);
      const ev = (type, target, x, y) => target.dispatchEvent(new win.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }));
      const a = card('sk-a').getBoundingClientRect();
      const c = card('sk-c').getBoundingClientRect();
      ev('pointerdown', card('sk-a'), a.left + 10, a.top + 10);
      ev('pointermove', win, a.left + 30, a.top + 30);
      // Over the top half of sk-c: between sk-b and sk-c.
      ev('pointermove', win, c.left + 20, c.top + 4);
      const sk = doc.querySelector('.card-skeleton');
      const out = {
        inTwo: Boolean(sk && sk.closest('.board-column').dataset.colId === 'c2'),
        beforeC: Boolean(sk && sk.nextElementSibling === card('sk-c')),
      };
      ev('pointerup', win, c.left + 20, c.top + 4);
      await new Promise((r) => setTimeout(r, 100));
      out.gone = !doc.querySelector('.card-skeleton');
      out.order = M.boards['sk-board'].columns.map((col) => col.noteIds);
      // A memory window dragged over a column from the desktop: at the end.
      M.emit('board-drop-hover', ['sk-board', 'c1', true]);
      const sk2 = doc.querySelector('.card-skeleton');
      out.windowAtEnd = Boolean(sk2 && sk2.closest('.board-column').dataset.colId === 'c1' && !sk2.nextElementSibling);
      M.emit('board-drop-hover', ['sk-board', 'c1', false]);
      out.windowGone = !doc.querySelector('.card-skeleton');
      // Above a card's middle: before that card.
      M.emit('board-drop-hover', ['sk-board', 'c2', true, 'sk-a']);
      const sk3 = doc.querySelector('.card-skeleton');
      out.windowBefore = Boolean(sk3 && sk3.nextElementSibling === card('sk-a'));
      M.emit('board-drop-hover', ['sk-board', 'c2', false, 'sk-a']);
      M.closeWin('board-sk-board');
      return out;
    });
    assert.equal(res.inTwo && res.beforeC, true, 'The skeleton sits in the hovered column, between the cards around the pointer');
    assert.equal(res.gone, true, 'The skeleton goes away on drop');
    assert.deepEqual(res.order, [[], ['sk-b', 'sk-a', 'sk-c']], 'The memory lands where the skeleton was');
    assert.equal(res.windowAtEnd && res.windowGone, true, 'A memory window below the cards shows the skeleton at the column end, gone when it leaves');
    assert.equal(res.windowBefore, true, 'A memory window above a card shows the skeleton before it');
  });

  // ------------------------------------------------ 7g. Board: changes after a save are saved too
  await step('Board: removing memories one after another removes each, the last one too', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      for (const id of ['rm-a', 'rm-b']) M.addNote({ id, text: id });
      M.addBoard({ id: 'rm-board', name: 'Remove', columns: [{ id: 'c1', name: 'One', noteIds: ['rm-a', 'rm-b'] }] });
      await M.openWin('board-rm-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 420, h: 360 });
      await new Promise((r) => setTimeout(r, 300));
      const doc = M.frameDoc('board-rm-board');
      const remove = async (id) => {
        doc.querySelector(`.board-card[data-note-id="${id}"] .card-del-btn`).click();
        await new Promise((r) => setTimeout(r, 200)); // saved, and its echo reloaded
      };
      await remove('rm-b');
      const afterOne = [...M.boards['rm-board'].columns[0].noteIds];
      await remove('rm-a');
      const afterTwo = [...M.boards['rm-board'].columns[0].noteIds];
      M.closeWin('board-rm-board');
      return { afterOne, afterTwo };
    });
    assert.deepEqual(res.afterOne, ['rm-a'], 'The first removal is saved');
    assert.deepEqual(res.afterTwo, [], 'The next removal is saved too, emptying the column');
  });

  // ------------------------------------------------ 7h. Share: "Link copied" in every window
  await step('Share: "Link copied" shows in a memory, a board and a group bar (which grows for it); no import offer', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const calls = [];
      M.hooks.set_group_height = (label, a) => { calls.push(a.height); return null; };
      M.addNote({ id: 'sh-note', text: 'x' });
      M.addBoard({ id: 'sh-board', name: 'B' });
      M.addGroup({ id: 'sh-group', name: 'G' });
      const labels = ['note-sh-note', 'board-sh-board', 'group-sh-group'];
      await M.openWin(labels[0], '/src/windows/note/index.html', { x: 40, y: 40, w: 300, h: 260 });
      await M.openWin(labels[1], '/src/windows/board/board.html', { x: 360, y: 40, w: 420, h: 300 });
      await M.openWin(labels[2], '/src/windows/group/group.html', { x: 40, y: 340, w: 300, h: 40 });
      await new Promise((r) => setTimeout(r, 300));
      const out = { copied: {} };
      for (const l of labels) {
        await M.frameDoc(l).defaultView.MemoShare.copy();
        const toast = M.frameDoc(l).querySelector('.toast[data-key="copied"]');
        out.copied[l] = toast ? toast.textContent : '';
      }
      out.groupGrew = calls.some((h) => h > 40);
      out.offers = labels.some((l) => M.frameDoc(l).querySelector('.toast[data-key="share"]'));
      for (const l of labels) M.closeWin(l);
      delete M.hooks.set_group_height;
      return out;
    });
    for (const [l, text] of Object.entries(res.copied)) {
      assert.ok(text.startsWith('Link copiado'), `${l}: "Share link" says it copied the link (${text})`);
    }
    assert.equal(res.groupGrew, true, 'A group bar grows to show the notice');
    assert.equal(res.offers, false, 'No import offer: a link imports where it is opened');
  });

  // ------------------------------------------------ 7i. A new version: a notice in every window
  await step('Update: a newer version shows a notice in every window, with Update and restart, progress and ✕', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const calls = [];
      M.hooks.install_update = () => { calls.push('install'); return null; };
      M.hooks.dismiss_update = () => { calls.push('dismiss'); return null; };
      M.addNote({ id: 'up-note', text: 'x' });
      M.addGroup({ id: 'up-group', name: 'G' });
      await M.openWin('note-up-note', '/src/windows/note/index.html', { x: 40, y: 40, w: 300, h: 260 });
      await M.openWin('group-up-group', '/src/windows/group/group.html', { x: 40, y: 340, w: 300, h: 40 });
      await new Promise((r) => setTimeout(r, 300));
      const notice = (l) => M.frameDoc(l).querySelector('.toast[data-key="update"]');
      const status = { checking: false, available: '9.9.9', progress: null, upToDate: false, error: null, dismissed: false };
      M.emit('update-changed', status);
      const out = {
        text: notice('note-up-note') && notice('note-up-note').textContent,
        inGroup: Boolean(notice('group-up-group')),
      };
      notice('note-up-note').querySelector('.toast-action').click();
      M.emit('update-changed', { ...status, progress: 40 });
      out.progress = notice('note-up-note').textContent;
      out.noCloseWhileInstalling = !notice('note-up-note').querySelector('.toast-close');
      M.emit('update-changed', { ...status, error: 'install' });
      notice('group-up-group').querySelector('.toast-close').click();
      M.emit('update-changed', { ...status, error: 'install', dismissed: true });
      out.gone = !notice('note-up-note') && !notice('group-up-group');
      out.calls = calls;
      M.closeWin('note-up-note');
      M.closeWin('group-up-group');
      delete M.hooks.install_update;
      delete M.hooks.dismiss_update;
      return out;
    });
    assert.ok(res.text.includes('Nova versão do Memo: 9.9.9') && res.text.includes('Atualizar e reiniciar'), `The notice names the version (${res.text})`);
    assert.equal(res.inGroup, true, 'Group bars show it too');
    assert.ok(res.progress.includes('40%'), `It shows the download (${res.progress})`);
    assert.equal(res.noCloseWhileInstalling, true, 'No ✕ while it installs');
    assert.equal(res.gone, true, '✕ hides it in every window');
    assert.deepEqual(res.calls, ['install', 'dismiss']);
  });

  // ------------------------------------------------ 7j. Board columns: colour, moving, folded memories
  await step('Board: a column\'s dot picks its colour, a column dragged by its header moves, a memory folds to its title', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      M.addNote({ id: 'cf-a', title: 'A', text: 'A\nfirst line' });
      M.addNote({ id: 'cf-b', title: 'B', text: 'B\nsecond line' });
      M.addBoard({ id: 'cf-board', name: 'Cols', columns: [
        { id: 'c1', name: 'One', color: '', noteIds: ['cf-a'] },
        { id: 'c2', name: 'Two', color: '', noteIds: ['cf-b'] },
      ] });
      await M.openWin('board-cf-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 640, h: 400 });
      await wait(300);
      const doc = M.frameDoc('board-cf-board');
      const win = doc.defaultView;
      const col = (id) => doc.querySelector(`.board-column[data-col-id="${id}"]`);
      const out = {};

      // Colour: the dot opens the swatches; a swatch paints and saves it.
      col('c1').querySelector('.col-dot').click();
      const menu = doc.getElementById('colColorMenu');
      out.menuOpen = Boolean(menu && !menu.hidden);
      menu.querySelector('.swatch[data-color="teal"]').click();
      await wait(200);
      out.saved = M.boards['cf-board'].columns[0].color;
      out.painted = col('c1').querySelector('.col-dot').dataset.color;
      out.menuClosed = menu.hidden;

      // Moving: drag "One" by its header past the middle of "Two".
      const head = col('c1').querySelector('.col-head');
      const r1 = head.getBoundingClientRect();
      const r2 = col('c2').getBoundingClientRect();
      const y = r1.top + r1.height / 2;
      head.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r1.left + 40, clientY: y }));
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: r1.left + 60, clientY: y }));
      win.dispatchEvent(new win.PointerEvent('pointermove', { clientX: r2.right - 10, clientY: y }));
      // While moving: the column follows the pointer and a skeleton holds its place, as a memory's.
      const skel = doc.querySelector('.columns-track > .col-skeleton');
      out.skeletonAfterTwo = Boolean(skel) && skel.previousElementSibling === col('c2');
      out.skeletonLook = skel && win.getComputedStyle(skel).animationName;
      out.avatar = Boolean(doc.querySelector('body > .col-drag-avatar'));
      out.hidden = col('c1').getBoundingClientRect().width === 0;
      win.dispatchEvent(new win.PointerEvent('pointerup', { clientX: r2.right - 10, clientY: y }));
      out.cleaned = !doc.querySelector('.col-skeleton') && !doc.querySelector('.col-drag-avatar');
      await wait(200);
      out.order = M.boards['cf-board'].columns.map((c) => c.id);
      out.drawn = [...doc.querySelectorAll('.board-column')].map((c) => c.dataset.colId);

      // Folding: the arrow keeps only the title, and opens it again.
      const card = () => doc.querySelector('.board-card[data-note-id="cf-a"]');
      // The group bar's toggle: same arrow, up while open, 180° when folded.
      const arrow = () => {
        const svg = card().querySelector('.card-fold-btn svg');
        return { path: svg.querySelector('path').getAttribute('d'), turn: win.getComputedStyle(svg).transform, ease: win.getComputedStyle(svg).transitionDuration };
      };
      const groupArrow = await (async () => {
        const g = await fetch('/src/windows/group/group.html').then((r) => r.text());
        return new DOMParser().parseFromString(g, 'text/html').querySelector('#toggleBtn path').getAttribute('d');
      })();
      out.arrowOpen = arrow();
      card().querySelector('.card-fold-btn').click();
      out.arrowTurning = card().querySelector('.card-fold-btn').getAttribute('aria-expanded');
      await wait(200);
      out.arrowFolded = arrow();
      out.groupArrow = groupArrow;
      out.folded = card().classList.contains('is-folded') && !card().querySelector('.card-snippet');
      out.foldSaved = [...(M.boards['cf-board'].columns.find((c) => c.id === 'c1').collapsed || [])];
      card().querySelector('.card-fold-btn').click();
      await wait(200);
      out.unfolded = !card().classList.contains('is-folded') && Boolean(card().querySelector('.card-snippet'));
      out.opened = M.wins['note-cf-a'] ? 'opened' : 'not opened';
      M.closeWin('board-cf-board');
      return out;
    });
    assert.equal(res.menuOpen, true, 'The column dot opens the colour swatches');
    assert.equal(res.saved, 'teal', 'The picked colour is saved with the columns');
    assert.equal(res.painted, 'teal', 'The dot shows it');
    assert.equal(res.menuClosed, true, 'Picking closes the swatches');
    assert.equal(res.skeletonAfterTwo, true, 'A skeleton shows where the column will land');
    assert.equal(res.skeletonLook, 'card-skeleton', 'It is the memories\' skeleton');
    assert.equal(res.avatar && res.hidden, true, 'The column follows the pointer, out of its old place');
    assert.equal(res.cleaned, true, 'Dropped, the skeleton and the dragged copy go');
    assert.deepEqual(res.order, ['c2', 'c1'], 'A column dragged past another moves there, saved');
    assert.deepEqual(res.drawn, ['c2', 'c1'], 'and is drawn there');
    assert.equal(res.arrowOpen.path, res.groupArrow, 'The fold arrow is the group bar\'s toggle arrow');
    assert.equal(res.arrowOpen.turn, 'none', 'It points up while open');
    assert.equal(res.arrowTurning, 'false', 'A click turns it at once (then the card folds)');
    assert.equal(res.arrowFolded.turn.replace(/\s/g, '').startsWith('matrix(-1,') && res.arrowFolded.ease === '0.16s', true, `Folded, it is turned 180° with the group's 160 ms (${res.arrowFolded.turn})`);
    assert.equal(res.folded, true, 'A folded memory shows only its title');
    assert.deepEqual(res.foldSaved, ['cf-a'], 'Folding is saved in the column');
    assert.equal(res.unfolded, true, 'The arrow opens it again');
    assert.equal(res.opened, 'not opened', 'Folding does not open the memory');
  });

  // ------------------------------------------------ 7k. A ✕ that deletes acts on one click
  await step('A ✕ that deletes acts on the first click: a column (with its memories), a card, the titlebar trash', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const id of ['dl-a', 'dl-b', 'dl-n']) M.addNote({ id, text: id });
      M.addBoard({ id: 'dl-board', name: 'Del', columns: [
        { id: 'c1', name: 'One', noteIds: ['dl-a'] },
        { id: 'c2', name: 'Two', noteIds: ['dl-b'] },
      ] });
      await M.openWin('board-dl-board', '/src/windows/board/board.html', { x: 40, y: 40, w: 640, h: 400 });
      await M.openWin('note-dl-n', '/src/windows/note/index.html', { x: 700, y: 40, w: 300, h: 260 });
      await wait(300);
      const doc = M.frameDoc('board-dl-board');
      const out = {};
      doc.querySelector('.board-column[data-col-id="c1"] .col-menu-btn').click();
      await wait(200);
      out.colGone = M.boards['dl-board'].columns.map((c) => c.id);
      out.memoryTrashed = Boolean(M.notes['dl-a'].trashedAt);
      doc.querySelector('.board-card[data-note-id="dl-b"] .card-del-btn').click();
      await wait(200);
      out.cardGone = !M.boards['dl-board'].columns[0].noteIds.includes('dl-b');
      M.frameDoc('note-dl-n').getElementById('trashBtn').click();
      await wait(200);
      out.noteTrashed = Boolean(M.notes['dl-n'].trashedAt);
      M.closeWin('board-dl-board');
      return out;
    });
    assert.deepEqual(res.colGone, ['c2'], 'One click on a column ✕ deletes the column');
    assert.equal(res.memoryTrashed, true, 'and sends its memories to the trash');
    assert.equal(res.cardGone, true, 'One click on a card ✕ removes it from the board');
    assert.equal(res.noteTrashed, true, 'One click on the titlebar trash trashes the memory');
  });

  // ------------------------------------------------ 7m. Boards tab: "Empty trash" empties the boards' trash
  await step('Manager: "Empty trash" in the Boards tab deletes the trashed boards (not memories)', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      M.addNote({ id: 'et-note', text: 'trashed memory' });
      M.notes['et-note'].trashedAt = Date.now();
      M.addBoard({ id: 'et-board', name: 'Old' });
      M.boards['et-board'].trashedAt = Date.now();
      M.addBoard({ id: 'et-live', name: 'Live' });
      const calls = [];
      M.hooks.empty_trash = () => { calls.push('empty_trash'); };
      M.hooks.empty_board_trash = () => { calls.push('empty_board_trash'); };
      await M.openManager();
      await wait(200);
      const doc = M.frameDoc('manager');
      doc.getElementById('tabBoards').click();
      doc.querySelector('#scopeSwitch [data-scope="trash"]').click();
      await wait(100);
      const btn = doc.getElementById('emptyTrash');
      const enabled = !btn.disabled;
      btn.click(); // armed: "Empty trash" asks for a second click
      btn.click();
      await wait(200);
      delete M.hooks.empty_trash;
      delete M.hooks.empty_board_trash;
      const out = {
        enabled,
        calls,
        boardGone: !M.boards['et-board'],
        liveKept: Boolean(M.boards['et-live']),
        noteKept: Boolean(M.notes['et-note']),
        cards: doc.querySelectorAll('#list .card').length,
      };
      doc.querySelector('#scopeSwitch [data-scope="current"]').click();
      doc.getElementById('tabNotes').click();
      delete M.notes['et-note'];
      delete M.boards['et-live'];
      return out;
    });
    assert.equal(res.enabled, true, 'The button is on with a board in the trash');
    assert.deepEqual(res.calls, ['empty_board_trash'], 'It empties the boards\' trash, not the memories\'');
    assert.equal(res.boardGone, true, 'The trashed board is gone');
    assert.equal(res.liveKept, true, 'A current board stays');
    assert.equal(res.noteKept, true, 'A trashed memory stays');
    assert.equal(res.cards, 0, 'The Boards trash is empty');
  });

  // ------------------------------------------------ 7l. Short titlebar menus
  await step('Titlebar: memories, boards and group bars have a share button that copies the item\'s link', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = [];
      M.hooks.copy_share = (label, a) => { calls.push([label, a || {}]); return 'http://localhost:3000/memo/app.html#memo:v1:x'; };
      M.addNote({ id: 'sb-note', text: 'x' });
      M.addBoard({ id: 'sb-board', name: 'B' });
      M.addGroup({ id: 'sb-group', name: 'G' });
      const labels = ['note-sb-note', 'board-sb-board', 'group-sb-group'];
      await M.openWin(labels[0], '/src/windows/note/index.html', { x: 40, y: 40, w: 300, h: 260 });
      await M.openWin(labels[1], '/src/windows/board/board.html', { x: 360, y: 40, w: 420, h: 300 });
      await M.openWin(labels[2], '/src/windows/group/group.html', { x: 40, y: 340, w: 300, h: 40 });
      await wait(300);
      const out = {};
      for (const l of labels) {
        const doc = M.frameDoc(l);
        const btn = doc.querySelector('#titlebar #shareBtn');
        const actions = btn ? [...btn.parentElement.children].map((b) => b.id) : [];
        out[l] = { title: btn ? btn.title : '', firstAction: actions[0] === 'shareBtn' };
        if (btn) btn.click();
        await wait(100);
        const toast = doc.querySelector('.toast[data-key="copied"]');
        out[l].toast = toast ? toast.textContent : '';
      }
      out.calls = calls.map(([l]) => l);
      delete M.hooks.copy_share;
      for (const l of labels) M.closeWin(l);
      return out;
    });
    for (const l of ['note-sb-note', 'board-sb-board', 'group-sb-group']) {
      assert.equal(res[l].title, 'Compartilhar link', `${l} has the share button`);
      assert.ok(res[l].firstAction, `${l}: it is the far left of the titlebar's buttons`);
      assert.ok(res[l].toast.startsWith('Link copiado'), `${l}: a click copies the link (${res[l].toast})`);
    }
    assert.deepEqual(res.calls, ['note-sb-note', 'board-sb-board', 'group-sb-group'], 'Each copies its own item');
  });

  await step('Titlebar: the share button shows only while the pointer is over the titlebar; the other buttons always', async () => {
    const labels = ['note-hv-note', 'board-hv-board', 'group-hv-group', 'group-hv-narrow'];
    await page.evaluate(async (labels) => {
      const M = window.Memo;
      M.addNote({ id: 'hv-note', title: 'Uma memória com um título bem comprido', text: 'x' });
      M.addBoard({ id: 'hv-board', name: 'B' });
      M.addGroup({ id: 'hv-group', name: 'G' });
      M.addGroup({ id: 'hv-narrow', name: 'N' });
      await M.openWin(labels[0], '/src/windows/note/index.html', { x: 40, y: 40, w: 260, h: 200 });
      await M.openWin(labels[1], '/src/windows/board/board.html', { x: 320, y: 40, w: 420, h: 200 });
      await M.openWin(labels[2], '/src/windows/group/group.html', { x: 40, y: 280, w: 300, h: 40 });
      // A group bar at its minimum width (main.rs GROUP_MIN_W).
      await M.openWin(labels[3], '/src/windows/group/group.html', { x: 360, y: 280, w: 210, h: 40 });
    }, labels);
    await page.mouse.move(900, 500);
    await page.waitForTimeout(150);
    const state = (label) => page.evaluate((label) => {
      const M = window.Memo;
      const doc = M.frameDoc(label);
      const actions = doc.querySelector('#titlebar .actions');
      const name = doc.querySelector('#titlebar .win-name, #titlebar .identity');
      const edge = doc.documentElement.clientWidth;
      const btns = [...actions.querySelectorAll('.icon-btn')].filter((b) => !b.hidden);
      const r = M.wins[label].f.getBoundingClientRect();
      const visible = (b) => getComputedStyle(b).display !== 'none';
      const always = btns.filter((b) => b.id !== 'shareBtn');
      const share = doc.getElementById('shareBtn');
      return {
        always: always.length >= 3 && always.every(visible),
        shown: visible(share),
        hidden: !visible(share),
        nameW: name ? name.getBoundingClientRect().width : 0,
        fits: btns.every((b) => b.getBoundingClientRect().right <= edge + 0.5),
        bar: { x: r.left + r.width / 2, y: r.top + 12 },
      };
    }, label);
    const res = {};
    for (const label of labels) {
      const before = await state(label);
      await page.mouse.move(before.bar.x, before.bar.y);
      await page.waitForTimeout(120);
      const over = await state(label);
      await page.mouse.move(900, 500);
      await page.waitForTimeout(120);
      const after = await state(label);
      res[label] = { before, over, after };
    }
    await page.evaluate((labels) => labels.forEach((l) => window.Memo.closeWin(l)), labels);
    for (const label of labels) {
      const { before, over, after } = res[label];
      assert.equal(before.always && over.always && after.always, true, `${label}: +, −, ✕ (and a group's toggle) always show`);
      assert.equal(before.hidden, true, `${label}: the share button waits for the pointer`);
      assert.equal(over.shown, true, `${label}: the pointer over the titlebar shows them`);
      assert.equal(over.fits, true, `${label}: they all fit in the bar`);
      assert.equal(after.hidden, true, `${label}: it goes when the pointer leaves`);
    }
    assert.ok(res['note-hv-note'].before.nameW > res['note-hv-note'].over.nameW,
      `The name has the share button's room while it is hidden (${res['note-hv-note'].before.nameW} > ${res['note-hv-note'].over.nameW})`);
  });

  await step('Titlebar menus keep only the window\'s own commands (no Close, no duplicates of the app part)', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const menus = {};
      M.hooks.show_title_menu = (label, a) => { menus[label] = (a.items || []).filter(Boolean).map((i) => i.label); return null; };
      M.addNote({ id: 'mn-note', text: 'x' });
      M.addBoard({ id: 'mn-board', name: 'B' });
      M.addGroup({ id: 'mn-group', name: 'G' });
      await M.openWin('note-mn-note', '/src/windows/note/index.html', { x: 40, y: 40, w: 300, h: 260 });
      await M.openWin('board-mn-board', '/src/windows/board/board.html', { x: 360, y: 40, w: 420, h: 300 });
      await M.openWin('group-mn-group', '/src/windows/group/group.html', { x: 40, y: 340, w: 300, h: 40 });
      await wait(300);
      for (const l of ['note-mn-note', 'board-mn-board', 'group-mn-group']) {
        const doc = M.frameDoc(l);
        doc.getElementById('titlebar').dispatchEvent(new doc.defaultView.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 10 }));
      }
      await wait(100);
      delete M.hooks.show_title_menu;
      for (const l of ['note-mn-note', 'board-mn-board', 'group-mn-group']) M.closeWin(l);
      return menus;
    });
    const all = Object.values(res).flat();
    assert.equal(Object.keys(res).length, 3, `Every window opens its menu (${Object.keys(res)})`);
    for (const gone of ['Fechar', 'Fechar memória', 'Nova memória', 'Trazer todas para a frente']) {
      assert.ok(!all.includes(gone), `"${gone}" is not in a titlebar's own commands (${all})`);
    }
    for (const [label, items] of Object.entries(res)) {
      assert.ok(!items.includes('Compartilhar link') && !items.includes('Compartilhar (copiar)'),
        `${label}: sharing is the titlebar's button, not a menu item (${items})`);
    }
  });

  // ------------------------------------------------ Settings: restore every preference
  await step('Settings: "Default settings" restores every preference on the second click (Memo Web)', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      const snapshot = () => webPage.evaluate(async () => {
        const inv = (c, a) => window.MemoWeb.invoke('manager', c, a);
        return {
          theme: await inv('get_theme'),
          language: (await inv('get_language'))[0],
          zoom: await inv('get_zoom'),
          magnet: await inv('get_magnet'),
          note: [await inv('get_default_color'), await inv('get_new_note_defaults')],
          group: await inv('get_group_defaults'),
          board: await inv('get_board_defaults'),
          layout: (await inv('load_manager')).layout || 'cards',
          trashHint: localStorage.getItem('memo.trashHintOff'),
        };
      });
      const fresh = await snapshot();
      await webPage.evaluate(async () => {
        const inv = (c, a) => window.MemoWeb.invoke('manager', c, a);
        await inv('change_theme', { theme: 'light' });
        await inv('change_language', { language: 'en' });
        await inv('change_zoom', { step: 2 });
        await inv('set_magnet', { on: false });
        await inv('set_manager_layout', { layout: 'list' });
        await inv('set_default_color', { color: 'coral' });
        await inv('set_default_title', { title: 'T' });
        await inv('set_default_group_color', { color: 'teal' });
        await inv('set_default_group_title', { title: 'G' });
        await inv('set_default_board_color', { color: 'iris' });
        await inv('set_default_board_title', { title: 'B' });
        await inv('set_default_board_columns', { columns: [] });
        localStorage.setItem('memo.trashHintOff', '1');
      });
      const changed = await snapshot();
      const btn = () => webPage.frameLocator('iframe[name="manager"]').locator('#resetSettingsBtn');
      await btn().dispatchEvent('click');
      const afterOne = await snapshot();
      await btn().dispatchEvent('click');
      await webPage.waitForTimeout(500);
      const after = await snapshot();
      assert.notDeepEqual(changed, fresh, 'The settings were changed');
      assert.deepEqual(afterOne, changed, 'One click changes nothing (it asks for a second)');
      assert.deepEqual(after, fresh, 'The second click restores every preference');
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Web: launching with no memories creates none
  await step('Web version: a launch with no memories (not the first) opens only the manager, no new memory', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.addInitScript(() => {
        localStorage.setItem('memo.web.data.v1', JSON.stringify({ notes: [], groups: [], nextSeq: 5 }));
      });
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(600);
      const res = await webPage.evaluate(async () => ({
        windows: document.querySelectorAll('.win[data-label^="note-"]').length,
        notes: (await window.MemoWeb.invoke('manager', 'list_notes')).length,
      }));
      assert.deepEqual(res, { windows: 0, notes: 0 });
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Web: only a link imports (never the clipboard or a paste)
  await step('Web version: a link\'s item is imported from its dialog, centered; a pasted or copied code is never offered', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
      // A code made by Memo Web elsewhere (the fixture share.rs reads too).
      const code = fs.readFileSync(path.join(ROOT, 'src-tauri/tests/web-share-code.txt'), 'utf8').trim();
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name^="note-"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async (code) => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const out = {};
        const label = document.querySelector('.win[data-label^="note-"]').dataset.label;
        const doc = document.querySelector(`iframe[name="${label}"]`).contentDocument;
        const menu = async () => {
          await inv(label, 'show_title_menu', { items: [] });
          return [...document.querySelectorAll('#contextMenu .ctx-item')].map((b) => b.textContent);
        };
        // Neither a paste, the clipboard on focus, nor copying here offers anything.
        await navigator.clipboard.writeText(`Oi\n${code}`);
        window.dispatchEvent(new Event('focus'));
        const dt = new DataTransfer();
        dt.setData('text/plain', `Oi\n${code}`);
        doc.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await inv(label, 'copy_share');
        await wait(300);
        out.offered = Boolean(document.querySelector('.share-dialog') || doc.querySelector('.toast[data-key="share"]'));
        out.menuBefore = await menu();
        document.body.click();
        // A link opened: Esc closes its dialog with nothing imported; opened
        // again, Enter imports it here.
        const before = new Set((await inv('manager', 'list_notes')).map((n) => n.id));
        location.hash = code;
        await wait(400);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(100);
        out.cancelled = [document.querySelectorAll('.share-dialog').length, (await inv('manager', 'list_notes')).length - before.size];
        location.hash = code;
        await wait(400);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await wait(600);
        const fresh = (await inv('manager', 'list_notes')).find((n) => !before.has(n.id));
        out.imported = fresh ? fresh.title : null;
        const w = fresh && document.querySelector(`.win[data-label="note-${fresh.id}"]`);
        if (w) {
          const r = w.getBoundingClientRect();
          const desk = document.getElementById('desk').getBoundingClientRect();
          out.dx = Math.abs(r.left + r.width / 2 - (desk.left + desk.width / 2));
          out.dy = Math.abs(r.top + r.height / 2 - (desk.top + desk.height / 2));
        }
        return out;
      }, code);
      assert.equal(res.offered, false, 'A code pasted, in the clipboard or just copied is not offered');
      assert.ok(!res.menuBefore.includes('Importar item compartilhado') && res.menuBefore.includes('Novo quadro'),
        `No import in the menu without a link (${res.menuBefore})`);
      for (const gone of ['Tema', 'Configurações', 'Idioma', 'Lixeira']) {
        assert.ok(!res.menuBefore.includes(gone), `"${gone}" stays in the tray, not in a titlebar menu (${res.menuBefore})`);
      }
      assert.deepEqual(res.cancelled, [0, 0], 'Esc closes the dialog and imports nothing');
      assert.equal(res.imported, 'Oi', 'Enter imports the link\'s item in this browser');
      assert.ok(res.dx <= 40 && res.dy <= 60, `The imported memory opens in the middle (${res.dx}, ${res.dy})`);
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Sync: Google Drive, OneDrive or both in Settings
  await step('Settings: Sync has a row per cloud; one, the other or both can be connected', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const calls = [];
      const accounts = [];
      const idle = { syncing: false, lastSync: 0, pending: 0, error: null };
      const emails = { google: 'me@gmail.com', microsoft: 'me@outlook.com' };
      M.hooks.get_cloud_account = () => [['google', 'microsoft'], accounts.slice()];
      M.hooks.connect_cloud = (label, a) => {
        calls.push(['connect', a.provider]);
        accounts.push({ provider: a.provider, email: emails[a.provider], status: idle });
        return emails[a.provider];
      };
      M.hooks.disconnect_cloud = (label, a) => {
        calls.push(['disconnect', a.provider]);
        accounts.splice(accounts.findIndex((x) => x.provider === a.provider), 1);
        return null;
      };
      await M.openManager();
      await wait(200);
      const doc = M.frameDoc('manager');
      doc.getElementById('tabSettings').click();
      await wait(100);
      const row = (p) => doc.querySelector(`[data-cloud-row="${p}"]`);
      const btn = (p, act) => row(p).querySelector(`[data-cloud-act="${act}"]`);
      const state = (p) => ({
        connect: !btn(p, 'connect').hidden,
        disconnect: !btn(p, 'disconnect').hidden,
        status: row(p).querySelector('[data-cloud-status]').textContent,
      });
      const out = { rows: [!row('google').hidden, !row('microsoft').hidden], start: [state('google'), state('microsoft')] };
      btn('microsoft', 'connect').click();
      await wait(200);
      out.oneDriveOnly = [state('google'), state('microsoft')];
      btn('google', 'connect').click();
      await wait(200);
      out.both = [state('google'), state('microsoft')];
      btn('microsoft', 'disconnect').click();
      await wait(200);
      out.googleOnly = [state('google'), state('microsoft')];
      out.calls = calls;
      delete M.hooks.get_cloud_account;
      delete M.hooks.connect_cloud;
      delete M.hooks.disconnect_cloud;
      doc.getElementById('tabNotes').click();
      return out;
    });
    assert.deepEqual(res.rows, [true, true], 'A row for Google Drive and one for OneDrive');
    assert.ok(res.start.every((r) => r.connect && !r.disconnect), 'Both can be connected at first');
    assert.ok(res.oneDriveOnly[1].disconnect && res.oneDriveOnly[1].status.includes('me@outlook.com'), 'OneDrive connected');
    assert.ok(res.oneDriveOnly[0].connect, 'Google Drive can still be connected beside it');
    assert.ok(res.both.every((r) => r.disconnect && !r.connect), `Both connected at once (${JSON.stringify(res.both)})`);
    assert.ok(res.googleOnly[0].disconnect && res.googleOnly[1].connect, 'Disconnecting OneDrive leaves Google Drive connected');
    assert.deepEqual(res.calls, [['connect', 'microsoft'], ['connect', 'google'], ['disconnect', 'microsoft']]);
  });

  // ------------------------------------------------ Web: OneDrive sync between two browsers (fake Graph)
  await step('Web version: memories sync through OneDrive between two browsers, one file per memory', async () => {
    const GRAPH = 'https://graph.microsoft.com/v1.0';
    const fake = { files: new Map(), log: [], next: 0 };
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS' };
    const json = (route, body) => route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const item = (id, name) => (fake.files.has(id) ? { id, name, file: {} } : { id, name, deleted: {} });
    const graph = async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const url = new URL(req.url());
      const path = decodeURIComponent(url.pathname.replace('/v1.0', ''));
      if (path === '/me/drive/special/approot/delta') {
        return json(route, { value: [], '@odata.deltaLink': `${GRAPH}/delta/${fake.log.length}` });
      }
      if (path.startsWith('/delta/')) {
        const from = Number(path.slice('/delta/'.length));
        return json(route, { value: fake.log.slice(from).map(([id, name]) => item(id, name)), '@odata.deltaLink': `${GRAPH}/delta/${fake.log.length}` });
      }
      if (path === '/me/drive/special/approot/children') {
        return json(route, { value: [...fake.files].map(([id, f]) => ({ id, name: f.name, file: {} })) });
      }
      const put = path.match(/^\/me\/drive\/special\/approot:\/(.+):\/content$/);
      if (put && req.method() === 'PUT') {
        const name = put[1];
        let id = [...fake.files].find(([, f]) => f.name === name)?.[0];
        if (!id) id = `o${++fake.next}`;
        fake.files.set(id, { name, body: req.postDataBuffer() || Buffer.alloc(0) });
        fake.log.push([id, name]);
        return json(route, { id });
      }
      const one = path.match(/^\/me\/drive\/items\/([^/]+)$/);
      if (one && req.method() === 'DELETE') {
        const f = fake.files.get(one[1]);
        if (f) {
          fake.files.delete(one[1]);
          fake.log.push([one[1], f.name]);
        }
        return route.fulfill({ status: 204, headers: cors });
      }
      if (one) return json(route, { id: one[1], '@microsoft.graph.downloadUrl': `https://download.example/${one[1]}` });
      return route.fulfill({ status: 404, headers: cors, body: '' });
    };
    const download = (route) => {
      const id = new URL(route.request().url()).pathname.slice(1);
      return route.fulfill({ status: 200, headers: cors, body: fake.files.get(id).body });
    };
    const signedIn = async () => {
      const p = await browser.newPage();
      await p.route(`${GRAPH}/**`, graph);
      await p.route('https://download.example/**', download);
      await p.addInitScript(() => {
        localStorage.setItem('memo.web.microsoftClientId', 'test-client');
        localStorage.setItem('memo.web.microsoftToken', JSON.stringify({ accessToken: 'test', expiresAt: Date.now() + 3_600_000 }));
        if (!localStorage.getItem('memo.web.data.v1')) {
          localStorage.setItem('memo.web.data.v1', JSON.stringify({ syncMicrosoft: { account: 'me@outlook.com' } }));
        }
      });
      await p.goto(`http://127.0.0.1:${port}/site/app.html`);
      await p.waitForSelector('iframe[name="manager"]');
      return p;
    };
    // Sync now and wait for it to end.
    const syncNow = (p) => p.evaluate(async () => {
      const inv = window.MemoWeb.invoke;
      await inv('manager', 'sync_cloud');
      for (let i = 0; i < 100; i++) {
        const [, accounts] = await inv('manager', 'get_cloud_account');
        const st = accounts.find((x) => x.provider === 'microsoft').status;
        if (!st.syncing) return st;
        await new Promise((r) => setTimeout(r, 50));
      }
      return { error: 'timeout' };
    });
    const a = await signedIn();
    const b = await signedIn();
    try {
      const account = await a.evaluate(async () => {
        const [providers, accounts] = await window.MemoWeb.invoke('manager', 'get_cloud_account');
        return [providers, accounts.map((x) => x.email).join(), accounts.map((x) => x.provider).join()];
      });
      const id = await a.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const before = new Set((await inv('manager', 'list_notes')).map((n) => n.id));
        await inv('manager', 'new_note');
        const fresh = (await inv('manager', 'list_notes')).find((n) => !before.has(n.id)).id;
        await inv(`note-${fresh}`, 'rename', { name: 'Na nuvem' });
        await inv(`note-${fresh}`, 'save_text', { text: 'Na nuvem\nolá', html: '<div>olá</div>' });
        return fresh;
      });
      const stA = await syncNow(a);
      const namesAfterFirst = [...fake.files.values()].map((f) => f.name);
      const stB = await syncNow(b);
      const onB = await b.evaluate(async (id) => (await window.MemoWeb.invoke('manager', 'list_notes')).find((n) => n.id === id), id);
      // Edited again on A: the newer file replaces the old one.
      await a.evaluate(async (id) => {
        await new Promise((r) => setTimeout(r, 20));
        await window.MemoWeb.invoke(`note-${id}`, 'save_text', { text: 'Na nuvem\nde novo', html: '<div>de novo</div>' });
      }, id);
      await syncNow(a);
      await syncNow(b);
      const onBAgain = await b.evaluate(async (id) => (await window.MemoWeb.invoke('manager', 'list_notes')).find((n) => n.id === id), id);
      const noteFiles = [...fake.files.values()].map((f) => f.name).filter((n) => n.startsWith(`note-${id}.json~`));

      assert.equal(account[1], 'me@outlook.com', 'The OneDrive account is connected');
      assert.equal(account[2], 'microsoft', 'as a Microsoft account');
      assert.ok(account[0].includes('microsoft'), `OneDrive is offered (${account[0]})`);
      assert.ok(!stA.error && !stB.error, `Both syncs succeed (${stA.error}, ${stB.error})`);
      assert.ok(namesAfterFirst.some((n) => new RegExp(`^note-${id}\\.json~\\d+$`).test(n)), `The memory is a file named with its stamp (${namesAfterFirst})`);
      assert.equal(onB && onB.title, 'Na nuvem', 'The memory reached the other browser');
      assert.equal(onBAgain && onBAgain.text, 'Na nuvem\nde novo', 'and so does its next edit');
      assert.equal(noteFiles.length, 1, `One file per memory in OneDrive (${noteFiles})`);
    } finally {
      await a.close();
      await b.close();
    }
  });

  // ------------------------------------------------ 8a. Landing page: live windows invite a click
  await step('Landing page: each window glows three times the first time it comes into view', async () => {
    const sitePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await sitePage.goto(`http://127.0.0.1:${port}/site/index.html`);
      await sitePage.waitForSelector('.win[data-label="manager"] iframe');
      await sitePage.waitForTimeout(300);
      const glow = (label) => sitePage.evaluate((l) => {
        const el = document.querySelector(`.win[data-label="${l}"]`);
        const cs = getComputedStyle(el);
        return { on: el.classList.contains('invite'), name: cs.animationName, times: cs.animationIterationCount, color: cs.getPropertyValue('--invite-glow').trim() !== '' };
      }, label);
      const hero = await glow('note-demo-today');
      const managerBefore = await glow('manager');
      await sitePage.evaluate(() => document.querySelector('.win[data-label="manager"]').scrollIntoView({ block: 'center' }));
      await sitePage.waitForTimeout(300);
      const managerSeen = await glow('manager');
      await sitePage.waitForTimeout(5200);
      const heroAfter = await glow('note-demo-today');
      assert.deepEqual(hero, { on: true, name: 'memo-invite', times: '3', color: true }, 'A window in view pulses three times, in a defined glow colour');
      assert.equal(managerBefore.on, false, 'One not yet in view waits');
      assert.equal(managerSeen.on, true, 'It pulses once scrolled into view');
      assert.equal(heroAfter.on, false, 'Then the pulse is gone for good');
    } finally {
      await sitePage.close();
    }
  });

  // ------------------------------------------------ 8. Web vs Landing page storage isolation
  await step('Web vs Landing page: landing page is ephemeral, web version persists data', async () => {
    const sitePage = await browser.newPage();
    const webPage = await browser.newPage();
    try {
      // 1. Landing page: changes must NOT be saved to localStorage and are lost on reload
      await sitePage.goto(`http://127.0.0.1:${port}/site/index.html`);
      await sitePage.waitForSelector('iframe[name="note-demo-wifi"]');

      // The manager sits in its slot beside the text, not centred over it.
      await sitePage.waitForSelector('.win[data-label="manager"] iframe');
      const mgrPlacement = await sitePage.evaluate(() => {
        const rect = (el) => el.getBoundingClientRect();
        const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const mgr = rect(document.querySelector('.win[data-label="manager"]'));
        const anchor = rect(document.getElementById('anchorManager'));
        const covered = [...document.querySelectorAll('h1, h2, h3, p')]
          .filter((el) => !el.closest('.win') && el.offsetParent && hit(mgr, rect(el)));
        return { inSlot: Math.abs(mgr.left - anchor.left) < 2 && Math.abs(mgr.top - anchor.top) < 8, covered: covered.length };
      });
      assert.equal(mgrPlacement.inSlot, true, 'Landing page: the manager opens in its slot (#anchorManager)');
      assert.equal(mgrPlacement.covered, 0, 'Landing page: the manager covers no text');

      // Check that localStorage has no data written by initial landing page boot
      let siteStorage = await sitePage.evaluate(() => localStorage.getItem('memo.web.data.v1'));
      assert.equal(siteStorage, null, 'Landing page must not write to localStorage on boot');

      // Edit demo note on landing page
      await sitePage.evaluate(async () => {
        const frame = document.querySelector('iframe[name="note-demo-wifi"]');
        const doc = frame.contentDocument;
        const ed = doc.getElementById('editor');
        ed.innerHTML = '<div>Texto alterado na landing page</div>';
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
      });

      // localStorage must still NOT contain landing page data
      siteStorage = await sitePage.evaluate(() => localStorage.getItem('memo.web.data.v1'));
      assert.equal(siteStorage, null, 'Landing page must not write note edits to localStorage');

      // Reload landing page: changes must be lost
      await sitePage.reload();
      await sitePage.waitForSelector('iframe[name="note-demo-wifi"]');
      const wifiTextAfterReload = await sitePage.evaluate(() => {
        const frame = document.querySelector('iframe[name="note-demo-wifi"]');
        return frame.contentDocument.getElementById('editor').innerText;
      });
      assert.ok(!wifiTextAfterReload.includes('Texto alterado na landing page'), 'Landing page changes must be lost on reload');
      assert.ok(wifiTextAfterReload.includes('Memo-5G'), 'Landing page must restore default demo note content on reload');

      // 2. Web version: data MUST be persisted to localStorage and survive reload
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      // Wait for welcome note or first note
      await webPage.waitForSelector('iframe[name^="note-"]');

      const webNoteLabel = await webPage.evaluate(() => {
        const frame = document.querySelector('iframe[name^="note-"]');
        return frame ? frame.name : null;
      });
      assert.ok(webNoteLabel, 'Web version should have opened a note');

      // Type in the web note
      await webPage.evaluate(async (label) => {
        const frame = document.querySelector(`iframe[name="${label}"]`);
        const doc = frame.contentDocument;
        const ed = doc.getElementById('editor');
        ed.innerHTML = '<div>Persisted web note content 12345</div>';
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 600));
      }, webNoteLabel);

      // Verify it was saved to localStorage
      const webStorage = await webPage.evaluate(() => localStorage.getItem('memo.web.data.v1'));
      assert.ok(webStorage, 'Web version must persist data to localStorage');
      assert.ok(webStorage.includes('Persisted web note content 12345'), 'Stored data must contain web note content');

      // Reload web page: data must survive
      await webPage.reload();
      await webPage.waitForSelector(`iframe[name="${webNoteLabel}"]`);
      // The note loads its content asynchronously after the frame appears.
      await webPage.waitForFunction((label) => {
        const frame = document.querySelector(`iframe[name="${label}"]`);
        const ed = frame && frame.contentDocument && frame.contentDocument.getElementById('editor');
        return ed && ed.innerText.trim().length > 0;
      }, webNoteLabel, { timeout: 5000 }).catch(() => {});
      const webTextAfterReload = await webPage.evaluate((label) => {
        const frame = document.querySelector(`iframe[name="${label}"]`);
        return frame.contentDocument.getElementById('editor').innerText;
      }, webNoteLabel);
      assert.ok(webTextAfterReload.includes('Persisted web note content 12345'), 'Web version note content must be preserved across reload');

      // 3. Board creation in web version
      await webPage.evaluate(async () => {
        const mgrFrame = document.querySelector('iframe[name="manager"]');
        if (mgrFrame) {
          const btn = mgrFrame.contentDocument.getElementById('newBoardBtn');
          if (btn) btn.click();
        }
      });
      await webPage.waitForSelector('iframe[name^="board-"]', { timeout: 3000 });
      const hasWebBoard = await webPage.evaluate(() => {
        return Boolean(document.querySelector('iframe[name^="board-"]'));
      });
      assert.equal(hasWebBoard, true, 'Board creation must work in web version and open board window');

      // 4. Re-verify landing page did not receive web version's notes
      await sitePage.reload();
      await sitePage.waitForSelector('iframe[name="note-demo-wifi"]');
      const siteNotes = await sitePage.evaluate(() => {
        return [...document.querySelectorAll('iframe[name^="note-"]')].map((f) => f.name);
      });
      assert.ok(!siteNotes.includes(webNoteLabel), 'Landing page must not load notes from web version');
    } finally {
      await sitePage.close();
      await webPage.close();
    }
  });

  // ------------------------------------------------ 9. Web version bug fixes
  await step('Web version: trash button, board column drop, board-to-group drop, manager note position, manager center', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name^="note-"]');

      // 1. Trash button in note titlebar sends note to trash
      const noteLabel = await webPage.evaluate(() => {
        const frame = document.querySelector('iframe[name^="note-"]');
        return frame ? frame.name : null;
      });
      assert.ok(noteLabel, 'Note window exists');
      const noteId = noteLabel.replace('note-', '');

      // The first time, through its notice (as on the desktop).
      const hinted = await webPage.evaluate(async (lbl) => {
        const doc = document.querySelector(`iframe[name="${lbl}"]`).contentDocument;
        doc.getElementById('trashBtn').click();
        await new Promise((r) => setTimeout(r, 30));
        const n = doc.querySelector('.toast[data-key="trash-hint"]');
        if (!n) return false;
        n.querySelector('.toast-action').click();
        return true;
      }, noteLabel);
      assert.equal(hinted, true, 'The ✕ first shows its notice in Memo Web too');

      await webPage.waitForFunction((lbl) => !document.querySelector(`iframe[name="${lbl}"]`), noteLabel);

      const isTrashed = await webPage.evaluate(async (id) => {
        const notes = await window.MemoWeb.invoke('manager', 'list_notes');
        const note = notes.find((n) => n.id === id);
        return Boolean(note && note.trashedAt);
      }, noteId);
      assert.equal(isTrashed, true, 'Titlebar trash button sends note to trash');

      // 2. Clicking manager tray icon centers manager
      const centered = await webPage.evaluate(() => {
        const trayBtn = document.getElementById('trayManagerBtn');
        trayBtn.click();
        const mgrWin = document.querySelector('.win.is-manager');
        const r = mgrWin.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const expectedX = Math.round(window.innerWidth / 2);
        const expectedY = Math.round(window.innerHeight / 2);
        return Math.abs(cx - expectedX) <= 10 && Math.abs(cy - expectedY) <= 10;
      });
      assert.equal(centered, true, 'Clicking manager button centers manager on screen');

      // 3. Opening a memory that is partially off-screen positions it beside manager
      const noteMovedBeside = await webPage.evaluate(async (id) => {
        await window.MemoWeb.invoke('manager', 'restore_note', { id });
        const noteWin = document.querySelector(`.win[data-label="note-${id}"]`);
        // Move note offscreen
        await window.MemoWeb.invoke(`note-${id}`, 'drag_start', { cx: 10, cy: 10 });
        await window.MemoWeb.invoke(`note-${id}`, 'drag_to', { cx: window.innerWidth + 200, cy: 50 });
        await window.MemoWeb.invoke(`note-${id}`, 'drag_end');

        // Reopen note from manager
        await window.MemoWeb.invoke('manager', 'open_note', { id });
        const noteEl = document.querySelector(`.win[data-label="note-${id}"]`);
        if (!noteEl) return false;
        const nr = noteEl.getBoundingClientRect();
        return nr.left >= 0 && nr.right <= window.innerWidth && nr.top >= 0 && nr.bottom <= window.innerHeight;
      }, noteId);
      assert.equal(noteMovedBeside, true, 'Partially offscreen memory appears beside manager inside screen bounds');

      // 4. Drag & drop board to group
      const boardJoinedGroup = await webPage.evaluate(async () => {
        const g = window.MemoWeb.createGroup();
        await window.MemoWeb.invoke('manager', 'new_board');
        const boards = await window.MemoWeb.invoke('manager', 'list_boards');
        const brd = boards[boards.length - 1];

        const bWin = document.querySelector(`.win[data-label="board-${brd.id}"]`);
        const gWin = document.querySelector(`.win[data-label="group-${g.id}"]`);
        const gr = gWin.getBoundingClientRect();
        const br = bWin.getBoundingClientRect();
        await window.MemoWeb.invoke(`board-${brd.id}`, 'drag_start', { cx: 50, cy: 10 });
        await window.MemoWeb.invoke(`board-${brd.id}`, 'drag_to', { cx: gr.left + 50 - br.left, cy: gr.top + 10 - br.top });
        await window.MemoWeb.invoke(`board-${brd.id}`, 'drag_end');

        const updatedBoards = await window.MemoWeb.invoke('manager', 'list_boards');
        const updatedBrd = updatedBoards.find((x) => x.id === brd.id);
        return Boolean(updatedBrd && updatedBrd.groupId === g.id);
      });
      assert.equal(boardJoinedGroup, true, 'Dragging board to group bar joins board to group');

      // 5. Drag & drop note into board column
      const noteDroppedInBoard = await webPage.evaluate(async (id) => {
        const boards = await window.MemoWeb.invoke('manager', 'list_boards');
        const brd = boards[boards.length - 1];
        const colId = brd.columns[0].id;

        await window.MemoWeb.invoke('manager', 'open_board', { id: brd.id });
        await window.MemoWeb.invoke(`board-${brd.id}`, 'update_board_drop_zones', {
          zones: [{ id: colId, left: 0, right: 300, top: 0, bottom: 500 }],
        });

        await window.MemoWeb.invoke('manager', 'open_note', { id });
        const bWin = document.querySelector(`.win[data-label="board-${brd.id}"]`);
        const nWin = document.querySelector(`.win[data-label="note-${id}"]`);
        const br = bWin.getBoundingClientRect();
        const nr = nWin.getBoundingClientRect();

        await window.MemoWeb.invoke(`note-${id}`, 'drag_start', { cx: 50, cy: 10 });
        await window.MemoWeb.invoke(`note-${id}`, 'drag_to', { cx: br.left + 50 - nr.left, cy: br.top + 50 - nr.top });
        await window.MemoWeb.invoke(`note-${id}`, 'drag_end');

        const updatedBoards = await window.MemoWeb.invoke('manager', 'list_boards');
        const updatedBrd = updatedBoards.find((x) => x.id === brd.id);
        const col = updatedBrd.columns.find((c) => c.id === colId);
        const notes = await window.MemoWeb.invoke('manager', 'list_notes');
        const updatedNote = notes.find((n) => n.id === id);
        return col.noteIds.includes(id) && updatedNote.hidden;
      }, noteId);
      assert.equal(noteDroppedInBoard, true, 'Dropping note into board column moves note to column and hides window');

      // 5b. Dropped above a card's middle, a memory goes before it: first
      //     in a column that already has memories.
      const droppedFirst = await webPage.evaluate(async (firstId) => {
        const inv = window.MemoWeb.invoke;
        const before = new Set((await inv('manager', 'list_notes')).map((n) => n.id));
        await inv('manager', 'new_note');
        const id = (await inv('manager', 'list_notes')).map((n) => n.id).find((x) => !before.has(x));
        const boards = await inv('manager', 'list_boards');
        const brd = boards[boards.length - 1];
        const colId = brd.columns[0].id;
        await inv(`board-${brd.id}`, 'update_board_drop_zones', {
          zones: [{ id: colId, left: 0, right: 300, top: 0, bottom: 500, cards: [{ id: firstId, mid: 200 }] }],
        });
        const br = document.querySelector(`.win[data-label="board-${brd.id}"]`).getBoundingClientRect();
        const nr = document.querySelector(`.win[data-label="note-${id}"]`).getBoundingClientRect();
        await inv(`note-${id}`, 'drag_start', { cx: 50, cy: 10 });
        await inv(`note-${id}`, 'drag_to', { cx: br.left + 50 - nr.left, cy: br.top + 50 - nr.top });
        await inv(`note-${id}`, 'drag_end');
        const col = (await inv('manager', 'list_boards')).find((x) => x.id === brd.id).columns.find((c) => c.id === colId);
        return col.noteIds.slice(0, 2).join() === [id, firstId].join();
      }, noteId);
      assert.equal(droppedFirst, true, 'A memory dropped above the first card goes first in the column');

      // 6. An empty memory put on a board is kept, as in a group: closing it
      //    after opening it from the board must not delete it.
      const emptyKeptOnBoard = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const before = new Set((await inv('manager', 'list_notes')).map((n) => n.id));
        await inv('manager', 'new_note');
        const id = (await inv('manager', 'list_notes')).map((n) => n.id).find((x) => !before.has(x));
        const boards = await inv('manager', 'list_boards');
        const brd = boards[boards.length - 1];
        const colId = brd.columns[0].id;
        await inv(`board-${brd.id}`, 'update_board_drop_zones', {
          zones: [{ id: colId, left: 0, right: 300, top: 0, bottom: 500 }],
        });
        const br = document.querySelector(`.win[data-label="board-${brd.id}"]`).getBoundingClientRect();
        const nr = document.querySelector(`.win[data-label="note-${id}"]`).getBoundingClientRect();
        await inv(`note-${id}`, 'drag_start', { cx: 50, cy: 10 });
        await inv(`note-${id}`, 'drag_to', { cx: br.left + 50 - nr.left, cy: br.top + 50 - nr.top });
        await inv(`note-${id}`, 'drag_end');
        await inv('manager', 'open_board_note', { id });
        await inv(`note-${id}`, 'close_window');
        const kept = (await inv('manager', 'list_notes')).some((n) => n.id === id && !n.trashedAt);
        const stillOnBoard = (await inv('manager', 'list_boards')).find((x) => x.id === brd.id)
          .columns.find((c) => c.id === colId).noteIds.includes(id);
        // Trashing it sends it to the trash (as on the desktop), not away.
        await inv('manager', 'move_to_trash', { id });
        const trashed = (await inv('manager', 'list_notes')).some((n) => n.id === id && n.trashedAt);
        return { id: Boolean(id), kept, stillOnBoard, trashed };
      });
      assert.equal(emptyKeptOnBoard.trashed, true, 'An empty memory on a board goes to the trash, not away');
      assert.equal(emptyKeptOnBoard.id, true, 'A new empty memory should be created');
      assert.equal(emptyKeptOnBoard.kept, true, 'An empty memory on a board must not be deleted when it closes');
      assert.equal(emptyKeptOnBoard.stillOnBoard, true, 'An empty memory on a board stays in its column');
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ 10. Web version stacking
  await step('Web version: the last clicked window stays on top, unless another one is pinned', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name^="note-"]');
      await webPage.evaluate(() => document.querySelector('iframe[name="manager"]').contentDocument.getElementById('newBoardBtn').click());
      await webPage.waitForSelector('.win[data-label^="board-"] iframe');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const note = document.querySelector('.win[data-label^="note-"]').dataset.label;
        const board = document.querySelector('.win[data-label^="board-"]').dataset.label;
        const win = (l) => document.querySelector(`.win[data-label="${l}"]`);
        const z = (l) => Number(win(l).style.zIndex);
        const top = () => [...document.querySelectorAll('.win')].sort((a, b) => b.style.zIndex - a.style.zIndex)[0].dataset.label;
        // A click anywhere in a window (the workspace raises on pointerdown).
        const click = async (l) => {
          const doc = win(l).querySelector('iframe').contentDocument;
          doc.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          await new Promise((r) => setTimeout(r, 50));
        };
        const out = { notePinnedTier: win(note).classList.contains('pinned') };
        await click(board);
        await click(note);
        out.noteOverBoard = top() === note;
        await click('manager');
        out.managerOnTop = top() === 'manager';
        await click(note);
        out.noteOnTopAgain = top() === note && z(note) > z(board) && z(note) > z('manager');
        // Pin the board: it stays above the note even after the note is clicked.
        win(board).querySelector('iframe').contentDocument.getElementById('pinBtn').click();
        await new Promise((r) => setTimeout(r, 300));
        await click(note);
        out.pinnedBoardAbove = z(board) > z(note);
        await new Promise((r) => setTimeout(r, 600)); // saves are debounced (400 ms)
        const data = JSON.parse(localStorage.getItem('memo.web.data.v1') || '{}');
        out.managerStaysUnpinned = !(data.manager && data.manager.pinned);
        out.boardSavedPinned = (data.boards || []).some((b) => `board-${b.id}` === board && b.pinned);
        return out;
      });
      assert.equal(res.notePinnedTier, false, 'An unpinned memory must not open in the pinned layer');
      assert.equal(res.noteOverBoard, true, 'Clicking a memory brings it above the board');
      assert.equal(res.managerOnTop, true, 'Clicking the manager brings it to the front');
      assert.equal(res.noteOnTopAgain, true, 'Clicking the memory again brings it above the manager and board');
      assert.equal(res.pinnedBoardAbove, true, 'A pinned board stays above an unpinned memory that is clicked');
      assert.equal(res.managerStaysUnpinned, true, 'Pinning a board must not pin the manager');
      assert.equal(res.boardSavedPinned, true, 'Pinning a board saves it as pinned');

      // A board nobody touched is removed when closed (as on the desktop);
      // one with a name stays among the current ones, hidden.
      const closing = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const ids = async () => (await inv('manager', 'list_boards')).map((b) => b.id);
        const before = new Set(await ids());
        await inv('manager', 'new_board');
        const fresh = (await ids()).find((x) => !before.has(x));
        await inv(`board-${fresh}`, 'close_window');
        const freshGone = !(await ids()).includes(fresh);
        await inv('manager', 'new_board');
        const named = (await ids()).find((x) => !before.has(x));
        await inv(`board-${named}`, 'rename', { name: 'Kept' });
        await inv(`board-${named}`, 'close_window');
        const kept = (await inv('manager', 'list_boards')).find((b) => b.id === named);
        return { freshGone, namedKept: Boolean(kept && kept.hidden && !kept.trashedAt && kept.name === 'Kept') };
      });
      assert.equal(closing.freshGone, true, 'Closing a board nobody touched removes it');
      assert.equal(closing.namedKept, true, 'Closing a named board keeps it, hidden');
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Web: a group leaves its board memories on the board
  await step('Web version: a group click opens its memories, but not those on a board', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name^="note-"]');
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const noteIds = async () => (await inv('manager', 'list_notes')).map((n) => n.id);
        const newNote = async () => {
          const before = new Set(await noteIds());
          await inv('manager', 'new_note');
          return (await noteIds()).find((x) => !before.has(x));
        };
        const loose = await newNote();
        const carded = await newNote();
        const groupsBefore = new Set((await inv('manager', 'list_groups')).map((g) => g.id));
        await inv(`note-${loose}`, 'new_group');
        const gid = (await inv('manager', 'list_groups')).map((g) => g.id).find((x) => !groupsBefore.has(x));
        for (const id of [loose, carded]) await inv(`note-${id}`, 'set_note_group', { groupId: gid });
        const boardsBefore = new Set((await inv('manager', 'list_boards')).map((b) => b.id));
        await inv('manager', 'new_board');
        const bid = (await inv('manager', 'list_boards')).map((b) => b.id).find((x) => !boardsBefore.has(x));
        const board = await inv(`board-${bid}`, 'load_board');
        board.columns[0].noteIds.push(carded);
        await inv(`board-${bid}`, 'save_board_columns', { columns: board.columns });
        for (const id of [loose, carded]) await inv(`note-${id}`, 'close_window');
        await wait(100);
        const open = (id) => Boolean(document.querySelector(`.win[data-label="note-${id}"]`));
        await inv(`group-${gid}`, 'show_group_notes');
        await wait(300);
        const out = { looseOpened: open(loose), cardedOpened: open(carded) };
        await inv(`group-${gid}`, 'toggle_group'); // put away
        await wait(300);
        await inv(`group-${gid}`, 'toggle_group'); // take out
        await wait(300);
        out.cardedAfterTakeOut = open(carded);
        return out;
      });
      assert.equal(res.looseOpened, true, 'A click on the group bar opens its memories');
      assert.equal(res.cardedOpened, false, 'A memory on a board stays a card when the group bar is clicked');
      assert.equal(res.cardedAfterTakeOut, false, 'Taking the memories out leaves the ones on a board in it');
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Web: share a board and a group, import them elsewhere
  await step('Web version: a shared board and group are imported as new copies from their links', async () => {
    const sender = await browser.newPage();
    const receiver = await browser.newPage();
    try {
      await sender.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
      await sender.goto(`http://127.0.0.1:${port}/site/app.html`);
      await sender.waitForSelector('iframe[name="manager"]');
      const shared = await sender.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const ids = async (cmd) => (await inv('manager', cmd)).map((x) => x.id);
        const newOne = async (cmd, list, from = 'manager') => {
          const before = new Set(await ids(list));
          await inv(from, cmd);
          return (await ids(list)).find((x) => !before.has(x));
        };
        const a = await newOne('new_note', 'list_notes');
        const b = await newOne('new_note', 'list_notes');
        await inv(`note-${a}`, 'rename', { name: 'Pão' });
        await inv(`note-${b}`, 'rename', { name: 'Leite' });
        const bid = await newOne('new_board', 'list_boards');
        await inv(`board-${bid}`, 'rename', { name: 'Mercado' });
        const board = await inv(`board-${bid}`, 'load_board');
        board.columns[0].noteIds = [a, b];
        await inv(`board-${bid}`, 'save_board_columns', { columns: board.columns });
        const boardLink = await inv(`board-${bid}`, 'copy_share');
        const gid = await newOne('new_group', 'list_groups', `note-${a}`);
        await inv(`group-${gid}`, 'rename', { name: 'Casa' });
        const c = await newOne('new_note', 'list_notes');
        await inv(`note-${c}`, 'rename', { name: 'Contas' });
        for (const id of [a, c]) await inv(`note-${id}`, 'set_note_group', { groupId: gid });
        const groupLink = await inv(`group-${gid}`, 'copy_share');
        return { boardLink, groupLink, bid, gid };
      });
      assert.ok(/^http:\/\/localhost:\d+\/memo\/app\.html#memo:v1:[A-Za-z0-9_-]+$/.test(shared.boardLink), `The board's link, nothing else (${shared.boardLink.slice(0, 80)})`);

      await receiver.goto(`http://127.0.0.1:${port}/site/app.html`);
      await receiver.waitForSelector('iframe[name="manager"]');
      await receiver.waitForTimeout(400);
      const imported = await receiver.evaluate(async ({ boardLink, groupLink, bid, gid }) => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const frame = document.querySelector('iframe[name="manager"]');
        // Opening a link: its fragment, here.
        const open = (link) => { location.hash = link.slice(link.indexOf('#') + 1); };
        const dialog = () => document.querySelector('.share-dialog');
        const out = {};
        open(boardLink);
        await wait(300);
        out.offer = dialog() ? dialog().textContent : '';
        dialog().querySelector('[data-choice="web"]').click();
        await wait(400);
        const boards = await inv('manager', 'list_boards');
        const copy = boards.find((b) => b.name === 'Mercado' && b.id !== bid);
        const notes = await inv('manager', 'list_notes');
        const title = (id) => (notes.find((n) => n.id === id) || {}).title;
        out.board = copy ? copy.columns[0].noteIds.map(title) : null;
        out.boardOpen = Boolean(copy && document.querySelector(`.win[data-label="board-${copy.id}"]`));
        open(groupLink);
        await wait(300);
        dialog().querySelector('[data-choice="web"]').click();
        await wait(400);
        const group = (await inv('manager', 'list_groups')).find((g) => g.name === 'Casa' && g.id !== gid);
        const notesAfter = await inv('manager', 'list_notes');
        out.group = group ? notesAfter.filter((n) => n.groupId === group.id).map((n) => n.title).sort() : null;
        out.addressBar = location.hash;
        return out;
      }, shared);
      assert.ok(imported.offer.includes('Importar o quadro “Mercado”'), `An opened link asks where to import (${imported.offer})`);
      assert.deepEqual(imported.board, ['Pão', 'Leite'], 'Import makes a new board with the same column of memories');
      assert.equal(imported.boardOpen, true, 'The imported board opens');
      assert.deepEqual(imported.group, ['Contas', 'Pão'], 'A group comes with its memories');
      assert.equal(imported.addressBar, '', 'The code leaves the address bar');
    } finally {
      await sender.close();
      await receiver.close();
    }
  });

  // ------------------------------------------------ Web: share by link
  await step('Web version: "Share link" makes a link; opening it asks in one dialog: this browser or the desktop app', async () => {
    const sender = await browser.newPage();
    const receiver = await browser.newPage();
    try {
      await sender.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
      await sender.goto(`http://127.0.0.1:${port}/site/app.html`);
      await sender.waitForSelector('iframe[name="manager"]');
      const sent = await sender.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const before = new Set((await inv('manager', 'list_notes')).map((n) => n.id));
        await inv('manager', 'new_note');
        const id = (await inv('manager', 'list_notes')).map((n) => n.id).find((x) => !before.has(x));
        await inv(`note-${id}`, 'rename', { name: 'Feira' });
        const link = await inv(`note-${id}`, 'copy_share');
        return { link, clip: await navigator.clipboard.readText() };
      });
      assert.equal(sent.clip, sent.link, 'The link goes to the clipboard');
      // Memo Web running locally links to itself on localhost, at /memo/ as published.
      assert.ok(new RegExp(`^http://localhost:${port}/memo/app\\.html#memo:v1:[A-Za-z0-9_-]+$`).test(sent.link),
        `Only the link, on the local Memo Web (${sent.link.slice(0, 90)})`);

      const hash = sent.link.slice(sent.link.indexOf('#'));
      await receiver.goto(`http://127.0.0.1:${port}/site/app.html${hash}`);
      await receiver.waitForSelector('iframe[name="manager"]');
      await receiver.waitForTimeout(600);
      const got = await receiver.evaluate(async (code) => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const dialogs = document.querySelectorAll('.share-dialog');
        const dialog = dialogs[0];
        const toast = document.querySelector('iframe[name="manager"]').contentDocument.querySelector('.toast[data-key="share"]');
        const out = {
          hash: location.hash,
          dialogs: dialogs.length,
          title: dialog ? dialog.querySelector('h2').textContent : '',
          choices: dialog ? [...dialog.querySelectorAll('[data-choice]')].map((b) => [b.dataset.choice, b.textContent]) : [],
          appHref: dialog ? dialog.querySelector('[data-choice="app"]').getAttribute('href') : '',
          buttons: dialog ? dialog.querySelectorAll('.share-dialog-btn').length : 0,
          hasX: Boolean(dialog && dialog.querySelector('.share-dialog-close')),
          toast: Boolean(toast && !toast.hidden),
        };
        // The ✕ and a click outside cancel; then open it again.
        dialog.querySelector('.share-dialog-close').click();
        out.afterX = [document.querySelectorAll('.share-dialog').length, (await inv('manager', 'list_notes')).some((n) => n.title === 'Feira')];
        location.hash = code;
        await wait(400);
        const back = document.querySelector('.share-dialog-back');
        back.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        out.afterOutside = document.querySelectorAll('.share-dialog').length;
        location.hash = code;
        await wait(400);
        document.querySelector('.share-dialog [data-choice="web"]').click();
        await wait(400);
        out.after = document.querySelectorAll('.share-dialog').length;
        out.imported = (await inv('manager', 'list_notes')).some((n) => n.title === 'Feira');
        return out;
      }, hash.slice(1));
      assert.equal(got.hash, '', 'The code leaves the address bar');
      assert.equal(got.dialogs, 1, 'Opening the link shows one dialog');
      assert.equal(got.title, 'Importar a memória “Feira”');
      assert.deepEqual(got.choices, [['app', 'No app do computador'], ['web', 'Neste navegador']],
        'It asks: this browser or the desktop app');
      assert.equal(got.buttons, 2, 'Only two buttons');
      assert.equal(got.hasX, true, 'A ✕ at the top right');
      assert.deepEqual(got.afterX, [0, false], 'The ✕ closes it, importing nothing');
      assert.equal(got.afterOutside, 0, 'A click outside closes it');
      assert.ok(got.appHref.startsWith('memo://import#memo:v1:'), `The desktop app gets it through memo:// (${got.appHref.slice(0, 40)})`);
      assert.equal(got.toast, false, 'No other offer beside the dialog');
      assert.equal(got.after, 0, 'The dialog closes');
      assert.equal(got.imported, true, '"In this browser" makes the copy here');
    } finally {
      await sender.close();
      await receiver.close();
    }
  });

  // ------------------------------------------------ Web on a phone: read-only video PiP
  await step('Web version on a phone: pinning floats the memory read-only in a video PiP, redrawn on edits', async () => {
    const webPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        // The browser's PiP, recorded: the canvas streamed and the video.
        const capture = HTMLCanvasElement.prototype.captureStream;
        HTMLCanvasElement.prototype.captureStream = function (...a) {
          window.__pipCanvas = this;
          return capture.apply(this, a);
        };
        HTMLVideoElement.prototype.requestPictureInPicture = async function () {
          window.__pipVideo = this;
          return {};
        };
        const before = new Set((await inv('manager', 'list_notes')).map((n) => n.id));
        await inv('manager', 'new_note');
        const id = (await inv('manager', 'list_notes')).map((n) => n.id).find((x) => !before.has(x));
        const label = `note-${id}`;
        await inv(label, 'rename', { name: 'Lista' });
        await wait(300);
        const pinned = await inv(label, 'set_pinned', { pinned: true });
        await wait(200);
        const canvas = window.__pipCanvas;
        const pixels = () => {
          const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let lit = 0;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > 300) lit++;
            sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) % 1e9;
          }
          return { lit, sum };
        };
        const out = { pinned, mobile: window.MemoWeb.isMobile(), video: Boolean(window.__pipVideo), drawn: canvas && pixels() };
        const toast = document.querySelector(`iframe[name="${label}"]`).contentDocument.querySelector('.toast[data-key="pip"]');
        out.toast = toast ? toast.textContent : '';
        await inv(label, 'save_text', { text: 'pão\nleite', html: '<div>pão</div><div>leite</div>' });
        await wait(200);
        out.redrawn = pixels();
        window.__pipVideo.dispatchEvent(new Event('leavepictureinpicture'));
        await wait(200);
        out.after = (await inv('manager', 'list_notes')).find((n) => n.id === id).pinned;
        return out;
      });
      assert.equal(res.mobile, true, 'A phone-sized page');
      assert.equal(res.pinned, true);
      assert.equal(res.video, true, 'Pinning asks the browser for a video PiP');
      assert.ok(res.drawn && res.drawn.lit > 50, `The memory is drawn on the canvas (${JSON.stringify(res.drawn)})`);
      assert.ok(res.toast.includes('só para leitura'), `The memory says it floats read-only (${res.toast})`);
      assert.notEqual(res.redrawn.sum, res.drawn.sum, 'Editing the memory redraws the picture');
      assert.equal(res.after, false, 'Closing the PiP unpins the memory');
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Web: a trashed board takes its memories
  await step('Web version on a phone: a column\'s "New memory" adds one at its bottom', async () => {
    const webPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const before = new Set((await inv('manager', 'list_boards')).map((x) => x.id));
        await inv('manager', 'new_board');
        const bid = (await inv('manager', 'list_boards')).map((x) => x.id).find((x) => !before.has(x));
        await new Promise((r) => setTimeout(r, 400));
        const frame = document.querySelector(`iframe[name="board-${bid}"]`);
        const btn = frame && frame.contentDocument.querySelectorAll('.col-add-note')[2];
        const notesBefore = (await inv('manager', 'list_notes')).length;
        if (btn) btn.click();
        await new Promise((r) => setTimeout(r, 400));
        const board = await inv(`board-${bid}`, 'load_board');
        return {
          button: Boolean(btn),
          added: (await inv('manager', 'list_notes')).length - notesBefore,
          counts: board.columns.map((c) => c.noteIds.length),
        };
      });
      assert.equal(res.button, true, 'The board shows the button on a phone');
      assert.equal(res.added, 1, 'It creates one memory');
      assert.deepEqual(res.counts, [0, 0, 1], 'In that column');
    } finally {
      await webPage.close();
    }
  });

  await step('Web version: a memory opened from a board closes by itself when a click goes elsewhere', async () => {
    const webPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const bid = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const before = new Set((await inv('manager', 'list_boards')).map((x) => x.id));
        await inv('manager', 'new_board');
        return (await inv('manager', 'list_boards')).map((x) => x.id).find((x) => !before.has(x));
      });
      await webPage.waitForTimeout(400);
      const boardFrame = webPage.frameLocator(`iframe[name="board-${bid}"]`);
      // A column's "New memory" opens one from the board.
      const before = await webPage.evaluate(async () => (await window.MemoWeb.invoke('manager', 'list_notes')).map((n) => n.id));
      await boardFrame.locator('.col-add-note').first().click();
      await webPage.waitForTimeout(400);
      const id = await webPage.evaluate(async (before) => (await window.MemoWeb.invoke('manager', 'list_notes')).map((n) => n.id).find((x) => !before.includes(x)), before);
      const open = () => webPage.evaluate((sel) => Boolean(document.querySelector(sel)), `.win[data-label="note-${id}"]`);
      // Editing it keeps it open.
      await webPage.frameLocator(`iframe[name="note-${id}"]`).locator('#editor').click();
      await webPage.keyboard.type('Comprar pão');
      await webPage.waitForTimeout(300);
      const whileEditing = await open();
      // A click on the board (another window) closes it.
      await boardFrame.locator('.col-head').first().click({ position: { x: 60, y: 10 } });
      await webPage.waitForTimeout(400);
      const afterOther = await open();
      // Opened again from its card, a click on the desk closes it too.
      await boardFrame.locator(`.board-card[data-note-id="${id}"]`).click();
      await webPage.waitForTimeout(400);
      await webPage.frameLocator(`iframe[name="note-${id}"]`).locator('#editor').click();
      await webPage.mouse.click(1390, 890);
      await webPage.waitForTimeout(400);
      const afterDesk = await open();
      const still = await webPage.evaluate(async ([id, bid]) => {
        const b = await window.MemoWeb.invoke(`board-${bid}`, 'load_board');
        const n = (await window.MemoWeb.invoke('manager', 'list_notes')).find((x) => x.id === id);
        return { onBoard: b.columns[0].noteIds.includes(id), kept: Boolean(n && !n.trashedAt) };
      }, [id, bid]);
      assert.equal(whileEditing, true, 'It stays open while being edited');
      assert.equal(afterOther, false, 'A click on another window closes it');
      assert.equal(afterDesk, false, 'A click on the desk closes it');
      assert.deepEqual(still, { onBoard: true, kept: true }, 'It stays on its board, not trashed');
    } finally {
      await webPage.close();
    }
  });

  await step('Reminders: set from the titlebar menu or the footer bell; the bell shows on the note, the manager and the board', async () => {
    const res = await page.evaluate(async () => {
      const M = window.Memo;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = {};
      M.addNote({ id: 'rm-note', title: 'Ligar', text: 'x' });
      M.addBoard({ id: 'rm-board', name: 'B' });
      M.boards['rm-board'].columns = [{ id: 'rm-col', name: '', color: '', noteIds: ['rm-note'], collapsed: [] }];
      await M.openNote('rm-note');
      await M.openWin('board-rm-board', '/src/windows/board/board.html', { x: 360, y: 40, w: 420, h: 300 });
      await wait(300);
      const doc = M.frameDoc('note-rm-note');
      const win = doc.defaultView;
      // The bell is always in the footer: alone without a reminder, and a
      // click on it opens the popover.
      const bare = doc.querySelector('#footReminder .reminder-pill');
      out.bareBell = Boolean(bare && bare.classList.contains('is-unset') && bare.querySelector('svg') && !bare.textContent.trim());
      bare.click();
      await wait(30);
      out.bareOpens = !doc.querySelector('.reminder-menu').hidden;
      doc.querySelector('.reminder-menu').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // The titlebar menu's "Reminder…" opens the popover.
      let items = [];
      M.hooks.show_title_menu = (label, a) => { items = a.items || []; return null; };
      doc.getElementById('titlebar').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 10 }));
      await wait(50);
      delete M.hooks.show_title_menu;
      const entry = items.find((i) => i && i.label === 'Lembrete…');
      out.inMenu = Boolean(entry);
      for (const l of M.listeners) if (l.ev === 'title-menu' && l.w === win) l.cb({ payload: entry.id });
      await wait(30);
      const menu = doc.querySelector('.reminder-menu');
      out.opened = !menu.hidden;
      out.presets = [...menu.querySelectorAll('[data-preset]')].map((b) => b.dataset.preset);
      out.noRemoveYet = !menu.querySelector('.reminder-remove');
      // "Tomorrow at 09:00".
      menu.querySelector('[data-preset="tomorrow"]').click();
      await wait(80);
      const at = new Date(M.notes['rm-note'].remindAt);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      out.tomorrow9 = at.toDateString() === tomorrow.toDateString() && at.getHours() === 9 && at.getMinutes() === 0;
      out.closedAfterPick = menu.hidden;
      out.footer = (doc.querySelector('#footReminder .reminder-pill') || {}).textContent;
      // The footer has no word count; the bell sits right before Aa, on the right.
      const foot = doc.querySelector('.statusbar');
      out.noWords = !doc.getElementById('count') && !/palavra|word/i.test(foot.textContent);
      const bellBox = doc.getElementById('footReminder').getBoundingClientRect();
      const aaBox = doc.getElementById('trayBtn').getBoundingClientRect();
      out.besideAa = doc.getElementById('footReminder').nextElementSibling === doc.getElementById('trayBtn')
        && aaBox.left - bellBox.right >= 0 && aaBox.left - bellBox.right < 16;
      // Its time is never cut: the group and boards give way first.
      const bellText = doc.querySelector('#footReminder .reminder-pill span');
      out.timeWhole = bellText.scrollWidth <= bellText.clientWidth;
      await wait(200);
      const card = M.frameDoc('manager').querySelector('.reminder-pill');
      out.manager = card && card.textContent;
      const onBoard = M.frameDoc('board-rm-board').querySelector('.board-card[data-note-id="rm-note"] .reminder-pill');
      out.board = onBoard && onBoard.textContent;
      // The footer's bell opens it again: a date and time of one's own.
      doc.querySelector('#footReminder .reminder-pill').click();
      await wait(30);
      out.reopened = !menu.hidden;
      const input = menu.querySelector('.reminder-pick input');
      input.value = '2031-05-04T07:30';
      input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(50);
      out.picked = M.notes['rm-note'].remindAt === new Date('2031-05-04T07:30').getTime();
      // Esc closes it without a change; "Remove reminder" clears it.
      doc.querySelector('#footReminder .reminder-pill').click();
      await wait(30);
      menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      out.escClosed = menu.hidden && M.notes['rm-note'].remindAt != null;
      // The quick choices come from Settings (get_reminder_defaults).
      M.reminderDefaults = ['in:30m', 'at:+3@17:00', 'at:fri@08:30'];
      doc.querySelector('#footReminder .reminder-pill').click();
      await wait(50);
      out.customLabels = [...menu.querySelectorAll('[data-preset]')].map((b) => b.textContent);
      menu.querySelector('[data-preset="fri"]').click();
      await wait(50);
      const at2 = new Date(M.notes['rm-note'].remindAt);
      out.customFriday = at2.getDay() === 5 && at2.getHours() === 8 && at2.getMinutes() === 30
        && at2 > Date.now() && at2 - Date.now() <= 7 * 86_400_000;
      delete M.reminderDefaults;
      // When each kind of choice falls, from Wednesday 2026-10-28 10:00.
      const R = win.MemoReminder;
      const from = new Date(2026, 9, 28, 10, 0).getTime();
      const fall = (spec) => { const ms = R.when(R.parse(spec), from); return ms && new Date(ms).toString().slice(0, 21); };
      out.falls = {
        weeks: fall('in:2w'), plus: fall('at:+3@07:45'), mon: fall('at:mon@09:00'),
        wedLater: fall('at:wed@18:00'), wedGone: fall('at:wed@09:00'), todayGone: fall('at:today@09:00'),
      };
      // "Remove reminder" clears it.
      doc.querySelector('#footReminder .reminder-pill').click();
      await wait(50);
      menu.querySelector('.reminder-remove').click();
      await wait(50);
      const after = doc.querySelector('#footReminder .reminder-pill');
      out.removed = M.notes['rm-note'].remindAt === null && Boolean(after) && after.classList.contains('is-unset') && !after.textContent.trim();
      M.closeWin('note-rm-note');
      M.closeWin('board-rm-board');
      delete M.notes['rm-note'];
      delete M.boards['rm-board'];
      M.emit('notes-changed');
      M.emit('boards-changed');
      return out;
    });
    assert.equal(res.bareBell, true, 'With no reminder, the footer still shows the bell, alone');
    assert.equal(res.bareOpens, true, 'A click on it opens the reminder popover');
    assert.equal(res.inMenu, true, 'The titlebar menu has "Lembrete…"');
    assert.equal(res.opened, true, 'It opens the reminder popover');
    assert.ok(res.presets.includes('in') && res.presets.includes('tomorrow'), `Quick choices (${res.presets})`);
    assert.equal(res.noRemoveYet, true, 'No "Remove" without a reminder');
    assert.equal(res.tomorrow9, true, '"Amanhã às 09:00" sets tomorrow at 09:00');
    assert.equal(res.closedAfterPick, true, 'Picking closes the popover');
    assert.match(res.footer || '', /Amanhã 09:00/, 'The note footer shows the bell and when');
    assert.equal(res.noWords, true, 'The note footer has no word count');
    assert.equal(res.besideAa, true, 'The bell sits right before Aa');
    assert.equal(res.timeWhole, true, 'The bell\'s time is never cut');
    assert.match(res.manager || '', /Amanhã 09:00/, 'So does its manager card');
    assert.match(res.board || '', /Amanhã 09:00/, 'And its board card');
    assert.equal(res.reopened, true, 'The footer bell opens the popover');
    assert.equal(res.picked, true, 'A date and time of one\'s own, confirmed with Enter');
    assert.equal(res.escClosed, true, 'Esc closes it without a change');
    assert.equal(res.removed, true, '"Remover lembrete" clears it; the bell stays, alone');
    assert.deepEqual(res.customLabels, ['Em 30 minutos', 'Em 3 dias às 17:00', 'Sexta-feira às 08:30'],
      'The quick choices follow Settings');
    assert.equal(res.customFriday, true, '"Sexta-feira às 08:30" sets the next Friday at 08:30');
    assert.deepEqual(res.falls, {
      weeks: 'Wed Nov 11 2026 10:00', plus: 'Sat Oct 31 2026 07:45', mon: 'Mon Nov 02 2026 09:00',
      wedLater: 'Wed Oct 28 2026 18:00', wedGone: 'Wed Nov 04 2026 09:00', todayGone: null,
    }, 'Each kind of choice falls on the right day');
  });

  await step('Web version: Settings → Defaults → Memory sets the reminder\'s quick choices', async () => {
    const webPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const doc = document.querySelector('iframe[name="manager"]').contentDocument;
        const row = (i) => doc.querySelector(`#reminderDefaults .reminder-default[data-choice="${i}"]`);
        const set = async (i, cls, value) => {
          const f = row(i).querySelector(`.${cls}`);
          f.value = value;
          f.dispatchEvent(new Event('change', { bubbles: true }));
          await wait(80);
        };
        const get = () => inv('manager', 'get_reminder_defaults');
        const out = { rows: doc.querySelectorAll('#reminderDefaults .reminder-default').length, first: row(0).textContent };
        await set(0, 'rd-amount', '2');
        await set(0, 'rd-unit', 'w');
        out.weeks = (await get())[0];
        await set(1, 'rd-day', 'plus');
        await set(1, 'rd-days', '5');
        out.plus = (await get())[1];
        await set(2, 'rd-day', 'mon');
        await set(2, 'rd-time', '07:30');
        out.monday = (await get())[2];
        await set(0, 'rd-kind', 'at');
        out.switched = (await get())[0];
        // Nonsense goes back to Memo's.
        await set(1, 'rd-days', '0');
        out.fallback = (await get())[1];
        await inv('manager', 'reset_settings');
        out.reset = await get();
        return out;
      });
      assert.equal(res.rows, 3, 'Three quick choices');
      assert.match(res.first, /Daqui a.*horas/, 'The first starts as "Daqui a 1 horas"');
      assert.equal(res.weeks, 'in:2w', '"Daqui a 2 semanas"');
      assert.equal(res.plus, 'at:+5@18:00', '"No dia Daqui a 5 dias às 18:00"');
      assert.equal(res.monday, 'at:mon@07:30', '"No dia Segunda-feira às 07:30"');
      assert.equal(res.switched, 'at:tomorrow@09:00', 'Switching to "No dia" starts at tomorrow 09:00');
      assert.equal(res.fallback, 'at:today@18:00', 'An invalid choice goes back to Memo\'s');
      assert.deepEqual(res.reset, ['in:1h', 'at:today@18:00', 'at:tomorrow@09:00'], '"Configurações padrão" restores them');
    } finally {
      await webPage.close();
    }
  });

  await step('Web version: a due reminder brings its memory up pinned, with a notification; never from the trash', async () => {
    const webPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    try {
      await webPage.addInitScript(() => {
        window.__shown = [];
        window.Notification = class {
          constructor(title, opts) { window.__shown.push({ title, body: opts && opts.body }); }
          static requestPermission() { return Promise.resolve('granted'); }
        };
        window.Notification.permission = 'granted';
      });
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const W = window.MemoWeb;
        const inv = W.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const ids = async () => (await inv('manager', 'list_notes')).map((x) => x.id);
        const make = async (name, text) => {
          const before = new Set(await ids());
          await inv('manager', 'new_note');
          const id = (await ids()).find((x) => !before.has(x));
          await inv(`note-${id}`, 'rename', { name });
          await inv(`note-${id}`, 'save_text', { text, html: `<div>${text}</div>` });
          return id;
        };
        const due = await make('Ligar', '[ ] Para a Ana');
        const binned = await make('Lixo', 'y');
        const later = await make('Depois', 'z');
        const past = Date.now() - 1000;
        await inv(`note-${due}`, 'set_reminder', { at: past });
        await inv(`note-${binned}`, 'set_reminder', { at: past });
        await inv(`note-${later}`, 'set_reminder', { at: Date.now() + 3_600_000 });
        await inv(`note-${due}`, 'close_window');
        await inv('manager', 'move_to_trash', { id: binned });
        await wait(200);
        const open = (id) => Boolean(document.querySelector(`.win[data-label="note-${id}"]`));
        const out = { closedBefore: !open(due) };
        await W.fireDueReminders();
        await wait(300);
        const list = await inv('manager', 'list_notes');
        const n = (id) => list.find((x) => x.id === id);
        out.opened = open(due);
        out.pinned = n(due).pinned === true;
        out.cleared = n(due).remindAt == null;
        out.notified = window.__shown;
        out.trashKept = n(binned).remindAt != null && !open(binned);
        out.laterWaits = n(later).remindAt != null;
        return out;
      });
      assert.equal(res.closedBefore, true, 'The memory was closed');
      assert.equal(res.opened, true, 'It opens');
      assert.equal(res.pinned, true, 'Pinned on top');
      assert.equal(res.cleared, true, 'Its reminder is used up');
      assert.deepEqual(res.notified, [{ title: 'Ligar', body: 'Para a Ana' }], 'One system notification, with its name and first line');
      assert.equal(res.trashKept, true, 'A memory in the trash never fires');
      assert.equal(res.laterWaits, true, 'A later one waits');
    } finally {
      await webPage.close();
    }
  });

  await step('Web version: trashing a board sends its memories to the trash; restoring it brings them back', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const ids = async (cmd) => (await inv('manager', cmd)).map((x) => x.id);
        const newOne = async (cmd, list) => {
          const before = new Set(await ids(list));
          await inv('manager', cmd);
          return (await ids(list)).find((x) => !before.has(x));
        };
        const a = await newOne('new_note', 'list_notes');
        const b = await newOne('new_note', 'list_notes');
        const loose = await newOne('new_note', 'list_notes');
        for (const [id, name] of [[a, 'A'], [b, 'B'], [loose, 'Solta']]) await inv(`note-${id}`, 'rename', { name });
        const bid = await newOne('new_board', 'list_boards');
        await inv(`board-${bid}`, 'rename', { name: 'Q' });
        const board = await inv(`board-${bid}`, 'load_board');
        board.columns[0].noteIds = [a, b];
        await inv(`board-${bid}`, 'save_board_columns', { columns: board.columns });
        const trashed = async () => (await inv('manager', 'list_notes')).filter((n) => n.trashedAt).map((n) => n.title).sort();
        await inv('manager', 'trash_board_id', { id: bid });
        const out = { afterTrash: await trashed(), boardTrashed: Boolean((await inv('manager', 'list_boards')).find((x) => x.id === bid).trashedAt) };
        out.windowsGone = !document.querySelector(`.win[data-label="note-${a}"]`) && !document.querySelector(`.win[data-label="note-${b}"]`);
        await inv('manager', 'restore_board_id', { id: bid });
        out.afterRestore = await trashed();
        return out;
      });
      assert.equal(res.boardTrashed, true);
      assert.deepEqual(res.afterTrash, ['A', 'B'], 'The board\'s memories go to the trash with it (not the loose one)');
      assert.equal(res.windowsGone, true, 'Their windows close');
      assert.deepEqual(res.afterRestore, [], 'Restoring the board brings its memories back');
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Settings → Defaults: board pane (web)
  await step('Web version: Settings → Defaults has Memory, Group and Board panes; a new board takes the board defaults', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      await webPage.waitForTimeout(400);
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const doc = document.querySelector('iframe[name="manager"]').contentDocument;
        doc.getElementById('tabSettings').click();
        await wait(100);
        const shown = () => [...doc.querySelectorAll('.def-pane')].filter((p) => !p.hidden).map((p) => p.dataset.pane);
        const out = { start: shown() };
        doc.querySelector('#defaultsSwitch [data-pane="group"]').click();
        out.group = shown();
        doc.querySelector('#defaultsSwitch [data-pane="board"]').click();
        out.board = shown();
        const rows = () => [...doc.querySelectorAll('#boardDefaultColumns .def-column')];
        const names = () => rows().map((r) => r.querySelector('input').value);
        out.langColumns = names();
        doc.querySelector('#boardSwatches .swatch[data-color="teal"]').click();
        const title = doc.getElementById('boardDefaultTitle');
        title.value = 'Sprint';
        title.dispatchEvent(new Event('change'));
        doc.getElementById('addDefaultColumn').click();
        const last = rows().at(-1).querySelector('input');
        last.value = 'Ideias';
        last.dispatchEvent(new Event('input', { bubbles: true }));
        rows().at(-1).querySelector('[data-act="up"]').click();
        rows()[0].querySelector('[data-act="remove"]').click();
        out.edited = names();
        await wait(500);
        out.saved = await inv('manager', 'get_board_defaults');
        const before = new Set((await inv('manager', 'list_boards')).map((b) => b.id));
        await inv('manager', 'new_board');
        const board = (await inv('manager', 'list_boards')).find((b) => !before.has(b.id));
        out.newBoard = [board.name, board.color, board.columns.map((c) => c.name)];
        doc.getElementById('restoreDefaultColumns').click();
        await wait(100);
        out.restored = [(await inv('manager', 'get_board_defaults'))[2], names()];
        return out;
      });
      assert.deepEqual(res.start, ['note'], 'One pane at a time, Memory first');
      assert.deepEqual(res.group, ['group']);
      assert.deepEqual(res.board, ['board']);
      assert.deepEqual(res.langColumns, ['A Fazer', 'Em Andamento', 'Concluído'], 'Board columns start as the language\'s');
      assert.deepEqual(res.edited, ['Em Andamento', 'Ideias', 'Concluído'], 'Add, move up and remove a column');
      assert.equal(res.saved[0], 'teal');
      assert.equal(res.saved[1], 'Sprint');
      assert.deepEqual(res.saved[2].map((c) => c.name), ['Em Andamento', 'Ideias', 'Concluído']);
      assert.deepEqual(res.newBoard, ['Sprint', 'teal', ['Em Andamento', 'Ideias', 'Concluído']], 'A new board takes the defaults');
      assert.equal(res.restored[0], null, 'Restore goes back to the language\'s columns');
      assert.deepEqual(res.restored[1], ['A Fazer', 'Em Andamento', 'Concluído']);
    } finally {
      await webPage.close();
    }
  });

  // ------------------------------------------------ Web: pinned members stay out; the manager opens just one
  await step('Web version: putting a group away leaves pinned members out; the manager opens only the memory picked', async () => {
    const webPage = await browser.newPage();
    try {
      await webPage.goto(`http://127.0.0.1:${port}/site/app.html`);
      await webPage.waitForSelector('iframe[name="manager"]');
      const res = await webPage.evaluate(async () => {
        const inv = window.MemoWeb.invoke;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const ids = async (cmd) => (await inv('manager', cmd)).map((x) => x.id);
        const newOne = async (cmd, list) => {
          const before = new Set(await ids(list));
          await inv('manager', cmd);
          return (await ids(list)).find((x) => !before.has(x));
        };
        const open = (id) => Boolean(document.querySelector(`.win[data-label="note-${id}"]`));
        const a = await newOne('new_note', 'list_notes');
        const b = await newOne('new_note', 'list_notes');
        const gid = await newOne('new_group', 'list_groups');
        for (const id of [a, b]) {
          await inv(`note-${id}`, 'rename', { name: id });
          await inv(`note-${id}`, 'set_note_group', { groupId: gid });
        }
        await inv(`note-${b}`, 'set_pinned', { pinned: true });
        await inv(`group-${gid}`, 'toggle_group'); // put away
        await wait(300);
        const out = { looseAway: !open(a), pinnedOut: open(b) };
        await inv(`note-${b}`, 'close_window');
        await wait(100);
        await inv('manager', 'open_note', { id: a });
        await wait(300);
        out.onlyPicked = open(a) && !open(b);
        out.groupStillAway = !(await inv('manager', 'list_groups')).find((g) => g.id === gid).open;
        return out;
      });
      assert.equal(res.looseAway, true, 'Putting the group away puts its memories away');
      assert.equal(res.pinnedOut, true, 'A pinned member stays out on screen');
      assert.equal(res.onlyPicked, true, 'Opening a memory from the manager opens only that one');
      assert.equal(res.groupStillAway, true, 'Its group stays put away');
    } finally {
      await webPage.close();
    }
  });

  assert.deepEqual(errors, [], `Unexpected console/page errors: ${errors.join('; ')}`);
  console.log(`\nAll ${passed} UI test suites passed with 0 runtime errors.`);
} finally {
  await browser.close();
  server.close();
}
