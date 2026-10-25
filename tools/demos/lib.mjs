// Recording and testing helpers for the real app pages (src/) in a fake
// desktop (stage.html) with a fake Tauri API (mock.js).
import { createRequire } from 'module';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');

// Playwright from the repo (npm install --no-save playwright) or a global install.
function playwright() {
  try {
    return createRequire(path.join(ROOT, 'package.json'))('playwright');
  } catch {
    const global = execSync('npm root -g').toString().trim();
    return createRequire(path.join(global, 'noop.js'))('playwright');
  }
}

async function launchChromium(chromium) {
  for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await chromium.launch(opts);
    } catch {
      // try next browser channel
    }
  }
  return chromium.launch();
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Serves the repository, so the stage (/tools/demos/stage.html) and the
// app's pages (/src/…) share an origin.
export function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (urlPath === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

export async function open({ port, theme, lang }) {
  const { chromium } = playwright();
  const browser = await launchChromium(chromium);
  const ctx = await browser.newContext({
    viewport: { width: 960, height: 540 }, deviceScaleFactor: 2,
    colorScheme: theme, locale: lang === 'pt' ? 'pt-BR' : 'en-US',
  });
  await ctx.addInitScript(fs.readFileSync(path.join(here, 'mock.js'), 'utf8'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(`console: ${m.text()}`);
      console.log('console:', m.text());
    }
  });
  page.on('pageerror', (e) => {
    errors.push(`pageerror: ${e.message}`);
    console.log('pageerror:', e.message);
  });
  await page.goto(`http://127.0.0.1:${port}/tools/demos/stage.html?theme=${theme}&lang=${lang}`);
  return { browser, page, errors };
}

export class Rec {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.frames = [];
    this.x = 480; this.y = 300;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  async shot(ms) {
    const file = path.join(this.dir, `${String(this.frames.length).padStart(4, '0')}.png`);
    await this.page.screenshot({ path: file, caret: 'initial' });
    this.frames.push([file, ms]);
  }
  async hold(ms) { await this.page.waitForTimeout(Math.min(ms, 120)); await this.shot(ms); }
  async cursor(kind) { await this.page.evaluate(([x, y, k]) => window.Memo.cursor(x, y, k), [this.x, this.y, kind]); }
  // Moves the mouse along an eased path, a frame every ~33 ms. `drag(dx, dy)`
  // runs on each step (the stage moves a window being dragged).
  async move(x, y, ms = 500, { drag = null } = {}) {
    const steps = Math.max(2, Math.round(ms / 33));
    const x0 = this.x, y0 = this.y;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.x = x0 + (x - x0) * e; this.y = y0 + (y - y0) * e;
      await this.page.mouse.move(this.x, this.y);
      if (drag) await drag(this.x - x0, this.y - y0);
      await this.cursor();
      await this.shot(33);
    }
  }
  async click({ after = 200 } = {}) {
    await this.page.mouse.down(); await this.page.mouse.up();
    await this.page.waitForTimeout(80);
    await this.shot(after);
  }
  async type(text, ms = 70) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.page.waitForTimeout(20);
      await this.shot(ms);
    }
  }
  async press(key, ms = 250) { await this.page.keyboard.press(key); await this.page.waitForTimeout(60); await this.shot(ms); }

  // Frames -> a 960 px wide GIF (palette per GIF, only changed areas redrawn).
  encode(out) {
    const list = path.join(this.dir, 'list.txt');
    const last = this.frames[this.frames.length - 1][0];
    fs.writeFileSync(list, this.frames.map(([f, ms]) => `file '${f}'\nduration ${(ms / 1000).toFixed(3)}\n`).join('') + `file '${last}'\n`);
    const vf = 'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];'
      + '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-vsync', 'vfr', out]);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
