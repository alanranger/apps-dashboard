/**
 * MC recurring-task calendar projection (READ-ONLY — never touches Google Calendar).
 *
 * For every ACTIVE task (open states only — see OPEN_STATES) with a non-empty
 * `recurrence` of the form `weekly:N` or `monthly:N`, emit the occurrences that
 * SHOULD exist over a rolling horizon (default 90 days, ?days=). Claude reads
 * this list and creates the missing Google Calendar events itself, de-duping on
 * the stable `projection_key`. The app creates/writes nothing external.
 *
 *   weekly:N  = every N weeks, on recurrence_day (1-7 Mon-Sun) else due_date's
 *               weekday else today's weekday. Phase anchored on due_date if set.
 *   monthly:N = every N months, on recurrence_day (1-31) else due_date's
 *               day-of-month else the 1st. Phase anchored on due_date if set.
 *
 * Read-only public GET (mirrors carry-forward-queue.js).
 */
const { envReady, json, cors, sb } = require('./_lib');

const OPEN_STATES = 'todo,in_progress,waiting';
const DEFAULT_HORIZON = 90;
const MAX_HORIZON = 366;
const STEP_CAP = 600;

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Noon-anchored Date from YYYY-MM-DD (date-only math, no day-rollover). */
function fromYmd(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0, 0));
}
function toYmd(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function parseRecurrence(r) {
  const m = /^(weekly|monthly):(\d+)$/.exec(String(r || '').trim().toLowerCase());
  if (!m) return null;
  return { unit: m[1], n: Math.max(1, Number(m[2]) || 1) };
}

/** Target weekday 0-6 (Sun-Sat) for a weekly task. */
function weeklyWeekday(t, todayD) {
  if (t.recurrence_day != null) {
    const d = Number(t.recurrence_day);
    return d === 7 ? 0 : d; // 1=Mon..7=Sun -> JS 1=Mon..0=Sun
  }
  if (t.due_date) return fromYmd(t.due_date).getUTCDay();
  return todayD.getUTCDay();
}
function monthlyDom(t) {
  if (t.recurrence_day != null) return Math.min(31, Math.max(1, Number(t.recurrence_day)));
  if (t.due_date) return fromYmd(t.due_date).getUTCDate();
  return 1;
}
function shiftToWeekday(d, wd) {
  const x = new Date(d);
  for (let g = 0; x.getUTCDay() !== wd && g < 7; g += 1) x.setUTCDate(x.getUTCDate() + 1);
  return x;
}

/** Occurrences (YYYY-MM-DD) every stepDays, phase-aligned to anchor, within [today,end]. */
function weeklyOccurrences(anchor, stepDays, todayD, endD) {
  let cur = new Date(anchor);
  let g = 0;
  while (cur > todayD && g < STEP_CAP) { cur = addDays(cur, -stepDays); g += 1; }
  g = 0;
  while (cur < todayD && g < STEP_CAP) { cur = addDays(cur, stepDays); g += 1; }
  const out = [];
  g = 0;
  while (cur <= endD && g < STEP_CAP) { out.push(toYmd(cur)); cur = addDays(cur, stepDays); g += 1; }
  return out;
}

function domDate(y, m, dom) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(dom, last), 12, 0, 0, 0));
}

/** Occurrences every stepMonths on day-of-month, phase-aligned to anchor month, within [today,end]. */
function monthlyOccurrences(anchorY, anchorM, dom, stepMonths, todayD, endD) {
  let y = anchorY;
  let m = anchorM;
  const back = () => { m -= stepMonths; while (m < 0) { m += 12; y -= 1; } };
  const fwd = () => { m += stepMonths; while (m > 11) { m -= 12; y += 1; } };
  let g = 0;
  while (domDate(y, m, dom) > todayD && g < STEP_CAP) { back(); g += 1; }
  g = 0;
  while (domDate(y, m, dom) < todayD && g < STEP_CAP) { fwd(); g += 1; }
  const out = [];
  g = 0;
  while (domDate(y, m, dom) <= endD && g < STEP_CAP) { out.push(toYmd(domDate(y, m, dom))); fwd(); g += 1; }
  return out;
}

function occurrenceDates(t, p, todayD, endD) {
  if (p.unit === 'weekly') {
    const wd = weeklyWeekday(t, todayD);
    const anchor = shiftToWeekday(t.due_date ? fromYmd(t.due_date) : new Date(todayD), wd);
    return weeklyOccurrences(anchor, 7 * p.n, todayD, endD);
  }
  const dom = monthlyDom(t);
  const base = t.due_date ? fromYmd(t.due_date) : todayD;
  return monthlyOccurrences(base.getUTCFullYear(), base.getUTCMonth(), dom, p.n, todayD, endD);
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const today = londonToday();
  const reqDays = Number(req.query?.days);
  const horizon = Number.isFinite(reqDays) && reqDays > 0 ? Math.min(Math.round(reqDays), MAX_HORIZON) : DEFAULT_HORIZON;
  if (!envReady()) {
    return json(res, 200, { configured: false, generated_at: new Date().toISOString(), horizon_days: horizon, occurrences: [], skipped: [] });
  }
  try {
    const todayD = fromYmd(today);
    const endD = addDays(todayD, horizon);
    const tasks = await sb(
      `tasks?select=display_id,title,recurrence,recurrence_day,due_date,est_minutes,priority,next_step&recurrence=not.is.null&state=in.(${OPEN_STATES})&order=display_id.asc`,
    );
    const occurrences = [];
    const skipped = [];
    for (const t of Array.isArray(tasks) ? tasks : []) {
      const p = parseRecurrence(t.recurrence);
      if (!p) {
        if (String(t.recurrence || '').trim()) skipped.push({ display_id: t.display_id, recurrence: t.recurrence, reason: 'unsupported_pattern' });
        continue;
      }
      for (const d of occurrenceDates(t, p, todayD, endD)) {
        occurrences.push({
          display_id: t.display_id,
          title: t.title,
          occurrence_date: d,
          recurrence: t.recurrence,
          est_minutes: t.est_minutes ?? null,
          priority: t.priority,
          next_step: t.next_step ?? null,
          projection_key: `mc-${t.display_id}-${d}`,
        });
      }
    }
    occurrences.sort((a, b) => a.occurrence_date.localeCompare(b.occurrence_date) || a.display_id - b.display_id);
    return json(res, 200, {
      configured: true,
      generated_at: new Date().toISOString(),
      today,
      timezone: 'Europe/London',
      horizon_days: horizon,
      count: occurrences.length,
      occurrences,
      skipped,
      calendar_writes: 0,
    });
  } catch {
    return json(res, 200, { configured: true, today, horizon_days: horizon, error: 'fail-silent', occurrences: [], skipped: [], calendar_writes: 0 });
  }
};
