import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApple } from '../lib/apple.js';

const AUTH = `Basic ${Buffer.from('me@icloud.com:abcd-efgh-ijkl-mnop').toString('base64')}`;
const store = new Map([
  [
    '/home/work/one.ics',
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Dentist & check\r\nDESCRIPTION:Bring card\r\nDTSTART:20261022T150000Z\r\nDTEND:20261022T160000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
  ],
  [
    '/home/work/weekly.ics',
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:Standup\r\nDTSTART:20261001T140000Z\r\nDTEND:20261001T141500Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
  ],
]);
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

let server;
let base;
let dir;

before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== AUTH) return res.writeHead(401).end();
    let body = '';
    for await (const c of req) body += c;
    const ms = (inner) => {
      res.writeHead(207, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${inner}</multistatus>`);
    };
    if (req.method === 'PROPFIND' && req.url === '/') {
      return ms(`<response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response>`);
    }
    if (req.method === 'PROPFIND' && req.url === '/123/principal/') {
      return ms(`<response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href>${base}home/</href></C:calendar-home-set></prop></propstat></response>`);
    }
    if (req.method === 'PROPFIND' && req.url === '/home/') {
      return ms(`
        <response><href>/home/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
        <response><href>/home/work/</href><propstat><prop><displayname>Work</displayname><resourcetype><collection/><C:calendar/></resourcetype>
          <A:calendar-color>#FF2968FF</A:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
          <current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set></prop></propstat></response>
        <response><href>/home/todo/</href><propstat><prop><displayname>Reminders</displayname><resourcetype><collection/><C:calendar/></resourcetype>
          <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop></propstat></response>`);
    }
    if (req.method === 'REPORT' && req.url === '/home/work/') {
      assert.match(body, /time-range start="\d{8}T\d{6}Z"/);
      return ms(
        [...store]
          .filter(([href]) => href.startsWith('/home/work/'))
          .map(([href, ics]) => `<response><href>${href}</href><propstat><prop><getetag>"e-${href.length}"</getetag><C:calendar-data>${xmlEscape(ics)}</C:calendar-data></prop></propstat></response>`)
          .join(''),
      );
    }
    if (req.method === 'GET' && store.has(req.url)) {
      res.writeHead(200, { etag: '"e1"', 'content-type': 'text/calendar' });
      return res.end(store.get(req.url));
    }
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && store.has(req.url)) return res.writeHead(412).end();
      store.set(req.url, body);
      return res.writeHead(201, { etag: '"new"' }).end();
    }
    if (req.method === 'DELETE') {
      store.delete(req.url);
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  dir = await mkdtemp(path.join(os.tmpdir(), 'clockcal-'));
});

after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const make = () => createApple({ dataDir: dir, base, allowHost: (h) => h === '127.0.0.1' });

test('rejects a wrong password', async () => {
  const apple = make();
  await assert.rejects(apple.connect('me@icloud.com', 'wrong-password'), /didn't accept/);
});

test('connects, lists event calendars, reads, creates, edits and deletes', async () => {
  const apple = make();
  const status = await apple.connect('me@icloud.com', 'abcd-efgh-ijkl-mnop');
  assert.equal(status.connected, true);
  assert.deepEqual(status.calendars.map((c) => c.name), ['Work']);

  const from = new Date('2026-10-22T00:00:00Z');
  const to = new Date('2026-10-23T00:00:00Z');
  let events = await apple.events(from, to);
  const dentist = events.find((e) => e.title === 'Dentist & check');
  assert.ok(dentist, 'reads a one-off event (and unescapes XML)');
  assert.equal(dentist.editable, true);
  assert.equal(dentist.color, '#FF2968');
  const standup = events.find((e) => e.title === 'Standup');
  assert.equal(standup.recurring, true);
  assert.equal(standup.editable, false, 'repeating events are read-only');

  const again = make();
  await again.ready;
  assert.equal((await again.status()).connected, true);

  const created = await again.create({
    calendarId: status.calendars[0].id,
    title: 'Gym',
    start: '2026-10-22T18:00:00.000Z',
    end: '2026-10-22T19:00:00.000Z',
  });
  assert.equal(created.title, 'Gym');
  assert.ok([...store.keys()].some((k) => k === new URL(created.href).pathname));

  await again.update({ href: dentist.href, title: 'Dentist', start: '2026-10-22T16:00:00.000Z', end: '2026-10-22T17:30:00.000Z' });
  const saved = store.get('/home/work/one.ics');
  assert.match(saved, /SUMMARY:Dentist\r?\n/);
  assert.match(saved, /DTSTART:20261022T160000Z/);
  assert.match(saved, /DTEND:20261022T173000Z/);
  assert.match(saved, /DESCRIPTION:Bring card/, 'keeps the rest of the event');

  await again.remove({ href: created.href });
  events = await again.events(from, to);
  assert.ok(!events.some((e) => e.title === 'Gym'));

  await again.disconnect();
  assert.equal((await again.status()).connected, false);
});
