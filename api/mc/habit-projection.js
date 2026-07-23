/**
 * BAU habit calendar projection from recurring_tasks (READ-ONLY — no Google Calendar).
 *
 * Expands each active habit's RRULE over a rolling horizon (default 90 days).
 * Claude reads this list, places events in Google Calendar, and POSTs back via
 * /api/mc/habit-scheduled. Never filters occurrences except active=false.
 */
const { envReady, json, cors, sb } = require('./_lib');
const { occurrencesInRange, fromYmd, addDays, toYmd } = require('./rrule-core');

const DEFAULT_HORIZON = 90;
const MAX_HORIZON = 366;

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function fmtTime(t) {
  return String(t || '09:00').slice(0, 5);
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  const today = londonToday();
  const reqDays = Number(req.query?.days);
  const horizon = Number.isFinite(reqDays) && reqDays > 0
    ? Math.min(Math.round(reqDays), MAX_HORIZON) : DEFAULT_HORIZON;
  if (!envReady()) {
    return json(res, 200, {
      configured: false, generated_at: new Date().toISOString(), today,
      timezone: 'Europe/London', horizon_days: horizon, count: 0, occurrences: [], calendar_writes: 0,
    });
  }
  try {
    const endYmd = toYmd(addDays(fromYmd(today), horizon));
    const habits = await sb(
      'recurring_tasks?select=id,title,cadence_text,rrule,duration_min,ideal_time,window_days,last_scheduled,last_done,rolls_used&active=eq.true&order=title.asc',
    );
    const occurrences = [];
    const skipped = [];
    for (const h of Array.isArray(habits) ? habits : []) {
      let dates = [];
      try { dates = occurrencesInRange(h.rrule, today, endYmd); }
      catch (e) { skipped.push({ habit_id: h.id, title: h.title, reason: 'bad_rrule' }); continue; }
      if (!dates.length) {
        skipped.push({ habit_id: h.id, title: h.title, reason: 'no_occurrences' });
        continue;
      }
      for (const idealDate of dates) {
        occurrences.push({
          habit_id: h.id,
          title: h.title,
          ideal_date: idealDate,
          ideal_time: fmtTime(h.ideal_time),
          duration_min: h.duration_min,
          window_days: h.window_days,
          cadence_text: h.cadence_text,
          projection_key: `habit-${h.id}-${idealDate}`,
          last_scheduled: h.last_scheduled || null,
          last_done: h.last_done || null,
          rolls_used: h.rolls_used ?? 0,
        });
      }
    }
    occurrences.sort((a, b) => a.ideal_date.localeCompare(b.ideal_date) || a.title.localeCompare(b.title));
    return json(res, 200, {
      configured: true,
      generated_at: new Date().toISOString(),
      today,
      timezone: 'Europe/London',
      horizon_days: horizon,
      horizon_end: endYmd,
      count: occurrences.length,
      occurrences,
      skipped,
      calendar_writes: 0,
    });
  } catch {
    return json(res, 200, {
      configured: true, today, horizon_days: horizon, error: 'fail-silent',
      occurrences: [], skipped: [], calendar_writes: 0,
    });
  }
};
