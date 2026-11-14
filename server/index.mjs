#!/usr/bin/env node
// Agent Office HTTP server. Local only: binds 127.0.0.1, rejects foreign Host/Origin headers,
// and requires a per-start token on every POST. API shapes are in contract.mjs.
//
//   node server/index.mjs [--mock] [--port 4477] [--meta-file <path>]
//   PORT sets the port too; AGENT_OFFICE_META_FILE says where names and groups are kept
//   (default ~/.agent-office/meta.json; never written with --mock).

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT as DEFAULT_PORT } from './contract.mjs';
import { createLauncher, LauncherError } from './launcher.mjs';
import { createMetaStore, createMockMeta, DEFAULT_META_FILE, MetaError } from './meta.mjs';
import { createOfficeState, probeAuth, probeVersions, resolveTools } from './state.mjs';

const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DIRS = 500;
const MAX_SSE_CLIENTS = 64;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Put the token where the UI looks for it: <meta name="office-token"> as the first thing in <head>. */
export function injectToken(html, token) {
  const meta = `<meta name="office-token" content="${escapeAttr(token)}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + '\n    ' + meta + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${meta}</head>` + html.slice(root.index + root[0].length);
  return meta + html;
}

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Agent Office</title>
    <style>
      body { margin: 0; padding: 16px; background: #14161c; color: #d8dee9; font: 13px/1.5 ui-monospace, Menlo, monospace; }
      h1 { font-size: 15px; margin: 0 0 4px; } p { margin: 0 0 12px; color: #8b93a5; }
      pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
    </style>
  </head>
  <body>
    <h1>Agent Office server is running</h1>
    <p>public/index.html does not exist yet, so this is the raw live state from /api/events.</p>
    <pre id="out">connecting…</pre>
    <script>
      const out = document.getElementById('out');
      const show = (s) => { out.textContent = JSON.stringify(s, null, 2); };
      fetch('/api/state').then((r) => r.json()).then(show).catch(() => {});
      const es = new EventSource('/api/events');
      es.onmessage = (e) => { try { show(JSON.parse(e.data)); } catch {} };
    </script>
  </body>
</html>
`;

/** Sub-directories of `dir`: plain names first, dot-directories after, each group sorted. */
export async function listDirs(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const names = [];
  for (const e of entries) {
    if (e.isDirectory()) names.push(e.name);
    else if (e.isSymbolicLink()) {
      try {
        if ((await fs.promises.stat(path.join(dir, e.name))).isDirectory()) names.push(e.name);
      } catch {
        /* dangling link */
      }
    }
  }
  const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }) || (a < b ? -1 : 1);
  const plain = names.filter((n) => !n.startsWith('.')).sort(cmp);
  const dotted = names.filter((n) => n.startsWith('.')).sort(cmp);
  const all = [...plain, ...dotted];
  return { dirs: all.slice(0, MAX_DIRS), truncated: all.length > MAX_DIRS };
}

/**
 * Build the app (nothing listens until `listen()`).
 *
 * @param {object} [o]
 * @param {number} [o.port]
 * @param {boolean} [o.mock]
 * @param {string} [o.publicDir]
 * @param {string} [o.taskDir]      launcher log directory (tests)
 * @param {string} [o.metaFile]     where names and groups are kept (default ~/.agent-office/meta.json; unused with mock)
 * @param {any} [o.adapters]        injected adapters (tests)
 * @param {Record<string, any>} [o.tools]  skip CLI detection and use these (tests)
 * @param {(line: string) => void} [o.log]
 */
export async function createApp({ port = DEFAULT_PORT, mock = false, publicDir = DEFAULT_PUBLIC, taskDir, metaFile = DEFAULT_META_FILE, adapters, tools, log = () => {} } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const publicRoot = path.resolve(publicDir);
  const home = os.homedir();

  let mockSource = null;
  if (mock) {
    const { createMock } = await import('../public/js/mock-state.js');
    mockSource = createMock();
  }
  // Which CLIs exist is known at once; their versions (and what the installed cursor-agent can do)
  // are asked for in the background so the page is up immediately. Launches wait on `ready`.
  const toolInfo = tools ? { ...tools } : mock ? {} : resolveTools();

  /** @type {ReturnType<typeof createOfficeState>} */
  let office;
  /** @type {NodeJS.Timeout|null} */
  let authTimer = null;
  // Names and groups. With --mock they live in the generator, so nothing is written to disk.
  const meta = mockSource ? createMockMeta(mockSource) : createMetaStore({ file: path.resolve(metaFile), log });
  const launcher = createLauncher({ tools: toolInfo, mock: mockSource, meta, ...(taskDir ? { dir: taskDir } : {}), onChange: () => office?.requestRefresh() });
  office = createOfficeState({ mock: mockSource, meta, tools: toolInfo, adapters, getTasks: () => launcher.list(), log });
  const ready = (
    mock || tools
      ? Promise.resolve()
      : probeVersions(toolInfo).then(() => office.setTools(toolInfo))
  )
    .then(() => {
      if (mock || tools) return;
      // Sign-in state can change while the office is open (the fix is `claude auth login` in a terminal),
      // so keep asking, off the critical path.
      const check = () =>
        probeAuth(toolInfo)
          .then(() => office.setTools(toolInfo))
          .catch(() => {});
      check();
      authTimer = setInterval(check, 60_000);
      authTimer.unref?.();
    })
    .then(() => launcher.ready())
    .catch((err) => log(`tool detection failed: ${err?.message || err}`));

  /** @type {Set<{res: http.ServerResponse, cleanup: () => void}>} */
  const streams = new Set();
  let boundPort = port;

  const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);

  function checkHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts().has(host)) throw new HttpError(403, 'forbidden: this server only answers to 127.0.0.1 / localhost');
  }

  function checkSameOrigin(req) {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins().has(String(origin).toLowerCase())) throw new HttpError(403, 'forbidden: cross-origin request');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'forbidden: cross-site request');
  }

  function checkToken(req) {
    const given = Buffer.from(String(req.headers['x-office-token'] || ''));
    if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) throw new HttpError(403, 'missing or invalid X-Office-Token');
  }

  function readJsonBody(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`);
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          done = true;
          reject(new HttpError(413, `request body too large (max ${MAX_BODY_BYTES} bytes)`, { Connection: 'close' }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
          body = text.trim() ? JSON.parse(text) : {};
        } catch {
          return reject(new HttpError(400, 'request body is not valid JSON'));
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(new HttpError(400, 'request body must be a JSON object'));
        resolve(body);
      });
      req.on('error', () => {
        if (!done) reject(new HttpError(400, 'could not read request body'));
        done = true;
      });
    });
  }

  // ---- static files ----

  async function serveIndex(req, res, file) {
    let html;
    try {
      html = await fs.promises.readFile(file, 'utf8');
    } catch {
      html = PLACEHOLDER_HTML;
    }
    const body = Buffer.from(injectToken(html, token));
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': MIME['.html'],
      'Content-Length': body.length,
      // The lab page frames the concept pages, so same-origin framing is allowed; nothing else may frame us.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function serveStatic(req, res, rawPath) {
    let rel;
    try {
      rel = decodeURIComponent(rawPath);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    if (rel.includes('\0') || rel.includes('\\')) throw new HttpError(400, 'bad path');
    // No dot-files, and no dot-dot in any form: a segment starting with "." is never served.
    if (rel.split('/').some((seg) => seg.startsWith('.'))) throw new HttpError(404, 'not found');
    if (rel.endsWith('/')) rel += 'index.html';
    const target = path.join(publicRoot, rel);
    if (target !== publicRoot && !target.startsWith(publicRoot + path.sep)) throw new HttpError(403, 'forbidden');
    if (target === path.join(publicRoot, 'index.html')) return serveIndex(req, res, target);

    let real;
    let st;
    try {
      real = await fs.promises.realpath(target);
      st = await fs.promises.stat(real);
    } catch {
      throw new HttpError(404, 'not found');
    }
    // A symlink inside public/ must not lead out of it.
    let realRoot = publicRoot;
    try {
      realRoot = await fs.promises.realpath(publicRoot);
    } catch {
      /* keep the unresolved root */
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(403, 'forbidden');
    if (st.isDirectory()) {
      if (!rawPath.endsWith('/')) {
        res.writeHead(302, { ...BASE_HEADERS, Location: `${rawPath}/` });
        return res.end();
      }
      throw new HttpError(404, 'not found');
    }
    if (!st.isFile()) throw new HttpError(404, 'not found');
    const ext = path.extname(real).toLowerCase();
    if (ext === '.html') {
      // Any page of the app may need to POST, so every HTML page gets the token.
      return serveIndex(req, res, real);
    }
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---- API ----

  function openEvents(req, res) {
    if (streams.size >= MAX_SSE_CLIENTS) throw new HttpError(503, 'too many open event streams');
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    const send = (state) => {
      if (res.writableEnded || res.destroyed) return;
      // A client that stopped reading must not make the server buffer without bound.
      if (res.writableLength > 8 * 1024 * 1024) return res.destroy();
      res.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    send(office.getState());
    const unsubscribe = office.subscribe(send);
    const beat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, SSE_HEARTBEAT_MS);
    beat.unref?.();
    const entry = {
      res,
      cleanup() {
        clearInterval(beat);
        unsubscribe();
        streams.delete(entry);
      },
    };
    streams.add(entry);
    req.on('close', entry.cleanup);
    res.on('error', entry.cleanup);
  }

  async function apiDirs(res, query) {
    const asked = query.get('path');
    const target = asked === null || asked === '' ? home : asked;
    if (target.includes('\0') || !path.isAbsolute(target)) throw new HttpError(400, 'path must be an absolute path');
    const dir = path.resolve(target);
    let st;
    try {
      st = await fs.promises.stat(dir);
    } catch {
      throw new HttpError(404, `no such directory: ${dir}`);
    }
    if (!st.isDirectory()) throw new HttpError(400, `not a directory: ${dir}`);
    let listing;
    try {
      listing = await listDirs(dir);
    } catch (err) {
      throw new HttpError(err?.code === 'EACCES' || err?.code === 'EPERM' ? 403 : 500, `cannot read directory: ${dir}`);
    }
    const parent = path.dirname(dir);
    sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs: listing.dirs, ...(listing.truncated ? { truncated: true } : {}), home });
  }

  async function handleApi(req, res, segments, query) {
    const method = req.method;
    const [, a, b, c] = segments; // ['api', a, b, c]
    const n = segments.length;
    const allow = (...methods) => {
      if (!methods.includes(method)) throw new HttpError(405, `method ${method} not allowed here`, { Allow: methods.join(', ') });
    };
    checkSameOrigin(req);

    if (n === 2 && a === 'state') {
      allow('GET');
      return sendJson(res, 200, office.getState());
    }
    if (n === 2 && a === 'meta') {
      allow('GET');
      await ready; // the Cursor notes depend on which cursor-agent build is installed
      return sendJson(res, 200, { permissionNotes: launcher.permissionNotes(), port: boundPort, mock: Boolean(mock) });
    }
    if (n === 2 && a === 'events') {
      allow('GET');
      return openEvents(req, res);
    }
    if (n === 2 && a === 'dirs') {
      allow('GET');
      return apiDirs(res, query);
    }
    if (n === 4 && a === 'sessions' && c === 'transcript') {
      allow('GET');
      const limitRaw = query.get('limit');
      const limit = limitRaw === null ? 60 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) throw new HttpError(400, 'limit must be a positive integer');
      const messages = await office.getTranscript(b, Math.min(limit, 500));
      if (messages === null) throw new HttpError(404, 'unknown session');
      return sendJson(res, 200, { messages });
    }
    if (n === 2 && a === 'tasks') {
      allow('POST');
      checkToken(req);
      const body = await readJsonBody(req);
      await ready;
      const task = await launcher.start(body);
      office.refresh();
      return sendJson(res, 201, { task });
    }
    if (n === 4 && a === 'sessions' && c === 'message') {
      allow('POST');
      checkToken(req);
      const body = await readJsonBody(req);
      const session = office.findSession(b);
      // Resuming a session that is in the middle of a turn would have two processes writing one
      // conversation. Refuse unless the caller insists.
      if (!mock && session?.status === 'working' && body.force !== true) {
        throw new HttpError(409, 'this session is in the middle of a turn; wait for it to finish (or send "force": true)');
      }
      await ready;
      const task = await launcher.followUp(b, body, session);
      office.refresh();
      return sendJson(res, 201, { task });
    }
    // Naming and grouping. The store tells the office about every change, so SSE clients see it at once.
    if (n === 4 && a === 'sessions' && c === 'meta') {
      allow('POST');
      checkToken(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, meta.setSessionMeta(b, { label: body.label, groupId: body.groupId }));
    }
    if (n === 2 && a === 'groups') {
      allow('POST');
      checkToken(req);
      const body = await readJsonBody(req);
      return sendJson(res, 201, { group: meta.createGroup(body) });
    }
    if (n === 3 && a === 'groups') {
      allow('POST');
      checkToken(req);
      const body = await readJsonBody(req);
      return sendJson(res, 200, { group: meta.updateGroup(b, body) });
    }
    if (n === 4 && a === 'groups' && c === 'delete') {
      allow('POST');
      checkToken(req);
      await readJsonBody(req);
      meta.deleteGroup(b);
      return sendJson(res, 200, { ok: true });
    }
    if (n === 4 && a === 'tasks' && c === 'stop') {
      allow('POST');
      checkToken(req);
      await readJsonBody(req);
      const task = launcher.stop(b);
      office.refresh();
      return sendJson(res, 200, { task });
    }
    throw new HttpError(404, 'no such API route');
  }

  async function handle(req, res) {
    checkHost(req);
    const url = String(req.url || '');
    if (!url.startsWith('/')) throw new HttpError(400, 'bad request');
    const cut = url.indexOf('?');
    const rawPath = cut < 0 ? url : url.slice(0, cut);
    const query = new URLSearchParams(cut < 0 ? '' : url.slice(cut + 1));

    if (rawPath === '/api' || rawPath.startsWith('/api/')) {
      let segments;
      try {
        segments = rawPath.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
      } catch {
        throw new HttpError(400, 'bad path');
      }
      return handleApi(req, res, segments, query);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, `method ${req.method} not allowed here`, { Allow: 'GET, HEAD' });
    return serveStatic(req, res, rawPath === '/' ? '/index.html' : rawPath);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const known = err instanceof HttpError || err instanceof LauncherError || err instanceof MetaError;
      const status = known ? err.status : 500;
      if (status >= 500 && !known) log(`error: ${req.method} ${String(req.url).split('?')[0]}: ${err?.message || err}`);
      if (res.headersSent) return res.destroy();
      // The rest of an oversized upload is not read: answer, then drop the connection.
      if (status === 413) res.once('finish', () => req.socket?.destroy());
      sendJson(res, status, { error: status === 500 ? 'internal error' : err.message }, err.headers || {});
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  function listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(port, HOST, () => {
        server.off('error', onError);
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        office.start();
        resolve(boundPort);
      });
    });
  }

  /** Stop serving. Runs started from the office are detached and keep going. */
  function close() {
    if (authTimer) clearInterval(authTimer);
    for (const entry of [...streams]) {
      entry.cleanup();
      entry.res.end();
    }
    office.stop();
    launcher.close();
    meta.close(); // writes any name or group change that was still waiting
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    server,
    listen,
    close,
    token,
    office,
    launcher,
    meta,
    ready,
    get port() {
      return boundPort;
    },
    get url() {
      return `http://${HOST}:${boundPort}`;
    },
  };
}

