// iCloud two-way sync over CalDAV. Runs both in the Node server and inside the
// phone app, so it only uses things both have (fetch, crypto.randomUUID, btoa).
// `store` keeps the account ({ appleId, password, home, calendars }) and
// `request` sends one HTTP request (the phone app swaps in a native one).
import ICAL from '../vendor/ical.js';
import { expandIcs } from './ics.js';

const ICLOUD = 'https://caldav.icloud.com/';
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

const tagRe = (name, flags = '') =>
  new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, flags);
const first = (xml, name) => (xml == null ? null : tagRe(name).exec(xml)?.[1] ?? null);
const all = (xml, name) => [...(xml || '').matchAll(tagRe(name, 'g'))].map((m) => m[1]);
function text(x) {
  if (x == null) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(x);
  if (cdata) return cdata[1];
  return x
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function base64(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const PROPFIND_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const PROPFIND_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/><a:calendar-color/><c:supported-calendar-component-set/></d:prop>
</d:propfind>`;
const icalUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const reportQuery = (from, to) => `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${icalUtc(from)}" end="${icalUtc(to)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;

// Default transport: plain fetch. Returns { status, text, url, etag }.
export async function fetchRequest(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  return { status: res.status, text: await res.text(), url: res.url || url, etag: res.headers.get('etag') };
}

export function memoryStore() {
  let value = null;
  return {
    load: async () => value,
    save: async (v) => void (value = v),
    clear: async () => void (value = null),
  };
}

export function createCalDav({
  store,
  request = fetchRequest,
  base = ICLOUD,
  allowHost = (h) => h === 'icloud.com' || h.endsWith('.icloud.com'),
}) {
  let account = null;
  const ready = Promise.resolve()
    .then(() => store.load())
    .then((a) => (account = a || null))
    .catch(() => {});

  const authFor = (a) => `Basic ${base64(`${a.appleId}:${a.password}`)}`;

  function safeUrl(href, relativeTo) {
    const u = new URL(href, relativeTo);
    if (u.protocol !== 'https:' && !base.startsWith('http://')) throw fail('iCloud sent an unexpected address.');
    if (!allowHost(u.hostname)) throw fail('iCloud sent an unexpected address.');
    return u.href;
  }

  async function dav(a, method, url, { body, depth, headers = {}, okStatus = [] } = {}) {
    const r = await request(method, url, {
      headers: {
        authorization: authFor(a),
        ...(body ? { 'content-type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}),
        ...(depth != null ? { depth: String(depth) } : {}),
        ...headers,
      },
      body,
    });
    if (r.status === 401 || r.status === 403) {
      throw fail("Apple didn't accept that Apple ID and app-specific password.", 401);
    }
    if (r.status === 412) throw fail('That event changed in iCloud meanwhile. Try again.', 409);
    const ok = (r.status >= 200 && r.status < 300) || okStatus.includes(r.status);
    if (!ok) throw fail(`iCloud answered ${r.status}.`);
    return { text: r.text, url: r.url || url, etag: r.etag };
  }

  async function discover(a) {
    const p = await dav(a, 'PROPFIND', base, { body: PROPFIND_PRINCIPAL, depth: 0 });
    const principalHref = text(first(first(p.text, 'current-user-principal'), 'href'));
    if (!principalHref) throw fail("Couldn't find your iCloud calendars.");
    const principal = safeUrl(principalHref, p.url);
    const h = await dav(a, 'PROPFIND', principal, { body: PROPFIND_HOME, depth: 0 });
    const homeHref = text(first(first(h.text, 'calendar-home-set'), 'href'));
    if (!homeHref) throw fail("Couldn't find your iCloud calendars.");
    const home = safeUrl(homeHref, h.url);
    return { home, calendars: await listCalendars(a, home) };
  }

  async function listCalendars(a, home) {
    const r = await dav(a, 'PROPFIND', home, { body: PROPFIND_CALENDARS, depth: 1 });
    const out = [];
    for (const resp of all(r.text, 'response')) {
      const type = first(resp, 'resourcetype') || '';
      if (!/<(?:[\w-]+:)?calendar\s*\/>/.test(type)) continue;
      const comps = first(resp, 'supported-calendar-component-set');
      if (comps && !/name="VEVENT"/i.test(comps)) continue;
      const privs = first(resp, 'current-user-privilege-set');
      const color = text(first(resp, 'calendar-color')).slice(0, 7);
      out.push({
        href: safeUrl(text(first(resp, 'href')), home),
        name: text(first(resp, 'displayname')) || 'Calendar',
        color: /^#[0-9a-f]{6}$/i.test(color) ? color : null,
        writable: !privs || /<(?:[\w-]+:)?(write|write-content|all)\s*\/>/.test(privs),
      });
    }
    return out;
  }

  const save = () => store.save(account);

  function need() {
    if (!account) throw fail('iCloud is not connected.', 409);
    return account;
  }

  return {
    ready,

    async status() {
      await ready;
      if (!account) return { connected: false, calendars: [] };
      return {
        connected: true,
        appleId: account.appleId,
        calendars: account.calendars
          .filter((c) => c.writable)
          .map((c) => ({ id: c.href, name: c.name, color: c.color })),
      };
    },

    async connect(appleId, password) {
      appleId = String(appleId || '').trim();
      password = String(password || '').replace(/\s+/g, '');
      if (!appleId.includes('@')) throw fail('Enter the email address of your Apple ID.', 400);
      if (password.length < 8) throw fail('Enter an app-specific password (it looks like xxxx-xxxx-xxxx-xxxx).', 400);
      const a = { appleId, password };
      const found = await discover(a);
      if (!found.calendars.length) throw fail('No calendars found in that iCloud account.');
      account = { ...a, ...found };
      await save();
      return this.status();
    },

    async disconnect() {
      account = null;
      await store.clear();
    },

    async events(from, to) {
      await ready;
      const a = need();
      try {
        a.calendars = await listCalendars(a, a.home);
        await save();
      } catch (err) {
        if (err.status === 401) throw err;
      }
      const per = await Promise.all(
        a.calendars.map(async (cal) => {
          const r = await dav(a, 'REPORT', cal.href, { body: reportQuery(from, to), depth: 1 });
          const events = [];
          for (const resp of all(r.text, 'response')) {
            const ics = text(first(resp, 'calendar-data'));
            if (!ics.includes('BEGIN:VCALENDAR')) continue;
            const href = safeUrl(text(first(resp, 'href')), cal.href);
            const etag = text(first(resp, 'getetag'));
            const recurring = /^RRULE:/m.test(ics) || /^RECURRENCE-ID/m.test(ics);
            let list;
            try {
              list = expandIcs(ics, from, to);
            } catch {
              continue;
            }
            for (const e of list) {
              events.push({
                id: recurring ? `${href}#${e.start}` : href,
                calendarId: cal.href,
                calendarName: cal.name,
                href,
                etag,
                title: e.title,
                allDay: e.allDay,
                start: e.start,
                end: e.end,
                color: cal.color,
                recurring,
                editable: cal.writable && !recurring && !e.allDay,
              });
            }
          }
          return events;
        }),
      );
      return per.flat();
    },

    async create({ calendarId, title, start, end }) {
      await ready;
      const a = need();
      const cal = a.calendars.find((c) => c.href === calendarId) || a.calendars.find((c) => c.writable);
      if (!cal) throw fail('No iCloud calendar to add to.', 409);
      const uid = crypto.randomUUID().toUpperCase();
      const comp = new ICAL.Component(['vcalendar', [], []]);
      comp.updatePropertyWithValue('prodid', '-//Clock Calendar//EN');
      comp.updatePropertyWithValue('version', '2.0');
      const ve = new ICAL.Component('vevent');
      const ev = new ICAL.Event(ve);
      ev.uid = uid;
      ev.summary = title || 'Untitled';
      ev.startDate = ICAL.Time.fromJSDate(new Date(start), true);
      ev.endDate = ICAL.Time.fromJSDate(new Date(end), true);
      ve.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
      comp.addSubcomponent(ve);
      const href = safeUrl(`${uid}.ics`, cal.href.endsWith('/') ? cal.href : `${cal.href}/`);
      const r = await dav(a, 'PUT', href, { body: comp.toString(), headers: { 'if-none-match': '*' } });
      return {
        id: href,
        calendarId: cal.href,
        calendarName: cal.name,
        href,
        etag: r.etag || '',
        title: ev.summary,
        allDay: false,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        color: cal.color,
        recurring: false,
        editable: true,
      };
    },

    async update({ href, title, start, end }) {
      await ready;
      const a = need();
      const url = safeUrl(href, a.home);
      const current = await dav(a, 'GET', url);
      const comp = new ICAL.Component(ICAL.parse(current.text));
      const ve = comp.getFirstSubcomponent('vevent');
      if (!ve) throw fail("Couldn't read that event from iCloud.");
      const ev = new ICAL.Event(ve);
      if (title != null) ev.summary = title;
      if (start || end) {
        const duration = ev.endDate.toJSDate() - ev.startDate.toJSDate();
        const s = start ? new Date(start) : ev.startDate.toJSDate();
        const e = end ? new Date(end) : new Date(s.getTime() + duration);
        ve.removeProperty('duration');
        ev.startDate = ICAL.Time.fromJSDate(s, true);
        ev.endDate = ICAL.Time.fromJSDate(e, true);
      }
      ve.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
      const seq = Number(ve.getFirstPropertyValue('sequence') || 0);
      ve.updatePropertyWithValue('sequence', seq + 1);
      await dav(a, 'PUT', url, {
        body: comp.toString(),
        headers: current.etag ? { 'if-match': current.etag } : {},
      });
    },

    async remove({ href }) {
      await ready;
      const a = need();
      try {
        await dav(a, 'DELETE', safeUrl(href, a.home), { okStatus: [404] });
      } catch (err) {
        if (err.status === 401) throw fail("Apple didn't accept the saved password.", 401);
        throw err;
      }
    },
  };
}
