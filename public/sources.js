import * as googleBrowser from './google-browser.js';

const CONFIG_KEY = 'clockcal.config.v1';

export const PALETTE = ['#e8735a', '#e9b949', '#5db88a', '#5b9bd5', '#a685d6', '#e57fa3'];

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  },
};

export function loadConfig() {
  const c = store.get(CONFIG_KEY, {});
  return {
    ...c,
    sources: Array.isArray(c.sources) ? c.sources : [],
    google: { enabled: false, ...(c.google || {}) },
    apple: { enabled: false, ...(c.apple || {}) },
  };
}

export function saveConfig(config) {
  store.set(CONFIG_KEY, config);
}

export function nextColor(config) {
  const used = new Set(config.sources.map((s) => s.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[config.sources.length % PALETTE.length];
}

function parseDateOnly(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function normalize(raw, extra) {
  const start = raw.allDay ? parseDateOnly(raw.start) : new Date(raw.start);
  const end = raw.allDay ? parseDateOnly(raw.end) : new Date(raw.end);
  return { title: raw.title, allDay: raw.allDay, start, end, ...extra };
}

async function fetchIcs(source, from, to) {
  if (!(await serverMode)) throw new Error('Calendar links only work in the version running on your computer.');
  const q = new URLSearchParams({ url: source.url, from: from.toISOString(), to: to.toISOString() });
  const res = await fetch(`/api/events?${q}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return {
    name: body.name || '',
    events: body.events.map((e, i) =>
      normalize(e, { id: `${source.id}:${e.uid}:${e.start}:${i}`, color: source.color, sourceId: source.id }),
    ),
  };
}

export const ACCOUNTS = { google: 'Google Calendar', apple: 'iCloud' };

export const GOOGLE_EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

export const serverMode = fetch('api/ping')
  .then(async (r) => r.ok && (await r.json().catch(() => ({}))).ok === true)
  .catch(() => false);
let onServer = true;
serverMode.then((v) => {
  onServer = v;
  if (!v) googleBrowser.preload().catch(() => {});
});
export const googleConnectInBrowser = () => googleBrowser.connect();
export const googleNeedsReconnect = () => !onServer && googleBrowser.needsReconnect();

const BROWSER_ACTIONS = {
  create: async (b) => ({ event: await googleBrowser.create(b) }),
  update: (b) => googleBrowser.update(b),
  delete: (b) => googleBrowser.remove(b),
  disconnect: async () => googleBrowser.disconnect(),
};

async function call(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const post = (source, action, body = {}) =>
  !onServer && source === 'google' && BROWSER_ACTIONS[action]
    ? BROWSER_ACTIONS[action](body)
    : call(`/api/${source}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export async function accountStatus(source) {
  if (!(await serverMode)) {
    if (source === 'google') return googleBrowser.status();
    return { configured: false, connected: false, calendars: [], unavailable: true };
  }
  try {
    return await call(`/api/${source}/status`);
  } catch {
    return { configured: false, connected: false, calendars: [] };
  }
}
export const accountDisconnect = (source) => post(source, 'disconnect');
export const googleSetup = (clientId, clientSecret) => post('google', 'setup', { clientId, clientSecret });
export const appleConnect = (appleId, password) => post('apple', 'connect', { appleId, password });

export function nearestGoogleColorId(hex) {
  const rgb = (h) => {
    const n = parseInt(String(h).replace('#', '').slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [r, g, b] = rgb(hex);
  let best = '1';
  let bestD = Infinity;
  for (const [id, c] of Object.entries(GOOGLE_EVENT_COLORS)) {
    const [r2, g2, b2] = rgb(c);
    const d = 2 * (r - r2) ** 2 + 4 * (g - g2) ** 2 + 3 * (b - b2) ** 2;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

function fromAccount(source, e) {
  return normalize(e, {
    id: `${source}:${e.calendarId}:${e.id}`,
    remoteId: e.id,
    calendarId: e.calendarId,
    calendarName: e.calendarName || '',
    href: e.href,
    color: e.color || PALETTE[3],
    sourceId: source,
    editable: Boolean(e.editable),
    recurring: Boolean(e.recurring),
    colorId: e.colorId || null,
    calendarColor: e.calendarColor || e.color || PALETTE[3],
  });
}

export async function pushCreate(source, calendarId, ev) {
  const body = await post(source, 'create', {
    calendarId,
    title: ev.title,
    start: ev.start.toISOString(),
    end: ev.end.toISOString(),
    ...(source === 'google' && ev.colorId !== '' ? { colorId: ev.colorId || nearestGoogleColorId(ev.color) } : {}),
  });
  return fromAccount(source, body.event);
}
export function pushUpdate(ev, fields) {
  return post(ev.sourceId, 'update', {
    calendarId: ev.calendarId,
    id: ev.remoteId,
    href: ev.href,
    title: fields.title,
    start: fields.start?.toISOString(),
    end: fields.end?.toISOString(),
    ...('colorId' in fields ? { colorId: fields.colorId } : {}),
  });
}
export function pushDelete(ev) {
  return post(ev.sourceId, 'delete', { calendarId: ev.calendarId, id: ev.remoteId, href: ev.href });
}

async function fetchAccount(source, from, to) {
  if (!(await serverMode) && source === 'google') {
    return { events: (await googleBrowser.events(from, to)).map((e) => fromAccount(source, e)) };
  }
  const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const body = await call(`/api/${source}/events?${q}`);
  return { events: body.events.map((e) => fromAccount(source, e)) };
}

export function demoEvents(now = new Date()) {
  const at = (dayOffset, h, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m);
  const mk = (d, h1, m1, h2, m2, title, color) => ({
    id: `demo:${d}:${h1}:${m1}:${title}`,
    title,
    allDay: false,
    start: at(d, h1, m1),
    end: at(d, h2, m2),
    color,
    sourceId: 'demo',
  });
  const [coral, sun, mint, sky, lilac, rose] = PALETTE;
  return [
    mk(0, 7, 0, 7, 45, 'Run', mint),
    mk(0, 9, 30, 11, 0, 'Deep work', sky),
    mk(0, 10, 30, 11, 15, 'Coffee with Sam', sun),
    mk(0, 12, 30, 13, 15, 'Lunch', coral),
    mk(0, 15, 0, 16, 0, 'Design review', lilac),
    mk(0, 15, 30, 16, 30, 'Call', sky),
    mk(0, 18, 30, 20, 0, 'Dinner', rose),
    mk(0, 21, 30, 22, 30, 'Read', sun),
  ];
}

export async function fetchAllEvents(config, from, to) {
  const jobs = config.sources
    .filter((s) => s.enabled !== false)
    .map((s) => ({ id: s.id, run: () => fetchIcs(s, from, to) }));
  for (const source of Object.keys(ACCOUNTS)) {
    if (config[source]?.enabled) jobs.push({ id: source, run: () => fetchAccount(source, from, to) });
  }

  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const status = {};
  const names = {};
  const events = [];
  results.forEach((r, i) => {
    const id = jobs[i].id;
    if (r.status === 'fulfilled') {
      status[id] = '';
      if (r.value.name) names[id] = r.value.name;
      events.push(...r.value.events);
    } else {
      status[id] = r.reason?.message || 'Failed to load.';
    }
  });
  return { events, status, names, hasSources: jobs.length > 0 };
}