export function parseArgs(argv, env = process.env) {
  let mock = false;
  let port = env.PORT !== undefined && env.PORT !== '' ? env.PORT : DEFAULT_PORT;
  let metaFile = env.AGENT_OFFICE_META_FILE || undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mock') mock = true;
    else if (arg === '--port') port = argv[++i];
    else if (arg.startsWith('--port=')) port = arg.slice(7);
    else if (arg === '--meta-file') metaFile = argv[++i] || '';
    else if (arg.startsWith('--meta-file=')) metaFile = arg.slice(12);
    else if (arg === '-h' || arg === '--help') return { help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid port: ${port}`);
  if (metaFile !== undefined && (typeof metaFile !== 'string' || !metaFile || metaFile.includes('\0'))) throw new Error('--meta-file needs a file path');
  return { mock, port: n, ...(metaFile !== undefined ? { metaFile: path.resolve(metaFile) } : {}) };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`agent-office: ${err.message}\nusage: node server/index.mjs [--mock] [--port <n>] [--meta-file <path>]`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('usage: node server/index.mjs [--mock] [--port <n>] [--meta-file <path>]\n  PORT env also sets the port (default 4477). Names and groups are kept in ~/.agent-office/meta.json\n  unless --meta-file or AGENT_OFFICE_META_FILE says otherwise.');
    return;
  }
  const app = await createApp({ port: opts.port, mock: opts.mock, ...(opts.metaFile ? { metaFile: opts.metaFile } : {}), log: (line) => console.error(`[agent-office] ${line}`) });
  try {
    await app.listen();
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(`agent-office: port ${opts.port} on 127.0.0.1 is already in use. Is Agent Office already running? Stop it, or choose another port with --port <n> (or PORT=<n>).`);
    } else {
      console.error(`agent-office: could not start: ${err?.message || err}`);
    }
    app.launcher.close();
    app.office.stop();
    app.meta.close();
    process.exit(1);
  }
  console.log(`Agent Office is running at ${app.url}${opts.mock ? '  (mock data)' : ''}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) process.exit(1);
    stopping = true;
    // Anything started from the office keeps running; only the server goes away.
    const hard = setTimeout(() => process.exit(0), 6500);
    hard.unref();
    app.close().then(() => {
      console.log(`Agent Office stopped (${signal}).`);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    console.error(`agent-office: ${err?.stack || err}`);
    process.exit(1);
  });
}
