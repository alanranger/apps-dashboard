/** RRULE expansion for server endpoints (mirrors mc/rrule.js). */
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

function toYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromYmd(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function nthWeekdayInMonth(year, month, nth, dow) {
  if (nth > 0) {
    const first = new Date(year, month, 1, 12, 0, 0, 0);
    let day = 1 + ((dow - first.getDay() + 7) % 7);
    day += (nth - 1) * 7;
    const last = new Date(year, month + 1, 0).getDate();
    if (day > last) return null;
    return new Date(year, month, day, 12, 0, 0, 0);
  }
  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let day = lastDay; day >= 1; day -= 1) {
    const d = new Date(year, month, day, 12, 0, 0, 0);
    if (d.getDay() === dow) return d;
  }
  return null;
}

function nextWeekly(after, byday) {
  const bd = parseByDay(byday);
  if (!bd || bd.dow == null) return null;
  let d = addDays(after, 1);
  for (let i = 0; i < 14; i += 1) {
    if (d.getDay() === bd.dow) return d;
    d = addDays(d, 1);
  }
  return null;
}

function nextMonthlyDom(after, dom, interval) {
  let y = after.getFullYear();
  let m = after.getMonth();
  for (let i = 0; i < 48; i += 1) {
    const last = new Date(y, m + 1, 0).getDate();
    const day = Math.min(dom, last);
    const cand = new Date(y, m, day, 12, 0, 0, 0);
    if (cand > after) return cand;
    m += interval;
    while (m > 11) { m -= 12; y += 1; }
  }
  return null;
}

function nextMonthlyByDay(after, byday, interval) {
  const bd = parseByDay(byday);
  if (!bd || bd.dow == null || !bd.nth) return null;
  let y = after.getFullYear();
  let m = after.getMonth();
  for (let i = 0; i < 48; i += 1) {
    const cand = nthWeekdayInMonth(y, m, bd.nth, bd.dow);
    if (cand && cand > after) return cand;
    m += interval;
    while (m > 11) { m -= 12; y += 1; }
  }
  return null;
}

function nextDueFromRrule(rrule, fromDate) {
  const p = parseRrule(rrule);
  if (!p.FREQ) return null;
  const after = fromDate instanceof Date
    ? new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate(), 12, 0, 0, 0)
    : fromYmd(fromDate || toYmd(new Date()));
  const interval = Number(p.INTERVAL) || 1;
  let n = null;
  if (p.FREQ === 'WEEKLY' && p.BYDAY) n = nextWeekly(after, p.BYDAY.split(',')[0]);
  else if (p.FREQ === 'MONTHLY' && p.BYMONTHDAY) n = nextMonthlyDom(after, Number(p.BYMONTHDAY), interval);
  else if (p.FREQ === 'MONTHLY' && p.BYDAY) n = nextMonthlyByDay(after, p.BYDAY.split(',')[0], interval);
  return n ? toYmd(n) : null;
}

/** Occurrences from startYmd..endYmd inclusive. Max steps capped for safety. */
function occurrencesInRange(rrule, startYmd, endYmd, maxSteps = 60) {
  const start = fromYmd(startYmd);
  const end = fromYmd(endYmd);
  const out = [];
  let cur = addDays(start, -1);
  for (let i = 0; i < maxSteps; i += 1) {
    const n = nextDueFromRrule(rrule, cur);
    if (!n) break;
    const nd = fromYmd(n);
    if (nd.getTime() <= cur.getTime()) break;
    if (nd > end) break;
    if (nd >= start) out.push(n);
    cur = nd;
  }
  return out;
}

module.exports = { occurrencesInRange, nextDueFromRrule, toYmd, fromYmd, addDays };
