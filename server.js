import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandIcs, icsName } from './lib/ics.js';
import { createGoogle } from './lib/google.js';
import { createApple } from './lib/apple.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(APP_DIR, '.env'));
} catch {
}

const ROOT = path.join(APP_DIR, 'public');
const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BYTES = 15 * 1024 * 1024;
const CACHE_MS = 60 * 1000;

const DATA_DIR = process.env.DATA_DIR || path.join(APP_DIR, 'data');
const google = createGoogle({
  dataDir: DATA_DIR,
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: `http://localhost:${PORT}/auth/google/callback`,
});
const apple = createApple(
  process.env.CALDAV_BASE
    ? { dataDir: DATA_DIR, base: process.env.CALDAV_BASE, allowHost: (h) => h === new URL(process.env.CALDAV_BASE).hostname }
    : { dataDir: DATA_DIR },
);
const accounts = { google, apple };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw Object.assign(new Error('That is not a valid link.'), { status: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error('Only http(s) and webcal links are supported.'), { status: 400 });
  }
  const { address } = await lookup(url.hostname).catch(() => {
    throw Object.assign(new Error(`Couldn't find ${url.hostname}.`), { status: 502 });
  });
  if (isPrivateIp(address)) {
    throw Object.assign(new Error('Local network addresses are not allowed.'), { status: 400 });
  }
  return url;
}

const cache = new Map();

async function fetchFeed(raw) {
  let url = await assertPublicUrl(raw);
  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;

  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'clock-calendar/0.1', accept: 'text/calendar, */*' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    if (!res.ok) {
      throw Object.assign(new Error(`The calendar server answered ${res.status}.`), { status: 502 });
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw Object.assign(new Error('That calendar is too large.'), { status: 502 });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw Object.assign(new Error('That calendar is too large.'), { status: 502 });
    if (!text.includes('BEGIN:VCALENDAR')) {
      throw Object.assign(new Error("That link didn't return a calendar (.ics) file."), { status: 502 });
    }
    cache.set(raw, { at: Date.now(), text });
    cache.set(url.href, { at: Date.now(), text });
    return text;
  }
  throw Object.assign(new Error('Too many redirects.'), { status: 502 });
}

async function handleEvents(req, res, params) {
  const raw = params.get('url');
  const from = new Date(params.get('from'));
  const to = new Date(params.get('to'));
  if (!raw || isNaN(from) || isNaN(to) || to <= from) {
    return sendJson(res, 400, { error: 'Missing url, from or to.' });
  }
  try {
    const text = await fetchFeed(raw);
    let events;
    try {
      events = expandIcs(text, from, to);
    } catch {
      return sendJson(res, 502, { error: "That calendar file couldn't be read." });
    }
    sendJson(res, 200, { name: icsName(text), events });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'The calendar server took too long.' : err.message;
    sendJson(res, err.status || 502, { error: msg });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' }).end();
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Bad request.'), { status: 400 });
  }
}

function range(params) {
  const from = new Date(params.get('from'));
  const to = new Date(params.get('to'));
  if (isNaN(from) || isNaN(to) || to <= from) throw Object.assign(new Error('Missing from or to.'), { status: 400 });
  return { from, to };
}

async function handleGoogleAuth(req, res, pathname, params) {
  try {
    await google.ready;
    if (!google.configured) return redirect(res, '/?google=not-set-up');
    if (pathname === '/auth/google/start') return redirect(res, google.startUrl());
    if (params.get('error')) return redirect(res, `/?google=${encodeURIComponent(params.get('error'))}`);
    await google.finish(params.get('code'), params.get('state'));
    return redirect(res, '/?google=connected');
  } catch (err) {
    return redirect(res, `/?google=${encodeURIComponent(err.message)}`);
  }
}

async function handleAccount(req, res, source, action, params) {
  const acct = accounts[source];
  try {
    await acct.ready;
    if (req.method === 'GET') {
      if (action === 'status') return sendJson(res, 200, await acct.status());
      if (action === 'events') {
        const { from, to } = range(params);
        return sendJson(res, 200, { events: await acct.events(from, to) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Not allowed.' });
    const body = await readJson(req);
    switch (`${source}/${action}`) {
      case 'google/setup':
        await google.saveClient(body.clientId, body.clientSecret);
        return sendJson(res, 200, await google.status());
      case 'apple/connect':
        return sendJson(res, 200, await apple.connect(body.appleId, body.password));
    }
    if (action === 'disconnect') {
      await acct.disconnect();
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'create') {
      if (!body.start || !body.end) return sendJson(res, 400, { error: 'Missing start or end.' });
      return sendJson(res, 200, { event: await acct.create(body) });
    }
    if (action === 'update') {
      await acct.update(body);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'delete') {
      await acct.remove(body);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const msg = err.name === 'TimeoutError' ? 'The calendar server took too long.' : err.message;
    return sendJson(res, err.status || 502, { error: msg });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const acct = /^\/api\/(google|apple)\/([a-z]+)$/.exec(pathname);
  const allowed = req.method === 'GET' || req.method === 'HEAD' || (req.method === 'POST' && acct);
  if (!allowed) return res.writeHead(405).end();
  if (acct) return handleAccount(req, res, acct[1], acct[2], searchParams);
  if (pathname === '/auth/google/start' || pathname === '/auth/google/callback') {
    return handleGoogleAuth(req, res, pathname, searchParams);
  }
  if (pathname === '/api/events') return handleEvents(req, res, searchParams);
  return serveStatic(res, pathname);
});

server.listen(PORT, HOST, async () => {
  console.log(`Clock calendar running at http://localhost:${PORT}`);
  await google.ready;
  console.log(google.configured ? 'Google sync: ready to connect' : 'Google sync: set up from the app settings');
});
