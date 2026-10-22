import {
  loadConfig,
  saveConfig,
  nextColor,
  fetchAllEvents,
  demoEvents,
  PALETTE,
  ACCOUNTS,
  accountStatus,
  accountDisconnect,
  googleSetup,
  appleConnect,
  pushCreate,
  pushUpdate,
  pushDelete,
  GOOGLE_EVENT_COLORS,
  nearestGoogleColorId,
  serverMode,
  googleConnectInBrowser,
  googleNeedsReconnect,
} from './sources.js';
import {
  C,
  TAU,
  STYLES,
  isAnalog,
  esc,
  dialSvg,
  gridSvg,
  bandsSvg,
  handsSvg,
  setHands,
  resetHands,
  pointToTime,
  inkFor,
} from './clock.js';

const EVENTS_KEY = 'clockcal.events.v1';
const LOCAL_KEY = 'clockcal.local.v1';
const HIDDEN_KEY = 'clockcal.hidden.v1';
const ADD_SNAP_MS = 30 * 60 * 1000;
const DURATIONS = [
  { mins: 15, label: '15m' },
  { mins: 30, label: '30m' },
  { mins: 60, label: '1h' },
];

for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener(
  'touchmove',
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);
let lastTouch = { at: 0, x: 0, y: 0 };
document.addEventListener(
  'touchend',
  (e) => {
    const t = e.changedTouches[0];
    const now = Date.now();
    const near = t && Math.hypot(t.clientX - lastTouch.x, t.clientY - lastTouch.y) < 40;
    if (now - lastTouch.at < 350 && near && !e.target.closest('input, textarea, select')) e.preventDefault();
    lastTouch = { at: now, x: t?.clientX || 0, y: t?.clientY || 0 };
  },
  { passive: false },
);

const face = document.getElementById('face');
const caption = document.getElementById('caption');
const params = new URLSearchParams(location.search);
if (params.has('widget')) document.documentElement.classList.add('widget');

const timeOffset = (() => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(params.get('at') || '');
  if (!m) return 0;
  const t = new Date();
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return t.getTime() - Date.now();
})();
const clockNow = () => new Date(Date.now() + timeOffset);

const state = {
  config: loadConfig(),
  events: loadCachedEvents(),
  status: {},
  hasSources: false,
  google: { configured: false, connected: false, calendars: [] },
  apple: { connected: false, calendars: [] },
  pending: new Map(),
  deleting: new Set(),
  local: loadLocal(),
  hidden: new Set(loadJson(HIDDEN_KEY, [])),
  focus: null,
  editing: null,
  drag: false,
  dragId: null,
  hover: null,
  hoverClock: false,
  showAll: false,
  preview: null,
  loading: false,
  onServer: true,
};
state.hasSources = state.config.sources.length > 0 || state.config.google.enabled || state.config.apple.enabled;

const styleParam = params.get('style');
const currentStyle = () =>
  STYLES.some((s) => s.id === styleParam) ? styleParam : state.config.style || 'ticking';

const dayAt = (d, add = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + add);
const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
const fmtTime = (d) => timeFmt.format(d);
const fmtRange = (ev) => `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function fmtIn(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function todaysEvents(now) {
  const synced = state.hasSources ? state.events : [];
  const start = dayAt(now).getTime();
  const end = dayAt(now, 1).getTime();
  return [...synced, ...state.local].filter(
    (e) =>
      !state.hidden.has(e.id) &&
      !state.deleting.has(e.id) &&
      e.end.getTime() > start &&
      e.start.getTime() < end,
  );
}

function focusOf(now, events) {
  const nowMs = now.getTime();
  const timed = events.filter((e) => !e.allDay);
  const shownId = state.dragId || state.focus;
  const picked = shownId && timed.find((e) => e.id === shownId);
  if (picked) {
    const hint = state.editing || state.drag ? '' : ' · double-click to edit';
    return { ev: picked, sub: `${fmtRange(picked)}${hint}` };
  }
  const current = timed
    .filter((e) => e.start.getTime() <= nowMs && e.end.getTime() > nowMs)
    .sort((a, b) => a.end - b.end)[0];
  if (current) return { ev: current, sub: `until ${fmtTime(current.end)} · ${fmtIn(current.end - now)} left` };
  const next = timed.filter((e) => e.start.getTime() > nowMs).sort((a, b) => a.start - b.start)[0];
  if (next) return { ev: next, sub: `${fmtTime(next.start)} · in ${fmtIn(next.start - now)}` };
  return null;
}

function allDayNote(now, events) {
  const today0 = dayAt(now).getTime();
  const list = events.filter((e) => e.allDay && e.start.getTime() <= today0 && e.end.getTime() > today0);
  if (!list.length) return '';
  return `${clip(list[0].title, 18)}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
}

let mountedStyle = null;
let parts = null;

function mount(style) {
  face.innerHTML = `
    <svg viewBox="0 0 400 400" class="clock ${style}" role="img">
      <g class="dial">${dialSvg(style)}</g>
      <g class="grid">${gridSvg()}</g>
      <g class="bands"></g>
      <g class="info"></g>
      <g class="hands">${handsSvg(style)}</g>
    </svg>`;
  const svg = face.firstElementChild;
  parts = { svg, bands: svg.querySelector('.bands'), info: svg.querySelector('.info') };
  mountedStyle = style;
  resetHands();
  document.documentElement.dataset.style = style;
}

