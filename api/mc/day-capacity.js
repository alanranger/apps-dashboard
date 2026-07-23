/**
 * GET /api/mc/day-capacity — per-day MC capacity (no Google Calendar access).
 * ?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
const { envReady, json, cors, sb } = require('./_lib');
const {
  bankHolidaySet, ruleMapFromRows, workingWindow, isSchedulableDay, blockMinutesOnDay,
} = require('./scheduling-rules-lib');

function todayLondon() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const from = String(req.query?.from || todayLondon()).slice(0, 10);
  const to = String(req.query?.to || addDays(from, 30)).slice(0, 10);
  try {
    const rules = await sb('scheduling_rules?select=key,value');
    const ruleMap = ruleMapFromRows(rules);
    const capMin = Number(ruleMap.daily_task_cap_min || 240);
    const holidays = bankHolidaySet(Number(from.slice(0, 4)), Number(to.slice(0, 4)));
    const tasks = await sb(
      'tasks?select=display_id,scheduled_start,scheduled_end,est_minutes,slot_pinned&scheduled_start=not.is.null&order=scheduled_start.asc',
    );
    const days = [];
    let cur = from;
    while (cur <= to) {
      const win = workingWindow(ruleMap, cur);
      const bh = holidays.has(cur);
      const schedulable = isSchedulableDay(cur, ruleMap, holidays);
      let mcMin = 0;
      for (const t of tasks || []) {
        if (!t.scheduled_start) continue;
        mcMin += blockMinutesOnDay(t.scheduled_start, t.scheduled_end || t.scheduled_start, cur);
      }
      const remaining = Math.max(0, capMin - mcMin);
      days.push({
        date: cur,
        is_bank_holiday: bh,
        schedulable,
        working_window: { start: win.start, end: win.end },
        mc_minutes_scheduled: mcMin,
        mc_minutes_remaining: remaining,
        is_over_cap: mcMin > capMin,
      });
      cur = addDays(cur, 1);
    }
    return json(res, 200, {
      from, to, timezone: 'Europe/London', daily_task_cap_min: capMin, days, calendar_writes: 0,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'day-capacity error', detail: e.data });
  }
};
