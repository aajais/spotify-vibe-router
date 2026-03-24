import http from "node:http";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { config } from "./config.mjs";
import { logger, initWandb, logWandbError, finishWandb } from "./logger.mjs";
import { pollOnce, startPolling, stopPolling } from "./poller.mjs";
import { routes } from "./routes.mjs";

/* ── static file serving ─────────────────────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

/* ── inline PWA assets ───────────────────────────────────── */

const MANIFEST_JSON = JSON.stringify({
  name: "Spotify Vibe Router",
  short_name: "Vibe Router",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#060a08",
  theme_color: "#06331D",
  description: "Automated Spotify vibe routing dashboard",
  icons: [
    { src: "/icon.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any maskable" },
    { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" }
  ]
});

const SW_JS = `
const CACHE = 'vibe-router-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
`;

const ICON_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#8DC4AA'/><stop offset='100%' stop-color='#1E5E3F'/></linearGradient></defs><rect width='512' height='512' rx='96' fill='#060a08'/><circle cx='256' cy='256' r='182' fill='url(#g)' opacity='0.18'/><path d='M130 300c60-72 192-72 252 0' stroke='#DAF7E9' stroke-width='28' fill='none' stroke-linecap='round'/><path d='M164 256c44-52 140-52 184 0' stroke='#8DC4AA' stroke-width='24' fill='none' stroke-linecap='round'/><circle cx='256' cy='338' r='24' fill='#DAF7E9'/></svg>`;

/* ── legacy HTML redirects ───────────────────────────────── */

const LEGACY_TAB_REDIRECTS = new Map([
  ["/analytics", "analytics"],
  ["/logs", "logs"],
  ["/system", "system"],
  ["/dashboard", "dashboard"],
]);

/* ── HTTP server ─────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Inline PWA assets
    if (u.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(MANIFEST_JSON);
      return;
    }
    if (u.pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
      res.end(SW_JS);
      return;
    }
    if (u.pathname === "/icon.svg") {
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
      res.end(ICON_SVG);
      return;
    }

    // Legacy HTML routes → redirect to SPA tabs
    const legacyTab = LEGACY_TAB_REDIRECTS.get(u.pathname);
    if (legacyTab) {
      res.writeHead(302, { Location: `/?tab=${legacyTab}` });
      res.end();
      return;
    }

    // API route handlers
    const handler = routes.get(u.pathname);
    if (handler) {
      await handler(req, res, u);
      return;
    }

    // Serve "/" → public/index.html
    if (u.pathname === "/") {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      if (serveStatic(res, indexPath)) return;
    }

    // Serve static files from public/
    const safePath = path.normalize(u.pathname).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath)) {
      if (serveStatic(res, filePath)) return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  } catch (err) {
    logger.error("request error", { error: err?.message ?? String(err) });
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err?.stack ?? err));
  }
});

/* ── graceful shutdown ───────────────────────────────────── */

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    logger.info(`Received ${sig}, shutting down...`);
    stopPolling();
    server.close();
    await finishWandb();
    process.exit(0);
  });
}

/* ── start ───────────────────────────────────────────────── */

server.listen(config.PORT, "127.0.0.1", async () => {
  if (config.WANDB_ENABLED) {
    await initWandb({
      entity: config.WANDB_ENTITY,
      project: config.WANDB_PROJECT,
      service: "spotify-vibe-router-lite"
    });
  }

  logger.info(`spotify-vibe-router running: http://127.0.0.1:${config.PORT}`);
  logger.info(`Login: http://127.0.0.1:${config.PORT}/login`);
  logger.info(`Redirect URI: ${config.REDIRECT_URI}`);

  // Start poll interval
  setInterval(() => {
    pollOnce()
      .then(r => logger.info(`[poll] processed=${r.processed} added=${r.added}`))
      .catch(async e => {
        const message = e?.message ?? String(e);
        logger.error("[poll]", { error: message });
        await logWandbError({
          phase: "poll-loop",
          message,
          stack: e?.stack ?? null,
          atMs: Date.now()
        });
      });
  }, config.POLL_MINUTES * 60_000);
});
