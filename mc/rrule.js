const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DOW_CODE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DOW_NAME = {
  SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday',
  TH: 'Thursday', FR: 'Friday', SA: 'Saturday',
};
const NTH_NAME = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', '-1': 'last' };

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

/** Local calendar date YYYY-MM-DD (no UTC shift). */
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

function nextWeekly(after, byday, interval = 1) {
  const bd = parseByDay(byday);
  if (!bd || bd.dow == null) return null;
  const step = Math.max(1, Number(interval) || 1);
  if (after.getDay() === bd.dow) return addDays(after, step * 7);
  let d = addDays(after, 1);
  for (let i = 0; i < 14; i += 1) {
    if (d.getDay() === bd.dow) return d;
    d = addDays(d, 1);
  }
  return null;
}

function nextMonthlyDom(after, dom, interval = 1) {
  let y = after.getFullYear();
  let m = after.getMonth();
  const step = Math.max(1, Number(interval) || 1);
  for (let i = 0; i < 48; i += 1) {
    const last = new Date(y, m + 1, 0).getDate();
    const day = Math.min(dom, last);
    const cand = new Date(y, m, day, 12, 0, 0, 0);
    if (cand > after) return cand;
    m += step;
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

/** Next occurrence strictly after fromDate (YYYY-MM-DD or Date). */
export function nextDueFromRrule(rrule, fromDate) {
  const p = parseRrule(rrule);
  if (!p.FREQ) return null;
  const after = fromDate instanceof Date
    ? new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate(), 12, 0, 0, 0)
    : fromYmd(fromDate || toYmd(new Date()));
  const interval = Number(p.INTERVAL) || 1;

  let n = null;
  if (p.FREQ === 'WEEKLY' && p.BYDAY) n = nextWeekly(after, p.BYDAY.split(',')[0], interval);
  else if (p.FREQ === 'MONTHLY' && p.BYMONTHDAY) n = nextMonthlyDom(after, Number(p.BYMONTHDAY), interval);
  else if (p.FREQ === 'MONTHLY' && p.BYDAY) n = nextMonthlyByDay(after, p.BYDAY.split(',')[0], interval);
  return n ? toYmd(n) : null;
}

/** Occurrences from startYmd..endYmd inclusive (local calendar days). Max 40. */
export function occurrencesInRange(rrule, startYmd, endYmd) {
  const start = fromYmd(startYmd);
  const end = fromYmd(endYmd);
  const out = [];
  let cur = addDays(start, -1);
  for (let i = 0; i < 40; i += 1) {
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

function phaseStartOf(rrule) {
  const p = parseRrule(rrule);
  const v = p['X-PHASE-START'];
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Most recent due date on or before today (missed detection). Hard-capped. */
export function lastDueOnOrBefore(rrule, today) {
  const end = today instanceof Date ? toYmd(today) : String(today || toYmd(new Date())).slice(0, 10);
  const endD = fromYmd(end);
  const phase = phaseStartOf(rrule);
  let cur = phase ? addDays(fromYmd(phase), -1) : addDays(endD, -420);
  let last = null;
  for (let i = 0; i < 80; i += 1) {
    const n = nextDueFromRrule(rrule, cur);
    if (!n) break;
    const nd = fromYmd(n);
    if (nd.getTime() <= cur.getTime()) break;
    if (nd > endD) break;
    last = n;
    cur = nd;
  }
  return last;
}

/**
 * Ideals in [startYmd, endYmd]. Honours X-PHASE-START so INTERVAL series can re-anchor.
 */
export function idealsInHorizon(rrule, startYmd, endYmd, maxSteps = 200, phaseAnchorYmd = null) {
  const from = String(startYmd).slice(0, 10);
  const to = String(endYmd).slice(0, 10);
  const phase = phaseStartOf(rrule);
  let expandFrom = from;
  if (phase) {
    expandFrom = phase;
  } else {
    const anchor = String(phaseAnchorYmd || from).slice(0, 10);
    try {
      const dayBefore = toYmd(addDays(fromYmd(anchor), -1));
      const last = lastDueOnOrBefore(rrule, dayBefore);
      if (last) expandFrom = last;
    } catch (_) { /* keep from */ }
  }
  const start = fromYmd(expandFrom);
  const end = fromYmd(to);
  const out = [];
  let cur = addDays(start, -1);
  for (let i = 0; i < maxSteps; i += 1) {
    const n = nextDueFromRrule(rrule, cur);
    if (!n) break;
    const nd = fromYmd(n);
    if (nd.getTime() <= cur.getTime()) break;
    if (nd > end) break;
    if (nd >= fromYmd(from) && nd <= end) out.push(n);
    cur = nd;
  }
  return out;
}

export function setPhaseStart(rrule, ymd) {
  const p = parseRrule(rrule);
  delete p['X-PHASE-START'];
  const parts = Object.keys(p).map((k) => `${k}=${p[k]}`);
  if (ymd) parts.push(`X-PHASE-START=${String(ymd).slice(0, 10)}`);
  return parts.join(';');
}

export function dowCodeFromYmd(ymd) {
  return DOW_CODE[fromYmd(ymd).getDay()];
}

/** Builder state from an existing RRULE. */
export function parseBuilder(rrule) {
  const p = parseRrule(rrule);
  const interval = Math.max(1, Number(p.INTERVAL) || 1);
  const phaseStart = phaseStartOf(rrule);
  if (p.FREQ === 'WEEKLY' && p.BYDAY) {
    const bd = parseByDay(p.BYDAY.split(',')[0]);
    return {
      pattern: 'weekly',
      interval,
      byday: bd ? DOW_CODE[bd.dow] : 'WE',
      nth: 1,
      monthday: 5,
      phaseStart,
      customRrule: '',
    };
  }
  if (p.FREQ === 'MONTHLY' && p.BYMONTHDAY) {
    return {
      pattern: 'monthly_dom',
      interval,
      byday: 'MO',
      nth: 1,
      monthday: Number(p.BYMONTHDAY) || 1,
      phaseStart,
      customRrule: '',
    };
  }
  if (p.FREQ === 'MONTHLY' && p.BYDAY) {
    const bd = parseByDay(p.BYDAY.split(',')[0]);
    return {
      pattern: 'monthly_nth',
      interval,
      byday: bd ? DOW_CODE[bd.dow] : 'SA',
      nth: bd?.nth || 1,
      monthday: 5,
      phaseStart,
      customRrule: '',
    };
  }
  return {
    pattern: 'custom',
    interval: 1,
    byday: 'WE',
    nth: 1,
    monthday: 5,
    phaseStart,
    customRrule: String(rrule || ''),
  };
}

/** Build RRULE (+ optional X-PHASE-START) from builder controls. */
export function buildRrule(state) {
  let core = '';
  if (state.pattern === 'weekly') {
    const iv = Math.max(1, Number(state.interval) || 1);
    core = iv > 1
      ? `FREQ=WEEKLY;INTERVAL=${iv};BYDAY=${state.byday || 'WE'}`
      : `FREQ=WEEKLY;BYDAY=${state.byday || 'WE'}`;
  } else if (state.pattern === 'monthly_dom') {
    const iv = Math.max(1, Number(state.interval) || 1);
    const dom = Math.min(31, Math.max(1, Number(state.monthday) || 1));
    core = iv > 1
      ? `FREQ=MONTHLY;INTERVAL=${iv};BYMONTHDAY=${dom}`
      : `FREQ=MONTHLY;BYMONTHDAY=${dom}`;
  } else if (state.pattern === 'monthly_nth') {
    const iv = Math.max(1, Number(state.interval) || 1);
    const nth = Number(state.nth) || 1;
    const tok = `${nth}${state.byday || 'MO'}`;
    core = iv > 1
      ? `FREQ=MONTHLY;INTERVAL=${iv};BYDAY=${tok}`
      : `FREQ=MONTHLY;BYDAY=${tok}`;
  } else {
    core = String(state.customRrule || '').replace(/;?X-PHASE-START=\d{4}-\d{2}-\d{2}/i, '');
  }
  return state.phaseStart ? setPhaseStart(core, state.phaseStart) : core.replace(/;?X-PHASE-START=\d{4}-\d{2}-\d{2}/i, '');
}

export function humanCadence(state) {
  const day = DOW_NAME[state.byday] || state.byday;
  const iv = Math.max(1, Number(state.interval) || 1);
  if (state.pattern === 'weekly') {
    return iv === 1 ? `Every ${day}` : `Every ${iv} weeks on ${day}`;
  }
  if (state.pattern === 'monthly_dom') {
    const dom = Number(state.monthday) || 1;
    return iv === 1 ? `${dom}th day monthly` : `${dom}th day every ${iv} months`;
  }
  if (state.pattern === 'monthly_nth') {
    const nth = NTH_NAME[String(state.nth)] || `${state.nth}th`;
    return iv === 1 ? `${nth} ${day} monthly` : `${nth} ${day} every ${iv} months`;
  }
  return '';
}

/** Pattern labels for the cadence builder (not hard-coded example RRULEs). */
export const CADENCE_PATTERNS = [
  { id: 'weekly', label: 'Weekly (every N weeks on a weekday)' },
  { id: 'monthly_dom', label: 'Monthly (day of month)' },
  { id: 'monthly_nth', label: 'Monthly (Nth weekday)' },
  { id: 'custom', label: 'Custom RRULE' },
];

/** @deprecated kept for any leftover imports — prefer CADENCE_PATTERNS + buildRrule */
export const RRULE_PRESETS = [
  { id: 'weekly', label: 'Weekly on day', cadence: '', rrule: '' },
  { id: 'custom', label: 'Custom RRULE', cadence: '', rrule: '' },
];

export { parseRrule, DOW_NAME, DOW_CODE };