function infoSvg(style, now, events, focus) {
  const note = allDayNote(now, events);
  if (isAnalog(style)) {
    const date = `${now.toLocaleDateString([], { weekday: 'short' })} ${now.getDate()}`.toUpperCase();
    return `
      <rect class="date-win" x="${C - 25}" y="${C + 38}" width="50" height="17" rx="5" />
      <text class="a-date" x="${C}" y="${C + 46.5}" text-anchor="middle" dominant-baseline="central">${esc(date)}</text>`;
  }
  const p = Object.fromEntries(timeFmt.formatToParts(now).map((x) => [x.type, x.value]));
  let date = `${now.toLocaleDateString([], { weekday: 'long' })} ${now.getDate()}`;
  if (note) date += ` · ${note}`;
  let s = `
    <text class="c-date" x="${C}" y="${C - 34}" text-anchor="middle">${esc(date)}</text>
    <text x="${C}" y="${C + 14}" text-anchor="middle"><tspan class="c-time">${esc(`${p.hour}:${p.minute}`)}</tspan>${
      p.dayPeriod ? `<tspan class="c-period" dx="4">${esc(p.dayPeriod)}</tspan>` : ''
    }</text>`;
  if (focus) {
    s += `
    <text class="c-title" x="${C}" y="${C + 43}" text-anchor="middle"><tspan fill="${esc(focus.ev.color)}">●</tspan> ${esc(clip(focus.ev.title, 24))}</text>
    <text class="c-sub" x="${C}" y="${C + 60}" text-anchor="middle">${esc(focus.sub)}</text>`;
  }
  return s;
}

function captionHtml(style, now, events, focus) {
  if (!isAnalog(style)) return '';
  const note = allDayNote(now, events);
  const bits = [];
  if (focus) {
    bits.push(
      `<span class="dot" style="background:${esc(focus.ev.color)}"></span><b>${esc(clip(focus.ev.title, 32))}</b> <span>${esc(focus.sub)}</span>`,
    );
  }
  if (note) bits.push(`<span>${esc(note)}</span>`);
  return bits.join('<span class="sep">·</span>');
}

let lastCaption = '';

function render() {
  const style = currentStyle();
  if (style !== mountedStyle) mount(style);
  const now = clockNow();
  const events = todaysEvents(now);
  const focus = focusOf(now, events);

  const focusId = state.focus || null;
  parts.svg.classList.toggle('has-selection', Boolean(focusId));
  parts.svg.classList.toggle('dragging', Boolean(state.drag));
  parts.svg.dataset.half = now.getHours() < 12 ? 'am' : 'pm';
  parts.svg.setAttribute('aria-label', ariaSummary(now, events));
  parts.bands.innerHTML = bandsSvg(events, now, { focused: focusId, hover: state.hover, showDone: state.showAll || (state.hoverClock && state.config.showPastOnHover !== false), preview: state.preview, fmtRange });
  parts.info.innerHTML = infoSvg(style, now, events, focus);
  const cap = captionHtml(style, now, events, focus);
  if (cap !== lastCaption) {
    caption.innerHTML = cap;
    lastCaption = cap;
  }
  setHands(parts.svg, style, now, style === 'sweep');
  renderEditor(now, events);
}

function ariaSummary(now, events) {
  const upcoming = events
    .filter((e) => !e.allDay && e.end > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, 6)
    .map((e) => `${e.title} ${fmtRange(e)}`);
  return `It's ${fmtTime(now)}. ${upcoming.length ? `Still today: ${upcoming.join(', ')}.` : 'Nothing else today.'}`;
}

const editor = document.getElementById('editor');
const edColors = document.getElementById('ed-colors');
const edTitle = document.getElementById('ed-title');
const edTime = document.getElementById('ed-time');
const edNote = document.getElementById('ed-note');
const edDelete = document.getElementById('ed-delete');
const tray = document.getElementById('tray');
const toast = document.getElementById('toast');

const MIN = 60 * 1000;
const EDGE_PX = 9;
const DRAG_PX = 4;
const DOUBLE_MS = 380;

const isLocal = (id) => Boolean(id && id.startsWith('local:'));
const findLocal = (id) => state.local.find((e) => e.id === id);
const findEvent = (id) => findLocal(id) || state.events.find((e) => e.id === id);
const canEdit = (id) => {
  const ev = findEvent(id);
  return Boolean(ev && (ev.sourceId === 'local' || ev.editable));
};
const snapTo = (ms, step) => Math.round(ms / step) * step;

function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}
function loadLocal() {
  return loadJson(LOCAL_KEY, []).map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
}
const saveLocal = () => saveJson(LOCAL_KEY, state.local);
const saveHidden = () => saveJson(HIDDEN_KEY, [...state.hidden]);

function seedDemo(now) {
  if (state.hasSources) return;
  const day = now.toDateString();
  if (state.config.demoDay === day) return;
  state.local = state.local.filter((e) => !e.demo);
  for (const e of demoEvents(now)) {
    state.local.push({ ...e, id: `local:${e.id}`, sourceId: 'local', demo: true });
  }
  state.config.demoDay = day;
  saveConfig(state.config);
  saveLocal();
}

function clearDemo() {
  if (!state.local.some((e) => e.demo)) return;
  state.local = state.local.filter((e) => !e.demo);
  delete state.config.demoDay;
  saveConfig(state.config);
  saveLocal();
}

const CHIP_DEFAULTS = { 15: PALETTE[3], 30: PALETTE[0], 60: PALETTE[4] };
const addColor = (mins = 30) => shownColor(state.config.chipColors?.[mins] || CHIP_DEFAULTS[mins] || PALETTE[0]);
function toGoogle() {
  return newEventTarget().startsWith('google|');
}
function shownColor(hex) {
  return toGoogle() ? GOOGLE_EVENT_COLORS[nearestGoogleColorId(hex)] : hex;
}
function colorChoices() {
  return toGoogle() ? Object.values(GOOGLE_EVENT_COLORS) : PALETTE;
}

function bandWindow(now, key) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  return key === 'am'
    ? { key, start: new Date(y, m, d, 0), end: new Date(y, m, d, 12) }
    : { key, start: new Date(y, m, d, 12), end: new Date(y, m, d + 1, 0) };
}

function placeIn(window, start, length) {
  const lo = window.start.getTime();
  const hi = window.end.getTime();
  if (hi - lo < 5 * MIN) return null;
  const len = Math.min(length, hi - lo);
  const s = Math.min(Math.max(start, lo), hi - len);
  return { start: s, end: s + len };
}

function addLocal(start, end, color) {
  const target = newEventTarget();
  const ev = {
    id: `local:${crypto.randomUUID()}`,
    title: '',
    allDay: false,
    start: new Date(start),
    end: new Date(end),
    color: color || addColor(),
    sourceId: 'local',
    ...(target !== 'local' ? { target } : {}),
  };
  state.local.push(ev);
  saveLocal();
  return ev;
}

