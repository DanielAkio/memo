// Fast static & invariant checks for Memo (< 1s, zero dependencies).
// Verifies JS syntax, Tauri commands, Tauri events, i18n keys/placeholders,
// and colour definitions across Rust, HTML, CSS and JS.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  failures++;
}
function pass(msg) {
  console.log(`  ok: ${msg}`);
}

// ----------------------------------------------------------------- 1. JS syntax

const jsFiles = [
  'src/i18n.js',
  'src/chrome.js',
  'src/app.js',
  'src/group.js',
  'src/board.js',
  'src/manager.js',
  'site/prefs.js',
  'tools/demos/mock.js',
  'tools/demos/stage.js',
];

for (const rel of jsFiles) {
  try {
    new vm.Script(read(rel), { filename: rel });
  } catch (err) {
    fail(`syntax error in ${rel}: ${err.message}`);
  }
}
if (!failures) pass(`JS syntax (${jsFiles.length} files)`);

// ------------------------------------------------------------ 2. Tauri commands

const mainRs = read('src-tauri/src/main.rs');
const handlerMatch = mainRs.match(/generate_handler!\[([\s\S]*?)\]/);
if (!handlerMatch) {
  fail('could not find generate_handler![...] in src-tauri/src/main.rs');
} else {
  const rustCmds = new Set(
    handlerMatch[1]
      .replace(/\/\/.*$/gm, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const jsCmds = new Set();
  const allJsStrings = new Set();
  for (const rel of ['src/chrome.js', 'src/app.js', 'src/group.js', 'src/board.js', 'src/manager.js']) {
    const src = read(rel);
    for (const m of src.matchAll(/\binvoke\(\s*'([a-z0-9_]+)'/g)) {
      jsCmds.add(m[1]);
    }
    for (const m of src.matchAll(/'([a-z][a-z0-9_]+)'/g)) {
      allJsStrings.add(m[1]);
    }
  }

  for (const cmd of jsCmds) {
    if (!rustCmds.has(cmd)) fail(`JS calls invoke('${cmd}') which is not in generate_handler! in main.rs`);
  }
  for (const cmd of rustCmds) {
    if (!allJsStrings.has(cmd)) fail(`Rust registers command '${cmd}' in generate_handler! but JS never references it`);
  }
  if (!failures) pass(`Tauri commands (${rustCmds.size} commands matched between JS and Rust)`);
}

// -------------------------------------------------------------- 3. Tauri events

const rustEvents = new Set();
for (const file of fs.readdirSync(path.join(ROOT, 'src-tauri/src'))) {
  if (!file.endsWith('.rs')) continue;
  const src = read(`src-tauri/src/${file}`);
  for (const m of src.matchAll(/\.emit(?:_to)?\s*\([^)]*?"([a-z0-9-]+)"/g)) {
    rustEvents.add(m[1]);
  }
}

const jsEvents = new Set();
for (const rel of ['src/chrome.js', 'src/app.js', 'src/group.js', 'src/board.js', 'src/manager.js', 'src/snap.html']) {
  const src = read(rel);
  for (const m of src.matchAll(/\blisten\(\s*'([a-z0-9-]+)'/g)) {
    jsEvents.add(m[1]);
  }
}
for (const ev of jsEvents) {
  if (!rustEvents.has(ev)) fail(`JS listens to '${ev}' which is never emitted by Rust`);
}
for (const ev of rustEvents) {
  if (!jsEvents.has(ev)) fail(`Rust emits '${ev}' which no JS window listens to`);
}
if (!failures) pass(`Tauri events (${rustEvents.size} events matched between JS and Rust)`);

// --------------------------------------------------------------------- 4. i18n

const i18nSrc = read('src/i18n.js');
// Expose internal STRINGS, PLACEHOLDERS, HELP for inspection alongside MemoI18n
const i18nInspection = i18nSrc.replace(
  'return { t, set, apply,',
  'window.__I18N_RAW__ = { STRINGS, PLACEHOLDERS, HELP }; return { t, set, apply,'
);
const sandbox = {
  window: {},
  navigator: { platform: 'Win32', language: 'pt-BR' },
  document: { documentElement: { lang: 'pt-BR' }, querySelectorAll: () => [] },
};
vm.runInNewContext(i18nInspection, sandbox, { filename: 'src/i18n.js' });
const { STRINGS, PLACEHOLDERS, HELP } = sandbox.window.__I18N_RAW__;

const ptKeys = new Set(Object.keys(STRINGS.pt));
const enKeys = new Set(Object.keys(STRINGS.en));

for (const k of ptKeys) {
  if (!enKeys.has(k)) fail(`STRINGS.en is missing key '${k}'`);
  if (typeof STRINGS.pt[k] !== 'string' || !STRINGS.pt[k].length) fail(`STRINGS.pt.${k} is empty`);
}
for (const k of enKeys) {
  if (!ptKeys.has(k)) fail(`STRINGS.pt is missing key '${k}'`);
  if (typeof STRINGS.en[k] !== 'string' || !STRINGS.en[k].length) fail(`STRINGS.en.${k} is empty`);
}

// Check {var} interpolation placeholders match between pt and en
const varsOf = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
for (const k of ptKeys) {
  if (!enKeys.has(k)) continue;
  if (varsOf(STRINGS.pt[k]) !== varsOf(STRINGS.en[k])) {
    fail(`STRINGS.${k} placeholder mismatch: pt={${varsOf(STRINGS.pt[k])}} vs en={${varsOf(STRINGS.en[k])}}`);
  }
}

// Check PLACEHOLDERS (arrays of strings in pt and en)
if (!Array.isArray(PLACEHOLDERS.pt) || !Array.isArray(PLACEHOLDERS.en) || PLACEHOLDERS.pt.length !== PLACEHOLDERS.en.length) {
  fail(`PLACEHOLDERS count mismatch: pt=${PLACEHOLDERS.pt?.length} vs en=${PLACEHOLDERS.en?.length}`);
} else {
  for (let i = 0; i < PLACEHOLDERS.pt.length; i++) {
    if (!PLACEHOLDERS.pt[i]) fail(`PLACEHOLDERS.pt[${i}] is empty`);
    if (!PLACEHOLDERS.en[i]) fail(`PLACEHOLDERS.en[${i}] is empty`);
  }
}

// Check HELP sections, item counts and demo icons match between pt and en
if (HELP.pt.length !== HELP.en.length) {
  fail(`HELP section count mismatch: pt=${HELP.pt.length} vs en=${HELP.en.length}`);
} else {
  const mgrSrc = read('src/manager.js');
  const demoIconsBlock = mgrSrc.match(/const DEMO_ICONS = \{([\s\S]*?)\};/);
  const demoIcons = new Set(
    demoIconsBlock ? [...demoIconsBlock[1].matchAll(/(?:'([^']+)'|(\b[a-z]+))\s*:/g)].map((m) => m[1] || m[2]) : []
  );
  for (let i = 0; i < HELP.pt.length; i++) {
    if (HELP.pt[i].items.length !== HELP.en[i].items.length) {
      fail(`HELP section ${i} ('${HELP.en[i].title}') item count mismatch: pt=${HELP.pt[i].items.length} vs en=${HELP.en[i].items.length}`);
    }
    for (const lang of ['pt', 'en']) {
      for (const [topic, , demo] of HELP[lang][i].items) {
        if (!demo) continue;
        for (const m of demo.matchAll(/data-icon="([^"]+)"/g)) {
          if (!demoIcons.has(m[1])) fail(`HELP.${lang} ('${topic}'): unknown demo data-icon="${m[1]}"`);
        }
      }
    }
  }
}

// Check HTML data-i18n and data-i18n-attr references
for (const rel of ['src/index.html', 'src/group.html', 'src/manager.html']) {
  const html = read(rel);
  for (const m of html.matchAll(/\bdata-i18n="([^"]+)"/g)) {
    if (!ptKeys.has(m[1])) fail(`${rel}: unknown data-i18n="${m[1]}"`);
  }
  for (const m of html.matchAll(/\bdata-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(',')) {
      const [, key] = pair.split('=').map((s) => s.trim());
      if (!key || !ptKeys.has(key)) fail(`${rel}: unknown key '${key}' in data-i18n-attr="${m[1]}"`);
    }
  }
}

// Check JS t('key') calls
for (const rel of ['src/chrome.js', 'src/app.js', 'src/group.js', 'src/manager.js']) {
  const src = read(rel);
  for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_]+)'/g)) {
    if (!ptKeys.has(m[1])) fail(`${rel}: unknown i18n key t('${m[1]}')`);
  }
}
if (!failures) pass(`i18n (${ptKeys.size} keys, ${HELP.pt.length} Help sections in pt & en)`);

