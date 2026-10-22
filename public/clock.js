export const C = 200;
export const TAU = Math.PI * 2;
const DIAL_R = 121;
const BAND = 28;
export const RING = { am: 141, pm: 172 };
const MAX_LANES = 3;
const LANE_GAP = 2;
const MIN_LABEL_STROKE = 11;

export const STYLES = [
  { id: 'ticking', label: 'Ticking' },
  { id: 'sweep', label: 'Sweep' },
  { id: 'minimal', label: 'Minimal' },
];
export const isAnalog = (style) => style !== 'minimal';

const f = (n) => n.toFixed(2);
export const pt = (r, a) => [C + r * Math.sin(a), C - r * Math.cos(a)];

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dayAt = (d, add = 0, h = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + add, h);

function arcPath(r, a0, a1, reverse = false) {
  if (a1 - a0 >= TAU - 1e-4) {
    const [x0, y0] = pt(r, 0);
    const [x1, y1] = pt(r, Math.PI);
    return `M${f(x0)} ${f(y0)}A${r} ${r} 0 1 1 ${f(x1)} ${f(y1)}A${r} ${r} 0 1 1 ${f(x0)} ${f(y0)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(r, reverse ? a1 : a0);
  const [x1, y1] = pt(r, reverse ? a0 : a1);
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} ${reverse ? 0 : 1} ${f(x1)} ${f(y1)}`;
}

export function windows(now) {
  const noon = dayAt(now, 0, 12);
  const morning = now < noon;
  return {
    am: { key: 'am', start: dayAt(now), end: noon, active: morning },
    pm: { key: 'pm', start: noon, end: dayAt(now, 1), active: !morning },
  };
}

export function angleOf(ms, w) {
  if (ms >= w.end.getTime()) return TAU;
  if (ms <= w.start.getTime()) return 0;
  const t = new Date(ms);
  const minutes = (t.getHours() % 12) * 60 + t.getMinutes() + t.getSeconds() / 60;
  return (minutes / 720) * TAU;
}

const measureCtx = document.createElement('canvas').getContext('2d');
const FONT_STACK = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui';
function textWidth(s, size) {
  measureCtx.font = `600 ${size}px ${FONT_STACK}`;
  return measureCtx.measureText(s).width;
}
function fitLabel(title, size, avail) {
  if (textWidth(title, size) <= avail) return title;
  for (let n = title.length - 1; n >= 3; n--) {
    const t = `${title.slice(0, n).trimEnd()}…`;
    if (textWidth(t, size) <= avail) return t;
  }
  return '';
}

export function inkFor(color) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return lum > 0.6 ? 'rgba(0,0,0,0.72)' : '#fff';
}

function layout(events, w) {
  const ws = w.start.getTime();
  const we = w.end.getTime();
  const segs = [];
  for (const ev of events) {
    if (ev.allDay) continue;
    const s = Math.max(ev.start.getTime(), ws);
    const e = Math.min(ev.end.getTime(), we);
    if (e > s) segs.push({ ev, s, e });
  }
  segs.sort((a, b) => a.s - b.s || b.e - a.e);

  let cluster = [];
  let clusterEnd = -Infinity;
  let laneEnds = [];
  const close = () => {
    for (const seg of cluster) seg.lanes = Math.min(laneEnds.length, MAX_LANES);
    cluster = [];
    laneEnds = [];
  };
  for (const seg of segs) {
    if (cluster.length && seg.s >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= seg.s);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(seg.e);
    } else {
      laneEnds[lane] = seg.e;
    }
    seg.lane = Math.min(lane, MAX_LANES - 1);
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, seg.e);
  }
  close();
  return segs;
}

