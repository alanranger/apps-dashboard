/**
 * Apply COMMITTED repair ops to Aug–Oct MC dump, then assert rules.
 * Busy map for residential collision excludes MC blocks.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = String.raw`C:\Users\alan\.cursor\projects\g-Dropbox-alan-ranger-photography-Website-Code-Chat-AI-Bot\agent-tools`;

// Holiday source: bank_holidays table (seeded from GOV.UK england-and-wales),
// materialised locally as bank-holidays.json. Empty over the asserted range is a
// FAULT, not "no holidays" — the exact hole Claude flagged.
const ASSERT_RANGE = { from: '2026-08-01', to: '2026-09-30' };
function loadHolidays() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'bank-holidays.json'), 'utf8'));
  const ew = raw['england-and-wales']?.events || [];
  const set = new Set(ew.map((e) => e.date));
  const inRange = [...set].filter((d) => d >= ASSERT_RANGE.from && d <= ASSERT_RANGE.to);
  if (inRange.length === 0) {
    throw new Error(`HOLIDAY SOURCE FAULT: 0 bank holidays for ${ASSERT_RANGE.from}..${ASSERT_RANGE.to} — dead input, refusing to report PASS.`);
  }
  return set;
}
const HOLIDAYS = loadHolidays();
const FILES = [
  '1d04bd30-a33b-42ff-ad82-d177eab7fbf7.txt',
  'c0eec649-277d-4fa2-b5e5-020fc8cbbed1.txt',
  '312b81fe-21e9-481f-abe1-f74c66f87749.txt',
];

function load() {
  const byId = new Map();
  for (const f of FILES) {
    const data = JSON.parse(fs.readFileSync(path.join(DUMP_DIR, f), 'utf8'));
    for (const e of data.events || []) {
      if (e.status === 'cancelled') continue;
      byId.set(e.id, { ...e });
    }
  }
  return byId;
}

function isTravelOrBuffer(t) {
  return (t || '').includes('MC 🚗') || (t || '').includes('MC ⏳')
    || (t || '').includes('Travel out') || (t || '').includes('Travel back')
    || (t || '').includes('Prep —') || (t || '').includes('Decompress —');
}

function isReminder(t) {
  return (t || '').includes('MC ⏰') || (t || '').includes('⏰');
}

function dayOf(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(iso));
}

function mins(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  return Number(parts.find((p) => p.type === 'hour').value) * 60
    + Number(parts.find((p) => p.type === 'minute').value);
}

function londonOffset(day) {
  // Rough UK DST: last Sunday Mar → last Sunday Oct. 2026: BST until 25 Oct.
  return day < '2026-10-26' ? '+01:00' : '+00:00';
}

function setSlot(e, day, startHm, endHm) {
  if (!e) throw new Error(`missing event for setSlot ${day} ${startHm}`);
  const off = londonOffset(day);
  const [sh, sm] = startHm.split(':').map(Number);
  const [eh, em] = endHm.split(':').map(Number);
  e.start = { dateTime: `${day}T${startHm}:00${off}`, timeZone: 'Europe/London' };
  e.end = { dateTime: `${day}T${endHm}:00${off}`, timeZone: 'Europe/London' };
  e._dur = (eh * 60 + em) - (sh * 60 + sm);
  e.colorId = e.colorId || '10';
}

const byId = load();

// --- COMMITTED OPS ---
const DELETE = new Set([
  'bhcc8qenibs36v2lvlio1ua7fo', // MC-52 done
  '0np73n7k18621lhm2qo093j3nk', // dup Review 15 Sep
  'g89h2cj849r1nas8ibdok3h56c', // 10 Aug hotel Claude — Wed 12 has pair
  'aak7c7a4ll22ku78tg4er4mkl0', // 10 Aug hotel Alan
  'p1abn90ci0jst37geoo530jp3c', // 22 Sep hotel Claude — BAU Day 2 alone
  'q96bs6mj8316c5kplkset61ve4', // 22 Sep hotel Alan
]);

for (const id of DELETE) byId.delete(id);

// 7 Aug: keep Accounts, Booking, MC-14 only (MC-2/13/1 leave)
setSlot(byId.get('1r5lf78cg1qulelc0dd5h767kk'), '2026-08-07', '10:00', '11:30');
setSlot(byId.get('ko8up50cr0u69s27udgau3c4es'), '2026-08-07', '12:00', '13:00');
setSlot(byId.get('691p6nukbf05p9u7fjupapchl4'), '2026-08-07', '13:30', '14:15');

// 11 Aug repack: MC-2,13 + 15..19 = 240
setSlot(byId.get('enh2ofbqif2o4ehovqke8o0kjk'), '2026-08-11', '10:00', '10:45'); // MC-2
setSlot(byId.get('m2mgpecbvtjcpr7doovievthlg'), '2026-08-11', '11:15', '11:45'); // MC-13
setSlot(byId.get('4sq0o5qtgldfq6der6u0bpdo2g'), '2026-08-11', '12:15', '13:00'); // MC-15
setSlot(byId.get('607hc8286v9cu2umhe5jfaitc4'), '2026-08-11', '13:30', '14:00'); // MC-16
setSlot(byId.get('g2cgddgsoimun70k8oa2mfff8s'), '2026-08-11', '14:30', '15:00'); // MC-17
setSlot(byId.get('132no8hi86rupn564ho1l8kiq4'), '2026-08-11', '15:30', '16:00'); // MC-18
setSlot(byId.get('a6fbk73lulilk1hamojbr78s38'), '2026-08-11', '16:30', '17:00'); // MC-19

// 12 Aug: MC-1 then hotels then MC-20
setSlot(byId.get('remc39e9mdat616al5lrmgg51g'), '2026-08-12', '10:00', '11:00'); // MC-1
setSlot(byId.get('7q08te3bvss0dump9i7qjupt6k'), '2026-08-12', '11:30', '12:15');
setSlot(byId.get('ggua02nc0i4d9maogu1kkto41k'), '2026-08-12', '12:45', '13:15');
setSlot(byId.get('he91671tj90c2dml3s46r2j9u4'), '2026-08-12', '13:45', '14:15'); // MC-20

// 13 Aug: Artfully+Blog stay; MC-50/51 + MC-3
setSlot(byId.get('ne08s5tg9bv7jpum571iqog840'), '2026-08-13', '13:05', '14:05'); // MC-50/51
setSlot(byId.get('ls20gle8ucqqgvsstlhjn4hf9s'), '2026-08-13', '14:35', '15:20'); // MC-3

// 14 Aug: Joining keep; Review shift; MC-50 gone
setSlot(byId.get('1rlpfjag61ocf5ctrtm1hroa10'), '2026-08-14', '13:30', '14:30');
setSlot(byId.get('biefgku8s4bpja7phl4mqj16c0'), '2026-08-14', '15:00', '17:00');

// 20 Aug: Blog keep; MC-42 → 21 Aug; hotels keep
setSlot(byId.get('svdhdk3f5eee9t9a4tpqkkrdn8'), '2026-08-20', '10:00', '12:00');
setSlot(byId.get('9f8a7gqhl57qbm39hkgqeprlt4'), '2026-08-21', '14:00', '15:00'); // MC-42 COMMITTED
setSlot(byId.get('jnbpn33p9dav8hv9gfc3ovngm4'), '2026-08-20', '12:30', '13:15');
setSlot(byId.get('clv9ovbrrp3a9grdsq3ko63o88'), '2026-08-20', '13:45', '14:15');

// 21 Aug: Joining+Review+MC-42 = 240; Hartland ⏰ after (excluded from cap)
setSlot(byId.get('pfm7j4en28bvv0vgmcba36as8g'), '2026-08-21', '10:00', '11:00');
setSlot(byId.get('9n20dbkf202roa3ert3s2fsajo'), '2026-08-21', '11:30', '13:30');
// Hartland ⏰ (free_cancel 21 Aug): default sits 21 Aug 15:30 (cap-exempt as ⏰).
// FALLBACK if Alan denies the ⏰ exemption → move to 20 Aug so 21 Aug stays ≤240.
if (process.env.FALLBACK_NO_EXEMPTION === '1') {
  setSlot(byId.get('jnk10hibaa3q05ihrg8k9se0gk'), '2026-08-20', '14:45', '15:05');
} else {
  setSlot(byId.get('jnk10hibaa3q05ihrg8k9se0gk'), '2026-08-21', '15:30', '15:50');
}

// 15 Sep: Review + hotel pair (Eagles £425 decision work) + both ⏰ pings
setSlot(byId.get('lp9ar8hesvf99q7un81poa0q88'), '2026-09-15', '10:00', '12:00');
setSlot(byId.get('2l9gkru81sdrd9dff4rqqj62o0'), '2026-09-15', '12:30', '13:15');
setSlot(byId.get('hve43mrq26rv6grnj6nu5912t4'), '2026-09-15', '13:45', '14:15');
setSlot(byId.get('aqrbdgkvvn3oe6n2snddvnv898'), '2026-09-15', '14:45', '15:00'); // Eagles ping with decision work

// Reminders + escape from Josh Birthday (1 Sep) AND the 31 Aug Summer bank holiday.
// 31 Aug is EXCLUDED (exclude_bank_holidays=true). The five blocks re-placed onto
// schedulable home days, ⏰ reminders anchored to their real free_cancel deadlines.
setSlot(byId.get('gvb8nps0ka9ikkdodrie5ndo4s'), '2026-08-30', '11:00', '14:00'); // SEO — weekend window; clear of Block Out + Sep 9 pile-up
setSlot(byId.get('q2pr801t3i2se9c7mjcg5qe0c8'), '2026-09-03', '14:00', '15:00'); // Booking Sheet month-end → first clear admin day (2 Sep would hit 255m cap)
setSlot(byId.get('ukfmq5ltmhr5f8ena601fo66cs'), '2026-09-14', '13:05', '14:05'); // MC-11 Money review → home day after Yorkshire trip
setSlot(byId.get('ju35jpe0ubc06uc5tij60u48b0'), '2026-09-02', '14:45', '15:00'); // Ellerby ⏰ — cancel 5 Sep, deadline−3 = 2 Sep
// Hotel Rudyard ⏰ — CREATE (not yet on calendar). Deadline 8 Aug; −3 = 5 Aug falls inside
// Rosedale 3–6 Aug → roll BACK to Sun 2 Aug 11:00–11:20. Folded into pending_diary_changes
// related_id hotel:3940d6ce…:2026-08-02. Do NOT write calendar until Alan applies.
setSlot(byId.get('53q73k1i7nh6lcsp3sjniv5dqc'), '2026-09-14', '14:35', '14:55'); // Ravenstone Sep ⏰ — cancel 15 Sep; deadline−3 (12 Sep) falls in Yorkshire trip, rolled to 14 Sep (nearest prior home day)
setSlot(byId.get('12v0odkh7a3obfo1gpkohmamas'), '2026-09-15', '15:30', '15:50'); // Kingston Dorset ⏰ — cancel 18 Sep, deadline−3 = 15 Sep
setSlot(byId.get('g4kk445v4epa7540133tasg6bc'), '2026-09-30', '14:00', '14:15'); // Vyrnwy — hotel-check day, not Oct 1
setSlot(byId.get('kofm1s8bjb5rdpjtgig9ereuok'), '2026-10-26', '14:00', '14:15'); // after Schema 10–12 + Backup 12:30–13:30 + 30m

// 10 Aug Blog+Review only (hotels deleted)
setSlot(byId.get('dkaj83c91t9b5ovhvnoba8h8uk'), '2026-08-10', '10:00', '12:00');
setSlot(byId.get('skthnamhog1ug4s51hhip39it4'), '2026-08-10', '12:30', '14:30');

// 22 Sep BAU Day 2 alone
setSlot(byId.get('8vqiohta3i33gc4nkb3jkd2hlk'), '2026-09-22', '10:00', '14:00');

// --- ASSERT ---
const mc = [...byId.values()].filter((e) => e.colorId === '10' || (e.summary || '').includes('MC '))
  .filter((e) => e.start?.dateTime);

const busyAllDay = [...byId.values()].filter((e) => e.start?.date && e.colorId !== '10' && !(e.summary || '').includes('MC '));

// Home day before an MC travel-out: hotel email "Guest Confirmation" all-days do not block admin
const preTravelHomeDays = new Set();
for (const e of byId.values()) {
  if (!(e.summary || '').includes('MC 🚗 Travel out') || !e.start?.dateTime) continue;
  const d = dayOf(e.start.dateTime);
  const prev = new Date(`${d}T12:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  preTravelHomeDays.add(prev.toISOString().slice(0, 10));
}

function dayBlocked(day) {
  return busyAllDay.some((e) => {
    if (!(day >= e.start.date && day < e.end.date)) return false;
    const title = e.summary || '';
    if (/Guest Confirmation|Reservation Ref/i.test(title) && preTravelHomeDays.has(day)) return false;
    return true;
  });
}

const overlaps = [];
const timed = mc.filter((e) => e.start?.dateTime).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
for (let i = 0; i < timed.length; i++) {
  for (let j = i + 1; j < timed.length; j++) {
    const a = timed[i]; const b = timed[j];
    const aS = Date.parse(a.start.dateTime); const aE = Date.parse(a.end.dateTime);
    const bS = Date.parse(b.start.dateTime); const bE = Date.parse(b.end.dateTime);
    if (bS >= aE) break;
    if (aS < bE && bS < aE) {
      overlaps.push({
        day: dayOf(a.start.dateTime),
        a: a.summary, b: b.summary,
        aSlot: `${a.start.dateTime}–${a.end.dateTime}`,
        bSlot: `${b.start.dateTime}–${b.end.dateTime}`,
        min: Math.round((Math.min(aE, bE) - Math.max(aS, bS)) / 60000),
      });
    }
  }
}

const zeroGaps = [];
const byDay = {};
for (const e of timed) (byDay[dayOf(e.start.dateTime)] ||= []).push(e);
for (const [day, list] of Object.entries(byDay)) {
  list.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  for (let i = 0; i < list.length - 1; i++) {
    const gap = Math.round((Date.parse(list[i + 1].start.dateTime) - Date.parse(list[i].end.dateTime)) / 60000);
    if (gap >= 0 && gap < 30) {
      zeroGaps.push({ day, gap, a: list[i].summary, b: list[i + 1].summary });
    }
  }
}

// Scenario toggle: if Alan rules ⏰ NOT window/cap exempt, count reminders too.
const REMINDERS_IN_CAP = process.env.REMINDERS_IN_CAP === '1';
const caps = {};
for (const e of timed) {
  // Cap = task minutes only. Travel and buffers always excluded; ⏰ excluded
  // unless the exemption is denied (REMINDERS_IN_CAP=1).
  if (isTravelOrBuffer(e.summary)) continue;
  if (isReminder(e.summary) && !REMINDERS_IN_CAP) continue;
  const d = dayOf(e.start.dateTime);
  const minutes = Math.round((Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60000);
  caps[d] = (caps[d] || 0) + minutes;
}
const capBreaches = Object.entries(caps).filter(([, m]) => m > 240).map(([day, minutes]) => ({ day, minutes }));

const windowBreaches = [];
for (const e of timed) {
  // Travel/buffers attach to real sessions (often evenings) — not admin window.
  if ((e.summary || '').includes('MC 🚗') || isTravelOrBuffer(e.summary)) continue;
  const d = dayOf(e.start.dateTime);
  const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
  const winStart = (dow === 0 || dow === 6) ? 11 * 60 : 10 * 60;
  const winEnd = (dow === 0 || dow === 6) ? 16 * 60 : 17 * 60;
  const sm = mins(e.start.dateTime);
  const em = mins(e.end.dateTime);
  // ⏰ not yet window-exempt — must sit inside admin window until Alan rules
  if (sm < winStart) windowBreaches.push({ day: d, title: e.summary, start: e.start.dateTime, kind: 'before_start' });
  if (!isReminder(e.summary) && em > winEnd + 60) {
    windowBreaches.push({ day: d, title: e.summary, kind: 'overrun' });
  }
  if (isReminder(e.summary) && em > winEnd) {
    windowBreaches.push({ day: d, title: e.summary, kind: 'reminder_past_window' });
  }
}

const residentialHits = timed.filter((e) => {
  if ((e.summary || '').includes('MC 🚗')) return false;
  if (isTravelOrBuffer(e.summary)) return false; // buffers on workshop home days OK
  return dayBlocked(dayOf(e.start.dateTime));
}).map((e) => ({ day: dayOf(e.start.dateTime), title: e.summary }));

// Bank-holiday breach: any schedulable MC block landing on an excluded holiday.
// Travel/buffers tied to a real client session on a holiday are allowed (the
// commitment, not MC, put Alan there); tasks and ⏰ reminders are not.
const allHolidayHits = timed.filter((e) => {
  if (!HOLIDAYS.has(dayOf(e.start.dateTime))) return false;
  if ((e.summary || '').includes('MC 🚗') || isTravelOrBuffer(e.summary)) return false;
  return true;
}).map((e) => ({ day: dayOf(e.start.dateTime), title: e.summary }));
const holidayHits = allHolidayHits.filter((h) => h.day >= ASSERT_RANGE.from && h.day <= ASSERT_RANGE.to);
const holidayHitsOutOfScope = allHolidayHits.filter((h) => h.day < ASSERT_RANGE.from || h.day > ASSERT_RANGE.to);

// Focused day totals for report
const focusDays = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-20', '2026-08-21', '2026-08-30', '2026-08-31', '2026-09-02', '2026-09-03', '2026-09-14', '2026-09-15', '2026-09-17', '2026-09-22'];
const dayDetail = {};
for (const d of focusDays) {
  const list = (byDay[d] || []).filter((e) => !isTravelOrBuffer(e.summary));
  dayDetail[d] = {
    taskMinutes: caps[d] || 0,
    blocks: list.map((e) => `${e.summary.slice(0, 50)} ${e.start.dateTime.slice(11, 16)}–${e.end.dateTime.slice(11, 16)}`),
  };
}

const out = {
  holidaySource: { count: HOLIDAYS.size, inRange: [...HOLIDAYS].filter((d) => d >= ASSERT_RANGE.from && d <= ASSERT_RANGE.to) },
  deleted: [...DELETE],
  overlaps,
  zeroGaps,
  capBreaches,
  windowBreaches,
  residentialHits,
  holidayHits,
  holidayHitsOutOfScope,
  dayDetail,
};
out.pass = overlaps.length === 0 && zeroGaps.length === 0 && capBreaches.length === 0
  && windowBreaches.length === 0 && residentialHits.length === 0 && holidayHits.length === 0;

fs.writeFileSync(path.join(__dirname, 'assert-post-fix-result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  pass: out.pass,
  holidaySourceInRange: out.holidaySource.inRange,
  overlaps: out.overlaps.length,
  zeroGaps: out.zeroGaps.length,
  capBreaches: out.capBreaches,
  windowBreaches: out.windowBreaches,
  residentialHits: out.residentialHits,
  holidayHits: out.holidayHits,
  holidayHitsOutOfScope: out.holidayHitsOutOfScope,
  dayDetail: out.dayDetail,
}, null, 2));
