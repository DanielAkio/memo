// Memo Web — browser workspace runtime (window.MemoWeb).
// Hosts the real note, group and manager pages from src/ inside floating
// window frames, pops pinned windows into OS-level Document Picture-in-Picture
// when available, adapts to full-screen single-view on mobile (< 680px),
// stores data in localStorage (+ IndexedDB for pasted images), and syncs with
// Google Drive's appDataFolder using the same format as sync.rs.

(() => {
  // OAuth 2.0 popup callback: send the token hash to the opener and close.
  if (window.opener && location.hash && /(access_token|error)=/.test(location.hash)) {
    try {
      window.opener.postMessage({ type: 'memo-oauth', hash: location.hash }, location.origin);
      window.close();
      return;
    } catch {
      // Fall through if opener is inaccessible.
    }
  }

  const STORAGE_KEY = 'memo.web.data.v1';
  const TOKEN_KEY = 'memo.web.googleToken';
  const IDB_NAME = 'memo-web-db';
  const IDB_IMAGES = 'images';

  const DEFAULT_W = 300;
  const DEFAULT_H = 320;
  const GROUP_W = 300;
  const TITLEBAR_H = 36;
  const TITLEBAR_SNAP = 40;
  const MIN_W = 200;
  const MANAGER_MIN_W = 320;
  const SNAP_GAP = 6;
  const SNAP_DISTANCE = 16;
  const SNAP_EDGE = 6;
  const TRASH_TTL_MS = 30 * 86_400_000;
  const TOMBSTONE_TTL_MS = 90 * 86_400_000;
  const ZOOM_MIN = 0.7;
  const ZOOM_MAX = 1.6;
  const ZOOM_STEP = 0.1;
  const TITLE_MAX = 80;
  const GROUP_NAME_MAX = 60;
  const DEFAULT_TEXT_MAX = 5000;
  const COLORS = ['', 'yellow', 'green', 'coral', 'teal', 'iris', 'lavender', 'mono'];
  const RANDOM_COLORS = ['yellow', 'green', 'coral', 'teal', 'iris'];

  // Welcome note content (matches src-tauri/src/welcome.rs).
  const WELCOME = {
    WIDTH: 380,
    HEIGHT: 680,
    pt: {
      title: 'Boas-vindas ao Memo',
      html: [
        '<div><font size="5"><b>Olá!</b></font></div>',
        '<div>Memórias rápidas que ficam <b>por cima de tudo</b>.</div>',
        '<div><br></div>',
        '<div><b>Básico</b></div>',
        '<div class="check done">Abrir o Memo!</div>',
        '<div class="check">Fixar por cima de tudo: clique na tachinha</div>',
        '<div class="check">Dar um título: clique duplo na barra de cima</div>',
        '<div class="check">Trocar a cor: clique na bolinha ao lado do título</div>',
        '<div class="check">Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)</div>',
        '<div class="check">Ver todos os comandos: botão … ou clique direito na barra</div>',
        '<div><br></div>',
        '<div><b>Organizar</b></div>',
        '<div class="bullet">Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda (o ímã desliga em Configurações)</div>',
        '<div class="bullet">Leve o cursor até a borda da tela para encaixar a memória</div>',
        '<div class="bullet">Encolha pela borda de baixo para deixar só a barra</div>',
        '<div class="bullet">Junte memórias num grupo em "Sem grupo", no rodapé</div>',
        '<div><br></div>',
        '<div><b>Escrever</b></div>',
        '<div class="bullet">Selecione um trecho para <b>negrito</b>, <i>itálico</i>, <u>sublinhado</u>, <span style="background-color: rgb(255, 230, 0)">marca-texto</span> ou <font size="5">tamanho</font></div>',
        '<div class="bullet">Digite <code>[]</code>, <code>-</code> ou <code>1.</code> no começo da linha para criar uma caixa, um marcador como este ou uma lista numerada</div>',
        '<div class="bullet">Sem teclado: a barrinha da seleção, o botão Aa no rodapé e Formatar no menu …</div>',
        '<div class="bullet" data-level="1">Tab recua o item e Shift+Tab volta</div>',
        '<div class="bullet">Crases em volta de um trecho viram <code>código</code>; três crases e Enter abrem um bloco:</div>',
        '<pre class="code" data-lang="sql">select * from memorias where fixada = true</pre>',
        '<div class="bullet">Digite <code>| a | b |</code> e Enter para começar uma tabela</div>',
        '<div class="bullet">Cole imagens e prints com Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho</div>',
        '<div><br></div>',
        '<div><b>Gerenciador do Memo</b></div>',
        '<div>Abre pelo botão do Memo no canto inferior direito. Lá você:</div>',
        '<div class="bullet">busca e ordena memórias e grupos, em cards ou em lista</div>',
        '<div class="bullet">reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)</div>',
        '<div class="bullet">em Configurações, escolhe tema, idioma e o padrão das memórias novas</div>',
        '<div class="bullet">na Ajuda, vê tudo o que o Memo faz</div>',
        '<div><br></div>',
        '<div><font size="2">Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias no app desktop e em outros computadores.</font></div>',
      ].join(''),
      text: [
        'Olá!',
        'Memórias rápidas que ficam por cima de tudo.',
        '',
        'Básico',
        '[x] Abrir o Memo!',
        '[ ] Fixar por cima de tudo: clique na tachinha',
        '[ ] Dar um título: clique duplo na barra de cima',
        '[ ] Trocar a cor: clique na bolinha ao lado do título',
        '[ ] Criar outra memória: botão + ou Ctrl+N (⌘N no Mac)',
        '[ ] Ver todos os comandos: botão … ou clique direito na barra',
        '',
        'Organizar',
        '- Arraste pela barra: perto da borda da tela ou de outra memória, ela gruda (o ímã desliga em Configurações)',
        '- Leve o cursor até a borda da tela para encaixar a memória',
        '- Encolha pela borda de baixo para deixar só a barra',
        '- Junte memórias num grupo em "Sem grupo", no rodapé',
        '',
        'Escrever',
        '- Selecione um trecho para negrito, itálico, sublinhado, marca-texto ou tamanho',
        '- Digite `[]`, `-` ou `1.` no começo da linha para criar uma caixa, um marcador como este ou uma lista numerada',
        '- Sem teclado: a barrinha da seleção, o botão Aa no rodapé e Formatar no menu …',
        '  - Tab recua o item e Shift+Tab volta',
        '- Crases em volta de um trecho viram `código`; três crases e Enter abrem um bloco:',
        '```sql',
        'select * from memorias where fixada = true',
        '```',
        '- Digite `| a | b |` e Enter para começar uma tabela',
        '- Cole imagens e prints com Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho',
        '',
        'Gerenciador do Memo',
        'Abre pelo botão do Memo no canto inferior direito. Lá você:',
        '- busca e ordena memórias e grupos, em cards ou em lista',
        '- reabre o que fechou no ✕ e recupera o que mandou para a lixeira (fica lá por 30 dias)',
        '- em Configurações, escolhe tema, idioma e o padrão das memórias novas',
        '- na Ajuda, vê tudo o que o Memo faz',
        '',
        'Dica: em Configurações, sincronize com o Google Drive para usar as mesmas memórias no app desktop e em outros computadores.',
      ].join('\n'),
    },
    en: {
      title: 'Welcome to Memo',
      html: [
        '<div><font size="5"><b>Hi!</b></font></div>',
        '<div>Quick memories that stay <b>on top of everything</b>.</div>',
        '<div><br></div>',
        '<div><b>Basics</b></div>',
        '<div class="check done">Open Memo!</div>',
        '<div class="check">Keep it on top: click the pin</div>',
        '<div class="check">Give it a title: double-click the top bar</div>',
        '<div class="check">Change the color: click the dot next to the title</div>',
        '<div class="check">Create another memory: the + button or Ctrl+N (⌘N on Mac)</div>',
        '<div class="check">See every command: the … button or a right click on the bar</div>',
        '<div><br></div>',
        '<div><b>Organizing</b></div>',
        '<div class="bullet">Drag it by the bar: near the screen edge or another memory, it sticks (turn the magnet off in Settings)</div>',
        '<div class="bullet">Move the cursor to the screen edge to snap the memory</div>',
        '<div class="bullet">Shrink it from the bottom edge to leave only the bar</div>',
        '<div class="bullet">Put memories in a group from "No group", in the footer</div>',
        '<div><br></div>',
        '<div><b>Writing</b></div>',
        '<div class="bullet">Select some text for <b>bold</b>, <i>italic</i>, <u>underline</u>, <span style="background-color: rgb(255, 230, 0)">highlight</span> or <font size="5">size</font></div>',
        '<div class="bullet">Type <code>[]</code>, <code>-</code> or <code>1.</code> at the start of a line for a box, a bullet like this one or a numbered list</div>',
        '<div class="bullet">No keyboard: the selection bar, the Aa button in the footer and Format in the … menu</div>',
        '<div class="bullet" data-level="1">Tab indents the item and Shift+Tab outdents it</div>',
        '<div class="bullet">Backticks around some text make it <code>code</code>; three backticks and Enter open a block:</div>',
        '<pre class="code" data-lang="sql">select * from memories where pinned = true</pre>',
        '<div class="bullet">Type <code>| a | b |</code> and Enter to start a table</div>',
        '<div class="bullet">Paste images and screenshots with Ctrl+V; click the image and drag its corner to resize it</div>',
        '<div><br></div>',
        '<div><b>Memo Manager</b></div>',
        '<div>Opens from the Memo button in the bottom-right corner. There you can:</div>',
        '<div class="bullet">search and sort memories and groups, as cards or as a list</div>',
        '<div class="bullet">reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)</div>',
        '<div class="bullet">in Settings, choose the theme, language and defaults for new memories</div>',
        '<div class="bullet">in Help, see everything Memo does</div>',
        '<div><br></div>',
        '<div><font size="2">Tip: in Settings, sync with Google Drive to use the same memories in the desktop app and on other computers.</font></div>',
      ].join(''),
      text: [
        'Hi!',
        'Quick memories that stay on top of everything.',
        '',
        'Basics',
        '[x] Open Memo!',
        '[ ] Keep it on top: click the pin',
        '[ ] Give it a title: double-click the top bar',
        '[ ] Change the color: click the dot next to the title',
        '[ ] Create another memory: the + button or Ctrl+N (⌘N on Mac)',
        '[ ] See every command: the … button or a right click on the bar',
        '',
        'Organizing',
        '- Drag it by the bar: near the screen edge or another memory, it sticks (turn the magnet off in Settings)',
        '- Move the cursor to the screen edge to snap the memory',
        '- Shrink it from the bottom edge to leave only the bar',
        '- Put memories in a group from "No group", in the footer',
        '',
        'Writing',
        '- Select some text for bold, italic, underline, highlight or size',
        '- Type `[]`, `-` or `1.` at the start of a line for a box, a bullet like this one or a numbered list',
        '- No keyboard: the selection bar, the Aa button in the footer and Format in the … menu',
        '  - Tab indents the item and Shift+Tab outdents it',
        '- Backticks around some text make it `code`; three backticks and Enter open a block:',
        '```sql',
        'select * from memories where pinned = true',
        '```',
        '- Type `| a | b |` and Enter to start a table',
        '- Paste images and screenshots with Ctrl+V; clique na imagem e arraste o canto para mudar o tamanho',
        '',
        'Memo Manager',
        'Opens from the Memo button in the bottom-right corner. There you can:',
        '- search and sort memories and groups, as cards or as a list',
        '- reopen what you closed with ✕ and restore what you sent to the trash (kept for 30 days)',
        '- in Settings, choose the theme, language and defaults for new memories',
        '- in Help, see everything Memo does',
        '',
        'Tip: in Settings, sync with Google Drive to use the same memories in the desktop app and on other computers.',
      ].join('\n'),
    },
  };

  const TRAY_LABELS = {
    pt: {
      newNote: 'Nova memória',
      newGroup: 'Novo grupo',
      showAll: 'Mostrar todas as memórias',
      manager: 'Gerenciador do Memo',
      trash: 'Lixeira',
      settings: 'Configurações',
      help: 'Ajuda',
      theme: 'Tema',
      layout: 'Visualização do Gerenciador',
      cards: 'Cards',
      list: 'Lista',
      language: 'Idioma',
      system: 'Sistema',
      light: 'Claro',
      dark: 'Escuro',
      magnet: 'Ímã das janelas',
      syncNow: 'Sincronizar agora',
      moreCommands: 'Mais comandos',
    },
    en: {
      newNote: 'New memory',
      newGroup: 'New group',
      showAll: 'Show all memories',
      manager: 'Memo Manager',
      trash: 'Trash',
      settings: 'Settings',
      help: 'Help',
      theme: 'Theme',
      layout: 'Manager view',
      cards: 'Cards',
      list: 'List',
      language: 'Language',
      system: 'System',
      light: 'Light',
      dark: 'Dark',
      magnet: 'Window magnet',
      syncNow: 'Sync now',
      moreCommands: 'More commands',
    },
  };

  const desk = document.getElementById('desk');
  const snapPreview = document.getElementById('snapPreview');
  const contextMenu = document.getElementById('contextMenu');
  const contextSubmenu = document.getElementById('contextSubmenu');
  const trayManagerBtn = document.getElementById('trayManagerBtn');
  const trayNewBtn = document.getElementById('trayNewBtn');
  const trayMenuBtn = document.getElementById('trayMenuBtn');

  let srcBase = '../src';
  const wins = {};
  const listeners = [];
  const restoreSizes = {};
  let pendingManagerView = null;
  let zNormal = 100;
  let zPinned = 10000;
  let activeDrag = null;
  let activeResize = null;
  let focusedLabel = null;
  let activePip = null; // { label, pipWin }

  // ------------------------------------------------------------- helpers

  const nowMs = () => Date.now();
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const idOf = (label) => label.replace(/^(note|group|board)-/, '');
  const isNote = (label) => label.startsWith('note-');
  const isGroup = (label) => label.startsWith('group-');
  const isBoard = (label) => label.startsWith('board-');
  const SCENE = new URLSearchParams(location.search).get('scene') || '';
  const IS_SITE_HOME = document.body.classList.contains('home');
  if (SCENE) document.documentElement.dataset.scene = SCENE;
  const isValidColor = (c) => COLORS.includes(c) || /^#[0-9a-f]{6}$/i.test(c || '');
  const isMobile = () => !SCENE && !IS_SITE_HOME && window.innerWidth < 680;

  function genId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function randomColor(usedList) {
    const counts = {};
    for (const c of RANDOM_COLORS) counts[c] = 0;
    for (const u of usedList) {
      if (u in counts) counts[u]++;
    }
    const min = Math.min(...Object.values(counts));
    const pool = RANDOM_COLORS.filter((c) => counts[c] === min);
    const b = new Uint32Array(1);
    crypto.getRandomValues(b);
    return pool[b[0] % pool.length];
  }

  function plainFromDefault(text) {
    const escaped = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (!text) return '';
    return text.split('\n').map((line) => {
      if (/^\[x\] /i.test(line)) return `<div class="check done">${escaped(line.slice(4)) || '<br>'}</div>`;
      if (/^\[ \] /.test(line)) return `<div class="check">${escaped(line.slice(4)) || '<br>'}</div>`;
      return `<div>${escaped(line) || '<br>'}</div>`;
    }).join('');
  }

  // ------------------------------------------------ IndexedDB image store

  const imageCache = new Map(); // name -> { dataUrl, bytes, mime }
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_IMAGES)) {
            db.createObjectStore(IDB_IMAGES, { keyPath: 'name' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function loadAllImagesFromDb() {
    if (IS_SITE_HOME) return;
    const db = await openDb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_IMAGES, 'readonly');
        const req = tx.objectStore(IDB_IMAGES).getAll();
        req.onsuccess = () => {
          for (const rec of req.result || []) {
            if (rec && rec.name && rec.dataUrl) {
              imageCache.set(rec.name, rec);
            }
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async function saveImageToDb(record) {
    imageCache.set(record.name, record);
    if (IS_SITE_HOME) return;
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction(IDB_IMAGES, 'readwrite');
      tx.objectStore(IDB_IMAGES).put(record);
    } catch {
      // Ignore quota errors; kept in memory for the session.
    }
  }

  const DATA_IMG_RE = /src="data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)"/gi;
  const REF_IMG_RE = /src="images\/([0-9a-f]{32}\.(?:png|jpg|webp|gif))"/g;

  function extForMime(sub) {
    const s = sub.toLowerCase();
    return s === 'jpeg' ? 'jpg' : s;
  }

  function mimeForName(name) {
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg')) return 'image/jpeg';
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.gif')) return 'image/gif';
    return 'application/octet-stream';
  }

  function base64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  async function storeImages(html) {
    if (!html || !html.includes('data:image/')) return html || '';
    const matches = [...html.matchAll(DATA_IMG_RE)];
    if (!matches.length) return html;
    let out = html;
    for (const m of matches) {
      const [full, subtype, b64] = m;
      try {
        const bytes = base64ToBytes(b64);
        const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
        const hex = [...new Uint8Array(hashBuf).slice(0, 16)]
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        const ext = extForMime(subtype);
        const name = `${hex}.${ext}`;
        const mime = mimeForName(name);
        const dataUrl = `data:${mime};base64,${b64.replace(/\s+/g, '')}`;
        await saveImageToDb({ name, dataUrl, mime });
        out = out.replace(full, `src="images/${name}"`);
      } catch {
        // Leave inline if hashing fails.
      }
    }
    return out;
  }

  function inlineImages(html) {
    if (!html || !html.includes('images/')) return html || '';
    return html.replace(REF_IMG_RE, (full, name) => {
      const rec = imageCache.get(name);
      return rec && rec.dataUrl ? `src="${rec.dataUrl}"` : full;
    });
  }

  function imageRefs(html) {
    if (!html) return [];
    const set = new Set();
    for (const m of html.matchAll(REF_IMG_RE)) set.add(m[1]);
    return [...set];
  }

  // ---------------------------------------------------------------- store

  function defaultData() {
    let siteLang = 'system';
    let siteTheme = 'system';
    try {
      const l = localStorage.getItem('memo-lang');
      if (l === 'pt') siteLang = 'pt-BR';
      else if (l === 'en') siteLang = 'en';
      const th = localStorage.getItem('memo-theme');
      if (th === 'light' || th === 'dark') siteTheme = th;
    } catch {}
    return {
      version: 1,
      nextSeq: 1,
      theme: siteTheme,
      language: siteLang,
      zoom: 1,
      magnetOff: false,
      defaultColor: '',
      defaultTitle: '',
      defaultText: '',
      defaultHtml: '',
      defaultGroupColor: 'random',
      defaultGroupTitle: '',
      defaultsUpdatedAt: 0,
      manager: { x: null, y: null, width: 560, height: 480, pinned: false, color: 'iris', layout: 'cards' },
      notes: [],
      groups: [],
      boards: [],
      deleted: [],
      sync: { account: '', pageToken: null, files: {}, deferred: [], lastSync: 0 },
    };
  }

  let data = defaultData();
  let saveTimer = null;

  function normalizeData(d) {
    const base = defaultData();
    const out = Object.assign(base, d || {});
    out.manager = Object.assign(base.manager, (d && d.manager) || {});
    out.sync = Object.assign(base.sync, (d && d.sync) || {});
    out.sync.files = out.sync.files || {};
    out.sync.deferred = Array.isArray(out.sync.deferred) ? out.sync.deferred : [];
    out.notes = Array.isArray(out.notes) ? out.notes : [];
    out.groups = Array.isArray(out.groups) ? out.groups : [];
    out.boards = Array.isArray(out.boards) ? out.boards : [];
    out.deleted = Array.isArray(out.deleted) ? out.deleted : [];
    const activeGids = new Set(out.groups.filter((g) => !g.trashedAt).map((g) => g.id));
    for (const n of out.notes) {
      if (!n.updatedAt) n.updatedAt = n.createdAt || nowMs();
      if (n.groupId && !activeGids.has(n.groupId) && !n.trashedAt) n.groupId = '';
      if (typeof n.width !== 'number' || n.width < MIN_W) n.width = DEFAULT_W;
      if (typeof n.height !== 'number' || n.height < TITLEBAR_H) n.height = DEFAULT_H;
      if (n.trashedAt === undefined) n.trashedAt = null;
      if (!isValidColor(n.color || '')) n.color = '';
    }
    for (const g of out.groups) {
      if (!g.updatedAt) g.updatedAt = g.createdAt || nowMs();
      if (typeof g.width !== 'number' || g.width < MIN_W) g.width = GROUP_W;
      if (g.open === undefined) g.open = true;
      if (g.trashedAt === undefined) g.trashedAt = null;
      if (!isValidColor(g.color || '')) g.color = 'iris';
    }
    for (const b of out.boards) {
      if (!b.updatedAt) b.updatedAt = b.createdAt || nowMs();
      if (typeof b.groupId !== 'string') b.groupId = '';
      if (typeof b.width !== 'number' || b.width < 400) b.width = 760;
      if (typeof b.height !== 'number' || b.height < 300) b.height = 520;
      if (b.trashedAt === undefined) b.trashedAt = null;
      if (!isValidColor(b.color || '')) b.color = '';
      if (!Array.isArray(b.columns)) {
        b.columns = [
          { id: 'c1', name: 'A Fazer', noteIds: [] },
          { id: 'c2', name: 'Em Andamento', noteIds: [] },
          { id: 'c3', name: 'Concluído', noteIds: [] },
        ];
      }
    }
    return out;
  }

  function loadStore() {
    if (IS_SITE_HOME) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) data = normalizeData(JSON.parse(raw));
    } catch (err) {
      console.error('Failed to read localStorage store', err);
    }
    // Clean up any demo notes that may have leaked into web storage from earlier landing page runs
    data.notes = data.notes.filter((n) => !n.demoSeed && !n.id.startsWith('demo-'));
    data.groups = data.groups.filter((g) => !g.demoSeed && !g.id.startsWith('demo-'));
    if (data.notes.length === 0 && data.groups.length === 0) {
      data.nextSeq = 1;
    }
    purgeExpired(nowMs());
  }

  function flushStore() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (IS_SITE_HOME) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('Failed to save store to localStorage', err);
    }
  }

  function markDirty(contentChanged = false) {
    if (IS_SITE_HOME) return;
    if (!saveTimer) saveTimer = setTimeout(flushStore, 400);
    if (contentChanged) scheduleCloudSync();
  }

  window.addEventListener('beforeunload', () => {
    if (!IS_SITE_HOME && saveTimer) flushStore();
  });

  function bury(id, at = nowMs()) {
    data.deleted = data.deleted.filter((t) => t.id !== id);
    data.deleted.push({ id, deletedAt: at });
  }

  function purgeExpired(now) {
    let changed = false;
    data.notes = data.notes.filter((n) => {
      if (n.trashedAt && now - n.trashedAt > TRASH_TTL_MS) {
        bury(n.id, now);
        changed = true;
        return false;
      }
      return true;
    });
    data.groups = data.groups.filter((g) => {
      if (g.trashedAt && now - g.trashedAt > TRASH_TTL_MS) {
        bury(g.id, now);
        changed = true;
        return false;
      }
      return true;
    });
    const beforeTombs = data.deleted.length;
    data.deleted = data.deleted.filter((t) => now - t.deletedAt <= TOMBSTONE_TTL_MS);
    if (data.deleted.length !== beforeTombs) changed = true;
    if (changed) markDirty();
    return changed;
  }

  function effectiveLanguage() {
    if (data.language === 'pt-BR' || data.language === 'pt') return 'pt';
    if (data.language === 'en') return 'en';
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'pt';
    return /^pt\b/i.test(nav) ? 'pt' : 'en';
  }

  function effectiveTheme() {
    return data.theme === 'light' || data.theme === 'dark' ? data.theme : 'system';
  }

  function applyDesktopThemeAndLang() {
    const th = effectiveTheme();
    if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th;
    else delete document.documentElement.dataset.theme;
    const lang = effectiveLanguage();
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    const L = TRAY_LABELS[lang];
    trayManagerBtn.title = L.manager;
    trayNewBtn.title = L.newNote;
    trayNewBtn.setAttribute('aria-label', L.newNote);
    trayMenuBtn.title = L.moreCommands;
    trayMenuBtn.setAttribute('aria-label', L.moreCommands);
  }

  function findNote(id) {
    return data.notes.find((n) => n.id === id) || null;
  }

  function findGroup(id) {
    return data.groups.find((g) => g.id === id) || null;
  }

  function activeNotes() {
    return data.notes.filter((n) => !n.trashedAt);
  }

  function activeGroups() {
    return data.groups.filter((g) => !g.trashedAt);
  }

  // Ids of the groups whose members stay off screen: put away or closed
  // (Store::closed_groups).
  const closedGroups = () => new Set(activeGroups().filter((g) => !g.open || g.hidden).map((g) => g.id));

  // On screen at startup: not closed with ✕ and not inside a closed group
  // (Store::visible / visible_boards).
  function visibleNotes() {
    const closed = closedGroups();
    return activeNotes().filter((n) => !n.hidden && (!n.groupId || !closed.has(n.groupId)));
  }
  function visibleBoards() {
    const closed = closedGroups();
    return activeBoards().filter((b) => !b.hidden && (!b.groupId || !closed.has(b.groupId)));
  }

  function isFirstRun() {
    return data.notes.length === 0 && (data.nextSeq || 1) <= 1;
  }

  function isUntouchedWelcome(title, html) {
    return (title === WELCOME.pt.title && html === WELCOME.pt.html)
      || (title === WELCOME.en.title && html === WELCOME.en.html);
  }

  // Whether a board (current or in the trash) holds note `id` in a column.
  const onBoard = (id) => (data.boards || []).some((b) => (b.columns || []).some((c) => (c.noteIds || []).includes(id)));

  // As created, and in no group and on no board (joining one is a change).
  function isPristineNote(n) {
    if (!n || n.groupId || onBoard(n.id)) return false;
    const defTitle = (data.defaultTitle || '').trim();
    const defText = data.defaultText || '';
    const defHtml = data.defaultHtml || plainFromDefault(defText);
    const sameContent = (n.title === '' && n.text === '' && (n.html === '' || n.html === '<div><br></div>'))
      || (n.title === defTitle && n.text === defText && (n.html === defHtml || !defHtml));
    if (!sameContent) return false;
    const dc = data.defaultColor || '';
    return dc === 'random' ? RANDOM_COLORS.includes(n.color) : n.color === dc;
  }

  function isPristineGroup(g) {
    if (!g) return false;
    const members = activeNotes().filter((n) => n.groupId === g.id);
    if (members.length > 0) return false;
    const bMembers = activeBoards().filter((b) => b.groupId === g.id);
    if (bMembers.length > 0) return false;
    const defTitle = (data.defaultGroupTitle || '').trim();
    if (g.name !== '' && g.name !== defTitle) return false;
    const dc = data.defaultGroupColor || 'random';
    return dc === 'random' ? RANDOM_COLORS.includes(g.color) : g.color === dc;
  }

  function noteContentSnapshot(n) {
    return JSON.stringify([n.title, n.text, n.html, n.color, n.groupId, n.trashedAt]);
  }

  function groupContentSnapshot(g) {
    return JSON.stringify([g.name, g.color, g.trashedAt]);
  }

  function updateNote(id, fn) {
    const n = findNote(id);
    if (!n) return null;
    const before = noteContentSnapshot(n);
    fn(n);
    const changed = noteContentSnapshot(n) !== before;
    if (changed) {
      n.updatedAt = nowMs();
      n.demoSeed = false;
    }
    markDirty(changed);
    return n;
  }

  function updateGroup(id, fn) {
    const g = findGroup(id);
    if (!g) return null;
    const before = groupContentSnapshot(g);
    fn(g);
    const changed = groupContentSnapshot(g) !== before;
    if (changed) {
      g.updatedAt = nowMs();
      g.demoSeed = false;
    }
    markDirty(changed);
    return g;
  }

  function newNoteColor() {
    const dc = data.defaultColor || '';
    if (dc === 'random') return randomColor(activeNotes().map((n) => n.color));
    return isValidColor(dc) ? dc : '';
  }

  function newGroupColor() {
    const dc = data.defaultGroupColor || 'random';
    if (dc === 'random') return randomColor(activeGroups().map((g) => g.color));
    return isValidColor(dc) ? dc : 'iris';
  }

  // ---------------------------------------------------------------- events

  function listen(ev, cb, winObj) {
    const entry = { ev, cb, w: winObj };
    listeners.push(entry);
    return () => {
      const idx = listeners.indexOf(entry);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  function emit(ev, payload = null) {
    for (const l of listeners.slice()) {
      if (l.ev !== ev) continue;
      try {
        if (!l.w || l.w.closed || !l.w.document) continue;
        l.cb({ payload });
      } catch {
        // Ignore frames that were removed.
      }
    }
  }

  function emitToWindow(label, ev, payload = null) {
    const w = wins[label];
    if (!w) return;
    for (const l of listeners.slice()) {
      if (l.ev !== ev || l.w !== w.f.contentWindow) continue;
      try {
        l.cb({ payload });
      } catch {}
    }
  }

  function notifyNotes() {
    emit('notes-changed');
  }

  function notifyGroups() {
    emit('groups-changed');
  }

  // ------------------------------------------------ window geometry & snap

  function workArea() {
    if (IS_SITE_HOME) {
      const docEl = document.documentElement;
      return {
        left: SNAP_GAP,
        top: SNAP_GAP,
        right: Math.max(360, (docEl.clientWidth || window.innerWidth) - SNAP_GAP),
        bottom: Math.max(1200, (docEl.scrollHeight || window.innerHeight) - SNAP_GAP),
      };
    }
    return {
      left: SNAP_GAP,
      top: SNAP_GAP,
      right: Math.max(360, window.innerWidth - SNAP_GAP),
      bottom: Math.max(260, window.innerHeight - SNAP_GAP),
    };
  }

  function clampToWorkArea(x, y, w, h) {
    const wa = workArea();
    const cw = Math.min(w, wa.right - wa.left);
    const ch = Math.min(h, wa.bottom - wa.top);
    const cx = Math.max(wa.left, Math.min(x, wa.right - cw));
    const cy = Math.max(wa.top, Math.min(y, wa.bottom - TITLEBAR_H));
    return { x: Math.round(cx), y: Math.round(cy), w: Math.round(cw), h: Math.round(ch) };
  }

  // Finds a position beside `parentLabel` (right side first, else left, then cascades).
  function beside(parentLabel, w = DEFAULT_W, h = DEFAULT_H) {
    const wa = workArea();
    const p = parentLabel && wins[parentLabel] ? wins[parentLabel] : null;
    let x;
    let y;
    if (p) {
      const rightX = p.x + p.w + SNAP_GAP;
      const leftX = p.x - w - SNAP_GAP;
      if (rightX + w <= wa.right) x = rightX;
      else if (leftX >= wa.left) x = leftX;
      else x = Math.max(wa.left, Math.min(p.x + 28, wa.right - w));
      y = Math.max(wa.top, Math.min(p.y, wa.bottom - h));
    } else {
      x = Math.max(wa.left, Math.round((wa.right - w) / 2));
      y = Math.max(wa.top, Math.round((wa.bottom - h) / 3));
    }

    const step = TITLEBAR_H + 8;
    const occupied = (tx, ty) => Object.values(wins).some((o) => Math.abs(o.x - tx) < 12 && Math.abs(o.y - ty) < 12);
    let tries = 0;
    while (occupied(x, y) && tries < 14) {
      y += step;
      if (y + h > wa.bottom) {
        y = wa.top + ((tries + 1) * 16) % Math.max(40, wa.bottom - h - wa.top);
        x = Math.min(wa.right - w, x + 24);
      }
      tries++;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function collectSnapTargets(excludeLabel) {
    if (data.magnetOff) return [];
    const out = [];
    for (const [label, w] of Object.entries(wins)) {
      if (label === excludeLabel || w.el.classList.contains('in-pip')) continue;
      out.push({ left: w.x, top: w.y, right: w.x + w.w, bottom: w.y + w.h });
    }
    return out;
  }

  function nearestSnap(val, candidates) {
    let best = val;
    let bestDist = SNAP_DISTANCE + 1;
    for (const c of candidates) {
      const d = Math.abs(val - c);
      if (d <= SNAP_DISTANCE && d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    return best;
  }

  function snappedPosition(label, x, y, w, h) {
    if (data.magnetOff) return { x: Math.round(x), y: Math.round(y) };
    const wa = workArea();
    const xs = [wa.left, wa.right - w];
    const ys = [wa.top, wa.bottom - h];
    const others = collectSnapTargets(label);
    for (const o of others) {
      const overlapY = y < o.bottom + SNAP_DISTANCE && y + h > o.top - SNAP_DISTANCE;
      const overlapX = x < o.right + SNAP_DISTANCE && x + w > o.left - SNAP_DISTANCE;
      if (overlapY) {
        xs.push(o.right + SNAP_GAP, o.left - w - SNAP_GAP, o.left, o.right - w);
      }
      if (overlapX) {
        ys.push(o.bottom + SNAP_GAP, o.top - h - SNAP_GAP, o.top, o.bottom - h);
      }
    }
    return {
      x: Math.round(nearestSnap(x, xs)),
      y: Math.round(nearestSnap(y, ys)),
    };
  }

  function snapZoneForCursor(label, px, py) {
    if (isGroup(label)) return null;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const wa = workArea();
    const fullW = wa.right - wa.left;
    const fullH = wa.bottom - wa.top;
    const halfW = Math.round((fullW - SNAP_GAP) / 2);
    const halfH = Math.round((fullH - SNAP_GAP) / 2);
    const rightX = wa.left + fullW - halfW;
    const bottomY = wa.top + fullH - halfH;

    const nearLeft = px <= SNAP_EDGE;
    const nearRight = px >= W - SNAP_EDGE;
    const nearTop = py <= SNAP_EDGE;
    const nearBottom = py >= H - SNAP_EDGE;

    if (nearLeft) {
      if (py < H * 0.2) return { x: wa.left, y: wa.top, w: halfW, h: halfH };
      if (py > H * 0.8) return { x: wa.left, y: bottomY, w: halfW, h: halfH };
      return { x: wa.left, y: wa.top, w: halfW, h: fullH };
    }
    if (nearRight) {
      if (py < H * 0.2) return { x: rightX, y: wa.top, w: halfW, h: halfH };
      if (py > H * 0.8) return { x: rightX, y: bottomY, w: halfW, h: halfH };
      return { x: rightX, y: wa.top, w: halfW, h: fullH };
    }
    if (nearTop) {
      if (px < W * 0.1) return { x: wa.left, y: wa.top, w: halfW, h: halfH };
      if (px > W * 0.9) return { x: rightX, y: wa.top, w: halfW, h: halfH };
      return { x: wa.left, y: wa.top, w: fullW, h: fullH };
    }
    if (nearBottom) {
      if (px < W * 0.2) return { x: wa.left, y: bottomY, w: halfW, h: halfH };
      if (px > W * 0.8) return { x: rightX, y: bottomY, w: halfW, h: halfH };
    }
    return null;
  }

  function showSnapPreview(zone) {
    if (!zone) {
      snapPreview.hidden = true;
      return;
    }
    snapPreview.style.left = `${zone.x}px`;
    snapPreview.style.top = `${zone.y}px`;
    snapPreview.style.width = `${zone.w}px`;
    snapPreview.style.height = `${zone.h}px`;
    snapPreview.hidden = false;
  }

  function groupUnderCursor(px, py, sourceLabel = null) {
    const srcWin = sourceLabel ? wins[sourceLabel] : null;
    const srcPinned = !!(IS_SITE_HOME && srcWin && srcWin.pinned);
    const docX = srcPinned ? px + window.scrollX : px;
    const docY = srcPinned ? py + window.scrollY : py;
    for (const [label, w] of Object.entries(wins)) {
      if (!isGroup(label)) continue;
      const gx = IS_SITE_HOME && w.pinned ? w.x + window.scrollX : w.x;
      const gy = IS_SITE_HOME && w.pinned ? w.y + window.scrollY : w.y;
      if (docX >= gx && docX <= gx + w.w && docY >= gy && docY <= gy + w.h) {
        return idOf(label);
      }
    }
    return null;
  }

  const boardDropZones = {};

  function boardColumnUnderCursor(px, py, sourceLabel = null) {
    const srcWin = sourceLabel ? wins[sourceLabel] : null;
    const srcPinned = !!(IS_SITE_HOME && srcWin && srcWin.pinned);
    const docX = srcPinned ? px + window.scrollX : px;
    const docY = srcPinned ? py + window.scrollY : py;
    for (const [bid, zones] of Object.entries(boardDropZones)) {
      const w = wins[`board-${bid}`];
      if (!w || w.el.classList.contains('in-pip')) continue;
      const bx = IS_SITE_HOME && w.pinned ? w.x + window.scrollX : w.x;
      const by = IS_SITE_HOME && w.pinned ? w.y + window.scrollY : w.y;
      if (docX >= bx && docX <= bx + w.w && docY >= by && docY <= by + w.h) {
        const relX = docX - bx;
        const relY = docY - by;
        for (const col of zones) {
          if (relX >= col.left && relX < col.right && relY >= col.top && relY < col.bottom) {
            return { bid, cid: col.id };
          }
        }
      }
    }
    return null;
  }

  // ------------------------------------------- Document Picture-in-Picture

  function unpinFromPip(label) {
    const id = idOf(label);
    const target = isNote(label) ? findNote(id) : isGroup(label) ? findGroup(id) : isBoard(label) ? findBoard(id) : data.manager;
    if (target) target.pinned = false;
    const cur = wins[label];
    if (cur) {
      const wasPinned = !!cur.pinned;
      cur.pinned = false;
      cur.el.classList.remove('pinned');
      cur.el.style.zIndex = String(++zNormal);
      if (IS_SITE_HOME && wasPinned) {
        setWinRect(label, cur.x + window.scrollX, cur.y + window.scrollY, cur.w, cur.h, false);
      }
      if (cur.el && cur.f.parentElement !== cur.el) {
        cur.el.classList.remove('in-pip');
        cur.el.appendChild(cur.f);
      }
      try {
        const pinBtn = cur.f.contentDocument?.getElementById('pinBtn');
        if (pinBtn) pinBtn.setAttribute('aria-pressed', 'false');
      } catch {}
    }
    markDirty(false);
    emit('store-replaced');
    notifyGroups();
    notifyNotes();
  }

  async function openPipForWindow(label) {
    if (isMobile() || !('documentPictureInPicture' in window)) return false;
    const w = wins[label];
    if (!w) return false;
    try {
      if (activePip && activePip.label !== label) {
        const prevLabel = activePip.label;
        closePipForWindow(prevLabel, true);
        unpinFromPip(prevLabel);
      }
      const pipWin = await window.documentPictureInPicture.requestWindow({
        width: Math.max(240, w.w),
        height: Math.max(60, w.h),
      });
      pipWin.MemoWeb = window.MemoWeb;
      const doc = pipWin.document;
      doc.title = 'Memo';
      Object.assign(doc.documentElement.style, { margin: '0', width: '100%', height: '100%', overflow: 'hidden', background: '#0f1011' });
      Object.assign(doc.body.style, { margin: '0', width: '100%', height: '100%', overflow: 'hidden', background: '#0f1011' });

      w.el.classList.add('in-pip');
      doc.body.appendChild(w.f);
      Object.assign(w.f.style, { width: '100%', height: '100%', border: '0', display: 'block' });
      activePip = { label, pipWin };

      pipWin.addEventListener('pagehide', () => {
        const wasActive = activePip && activePip.label === label;
        if (wasActive) {
          activePip = null;
          unpinFromPip(label);
        } else {
          const cur = wins[label];
          if (cur && cur.el && cur.f.parentElement !== cur.el) {
            cur.el.classList.remove('in-pip');
            cur.el.appendChild(cur.f);
          }
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  function closePipForWindow(label, closeOsWin = true) {
    if (!activePip || activePip.label !== label) return;
    const { pipWin } = activePip;
    activePip = null;
    const w = wins[label];
    if (w && w.el && w.f.parentElement !== w.el) {
      w.el.classList.remove('in-pip');
      w.el.appendChild(w.f);
    }
    if (closeOsWin) {
      try { pipWin.close(); } catch {}
    }
  }

  // --------------------------------------------------------------- windows

  function applyZoomToFrame(f) {
    try {
      const doc = f.contentDocument;
      if (!doc || !doc.documentElement) return;
      doc.documentElement.style.zoom = String(data.zoom || 1);
      for (const sub of doc.querySelectorAll('iframe')) {
        if (sub.contentDocument && sub.contentDocument.documentElement) {
          sub.contentDocument.documentElement.style.zoom = String(data.zoom || 1);
        }
      }
    } catch {}
  }

  function raiseWindow(label) {
    const w = wins[label];
    if (!w) return;
    focusedLabel = label;
    w.el.style.zIndex = String(w.pinned ? ++zPinned : ++zNormal);
    for (const [k, other] of Object.entries(wins)) {
      try {
        const frameEl = other.f.contentDocument?.getElementById('frame');
        if (frameEl) frameEl.classList.toggle('is-focused', k === label);
      } catch {}
    }
  }

  function setWinRect(label, x, y, w, h, persist = true) {
    const win = wins[label];
    if (!win) return;
    win.x = Math.round(x);
    win.y = Math.round(y);
    win.w = Math.round(w);
    win.h = Math.round(h);
    Object.assign(win.el.style, {
      left: `${win.x}px`,
      top: `${win.y}px`,
      width: `${win.w}px`,
      height: `${win.h}px`,
    });
    if (!persist) return;
    const z = data.zoom || 1;
    if (isNote(label)) {
      const n = findNote(idOf(label));
      if (n) {
        n.x = win.x;
        n.y = win.y;
        n.width = Math.round(win.w / z);
        n.height = Math.round(win.h / z);
        markDirty(false);
      }
    } else if (isGroup(label)) {
      const g = findGroup(idOf(label));
      if (g) {
        g.x = win.x;
        g.y = win.y;
        g.width = Math.round(win.w / z);
        markDirty(false);
      }
    } else if (label === 'manager') {
      data.manager.x = win.x;
      data.manager.y = win.y;
      data.manager.width = Math.round(win.w / z);
      data.manager.height = Math.round(win.h / z);
      markDirty(false);
    }
  }

  function openWindow(label, page, { x, y, w, h, pinned = false, autofocus = !IS_SITE_HOME }) {
    if (wins[label]) {
      raiseWindow(label);
      return Promise.resolve(wins[label]);
    }
    const clamped = clampToWorkArea(x, y, w, h);
    const kindClass = isNote(label) ? 'is-note' : isGroup(label) ? 'is-group' : 'is-manager';
    const el = document.createElement('div');
    el.className = `win ${kindClass}${pinned ? ' pinned' : ''}`;
    el.dataset.label = label;
    const z = pinned ? ++zPinned : ++zNormal;
    Object.assign(el.style, {
      left: `${clamped.x}px`,
      top: `${clamped.y}px`,
      width: `${clamped.w}px`,
      height: `${clamped.h}px`,
      zIndex: String(z),
    });

    const f = document.createElement('iframe');
    f.name = label;
    const query = new URLSearchParams();
    query.set('label', label);
    if (!autofocus) query.set('nofocus', '1');
    const sep = page.includes('?') ? '&' : '?';
    f.src = `${srcBase}/${page}${sep}${query.toString()}`;
    el.appendChild(f);
    desk.appendChild(el);

    const winObj = { label, el, f, x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h, pinned: !!pinned };
    wins[label] = winObj;
    focusedLabel = label;

    if (isMobile() && isNote(label)) {
      try {
        if (!history.state || history.state.memoNote !== label) {
          history.pushState({ memoNote: label }, '');
        }
      } catch {}
    }

    return new Promise((resolve) => {
      f.addEventListener('load', () => {
        applyZoomToFrame(f);
        if (label === 'manager') {
          try {
            f.contentDocument.documentElement.classList.toggle('is-mobile', isMobile());
            f.contentWindow.dispatchEvent(new Event('memo-mobile-changed'));
          } catch {}
        }
        try {
          f.contentWindow.addEventListener('pointerdown', () => {
            closeContextMenu();
            raiseWindow(label);
          }, true);
          const sub = f.contentDocument.getElementById('defaultTextFrame');
          if (sub) {
            sub.addEventListener('load', () => applyZoomToFrame(f));
          }
        } catch {}
        raiseWindow(label);
        resolve(winObj);
      });
    });
  }

  function closeWindow(label) {
    if (label === 'manager' && isMobile()) return;
    closePipForWindow(label, true);
    const w = wins[label];
    if (!w) return;
    w.el.remove();
    delete wins[label];
    delete restoreSizes[label];
    if (focusedLabel === label) {
      const remaining = Object.keys(wins);
      focusedLabel = remaining.length ? remaining[remaining.length - 1] : null;
    }
    if (isMobile() && !wins.manager) {
      openManagerWindow();
    }
  }

  window.addEventListener('popstate', () => {
    if (!isMobile()) return;
    const openNoteLabels = Object.keys(wins).filter(isNote);
    if (openNoteLabels.length) {
      const topNote = openNoteLabels[openNoteLabels.length - 1];
      closeNoteById(idOf(topNote));
      openManagerWindow();
    }
  });

  function openNoteWindow(n, autofocus = !IS_SITE_HOME) {
    const z = data.zoom || 1;
    const w = Math.round((n.width || DEFAULT_W) * z);
    const h = Math.round((n.height || DEFAULT_H) * z);
    let pos = { x: n.x, y: n.y };
    if (pos.x == null || pos.y == null) {
      pos = beside('manager', w, h);
      n.x = pos.x;
      n.y = pos.y;
      markDirty(false);
    }
    return openWindow(`note-${n.id}`, 'index.html', { x: pos.x, y: pos.y, w, h, pinned: !!n.pinned, autofocus });
  }

  function openGroupWindow(g, autofocus = !IS_SITE_HOME) {
    const z = data.zoom || 1;
    const w = Math.round((g.width || GROUP_W) * z);
    const h = Math.round(TITLEBAR_H * z);
    let pos = { x: g.x, y: g.y };
    if (pos.x == null || pos.y == null) {
      pos = beside('manager', w, h);
      g.x = pos.x;
      g.y = pos.y;
      markDirty(false);
    }
    return openWindow(`group-${g.id}`, 'group.html', { x: pos.x, y: pos.y, w, h, pinned: !!g.pinned, autofocus });
  }

  // The web app centres the manager; the landing page never does: it has a
  // slot beside the text (#anchorManager, computeSiteHomePositions), so it
  // never covers the page's text.
  function openManagerWindow(targetView = null, autofocus = !IS_SITE_HOME, center = !IS_SITE_HOME) {
    if (targetView) pendingManagerView = targetView;
    const z = data.zoom || 1;
    const m = data.manager;
    const w = Math.round((m.width || 560) * z);
    const h = Math.round((m.height || 480) * z);
    const wa = workArea();
    const placed = !center && m.x != null && m.y != null;
    const cx = placed ? m.x : Math.max(wa.left, Math.round(wa.left + (wa.right - wa.left - w) / 2));
    const cy = placed ? m.y : Math.max(wa.top, Math.round(wa.top + (wa.bottom - wa.top - h) / 2));

    if (wins.manager) {
      if (center) {
        setWinRect('manager', cx, cy, wins.manager.w, wins.manager.h);
        m.x = cx;
        m.y = cy;
        markDirty(false);
      }
      raiseWindow('manager');
      if (pendingManagerView) {
        const v = pendingManagerView;
        pendingManagerView = null;
        emitToWindow('manager', 'manager-view', v);
      }
      return Promise.resolve(wins.manager);
    }
    m.x = cx;
    m.y = cy;
    return openWindow('manager', 'manager.html', { x: cx, y: cy, w, h, pinned: !!m.pinned, autofocus });
  }


  function createNote({ parentLabel = null, groupId = '' } = {}) {
    const z = data.zoom || 1;
    const w = Math.round(DEFAULT_W * z);
    const h = Math.round(DEFAULT_H * z);
    const pos = beside(parentLabel, w, h);
    const now = nowMs();
    const defText = data.defaultText || '';
    const defHtml = data.defaultHtml || plainFromDefault(defText);
    const note = {
      id: genId(),
      seq: data.nextSeq++,
      title: (data.defaultTitle || '').trim(),
      text: defText,
      html: defHtml,
      x: pos.x,
      y: pos.y,
      width: DEFAULT_W,
      height: DEFAULT_H,
      pinned: false,
      color: newNoteColor(),
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      welcomeCopy: false,
      groupId: groupId || '',
      hidden: false,
    };
    data.notes.push(note);
    markDirty(true);
    openNoteWindow(note, true);
    notifyNotes();
    if (groupId) notifyGroups();
    return note;
  }

  function openWelcomeNote(parentLabel = 'manager', isCopy = true, openWin = true) {
    for (const n of activeNotes()) {
      if (!n.hidden && isUntouchedWelcome(n.title, n.html)) {
        if (openWin) {
          openNoteWindow(n);
          raiseWindow(`note-${n.id}`);
        }
        return n;
      }
    }
    const lang = effectiveLanguage();
    const wData = WELCOME[lang] || WELCOME.pt;
    const z = data.zoom || 1;
    const pos = beside(parentLabel, Math.round(WELCOME.WIDTH * z), Math.round(Math.min(WELCOME.HEIGHT, window.innerHeight - 40) * z));
    const now = nowMs();
    const note = {
      id: genId(),
      seq: data.nextSeq++,
      title: wData.title,
      text: wData.text,
      html: wData.html,
      x: pos.x,
      y: pos.y,
      width: WELCOME.WIDTH,
      height: Math.min(WELCOME.HEIGHT, Math.max(360, window.innerHeight - 48)),
      pinned: false,
      color: 'iris',
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      welcomeCopy: isCopy,
      groupId: '',
      hidden: !openWin,
    };
    data.notes.push(note);
    markDirty(false);
    if (openWin) openNoteWindow(note);
    notifyNotes();
    return note;
  }

  const BOARD_MIN_W = 400;
  const BOARD_MIN_H = 300;
  const BOARD_DEFAULT_W = 760;
  const BOARD_DEFAULT_H = 520;

  function findBoard(id) {
    return data.boards.find((b) => b.id === id);
  }

  function activeBoards() {
    return data.boards.filter((b) => !b.trashedAt);
  }

  function notifyBoards() {
    emit('boards-changed');
  }

  function openBoardWindow(b, autofocus = !IS_SITE_HOME) {
    const z = data.zoom || 1;
    const w = Math.round((b.width || BOARD_DEFAULT_W) * z);
    const h = Math.round((b.height || BOARD_DEFAULT_H) * z);
    let pos = { x: b.x, y: b.y };
    if (pos.x == null || pos.y == null) {
      pos = beside('manager', w, h);
      b.x = pos.x;
      b.y = pos.y;
      markDirty(false);
    }
    return openWindow(`board-${b.id}`, 'board.html', { x: pos.x, y: pos.y, w, h, pinned: !!b.pinned, autofocus });
  }

  function createBoard(parentLabel = 'manager') {
    const z = data.zoom || 1;
    const pos = beside(parentLabel, Math.round(BOARD_DEFAULT_W * z), Math.round(BOARD_DEFAULT_H * z));
    const now = nowMs();
    const lang = effectiveLanguage();
    const defaultCols = lang === 'en'
      ? ['To Do', 'In Progress', 'Done']
      : ['A Fazer', 'Em Andamento', 'Concluído'];
    const columns = defaultCols.map((name) => ({
      id: genId(),
      name,
      noteIds: [],
    }));
    const board = {
      id: genId(),
      name: '',
      color: '',
      groupId: '',
      x: pos.x,
      y: pos.y,
      width: BOARD_DEFAULT_W,
      height: BOARD_DEFAULT_H,
      pinned: false,
      hidden: false,
      trashedAt: null,
      createdAt: now,
      updatedAt: now,
      columns,
    };
    data.boards.push(board);
    markDirty(true);
    openBoardWindow(board);
    notifyBoards();
    return board;
  }

  function updateBoard(id, fn) {
    const b = findBoard(id);
    if (!b) return null;
    fn(b);
    b.updatedAt = nowMs();
    markDirty(true);
    return b;
  }

  function trashBoardById(id) {
    const b = findBoard(id);
    if (!b) return;
    closeWindow(`board-${id}`);
    updateBoard(id, (x) => { x.trashedAt = nowMs(); });
    notifyBoards();
  }

  function restoreBoardById(id) {
    const b = findBoard(id);
    if (!b) return;
    updateBoard(id, (x) => { x.trashedAt = null; });
    notifyBoards();
  }

  function deleteBoardForever(id) {
    closeWindow(`board-${id}`);
    data.boards = data.boards.filter((b) => b.id !== id);
    bury(id);
    markDirty(true);
    notifyBoards();
  }

  function createGroup(parentLabel = 'manager') {
    const z = data.zoom || 1;
    const pos = beside(parentLabel, Math.round(GROUP_W * z), Math.round(TITLEBAR_H * z));
    const now = nowMs();
    const group = {
      id: genId(),
      name: (data.defaultGroupTitle || '').trim(),
      x: pos.x,
      y: pos.y,
      width: GROUP_W,
      open: true,
      pinned: false,
      color: newGroupColor(),
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      hidden: false,
    };
    data.groups.push(group);
    markDirty(true);
    openGroupWindow(group);
    notifyGroups();
    return group;
  }

  // As trash() on the desktop: a note nobody touched and a welcome copy are
  // deleted outright; anything else (even blank, in a group or on a board)
  // goes to the trash.
  function trashNoteById(id) {
    const n = findNote(id);
    if (!n) return;
    closeWindow(`note-${id}`);
    if (n.welcomeCopy || isPristineNote(n)) {
      data.notes = data.notes.filter((x) => x.id !== id);
      markDirty(false);
    } else {
      updateNote(id, (x) => {
        x.trashedAt = nowMs();
      });
    }
    notifyNotes();
    if (n.groupId) notifyGroups();
  }

  function closeNoteById(id) {
    const n = findNote(id);
    if (!n) return;
    if (n.welcomeCopy || isPristineNote(n)) {
      trashNoteById(id);
      return;
    }
    n.hidden = true;
    closeWindow(`note-${id}`);
    markDirty(false);
    notifyNotes();
  }

  async function takeOutGroup(g) {
    g.open = true;
    g.hidden = false;
    markDirty(false);
    if (!wins[`group-${g.id}`]) await openGroupWindow(g);
    const barWin = wins[`group-${g.id}`];
    const members = activeNotes().filter((n) => n.groupId === g.id);
    for (const n of members) {
      n.hidden = false;
      const label = `note-${n.id}`;
      if (!wins[label]) {
        const z = data.zoom || 1;
        const w = Math.round((n.width || DEFAULT_W) * z);
        const h = Math.round((n.height || DEFAULT_H) * z);
        const target = n.x != null && n.y != null ? clampToWorkArea(n.x, n.y, w, h) : beside(`group-${g.id}`, w, h);
        n.x = target.x;
        n.y = target.y;
        const startX = barWin ? barWin.x : target.x;
        const startY = barWin ? barWin.y : target.y;
        const winObj = await openWindow(label, 'index.html', { x: startX, y: startY, w: target.w, h: target.h, pinned: !!n.pinned });
        requestAnimationFrame(() => {
          winObj.el.classList.add('sliding');
          setWinRect(label, target.x, target.y, target.w, target.h, false);
          setTimeout(() => winObj.el.classList.remove('sliding'), 170);
        });
      }
    }
    const bMembers = activeBoards().filter((b) => b.groupId === g.id);
    for (const b of bMembers) {
      b.hidden = false;
      const label = `board-${b.id}`;
      if (!wins[label]) {
        const z = data.zoom || 1;
        const w = Math.round((b.width || BOARD_DEFAULT_W) * z);
        const h = Math.round((b.height || BOARD_DEFAULT_H) * z);
        const target = b.x != null && b.y != null ? clampToWorkArea(b.x, b.y, w, h) : beside(`group-${g.id}`, w, h);
        b.x = target.x;
        b.y = target.y;
        const startX = barWin ? barWin.x : target.x;
        const startY = barWin ? barWin.y : target.y;
        const winObj = await openWindow(label, 'board.html', { x: startX, y: startY, w: target.w, h: target.h, pinned: !!b.pinned });
        requestAnimationFrame(() => {
          winObj.el.classList.add('sliding');
          setWinRect(label, target.x, target.y, target.w, target.h, false);
          setTimeout(() => winObj.el.classList.remove('sliding'), 170);
        });
      }
    }
    raiseWindow(`group-${g.id}`);
    notifyGroups();
    notifyNotes();
    notifyBoards();
  }

  function putAwayGroup(g) {
    g.open = false;
    markDirty(false);
    const barWin = wins[`group-${g.id}`];
    const members = activeNotes().filter((n) => n.groupId === g.id);
    for (const n of members) {
      const label = `note-${n.id}`;
      const w = wins[label];
      if (!w) continue;
      if (barWin) {
        w.el.classList.add('sliding');
        w.el.style.left = `${barWin.x}px`;
        w.el.style.top = `${barWin.y}px`;
        w.el.style.opacity = '0';
        setTimeout(() => closeWindow(label), 150);
      } else {
        closeWindow(label);
      }
    }
    const bMembers = activeBoards().filter((b) => b.groupId === g.id);
    for (const b of bMembers) {
      const label = `board-${b.id}`;
      const w = wins[label];
      if (!w) continue;
      if (barWin) {
        w.el.classList.add('sliding');
        w.el.style.left = `${barWin.x}px`;
        w.el.style.top = `${barWin.y}px`;
        w.el.style.opacity = '0';
        setTimeout(() => closeWindow(label), 150);
      } else {
        closeWindow(label);
      }
    }
    notifyGroups();
    notifyNotes();
    notifyBoards();
  }

  function toggleGroupById(gid) {
    const g = findGroup(gid);
    if (!g) return;
    if (g.open) putAwayGroup(g);
    else takeOutGroup(g);
  }

  function raiseGroup(gid) {
    const g = findGroup(gid);
    if (!g) return;
    g.hidden = false;
    if (!wins[`group-${gid}`]) openGroupWindow(g);
    if (g.open) {
      for (const n of activeNotes().filter((x) => x.groupId === gid)) {
        n.hidden = false;
        if (!wins[`note-${n.id}`]) openNoteWindow(n);
        raiseWindow(`note-${n.id}`);
      }
      for (const b of activeBoards().filter((x) => x.groupId === gid)) {
        b.hidden = false;
        if (!wins[`board-${b.id}`]) openBoardWindow(b);
        raiseWindow(`board-${b.id}`);
      }
    }
    raiseWindow(`group-${gid}`);
    markDirty(false);
    notifyGroups();
    notifyNotes();
    notifyBoards();
  }

  function closeGroupById(gid) {
    const g = findGroup(gid);
    if (!g) return;
    if (isPristineGroup(g)) {
      closeWindow(`group-${gid}`);
      data.groups = data.groups.filter((x) => x.id !== gid);
      markDirty(false);
      notifyGroups();
      return;
    }
    g.hidden = true;
    closeWindow(`group-${gid}`);
    for (const n of activeNotes().filter((x) => x.groupId === gid)) {
      closeWindow(`note-${n.id}`);
    }
    for (const b of activeBoards().filter((x) => x.groupId === gid)) {
      closeWindow(`board-${b.id}`);
    }
    markDirty(false);
    notifyGroups();
    notifyNotes();
    notifyBoards();
  }

  function trashGroupById(gid) {
    const g = findGroup(gid);
    if (!g) return;
    closeWindow(`group-${gid}`);
    const members = activeNotes().filter((n) => n.groupId === gid);
    const bMembers = activeBoards().filter((b) => b.groupId === gid);
    if (!g.name.trim() && members.length === 0 && bMembers.length === 0) {
      data.groups = data.groups.filter((x) => x.id !== gid);
      markDirty(false);
      notifyGroups();
      return;
    }
    const t0 = nowMs();
    updateGroup(gid, (x) => { x.trashedAt = t0; });
    for (const n of members) {
      closeWindow(`note-${n.id}`);
      updateNote(n.id, (x) => { x.trashedAt = t0 + 1; });
    }
    for (const b of bMembers) {
      closeWindow(`board-${b.id}`);
      updateBoard(b.id, (x) => { x.trashedAt = t0 + 1; });
    }
    notifyGroups();
    notifyNotes();
    notifyBoards();
  }

  function restoreGroupById(gid) {
    const g = findGroup(gid);
    if (!g || !g.trashedAt) return;
    const t0 = g.trashedAt;
    updateGroup(gid, (x) => {
      x.trashedAt = null;
      x.hidden = false;
    });
    for (const n of data.notes) {
      if (n.groupId === gid && n.trashedAt && n.trashedAt >= t0) {
        updateNote(n.id, (x) => {
          x.trashedAt = null;
          x.hidden = false;
        });
      }
    }
    for (const b of data.boards) {
      if (b.groupId === gid && b.trashedAt && b.trashedAt >= t0) {
        updateBoard(b.id, (x) => {
          x.trashedAt = null;
          x.hidden = false;
        });
      }
    }
    openGroupWindow(g);
    if (g.open) {
      for (const n of activeNotes().filter((x) => x.groupId === gid && !x.hidden)) {
        openNoteWindow(n);
      }
      for (const b of activeBoards().filter((x) => x.groupId === gid && !x.hidden)) {
        openBoardWindow(b);
      }
    }
    notifyGroups();
    notifyNotes();
    notifyBoards();
  }

  function assignBoardGroup(boardId, groupId, parentLabel) {
    const b = findBoard(boardId);
    if (!b) return;
    let targetGid = groupId || '';
    if (targetGid === 'new') {
      const g = createGroup(parentLabel || `board-${boardId}`);
      targetGid = g.id;
    }
    updateBoard(boardId, (x) => {
      x.groupId = targetGid;
    });
    if (targetGid) {
      const g = findGroup(targetGid);
      if (g && !g.open) closeWindow(`board-${boardId}`);
    } else if (!b.hidden && !wins[`board-${boardId}`]) {
      openBoardWindow(b);
    }
    notifyGroups();
    notifyBoards();
  }

  function assignNoteGroup(noteId, groupId, parentLabel) {
    const n = findNote(noteId);
    if (!n) return;
    let targetGid = groupId || '';
    if (targetGid === 'new') {
      const g = createGroup(parentLabel || `note-${noteId}`);
      targetGid = g.id;
    }
    updateNote(noteId, (x) => {
      x.groupId = targetGid;
    });
    if (targetGid) {
      const g = findGroup(targetGid);
      if (g && !g.open) closeWindow(`note-${noteId}`);
    } else if (!n.hidden && !wins[`note-${noteId}`]) {
      openNoteWindow(n);
    }
    notifyGroups();
    notifyNotes();
  }

  function bringNotesToFront() {
    for (const g of activeGroups()) {
      if (!g.hidden && !wins[`group-${g.id}`]) openGroupWindow(g);
    }
    for (const n of visibleNotes()) {
      if (!wins[`note-${n.id}`]) openNoteWindow(n);
      raiseWindow(`note-${n.id}`);
    }
    for (const g of activeGroups()) {
      if (!g.hidden && wins[`group-${g.id}`]) raiseWindow(`group-${g.id}`);
    }
  }

  // ------------------------------------------- drag & resize handlers

  function handleDragStart(label, { cx = 0, cy = 0 } = {}) {
    if (isMobile()) return;
    const w = wins[label];
    if (!w || w.el.classList.contains('in-pip')) return;
    raiseWindow(label);
    const z = data.zoom || 1;
    let grabX = cx * z;
    const grabY = cy * z;
    const px = w.x + grabX;
    const py = w.y + grabY;

    if (restoreSizes[label]) {
      const prev = restoreSizes[label];
      delete restoreSizes[label];
      const rel = Math.max(0.15, Math.min(0.85, grabX / w.w));
      grabX = Math.round(prev.w * rel);
      setWinRect(label, Math.round(px - grabX), w.y, prev.w, prev.h);
    }

    w.userMoved = true;
    w.el.classList.add('active-gesture');
    document.body.classList.add('interacting');
    activeDrag = {
      label,
      grabX,
      grabY,
      startX: w.x,
      startY: w.y,
      hoverGroup: null,
      hoverBoardCol: null,
      snapZone: null,
    };
  }

  function handleDragTo(label, { cx = 0, cy = 0 } = {}) {
    if (!activeDrag || activeDrag.label !== label) return;
    const w = wins[label];
    if (!w) return;
    const z = data.zoom || 1;
    const px = w.x + cx * z;
    const py = w.y + cy * z;
    const rawX = px - activeDrag.grabX;
    const rawY = py - activeDrag.grabY;
    const snapped = snappedPosition(label, rawX, rawY, w.w, w.h);
    setWinRect(label, snapped.x, snapped.y, w.w, w.h);

    if (isNote(label)) {
      const colTarget = boardColumnUnderCursor(px, py, label);
      const colKey = colTarget ? `${colTarget.bid}:${colTarget.cid}` : null;
      const prevKey = activeDrag.hoverBoardCol ? `${activeDrag.hoverBoardCol.bid}:${activeDrag.hoverBoardCol.cid}` : null;
      if (colKey !== prevKey) {
        if (activeDrag.hoverBoardCol) {
          emit('board-drop-hover', [activeDrag.hoverBoardCol.bid, activeDrag.hoverBoardCol.cid, false]);
        }
        activeDrag.hoverBoardCol = colTarget;
        if (colTarget) {
          emit('board-drop-hover', [colTarget.bid, colTarget.cid, true]);
        }
      }
      if (colTarget) {
        if (activeDrag.hoverGroup) {
          emit('drop-hover', [activeDrag.hoverGroup, false]);
          activeDrag.hoverGroup = null;
        }
        activeDrag.snapZone = null;
        showSnapPreview(null);
        return;
      }
    }

    if (isNote(label) || isBoard(label)) {
      if (activeDrag.hoverBoardCol) {
        emit('board-drop-hover', [activeDrag.hoverBoardCol.bid, activeDrag.hoverBoardCol.cid, false]);
        activeDrag.hoverBoardCol = null;
      }
      const overGid = groupUnderCursor(px, py, label);
      if (overGid !== activeDrag.hoverGroup) {
        if (activeDrag.hoverGroup) emit('drop-hover', [activeDrag.hoverGroup, false]);
        activeDrag.hoverGroup = overGid;
        if (overGid) emit('drop-hover', [overGid, true]);
      }
      if (overGid) {
        activeDrag.snapZone = null;
        showSnapPreview(null);
        return;
      }
    }

    const zone = snapZoneForCursor(label, px, py);
    activeDrag.snapZone = zone;
    showSnapPreview(zone);
  }

  function handleDragEnd(label) {
    if (!activeDrag || activeDrag.label !== label) return;
    const d = activeDrag;
    activeDrag = null;
    const w = wins[label];
    if (w) w.el.classList.remove('active-gesture');
    document.body.classList.remove('interacting');
    showSnapPreview(null);

    if (!w) return;
    if (d.hoverBoardCol && isNote(label)) {
      emit('board-drop-hover', [d.hoverBoardCol.bid, d.hoverBoardCol.cid, false]);
      const noteId = idOf(label);
      const b = findBoard(d.hoverBoardCol.bid);
      if (b) {
        updateBoard(b.id, (brd) => {
          for (const col of brd.columns) {
            col.noteIds = (col.noteIds || []).filter((id) => id !== noteId);
          }
          const targetCol = brd.columns.find((c) => c.id === d.hoverBoardCol.cid);
          if (targetCol) {
            if (!targetCol.noteIds) targetCol.noteIds = [];
            targetCol.noteIds.push(noteId);
          }
        });
      }
      updateNote(noteId, (n) => { n.hidden = true; });
      closeWindow(label);
      notifyBoards();
      notifyNotes();
      markDirty(false);
      return;
    }

    if (d.hoverGroup && (isNote(label) || isBoard(label))) {
      emit('drop-hover', [d.hoverGroup, false]);
      const targetId = idOf(label);
      const g = findGroup(d.hoverGroup);
      if (isBoard(label)) {
        updateBoard(targetId, (b) => { b.groupId = d.hoverGroup; });
        if (g && !g.open) {
          const barWin = wins[`group-${g.id}`];
          w.el.classList.add('sliding');
          if (barWin) {
            w.el.style.left = `${barWin.x}px`;
            w.el.style.top = `${barWin.y}px`;
          }
          w.el.style.opacity = '0';
          const b = findBoard(targetId);
          if (b) {
            b.x = d.startX;
            b.y = d.startY;
          }
          setTimeout(() => closeWindow(label), 150);
        } else {
          w.el.classList.add('sliding');
          setWinRect(label, d.startX, d.startY, w.w, w.h);
          setTimeout(() => w.el.classList.remove('sliding'), 170);
        }
        notifyGroups();
        notifyBoards();
        markDirty(false);
        return;
      } else {
        updateNote(targetId, (n) => { n.groupId = d.hoverGroup; });
        if (g && !g.open) {
          const barWin = wins[`group-${g.id}`];
          w.el.classList.add('sliding');
          if (barWin) {
            w.el.style.left = `${barWin.x}px`;
            w.el.style.top = `${barWin.y}px`;
          }
          w.el.style.opacity = '0';
          const n = findNote(targetId);
          if (n) {
            n.x = d.startX;
            n.y = d.startY;
          }
          setTimeout(() => closeWindow(label), 150);
        } else {
          w.el.classList.add('sliding');
          setWinRect(label, d.startX, d.startY, w.w, w.h);
          setTimeout(() => w.el.classList.remove('sliding'), 170);
        }
        notifyGroups();
        notifyNotes();
        markDirty(false);
        return;
      }
    }

    if (d.hoverBoardCol) {
      emit('board-drop-hover', [d.hoverBoardCol.bid, d.hoverBoardCol.cid, false]);
    }
    if (d.hoverGroup) {
      emit('drop-hover', [d.hoverGroup, false]);
    }

    if (d.snapZone) {
      restoreSizes[label] = { w: w.w, h: w.h };
      setWinRect(label, d.snapZone.x, d.snapZone.y, d.snapZone.w, d.snapZone.h);
    }
  }

  function handleResizeStart(label) {
    if (isMobile()) return;
    const w = wins[label];
    if (!w || w.el.classList.contains('in-pip')) return;
    raiseWindow(label);
    delete restoreSizes[label];
    w.userMoved = true;
    w.el.classList.add('active-gesture');
    document.body.classList.add('interacting');
    activeResize = {
      label,
      left: w.x,
      top: w.y,
      right: w.x + w.w,
      bottom: w.y + w.h,
    };
  }

  function handleResizeTo(label, { edges = 'se', cx = 0, cy = 0 } = {}) {
    if (!activeResize || activeResize.label !== label) return;
    const w = wins[label];
    if (!w) return;
    const z = data.zoom || 1;
    const px = w.x + cx * z;
    const py = w.y + cy * z;
    const wa = workArea();
    const minW = Math.round((label === 'manager' ? MANAGER_MIN_W : MIN_W) * z);
    const minH = Math.round(TITLEBAR_H * z);

    let left = w.x;
    let top = w.y;
    let right = w.x + w.w;
    let bottom = w.y + w.h;

    const others = collectSnapTargets(label);
    const snapX = (val) => {
      if (data.magnetOff) return val;
      const cands = [wa.left, wa.right];
      for (const o of others) cands.push(o.left, o.right, o.left - SNAP_GAP, o.right + SNAP_GAP);
      return nearestSnap(val, cands);
    };
    const snapY = (val) => {
      if (data.magnetOff) return val;
      const cands = [wa.top, wa.bottom];
      for (const o of others) cands.push(o.top, o.bottom, o.top - SNAP_GAP, o.bottom + SNAP_GAP);
      return nearestSnap(val, cands);
    };

    if (edges.includes('e')) right = Math.max(left + minW, snapX(px));
    if (edges.includes('w')) left = Math.min(right - minW, snapX(px));
    if (edges.includes('s')) {
      bottom = Math.max(top + minH, snapY(py));
      if (isNote(label) && !data.magnetOff && bottom - top < Math.round((TITLEBAR_H + TITLEBAR_SNAP) * z)) {
        bottom = top + minH;
      }
    }
    if (edges.includes('n')) {
      top = Math.min(bottom - minH, snapY(py));
      if (isNote(label) && !data.magnetOff && bottom - top < Math.round((TITLEBAR_H + TITLEBAR_SNAP) * z)) {
        top = bottom - minH;
      }
    }

    setWinRect(label, left, top, right - left, bottom - top);
  }

  window.addEventListener('pointerup', () => {
    if (activeResize) {
      const w = wins[activeResize.label];
      if (w) w.el.classList.remove('active-gesture');
      activeResize = null;
      document.body.classList.remove('interacting');
    }
  });

  // ------------------------------------------------ popup & tray menus

  const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';
  const ARROW_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>';

  function closeContextMenu() {
    contextMenu.hidden = true;
    contextSubmenu.hidden = true;
    contextMenu.replaceChildren();
    contextSubmenu.replaceChildren();
  }

  function buildAppTrayItems(sourceLabel = null) {
    const lang = effectiveLanguage();
    const L = TRAY_LABELS[lang];
    const th = effectiveTheme();
    const lay = data.manager.layout === 'cards' ? 'cards' : 'list';
    const langSet = data.language || 'system';

    const items = [
      { label: L.newNote, run: () => createNote({ parentLabel: sourceLabel || 'manager' }) },
      { label: L.newGroup, run: () => createGroup(sourceLabel || 'manager') },
      { label: L.showAll, run: () => bringNotesToFront() },
      null,
      { label: L.manager, run: () => openManagerWindow({ view: 'notes', scope: 'current' }) },
      { label: L.trash, run: () => openManagerWindow({ view: 'notes', scope: 'trash' }) },
      { label: L.settings, run: () => openManagerWindow({ view: 'settings' }) },
      { label: L.help, run: () => openManagerWindow({ view: 'help' }) },
      null,
      {
        label: L.theme,
        items: [
          { label: L.system, checked: th === 'system', run: () => setThemeSetting('system') },
          { label: L.light, checked: th === 'light', run: () => setThemeSetting('light') },
          { label: L.dark, checked: th === 'dark', run: () => setThemeSetting('dark') },
        ],
      },
      {
        label: L.layout,
        items: [
          { label: L.cards, checked: lay === 'cards', run: () => setManagerLayout('cards') },
          { label: L.list, checked: lay === 'list', run: () => setManagerLayout('list') },
        ],
      },
      {
        label: L.language,
        items: [
          { label: L.system, checked: langSet === 'system', run: () => setLanguageSetting('system') },
          { label: 'Português', checked: langSet === 'pt-BR', run: () => setLanguageSetting('pt-BR') },
          { label: 'English', checked: langSet === 'en', run: () => setLanguageSetting('en') },
        ],
      },
      {
        label: L.magnet,
        checked: !data.magnetOff,
        run: () => {
          data.magnetOff = !data.magnetOff;
          markDirty(false);
          emit('magnet-changed', !data.magnetOff);
        },
      },
    ];

    if (data.sync && data.sync.account) {
      items.push({ label: L.syncNow, run: () => syncCloudNow() });
    }
    return items;
  }

  function renderMenuRows(container, list, onPick) {
    container.replaceChildren();
    for (const item of list) {
      if (!item) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        container.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-item';
      btn.setAttribute('role', 'menuitem');

      const check = document.createElement('span');
      check.className = 'ctx-check';
      if (item.checked) check.innerHTML = CHECK_SVG;

      const label = document.createElement('span');
      label.className = 'ctx-label';
      label.textContent = item.label;

      btn.append(check, label);

      if (item.items && item.items.length) {
        const arrow = document.createElement('span');
        arrow.className = 'ctx-arrow';
        arrow.innerHTML = ARROW_SVG;
        btn.appendChild(arrow);
        const openSub = () => {
          for (const sibling of container.querySelectorAll('.ctx-item')) {
            sibling.classList.toggle('is-open', sibling === btn);
          }
          renderMenuRows(contextSubmenu, item.items, onPick);
          contextSubmenu.hidden = false;
          const r = btn.getBoundingClientRect();
          const sw = contextSubmenu.offsetWidth || 180;
          const sh = contextSubmenu.offsetHeight || 120;
          const left = r.right + sw + 8 <= window.innerWidth ? r.right + 2 : Math.max(6, r.left - sw - 2);
          const top = Math.min(r.top, Math.max(6, window.innerHeight - sh - 6));
          contextSubmenu.style.left = `${left}px`;
          contextSubmenu.style.top = `${top}px`;
        };
        btn.addEventListener('pointerenter', openSub);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openSub();
        });
      } else {
        btn.addEventListener('pointerenter', () => {
          if (container === contextMenu) {
            contextSubmenu.hidden = true;
            for (const sibling of container.querySelectorAll('.ctx-item')) {
              sibling.classList.remove('is-open');
            }
          }
        });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeContextMenu();
          onPick(item);
        });
      }
      container.appendChild(btn);
    }
  }

  function showPopupMenu(items, x, y, onPick) {
    contextSubmenu.hidden = true;
    renderMenuRows(contextMenu, items, onPick);
    contextMenu.hidden = false;
    const mw = contextMenu.offsetWidth || 210;
    const mh = contextMenu.offsetHeight || 260;
    const left = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - mh - 8));
    contextMenu.style.left = `${left}px`;
    contextMenu.style.top = `${top}px`;
  }

  function openTitlebarMenu(label, ownItems, at) {
    const w = wins[label];
    const z = data.zoom || 1;
    let x = lastPointer.x;
    let y = lastPointer.y;
    if (Array.isArray(at) && at.length === 2 && w) {
      const r = w.el.getBoundingClientRect();
      x = r.left + at[0] * z;
      y = r.top + at[1] * z;
    }
    const mapOwn = (list) => (list || []).map((it) => {
      if (!it) return null;
      if (it.items) return { label: it.label, items: mapOwn(it.items) };
      return {
        label: it.label,
        checked: !!it.checked,
        run: () => emitToWindow(label, 'title-menu', it.id),
      };
    });
    const combined = [
      ...mapOwn(ownItems),
      ...(ownItems && ownItems.length ? [null] : []),
      ...buildAppTrayItems(label),
    ];
    showPopupMenu(combined, x, y, (picked) => {
      if (picked && picked.run) picked.run();
    });
  }

  function updateMobileState() {
    const mobile = isMobile();
    document.documentElement.classList.toggle('is-mobile', mobile);
    if (wins.manager && wins.manager.f) {
      try {
        wins.manager.f.contentDocument.documentElement.classList.toggle('is-mobile', mobile);
        wins.manager.f.contentWindow.dispatchEvent(new Event('memo-mobile-changed'));
      } catch {}
    }
  }
  window.addEventListener('resize', updateMobileState);

  const lastPointer = { x: 240, y: 180 };
  window.addEventListener('pointermove', (e) => {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
  }, true);

  window.addEventListener('pointerdown', (e) => {
    if (!contextMenu.hidden && !contextMenu.contains(e.target) && !contextSubmenu.contains(e.target)) {
      closeContextMenu();
    }
  });

  desk.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPopupMenu(buildAppTrayItems(null), e.clientX, e.clientY, (picked) => {
      if (picked && picked.run) picked.run();
    });
  });

  trayManagerBtn.addEventListener('click', () => {
    closeContextMenu();
    openManagerWindow();
  });
  trayNewBtn.addEventListener('click', () => {
    closeContextMenu();
    createNote({ parentLabel: 'manager' });
  });
  trayMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = trayMenuBtn.getBoundingClientRect();
    showPopupMenu(buildAppTrayItems(null), r.right - 210, r.top - 320, (picked) => {
      if (picked && picked.run) picked.run();
    });
  });
  document.getElementById('trayBar').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showPopupMenu(buildAppTrayItems(null), e.clientX, e.clientY, (picked) => {
      if (picked && picked.run) picked.run();
    });
  });

  // ------------------------------------------------ backup export / import

  function exportNotesFile(fileName) {
    const out = copy(data);
    out.notes = out.notes
      .filter((n) => !n.trashedAt)
      .map((n) => Object.assign({}, n, { html: inlineImages(n.html) }));
    out.groups = out.groups.filter((g) => !g.trashedAt);
    out.defaultHtml = inlineImages(out.defaultHtml);
    delete out.deleted;
    delete out.sync;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'memo-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  }

  function importNotesFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) {
          resolve(null);
          return;
        }
        try {
          const text = await file.text();
          const incoming = normalizeData(JSON.parse(text));
          let count = 0;

          for (const g of incoming.groups) {
            if (g.trashedAt) continue;
            const local = findGroup(g.id);
            if (!local) {
              data.groups.push(g);
              data.deleted = data.deleted.filter((t) => t.id !== g.id);
              if (!g.hidden) openGroupWindow(g);
            } else if ((g.updatedAt || 0) > (local.updatedAt || 0)) {
              Object.assign(local, {
                name: g.name,
                color: g.color,
                trashedAt: null,
                updatedAt: g.updatedAt,
              });
            }
          }

          for (const n of incoming.notes) {
            if (n.trashedAt) continue;
            n.html = await storeImages(n.html || '');
            const local = findNote(n.id);
            if (!local) {
              n.seq = data.nextSeq++;
              data.notes.push(n);
              data.deleted = data.deleted.filter((t) => t.id !== n.id);
              if (!n.hidden) openNoteWindow(n);
              count++;
            } else if ((n.updatedAt || 0) > (local.updatedAt || 0)) {
              Object.assign(local, {
                title: n.title,
                text: n.text,
                html: n.html,
                color: n.color,
                groupId: n.groupId,
                trashedAt: null,
                updatedAt: n.updatedAt,
              });
              if (wins[`note-${local.id}`]) {
                wins[`note-${local.id}`].f.contentWindow.location.reload();
              } else if (!local.hidden) {
                openNoteWindow(local);
              }
              count++;
            }
          }

          markDirty(count > 0);
          notifyGroups();
          notifyNotes();
          resolve(count);
        } catch (err) {
          console.error('import_notes failed', err);
          resolve(0);
        }
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  // ------------------------------------------- theme / language / zoom setters

  function setThemeSetting(theme) {
    data.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
    if (!IS_SITE_HOME) {
      try {
        if (data.theme === 'system') localStorage.removeItem('memo-theme');
        else localStorage.setItem('memo-theme', data.theme);
      } catch {}
    }
    applyDesktopThemeAndLang();
    markDirty(false);
    emit('theme-changed', data.theme);
  }

  function setLanguageSetting(language) {
    data.language = language === 'pt-BR' || language === 'en' ? language : 'system';
    const eff = effectiveLanguage();
    if (!IS_SITE_HOME) {
      try {
        localStorage.setItem('memo-lang', eff);
      } catch {}
    }
    applyDesktopThemeAndLang();
    markDirty(false);
    emit('language-changed', eff);
  }

  function setManagerLayout(layout) {
    data.manager.layout = layout === 'cards' ? 'cards' : 'list';
    markDirty(false);
    emit('layout-changed', data.manager.layout);
  }

  function stepZoom(step) {
    const prev = data.zoom || 1;
    let next = step === 0 ? 1 : Math.round((prev + step * ZOOM_STEP) * 10) / 10;
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    if (next === prev) return next;
    data.zoom = next;
    for (const [label, w] of Object.entries(wins)) {
      applyZoomToFrame(w.f);
      if (isGroup(label)) {
        const g = findGroup(idOf(label));
        const gw = (g ? g.width : GROUP_W) * next;
        setWinRect(label, w.x, w.y, gw, TITLEBAR_H * next, false);
      } else if (isNote(label)) {
        const n = findNote(idOf(label));
        if (n) setWinRect(label, w.x, w.y, n.width * next, n.height * next, false);
      } else if (label === 'manager') {
        setWinRect(label, w.x, w.y, data.manager.width * next, data.manager.height * next, false);
      }
    }
    markDirty(false);
    emit('zoom-changed', next);
    return next;
  }

  // ------------------------------------------------ Google Drive sync

  const DRIVE_API = 'https://www.googleapis.com';
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
  const SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email';
  const SETTINGS_FILE = 'settings.json';
  const IMAGE_PREFIX = 'image-';

  let cloudStatus = { syncing: false, lastSync: 0, pending: 0, error: null };
  let oauthCancel = null;
  let syncTimer = null;

  function googleClientId() {
    if (IS_SITE_HOME) return '';
    const meta = document.querySelector('meta[name="memo-google-client-id"]')?.content?.trim();
    if (meta) return meta;
    if (window.MEMO_GOOGLE_CLIENT_ID) return String(window.MEMO_GOOGLE_CLIENT_ID).trim();
    try {
      return (localStorage.getItem('memo.web.googleClientId') || '').trim();
    } catch {
      return '';
    }
  }

  function loadStoredToken() {
    if (IS_SITE_HOME) return null;
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.accessToken && parsed.expiresAt > nowMs() + 30_000) {
        return parsed.accessToken;
      }
    } catch {}
    return null;
  }

  function saveStoredToken(accessToken, expiresInSec) {
    if (IS_SITE_HOME) return;
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({
        accessToken,
        expiresAt: nowMs() + (Number(expiresInSec) || 3600) * 1000,
      }));
    } catch {}
  }

  function clearStoredToken() {
    if (IS_SITE_HOME) return;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {}
  }

  function updateCloudStatus(patch) {
    Object.assign(cloudStatus, patch);
    cloudStatus.pending = computeUploads().length;
    emit('cloud-changed');
  }

  function connectCloudAccount() {
    if (IS_SITE_HOME) return Promise.reject('unavailable');
    if (oauthCancel) return Promise.reject('busy');
    const clientId = googleClientId();
    if (!clientId) return Promise.reject('unavailable');

    return new Promise((resolve, reject) => {
      const stateBytes = new Uint8Array(16);
      crypto.getRandomValues(stateBytes);
      const state = [...stateBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      const redirectUri = `${location.origin}${location.pathname}`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: SCOPES,
        state,
        include_granted_scopes: 'true',
        prompt: 'select_account',
      });

      const w = 520;
      const h = 620;
      const left = Math.round(window.screenX + (window.outerWidth - w) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - h) / 2);
      const popup = window.open(`${AUTH_URL}?${params}`, 'memo-google-auth', `width=${w},height=${h},left=${left},top=${top}`);
      if (!popup) {
        reject('denied');
        return;
      }

      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(pollClosed);
        clearTimeout(timeoutId);
        oauthCancel = null;
      };

      oauthCancel = () => {
        try { popup.close(); } catch {}
        cleanup();
        reject('cancelled');
      };

      const timeoutId = setTimeout(() => {
        try { popup.close(); } catch {}
        cleanup();
        reject('timeout');
      }, 300_000);

      const pollClosed = setInterval(() => {
        if (popup.closed) {
          cleanup();
          reject('cancelled');
        }
      }, 500);

      async function onMessage(e) {
        if (e.origin !== location.origin || !e.data || e.data.type !== 'memo-oauth') return;
        cleanup();
        const hashParams = new URLSearchParams(String(e.data.hash || '').replace(/^#/, ''));
        if (hashParams.get('state') !== state) {
          reject('denied');
          return;
        }
        const err = hashParams.get('error');
        if (err) {
          reject(err === 'access_denied' ? 'denied' : 'network');
          return;
        }
        const token = hashParams.get('access_token');
        const expiresIn = hashParams.get('expires_in');
        if (!token) {
          reject('denied');
          return;
        }
        saveStoredToken(token, expiresIn);
        try {
          const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error('userinfo');
          const info = await r.json();
          const email = info.email || 'Google Drive';
          if (data.sync.account !== email) {
            data.sync = { account: email, pageToken: null, files: {}, deferred: [], lastSync: 0 };
          }
          markDirty(false);
          cloudStatus.error = null;
          syncCloudNow();
          resolve(email);
        } catch {
          reject('network');
        }
      }

      window.addEventListener('message', onMessage);
    });
  }

  function disconnectCloudAccount() {
    if (IS_SITE_HOME) return;
    clearStoredToken();
    data.sync = { account: '', pageToken: null, files: {}, deferred: [], lastSync: 0 };
    cloudStatus = { syncing: false, lastSync: 0, pending: 0, error: null };
    markDirty(false);
    emit('cloud-changed');
  }

  function noteDocOf(n) {
    return {
      version: 1,
      id: n.id,
      title: n.title || '',
      text: n.text || '',
      html: n.html || '',
      color: n.color || '',
      groupId: n.groupId || '',
      createdAt: n.createdAt || 0,
      updatedAt: n.updatedAt || 0,
      trashedAt: n.trashedAt || null,
      deleted: false,
      deletedAt: 0,
    };
  }

  function groupDocOf(g) {
    return {
      version: 1,
      id: g.id,
      name: g.name || '',
      color: g.color || '',
      createdAt: g.createdAt || 0,
      updatedAt: g.updatedAt || 0,
      trashedAt: g.trashedAt || null,
      deleted: false,
      deletedAt: 0,
    };
  }

  function settingsDocOf() {
    return {
      version: 1,
      defaultColor: data.defaultColor || '',
      defaultTitle: data.defaultTitle || '',
      defaultText: data.defaultText || '',
      defaultHtml: data.defaultHtml || '',
      defaultGroupColor: data.defaultGroupColor || 'random',
      defaultGroupTitle: data.defaultGroupTitle || '',
      updatedAt: data.defaultsUpdatedAt || 0,
    };
  }

  function computeUploads() {
    const st = data.sync || { files: {}, deferred: [] };
    const files = st.files || {};
    const synced = (name) => (files[name] ? files[name].synced : undefined);
    const deferredNames = new Set((st.deferred || []).map((d) => `note-${d.id}.json`));
    const out = [];

    for (const g of data.groups) {
      const name = `group-${g.id}.json`;
      const s = synced(name);
      if (s !== undefined && g.updatedAt <= s) continue;
      if (s === undefined && isPristineGroup(g)) continue;
      out.push({ name, stamp: g.updatedAt, body: JSON.stringify(groupDocOf(g)), images: [] });
    }

    for (const n of data.notes) {
      const name = `note-${n.id}.json`;
      if (deferredNames.has(name)) continue;
      const s = synced(name);
      if (s !== undefined && n.updatedAt <= s) continue;
      if (s === undefined && (n.welcomeCopy || isPristineNote(n) || isUntouchedWelcome(n.title, n.html))) continue;
      out.push({ name, stamp: n.updatedAt, body: JSON.stringify(noteDocOf(n)), images: imageRefs(n.html) });
    }

    for (const tomb of data.deleted) {
      const isGrp = Boolean(files[`group-${tomb.id}.json`]);
      const name = isGrp ? `group-${tomb.id}.json` : `note-${tomb.id}.json`;
      const s = synced(name);
      if (s === undefined || tomb.deletedAt <= s) continue;
      const doc = { version: 1, id: tomb.id, deleted: true, deletedAt: tomb.deletedAt };
      out.push({ name, stamp: tomb.deletedAt, body: JSON.stringify(doc), images: [] });
    }

    if ((data.defaultsUpdatedAt || 0) > 0) {
      const s = synced(SETTINGS_FILE);
      if (s === undefined || data.defaultsUpdatedAt > s) {
        out.push({ name: SETTINGS_FILE, stamp: data.defaultsUpdatedAt, body: JSON.stringify(settingsDocOf()), images: [] });
      }
    }
    return out;
  }

  async function driveFetch(token, path, query = {}) {
    const url = new URL(`${DRIVE_API}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) {
      clearStoredToken();
      throw 'reauth';
    }
    if (!r.ok) throw 'network';
    return r;
  }

  async function driveUpload(token, fileId, name, stamp, contentType, bodyBytes) {
    const meta = { appProperties: { stamp: String(stamp) } };
    if (!fileId) {
      meta.name = name;
      meta.parents = ['appDataFolder'];
    }
    const boundary = `memo-${genId()}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const payload = new Uint8Array(head.length + bodyBytes.length + tail.length);
    payload.set(head, 0);
    payload.set(bodyBytes, head.length);
    payload.set(tail, head.length + bodyBytes.length);

    const send = async (id) => {
      const url = id
        ? `${DRIVE_API}/upload/drive/v3/files/${id}?uploadType=multipart&fields=id`
        : `${DRIVE_API}/upload/drive/v3/files?uploadType=multipart&fields=id`;
      return fetch(url, {
        method: id ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: payload,
      });
    };

    let res = await send(fileId);
    if (fileId && res.status === 404) res = await send(null);
    if (res.status === 401) {
      clearStoredToken();
      throw 'reauth';
    }
    if (!res.ok) throw 'network';
    const created = await res.json();
    return created.id;
  }

  function remoteFileFromMeta(m) {
    if (!m || m.trashed || !(m.name?.endsWith('.json') || m.name?.startsWith(IMAGE_PREFIX))) return null;
    const stamp = Number(m.appProperties && m.appProperties.stamp);
    if (!Number.isFinite(stamp)) return null;
    return { id: m.id, name: m.name, stamp };
  }

  function dedupeRemote(files) {
    const byName = new Map();
    for (const f of files) {
      const kept = byName.get(f.name);
      if (!kept || f.stamp > kept.stamp) byName.set(f.name, f);
    }
    return [...byName.values()];
  }

  async function runCloudSync() {
    if (IS_SITE_HOME || !data.sync || !data.sync.account || cloudStatus.syncing) return;
    const token = loadStoredToken();
    if (!token) {
      updateCloudStatus({ syncing: false, error: 'reauth' });
      return;
    }

    updateCloudStatus({ syncing: true });
    try {
      const st = data.sync;
      st.files = st.files || {};
      let remote = [];
      let nextToken = st.pageToken;

      if (!st.pageToken) {
        const startRes = await (await driveFetch(token, '/drive/v3/changes/startPageToken')).json();
        nextToken = startRes.startPageToken;
        let pageToken = null;
        const all = [];
        do {
          const list = await (await driveFetch(token, '/drive/v3/files', {
            spaces: 'appDataFolder',
            pageSize: 1000,
            fields: 'nextPageToken,files(id,name,appProperties,trashed)',
            pageToken,
          })).json();
          for (const m of list.files || []) {
            const rf = remoteFileFromMeta(m);
            if (rf) all.push(rf);
          }
          pageToken = list.nextPageToken;
        } while (pageToken);
        remote = dedupeRemote(all);
      } else {
        let page = st.pageToken;
        const all = [];
        while (page) {
          const list = await (await driveFetch(token, '/drive/v3/changes', {
            pageToken: page,
            spaces: 'appDataFolder',
            pageSize: 1000,
            fields: 'nextPageToken,newStartPageToken,changes(file(id,name,appProperties,trashed))',
          })).json();
          for (const c of list.changes || []) {
            const rf = remoteFileFromMeta(c.file);
            if (rf) all.push(rf);
          }
          if (list.newStartPageToken) {
            nextToken = list.newStartPageToken;
            break;
          }
          page = list.nextPageToken;
        }
        remote = dedupeRemote(all);
      }

      remote.sort((a, b) => {
        const rank = (n) => (n.startsWith(IMAGE_PREFIX) ? 0 : n.startsWith('group-') ? 1 : 2);
        return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
      });

      let groupsChanged = false;
      let notesChanged = false;

      for (const file of remote) {
        if (file.name.startsWith(IMAGE_PREFIX)) {
          st.files[file.name] = { fileId: file.id, synced: file.stamp };
          continue;
        }
        const known = st.files[file.name]?.synced;
        if (known !== undefined && file.stamp <= known) {
          st.files[file.name] = { fileId: file.id, synced: known };
          continue;
        }
        const bodyText = await (await driveFetch(token, `/drive/v3/files/${file.id}`, { alt: 'media' })).text();
        if (file.name === SETTINGS_FILE) {
          const doc = JSON.parse(bodyText);
          const localStamp = data.defaultsUpdatedAt || 0;
          if (localStamp <= (known || 0) || (doc.updatedAt || 0) >= localStamp) {
            data.defaultColor = doc.defaultColor || '';
            data.defaultTitle = doc.defaultTitle || '';
            data.defaultText = doc.defaultText || '';
            data.defaultHtml = doc.defaultHtml || '';
            data.defaultGroupColor = doc.defaultGroupColor || 'random';
            data.defaultGroupTitle = doc.defaultGroupTitle || '';
            data.defaultsUpdatedAt = doc.updatedAt || 0;
          }
          st.files[file.name] = { fileId: file.id, synced: file.stamp };
        } else if (file.name.startsWith('group-')) {
          const doc = JSON.parse(bodyText);
          const local = findGroup(doc.id);
          const localTomb = data.deleted.find((t) => t.id === doc.id)?.deletedAt || 0;
          const localStamp = (local ? local.updatedAt : localTomb) || 0;
          const docStamp = doc.deleted ? doc.deletedAt : doc.updatedAt;
          if (!(localStamp > (known || 0) && localStamp > docStamp)) {
            if (doc.deleted) {
              closeWindow(`group-${doc.id}`);
              data.groups = data.groups.filter((g) => g.id !== doc.id);
              bury(doc.id, doc.deletedAt || file.stamp);
            } else if (!local) {
              data.deleted = data.deleted.filter((t) => t.id !== doc.id);
              data.groups.push({
                id: doc.id,
                name: doc.name || '',
                x: null,
                y: null,
                width: GROUP_W,
                open: true,
                pinned: false,
                color: isValidColor(doc.color) ? doc.color : 'iris',
                createdAt: doc.createdAt || doc.updatedAt,
                updatedAt: doc.updatedAt,
                trashedAt: doc.trashedAt || null,
                hidden: true,
              });
            } else {
              Object.assign(local, {
                name: doc.name || '',
                color: isValidColor(doc.color) ? doc.color : local.color,
                updatedAt: doc.updatedAt,
                trashedAt: doc.trashedAt || null,
              });
              if (doc.trashedAt) closeWindow(`group-${doc.id}`);
            }
            groupsChanged = true;
          }
          st.files[file.name] = { fileId: file.id, synced: file.stamp };
        } else if (file.name.startsWith('note-')) {
          const doc = JSON.parse(bodyText);
          doc.html = await storeImages(doc.html || '');
          for (const imgName of imageRefs(doc.html)) {
            if (!imageCache.has(imgName) && st.files[`${IMAGE_PREFIX}${imgName}`]) {
              try {
                const imgRes = await driveFetch(token, `/drive/v3/files/${st.files[`${IMAGE_PREFIX}${imgName}`].fileId}`, { alt: 'media' });
                const buf = new Uint8Array(await imgRes.arrayBuffer());
                const mime = mimeForName(imgName);
                const dataUrl = `data:${mime};base64,${bytesToBase64(buf)}`;
                await saveImageToDb({ name: imgName, dataUrl, mime });
              } catch {}
            }
          }
          const local = findNote(doc.id);
          const localTomb = data.deleted.find((t) => t.id === doc.id)?.deletedAt || 0;
          const localStamp = (local ? local.updatedAt : localTomb) || 0;
          const docStamp = doc.deleted ? doc.deletedAt : doc.updatedAt;
          const changedHere = localStamp > (known || 0);
          let apply = true;

          if (changedHere && local && !doc.deleted) {
            const sameText = local.text === doc.text && local.title === doc.title && local.html === doc.html;
            if (!sameText) {
              const suffix = effectiveLanguage() === 'pt' ? 'conflito' : 'conflict';
              const loser = (doc.updatedAt || 0) >= (local.updatedAt || 0) ? local : doc;
              const now = nowMs();
              data.notes.push({
                id: genId(),
                seq: data.nextSeq++,
                title: `${loser.title || (effectiveLanguage() === 'pt' ? 'Sem título' : 'Untitled')} (${suffix})`,
                text: loser.text || '',
                html: loser.html || '',
                x: null,
                y: null,
                width: DEFAULT_W,
                height: DEFAULT_H,
                pinned: false,
                color: loser.color || '',
                createdAt: loser.createdAt || now,
                updatedAt: now,
                trashedAt: now,
                welcomeCopy: false,
                groupId: '',
                hidden: true,
              });
              apply = (doc.updatedAt || 0) >= (local.updatedAt || 0);
              notesChanged = true;
            } else {
              apply = (doc.updatedAt || 0) >= (local.updatedAt || 0);
            }
          } else if (changedHere && local && doc.deleted) {
            apply = false;
          }

          if (apply) {
            if (doc.deleted) {
              closeWindow(`note-${doc.id}`);
              data.notes = data.notes.filter((n) => n.id !== doc.id);
              bury(doc.id, doc.deletedAt || docStamp);
            } else if (!local) {
              data.deleted = data.deleted.filter((t) => t.id !== doc.id);
              data.notes.push({
                id: doc.id,
                seq: data.nextSeq++,
                title: doc.title || '',
                text: doc.text || '',
                html: doc.html || '',
                x: null,
                y: null,
                width: DEFAULT_W,
                height: DEFAULT_H,
                pinned: false,
                color: isValidColor(doc.color) ? doc.color : '',
                createdAt: doc.createdAt || doc.updatedAt,
                updatedAt: doc.updatedAt,
                trashedAt: doc.trashedAt || null,
                welcomeCopy: false,
                groupId: doc.groupId || '',
                hidden: true,
              });
            } else {
              Object.assign(local, {
                title: doc.title || '',
                text: doc.text || '',
                html: doc.html || '',
                color: isValidColor(doc.color) ? doc.color : local.color,
                groupId: doc.groupId || '',
                updatedAt: doc.updatedAt,
                trashedAt: doc.trashedAt || null,
              });
              if (doc.trashedAt) closeWindow(`note-${doc.id}`);
              else if (wins[`note-${doc.id}`]) wins[`note-${doc.id}`].f.contentWindow.location.reload();
            }
            notesChanged = true;
          }
          st.files[file.name] = { fileId: file.id, synced: docStamp };
        }
      }

      st.pageToken = nextToken;
      if (groupsChanged) notifyGroups();
      if (notesChanged || groupsChanged) notifyNotes();

      // Push local changes.
      const enc = new TextEncoder();
      for (const up of computeUploads()) {
        for (const imgName of up.images) {
          const driveImgName = `${IMAGE_PREFIX}${imgName}`;
          if (st.files[driveImgName]) continue;
          const rec = imageCache.get(imgName);
          if (!rec || !rec.dataUrl) continue;
          const b64 = rec.dataUrl.split(',')[1] || '';
          const bytes = base64ToBytes(b64);
          const id = await driveUpload(token, null, driveImgName, 1, rec.mime || mimeForName(imgName), bytes);
          st.files[driveImgName] = { fileId: id, synced: 1 };
        }
        const existingId = st.files[up.name]?.fileId || null;
        const id = await driveUpload(token, existingId, up.name, up.stamp, 'application/json', enc.encode(up.body));
        st.files[up.name] = { fileId: id, synced: up.stamp };
      }

      st.lastSync = nowMs();
      markDirty(false);
      updateCloudStatus({ syncing: false, lastSync: st.lastSync, error: null });
    } catch (err) {
      updateCloudStatus({ syncing: false, error: typeof err === 'string' ? err : 'network' });
    }
  }

  function scheduleCloudSync() {
    if (IS_SITE_HOME || !data.sync || !data.sync.account) return;
    updateCloudStatus({});
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => runCloudSync(), 3000);
  }

  function syncCloudNow() {
    if (IS_SITE_HOME) return;
    clearTimeout(syncTimer);
    runCloudSync();
  }

  // ------------------------------------------------ command invoke handler

  async function invokeCommand(label, cmd, args = {}) {
    const id = idOf(label);
    const n = isNote(label) ? findNote(id) : null;
    const g = isGroup(label) ? findGroup(id) : null;
    const b = isBoard(label) ? findBoard(id) : null;

    switch (cmd) {
      case 'get_language':
        return [data.language || 'system', effectiveLanguage()];
      case 'change_language':
        setLanguageSetting(args.language);
        return null;
      case 'get_theme':
        return effectiveTheme();
      case 'change_theme':
        setThemeSetting(args.theme);
        return null;
      case 'get_zoom':
        return data.zoom || 1;
      case 'change_zoom':
        return stepZoom(args.step);
      case 'get_magnet':
        return !data.magnetOff;
      case 'set_magnet':
        data.magnetOff = !args.on;
        markDirty(false);
        emit('magnet-changed', !data.magnetOff);
        return !data.magnetOff;

      // Dragging & Resizing
      case 'drag_start':
        handleDragStart(label, args);
        return null;
      case 'drag_to':
        handleDragTo(label, args);
        return null;
      case 'drag_end':
        handleDragEnd(label, args);
        return null;
      case 'resize_start':
        handleResizeStart(label, args);
        return null;
      case 'resize_to':
        handleResizeTo(label, args);
        return null;
      case 'place_color_picker':
        return null;
      case 'show_title_menu':
        openTitlebarMenu(label, args.items || [], args.at);
        return null;

      // Note commands
      case 'load_note':
        if (!n) return null;
        return Object.assign(copy(n), { html: inlineImages(n.html) });
      case 'save_text': {
        if (!n) return null;
        const storedHtml = await storeImages(args.html || '');
        updateNote(n.id, (x) => {
          x.text = args.text || '';
          x.html = storedHtml;
        });
        notifyNotes();
        return null;
      }
      case 'set_title': {
        if (!n) return '';
        const clean = String(args.title || '').trim().slice(0, TITLE_MAX);
        updateNote(n.id, (x) => { x.title = clean; });
        notifyNotes();
        return clean;
      }
      case 'set_color': {
        if (!n) return null;
        const color = isValidColor(args.color) ? args.color : '';
        updateNote(n.id, (x) => { x.color = color; });
        notifyNotes();
        return null;
      }
      case 'set_pinned': {
        const target = n || g || b || data.manager;
        if (!target) return false;
        target.pinned = !!args.pinned;
        const w = wins[label];
        if (w) {
          const wasPinned = !!w.pinned;
          w.pinned = target.pinned;
          w.el.classList.toggle('pinned', w.pinned);
          if (IS_SITE_HOME && wasPinned !== w.pinned) {
            if (w.pinned) {
              setWinRect(label, w.x - window.scrollX, w.y - window.scrollY, w.w, w.h, false);
            } else {
              setWinRect(label, w.x + window.scrollX, w.y + window.scrollY, w.w, w.h, false);
            }
          }
          raiseWindow(label);
          if (target.pinned) {
            await openPipForWindow(label);
          } else {
            closePipForWindow(label, true);
          }
        }
        markDirty(false);
        return target.pinned;
      }
      case 'new_note':
        createNote({ parentLabel: label });
        return null;
      case 'close_note':
        if (n) closeNoteById(n.id);
        return null;
      case 'trash_note': {
        const noteId = (args && args.id) || (n && n.id) || idOf(label);
        if (noteId) trashNoteById(noteId);
        return null;
      }
      case 'open_link':
        if (args.url && /^(https?:|mailto:)/i.test(args.url)) {
          window.open(args.url, '_blank', 'noopener,noreferrer');
        }
        return null;
      case 'get_note_group':
        return n ? n.groupId || '' : '';
      case 'set_note_group':
        if (n) assignNoteGroup(n.id, args.groupId, label);
        return null;

      // Board commands
      case 'list_boards':
        return copy(data.boards);
      case 'load_board': {
        const brd = b || findBoard(id);
        return brd ? copy(brd) : null;
      }
      case 'get_board_group':
        return b ? (b.groupId || '') : '';
      case 'set_board_group':
        if (b) assignBoardGroup(b.id, args.groupId, label);
        return null;
      case 'save_board_columns': {
        updateBoard(id, (x) => { x.columns = args.columns; });
        notifyBoards();
        return null;
      }
      case 'rename_board': {
        const brd = updateBoard(id, (x) => { x.name = String(args.name || '').trim().slice(0, 60); });
        notifyBoards();
        return brd ? brd.name : '';
      }
      case 'set_board_color': {
        const color = isValidColor(args.color) ? args.color : '';
        updateBoard(id, (x) => { x.color = color; });
        notifyBoards();
        return null;
      }
      case 'close_board': {
        const brd = b || findBoard(id);
        if (brd) {
          brd.hidden = true;
          closeWindow(label);
          notifyBoards();
        }
        return null;
      }
      case 'trash_board': {
        const brd = b || findBoard(id) || (args && findBoard(args.id));
        if (brd) trashBoardById(brd.id);
        return null;
      }
      case 'new_board':
        createBoard(label);
        return null;
      case 'open_board': {
        const brd = findBoard(args.id);
        if (brd) {
          brd.hidden = false;
          openBoardWindow(brd);
          notifyBoards();
        }
        return null;
      }
      case 'trash_board_id':
        trashBoardById(args.id);
        return null;
      case 'restore_board_id':
        restoreBoardById(args.id);
        return null;
      case 'delete_board_forever':
        deleteBoardForever(args.id);
        return null;
      case 'update_board_drop_zones': {
        const bid = (b && b.id) || (args && args.id) || idOf(label);
        boardDropZones[bid] = args.zones || [];
        return null;
      }
      case 'take_note_out_of_board': {
        for (const brd of data.boards) {
          for (const col of brd.columns) {
            col.noteIds = col.noteIds.filter((noteId) => noteId !== args.id);
          }
        }
        const note = findNote(args.id);
        if (note) {
          note.hidden = false;
          if (args.screenX != null) note.x = args.screenX;
          if (args.screenY != null) note.y = args.screenY;
          openNoteWindow(note);
          notifyNotes();
          notifyBoards();
        }
        return null;
      }
      // Group commands
      case 'list_groups':
        return copy(data.groups);
      case 'load_group':
        if (!g) return null;
        return [copy(g), activeNotes().filter((x) => x.groupId === g.id).length + activeBoards().filter((x) => x.groupId === g.id).length];
      case 'rename_group': {
        const grp = g || findGroup(args.id);
        if (!grp) return '';
        const clean = String(args.name || '').trim().slice(0, GROUP_NAME_MAX);
        updateGroup(grp.id, (x) => { x.name = clean; });
        notifyGroups();
        notifyNotes();
        return clean;
      }
      case 'set_group_color': {
        if (!g) return null;
        const color = isValidColor(args.color) ? args.color : 'iris';
        updateGroup(g.id, (x) => { x.color = color; });
        notifyGroups();
        notifyNotes();
        return null;
      }
      case 'set_group_height': {
        const w = wins[label];
        if (w && typeof args.height === 'number') {
          const z = data.zoom || 1;
          w.el.style.height = `${Math.round(args.height * z)}px`;
        }
        return null;
      }
      case 'toggle_group':
        if (g) toggleGroupById(g.id);
        return null;
      case 'toggle_group_id':
        toggleGroupById(args.id);
        return null;
      case 'show_group_notes':
        if (g) raiseGroup(g.id);
        return null;
      case 'focus_group':
        raiseGroup(args.id);
        return null;
      case 'new_note_in_group':
        if (g) {
          if (!g.open) await takeOutGroup(g);
          createNote({ parentLabel: label, groupId: g.id });
        }
        return null;
      case 'new_group':
        createGroup(label);
        return null;
      case 'close_group':
        if (g) closeGroupById(g.id);
        return null;
      case 'trash_group':
        if (g) trashGroupById(g.id);
        return null;
      case 'trash_group_id':
        trashGroupById(args.id);
        return null;
      case 'restore_group':
        restoreGroupById(args.id);
        return null;
      case 'delete_group_forever':
        closeWindow(`group-${args.id}`);
        for (const x of data.notes) {
          if (x.groupId === args.id) x.groupId = '';
        }
        data.groups = data.groups.filter((x) => x.id !== args.id);
        bury(args.id);
        markDirty(true);
        notifyGroups();
        notifyNotes();
        return null;
      case 'empty_group_trash':
        for (const x of data.groups.filter((grp) => grp.trashedAt)) {
          for (const m of data.notes) {
            if (m.groupId === x.id) m.groupId = '';
          }
          bury(x.id);
        }
        data.groups = data.groups.filter((grp) => !grp.trashedAt);
        markDirty(true);
        notifyGroups();
        notifyNotes();
        return null;

      // Manager commands
      case 'load_manager':
        return copy(data.manager);
      case 'take_manager_view': {
        const v = pendingManagerView;
        pendingManagerView = null;
        return v;
      }
      case 'close_manager':
        if (!isMobile()) closeWindow('manager');
        return null;
      case 'set_manager_color':
        if (isValidColor(args.color)) {
          data.manager.color = args.color;
          markDirty(false);
        }
        return null;
      case 'set_manager_layout':
        setManagerLayout(args.layout);
        return null;
      case 'bring_notes_to_front':
        bringNotesToFront();
        return null;
      case 'list_notes':
        return data.notes.map((x) => Object.assign(copy(x), { html: '' }));
      case 'open_board_note':
      case 'open_note': {
        const target = findNote(args.id);
        if (!target) return null;
        target.hidden = false;
        if (target.groupId) {
          const grp = findGroup(target.groupId);
          if (grp && (!grp.open || grp.hidden)) {
            await takeOutGroup(grp);
          }
        }
        await openNoteWindow(target);
        const wKey = `note-${target.id}`;
        const win = wins[wKey];
        if (win) {
          const wa = workArea();
          if (win.x < wa.left || win.y < wa.top || (win.x + win.w) > wa.right || (win.y + win.h) > wa.bottom) {
            const pos = beside('manager', win.w, win.h);
            setWinRect(wKey, pos.x, pos.y, win.w, win.h);
            target.x = pos.x;
            target.y = pos.y;
          }
        }
        raiseWindow(`note-${target.id}`);
        markDirty(false);
        notifyNotes();
        return null;
      }
      case 'move_to_trash':
        trashNoteById(args.id);
        return null;
      case 'restore_note': {
        const target = findNote(args.id);
        if (!target) return null;
        const grp = target.groupId ? findGroup(target.groupId) : null;
        updateNote(target.id, (x) => {
          x.trashedAt = null;
          x.hidden = false;
          if (grp && grp.trashedAt) x.groupId = '';
        });
        if (!grp || grp.open) openNoteWindow(target);
        notifyNotes();
        notifyGroups();
        return null;
      }
      case 'delete_forever':
        closeWindow(`note-${args.id}`);
        data.notes = data.notes.filter((x) => x.id !== args.id);
        bury(args.id);
        markDirty(true);
        notifyNotes();
        return null;
      case 'empty_trash':
        for (const x of data.notes.filter((m) => m.trashedAt)) bury(x.id);
        data.notes = data.notes.filter((m) => !m.trashedAt);
        markDirty(true);
        notifyNotes();
        return null;

      // Defaults
      case 'get_default_color':
        return data.defaultColor || '';
      case 'set_default_color':
        data.defaultColor = args.color === 'random' || isValidColor(args.color) ? args.color : '';
        data.defaultsUpdatedAt = nowMs();
        markDirty(true);
        return null;
      case 'get_new_note_defaults':
        return [
          data.defaultTitle || '',
          data.defaultText || '',
          inlineImages(data.defaultHtml || plainFromDefault(data.defaultText || '')),
        ];
      case 'set_default_title':
        data.defaultTitle = String(args.title || '').trim().slice(0, TITLE_MAX);
        data.defaultsUpdatedAt = nowMs();
        markDirty(true);
        return null;
      case 'set_default_content':
        data.defaultText = String(args.text || '').slice(0, DEFAULT_TEXT_MAX);
        data.defaultHtml = await storeImages(args.html || '');
        data.defaultsUpdatedAt = nowMs();
        markDirty(true);
        return null;
      case 'get_group_defaults':
        return [data.defaultGroupColor || 'random', data.defaultGroupTitle || ''];
      case 'set_default_group_color':
        data.defaultGroupColor = args.color === 'random' || isValidColor(args.color) ? args.color : 'random';
        data.defaultsUpdatedAt = nowMs();
        markDirty(true);
        return null;
      case 'set_default_group_title':
        data.defaultGroupTitle = String(args.title || '').trim().slice(0, GROUP_NAME_MAX);
        data.defaultsUpdatedAt = nowMs();
        markDirty(true);
        return null;

      // Storage & Backup
      case 'get_data_dir':
        return ['localStorage', true];
      case 'export_notes':
        return exportNotesFile(args.fileName);
      case 'import_notes':
        return importNotesFile();

      // Cloud Sync
      case 'get_cloud_account':
        cloudStatus.pending = computeUploads().length;
        cloudStatus.lastSync = (data.sync && data.sync.lastSync) || cloudStatus.lastSync || 0;
        return [Boolean(googleClientId()), (data.sync && data.sync.account) || null, copy(cloudStatus)];
      case 'connect_cloud':
        return connectCloudAccount();
      case 'cancel_cloud_connect':
        if (oauthCancel) oauthCancel();
        return null;
      case 'disconnect_cloud':
        disconnectCloudAccount();
        return null;
      case 'sync_cloud':
        syncCloudNow();
        return null;

      // Welcome & desktop stubs
      case 'show_welcome':
        openWelcomeNote('manager', true, true);
        return null;
      case 'get_autostart':
        return false;
      case 'set_autostart':
        return false;
      case 'get_updates':
        return [false, { checking: false, available: null, progress: null, upToDate: true, error: null }];
      case 'get_ai_control':
        return [false, ''];
      case 'get_ai_clients':
        return [];
      case 'quit_app':
        return null;
      default:
        return null;
    }
  }

  // ------------------------------------------------ window.__TAURI__ bridge

  function labelForFrame(frameWin) {
    try {
      const q = new URLSearchParams(frameWin.location.search);
      if (q.get('label')) return q.get('label');
      if (frameWin.parent && frameWin.parent !== window) {
        const pq = new URLSearchParams(frameWin.parent.location.search);
        if (pq.get('label')) return pq.get('label');
      }
    } catch {}
    return 'manager';
  }

  function createTauri(frameWin) {
    const label = labelForFrame(frameWin);
    const winApi = {
      label,
      setTitle: async () => {},
      innerPosition: async () => ({ x: wins[label]?.x || 0, y: wins[label]?.y || 0 }),
      innerSize: async () => ({ width: frameWin.innerWidth, height: frameWin.innerHeight }),
      scaleFactor: async () => 1,
      startDragging: async () => {},
      setFocus: async () => raiseWindow(label),
      close: async () => closeWindow(label),
      hide: async () => {},
      show: async () => {},
    };
    return {
      core: {
        invoke: (cmd, args) => invokeCommand(label, cmd, args || {}),
      },
      event: {
        listen: (ev, cb) => Promise.resolve(listen(ev, cb, frameWin)),
        emit: async (ev, payload) => emit(ev, payload),
      },
      window: { getCurrentWindow: () => winApi },
      webviewWindow: { getCurrentWebviewWindow: () => winApi },
      app: { getVersion: async () => '0.9.0 (Web)' },
    };
  }

  window.MemoWeb = {
    createTauri,
    invoke: invokeCommand,
    openManager: openManagerWindow,
    createNote,
    createGroup,
    isMobile,
  };

  // ---------------------------------------------------------------- startup

  async function resolveSrcBase() {
    try {
      const r = await fetch('./src/index.html', { method: 'HEAD' });
      if (r.ok) {
        srcBase = './src';
        return;
      }
    } catch {}
    srcBase = '../src';
  }

  // ------------------------------------------------ interactive site scenes

  function demoCatalog(lang) {
    const pt = lang === 'pt';
    const day = 86_400_000;
    const now = nowMs();
    const groupWork = {
      id: 'demo-work',
      name: pt ? 'Trabalho' : 'Work',
      color: 'teal',
      x: 56,
      y: 36,
      width: 296,
      open: true,
      pinned: false,
      hidden: false,
    };
    const groupProjects = {
      id: 'demo-projects',
      name: pt ? 'Projetos' : 'Projects',
      color: 'coral',
      x: 56,
      y: 36,
      width: 312,
      open: true,
      pinned: false,
      hidden: false,
    };
    return {
      group: groupWork,
      groups: [groupWork, groupProjects],
      notes: [
        {
          id: 'demo-today',
          title: pt ? 'Hoje' : 'Today',
          text: pt
            ? '[x] Conhecer o Memo\n[ ] Clique aqui para marcar esta tarefa\n[ ] Dois cliques no título para renomear\n[ ] Digite qualquer anotação aqui'
            : '[x] Discover Memo\n[ ] Click here to check off this task\n[ ] Double-click title bar to rename\n[ ] Type any note right here',
          html: '',
          color: 'yellow',
          groupId: '',
          x: 596,
          y: 68,
          width: 304,
          height: 252,
          pinned: false,
          hidden: false,
          updatedAt: now - 300_000,
        },
        {
          id: 'demo-launch',
          title: pt ? 'Dia do lançamento' : 'Launch day',
          text: pt
            ? '[x] Enviar a newsletter\n[x] Atualizar o site\n[ ] Avisar o time\n\nColetiva às 15h\nDepois rode npm run deploy'
            : '[x] Send the newsletter\n[x] Update the website\n[ ] Tell the team\n\nPress call at 3pm\nThen run npm run deploy',
          html: pt
            ? '<div class="check done">Enviar a newsletter</div><div class="check done">Atualizar o site</div><div class="check">Avisar o time</div><div><br></div><div><span style="background-color: rgb(255, 230, 0)">Coletiva às 15h</span></div><div>Depois rode <code>npm run deploy</code></div>'
            : '<div class="check done">Send the newsletter</div><div class="check done">Update the website</div><div class="check">Tell the team</div><div><br></div><div><span style="background-color: rgb(255, 230, 0)">Press call at 3pm</span></div><div>Then run <code>npm run deploy</code></div>',
          color: 'yellow',
          groupId: '',
          x: 244,
          y: 26,
          width: 376,
          height: 360,
          pinned: false,
          hidden: false,
          updatedAt: now - 450_000,
        },
        {
          id: 'demo-groceries',
          title: pt ? 'Compras' : 'Groceries',
          text: pt ? 'Café\nPão\nLeite' : 'Coffee\nBread\nMilk',
          html: '',
          color: 'yellow',
          groupId: '',
          x: 612,
          y: 64,
          width: 312,
          height: 220,
          pinned: false,
          hidden: false,
          updatedAt: now - 600_000,
        },
        {
          id: 'demo-q4',
          title: pt ? 'Plano do T4' : 'Q4 plan',
          text: pt
            ? '[ ] Contratar designer\n[ ] Nova página de preços\n[ ] Pesquisa com clientes'
            : '[ ] Hire a designer\n[ ] New pricing page\n[ ] Customer survey',
          html: '',
          color: 'teal',
          groupId: 'demo-work',
          x: 56,
          y: 88,
          width: 296,
          height: 204,
          pinned: false,
          hidden: false,
          updatedAt: now - (1 * day + 3_600_000),
        },
        {
          id: 'demo-meet',
          title: pt ? 'Notas da reunião' : 'Meeting notes',
          text: pt
            ? '- Lançar a 0.4 na sexta\n- Ana cuida das notas da versão\n- Próxima reunião: terça'
            : '- Ship 0.4 on Friday\n- Ana owns the release notes\n- Next sync: Tuesday',
          html: '',
          color: 'coral',
          groupId: 'demo-projects',
          x: 366,
          y: 88,
          width: 296,
          height: 204,
          pinned: false,
          hidden: false,
          updatedAt: now - (2 * day + 3_600_000),
        },
        {
          id: 'demo-wifi',
          title: pt ? 'Senha do Wi-Fi' : 'Wi-Fi password',
          text: 'memo-2026',
          html: '',
          color: 'iris',
          groupId: '',
          x: 612,
          y: 110,
          width: 290,
          height: 190,
          pinned: false,
          hidden: true,
          updatedAt: now - (3 * day + 3_600_000),
        },
        {
          id: 'demo-ideas',
          title: pt ? 'Ideias' : 'Ideas',
          text: pt
            ? 'Modo escuro no site\nAtalho para duplicar uma memória'
            : 'Dark mode for the website\nA shortcut to duplicate a memory',
          html: '',
          color: 'coral',
          groupId: '',
          x: 556,
          y: 312,
          width: 324,
          height: 180,
          pinned: false,
          hidden: false,
          updatedAt: now - (4 * day + 3_600_000),
        },
        {
          id: 'demo-books',
          title: pt ? 'Livros para ler' : 'Books to read',
          text: pt ? 'O Hobbit\nDuna' : 'The Hobbit\nDune',
          html: '',
          color: 'green',
          groupId: '',
          x: 612,
          y: 140,
          width: 290,
          height: 190,
          pinned: false,
          hidden: true,
          updatedAt: now - (5 * day + 3_600_000),
        },
        {
          id: 'demo-trip',
          title: pt ? 'Orçamento da viagem' : 'Trip budget',
          text: pt ? 'Hotel 1.300\nPassagens 900' : 'Hotel 1,300\nFlights 900',
          html: '',
          color: '',
          groupId: '',
          x: 612,
          y: 170,
          width: 290,
          height: 190,
          pinned: false,
          hidden: true,
          updatedAt: now - (6 * day + 3_600_000),
        },
      ],
    };
  }

  function seedDemoData(lang, force = false) {
    const cat = demoCatalog(lang);
    const groups = cat.groups || (cat.group ? [cat.group] : []);
    for (const gDef of groups) {
      let grp = findGroup(gDef.id);
      if (!grp) {
        data.groups.push(Object.assign({
          seq: data.nextSeq++,
          createdAt: nowMs(),
          updatedAt: nowMs(),
          trashedAt: null,
          demoSeed: true,
        }, gDef));
      } else if (force || grp.demoSeed) {
        grp.name = gDef.name;
        if (force) {
          Object.assign(grp, gDef, { trashedAt: null, demoSeed: true });
        }
      }
    }

    for (const item of cat.notes) {
      const existing = findNote(item.id);
      if (!existing) {
        data.notes.push(Object.assign({
          seq: data.nextSeq++,
          createdAt: item.updatedAt,
          trashedAt: null,
          welcomeCopy: false,
          demoSeed: true,
        }, item));
      } else if (force) {
        Object.assign(existing, item, { trashedAt: null, demoSeed: true });
      } else if (existing.demoSeed) {
        existing.title = item.title;
        existing.text = item.text;
        existing.html = item.html;
      }
    }
  }

  function buildPinSpreadsheet(lang) {
    const pt = lang === 'pt';
    const oldSheet = document.getElementById('sheet');
    if (oldSheet) oldSheet.remove();
    const oldDock = document.getElementById('demoDock');
    if (oldDock) oldDock.remove();

    const rows = [
      [pt ? 'Categoria' : 'Category', ...(pt ? 'Jan Fev Mar Abr Mai Jun Jul' : 'Jan Feb Mar Apr May Jun Jul').split(' ')],
      [pt ? 'Aluguel' : 'Rent', 5214, 5847, 1839, 2904, 3120, 4410, 3807],
      [pt ? 'Equipe' : 'Team', 8710, 6105, 4497, 3352, 6620, 2981, 5039],
      ['Marketing', 5287, 2916, 6848, 2218, 4093, 3367, 4636],
      ['Software', 1251, 9252, 9529, 1840, 2210, 6115, 2702],
      [pt ? 'Viagens' : 'Travel', 4573, 5753, 6847, 3327, 2333, 9671, 4811],
      [pt ? 'Eventos' : 'Events', 2893, 5723, 3773, 2182, 7756, 3965, 3951],
      [pt ? 'Materiais' : 'Supplies', 1517, 9136, 2948, 8757, 5036, 2924, 6227],
      [pt ? 'Consultoria' : 'Consulting', 4416, 7630, 6675, 2024, 2815, 4853, 1612],
    ];
    const title = pt ? 'Orçamento 2027.xlsx' : 'Budget 2027.xlsx';
    const fmt = (v) => (typeof v === 'number' ? v.toLocaleString(pt ? 'pt-BR' : 'en-US') : v);
    const head = '<tr><th></th>' + 'ABCDEFGH'.split('').map((c) => `<th>${c}</th>`).join('') + '</tr>';
    const body = rows.map((r, i) => `<tr><td class="rn">${i + 1}</td>${r.map((v) => `<td>${fmt(v)}</td>`).join('')}</tr>`).join('');

    desk.insertAdjacentHTML('beforeend', `
      <div class="demo-app" id="sheet" style="left:36px;top:22px;width:888px;height:442px;z-index:${++zNormal}">
        <div class="bar"><span class="dots"><i></i><i></i><i></i></span><span id="sheetTitle">${title}</span></div>
        <div class="tools"><span>B</span><span>I</span><span>%</span><span>Σ</span><span class="fx" id="fx"></span></div>
        <table class="sheet"><tbody>${head}${body}</tbody></table>
      </div>
      <div class="demo-dock" id="demoDock">
        <i></i><i></i>
        <button type="button" class="dock-memo" id="memoIcon" title="Memo" aria-label="Memo">
          <img src="media/icon.svg" width="16" height="16" alt="" aria-hidden="true">
        </button>
        <i></i><i></i>
      </div>
    `);

    const sheet = document.getElementById('sheet');
    const fx = document.getElementById('fx');
    let sel = null;
    let typed = null;
    const select = (td) => {
      if (sel) sel.classList.remove('sel');
      sel = td;
      typed = null;
      td.classList.add('sel');
      fx.textContent = td.textContent;
    };
    sheet.addEventListener('pointerdown', (e) => {
      sheet.style.zIndex = String(++zNormal);
      for (const other of Object.values(wins)) {
        try {
          other.f.contentDocument?.getElementById('frame')?.classList.remove('is-focused');
        } catch {}
      }
      const td = e.target.closest('td');
      if (td && !td.classList.contains('rn')) select(td);
    });
    document.addEventListener('keydown', (e) => {
      if (!sel || !document.body.contains(sel)) return;
      if (/^[0-9]$/.test(e.key)) {
        typed = (typed || '') + e.key;
        sel.textContent = typed;
        fx.textContent = typed;
      } else if (e.key === 'Backspace' && sel) {
        typed = (typed || '').slice(0, -1);
        sel.textContent = typed;
        fx.textContent = typed;
      } else if (e.key === 'Enter') {
        if (typed) sel.textContent = Number(typed).toLocaleString(pt ? 'pt-BR' : 'en-US');
        const tr = sel.parentElement.nextElementSibling;
        if (tr) select(tr.children[[...sel.parentElement.children].indexOf(sel)]);
      }
    });
    document.getElementById('memoIcon').addEventListener('click', async () => {
      const n = findNote('demo-today');
      if (n) {
        n.hidden = false;
        await openNoteWindow(n);
        raiseWindow('note-demo-today');
      }
    });
  }

  async function bootScene(scene, forceReset = false) {
    for (const label of Object.keys(wins)) {
      closeWindow(label);
    }
    const lang = effectiveLanguage();
    seedDemoData(lang, forceReset);
    if (forceReset) markDirty(false);

    if (scene === 'pin') {
      data.zoom = 1;
      buildPinSpreadsheet(lang);
      const n = findNote('demo-today');
      if (n) {
        n.hidden = false;
        if (forceReset) {
          n.x = 596;
          n.y = 68;
          n.width = 304;
          n.height = 252;
        }
        await openNoteWindow(n);
        raiseWindow('note-demo-today');
      }
      return;
    }

    if (scene === 'write') {
      data.zoom = 1.25;
      const n = findNote('demo-launch');
      if (n) {
        n.hidden = false;
        if (forceReset || n.x === null) {
          n.x = 244;
          n.y = 26;
          n.width = 376;
          n.height = 360;
        }
        const w = await openNoteWindow(n);
        raiseWindow('note-demo-launch');
        setTimeout(() => {
          try {
            const btn = w?.f?.contentDocument?.getElementById('trayBtn');
            if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
          } catch {}
        }, 120);
      }
      return;
    }

    if (scene === 'group') {
      data.zoom = 1;
      const g = findGroup('demo-work');
      if (g) {
        g.hidden = false;
        g.open = true;
        await openGroupWindow(g);
      }
      for (const id of ['demo-q4', 'demo-meet', 'demo-ideas']) {
        const n = findNote(id);
        if (n) {
          if (id === 'demo-meet') n.groupId = 'demo-work';
          n.hidden = false;
          await openNoteWindow(n);
        }
      }
      raiseWindow('note-demo-ideas');
      return;
    }

    if (scene === 'manager') {
      data.zoom = 1;
      Object.assign(data.manager, { x: 32, y: 20, width: 556, height: 492, color: 'iris' });
      await openManagerWindow({ view: 'notes', scope: 'current' });
      const n = findNote('demo-groceries');
      if (n) {
        n.hidden = false;
        await openNoteWindow(n);
      }
      raiseWindow('manager');
    }
  }

  function anchorRect(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      w: Math.max(240, Math.round(r.width)),
      h: Math.round(r.height),
    };
  }

  function computeSiteHomePositions() {
    const pos = {};
    const hero = anchorRect('anchorHero');
    if (hero) {
      const groupY = hero.y + 8;
      const noteQ4Y = groupY + TITLEBAR_H + SNAP_GAP;
      if (hero.w >= 880) {
        const gap = hero.w >= 960 ? 24 : 16;
        const colW = Math.min(296, Math.floor((hero.w - gap * 2) / 3));
        const totalW = colW * 3 + gap * 2;
        const startX = hero.x + Math.max(0, Math.round((hero.w - totalW) / 2));
        const x1 = startX;
        const x2 = startX + colW + gap;
        const x3 = startX + (colW + gap) * 2;

        pos['group-demo-work'] = { x: x1, y: groupY, w: colW, h: TITLEBAR_H };
        pos['note-demo-q4'] = { x: x1, y: noteQ4Y, w: colW, h: 210 };
        pos['note-demo-today'] = { x: x2, y: hero.y + 14, w: colW, h: 246 };
        pos['note-demo-wifi'] = { x: x3, y: hero.y + 26, w: colW, h: 224 };
      } else if (hero.w >= 600) {
        const gap = 16;
        const colW = Math.min(320, Math.floor((hero.w - gap) / 2));
        const totalW = colW * 2 + gap;
        const startX = hero.x + Math.max(0, Math.round((hero.w - totalW) / 2));
        const x1 = startX;
        const x2 = startX + colW + gap;

        pos['group-demo-work'] = { x: x1, y: groupY, w: colW, h: TITLEBAR_H };
        pos['note-demo-q4'] = { x: x1, y: noteQ4Y, w: colW, h: 210 };
        pos['note-demo-today'] = { x: x2, y: hero.y + 8, w: colW, h: 240 };
        pos['note-demo-wifi'] = { x: x2, y: hero.y + 264, w: colW, h: 216 };
      } else {
        const w = Math.min(340, hero.w);
        const x = hero.x + Math.max(0, Math.round((hero.w - w) / 2));
        pos['group-demo-work'] = { x, y: groupY, w, h: TITLEBAR_H };
        pos['note-demo-q4'] = { x, y: noteQ4Y, w, h: 200 };
        pos['note-demo-today'] = { x, y: hero.y + 264, w, h: 240 };
        pos['note-demo-wifi'] = { x, y: hero.y + 518, w, h: 216 };
      }
    }
    const write = anchorRect('anchorWrite');
    if (write) {
      const w = Math.min(440, write.w);
      pos['note-demo-launch'] = { x: write.x + Math.max(0, Math.round((write.w - w) / 2)), y: write.y + 4, w, h: 348 };
    }
    const grp = anchorRect('anchorGroup');
    if (grp) {
      const grpY = grp.y + 4;
      const grpNoteY = grpY + TITLEBAR_H + SNAP_GAP;
      pos['group-demo-projects'] = { x: grp.x, y: grpY, w: Math.min(312, grp.w), h: TITLEBAR_H };
      if (grp.w >= 540) {
        pos['note-demo-meet'] = { x: grp.x, y: grpNoteY, w: 268, h: 204 };
        pos['note-demo-ideas'] = { x: grp.x + 280, y: grpNoteY, w: 268, h: 204 };
      } else {
        const w = Math.min(340, grp.w);
        pos['note-demo-meet'] = { x: grp.x, y: grpNoteY, w, h: 190 };
        pos['note-demo-ideas'] = { x: grp.x, y: grpNoteY + 190 + SNAP_GAP, w, h: 165 };
      }
    }
    const mgr = anchorRect('anchorManager');
    if (mgr) {
      pos.manager = { x: mgr.x, y: mgr.y + 4, w: Math.min(560, mgr.w), h: 452 };
    }
    return pos;
  }

  function alignSiteHomeWindows(force = false) {
    if (!IS_SITE_HOME) return;
    const pos = computeSiteHomePositions();
    for (const [label, rect] of Object.entries(pos)) {
      const w = wins[label];
      if (!w) continue;
      if (!force && (w.userMoved || w.pinned)) continue;
      setWinRect(label, rect.x, rect.y, rect.w, rect.h, false);
    }
  }

  async function bootSiteHome() {
    data = defaultData();
    data.zoom = 1;
    const lang = effectiveLanguage();
    seedDemoData(lang, true);
    const pt = lang === 'pt';
    const wifi = findNote('demo-wifi');
    if (wifi && wifi.demoSeed) {
      wifi.text = pt
        ? 'Rede: Memo-5G\nSenha: memo-2026\n\nDica: clique no alfinete (↖) e role a página!'
        : 'Network: Memo-5G\nPass: memo-2026\n\nTip: click the pin (↖) and scroll the page!';
      wifi.html = '';
    }

    const pos = computeSiteHomePositions();
    for (const [label, rect] of Object.entries(pos)) {
      if (label === 'manager') {
        Object.assign(data.manager, { x: rect.x, y: rect.y, width: rect.w, height: rect.h, color: 'iris', pinned: false });
      } else if (isGroup(label)) {
        const g = findGroup(idOf(label));
        if (g) Object.assign(g, { x: rect.x, y: rect.y, width: rect.w, hidden: false, open: true, pinned: false });
      } else if (isNote(label)) {
        const n = findNote(idOf(label));
        if (n) Object.assign(n, { x: rect.x, y: rect.y, width: rect.w, height: rect.h, hidden: false, pinned: false });
      }
    }

    for (const gid of ['demo-work', 'demo-projects']) {
      const g = findGroup(gid);
      if (g) await openGroupWindow(g);
    }

    for (const id of ['demo-today', 'demo-wifi', 'demo-launch', 'demo-q4', 'demo-meet', 'demo-ideas']) {
      const n = findNote(id);
      if (n) {
        const w = await openNoteWindow(n);
        if (id === 'demo-launch') {
          setTimeout(() => {
            try {
              const btn = w?.f?.contentDocument?.getElementById('trayBtn');
              if (btn && btn.getAttribute('aria-pressed') !== 'true') btn.click();
            } catch {}
          }, 150);
        }
      }
    }

    await openManagerWindow({ view: 'notes', scope: 'current' }, false);
    raiseWindow('note-demo-today');
    if (!location.hash && window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
    window.addEventListener('resize', () => alignSiteHomeWindows(false));
  }

  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'memo-site-prefs') {
      if (e.data.theme === 'light' || e.data.theme === 'dark' || e.data.theme === 'system') {
        setThemeSetting(e.data.theme);
      }
      if (e.data.lang === 'pt' || e.data.lang === 'pt-BR' || e.data.lang === 'en') {
        const nextLang = e.data.lang === 'en' ? 'en' : 'pt-BR';
        setLanguageSetting(nextLang);
        if (SCENE || IS_SITE_HOME) {
          const eff = effectiveLanguage();
          seedDemoData(eff, false);
          if (IS_SITE_HOME) {
            const wifi = findNote('demo-wifi');
            if (wifi && wifi.demoSeed) {
              wifi.text = eff === 'pt'
                ? 'Rede: Memo-5G\nSenha: memo-2026\n\nDica: clique no alfinete (↖) e role a página!'
                : 'Network: Memo-5G\nPass: memo-2026\n\nTip: click the pin (↖) and scroll the page!';
              wifi.html = '';
            }
          }
          if (SCENE === 'pin') buildPinSpreadsheet(eff);
          for (const w of Object.values(wins)) {
            if (isNote(w.label)) {
              try { w.f.contentWindow.location.reload(); } catch {}
            }
          }
          notifyGroups();
          notifyNotes();
        }
      }
    } else if (e.data.type === 'memo-reset-scene' && SCENE) {
      bootScene(SCENE, true);
    } else if (e.data.type === 'memo-persist-scene' && SCENE) {
      flushStore();
    }
  });

  window.addEventListener('storage', (e) => {
    if (IS_SITE_HOME) return;
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        data = normalizeData(JSON.parse(e.newValue));
        data.notes = data.notes.filter((n) => !n.demoSeed && !n.id.startsWith('demo-'));
        data.groups = data.groups.filter((g) => !g.demoSeed && !g.id.startsWith('demo-'));
        applyDesktopThemeAndLang();
        notifyGroups();
        notifyNotes();
      } catch {}
    }
  });

  async function boot() {
    await resolveSrcBase();
    if (!IS_SITE_HOME) {
      await loadAllImagesFromDb();
      loadStore();
    }
    applyDesktopThemeAndLang();

    if (IS_SITE_HOME) {
      await bootSiteHome();
      return;
    }

    if (SCENE) {
      await bootScene(SCENE, false);
      return;
    }

    const first = isFirstRun();
    const mobile = isMobile();
    document.documentElement.classList.toggle('is-mobile', mobile);
    await openManagerWindow();

    if (!mobile) {
      for (const g of activeGroups().filter((x) => !x.hidden)) {
        await openGroupWindow(g);
      }
      for (const brd of visibleBoards()) {
        await openBoardWindow(brd);
      }
    }

    if (first) {
      openWelcomeNote('manager', false, !mobile);
    } else if (activeNotes().length === 0 && activeGroups().length === 0 && !mobile) {
      createNote({ parentLabel: 'manager' });
    } else if (!mobile) {
      for (const n of visibleNotes()) {
        await openNoteWindow(n);
      }
    }

    if (data.sync && data.sync.account && loadStoredToken()) {
      runCloudSync();
    }
    setInterval(() => {
      if (data.sync && data.sync.account && loadStoredToken()) runCloudSync();
    }, 5 * 60_000);
  }

  window.addEventListener('focus', () => {
    if (data.sync && data.sync.account && loadStoredToken()) {
      if (nowMs() - (cloudStatus.lastSync || 0) >= 30_000) runCloudSync();
    }
  });

  boot().catch((err) => console.error('MemoWeb boot failed', err));
})();
