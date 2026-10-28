// Local static server for testing Memo's website and browser web app (`site/app.html`).
// Usage: `npm run web` (or `node tools/serve-web.mjs [port]`)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") {
      res.writeHead(302, { Location: "/site/app.html" });
      res.end();
      return;
    }
    // Support both `/site/src/...` (production layout where `src/` is copied into `site/src/`)
    // and `/src/...` (repo root relative path from `/site/app.html`).
    if (pathname.startsWith("/site/src/")) {
      pathname = pathname.replace(/^\/site\/src\//, "/src/");
    }
    let filePath = normalize(join(ROOT, pathname));
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Memo Web running at http://127.0.0.1:${PORT}/site/app.html`);
  console.log(`  (for OneDrive sign-in, open it as http://localhost:${PORT}/site/app.html: docs/onedrive.md)`);
  console.log(`Memo Site running at http://127.0.0.1:${PORT}/site/`);
});