function tilePath(r, sw, a0, a1) {
  a1 = Math.min(a1, a0 + TAU - 0.002);
  const ro = r + sw / 2;
  const ri = r - sw / 2;
  const rc = Math.max(0, Math.min(7, sw / 2 - 0.5, ((a1 - a0) * ri) / 2 - 0.05));
  const dO = rc / ro;
  const dI = rc / ri;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const P = (rr, a) => pt(rr, a).map(f).join(' ');
  return (
    `M${P(ro, a0 + dO)}A${f(ro)} ${f(ro)} 0 ${large} 1 ${P(ro, a1 - dO)}` +
    `Q${P(ro, a1)} ${P(ro - rc, a1)}L${P(ri + rc, a1)}Q${P(ri, a1)} ${P(ri, a1 - dI)}` +
    `A${f(ri)} ${f(ri)} 0 ${large} 0 ${P(ri, a0 + dI)}` +
    `Q${P(ri, a0)} ${P(ri + rc, a0)}L${P(ro - rc, a0)}Q${P(ro, a0)} ${P(ro, a0 + dO)}Z`
  );
}

function laneGeometry(seg, key) {
  const laneW = BAND / seg.lanes;
  const r = RING[key] + BAND / 2 - laneW * (seg.lane + 0.5);
  const sw = Math.max(laneW - (seg.lanes > 1 ? LANE_GAP : 0), 3);
  return { r, sw };
}

function wedgePath(a0, a1) {
  const [x0, y0] = pt(200, a0);
  const [x1, y1] = pt(200, a1);
  return `M${C} ${C}L${f(x0)} ${f(y0)}A200 200 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f(x1)} ${f(y1)}Z`;
}

function segmentSvg(seg, w, nowMs, ctx) {
  const done = seg.e <= nowMs;
  if (done && !ctx.showDone && ctx.focused !== seg.ev.id) return '';

  const { r, sw } = laneGeometry(seg, w.key);
  const a0 = angleOf(seg.s, w);
  const a1 = angleOf(seg.e, w);
  const len = (a1 - a0) * (r - sw / 2);
  if (len < 0.8) return '';

  const { ev } = seg;
  const sel = ctx.focused === ev.id ? ' selected' : '';
  const local = ev.sourceId === 'local' || ev.editable ? ' local' : '';
  const title = `<title>${esc(ev.title)} · ${esc(ctx.fmtRange(ev))}</title>`;
  const id = esc(ev.id);
  const ink = inkFor(ev.color);
  const tile = tilePath(r, sw, a0, a1);

  let out = `<path class="ev${sel}${local}${done ? ' done' : ''}" data-id="${id}" d="${tile}" fill="${esc(ev.color)}">${title}</path>`;

  if (done) {
    out += `<path class="elapsed" d="${tile}" />`;
  } else if (seg.s < nowMs) {
    const cid = `el${ctx.uid++}`;
    out += `<clipPath id="${cid}"><path d="${wedgePath(a0 - 0.05, angleOf(nowMs, w))}" /></clipPath>`;
    out += `<path class="elapsed" d="${tile}" clip-path="url(#${cid})" />`;
  }

  const hovered = ctx.hover?.id === ev.id;
  const showGrips = local && (sel || hovered);
  if (showGrips && len > 18) {
    const grip = (ang, zone) => {
      const hot = hovered && ctx.hover.zone === zone ? ' hot' : '';
      const [x0, y0] = pt(r - sw / 2 + 6, ang);
      const [x1, y1] = pt(r + sw / 2 - 6, ang);
      return `<line class="grip${hot}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="${ink}" />`;
    };
    const inset = 5 / r;
    if (seg.s === ev.start.getTime()) out += grip(a0 + inset, 'start');
    if (seg.e === ev.end.getTime()) out += grip(a1 - inset, 'end');
  }

  if (sw >= MIN_LABEL_STROKE) {
    const pad = local ? 22 : 10;
    const avail = (a1 - a0) * r - pad;
    const maxSize = Math.min(14, Math.max(8, sw * 0.5));
    const minSize = Math.min(maxSize, Math.max(8, sw * 0.38));
    let size = maxSize;
    while (size > minSize && textWidth(ev.title, size) > avail) size -= 0.5;
    const text = fitLabel(ev.title, size, avail);
    if (text) {
      const mid = (a0 + a1) / 2;
      const flip = mid > Math.PI / 2 && mid < (3 * Math.PI) / 2;
      const pid = `lp${ctx.uid++}`;
      out += `<path id="${pid}" d="${arcPath(r, a0, a1, flip)}" fill="none" />`;
      out += `<text class="arc-label${sel}" fill="${ink}" font-size="${f(size)}" dominant-baseline="central"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(text)}</textPath></text>`;
    }
  }
  return done ? `<g class="done-seg">${out}</g>` : out;
}