function targets() {
  const out = [{ value: 'local', label: 'This clock only' }];
  if (state.config.google.enabled && state.google.connected) {
    for (const c of state.google.calendars || []) {
      out.push({ value: `google|${c.id}`, label: `Google · ${c.name}`, primary: c.primary });
    }
  }
  if (state.config.apple.enabled && state.apple.connected) {
    for (const c of state.apple.calendars || []) out.push({ value: `apple|${c.id}`, label: `iCloud · ${c.name}` });
  }
  return out;
}

function newEventTarget() {
  const options = targets();
  const chosen = state.config.newEventsTo;
  if (chosen && options.some((o) => o.value === chosen)) return chosen;
  const google = options.find((o) => o.primary) || options.find((o) => o.value.startsWith('google|'));
  return (google || options.find((o) => o.value.startsWith('apple|')) || options[0]).value;
}

function targetLabel(target) {
  return targets().find((o) => o.value === target)?.label || ACCOUNTS[target.split('|')[0]] || 'your calendar';
}

function targetColor(target) {
  const [source, ...rest] = String(target || '').split('|');
  const id = rest.join('|');
  return (state[source]?.calendars || []).find((c) => c.id === id)?.color || PALETTE[3];
}

function editorNote(ev, editable) {
  if (ev.sourceId === 'local') {
    if (ev.target) return `Will be added to ${targetLabel(ev.target)}.`;
    if (ev.demo) return 'Demo event. Connect a calendar in settings to see yours.';
    return accountsOn() ? 'Only on this clock.' : '';
  }
  const where = ACCOUNTS[ev.sourceId]
    ? `${ACCOUNTS[ev.sourceId]}${ev.calendarName ? ` · ${ev.calendarName}` : ''}`
    : state.config.sources.find((x) => x.id === ev.sourceId)?.name || 'a calendar link';
  if (editable) return `Synced with ${where}. Changes are saved there too.`;
  if (ev.recurring) return `Repeating event from ${where}. Change it there; the bin hides it here.`;
  return `From ${where} (read-only). The bin hides it on this clock only.`;
}

function applyPending() {
  for (const ev of state.events) {
    const patch = state.pending.get(ev.id);
    if (patch) Object.assign(ev, patch);
  }
}

async function persist(ev, fields) {
  if (ev.sourceId === 'local') {
    saveLocal();
    return;
  }
  const patch = { ...state.pending.get(ev.id), ...fields };
  state.pending.set(ev.id, patch);
  try {
    await pushUpdate(ev, fields);
  } catch (err) {
    showToast(`Couldn't save to ${ACCOUNTS[ev.sourceId]}: ${err.message}`, false);
  } finally {
    if (state.pending.get(ev.id) === patch) state.pending.delete(ev.id);
    refreshSoon();
  }
}

async function upload(ev) {
  const [source, ...rest] = ev.target.split('|');
  const calendarId = rest.join('|');
  if (ev.uploading) return;
  ev.uploading = true;
  try {
    const created = await pushCreate(source, calendarId, ev);
    state.local = state.local.filter((x) => x !== ev);
    saveLocal();
    state.events.push(created);
    if (state.focus === ev.id) state.focus = created.id;
    if (state.editing?.id === ev.id) state.editing = { ...state.editing, id: created.id };
    render();
    refreshSoon();
  } catch (err) {
    delete ev.target;
    delete ev.uploading;
    saveLocal();
    showToast(`Couldn't add to ${ACCOUNTS[source]}: ${err.message}. Kept on this clock.`, false);
    render();
  }
}

function setFocus(id) {
  state.focus = id;
  render();
}

function openEditor(id, isNew = false) {
  if (state.editing && state.editing.id !== id) closeEditor();
  state.focus = id;
  state.editing = { id, isNew };
  render();
  if (canEdit(id)) {
    const ev = findEvent(id);
    edTitle.value = ev?.title || '';
    state.editing.originalTitle = ev?.title || '';
    if (isNew || !matchMedia('(hover: none)').matches) edTitle.focus({ preventScroll: true });
  }
}

function closeEditor() {
  const editing = state.editing;
  const id = editing?.id;
  state.editing = null;
  const ev = id && findEvent(id);
  if (ev && canEdit(id)) {
    if (!ev.title.trim()) ev.title = 'Untitled';
    if (ev.sourceId === 'local') {
      saveLocal();
      if (ev.target) upload(ev);
    } else if (ev.title !== editing.originalTitle) {
      persist(ev, { title: ev.title });
    }
  }
  edTitle.blur();
  render();
}

let undo = null;
function removeEvent(id) {
  if (!id) return;
  if (state.editing?.id === id) state.editing = null;
  if (state.focus === id) state.focus = null;
  const synced = findEvent(id);
  if (isLocal(id)) {
    const ev = findLocal(id);
    state.local = state.local.filter((e) => e.id !== id);
    saveLocal();
    undo = () => {
      state.local.push(ev);
      saveLocal();
    };
    showToast(`Deleted “${clip(ev?.title || 'Untitled', 24)}”`);
  } else if (synced?.editable) {
    state.deleting.add(id);
    let cancelled = false;
    undo = () => {
      cancelled = true;
      state.deleting.delete(id);
    };
    showToast(`Deleted “${clip(synced.title, 24)}”`);
    setTimeout(async () => {
      if (cancelled) return;
      try {
        await pushDelete(synced);
      } catch (err) {
        state.deleting.delete(id);
        showToast(`Couldn't delete in ${ACCOUNTS[synced.sourceId]}: ${err.message}`, false);
      }
      refreshSoon();
    }, 5200);
  } else {
    state.hidden.add(id);
    saveHidden();
    undo = () => {
      state.hidden.delete(id);
      saveHidden();
    };
    showToast('Hidden on this clock');
  }
  render();
}

let toastTimer = 0;
function showToast(text, withUndo = true, ms = 5000) {
  toast.querySelector('span').textContent = text;
  toast.querySelector('button').hidden = !withUndo;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    undo = null;
  }, ms);
}
toast.querySelector('button').addEventListener('click', () => {
  undo?.();
  undo = null;
  toast.hidden = true;
  render();
});

