import { GOOGLE_CLIENT_ID } from './config.js';

const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ');
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_KEY = 'clockcal.google.browser.v1';

const CALENDAR_COLORS = {
  1: '#795548', 2: '#e67c73', 3: '#d50000', 4: '#f4511e', 5: '#ef6c00', 6: '#f09300',
  7: '#009688', 8: '#0b8043', 9: '#7cb342', 10: '#c0ca33', 11: '#e4c441', 12: '#f6bf26',
  13: '#33b679', 14: '#039be5', 15: '#4285f4', 16: '#3f51b5', 17: '#7986cb', 18: '#b39ddb',
  19: '#616161', 20: '#a79b8e', 21: '#ad1457', 22: '#d81b60', 23: '#8e24aa', 24: '#9e69af',
};
const EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

const fail = (message, status = 502) => Object.assign(new Error(message), { status });

function readToken() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  } catch {
    return null;
  }
}
function writeToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}
const validToken = () => {
  const t = readToken();
  return t && t.expires > Date.now() ? t : null;
};

let gisReady = null;
export function preload() {
  gisReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => {
      gisReady = null;
      reject(fail("Couldn't load Google sign-in."));
    };
    document.head.append(s);
  });
  return gisReady;
}

let tokenClient = null;
export function connect() {
  if (!GOOGLE_CLIENT_ID) return Promise.reject(fail('No Google client ID is set in config.js.', 409));
  if (!window.google?.accounts?.oauth2) return Promise.reject(fail('Google sign-in is still loading. Try again.', 503));
  return new Promise((resolve, reject) => {
    tokenClient ??= window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPE,
      callback: () => {},
    });
    tokenClient.callback = (r) => {
      if (r.error) return reject(fail(r.error_description || r.error, 401));
      if (!window.google.accounts.oauth2.hasGrantedAllScopes(r, ...SCOPE.split(' '))) {
        return reject(fail('Tick every box on Google’s permission screen so the clock can see and edit your events.', 403));
      }
      writeToken({ access_token: r.access_token, expires: Date.now() + (Number(r.expires_in) - 60) * 1000 });
      resolve();
    };
    tokenClient.error_callback = (e) => reject(fail(e?.message || 'Google sign-in was closed.', 401));
    tokenClient.requestAccessToken({ prompt: readToken() ? '' : 'consent' });
  });
}

export function disconnect() {
  const t = readToken();
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.access_token, () => {});
  writeToken(null);
}

export const needsReconnect = () => !validToken();

async function api(path, { method = 'GET', body } = {}) {
  const t = validToken();
  if (!t) throw fail('Google sign-in expired. Click Reconnect Google.', 401);
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { authorization: `Bearer ${t.access_token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    writeToken({ ...t, expires: 0 });
    throw fail('Google sign-in expired. Click Reconnect Google.', 401);
  }
  if (res.status === 403) {
    const info = await res.json().catch(() => ({}));
    const err = info.error || {};
    const link = err.details?.find((d) => d.metadata?.activationUrl)?.metadata.activationUrl;
    if (link) throw fail(`The Google Calendar API is turned off for your project. Turn it on here: ${link}`, 403);
    throw fail(`Google refused: ${err.message || 'access denied'}`, 403);
  }
  if (res.status === 204 || res.status === 410) return null;
  if (!res.ok) throw fail(`Google Calendar answered ${res.status}.`);
  return res.json();
}

const canWrite = (cal) => cal.accessRole === 'owner' || cal.accessRole === 'writer';

let palette = null;
async function calendarList() {
  const list = await api('users/me/calendarList?minAccessRole=reader');
  palette ??= (await api('colors').catch(() => null))?.calendar || {};
  const cals = (list.items || []).filter((c) => c.selected !== false && !c.hidden);
  for (const c of cals) {
    const standard = palette[c.colorId]?.background;
    const isStandard = !standard || String(c.backgroundColor).toLowerCase() === standard.toLowerCase();
    c.color = (isStandard && CALENDAR_COLORS[c.colorId]) || c.backgroundColor || null;
  }
  return cals;
}

function toEvent(e, cal) {
  const allDay = !e.start.dateTime;
  return {
    id: e.id,
    calendarId: cal.id,
    calendarName: cal.summaryOverride || cal.summary,
    title: e.summary || 'Busy',
    allDay,
    start: allDay ? e.start.date : e.start.dateTime,
    end: allDay ? e.end.date : e.end.dateTime,
    color: EVENT_COLORS[e.colorId] || cal.color || null,
    colorId: e.colorId || null,
    calendarColor: cal.color || null,
    recurring: Boolean(e.recurringEventId),
    editable: canWrite(cal) && !e.recurringEventId && !allDay,
  };
}

export async function status() {
  const connected = Boolean(validToken());
  let calendars = [];
  if (connected) {
    calendars = (await calendarList().catch(() => []))
      .filter(canWrite)
      .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: Boolean(c.primary), color: c.color }));
  }
  return { configured: Boolean(GOOGLE_CLIENT_ID), connected, calendars, browser: true };
}

export async function events(from, to) {
  const cals = await calendarList();
  const per = await Promise.all(
    cals.map(async (cal) => {
      const q = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '250',
      });
      const data = await api(`calendars/${encodeURIComponent(cal.id)}/events?${q}`);
      return (data.items || [])
        .filter((e) => e.status !== 'cancelled' && e.start && e.end)
        .filter((e) => !(e.attendees || []).some((a) => a.self && a.responseStatus === 'declined'))
        .map((e) => toEvent(e, cal));
    }),
  );
  return per.flat();
}

export async function create({ calendarId, title, start, end, colorId }) {
  const body = { summary: title, start: { dateTime: start }, end: { dateTime: end } };
  if (EVENT_COLORS[colorId]) body.colorId = String(colorId);
  const e = await api(`calendars/${encodeURIComponent(calendarId || 'primary')}/events`, { method: 'POST', body });
  const cal = (await calendarList()).find((c) => c.id === calendarId) || { id: calendarId, accessRole: 'owner' };
  return toEvent(e, cal);
}

export async function update({ calendarId, id, title, start, end, colorId }) {
  const body = {};
  if (colorId !== undefined) body.colorId = colorId;
  if (title != null) body.summary = title;
  if (start) body.start = { dateTime: start };
  if (end) body.end = { dateTime: end };
  await api(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

export async function remove({ calendarId, id }) {
  await api(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
