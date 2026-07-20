const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRrule(rrule) {
  const parts = {};
  String(rrule || '').split(';').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  });
  return parts;
}

function parseByDay(val) {
  const m = String(val).match(/^(-?\d+)?([A-Z]{2})$/i);
  if (!m) return null;
  return { nth: m[1] ? Number(m[1]) : null, dow: DOW[m[2].toUpperCase()] };
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function nthWeekdayInMonth(year, month, nth, dow) {
  if (nth > 0) {
    const first = new Date(year, month, 1);
    let day = 1 + ((dow - first.getDay() + 7) % 7);
    day += (nth - 1) * 7;
    const last = new Date(year, month + 1, 0).getDate();
    if (day > last) return null;
    return new Date(year, month, day);
  }
  const lastDay = new Date(year, month + 1, 0);
  let day = lastDay.getDate();
  while (day >= 1) {
    const d = new Date(year, month, day);
    if (d.getDay() === dow) return d;
    day -= 1;
  }
  return null;
}

function nextWeekly(from, byday) {
  const bd = parseByDay(byday);
  if (!bd || bd.dow == null) return null;
  const start = addDays(from, 1);
  let d = new Date(start);
  for (let i = 0; i < 366; i += 1) {
    if (d.getDay() === bd.dow) return d;
    d = addDays(d, 1);
  }
  return null;
}

function nextMonthlyDom(from, dom) {
  let d = new Date(from);
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 24; i += 1) {
    const y = d.getFullYear();
    const m = d.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    const day = Math.min(dom, last);
    const cand = new Date(y, m, day);
    if (cand > from) return cand;
    d = new Date(y, m + 1, 1);
  }
  return null;
}

function nextMonthlyByDay(from, byday, interval) {
  const bd = parseByDay(byday);
  if (!bd || bd.dow == null || !bd.nth) return null;
  let d = new Date(from);
  d.setDate(d.getDate() + 1);
  for (let i = 0; i < 36; i += 1) {
    const y = d.getFullYear();
    const m = d.getMonth();
    const cand = nthWeekdayInMonth(y, m, bd.nth, bd.dow);
    if (cand && cand > from) return cand;
    d = new Date(y, m + interval, 1);
  }
  return null;
}

/** Next occurrence on or after tomorrow from `fromDate` (YYYY-MM-DD or Date). */
export function nextDueFromRrule(rrule, fromDate) {
  const p = parseRrule(rrule);
  if (!p.FREQ) return null;
  const from = fromDate ? new Date(String(fromDate).slice(0, 10)) : new Date();
  from.setHours(12, 0, 0, 0);
  const interval = Number(p.INTERVAL) || 1;

  if (p.FREQ === 'WEEKLY' && p.BYDAY) {
    const n = nextWeekly(from, p.BYDAY.split(',')[0]);
    return n ? fmt(n) : null;
  }
  if (p.FREQ === 'MONTHLY' && p.BYMONTHDAY) {
    const n = nextMonthlyDom(from, Number(p.BYMONTHDAY));
    return n ? fmt(n) : null;
  }
  if (p.FREQ === 'MONTHLY' && p.BYDAY) {
    const n = nextMonthlyByDay(from, p.BYDAY.split(',')[0], interval);
    return n ? fmt(n) : null;
  }
  return null;
}

/** Most recent due date on or before today (for missed detection). */
export function lastDueOnOrBefore(rrule, today) {
  const p = parseRrule(rrule);
  if (!p.FREQ) return null;
  const end = today ? new Date(String(today).slice(0, 10)) : new Date();
  end.setHours(12, 0, 0, 0);
  let cursor = addDays(end, -400);
  let last = null;
  while (cursor <= end) {
    const n = nextDueFromRrule(rrule, addDays(cursor, -1));
    if (!n) break;
    const nd = new Date(n);
    nd.setHours(12, 0, 0, 0);
    if (nd <= end) last = n;
    cursor = addDays(nd, 1);
    if (nd > end) break;
  }
  return last;
}

export const RRULE_PRESETS = [
  { id: 'weekly', label: 'Weekly on day', cadence: 'Every Thursday', rrule: 'FREQ=WEEKLY;BYDAY=TH' },
  { id: 'monthly-dom', label: 'Monthly day N', cadence: '5th day monthly', rrule: 'FREQ=MONTHLY;BYMONTHDAY=5' },
  { id: 'monthly-nth', label: 'Nth weekday monthly', cadence: '2nd Thursday monthly', rrule: 'FREQ=MONTHLY;BYDAY=2TH' },
  { id: 'monthly-nth-bi', label: 'Nth weekday every 2 months', cadence: '4th Monday every other month', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO' },
  { id: 'quarterly-nth', label: 'Quarterly Nth weekday', cadence: '3rd Saturday every 3 months', rrule: 'FREQ=MONTHLY;INTERVAL=3;BYDAY=3SA' },
  { id: 'custom', label: 'Custom RRULE', cadence: '', rrule: '' },
];