let editorKey = '';
function renderEditor(now, events) {
  const id = state.editing?.id;
  const ev = id && events.find((e) => e.id === id);
  if (id && !ev) state.editing = null;
  if (state.focus && !events.some((e) => e.id === state.focus)) state.focus = null;
  document.documentElement.classList.toggle('editing', Boolean(ev));
  editor.hidden = !ev;
  if (!ev) {
    editorKey = '';
    return;
  }
  const local = isLocal(id);
  const editable = canEdit(id);
  edTime.textContent = fmtRange(ev);
  const key = `${id}|${ev.color}|${editable}`;
  if (key === editorKey) return;
  editorKey = key;
  editor.classList.toggle('readonly', !editable);
  edTitle.readOnly = !editable;
  if (!editable) edTitle.value = ev.title;
  edDelete.setAttribute('aria-label', editable ? 'Delete event' : 'Hide on this clock');
  edDelete.title = editable ? 'Delete' : 'Hide on this clock';
  edNote.textContent = editorNote(ev, editable);
  edNote.hidden = !edNote.textContent;
  const googleBound = ev.target?.startsWith('google|');
  if ((ev.sourceId === 'google' && editable) || googleBound) {
    const current = ev.colorId ?? (googleBound ? nearestGoogleColorId(ev.color) : '');
    const dot = (id, c, label) =>
      `<button type="button" class="ed-color" data-color-id="${id}" style="background:${esc(c)}" aria-label="${label}" title="${label}" aria-pressed="${(current || '') === id}"></button>`;
    edColors.innerHTML =
      dot('', ev.calendarColor || targetColor(ev.target), 'Calendar colour') +
      Object.entries(GOOGLE_EVENT_COLORS)
        .map(([id, c]) => dot(id, c, 'Google colour'))
        .join('');
    edColors.classList.add('google');
    return;
  }
  edColors.classList.remove('google');
  edColors.innerHTML = local && !ev.target
    ? PALETTE.map(
        (c) =>
          `<button type="button" class="ed-color" data-color="${c}" style="background:${c}" aria-label="Colour" aria-pressed="${c === ev.color}"></button>`,
      ).join('')
    : `<span class="ed-color static" style="background:${esc(ev.color)}"></span>`;
}

edTitle.addEventListener('input', () => {
  const id = state.editing?.id;
  const ev = id && canEdit(id) && findEvent(id);
  if (!ev) return;
  ev.title = edTitle.value;
  if (ev.sourceId === 'local') saveLocal();
  else state.pending.set(id, { ...state.pending.get(id), title: ev.title });
  render();
});
edTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeEditor();
  if (e.key === 'Escape') {
    const ev = findLocal(state.editing?.id);
    if (state.editing?.isNew && ev && !ev.title.trim()) {
      state.local = state.local.filter((x) => x !== ev);
      state.editing = null;
      state.focus = null;
      saveLocal();
      render();
    } else {
      closeEditor();
    }
  }
});
edColors.addEventListener('click', (e) => {
  const gid = e.target.closest('[data-color-id]')?.dataset.colorId;
  const synced = gid !== undefined && findEvent(state.editing?.id);
  if (synced && synced.target?.startsWith('google|')) {
    synced.colorId = gid;
    synced.color = gid ? GOOGLE_EVENT_COLORS[gid] : targetColor(synced.target);
    saveLocal();
    render();
    return;
  }
  if (synced && synced.sourceId === 'google') {
    synced.colorId = gid || null;
    synced.color = gid ? GOOGLE_EVENT_COLORS[gid] : synced.calendarColor;
    state.pending.set(synced.id, { ...state.pending.get(synced.id), colorId: synced.colorId, color: synced.color });
    persist(synced, { colorId: synced.colorId });
    render();
    return;
  }
  const color = e.target.closest('[data-color]')?.dataset.color;
  const ev = findLocal(state.editing?.id);
  if (color && ev) {
    ev.color = color;
    saveLocal();
    render();
  }
});
edDelete.addEventListener('click', () => removeEvent(state.editing?.id));
document.getElementById('ed-done').addEventListener('click', closeEditor);

document.addEventListener('keydown', (e) => {
  if (dialog.open || e.target.closest?.('input, textarea, button')) return;
  const id = state.focus;
  if (e.key === 'Escape') {
    if (state.editing) closeEditor();
    else if (id) setFocus(null);
    return;
  }
  if (!id) return;
  if (e.key === 'Enter') {
    openEditor(id);
    e.preventDefault();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    removeEvent(id);
    e.preventDefault();
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && canEdit(id)) {
    const ev = findEvent(id);
    const now = clockNow();
    const key = ev.start.getHours() < 12 ? 'am' : 'pm';
    const step = (e.key === 'ArrowRight' ? 1 : -1) * 15 * MIN;
    const spot = placeIn(bandWindow(now, key), ev.start.getTime() + step, ev.end - ev.start);
    if (spot) {
      ev.start = new Date(spot.start);
      ev.end = new Date(spot.end);
      persist(ev, { start: ev.start, end: ev.end });
      render();
    }
    e.preventDefault();
  }
});

function probe(e) {
  const now = clockNow();
  const hit = pointToTime(parts.svg, e.clientX, e.clientY, now);
  let id = e.target.closest?.('[data-id]')?.dataset.id || null;
  const pxPerMs = hit ? (hit.r * TAU) / (12 * 3600e3) : 0;
  if (!id && hit) {
    const near = [...state.local, ...state.events].find((ev) => {
      if (ev.sourceId !== 'local' && !ev.editable) return false;
      if ((ev.start.getHours() < 12 ? 'am' : 'pm') !== hit.key) return false;
      const dEnd = Math.abs(hit.ms - ev.end.getTime()) * pxPerMs;
      const dStart = Math.abs(hit.ms - ev.start.getTime()) * pxPerMs;
      return dEnd <= EDGE_PX || dStart <= EDGE_PX;
    });
    if (near) id = near.id;
  }
  if (!id) return { hit, id: null, zone: null };
  if (!canEdit(id) || !hit) return { hit, id, zone: 'body' };
  const ev = findEvent(id);
  const fromStart = Math.abs(hit.ms - ev.start.getTime()) * pxPerMs;
  const fromEnd = Math.abs(hit.ms - ev.end.getTime()) * pxPerMs;
  let zone = 'body';
  if (fromEnd <= EDGE_PX && fromEnd <= fromStart) zone = 'end';
  else if (fromStart <= EDGE_PX) zone = 'start';
  return { hit, id, zone };
}