const DEFS = `
  <defs>
    <filter id="dial-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow class="shadow-near" dx="0" dy="1" stdDeviation="1" flood-color="#000" />
      <feDropShadow class="shadow-far" dx="0" dy="8" stdDeviation="10" flood-color="#000" />
    </filter>
    <filter id="hand-shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" flood-color="#000" flood-opacity="0.28" />
    </filter>
    <filter id="pill-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#000" flood-opacity="0.14" />
    </filter>
    <pattern id="past-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line class="hatch" x1="0" y1="0" x2="0" y2="5" />
    </pattern>
    <radialGradient id="dial-fill" cx="50%" cy="38%" r="70%">
      <stop offset="0" style="stop-color: var(--dial-hi)" />
      <stop offset="1" style="stop-color: var(--dial)" />
    </radialGradient>
  </defs>`;

export function dialSvg(style) {
  let s = DEFS;
  s += `<circle class="dial" cx="${C}" cy="${C}" r="${DIAL_R}" fill="url(#dial-fill)" filter="url(#dial-shadow)" />`;
  s += `<circle class="dial-rim" cx="${C}" cy="${C}" r="${DIAL_R - 0.5}" />`;

  if (!isAnalog(style)) {
    for (let h = 0; h < 12; h++) {
      const [x, y] = pt(DIAL_R - 9, (h / 12) * TAU);
      s += `<circle class="pip${h % 3 ? '' : ' major'}" cx="${f(x)}" cy="${f(y)}" r="${h % 3 ? 1.2 : 1.8}" />`;
    }
    return s;
  }

  for (let m = 0; m < 60; m++) {
    const a = (m / 60) * TAU;
    const hour = m % 5 === 0;
    const [x0, y0] = pt(hour ? DIAL_R - 16 : DIAL_R - 10, a);
    const [x1, y1] = pt(DIAL_R - 6, a);
    s += `<line class="${hour ? 'mark-h' : 'mark-m'}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" />`;
  }
  for (let h = 1; h <= 12; h++) {
    const [x, y] = pt(DIAL_R - 31, (h / 12) * TAU);
    s += `<text class="num" x="${f(x)}" y="${f(y)}" text-anchor="middle" dominant-baseline="central">${h}</text>`;
  }
  return s;
}

export function gridSvg() {
  let s = '';
  for (const key of ['pm', 'am']) {
    const r = RING[key];
    const edge = r + BAND / 2 - 1.5;
    s += `<circle class="track ${key}" cx="${C}" cy="${C}" r="${r}" stroke-width="${BAND}" />`;
    for (let m = 0; m < 144; m++) {
      const a = (m / 144) * TAU;
      const kind = m % 36 === 0 ? 'rt-3h' : m % 12 === 0 ? 'rt-h' : m % 6 === 0 ? 'rt-30' : 'rt-m';
      const len = { 'rt-3h': 10, 'rt-h': 7.5, 'rt-30': 5, 'rt-m': 2 }[kind];
      const [x0, y0] = pt(edge, a);
      const [x1, y1] = pt(edge - len, a);
      s += `<line class="${kind}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" />`;
    }
  }
  return s;
}

export function pointToTime(svg, clientX, clientY, now) {
  const p = new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
  const dx = p.x - C;
  const dy = p.y - C;
  const r = Math.hypot(dx, dy);
  let key = null;
  if (r >= RING.am - BAND / 2 - 4 && r < (RING.am + RING.pm) / 2) key = 'am';
  else if (r >= (RING.am + RING.pm) / 2 && r <= RING.pm + BAND / 2 + 8) key = 'pm';
  if (!key) return null;
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += TAU;
  const w = windows(now)[key];
  return { key, window: w, r, ms: w.start.getTime() + (a / TAU) * 12 * 3600e3 };
}

