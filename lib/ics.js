import ICAL from 'ical.js';

const MAX_ITERATIONS = 20000;

function dateOnly(t) {
  const p = (n) => String(n).padStart(2, '0');
  return `${t.year}-${p(t.month)}-${p(t.day)}`;
}

function toOccurrence(ev, start, end) {
  const allDay = start.isDate;
  return {
    uid: ev.uid,
    title: (ev.summary || '').trim() || 'Untitled',
    location: ev.location || '',
    allDay,
    start: allDay ? dateOnly(start) : start.toJSDate().toISOString(),
    end: allDay ? dateOnly(end) : end.toJSDate().toISOString(),
  };
}

function isCancelled(ev) {
  return String(ev.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
}

export function expandIcs(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(text));

  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid');
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(vtz);
  }

  const masters = [];
  const exceptions = new Map();
  for (const ve of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(ve);
    if (!ev.startDate) continue;
    if (ev.isRecurrenceException()) {
      if (!exceptions.has(ev.uid)) exceptions.set(ev.uid, []);
      exceptions.get(ev.uid).push(ev);
    } else {
      masters.push(ev);
    }
  }

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out = [];
  const overlaps = (s, e) => e.toJSDate().getTime() > fromMs && s.toJSDate().getTime() < toMs;

  for (const ev of masters) {
    const related = exceptions.get(ev.uid) || [];
    for (const ex of related) ev.relateException(ex);

    if (!ev.isRecurring()) {
      if (!isCancelled(ev) && overlaps(ev.startDate, ev.endDate)) {
        out.push(toOccurrence(ev, ev.startDate, ev.endDate));
      }
      continue;
    }

    const stopMs = toMs + 24 * 3600 * 1000;
    const it = ev.iterator();
    let next;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_ITERATIONS) {
      if (next.toJSDate().getTime() > stopMs) break;
      const d = ev.getOccurrenceDetails(next);
      if (isCancelled(d.item)) continue;
      if (overlaps(d.startDate, d.endDate)) {
        out.push(toOccurrence(d.item, d.startDate, d.endDate));
      }
    }
  }

  const masterUids = new Set(masters.map((m) => m.uid));
  for (const [uid, list] of exceptions) {
    if (masterUids.has(uid)) continue;
    for (const ev of list) {
      if (!isCancelled(ev) && overlaps(ev.startDate, ev.endDate)) {
        out.push(toOccurrence(ev, ev.startDate, ev.endDate));
      }
    }
  }

  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

export function icsName(text) {
  const m = /^X-WR-CALNAME(?:;[^:]*)?:(.*)$/m.exec(text);
  return m ? m[1].trim().replace(/\\([,;\\])/g, '$1') : '';
}