const CURSORS = { start: 'ew-resize', end: 'ew-resize', body: 'grab' };
let press = null;
let lastClick = { at: 0, id: null, x: 0, y: 0 };

face.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !parts) return;
  const p = probe(e);
  press = { x: e.clientX, y: e.clientY, probe: p, mode: null };
  parts.svg.setPointerCapture(e.pointerId);
  if (p.id) e.preventDefault();
});

face.addEventListener('pointermove', (e) => {
  if (!parts) return;
  if (!press) {
    const p = probe(e);
    parts.svg.style.cursor = p.id ? (canEdit(p.id) ? CURSORS[p.zone] : 'pointer') : p.hit ? 'cell' : '';
    const hover = p.id && canEdit(p.id) ? { id: p.id, zone: p.zone } : null;
    if (hover?.id !== state.hover?.id || hover?.zone !== state.hover?.zone || !state.hoverClock) {
      state.hover = hover;
      state.hoverClock = true;
      render();
    }
    return;
  }
  if (!press.mode) {
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
    startDrag();
    if (!press.mode) return;
  }
  dragTo(e);
});

function startDrag() {
  const { probe: p } = press;
  const now = clockNow();
  if (p.id && canEdit(p.id) && p.hit) {
    const ev = findEvent(p.id);
    press.mode = p.zone === 'body' ? 'move' : p.zone;
    press.grab = p.hit.ms - ev.start.getTime();
    press.length = ev.end - ev.start;
    press.id = p.id;
    state.dragId = p.id;
    parts.svg.style.cursor = press.mode === 'move' ? 'grabbing' : 'ew-resize';
  } else if (!p.id && p.hit) {
    press.mode = 'paint';
    press.anchor = snapTo(p.hit.ms, 15 * MIN);
    press.key = p.hit.key;
  }
  state.drag = Boolean(press.mode);
}

function dragTo(e) {
  const now = clockNow();
  const hit = pointToTime(parts.svg, e.clientX, e.clientY, now);
  if (!hit) return;
  const quarter = 15 * MIN;

  if (press.mode === 'paint') {
    if (hit.key !== press.key) return;
    const t = snapTo(hit.ms, quarter);
    let s = Math.min(press.anchor, t);
    let en = Math.max(press.anchor, t);
    if (en - s < quarter) en = s + quarter;
    const spot = placeIn(hit.window, s, en - s);
    if (!spot) return;
    if (!press.id) press.id = addLocal(spot.start, spot.end).id;
    const ev = findLocal(press.id);
    ev.start = new Date(spot.start);
    ev.end = new Date(spot.end);
    state.dragId = press.id;
  } else {
    const ev = findEvent(press.id);
    if (!ev) return;
    if (press.mode === 'move') {
      const spot = placeIn(hit.window, snapTo(hit.ms - press.grab, quarter), press.length);
      if (!spot) return;
      ev.start = new Date(spot.start);
      ev.end = new Date(spot.end);
    } else {
      const w = bandWindow(now, ev.start.getHours() < 12 ? 'am' : 'pm');
      if (hit.key !== w.key) return;
      const t = snapTo(hit.ms, quarter);
      if (press.mode === 'start') {
        ev.start = new Date(Math.min(Math.max(t, w.start.getTime()), ev.end.getTime() - quarter));
      } else {
        ev.end = new Date(Math.max(Math.min(t, w.end.getTime()), ev.start.getTime() + quarter));
      }
    }
  }
  render();
}

function endPress(e) {
  if (!press) return;
  const p = press;
  press = null;
  const wasDrag = Boolean(p.mode);
  state.drag = false;
  state.dragId = null;
  if (wasDrag) {
    const moved = p.id && findEvent(p.id);
    if (moved && p.mode !== 'paint') persist(moved, { start: moved.start, end: moved.end });
    else saveLocal();
    if (p.mode === 'paint' && p.id) openEditor(p.id, true);
    else {
      if (!state.editing) state.focus = null;
      render();
    }
    return;
  }
  if (e.type === 'pointercancel') return;

  const t = performance.now();
  const id = p.probe.id;
  const isDouble =
    t - lastClick.at < DOUBLE_MS && lastClick.id === id && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 12;
  lastClick = isDouble ? { at: 0, id: null, x: 0, y: 0 } : { at: t, id, x: e.clientX, y: e.clientY };

  if (id) {
    if (isDouble) openEditor(id);
    else {
      if (state.editing && state.editing.id !== id) closeEditor();
      setFocus(id);
    }
    return;
  }
  if (isDouble && p.probe.hit) {
    const start = Math.floor(p.probe.hit.ms / ADD_SNAP_MS) * ADD_SNAP_MS;
    const spot = placeIn(p.probe.hit.window, start, 30 * MIN);
    if (spot) openEditor(addLocal(spot.start, spot.end).id, true);
    return;
  }
  if (state.editing || state.focus) {
    if (state.editing) closeEditor();
    setFocus(null);
    return;
  }
  if (e.pointerType !== 'mouse') setShowAll(!state.showAll);
}

function setShowAll(on) {
  if (state.showAll === on) return;
  state.showAll = on;
  showToast(on ? 'Showing finished events' : 'Finished events hidden', false, 1600);
  render();
}

face.addEventListener('pointerleave', () => {
  if ((state.hover || state.hoverClock) && !press) {
    state.hover = null;
    state.hoverClock = false;
    render();
  }
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#face, #editor, #tray, #toast, dialog, #gear')) return;
  if (state.editing) closeEditor();
  if (state.focus) setFocus(null);
  if (state.showAll) setShowAll(false);
});
face.addEventListener('pointerup', endPress);
face.addEventListener('pointercancel', endPress);

