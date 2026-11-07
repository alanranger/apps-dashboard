/**
 * MC-49 full calendar re-lay planner (plan only — no calendar writes).
 * Window: habits 13wk from 2026-07-24; travel 26wk; tasks compete for 240 cap.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TZ = 'Europe/London';
const START = '2026-07-24';
const HABIT_END = addDays(START, 13 * 7 - 1); // 2026-10-22
const TRAVEL_END = addDays(START, 26 * 7 - 1); // 2027-01-21
const CAP = 240;
const DECOMP = 30;
const FIXBUF = 60;
const HOME_PC = 'CV4 9HW';

const CAL = {
  primary: 'info@alanranger.com',
  workshops: 'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com',
  lessons: 'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com',
  holidays: 'alanranger.com_75moakqf5i3ap9jirm85uev8h8@group.calendar.google.com',
  ipswich: 'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com',
  journey: 'c_e6e8a50d4f6a9e8c7a5e284ead78fb8621c1d63ea92a97dca94b268baf76921a@group.calendar.google.com',
  fifa: 'thv8nth15qbu530phsap5td5cjfl9536@import.calendar.google.com',
};

const TIME_CRITICAL = new Set([
  'Send Out Joining Details',
  'Review/Amend Course & Workshop Dates + check Hotel Bookings',
  'Booking Sheet, Month End Update',
  'Hotel bookings check (Claude)',
  'Hotel bookings — Alan actions',
]);

const HABITS = [
  { id: 'e1423beb-0c21-42c4-ae8d-77a14f78e7e6', title: 'Booking Sheet, Month End Update', rrule: 'FREQ=MONTHLY;BYMONTHDAY=1', duration: 60, priority: 'p0', source: 'recurring_tasks.scheduled_note' },
  { id: 'c2f135c9-7146-415d-8231-c2460a064e94', title: 'Light & Logic newsletter issue', rrule: 'FREQ=MONTHLY;BYMONTHDAY=15', duration: 240, priority: 'p0', source: 'recurring_tasks.scheduled_note' },
  { id: '02d10c2d-15bf-4684-8b1a-ff65aaa6cd3b', title: 'Monthly Accounts — Bank Genie', rrule: 'FREQ=MONTHLY;BYDAY=1MO', duration: 90, priority: 'p0', source: 'recurring_tasks.scheduled_note' },
  { id: 'dd4c3659-93a2-49ae-affe-152d350a914f', title: 'Send Out Joining Details', rrule: 'FREQ=WEEKLY;BYDAY=FR', duration: 60, priority: 'p0', source: 'recurring_tasks.scheduled_note' },
  { id: 'b002933c-0068-4dca-8661-f4098ccd714d', title: 'BAU global refresh — Day 1: CSVs + preliminary ingest', rrule: 'FREQ=WEEKLY;INTERVAL=8;BYDAY=MO', duration: 240, priority: 'p1', source: 'recurring_tasks.scheduled_note', anchor: '2026-07-27' },
  { id: '65bb5023-40a3-4797-8e9c-e0b85f0581b6', title: 'BAU global refresh — Day 2: schemas + final ingest + verify', rrule: 'FREQ=WEEKLY;INTERVAL=8;BYDAY=TU', duration: 240, priority: 'p1', source: 'recurring_tasks.scheduled_note', anchor: '2026-07-28', depends: 'b002933c-0068-4dca-8661-f4098ccd714d', depType: 'must_complete_first' },
  { id: '4dd47c23-92a2-4d03-8474-4f557775e3a9', title: 'Hotel bookings check (Claude)', rrule: 'FREQ=WEEKLY;BYDAY=WE', duration: 45, priority: 'p1', source: 'recurring_tasks.scheduled_note' },
  { id: 'fc32dffb-6b5d-434b-86b9-d484ce434127', title: 'Hotel bookings — Alan actions', rrule: 'FREQ=WEEKLY;BYDAY=WE', duration: 30, priority: 'p1', source: 'recurring_tasks.scheduled_note', depends: '4dd47c23-92a2-4d03-8474-4f557775e3a9', depType: 'same_day_after' },
  { id: '2d5898bd-fa64-42d7-9649-d16fa771e945', title: 'Publish Blog Post', rrule: 'FREQ=WEEKLY;BYDAY=TH', duration: 120, priority: 'p1', source: 'recurring_tasks.scheduled_note' },
  { id: '0a7aa275-b148-4364-a184-fc14daea8edb', title: 'Review/Amend Course & Workshop Dates + check Hotel Bookings', rrule: 'FREQ=WEEKLY;BYDAY=FR', duration: 120, priority: 'p1', source: 'recurring_tasks.scheduled_note' },
  { id: '6ec9689d-5426-4276-9e17-824cb4ea4fc1', title: 'SEO Performance Review', rrule: 'FREQ=MONTHLY;BYMONTHDAY=4', duration: 180, priority: 'p1', source: 'recurring_tasks.scheduled_note' },
  { id: 'e6d11356-6276-48af-a5d3-58874c31ce5d', title: 'Upload sites — LocalViking, TOGDays, Where Can We Go', rrule: 'FREQ=WEEKLY;INTERVAL=8;BYDAY=WE', duration: 180, priority: 'p1', source: 'recurring_tasks.scheduled_note', anchor: '2026-07-29', depends: '65bb5023-40a3-4797-8e9c-e0b85f0581b6', depType: 'within_hours', withinHours: 24 },
  { id: '75c54300-e8ef-434f-af4a-51bb546b3496', title: 'Check Artfully Walls Sales', rrule: 'FREQ=MONTHLY;BYDAY=2TH', duration: 5, priority: 'p2', source: 'recurring_tasks.scheduled_note' },
  { id: '755f6aa0-3daa-470b-a4d8-c4f301ba1235', title: 'Update Event Schema for Classes & Workshops', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO', duration: 120, priority: 'p2', source: 'recurring_tasks.scheduled_note', monthAnchor: '2026-07' },
  { id: '38fe0fbd-3eb6-41df-9480-a862d5104cef', title: 'Backup Photos to Portable Drive', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO', duration: 60, priority: 'p3', source: 'recurring_tasks.scheduled_note', monthAnchor: '2026-07' },
];

const TASKS = [
  { id: 31, title: 'Review: Recurring tab (Reclaim replacement)', due: '2026-07-23', mins: 240, priority: 'p3' },
  { id: 49, title: 'Full calendar re-lay — all MC events deleted, rebuild from verified plan', due: '2026-07-24', mins: 240, priority: 'p0' },
  { id: 32, title: 'White Horse Farm Inn 3–6 Aug — confirm policy + trip prep', due: '2026-07-24', mins: 30, priority: 'p0' },
  { id: 35, title: 'Verify Exmoor cancellation carried no charge', due: '2026-07-24', mins: 20, priority: 'p2' },
  { id: 12, title: 'Page-3 competitor sign-off', due: '2026-07-25', mins: 45, priority: 'p3' },
  { id: 8, title: 'Rev-weighting brief', due: '2026-07-26', mins: 150, priority: 'p1' },
  { id: 9, title: 'AI-citation scoping', due: '2026-07-27', mins: 90, priority: 'p2' },
  { id: 25, title: 'Scoping session', due: '2026-07-28', mins: 45, priority: 'p2' },
  { id: 2, title: 'Walkthrough: Money rebuild', due: '2026-07-30', mins: 45, priority: 'p3' },
  { id: 3, title: 'Walkthrough: weekend page fixes', due: '2026-07-31', mins: 45, priority: 'p3' },
  { id: 27, title: 'Applied Learning next article', due: '2026-08-01', mins: 150, priority: 'p1' },
  { id: 13, title: 'Sign-off: URL Money Pages', due: '2026-08-01', mins: 30, priority: 'p3' },
  { id: 14, title: 'Sign-off: Traditional SEO', due: '2026-08-01', mins: 45, priority: 'p3' },
  { id: 16, title: 'Sign-off: Portfolio', due: '2026-08-05', mins: 30, priority: 'p3' },
  { id: 15, title: 'Sign-off: Backlinks', due: '2026-08-05', mins: 45, priority: 'p3' },
  { id: 17, title: 'Sign-off: Authority', due: '2026-08-08', mins: 30, priority: 'p3' },
  { id: 18, title: 'Sign-off: Local & Reviews', due: '2026-08-08', mins: 30, priority: 'p3' },
  { id: 19, title: 'Sign-off: Revenue Truth re-review', due: '2026-08-10', mins: 30, priority: 'p3' },
  { id: 20, title: 'Sign-off: History', due: '2026-08-12', mins: 30, priority: 'p3' },
  { id: 28, title: 'JLR comeback next step', due: '2026-08-15', mins: 60, priority: 'p1' },
  { id: 11, title: 'Money review', due: '2026-09-01', mins: 60, priority: 'p2' },
];

const DRIVES = {
  'Burnham-on-Sea': 135, 'Batsford Arboretum': 60, 'Padley Gorge': 120, 'Piles Coppice': 30,
  'Hartland Quay': 240, 'Gower': 195, 'Capel Curig': 180, 'Bassenthwaite': 225,
  'Rosedale Abbey': 210, 'Saltburn': 210, 'Wareham': 195, 'Lake Vyrnwy': 135,
  'The Roaches': 120, 'Kenilworth': 15, 'Chesterton': 45, 'Priory': 15,
  'Warwick University': 15, 'Hathersage': 120, 'Surprise View': 120,
};

const BANK = new Set(['2026-08-31', '2026-12-25', '2026-12-28', '2027-01-01']); // UK BH in window

function addDays(iso, n) {
  const d = parseYMD(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtYMD(d);
}
function parseYMD(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmtYMD(d) {
  return d.toISOString().slice(0, 10);
}
function dow(iso) { return parseYMD(iso).getUTCDay(); } // 0 Sun
function isWeekend(iso) { const w = dow(iso); return w === 0 || w === 6; }
function workWindow(iso) {
  return isWeekend(iso) ? { start: 11 * 60, end: 16 * 60 } : { start: 10 * 60, end: 17 * 60 };
}
function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function fromMin(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
function dayRange(iso) {
  // Local Europe/London as naive minutes; feed already London offset.
  return { date: iso };
}
function prioRank(p) {
  return Number(String(p || 'p5').replace('p', '')) || 5;
}

// --- load events ---
const a = JSON.parse(fs.readFileSync(path.join(__dirname, 'cal-jul-oct.json'), 'utf8'));
const b = JSON.parse(fs.readFileSync(path.join(__dirname, 'cal-oct-jan.json'), 'utf8'));
const raw = [...a.events, ...b.events];
const counts = {};
for (const e of raw) counts[e.calendarId] = (counts[e.calendarId] || 0) + 1;

// busy structures
const fullDay = new Set(); // YYYY-MM-DD
const timed = []; // {date, start, end, label, cal, kind}
const rolls = [];
const unplaceable = [];
const placed = [];
const travelRows = [];
const dayUsed = {}; // date -> minutes of MC task time
const daySlots = {}; // date -> [{start,end}]

function markFull(iso, reason) {
  fullDay.add(iso);
}

function addTimed(date, start, end, label, cal, kind) {
  if (end <= start) return;
  timed.push({ date, start, end, label, cal, kind });
}

function expandDateSpan(startIso, endIsoExclusive) {
  // Google all-day end is exclusive; timed multi-day end may be exclusive day of end datetime
  let cur = startIso;
  const out = [];
  while (cur < endIsoExclusive) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function locIsHome(loc = '', summary = '') {
  const s = `${loc} ${summary}`.toLowerCase();
  if (/hathaway|cv4 9hw|home/.test(s)) return true;
  if (/kenilworth|chesterton|priory|warwick university|crackley|hay woods|lapworth|leamington|solihull|piles/.test(s)) return true;
  if (/burnham|padley|batsford|hartland|gower|capel|bassenthwaite|saltburn|wareham|vyrnwy|roaches|hathersage|peak district|lake district|snowdonia|dorset|yorkshire|norfolk|exmoor|rosedale|ellerby|york yo/.test(s)) return false;
  return /cv4|cv8|cv1|cv33|coventry|warwickshire/.test(s);
}

function driveMins(summary = '', loc = '') {
  const s = `${summary} ${loc}`;
  for (const [k, v] of Object.entries(DRIVES)) {
    if (s.includes(k.split(' ')[0]) || s.toLowerCase().includes(k.toLowerCase().split(' ')[0].toLowerCase())) {
      // more precise
    }
  }
  if (/piles|woodland photography walk.*coventry/i.test(s)) return 30;
  if (/padley/i.test(s)) return 120;
  if (/batsford/i.test(s)) return 60;
  if (/burnham/i.test(s)) return 135;
  if (/hartland/i.test(s)) return 240;
  if (/gower/i.test(s)) return 195;
  if (/capel|snowdonia|fairy glen|betws/i.test(s)) return 180;
  if (/bassenthwaite|lake district|ravenstone|cumbria/i.test(s)) return 225;
  if (/saltburn|yorkshire|ellerby|forge/i.test(s)) return 210;
  if (/wareham|dorset|jurassic/i.test(s)) return 195;
  if (/vyrnwy|pistyll|rhaeadr/i.test(s)) return 135;
  if (/roaches|heathers sunrise|leek/i.test(s)) return 120;
  if (/hathersage|heathers sunset/i.test(s)) return 120;
  if (/kenilworth|chesterton|priory|hathaway|crackley|hay woods|christmas photography|woodland.*masterclass|abstract and macro/i.test(s)) return 15;
  if (/norfolk|blakeney|cromer/i.test(s)) return 180; // estimate — not in verified table; flag
  return null;
}

// Build busy from feed
const fixtureCal = new Set([CAL.ipswich, CAL.fifa]);
const wsCal = CAL.workshops;
const lessonCal = CAL.lessons;

for (const e of raw) {
  const cal = e.calendarId;
  const sum = e.summary || '';
  const loc = e.location || '';
  const isAllDay = !!e.start.date;
  const startIso = (e.start.date || e.start.dateTime).slice(0, 10);
  const endRaw = e.end.date || e.end.dateTime;
  const endIso = endRaw.slice(0, 10);
  const isFixture = fixtureCal.has(cal) || /⚽️|ipswich|world cup|england/i.test(sum);

  if (cal === CAL.holidays || BANK.has(startIso)) {
    if (isAllDay) markFull(startIso, 'bank/holiday');
  }

  // Cleaner already on calendar — mark timed busy (and treat morning as blocked for working-hours start)
  if (/^cleaner$/i.test(sum)) {
    const s = toMin((e.start.dateTime || '09:00').slice(11, 16));
    const en = toMin((e.end.dateTime || '13:00').slice(11, 16));
    addTimed(startIso, s, en, 'Cleaner', cal, 'cleaner');
    continue;
  }

  if (isFixture) {
    // timed with ±60; ignore transparency
    if (!isAllDay) {
      const s = toMin(e.start.dateTime.slice(11, 16));
      const en = toMin(e.end.dateTime.slice(11, 16));
      addTimed(startIso, Math.max(0, s - FIXBUF), Math.min(24 * 60, en + FIXBUF), sum, cal, 'fixture');
    }
    continue;
  }

  // Multi-day workshop / residential: full span
  if (!isAllDay && startIso !== endIso && (cal === wsCal || cal === CAL.primary)) {
    // end datetime day is inclusive if time > midnight start of that day
    const endExclusive = endRaw.includes('T') && endRaw.slice(11, 16) === '00:00' ? endIso : addDays(endIso, 1);
    // For timed end same calendar day as last active day: include endIso
    const last = endIso;
    for (const d of expandDateSpan(startIso, addDays(last, 1))) markFull(d, sum);
    continue;
  }

  if (isAllDay) {
    // Only real away/admin blocks — not birthdays / social all-days
    const days = expandDateSpan(startIso, endIso); // end exclusive for Google all-day
    const block = /block out|stay at|masterclass|post processing|ruby moving/i.test(sum);
    if (block) for (const d of days) markFull(d, sum);
    continue;
  }

  // Same-day workshop: away → full day; home → timed only
  if (cal === wsCal) {
    const home = locIsHome(loc, sum);
    if (!home) {
      markFull(startIso, sum);
    } else {
      const s = toMin(e.start.dateTime.slice(11, 16));
      const en = toMin(e.end.dateTime.slice(11, 16));
      addTimed(startIso, s, en, sum, cal, 'workshop-home');
    }
    continue;
  }

  if (cal === lessonCal || cal === CAL.primary) {
    const s = toMin(e.start.dateTime.slice(11, 16));
    const en = toMin(e.end.dateTime.slice(11, 16));
    addTimed(startIso, s, en, sum, cal, cal === lessonCal ? 'lesson' : 'primary');
  }
}

// Synthetic cleaner fortnightly Fri 09-13 if missing (through travel end)
{
  let c = '2026-07-31';
  while (c <= TRAVEL_END) {
    const has = timed.some((t) => t.date === c && t.kind === 'cleaner');
    if (!has) addTimed(c, 9 * 60, 13 * 60, 'Cleaner (recurring_personal_blocks)', CAL.primary, 'cleaner');
    c = addDays(c, 14);
  }
}

function dayBusyIntervals(date) {
  if (fullDay.has(date)) return [{ start: 0, end: 24 * 60, label: 'FULL' }];
  return timed.filter((t) => t.date === date).map((t) => ({ start: t.start, end: t.end, label: t.label }));
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function canPlace(date, start, duration) {
  const win = workWindow(date);
  const end = start + duration;
  if (start < win.start || end > win.end) return false;
  if (BANK.has(date)) return false;
  if (fullDay.has(date)) return false;
  const used = dayUsed[date] || 0;
  if (used + duration > CAP) return false;
  const blockEnd = end + DECOMP; // decompress needs clear calendar (not counting toward cap)
  const busy = dayBusyIntervals(date);
  const slots = daySlots[date] || [];
  for (const b of busy) {
    if (overlaps(start, Math.min(blockEnd, win.end + DECOMP), b.start, b.end)) {
      // decompress may extend past work window into evening — only require task itself clear of busy
    }
    if (overlaps(start, end, b.start, b.end)) return false;
  }
  for (const s of slots) {
    // include decompress gap between MC blocks
    if (overlaps(start, end + DECOMP, s.start, s.end + DECOMP)) return false;
  }
  return true;
}

function commit(date, start, duration, row) {
  dayUsed[date] = (dayUsed[date] || 0) + duration;
  daySlots[date] = daySlots[date] || [];
  daySlots[date].push({ start, end: start + duration });
  placed.push(row);
}

function findSlotOnDay(date, duration, preferStart) {
  const win = workWindow(date);
  let t = Math.max(win.start, preferStart ?? win.start);
  // snap to 15
  t = Math.ceil(t / 15) * 15;
  while (t + duration <= win.end) {
    if (canPlace(date, t, duration)) return t;
    t += 15;
  }
  return null;
}

function searchPlace(idealDate, duration, { backward = false, maxRolls = 3, preferStart = null, windowDays = 2 } = {}) {
  // try ideal day first within windowDays forward soft, then directional rolls
  const tryDates = [];
  tryDates.push(idealDate);
  for (let i = 1; i <= windowDays; i++) tryDates.push(addDays(idealDate, i));

  for (const d of tryDates) {
    if (d < START || d > HABIT_END) continue;
    const s = findSlotOnDay(d, duration, preferStart);
    if (s != null) return { date: d, start: s, roll: d === idealDate ? null : { dir: 'FORWARD', from: idealDate, reason: `window_days to ${d}` } };
  }

  if (backward) {
    for (let i = 1; i <= maxRolls + 10; i++) {
      const d = addDays(idealDate, -i);
      if (d < START) break;
      const s = findSlotOnDay(d, duration, preferStart);
      if (s != null) return { date: d, start: s, roll: { dir: 'BACK', from: idealDate, reason: `time_critical blocked on/near ${idealDate}` } };
    }
  }
  // always allow forward beyond window for non-critical / if back failed
  for (let i = 1; i <= maxRolls + 21; i++) {
    const d = addDays(idealDate, i);
    if (d > HABIT_END) break;
    const s = findSlotOnDay(d, duration, preferStart);
    if (s != null) return { date: d, start: s, roll: { dir: 'FORWARD', from: idealDate, reason: `forward after block/cap near ${idealDate}` } };
  }
  return null;
}

// RRULE occurrence generators (simple)
function eachDate(start, end, pred) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (pred(d)) out.push(d);
  return out;
}
function nthWeekdayOfMonth(ym, weekday, n) {
  // ym YYYY-MM, weekday 0Sun, n=1..4 or -1
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`;
  const days = [];
  for (let d = first; d.slice(0, 7) === ym; d = addDays(d, 1)) {
    if (dow(d) === weekday) days.push(d);
  }
  if (n === -1) return days[days.length - 1];
  return days[n - 1];
}
function monthsBetween(start, end) {
  const out = [];
  let y = +start.slice(0, 4);
  let m = +start.slice(5, 7);
  const ey = +end.slice(0, 4);
  const em = +end.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function habitOccurrences(h) {
  const out = [];
  if (h.rrule.includes('FREQ=WEEKLY') && h.rrule.includes('INTERVAL=8')) {
    const by = h.rrule.includes('BYDAY=MO') ? 1 : h.rrule.includes('BYDAY=TU') ? 2 : h.rrule.includes('BYDAY=WE') ? 3 : 5;
    let d = h.anchor;
    while (d <= HABIT_END) {
      if (d >= START && dow(d) === by) out.push(d);
      d = addDays(d, 56);
    }
    return out;
  }
  if (h.rrule === 'FREQ=WEEKLY;BYDAY=FR') return eachDate(START, HABIT_END, (d) => dow(d) === 5);
  if (h.rrule === 'FREQ=WEEKLY;BYDAY=WE') return eachDate(START, HABIT_END, (d) => dow(d) === 3);
  if (h.rrule === 'FREQ=WEEKLY;BYDAY=TH') return eachDate(START, HABIT_END, (d) => dow(d) === 4);
  if (h.rrule === 'FREQ=MONTHLY;BYMONTHDAY=1') {
    for (const ym of monthsBetween(START, HABIT_END)) {
      const d = `${ym}-01`;
      if (d >= START && d <= HABIT_END) out.push(d);
    }
    return out;
  }
  if (h.rrule === 'FREQ=MONTHLY;BYMONTHDAY=15') {
    for (const ym of monthsBetween(START, HABIT_END)) {
      const d = `${ym}-15`;
      if (d >= START && d <= HABIT_END) out.push(d);
    }
    return out;
  }
  if (h.rrule === 'FREQ=MONTHLY;BYMONTHDAY=4') {
    for (const ym of monthsBetween(START, HABIT_END)) {
      const d = `${ym}-04`;
      if (d >= START && d <= HABIT_END) out.push(d);
    }
    return out;
  }
  if (h.rrule === 'FREQ=MONTHLY;BYDAY=1MO') {
    for (const ym of monthsBetween(START, HABIT_END)) {
      const d = nthWeekdayOfMonth(ym, 1, 1);
      if (d && d >= START && d <= HABIT_END) out.push(d);
    }
    return out;
  }
  if (h.rrule === 'FREQ=MONTHLY;BYDAY=2TH') {
    for (const ym of monthsBetween(START, HABIT_END)) {
      const d = nthWeekdayOfMonth(ym, 4, 2);
      if (d && d >= START && d <= HABIT_END) out.push(d);
    }
    return out;
  }
  if (h.rrule.includes('INTERVAL=2') && h.rrule.includes('BYDAY=4MO')) {
    let i = 0;
    for (const ym of monthsBetween(h.monthAnchor || START, HABIT_END)) {
      if (i % 2 === 0) {
        const d = nthWeekdayOfMonth(ym, 1, 4);
        if (d && d >= START && d <= HABIT_END) out.push(d);
      }
      i++;
    }
    return out;
  }
  return out;
}

// Place habits by priority then ideal date; keep same_day_after / deps
const habitById = Object.fromEntries(HABITS.map((h) => [h.id, h]));
const occByHabit = {};
for (const h of HABITS) occByHabit[h.id] = habitOccurrences(h);

// Expand to jobs — parents before dependents
const habitJobs = [];
for (const h of HABITS) {
  for (const ideal of occByHabit[h.id]) {
    habitJobs.push({ kind: 'habit', ...h, ideal });
  }
}
function chainRank(j) {
  // BAU Day1 → Day2 → Upload first; hotel check before Alan same_day_after
  if (j.title.startsWith('BAU global refresh — Day 1')) return 0;
  if (j.depType === 'must_complete_first') return 1;
  if (j.depType === 'within_hours') return 2;
  if (j.title.startsWith('Hotel bookings check')) return 3;
  if (j.depType === 'same_day_after') return 4;
  return 5;
}
habitJobs.sort(
  (a, b) =>
    prioRank(a.priority) - prioRank(b.priority) ||
    chainRank(a) - chainRank(b) ||
    a.ideal.localeCompare(b.ideal) ||
    a.title.localeCompare(b.title)
);

// Place due tasks FIRST so they occupy the busy map (root cause of 1 Sep over-cap).
const taskRows = [];
const taskUn = [];
{
  const sortedTasks = [...TASKS].sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || a.due.localeCompare(b.due));
  for (const t of sortedTasks) {
    const startFrom = t.due < START ? START : t.due;
    let hit = null;
    for (let i = 0; i < 60; i++) {
      const d = addDays(startFrom, i);
      if (d > TRAVEL_END) break;
      if (d > addDays(HABIT_END, 30)) break;
      const s = findSlotOnDay(d, t.mins, 10 * 60);
      if (s != null) {
        hit = { date: d, start: s };
        break;
      }
    }
    if (!hit) {
      taskUn.push({ ...t, reason: 'no capacity in forward search' });
      continue;
    }
    const end = hit.start + t.mins;
    const row = {
      section: 'task',
      date: hit.date,
      start: fromMin(hit.start),
      end: fromMin(end),
      title: `MC ✅ MC-${t.id} ${t.title}`,
      calendar: CAL.primary,
      priority: t.priority,
      source: 'tasks.detail_md',
      rule: hit.date === t.due
        ? `due_date ${t.due}; daily_task_cap_min; working_hours`
        : `FORWARD from due ${t.due} (busy/cap); daily_task_cap_min`,
      due: t.due,
    };
    if (hit.date !== t.due) rolls.push({ title: `MC-${t.id} ${t.title}`, dir: 'FORWARD', from: t.due, reason: row.rule });
    commit(hit.date, hit.start, t.mins, row);
    taskRows.push(row);
  }
}

const placedHabitKeys = {}; // id|ideal -> placement

// Habits after tasks; depRank puts hotel check before same_day_after Alan actions
for (const job of habitJobs) {
  if (job.depType === 'same_day_after') {
    // place after parent same ideal week occurrence
    const parentPlaced = Object.values(placedHabitKeys).filter((p) => p.id === job.depends && p.ideal === job.ideal);
    // match by nearest parent on same ideal Wednesday
    const parents = Object.values(placedHabitKeys).filter((p) => p.id === job.depends);
    const parent =
      parents.find((p) => p.ideal === job.ideal) ||
      parents.find((p) => p.date === job.ideal) ||
      parents.find((p) => Math.abs((parseYMD(p.date) - parseYMD(job.ideal)) / 86400000) <= 4);
    if (!parent) {
      unplaceable.push({
        ...job,
        reason: `parent hotel check not placed (have ${parents.length}: ${parents.map((p) => p.ideal + '→' + p.date).join(',')})`,
      });
      continue;
    }
    const prefer = parent.start + parent.duration + DECOMP;
    const slot = findSlotOnDay(parent.date, job.duration, prefer);
    if (slot == null) {
      // try roll with parent day constraint relaxed — search same rules
      const hit = searchPlace(parent.date, job.duration, { backward: TIME_CRITICAL.has(job.title), preferStart: prefer });
      if (!hit) {
        unplaceable.push({ ...job, reason: 'no slot after hotel check' });
        continue;
      }
      const row = makeHabitRow(job, hit);
      commit(hit.date, hit.start, job.duration, row);
      placedHabitKeys[`${job.id}|${job.ideal}`] = { ...job, ...hit, duration: job.duration };
      if (hit.roll) rolls.push({ title: job.title, ...hit.roll });
      continue;
    }
    const hit = { date: parent.date, start: slot, roll: null };
    const row = makeHabitRow(job, hit);
    commit(hit.date, hit.start, job.duration, row);
    placedHabitKeys[`${job.id}|${job.ideal}`] = { ...job, ...hit, duration: job.duration };
    continue;
  }

  if (job.depType === 'must_complete_first') {
    const parents = Object.values(placedHabitKeys).filter((p) => p.id === job.depends);
    const parent =
      parents.find((p) => p.ideal === addDays(job.ideal, -1)) ||
      parents.find((p) => Math.abs((parseYMD(p.ideal) - parseYMD(job.ideal)) / 86400000) <= 2) ||
      parents.sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!parent) {
      unplaceable.push({ ...job, reason: 'BAU Day 1 not placed' });
      continue;
    }
    const ideal = addDays(parent.date, 1);
    const hit = searchPlace(ideal, job.duration, { backward: false, preferStart: 10 * 60 });
    if (!hit) {
      unplaceable.push({ ...job, reason: 'no day after BAU Day 1' });
      continue;
    }
    if (hit.date !== ideal) rolls.push({ title: job.title, dir: hit.roll?.dir || 'FORWARD', from: ideal, reason: hit.roll?.reason || 'track Day 1' });
    const row = makeHabitRow(job, hit);
    commit(hit.date, hit.start, job.duration, row);
    placedHabitKeys[`${job.id}|${job.ideal}`] = { ...job, ...hit, duration: job.duration };
    continue;
  }

  if (job.depType === 'within_hours') {
    const parents = Object.values(placedHabitKeys).filter((p) => p.id === job.depends);
    const parent =
      parents.find((p) => p.ideal === addDays(job.ideal, -1)) ||
      parents.find((p) => Math.abs((parseYMD(p.ideal) - parseYMD(job.ideal)) / 86400000) <= 2) ||
      parents.sort((a, b) => a.date.localeCompare(b.date)).find((p) => p.date <= job.ideal) ||
      parents.sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!parent) {
      unplaceable.push({ ...job, reason: 'BAU Day 2 not placed' });
      continue;
    }
    // same day after or next day within 24h
    let hit = null;
    const prefer = parent.start + parent.duration + DECOMP;
    const same = findSlotOnDay(parent.date, job.duration, prefer);
    if (same != null) hit = { date: parent.date, start: same, roll: { dir: 'FORWARD', from: job.ideal, reason: 'within_hours of BAU Day 2' } };
    else {
      const next = addDays(parent.date, 1);
      const s = findSlotOnDay(next, job.duration, 10 * 60);
      if (s != null) hit = { date: next, start: s, roll: { dir: 'FORWARD', from: job.ideal, reason: 'within_hours (next day after Day 2)' } };
    }
    if (!hit) {
      unplaceable.push({ ...job, reason: 'cannot place within 24h of BAU Day 2' });
      continue;
    }
    rolls.push({ title: job.title, ...hit.roll });
    const row = makeHabitRow(job, hit);
    commit(hit.date, hit.start, job.duration, row);
    placedHabitKeys[`${job.id}|${job.ideal}`] = { ...job, ...hit, duration: job.duration };
    continue;
  }

  const backward = TIME_CRITICAL.has(job.title);
  const hit = searchPlace(job.ideal, job.duration, { backward, preferStart: 10 * 60 });
  if (!hit) {
    unplaceable.push({ ...job, reason: 'no slot within roll limits / horizon' });
    continue;
  }
  if (hit.roll) rolls.push({ title: job.title, ideal: job.ideal, ...hit.roll });
  const row = makeHabitRow(job, hit);
  commit(hit.date, hit.start, job.duration, row);
  placedHabitKeys[`${job.id}|${job.ideal}`] = { ...job, ...hit, duration: job.duration };
}

function makeHabitRow(job, hit) {
  const end = hit.start + job.duration;
  const rule = hit.roll
    ? `missed_habit_direction=${hit.roll.dir === 'BACK' ? 'backward_if_time_critical' : 'forward'}; ${hit.roll.reason}`
    : `rrule ideal ${job.ideal}; working_hours; daily_task_cap_min; decompress_after_task_min`;
  return {
    section: 'habit',
    date: hit.date,
    start: fromMin(hit.start),
    end: fromMin(end),
    title: `MC 🔁 ${shortTitle(job.title)}`,
    calendar: CAL.primary,
    priority: job.priority,
    source: job.source,
    rule,
    ideal: job.ideal,
  };
}

function shortTitle(t) {
  return t
    .replace('BAU global refresh — Day 1: CSVs + preliminary ingest', 'BAU global refresh — Day 1')
    .replace('BAU global refresh — Day 2: schemas + final ingest + verify', 'BAU global refresh — Day 2')
    .replace('Review/Amend Course & Workshop Dates + check Hotel Bookings', 'Review/Amend Course & Workshop Dates')
    .replace('Upload sites — LocalViking, TOGDays, Where Can We Go', 'Upload sites — LV/TOGDays/WhereCanWeGo');
}

// Travel / buffers / hotel reminders for TRAVEL_END
const verifiedNote = [];
for (const e of raw) {
  if (e.calendarId !== wsCal && e.calendarId !== lessonCal && !(e.calendarId === CAL.primary && /class|masterclass/i.test(e.summary || ''))) continue;
  const sum = e.summary || '';
  const loc = e.location || '';
  if (/zoom|online 1-2-1|1-2-1 tuition/i.test(sum)) continue;
  if (e.start.date) continue; // all-day handled as stays
  const startIso = e.start.dateTime.slice(0, 10);
  if (startIso < START || startIso > TRAVEL_END) continue;
  const endIso = e.end.dateTime.slice(0, 10);
  const sMin = toMin(e.start.dateTime.slice(11, 16));
  const eMin = toMin(e.end.dateTime.slice(11, 16));
  const home = locIsHome(loc, sum);
  const multi = startIso !== endIso;

  if (e.calendarId === lessonCal || (home && !multi)) {
    // prep/decompress around evening classes & home workshops
    const prepStart = sMin - 30;
    const decStart = eMin;
    if (prepStart >= 0) {
      travelRows.push(rowTravel(startIso, prepStart, prepStart + 30, `MC ⏳ Prep — ${clip(sum)}`, 'prep_buffer_min=30; home_only buffer_scope'));
    }
    travelRows.push(rowTravel(startIso, decStart, decStart + 30, `MC ⏳ Decompress — ${clip(sum)}`, 'decompress_buffer_min=30; home_only'));
  } else if (!home || multi) {
    // travel out/back each away day in span
    const days = multi ? expandDateSpan(startIso, addDays(endIso, 1)) : [startIso];
    let mins = driveMins(sum, loc);
    if (mins == null) {
      mins = 180;
      verifiedNote.push(`UNVERIFIED drive estimate ${mins}m for: ${sum}`);
    }
    for (const d of days) {
      // skip pure travel-end days with no workshop? still block
      const dayStart = d === startIso ? sMin : 9 * 60;
      const dayEnd = d === endIso ? eMin : 16 * 60;
      travelRows.push(rowTravel(d, dayStart - mins, dayStart, `MC 🚗 Travel out — ${clip(sum)}`, `venue_drive_times ${mins}m; arrive_before_start_min absorbed in drive`));
      travelRows.push(rowTravel(d, dayEnd, dayEnd + mins, `MC 🚗 Travel back — ${clip(sum)}`, `venue_drive_times ${mins}m; depart_at_stated_end`));
    }
  }
}

function clip(s) {
  return s.replace(/\s+/g, ' ').slice(0, 72);
}
function rowTravel(date, start, end, title, rule) {
  return {
    section: 'travel',
    date,
    start: fromMin(Math.max(0, start)),
    end: fromMin(Math.max(0, end)),
    title,
    calendar: CAL.primary,
    priority: 'p1',
    source: 'calendar event + venue_drive_times / buffer rules',
    rule,
  };
}

// Hotel deadline reminders: 3 days before Stay at
for (const e of raw) {
  if (e.calendarId !== CAL.primary) continue;
  if (!/^Stay at /i.test(e.summary || '')) continue;
  const stay = (e.start.date || e.start.dateTime).slice(0, 10);
  const rem = addDays(stay, -3);
  if (rem < START || rem > TRAVEL_END) continue;
  travelRows.push({
    section: 'travel',
    date: rem,
    start: '10:00',
    end: '10:15',
    title: `MC ⏰ Hotel deadline — ${e.summary}`,
    calendar: CAL.primary,
    priority: 'p0',
    source: 'primary Stay at* event; hotel_deadline_reminder_days=3',
    rule: 'hotel_deadline_reminder_days=3',
  });
}

travelRows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
const habitRows = placed.filter((p) => p.section === 'habit').sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
taskRows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));

const report = {
  meta: {
    start: START,
    habitEnd: HABIT_END,
    travelEnd: TRAVEL_END,
    nothingWritten: true,
    eventCounts: counts,
    fullDayCount: fullDay.size,
    fullDays: [...fullDay].sort(),
    timedCount: timed.length,
    habitsPlaced: habitRows.length,
    habitsUnplaceable: unplaceable.length,
    tasksPlaced: taskRows.length,
    tasksUnplaceable: taskUn.length,
    travelRows: travelRows.length,
    rolls: rolls.length,
    verifiedNote,
    missingCalendars: {
      ukHolidays: counts[CAL.holidays] || 0,
      journey: counts[CAL.journey] || 0,
      fifa: counts[CAL.fifa] || 0,
      englandFixtures: 'not in account calendar list',
    },
  },
  habitRows,
  taskRows,
  travelRows,
  rolls,
  unplaceable,
  taskUn,
  dayUsed,
};

fs.writeFileSync(path.join(__dirname, 'mc49-plan.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.meta, null, 2));
console.log('unplaceable habits', unplaceable.length, unplaceable.slice(0, 5));
console.log('unplaceable tasks', taskUn);
console.log('rolls', rolls.length);