export function bandsSvg(events, now, { focused, hover, showDone, preview, fmtRange }) {
  const nowMs = now.getTime();
  const w = windows(now);
  const ctx = { focused, hover, showDone, fmtRange, uid: 0 };
  let s = '';
  for (const ring of [w.pm, w.am]) {
    s += `<g class="ring ${ring.key} ${ring.active ? 'active' : 'inactive'}">`;
    if (nowMs > ring.start.getTime()) {
      const d = arcPath(RING[ring.key], 0, angleOf(nowMs, ring));
      s += `<path class="past" d="${d}" stroke-width="${BAND}" /><path class="past-hatch" d="${d}" stroke-width="${BAND}" />`;
    }
    s += `<g class="events" filter="url(#pill-shadow)">`;
    for (const seg of layout(events, ring)) s += segmentSvg(seg, ring, nowMs, ctx);
    s += `</g></g>`;
  }
  if (preview) {
    const ring = w[preview.key];
    const a0 = angleOf(preview.start, ring);
    const a1 = angleOf(preview.end, ring);
    if (a1 > a0) {
      s += `<path class="ev-preview" d="${tilePath(RING[preview.key], BAND, a0, a1)}" fill="${esc(preview.color)}" stroke="${esc(preview.color)}" />`;
    }
  }
  s += `<text class="ring-label" x="${C}" y="${C - RING.am}" text-anchor="middle" dominant-baseline="central">AM</text>`;
  s += `<text class="ring-label" x="${C}" y="${C - RING.pm}" text-anchor="middle" dominant-baseline="central">PM</text>`;
  return s;
}

export function handsSvg(style) {
  const playhead = `<line class="playhead" />`;
  if (!isAnalog(style)) return playhead;
  return `
    ${playhead}
    <g filter="url(#hand-shadow)">
      <line class="h-hour" x1="${C}" y1="${C + 13}" x2="${C}" y2="${C - 58}" />
      <line class="h-min" x1="${C}" y1="${C + 15}" x2="${C}" y2="${C - 106}" />
      <g class="h-sec">
        <line x1="${C}" y1="${C + 20}" x2="${C}" y2="${C - 112}" />
        <circle cx="${C}" cy="${C}" r="3.2" />
      </g>
    </g>
    <circle class="h-cap" cx="${C}" cy="${C}" r="1.5" />`;
}

let lastSecDeg = null;

export function setHands(svg, style, now, smooth) {
  const w = windows(now);
  const active = w.am.active ? w.am : w.pm;
  const a = angleOf(now.getTime(), active);
  const r = RING[active.key];
  const [x0, y0] = pt(r - BAND / 2 - 1, a);
  const [x1, y1] = pt(r + BAND / 2 + 1, a);
  const ph = svg.querySelector('.playhead');
  ph.setAttribute('x1', f(x0));
  ph.setAttribute('y1', f(y0));
  ph.setAttribute('x2', f(x1));
  ph.setAttribute('y2', f(y1));

  if (!isAnalog(style)) return;

  const sec = now.getSeconds() + (smooth ? now.getMilliseconds() / 1000 : 0);
  const min = now.getMinutes() + sec / 60;
  const hour = (now.getHours() % 12) + min / 60;
  svg.querySelector('.h-hour').style.transform = `rotate(${hour * 30}deg)`;
  svg.querySelector('.h-min').style.transform = `rotate(${min * 6}deg)`;

  let deg = sec * 6;
  const hand = svg.querySelector('.h-sec');
  if (lastSecDeg !== null) {
    while (deg < lastSecDeg - 0.01) deg += 360;
    hand.classList.toggle('jump', deg - lastSecDeg > 12);
  }
  lastSecDeg = deg;
  hand.style.transform = `rotate(${deg}deg)`;
}

export function resetHands() {
  lastSecDeg = null;
}