const chipWidth = (mins) => 24 + mins * 0.6;

function renderTray() {
  tray.innerHTML = `
    ${DURATIONS.map((d) => {
      const color = addColor(d.mins);
      return `<button type="button" class="chip" data-mins="${d.mins}" style="--chip:${color};--ink:${inkFor(color)};--w:${chipWidth(d.mins)}px" aria-label="${d.label} event: drag onto the clock, click for colour, double-click to add">${d.label}</button>`;
    }).join('')}
    <div class="tray-palette" role="group" aria-label="Colour for this block" hidden>${colorChoices().map(
      (c) => `<button type="button" class="ed-color" data-color="${c}" style="background:${c}" aria-label="Use this colour"></button>`,
    ).join('')}</div>`;
}

function togglePalette(chip) {
  const palette = tray.querySelector('.tray-palette');
  const open = palette.hidden || palette.dataset.for !== chip.dataset.mins;
  palette.hidden = !open;
  palette.dataset.for = chip.dataset.mins;
  if (open) {
    const current = addColor(Number(chip.dataset.mins));
    for (const b of palette.querySelectorAll('[data-color]')) {
      b.setAttribute('aria-pressed', String(b.dataset.color === current));
    }
    const t = tray.getBoundingClientRect();
    const c = chip.getBoundingClientRect();
    palette.style.left = `${c.left + c.width / 2 - t.left}px`;
  }
}

function closePalette() {
  const palette = tray.querySelector('.tray-palette');
  if (palette) palette.hidden = true;
}

tray.addEventListener('click', (e) => {
  const pick = e.target.closest('[data-color]');
  if (!pick) return;
  const mins = tray.querySelector('.tray-palette').dataset.for;
  state.config.chipColors = { ...state.config.chipColors, [mins]: pick.dataset.color };
  saveConfig(state.config);
  renderTray();
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#tray')) closePalette();
});

function earliestFreeSpot(mins) {
  const now = clockNow();
  const len = mins * MIN;
  const step = Math.min(30, mins) * MIN;
  const busy = todaysEvents(now)
    .filter((e) => !e.allDay)
    .map((e) => [e.start.getTime(), e.end.getTime()]);
  const dayEnd = dayAt(now, 1).getTime();
  for (let s = Math.ceil(now.getTime() / step) * step; s + len <= dayEnd; s += step) {
    const key = new Date(s).getHours() < 12 ? 'am' : 'pm';
    if (s + len > bandWindow(now, key).end.getTime()) continue;
    if (busy.every(([bs, be]) => s + len <= bs || s >= be)) return { start: s, end: s + len };
  }
  return null;
}

function dropSpot(hit, mins) {
  const step = Math.min(30, mins) * MIN;
  const start = snapTo(hit.ms - (mins * MIN) / 2, step);
  const spot = placeIn(hit.window, start, mins * MIN);
  return spot && { key: hit.key, ...spot };
}

let lastChipClick = { at: 0, mins: null };

tray.addEventListener('pointerdown', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip || e.button !== 0) return;
  e.preventDefault();
  const mins = Number(chip.dataset.mins);
  const color = addColor(mins);
  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.style.background = color;
  ghost.style.width = `${chipWidth(mins)}px`;
  ghost.style.opacity = '0';
  document.body.append(ghost);
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let spot = null;

  const move = (ev) => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    if (!dragging) {
      dragging = true;
      closePalette();
    }
    ghost.style.transform = `translate(${ev.clientX - chipWidth(mins) / 2}px, ${ev.clientY - 10}px)`;
    const hit = pointToTime(parts.svg, ev.clientX, ev.clientY, clockNow());
    spot = hit ? dropSpot(hit, mins) : null;
    ghost.style.opacity = spot ? '0' : '0.92';
    state.preview = spot && { ...spot, color };
    render();
  };
  const up = (ev) => {
    chip.removeEventListener('pointermove', move);
    chip.removeEventListener('pointerup', up);
    chip.removeEventListener('pointercancel', up);
    ghost.remove();
    state.preview = null;
    if (ev.type === 'pointercancel') return render();
    if (dragging) {
      if (spot) openEditor(addLocal(spot.start, spot.end, color).id, true);
      else render();
      return;
    }
    const t = performance.now();
    if (t - lastChipClick.at < DOUBLE_MS && lastChipClick.mins === mins) {
      lastChipClick = { at: 0, mins: null };
      closePalette();
      const free = earliestFreeSpot(mins);
      if (free) openEditor(addLocal(free.start, free.end, color).id, true);
      else showToast('No free time left today', false);
      return;
    }
    lastChipClick = { at: t, mins };
    togglePalette(chip);
  };
  chip.setPointerCapture(e.pointerId);
  chip.addEventListener('pointermove', move);
  chip.addEventListener('pointerup', up);
  chip.addEventListener('pointercancel', up);
});

renderTray();

(function tick() {
  render();
  setTimeout(tick, 1000 - ((Date.now() + timeOffset) % 1000) + 2);
})();
(function frame() {
  if (currentStyle() === 'sweep' && parts) setHands(parts.svg, 'sweep', clockNow(), true);
  requestAnimationFrame(frame);
})();

function loadCachedEvents() {
  try {
    const raw = JSON.parse(localStorage.getItem(EVENTS_KEY) || '[]');
    return raw.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
  } catch {
    return [];
  }
}

function cacheEvents(events) {
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch {
  }
}

function accountsOn() {
  return Object.keys(ACCOUNTS).some((s) => state.config[s]?.enabled);
}
function anySources() {
  return state.config.sources.length > 0 || accountsOn();
}

let loadedDay = '';
let refreshTimer = 0;
function refreshSoon(ms = 800) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

