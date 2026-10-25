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

      // Trigger an input event in the editor so app.js runs sanitize/toPlain and saves
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

      // 5. Close button (✕) closes (hidden=true) and does NOT trash (trashedAt=null)
      doc.getElementById('closeBtn').click();
      await new Promise((r) => setTimeout(r, 30));
      const { hidden, trashedAt } = window.Memo.notes.ed1;

      return { pinned, title, shownName, color, frameColor, hidden, trashedAt, titlebarTouchAction, gripTouchAction, rsTouchAction, calls };
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
      };
    });

    assert.equal(gRes.initialUntitled, true);
    assert.equal(gRes.name, 'Trabalho');
    assert.equal(gRes.shownName, 'Trabalho');
    assert.equal(gRes.color, 'yellow');
    assert.equal(gRes.frameColor, 'yellow');
    assert.equal(gRes.open, false);
    assert.equal(gRes.pinned, true);
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

      doc.getElementById('moreBtn').click();
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

  // ------------------------------------------------ 7. Web vs Landing page storage isolation
  await step('Web vs Landing page: landing page is ephemeral, web version persists data', async () => {
    const sitePage = await browser.newPage();
    const webPage = await browser.newPage();
    try {
      // 1. Landing page: changes must NOT be saved to localStorage and are lost on reload
      await sitePage.goto(`http://127.0.0.1:${port}/site/index.html`);
      await sitePage.waitForSelector('iframe[name="note-demo-wifi"]');

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
      const webTextAfterReload = await webPage.evaluate((label) => {
        const frame = document.querySelector(`iframe[name="${label}"]`);
        return frame.contentDocument.getElementById('editor').innerText;
      }, webNoteLabel);
      assert.ok(webTextAfterReload.includes('Persisted web note content 12345'), 'Web version note content must be preserved across reload');

      // 3. Re-verify landing page did not receive web version's notes
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

  assert.deepEqual(errors, [], `Unexpected console/page errors: ${errors.join('; ')}`);
  console.log(`\nAll ${passed} UI test suites passed with 0 runtime errors.`);
} finally {
  await browser.close();
  server.close();
}
