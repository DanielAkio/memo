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
          const dt = new DataTransfer();
          card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
          targetCol.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
          targetCol.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
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
    assert.deepEqual(res.names, ['Nome da coluna 5', 'To Do', 'In Progress', 'Done', 'Nome da coluna 4'],
      'Clicking adds a column at that side');
    assert.equal(res.editing, false, 'The new column is just added, its name not opened for editing');
    assert.equal(res.added, 1, 'The "+" creates one memory');
    assert.equal(res.onBoard, false, 'The new memory is not put on the board');
    assert.equal(res.opened, true, 'The new memory opens');
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

      await webPage.evaluate((lbl) => {
        const frame = document.querySelector(`iframe[name="${lbl}"]`);
        frame.contentDocument.getElementById('trashBtn').click();
      }, noteLabel);

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

  assert.deepEqual(errors, [], `Unexpected console/page errors: ${errors.join('; ')}`);
  console.log(`\nAll ${passed} UI test suites passed with 0 runtime errors.`);
} finally {
  await browser.close();
  server.close();
}