async function refresh() {
  if (state.loading) return;
  if (state.drag) return refreshSoon(1500);
  state.loading = true;
  const now = clockNow();
  loadedDay = now.toDateString();
  try {
    const r = await fetchAllEvents(state.config, dayAt(now), dayAt(now, 1));
    const failed = new Set(Object.keys(r.status).filter((k) => r.status[k]));
    const kept = state.events.filter((e) => failed.has(e.sourceId));
    state.events = [...r.events, ...kept];
    applyPending();
    state.status = r.status;
    state.hasSources = r.hasSources;
    if (r.hasSources) clearDemo();

    let renamed = false;
    for (const s of state.config.sources) {
      if (s.autoName && r.names[s.id] && s.name !== r.names[s.id]) {
        s.name = r.names[s.id];
        renamed = true;
      }
    }
    if (renamed) saveConfig(state.config);
    cacheEvents(state.events);
  } finally {
    state.loading = false;
    render();
    renderSettings();
  }
}

const dialog = document.getElementById('settings');
const styleRow = document.getElementById('style-row');
const list = document.getElementById('source-list');
const addForm = document.getElementById('add-form');
const addUrl = document.getElementById('add-url');
const addError = document.getElementById('add-error');
const targetRow = document.getElementById('target-row');
const targetSelect = document.getElementById('target-select');
const moveLocal = document.getElementById('move-local');
const panels = {
  google: document.getElementById('panel-google'),
  apple: document.getElementById('panel-apple'),
  link: document.getElementById('panel-link'),
};

async function loadAccounts() {
  const [g, a] = await Promise.all([accountStatus('google'), accountStatus('apple')]);
  state.google = g;
  state.apple = a;
  renderSettings();
  renderTray();
}

document.getElementById('gear').addEventListener('click', () => {
  dialog.showModal();
  renderSettings();
  loadAccounts();
});

function guessName(url) {
  try {
    const u = new URL(url.replace(/^webcals?:/i, 'https:'));
    if (u.hostname.includes('google.com')) return 'Google calendar';
    if (u.hostname.includes('icloud.com')) return 'Apple calendar';
    if (u.hostname.includes('outlook') || u.hostname.includes('office365')) return 'Outlook calendar';
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'Calendar';
  }
}

function statusLine(id, extra = '') {
  if (!(id in state.status)) return { text: state.loading ? 'Syncing…' : 'Not synced yet', bad: false };
  const err = state.status[id];
  if (err) return { text: err, bad: true };
  const n = state.events.filter((e) => e.sourceId === id && e.end > clockNow()).length;
  const base = n ? `${n} still to come today` : 'Synced · nothing else today';
  return { text: extra ? `${extra} · ${base}` : base, bad: false };
}

function sourceRow({ name, title, state: st, color, onRemove, onColor, icon }) {
  const li = document.createElement('li');
  li.innerHTML = `
    ${
      onColor
        ? `<input class="swatch" type="color" value="${esc(color)}" aria-label="Colour for ${esc(name)}" />`
        : `<span class="src-icon">${icon || ''}</span>`
    }
    <div class="meta">
      <div class="name" title="${esc(title || name)}">${esc(name)}</div>
      <div class="state${st.bad ? ' bad' : ''}">${esc(st.text)}</div>
    </div>
    <button class="icon" type="button" aria-label="Remove ${esc(name)}">&times;</button>`;
  if (onColor) li.querySelector('.swatch').addEventListener('change', (e) => onColor(e.target.value));
  li.querySelector('button').addEventListener('click', onRemove);
  return li;
}

const ICONS = {
  google: document.querySelector('[data-connect="google"] svg').outerHTML,
  apple: document.querySelector('[data-connect="apple"] svg').outerHTML,
};

async function disconnectAccount(source) {
  await accountDisconnect(source).catch(() => {});
  state.config[source].enabled = false;
  if (state[source]) state[source].connected = false;
  state.events = state.events.filter((ev) => ev.sourceId !== source);
  delete state.status[source];
  state.hasSources = anySources();
  saveConfig(state.config);
  cacheEvents(state.events);
  render();
  renderSettings();
}

function renderReconnect() {
  reconnectBtn.hidden = !(state.config.google.enabled && googleNeedsReconnect());
}

