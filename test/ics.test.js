import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandIcs } from '../lib/ics.js';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:test
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:daily-1
SUMMARY:Standup
DTSTART;TZID=America/New_York:20200106T093000
DTEND;TZID=America/New_York:20200106T094500
RRULE:FREQ=DAILY
EXDATE;TZID=America/New_York:20261021T093000
END:VEVENT
BEGIN:VEVENT
UID:daily-1
RECURRENCE-ID;TZID=America/New_York:20261022T093000
SUMMARY:Standup (moved)
DTSTART;TZID=America/New_York:20261022T110000
DTEND;TZID=America/New_York:20261022T111500
END:VEVENT
BEGIN:VEVENT
UID:daily-1
RECURRENCE-ID;TZID=America/New_York:20261023T093000
SUMMARY:Standup
STATUS:CANCELLED
DTSTART;TZID=America/New_York:20261023T093000
DTEND;TZID=America/New_York:20261023T094500
END:VEVENT
BEGIN:VEVENT
UID:one-off
SUMMARY:Dinner
DTSTART:20261022T230000Z
DTEND:20261023T003000Z
END:VEVENT
BEGIN:VEVENT
UID:allday
SUMMARY:Birthday
DTSTART;VALUE=DATE:20261022
DTEND;VALUE=DATE:20261023
END:VEVENT
BEGIN:VEVENT
UID:old
SUMMARY:Old thing
DTSTART:20190101T100000Z
DTEND:20190101T110000Z
END:VEVENT
END:VCALENDAR`;

test('expands recurrences, exceptions, cancellations and time zones', () => {
  const ev = expandIcs(ICS, new Date('2026-10-20T00:00:00Z'), new Date('2026-10-25T00:00:00Z'));
  const titles = ev.map((e) => `${e.title}@${e.start}`);
  assert.ok(titles.includes('Standup@2026-10-20T13:30:00.000Z'));
  assert.ok(!titles.some((t) => t.startsWith('Standup@2026-10-21')));
  assert.ok(titles.includes('Standup (moved)@2026-10-22T15:00:00.000Z'));
  assert.ok(!titles.some((t) => t.startsWith('Standup@2026-10-23')));
  assert.ok(titles.includes('Standup@2026-10-24T13:30:00.000Z'));
  assert.ok(titles.includes('Dinner@2026-10-22T23:00:00.000Z'));
  const bday = ev.find((e) => e.title === 'Birthday');
  assert.deepEqual([bday.allDay, bday.start, bday.end], [true, '2026-10-22', '2026-10-23']);
  assert.ok(!titles.some((t) => t.startsWith('Old thing')));
});
