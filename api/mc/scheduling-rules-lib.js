/** Shared scheduling rules + UK bank holidays + window/cap helpers (no Calendar access). */

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function easterSunday(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(ymdStr, n) {
  const d = new Date(`${ymdStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ukBankHolidays(year) {
  const out = new Set();
  const fixed = [
    `${year}-01-01`, `${year}-12-25`, `${year}-12-26`,
  ];
  fixed.forEach((d) => out.add(d));
  const easter = easterSunday(year);
  const gf = new Date(easter);
  gf.setUTCDate(gf.getUTCDate() - 2);
  const em = new Date(easter);
  em.setUTCDate(em.getUTCDate() + 1);
  out.add(ymd(gf));
  out.add(ymd(em));
  const may1 = new Date(Date.UTC(year, 4, 1));
  while (may1.getUTCDay() !== 1) may1.setUTCDate(may1.getUTCDate() + 1);
  out.add(ymd(may1));
  const mayLast = new Date(Date.UTC(year, 4, 31));
  while (mayLast.getUTCDay() !== 1) mayLast.setUTCDate(mayLast.getUTCDate() - 1);
  out.add(ymd(mayLast));
  const augLast = new Date(Date.UTC(year, 7, 31));
  while (augLast.getUTCDay() !== 1) augLast.setUTCDate(augLast.getUTCDate() - 1);
  out.add(ymd(augLast));
  return out;
}

function bankHolidaySet(fromY, toY) {
  const s = new Set();
  for (let y = fromY; y <= toY; y += 1) ukBankHolidays(y).forEach((d) => s.add(d));
  return s;
}

// Canonical holiday set from the bank_holidays table (GOV.UK-seeded). Preferred
// over the computed last-Monday set because it also carries substitute days.
// An EMPTY result over a range where rows are expected is a FAULT — the caller
// must surface it (never treat empty as "no holidays this period").
function holidaySetFromRows(rows) {
  return new Set((rows || []).map((r) => String(r.holiday_date).slice(0, 10)));
}

function ruleMapFromRows(rows) {
  return Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
}

function workingDaysSet(ruleMap) {
  const raw = String(ruleMap.working_days || 'mon,tue,wed,thu,fri').split(',');
  return new Set(raw.map((d) => d.trim().toLowerCase()).filter(Boolean));
}

function dayName(ymdStr) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${ymdStr}T12:00:00Z`).getUTCDay()];
}

function workingWindow(ruleMap, ymdStr) {
  const dn = dayName(ymdStr);
  const isWeekend = dn === 'sat' || dn === 'sun';
  const start = isWeekend
    ? ruleMap.working_hours_weekend_start || '11:00'
    : ruleMap.working_hours_weekday_start || '10:00';
  const end = isWeekend
    ? ruleMap.working_hours_weekend_end || '16:00'
    : ruleMap.working_hours_weekday_end || '17:00';
  return { start, end, start_min: parseHm(start), end_min: parseHm(end) };
}

function isSchedulableDay(ymdStr, ruleMap, holidays) {
  const wd = workingDaysSet(ruleMap);
  if (!wd.has(dayName(ymdStr))) return false;
  if (ruleMap.exclude_bank_holidays === 'true' && holidays.has(ymdStr)) return false;
  return true;
}

function isoToLondonDate(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

function isoToLondonMinutes(iso) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}

function blockMinutesOnDay(startIso, endIso, ymdStr) {
  const sd = isoToLondonDate(startIso);
  const ed = isoToLondonDate(endIso);
  if (!sd || !ed || ymdStr < sd || ymdStr > ed) return 0;
  const win = workingWindow({}, ymdStr);
  let sm = sd === ymdStr ? isoToLondonMinutes(startIso) : win.start_min;
  let em = ed === ymdStr ? isoToLondonMinutes(endIso) : win.end_min;
  return Math.max(0, em - sm);
}

module.exports = {
  parseHm, bankHolidaySet, holidaySetFromRows, ruleMapFromRows, workingWindow, workingDaysSet,
  dayName, isSchedulableDay, isoToLondonDate, isoToLondonMinutes, blockMinutesOnDay, addDays,
};