function renderSettings() {
  renderReconnect();
  document.documentElement.classList.toggle('no-sources', !state.hasSources);
  document.documentElement.classList.toggle('no-server', !state.onServer);
  if (!dialog.open) return;

  const style = currentStyle();
  styleRow.innerHTML = STYLES.map(
    (s) =>
      `<button type="button" data-style="${s.id}" aria-pressed="${s.id === style}">${esc(s.label)}</button>`,
  ).join('');
  showPast.checked = state.config.showPastOnHover !== false;

  list.innerHTML = '';
  for (const source of Object.keys(ACCOUNTS)) {
    if (!state.config[source]?.enabled) continue;
    const label = source === 'apple' && state.apple.appleId ? `iCloud (${state.apple.appleId})` : ACCOUNTS[source];
    list.append(
      sourceRow({
        name: label,
        icon: ICONS[source],
        state: statusLine(source, 'Two-way sync'),
        onRemove: () => disconnectAccount(source),
      }),
    );
  }
  for (const s of state.config.sources) {
    list.append(
      sourceRow({
        name: s.name,
        title: s.url,
        color: s.color,
        state: statusLine(s.id, 'Read-only link'),
        onColor: (c) => {
          s.color = c;
          for (const ev of state.events) if (ev.sourceId === s.id) ev.color = c;
          saveConfig(state.config);
          cacheEvents(state.events);
          render();
        },
        onRemove: () => {
          state.config.sources = state.config.sources.filter((x) => x !== s);
          state.events = state.events.filter((ev) => ev.sourceId !== s.id);
          delete state.status[s.id];
          state.hasSources = anySources();
          saveConfig(state.config);
          cacheEvents(state.events);
          render();
          renderSettings();
        },
      }),
    );
  }

  for (const source of Object.keys(ACCOUNTS)) {
    const btn = document.querySelector(`[data-connect="${source}"]`);
    const on = Boolean(state.config[source]?.enabled);
    btn.classList.toggle('connected', on);
    btn.disabled = on;
    btn.title = on ? `${ACCOUNTS[source]} is connected` : `Connect ${ACCOUNTS[source]}`;
  }
  document.getElementById('redirect-uri').textContent =
    state.google.redirectUri || `${location.origin}/auth/google/callback`;

  const options = targets();
  targetRow.hidden = options.length < 2;
  const current = newEventTarget();
  targetSelect.innerHTML = options
    .map((o) => `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');

  const clockOnly = state.local.filter((e) => !e.demo && !e.target);
  const dest = options.find((o) => o.value === current);
  moveLocal.hidden = !(clockOnly.length && current !== 'local');
  if (!moveLocal.hidden) {
    moveLocal.innerHTML = `${clockOnly.length} event${clockOnly.length > 1 ? 's are' : ' is'} only on this clock. <button type="button" class="link">Add ${clockOnly.length > 1 ? 'them' : 'it'} to ${esc(dest.label)}</button>`;
  }
}

moveLocal.addEventListener('click', async (e) => {
  if (!e.target.closest('button')) return;
  const target = newEventTarget();
  const clockOnly = state.local.filter((ev) => !ev.demo && !ev.target);
  for (const ev of clockOnly) {
    ev.target = target;
    upload(ev);
  }
  renderSettings();
});

targetSelect.addEventListener('change', () => {
  state.config.newEventsTo = targetSelect.value;
  saveConfig(state.config);
  renderSettings();
  renderTray();
});

const showPast = document.getElementById('show-past');
showPast.addEventListener('change', () => {
  state.config.showPastOnHover = showPast.checked;
  saveConfig(state.config);
  render();
});

styleRow.addEventListener('click', (e) => {
  const id = e.target.closest('[data-style]')?.dataset.style;
  if (!id) return;
  state.config.style = id;
  saveConfig(state.config);
  if (styleParam) {
    params.delete('style');
    history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
    location.reload();
    return;
  }
  render();
  renderSettings();
});

document.querySelector('.connect-row').addEventListener('click', (e) => {
  const which = e.target.closest('[data-connect]')?.dataset.connect;
  if (!which) return;
  if (which === 'google' && !state.onServer) return connectGoogleInBrowser();
  if (which === 'google' && state.google.configured) return startGoogle();
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== which || !panel.hidden;
  panels[which].querySelector('input')?.focus();
});

const reconnectBtn = document.getElementById('reconnect');
reconnectBtn.addEventListener('click', connectGoogleInBrowser);

function connectGoogleInBrowser() {
  googleConnectInBrowser()
    .then(async () => {
      state.config.google.enabled = true;
      state.hasSources = true;
      saveConfig(state.config);
      clearDemo();
      showToast('Google Calendar connected', false);
      await loadAccounts();
      await refresh();
    })
    .catch((err) => showToast(err.message, false));
}

function startGoogle() {
  state.config.google.enabled = true;
  saveConfig(state.config);
  location.href = '/auth/google/start';
}

document.getElementById('copy-redirect').addEventListener('click', async (e) => {
  const text = document.getElementById('redirect-uri').textContent;
  try {
    await navigator.clipboard.writeText(text);
    e.target.textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren(document.getElementById('redirect-uri'));
    e.target.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => (e.target.textContent = 'Copy'), 1800);
});

function formError(id, err) {
  const el = document.getElementById(id);
  el.textContent = err ? err.message || String(err) : '';
  el.hidden = !err;
}

async function busy(form, fn) {
  const btn = form.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

document.getElementById('google-form').addEventListener('submit', (e) => {
  e.preventDefault();
  formError('google-error', null);
  busy(e.target, async () => {
    try {
      state.google = await googleSetup(
        document.getElementById('g-client-id').value,
        document.getElementById('g-client-secret').value,
      );
      startGoogle();
    } catch (err) {
      formError('google-error', err);
    }
  });
});

document.getElementById('apple-form').addEventListener('submit', (e) => {
  e.preventDefault();
  formError('apple-error', null);
  busy(e.target, async () => {
    try {
      state.apple = await appleConnect(
        document.getElementById('apple-id').value,
        document.getElementById('apple-pass').value,
      );
      document.getElementById('apple-pass').value = '';
      state.config.apple.enabled = true;
      state.hasSources = true;
      saveConfig(state.config);
      panels.apple.hidden = true;
      clearDemo();
      await refresh();
    } catch (err) {
      formError('apple-error', err);
    }
  });
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = addUrl.value.trim();
  addError.hidden = true;
  if (!/^(https?|webcals?):\/\//i.test(url)) {
    addError.textContent = 'Paste a link that starts with https:// or webcal://';
    addError.hidden = false;
    return;
  }
  if (state.config.sources.some((s) => s.url === url)) {
    addError.textContent = 'That calendar is already added.';
    addError.hidden = false;
    return;
  }
  state.config.sources.push({
    id: crypto.randomUUID(),
    type: 'ics',
    url,
    name: guessName(url),
    autoName: true,
    color: nextColor(state.config),
    enabled: true,
  });
  state.hasSources = true;
  saveConfig(state.config);
  addUrl.value = '';
  panels.link.hidden = true;
  renderSettings();
  await refresh();
});

const googleResult = params.get('google');
if (googleResult) {
  params.delete('google');
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
  if (googleResult === 'connected') {
    state.config.google.enabled = true;
    showToast('Google Calendar connected', false);
  } else {
    state.config.google.enabled = false;
    const msg = googleResult === 'not-set-up' ? 'Google isn’t set up yet' : `Google sign-in failed: ${googleResult}`;
    showToast(msg, false);
  }
  saveConfig(state.config);
  state.hasSources = anySources();
}

seedDemo(clockNow());
renderSettings();
refresh();
loadAccounts();
serverMode.then((v) => {
  state.onServer = v;
  renderSettings();
});

let ticks = 0;
setInterval(() => {
  ticks += 1;
  if (accountsOn() || ticks % 5 === 0) refresh();
}, 60 * 1000);
setInterval(() => {
  if (clockNow().toDateString() !== loadedDay) {
    seedDemo(clockNow());
    refresh();
  }
}, 30 * 1000);
let lastFocusRefresh = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFocusRefresh > 20 * 1000) {
    lastFocusRefresh = Date.now();
    refresh();
  }
});
