// claude-agent-pipeline — local UI server.
// Binds 127.0.0.1 only. Serves the dashboard + a documented HTTP/SSE wrapper
// around the public api/.
//
// HTTP surface (v1):
//   GET /                       → dashboard SPA
//   GET /api/v1/snapshot        → JSON Snapshot
//   GET /api/v1/ticket/:id      → JSON Ticket | 404
//   GET /api/v1/agent/:name     → JSON Agent  | 404
//   GET /api/v1/events          → text/event-stream of WatcherEvent
//   GET /api/v1/log?limit=N     → text/event-stream of RunEvent (with runId added)
//
// No runtime dependencies. Node stdlib only.

import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createWatcher, getAgent, getTicket, readSnapshot } from '../api/index.js';
import { createLogStream } from './log-stream.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

/**
 * @param {{ target: string, port?: number, host?: string, pluginRoot?: string,
 *           devReload?: boolean }} opts
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export function startServer(opts) {
  const target = resolve(opts.target);
  const host = opts.host || '127.0.0.1';
  const pluginRoot = opts.pluginRoot;
  // A fresh id per server process. The dashboard records it on first connect
  // and reloads itself when it sees a new one — that's how `ui --watch` makes a
  // server restart show up in the browser without a manual refresh.
  const bootId = randomUUID();
  const devReload = !!opts.devReload;
  const apiOpts = { target, pluginRoot, bootId, devReload };

  // One shared watcher per server; each SSE client gets its own listener.
  const watcher = createWatcher({ target, pluginRoot });
  const sseClients = new Set();
  watcher.on('event', ev => {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch {}
    }
  });
  watcher.on('error', err => {
    const frame = `event: error\ndata: ${JSON.stringify({ message: String(err?.message || err) })}\n\n`;
    for (const res of sseClients) { try { res.write(frame); } catch {} }
  });

  // Tail every runs/logs/*.events.jsonl and fan out to /api/v1/log subscribers.
  const logStream = createLogStream({ target });
  const logClients = new Set();
  logStream.on('event', ev => {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of logClients) { try { res.write(frame); } catch {} }
  });

  const server = createHttpServer((req, res) => {
    try { route(req, res, apiOpts, sseClients, logClients, logStream); }
    catch (err) { sendJson(res, 500, { error: String(err?.message || err) }); }
  });

  return new Promise((resolveStart, rejectStart) => {
    const tryListen = (port, attempts) => {
      server.once('error', err => {
        if (err.code === 'EADDRINUSE' && attempts > 0) tryListen(port + 1, attempts - 1);
        else rejectStart(err);
      });
      server.listen(port, host, () => {
        const actualPort = server.address().port;
        resolveStart({
          url: `http://${host}:${actualPort}/`,
          port: actualPort,
          close: () =>
            new Promise(closed => {
              for (const c of sseClients) { try { c.end(); } catch {} }
              for (const c of logClients) { try { c.end(); } catch {} }
              sseClients.clear();
              logClients.clear();
              watcher.close();
              logStream.close();
              server.close(() => closed());
            }),
        });
      });
    };
    tryListen(opts.port ?? 7456, 20);
  });
}

function route(req, res, apiOpts, sseClients, logClients, logStream) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });

  // CORS for localhost tooling
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (path === '/' || path === '/index.html') return sendStatic(res, 'index.html');
  if (path.startsWith('/public/'))            return sendStatic(res, path.replace(/^\/public\//, ''));
  // Any root-level asset with a known extension (app.js, pipeline.js,
  // pipeline-graph.js, style.css, favicon.ico, …). Single-segment only, so it
  // never shadows the /api/ routes below; sendStatic guards path traversal and
  // 404s anything missing.
  if (path !== '/' && !path.includes('/', 1) && extname(path) in MIME)
    return sendStatic(res, path.slice(1));

  if (path === '/api/v1/snapshot') {
    return sendJson(res, 200, readSnapshot(apiOpts));
  }
  const t = path.match(/^\/api\/v1\/ticket\/([^/]+)$/);
  if (t) {
    const tk = getTicket(apiOpts, decodeURIComponent(t[1]));
    return tk ? sendJson(res, 200, tk) : sendJson(res, 404, { error: 'ticket not found' });
  }
  const a = path.match(/^\/api\/v1\/agent\/([^/]+)$/);
  if (a) {
    const ag = getAgent(apiOpts, decodeURIComponent(a[1]));
    return ag ? sendJson(res, 200, ag) : sendJson(res, 404, { error: 'agent not found' });
  }
  if (path === '/api/v1/events') return openSse(req, res, sseClients, apiOpts);
  if (path === '/api/v1/log')    return openLogSse(req, res, logClients, logStream, url);

  return sendJson(res, 404, { error: 'not found', path });
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function sendStatic(res, relPath) {
  // Path-traversal guard: must stay inside PUBLIC_DIR.
  const abs = normalize(join(PUBLIC_DIR, relPath));
  if (!abs.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  if (!existsSync(abs) || !statSync(abs).isFile()) return sendJson(res, 404, { error: 'not found' });
  const body = readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function openLogSse(req, res, logClients, logStream, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Replay the most recent N events so a freshly-opened browser sees context.
  const limit = Number(url.searchParams.get('limit') || 100);
  for (const ev of logStream.snapshot({ limit })) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  logClients.add(res);
  const beat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 25_000);
  beat.unref?.();
  req.on('close', () => {
    clearInterval(beat);
    logClients.delete(res);
  });
}

function openSse(req, res, sseClients, apiOpts) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Greet first so the client learns this process's bootId before any data.
  // On a `ui --watch` restart the client sees a new bootId and reloads itself.
  res.write(`data: ${JSON.stringify({ type: 'hello', bootId: apiOpts.bootId, devReload: apiOpts.devReload })}\n\n`);
  // Replay current state immediately so a fresh client gets a snapshot
  // even if it connected after the watcher's initial emit.
  try {
    const snap = readSnapshot(apiOpts);
    res.write(`data: ${JSON.stringify({ type: 'snapshot', data: snap })}\n\n`);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: String(err?.message || err) })}\n\n`);
  }
  sseClients.add(res);
  // Heartbeat keeps proxies and idle TCP from killing the connection.
  const beat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 25_000);
  beat.unref?.();
  req.on('close', () => {
    clearInterval(beat);
    sseClients.delete(res);
  });
}