// ------------------------------------------------------------------ 5. Colours

const storeRs = read('src-tauri/src/store.rs');
const colorsMatch = storeRs.match(/pub const COLORS: \[&str; \d+\] = \[([\s\S]*?)\];/);
if (!colorsMatch) {
  fail('could not find COLORS in src-tauri/src/store.rs');
} else {
  const storeColors = [...colorsMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const baseCss = read('src/base.css');

  for (const c of storeColors) {
    if (!c) continue;
    if (!baseCss.includes(`[data-color="${c}"]`)) fail(`src/base.css is missing [data-color="${c}"]`);
    if (!baseCss.includes(`.swatch[data-color="${c}"]`)) fail(`src/base.css is missing .swatch[data-color="${c}"]`);
  }

  // Primary swatch bars in index.html (#swatches), group.html (#swatches), manager.html (#mgrSwatches)
  const expectedSwatches = storeColors.filter((c) => c !== 'lavender' && c !== '').concat(['', 'custom']);
  for (const [rel, id] of [
    ['src/index.html', 'swatches'],
    ['src/group.html', 'swatches'],
    ['src/manager.html', 'mgrSwatches'],
  ]) {
    const html = read(rel);
    const block = html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<\\/div>`));
    if (!block) {
      fail(`${rel}: missing #${id}`);
      continue;
    }
    const found = [...block[1].matchAll(/class="swatch"\s+data-color="([^"]*)"/g)].map((m) => m[1]);
    if (found.join(',') !== expectedSwatches.join(',')) {
      fail(`${rel} #${id} swatches [${found.join(',')}] != expected [${expectedSwatches.join(',')}]`);
    }
  }
  if (!failures) pass(`Colours (${storeColors.length} store colours synced across Rust, CSS and HTML)`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
