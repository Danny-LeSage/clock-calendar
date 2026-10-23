// The phone's own calendar (iOS EventKit / Android CalendarContract), through the
// @ebarooni/capacitor-calendar plugin. Every account on the phone (iCloud, Google,
// Outlook, Exchange, …) shows up here with one permission prompt.
import { native, platform } from './platform.js';

const P = 'CapacitorCalendar';
const call = (method, options) => native(P, method, options);
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

async function granted() {
  const { result } = await call('checkAllPermissions');
  return result.readCalendar === 'granted' && result.writeCalendar === 'granted';
}

export async function connect() {
  if (await granted().catch(() => false)) return;
  const { result } = await call('requestFullCalendarAccess');
  if (result !== 'granted' && !(await granted().catch(() => false))) {
    const where = platform === 'ios' ? 'Settings → Clock Calendar → Calendars' : 'Settings → Apps → Clock Calendar → Permissions';
    throw fail(`Calendar access is off. Turn on full access in ${where}.`, 403);
  }
}

// Holiday, birthday and subscribed calendars can't take new events.
const writable = (c) => c.allowsContentModifications !== false && c.isImmutable !== true && c.isSubscribed !== true;
const visible = (c) => c.visible !== false;
const hex = (c) => (/^#[0-9a-f]{6}/i.test(c || '') ? c.slice(0, 7) : null);

let cache = null;
async function calendars() {
  const { result } = await call('listCalendars');
  cache = new Map(result.map((c) => [String(c.id), c]));
  return result;
}

function calName(c) {
  const title = c.title || c.internalTitle || 'Calendar';
  const account = c.source?.title || c.accountName;
  return account && account !== title ? `${title} (${account})` : title;
}

export async function status() {
  if (!(await granted().catch(() => false))) return { connected: false, calendars: [] };
  const [list, def] = await Promise.all([
    calendars().catch(() => []),
    call('getDefaultCalendar', { useFallbackCalendar: true }).then((r) => r.result, () => null),
  ]);
  return {
    connected: true,
    calendars: list
      .filter((c) => visible(c) && writable(c))
      .map((c) => ({ id: String(c.id), name: calName(c), color: hex(c.color), primary: String(c.id) === String(def?.id) })),
  };
}

export const disconnect = async () => {};

function toEvent(e) {
  const cal = cache?.get(String(e.calendarId)) || {};
  const allDay = Boolean(e.isAllDay);
  const day = (ms) => {
    // All-day events come back as midnight: UTC midnight on Android, local on iOS.
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return platform === 'android'
      ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
      : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  return {
    id: String(e.id),
    calendarId: String(e.calendarId ?? ''),
    calendarName: cal.title || '',
    title: (e.title || '').trim() || 'Busy',
    allDay,
    start: allDay ? day(e.startDate) : new Date(e.startDate).toISOString(),
    end: allDay ? day(e.endDate) : new Date(e.endDate).toISOString(),
    color: hex(e.color) || hex(cal.color),
    calendarColor: hex(cal.color),
    recurring: Boolean(e.isPartOfSeries),
    editable: !e.isPartOfSeries && !allDay && writable(cal),
  };
}

export async function events(from, to) {
  if (!(await granted())) throw fail('Calendar access is off. Reconnect the phone calendar in settings.', 403);
  await calendars().catch(() => {});
  const { result } = await call('listEventsInRange', { from: from.getTime(), to: to.getTime() });
  return result
    .filter((e) => {
      const cal = cache?.get(String(e.calendarId));
      return !cal || visible(cal);
    })
    .filter((e) => e.status !== 'canceled' && e.status !== 'cancelled')
    .map(toEvent);
}

export async function create({ calendarId, title, start, end }) {
  const { id } = await call('createEvent', {
    title: title || 'Untitled',
    ...(calendarId ? { calendarId } : {}),
    startDate: new Date(start).getTime(),
    endDate: new Date(end).getTime(),
    isAllDay: false,
    commit: true,
  });
  if (!id) throw fail("The phone didn't save the event.");
  if (!cache) await calendars().catch(() => {});
  return toEvent({
    id,
    calendarId,
    title: title || 'Untitled',
    startDate: new Date(start).getTime(),
    endDate: new Date(end).getTime(),
    isAllDay: false,
    isPartOfSeries: false,
  });
}

export async function update({ id, title, start, end }) {
  await call('modifyEvent', {
    id,
    ...(title != null ? { title } : {}),
    ...(start ? { startDate: new Date(start).getTime() } : {}),
    ...(end ? { endDate: new Date(end).getTime() } : {}),
  });
}

export async function remove({ id }) {
  await call('deleteEvent', { id, commit: true });
}
