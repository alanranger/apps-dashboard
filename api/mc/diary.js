/**
 * GET /api/mc/diary — 4-week diary feed (DB master + GCal READ for busy).
 * calendar_writes: always 0
 */
const { envReady, json, cors, requireAuth, sb } = require('./_lib');
const { fetchHorizonEvents, gcalConfigured } = require('./gcal-lib');
const {
  londonToday, addDaysYmd, mondayOnOrBefore, weeksFrom, ruleMapFromRows, splitMcAndBusy,
  awaySpansFromTravelBlocks, tasksToBlocks, travelToBlocks, busyToBlocks,
  habitLogsToBlocks, insertDecompressStrips, attachWeekCapacity, DAY_START_MIN, DAY_END_MIN,
} = require('./diary-lib');
const { listOpenPush, listAwaySpanBacklog, BACKLOG_SQL_HINT } = require('./gcal-push-lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  const rawFrom = String(req.query?.from || londonToday()).slice(0, 10);
  const from = mondayOnOrBefore(rawFrom);
  const weeks = Math.min(12, Math.max(1, Number(req.query?.weeks) || 8));
  const to = addDaysYmd(from, weeks * 7 - 1);
  const today = londonToday();

  try {
    const rules = await sb('scheduling_rules?select=key,value');
    const ruleMap = ruleMapFromRows(rules);
    const writesAvailable = String(ruleMap.gcal_writes_available || 'false') === 'true';

    const timeMin = `${from}T00:00:00.000Z`;
    const timeMax = `${addDaysYmd(to, 1)}T00:00:00.000Z`;

    const [tasks, travel, habits, logs, pushOpen, backlog] = await Promise.all([
      sb(`tasks?select=id,display_id,title,state,priority,due_date,completed_on,scheduled_start,scheduled_end,slot_pinned,calendar_event_id,est_minutes&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}&order=scheduled_start.asc`),
      sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}&order=starts_at.asc`),
      sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active&active=eq.true'),
      sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=scheduled_date.asc`),
      listOpenPush(sb),
      listAwaySpanBacklog(sb),
    ]);

    const habitMap = new Map((habits || []).map((h) => [h.id, h]));
    let busyBlocks = [];
    let gcalHealth = null;
    if (gcalConfigured()) {
      const { events, assessment } = await fetchHorizonEvents(timeMin, timeMax);
      gcalHealth = assessment;
      const split = splitMcAndBusy(events, ruleMap);
      busyBlocks = busyToBlocks(split.busy, split.fixtures);
    }

    const awaySpans = awaySpansFromTravelBlocks(travel || []);
    const rawBlocks = [
      ...tasksToBlocks(tasks, today),
      ...habitLogsToBlocks(logs, habitMap),
      ...travelToBlocks(travel),
      ...busyBlocks,
    ];
    const blocks = insertDecompressStrips(rawBlocks, ruleMap);

    const awayDays = {};
    for (const span of awaySpans) {
      let d = span.startDay;
      while (d <= span.endDay) {
        awayDays[d] = {
          label: 'AWAY',
          summary: span.summary || null,
        };
        d = addDaysYmd(d, 1);
      }
    }

    return json(res, 200, {
      from,
      to,
      weeks: attachWeekCapacity(weeksFrom(from, weeks), blocks, awayDays, ruleMap),
      day_axis: { start_min: DAY_START_MIN, end_min: DAY_END_MIN },
      blocks,
      away_days: awayDays,
      away_spans: awaySpans,
      rules: {
        daily_task_cap_min: Number(ruleMap.daily_task_cap_min || 240),
        decompress_after_task_min: Number(ruleMap.decompress_after_task_min || 30),
        buffer_scope: ruleMap.buffer_scope || 'home_only',
        gcal_writes_available: writesAvailable,
      },
      push: {
        open_count: (pushOpen || []).length,
        backlog_count: (backlog || []).length,
        backlog_filter: BACKLOG_SQL_HINT,
        writes_available: writesAvailable,
      },
      gcal_health: gcalHealth,
      calendar_writes: 0,
      warn_checks_use: [
        'habit-placer-lib.requiredGapMins',
        'habit-placer-lib.dayCapLimits',
        'habit-placer-lib.awaySpansFromTravelBlocks',
        'habit-placer-lib.dayInsideAwaySpan',
      ],
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'diary error', detail: e.data });
  }
};
