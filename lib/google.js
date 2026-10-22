import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ');
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });

const CALENDAR_COLORS = {
  1: '#795548', 2: '#e67c73', 3: '#d50000', 4: '#f4511e', 5: '#ef6c00', 6: '#f09300',
  7: '#009688', 8: '#0b8043', 9: '#7cb342', 10: '#c0ca33', 11: '#e4c441', 12: '#f6bf26',
  13: '#33b679', 14: '#039be5', 15: '#4285f4', 16: '#3f51b5', 17: '#7986cb', 18: '#b39ddb',
  19: '#616161', 20: '#a79b8e', 21: '#ad1457', 22: '#d81b60', 23: '#8e24aa', 24: '#9e69af',
};
export const EVENT_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73', 5: '#f6bf26', 6: '#f4511e',
  7: '#039be5', 8: '#616161', 9: '#3f51b5', 10: '#0b8043', 11: '#d50000',
};

export function createGoogle({ dataDir, clientId, clientSecret, redirectUri }) {
  const tokenFile = path.join(dataDir, 'google-token.json');
  const clientFile = path.join(dataDir, 'google-client.json');
  const pendingStates = new Map();
  let access = null;
  const creds = { clientId, clientSecret, fromEnv: Boolean(clientId && clientSecret) };

  const isConfigured = () => Boolean(creds.clientId && creds.clientSecret);

  async function loadSavedClient() {
    if (creds.fromEnv) return;
    try {
      const saved = JSON.parse(await readFile(clientFile, 'utf8'));
      creds.clientId = saved.clientId;
      creds.clientSecret = saved.clientSecret;
    } catch {
    }
  }
  const ready = loadSavedClient();

  async function readRefreshToken() {
    try {
      return JSON.parse(await readFile(tokenFile, 'utf8')).refresh_token || null;
    } catch {
      return null;
    }
  }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error_description || body.error || `Google answered ${res.status}.`);
      err.code = body.error;
      throw err;
    }
    return body;
  }

  async function accessToken() {
    if (access && access.expires > Date.now()) return access.token;
    const refresh = await readRefreshToken();
    if (!refresh) throw fail('Google is not connected.', 409);
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
      access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
      return access.token;
    } catch (err) {
      if (err.code === 'invalid_grant') {
        await rm(tokenFile, { force: true });
        throw fail('Google access was revoked. Connect again in settings.', 409);
      }
      throw err;
    }
  }

  async function api(p, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}/${p}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) access = null;
    if (res.status === 403) {
      const info = await res.json().catch(() => ({}));
      const err = info.error || {};
      const reason = err.errors?.[0]?.reason || err.details?.find((d) => d.reason)?.reason || err.status || '';
      const text = String(err.message || '');
      let message;
      if (/SERVICE_DISABLED|accessNotConfigured/i.test(`${reason} ${text}`)) {
        const link = err.details?.find((d) => d.metadata?.activationUrl)?.metadata.activationUrl;
        message = `The Google Calendar API is turned off for your Google Cloud project. Turn it on${
          link ? ` here: ${link}` : ' (step 2 in the Google setup)'
        }, wait a minute, then try again.`;
      } else if (/insufficient|scope/i.test(`${reason} ${text}`)) {
        message = 'Google didn’t give calendar access. Remove Google here and connect again, and tick every box on Google’s permission screen.';
      } else {
        message = `Google refused: ${text || reason || 'access denied'}`;
      }
      throw fail(message, 403);
    }
    if (res.status === 204 || res.status === 410) return null;
    if (!res.ok) throw fail(`Google Calendar answered ${res.status}.`);
    return res.json();
  }

  async function calendarList() {
    const list = await api('users/me/calendarList?minAccessRole=reader');
    return (list.items || []).filter((c) => c.selected !== false && !c.hidden);
  }

  const canWrite = (cal) => cal.accessRole === 'owner' || cal.accessRole === 'writer';

  let palette = null;
  async function oldPalette() {
    if (!palette) palette = (await api('colors').catch(() => null))?.calendar || {};
    return palette;
  }
  async function calendarColor(cal) {
    const standard = (await oldPalette())[cal.colorId]?.background;
    const isStandard = !standard || String(cal.backgroundColor).toLowerCase() === standard.toLowerCase();
    return (isStandard && CALENDAR_COLORS[cal.colorId]) || cal.backgroundColor || null;
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
      color: EVENT_COLORS[e.colorId] || cal.color || cal.backgroundColor || null,
      colorId: e.colorId || null,
      calendarColor: cal.color || cal.backgroundColor || null,
      recurring: Boolean(e.recurringEventId),
      editable: canWrite(cal) && !e.recurringEventId && !allDay,
    };
  }

  return {
    ready,

    get configured() {
      return isConfigured();
    },

    async status() {
      await ready;
      const connected = isConfigured() && Boolean(await readRefreshToken());
      let calendars = [];
      if (connected) {
        calendars = (await calendarList().catch(() => []))
          .filter(canWrite)
          .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: Boolean(c.primary), cal: c }));
        for (const c of calendars) {
          c.color = await calendarColor(c.cal);
          delete c.cal;
        }
      }
      return { configured: isConfigured(), fromEnv: creds.fromEnv, connected, calendars, redirectUri };
    },

    async saveClient(id, secret) {
      id = String(id || '').trim();
      secret = String(secret || '').trim();
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) {
        throw fail('That client ID should end in .apps.googleusercontent.com', 400);
      }
      if (secret.length < 10) throw fail('That client secret looks too short.', 400);
      await mkdir(dataDir, { recursive: true });
      await writeFile(clientFile, JSON.stringify({ clientId: id, clientSecret: secret }), { mode: 0o600 });
      creds.clientId = id;
      creds.clientSecret = secret;
      creds.fromEnv = false;
      access = null;
    },

    startUrl() {
      const state = randomBytes(16).toString('hex');
      pendingStates.set(state, Date.now() + 10 * 60 * 1000);
      return `${AUTH_URL}?${new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
      })}`;
    },

    async finish(code, state) {
      const exp = pendingStates.get(state);
      pendingStates.delete(state);
      if (!exp || exp < Date.now()) throw new Error('That sign-in link expired. Try connecting again.');
      const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (!t.refresh_token) throw new Error("Google didn't return a long-lived token. Try connecting again.");
      await mkdir(dataDir, { recursive: true });
      await writeFile(tokenFile, JSON.stringify({ refresh_token: t.refresh_token }), { mode: 0o600 });
      access = { token: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
    },

    async disconnect() {
      const refresh = await readRefreshToken();
      access = null;
      await rm(tokenFile, { force: true });
      if (refresh) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, {
          method: 'POST',
        }).catch(() => {});
      }
    },

    async events(from, to) {
      const calendars = await calendarList();
      for (const cal of calendars) cal.color = await calendarColor(cal);
      const per = await Promise.all(
        calendars.map(async (cal) => {
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
    },

    async create({ calendarId, title, start, end, colorId }) {
      const cal = encodeURIComponent(calendarId || 'primary');
      const body = { summary: title, start: { dateTime: start }, end: { dateTime: end } };
      if (EVENT_COLORS[colorId]) body.colorId = String(colorId);
      const e = await api(`calendars/${cal}/events`, { method: 'POST', body });
      const calInfo = (await calendarList()).find((c) => c.id === e.organizer?.email || c.id === calendarId);
      if (calInfo) calInfo.color = await calendarColor(calInfo);
      return toEvent(e, calInfo || { id: calendarId || 'primary', accessRole: 'owner' });
    },

    async update({ calendarId, id, title, start, end, colorId }) {
      const body = {};
      if (colorId !== undefined) {
        if (colorId !== null && !EVENT_COLORS[colorId]) throw fail('Unknown colour.', 400);
        body.colorId = colorId;
      }
      if (title != null) body.summary = title;
      if (start) body.start = { dateTime: start };
      if (end) body.end = { dateTime: end };
      await api(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
      });
    },

    async remove({ calendarId, id }) {
      await api(`calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
  };
}
