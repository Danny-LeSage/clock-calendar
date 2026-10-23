// What the Node server does on a computer, done inside the phone app instead:
// iCloud (CalDAV) and calendar links (.ics). Native HTTP has no CORS limits, so
// the app can talk to these servers directly.
//  - iOS: Capacitor's native HTTP handles every request type through fetch.
//  - Android: its HTTP stack refuses PROPFIND/REPORT, so CalDAV goes through the
//    small DavHttp plugin in android/app (OkHttp).
import { native, platform } from './platform.js';
import { createCalDav, fetchRequest } from './shared/caldav.js';
import { expandIcs, icsName } from './shared/ics.js';

const APPLE_KEY = 'clockcal.apple.native.v1';
const MAX_BYTES = 15 * 1024 * 1024;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

const store = {
  async load() {
    try {
      return JSON.parse(localStorage.getItem(APPLE_KEY) || 'null');
    } catch {
      return null;
    }
  },
  async save(account) {
    localStorage.setItem(APPLE_KEY, JSON.stringify(account));
  },
  async clear() {
    localStorage.removeItem(APPLE_KEY);
  },
};

async function androidRequest(method, url, { headers = {}, body } = {}) {
  const r = await native('DavHttp', 'request', { method, url, headers, body: body ?? null });
  return { status: r.status, text: r.text || '', url: r.url || url, etag: r.etag || null };
}

export const apple = createCalDav({ store, request: platform === 'android' ? androidRequest : fetchRequest });

const cache = new Map();

export async function linkEvents(raw, from, to) {
  let url;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw fail('That is not a valid link.', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail('Only http(s) and webcal links are supported.', 400);

  let text;
  const hit = cache.get(url.href);
  if (hit && Date.now() - hit.at < 60 * 1000) {
    text = hit.text;
  } else {
    let res;
    try {
      res = await fetch(url.href, { headers: { accept: 'text/calendar, */*' } });
    } catch {
      throw fail(`Couldn't reach ${url.hostname}.`);
    }
    if (!res.ok) throw fail(`The calendar server answered ${res.status}.`);
    text = await res.text();
    if (text.length > MAX_BYTES) throw fail('That calendar is too large.');
    if (!text.includes('BEGIN:VCALENDAR')) throw fail("That link didn't return a calendar (.ics) file.");
    cache.set(url.href, { at: Date.now(), text });
  }
  let events;
  try {
    events = expandIcs(text, from, to);
  } catch {
    throw fail("That calendar file couldn't be read.");
  }
  return { name: icsName(text), events };
}
