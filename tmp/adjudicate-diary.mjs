/**
 * Independent MC diary adjudicator — reads calendar MCP dumps.
 * Busy map excludes MC-tied events. Finds overlaps, zero-gaps, 240-cap, window breaches.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = String.raw`C:\Users\alan\.cursor\projects\g-Dropbox-alan-ranger-photography-Website-Code-Chat-AI-Bot\agent-tools`;
const FILES = [
  '1d04bd30-a33b-42ff-ad82-d177eab7fbf7.txt',
  'c0eec649-277d-4fa2-b5e5-020fc8cbbed1.txt',
  '312b81fe-21e9-481f-abe1-f74c66f87749.txt',
];

const TIE_IDS = new Set(JSON.parse(fs.readFileSync(
  path.join(__dirname, 'tieback-ids.json'),
  'utf8',
)));

function loadEvents() {
  const byId = new Map();
  for (const f of FILES) {
    const raw = fs.readFileSync(path.join(DUMP_DIR, f), 'utf8');
    const data = JSON.parse(raw);
    for (const e of data.events || []) {
      if (e.status === 'cancelled') continue;
      byId.set(`${e.calendarId}|${e.id}`, e);
    }
  }
  return [...byId.values()];
}

function parseStart(e) {
  if (e.start?.date) return { allDay: true, day: e.start.date, ms: Date.parse(`${e.start.date}T00:00:00+01:00`) };
  const iso = e.start?.dateTime;
  return { allDay: false, day: iso.slice(0, 10), ms: Date.parse(iso), iso };
}

function parseEnd(e) {
  if (e.end?.date) return { allDay: true, day: e.end.date, ms: Date.parse(`${e.end.date}T00:00:00+01:00`) };
  const iso = e.end?.dateTime;
  return { allDay: false, day: iso.slice(0, 10), ms: Date.parse(iso), iso };
}

function londonDay(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(iso));
}

function londonMinutes(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function isMc(e) {
  if (TIE_IDS.has(e.id)) return true;
  if (e.colorId === '10') return true; // flag separately if unmatched
  return false;
}

function isTied(e) {
  return TIE_IDS.has(e.id);
}

function durationMin(e) {
  const s = parseStart(e);
  const en = parseEnd(e);
  if (s.allDay) return 0;
  return Math.round((en.ms - s.ms) / 60000);
}

function winForDay(day) {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 Sun
  const weekend = dow === 0 || dow === 6;
  return weekend
    ? { start: 11 * 60, end: 16 * 60, label: '11:00–16:00' }
    : { start: 10 * 60, end: 17 * 60, label: '10:00–17:00' };
}

const events = loadEvents();
const mc = events.filter(isMc);
const tied = events.filter(isTied);
const unmatchedColor10 = events.filter((e) => e.colorId === '10' && !TIE_IDS.has(e.id));

// Real commitments = non-MC timed + all-day (except transparent hotel stays still block day if all-day)
const busy = events.filter((e) => !isMc(e));

const overlaps = [];
const zeroGaps = [];
const timedMc = mc.filter((e) => e.start?.dateTime).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));

for (let i = 0; i < timedMc.length; i++) {
  for (let j = i + 1; j < timedMc.length; j++) {
    const a = timedMc[i];
    const b = timedMc[j];
    const aS = Date.parse(a.start.dateTime);
    const aE = Date.parse(a.end.dateTime);
    const bS = Date.parse(b.start.dateTime);
    const bE = Date.parse(b.end.dateTime);
    if (bS >= aE) break; // sorted; further j only later
    if (aS < bE && bS < aE) {
      overlaps.push({
        day: londonDay(a.start.dateTime),
        a: { id: a.id, title: a.summary, start: a.start.dateTime, end: a.end.dateTime },
        b: { id: b.id, title: b.summary, start: b.start.dateTime, end: b.end.dateTime },
        overlapMin: Math.round((Math.min(aE, bE) - Math.max(aS, bS)) / 60000),
      });
    }
  }
}

// Zero gaps: consecutive MC blocks on same day with gap < 30
const byDay = {};
for (const e of timedMc) {
  const d = londonDay(e.start.dateTime);
  (byDay[d] ||= []).push(e);
}
for (const [day, list] of Object.entries(byDay)) {
  list.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  for (let i = 0; i < list.length - 1; i++) {
    const aE = Date.parse(list[i].end.dateTime);
    const bS = Date.parse(list[i + 1].start.dateTime);
    const gap = Math.round((bS - aE) / 60000);
    if (gap >= 0 && gap < 30) {
      zeroGaps.push({
        day,
        gap,
        a: { id: list[i].id, title: list[i].summary, end: list[i].end.dateTime },
        b: { id: list[i + 1].id, title: list[i + 1].summary, start: list[i + 1].start.dateTime },
      });
    }
  }
}

// 240-min cap (task minutes only — exclude travel/buffer; avoid emoji char-classes)
function isTravelOrBuffer(title) {
  const t = title || '';
  return t.includes('MC 🚗') || t.includes('MC ⏳')
    || t.includes('Travel out') || t.includes('Travel back') || t.includes('Travel —')
    || t.includes('Prep —') || t.includes('Decompress —');
}
const dayCaps = {};
for (const e of timedMc) {
  if (isTravelOrBuffer(e.summary)) continue;
  const d = londonDay(e.start.dateTime);
  dayCaps[d] = (dayCaps[d] || 0) + durationMin(e);
}
const capBreaches = Object.entries(dayCaps)
  .filter(([, m]) => m > 240)
  .map(([day, minutes]) => ({ day, minutes }))
  .sort((a, b) => a.day.localeCompare(b.day));

// Window breaches: MC work blocks starting before window (exclude travel which often starts early)
const windowBreaches = [];
for (const e of timedMc) {
  if (isTravelOrBuffer(e.summary) && !/⏰/.test(e.summary || '')) continue;
  if ((e.summary || '').includes('MC 🚗') || (e.summary || '').includes('Travel ')) continue;
  const d = londonDay(e.start.dateTime);
  const win = winForDay(d);
  const sm = londonMinutes(e.start.dateTime);
  const em = londonMinutes(e.end.dateTime);
  if (sm < win.start) {
    windowBreaches.push({
      day: d,
      id: e.id,
      title: e.summary,
      start: e.start.dateTime,
      startMin: sm,
      window: win.label,
    });
  }
  // end past window + 60 overrun only if no real commitment — flag hard overrun > window+60 always
  if (em > win.end + 60) {
    windowBreaches.push({
      day: d,
      id: e.id,
      title: e.summary,
      end: e.end.dateTime,
      endMin: em,
      window: win.label,
      kind: 'overrun',
    });
  }
}

// MC during all-day busy (residential / Block Out)
const allDayBusy = busy.filter((e) => e.start?.date);
function dayBlocked(day) {
  return allDayBusy.some((e) => {
    const s = e.start.date;
    const en = e.end.date; // exclusive
    return day >= s && day < en;
  });
}
const duringBlocked = timedMc.filter((e) => {
  if ((e.summary || '').includes('MC 🚗') || (e.summary || '').includes('Travel ')) return false;
  return dayBlocked(londonDay(e.start.dateTime));
}).map((e) => ({
  day: londonDay(e.start.dateTime),
  id: e.id,
  title: e.summary,
  start: e.start.dateTime,
}));

// Duplicate Review/Amend same day
const reviewDupes = [];
for (const [day, list] of Object.entries(byDay)) {
  const reviews = list.filter((e) => /Review\/Amend/i.test(e.summary || ''));
  if (reviews.length > 1) {
    reviewDupes.push({ day, count: reviews.length, ids: reviews.map((r) => r.id), titles: reviews.map((r) => r.summary) });
  }
}

// Self-test targets from brief
const targets = {
  'overlap_7_aug_mc2_mc13': overlaps.some((o) => o.day === '2026-08-07' && /MC-2|Money rebuild/i.test(o.a.title + o.b.title) && /MC-13|URL Money/i.test(o.a.title + o.b.title)),
  'overlap_10_aug_mc3_hotel': overlaps.some((o) => o.day === '2026-08-10' && /MC-3|weekend page/i.test(o.a.title + o.b.title) && /Hotel bookings check/i.test(o.a.title + o.b.title)),
  'overlap_14_aug_mc50_review': overlaps.some((o) => o.day === '2026-08-14' && /MC-50|Yorkshire|Anglesey/i.test(o.a.title + o.b.title) && /Review\/Amend/i.test(o.a.title + o.b.title)),
  'overlap_20_aug_mc42_blog': overlaps.some((o) => o.day === '2026-08-20' && /MC-42|Gower/i.test(o.a.title + o.b.title) && /Publish Blog/i.test(o.a.title + o.b.title)),
  'zero_gap_10_aug': zeroGaps.some((z) => z.day === '2026-08-10' && z.gap === 0),
  'zero_gap_14_aug': zeroGaps.some((z) => z.day === '2026-08-14' && z.gap === 0),
  'cap_7_aug': capBreaches.some((c) => c.day === '2026-08-07' && c.minutes >= 300),
  'cap_10_aug': capBreaches.some((c) => c.day === '2026-08-10' && c.minutes >= 300),
  'cap_20_aug': capBreaches.some((c) => c.day === '2026-08-20' && c.minutes >= 250),
  'cap_15_sep': capBreaches.some((c) => c.day === '2026-09-15'),
  'cap_22_sep': capBreaches.some((c) => c.day === '2026-09-22'),
  'window_reminders_09': windowBreaches.filter((w) => /⏰|Room release|deadline/i.test(w.title || '') && w.startMin === 9 * 60).length,
  'dup_review_15_sep': reviewDupes.some((d) => d.day === '2026-09-15'),
  'mc52_during_david_ward': duringBlocked.some((d) => d.day === '2026-08-05' && /MC-52|Hotel register/i.test(d.title)),
};

const out = {
  totals: {
    events: events.length,
    mc_blocks: mc.length,
    tied: tied.length,
    unmatched_color10: unmatchedColor10.length,
    busy_non_mc: busy.length,
  },
  overlaps,
  zeroGaps,
  capBreaches,
  windowBreaches,
  duringBlocked,
  reviewDupes,
  unmatchedColor10: unmatchedColor10.map((e) => ({
    id: e.id, title: e.summary, start: e.start?.dateTime || e.start?.date, calendarId: e.calendarId,
  })),
  selfTest: targets,
  dayCapsSample: Object.fromEntries(
    Object.entries(dayCaps).filter(([d]) => ['2026-08-07', '2026-08-10', '2026-08-20', '2026-09-15', '2026-09-22'].includes(d)),
  ),
};

const outPath = path.join(__dirname, 'adjudicate-result.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  totals: out.totals,
  overlapCount: overlaps.length,
  zeroGapCount: zeroGaps.length,
  capBreachCount: capBreaches.length,
  windowBreachCount: windowBreaches.length,
  duringBlockedCount: duringBlocked.length,
  reviewDupes,
  selfTest: targets,
  dayCapsSample: out.dayCapsSample,
  capBreaches,
  windowReminder09: windowBreaches.filter((w) => w.startMin === 9 * 60).map((w) => ({ day: w.day, title: w.title })),
}, null, 2));
