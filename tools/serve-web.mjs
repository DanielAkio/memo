// Local static server for testing Memo's website and browser web app (`site/app.html`).
// Usage: `npm run web` (or `node tools/serve-web.mjs [port]`)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 3000);

// Optional `.env` loader so local Google Drive web sync works with MEMO_GOOGLE_WEB_CLIENT_ID
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};

// Memo Web runs locally only as http://localhost:<port>: Google and Microsoft
// sign-in each know one origin, and localStorage differs per origin, so a
// visit through 127.0.0.1 goes to the same address on localhost.
export function localhostRedirect(host, path) {
  const m = /^127\.0\.0\.1(:\d+)?$/.exec(host || "");
  return m ? `http://localhost${m[1] || ""}${path || "/"}` : null;
}

// The site is served as in production (GitHub Pages, pages.yml): `site/` at
// /memo/, with `src/` copied into it (/memo/src/). `{ redirect }` for the
// addresses that move there (/, /memo, the old /site/...), else the repo
// path to serve.
export function localPath(pathname) {
  if (pathname === "/" || pathname === "/memo") return { redirect: "/memo/app.html" };
  if (pathname === "/site" || pathname.startsWith("/site/")) {
    return { redirect: `/memo${pathname.slice("/site".length) || "/"}` };
  }
  if (pathname.startsWith("/memo/src/")) return { path: pathname.slice("/memo".length) };
  if (pathname.startsWith("/memo/")) return { path: `/site${pathname.slice("/memo".length)}` };
  return { path: pathname };
}

const server = createServer(async (req, res) => {
  try {
    const moved = localhostRedirect(req.headers.host, req.url);
    if (moved) {
      res.writeHead(302, { Location: moved });
      res.end();
      return;
    }
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const local = localPath(decodeURIComponent(url.pathname));
    if (local.redirect) {
      res.writeHead(302, { Location: local.redirect + url.search });
      res.end();
      return;
    }
    let filePath = normalize(join(ROOT, local.path));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    let info = await stat(filePath).catch(() => null);
    if (info && info.isDirectory()) {
      filePath = join(filePath, "index.html");
      info = await stat(filePath).catch(() => null);
    }
    if (!info || !info.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    let body = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    if (filePath.endsWith(join("site", "app.html"))) {
      const clientId = process.env.MEMO_GOOGLE_WEB_CLIENT_ID || process.env.GOOGLE_WEB_CLIENT_ID || process.env.MEMO_GOOGLE_CLIENT_ID || "";
      const microsoftId = process.env.MEMO_MICROSOFT_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || "";
      let html = body.toString("utf8");
      if (clientId) {
        html = html.replace(/(<meta\s+name="memo-google-client-id"\s+content=")([^"]*)"/, `$1${clientId}"`);
      }
      if (microsoftId) {
        html = html.replace(/(<meta\s+name="memo-microsoft-client-id"\s+content=")([^"]*)"/, `$1${microsoftId}"`);
      }
      body = Buffer.from(html, "utf8");
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
});

// Bound to 127.0.0.1 (localhost resolves to it; 127.0.0.1 itself redirects).
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Memo Web running at http://localhost:${PORT}/memo/app.html`);
    console.log(`Memo Site running at http://localhost:${PORT}/memo/`);
  });
}
