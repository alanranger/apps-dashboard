/**
 * GET /api/mc/diary — 4-week diary feed (DB master + GCal READ for busy).
 * calendar_writes: always 0
 */
const { envReady, json, cors, requireAuth, sb } = require('./_lib');
const { fetchHorizonEvents, gcalConfigured } = require('./gcal-lib');
const {
  londonToday, addDaysYmd, mondayOnOrBefore, weeksFrom, ruleMapFromRows, splitMcAndBusy,
  awaySpansFromTravelBlocks, teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents,
  tasksToBlocks, travelToBlocks, busyToBlocks,
  fixtureFlanksToBlocks, allDayBannersFromBusy, holidayMapFromRows,
  habitLogsToBlocks, insertDecompressStrips, attachWeekCapacity,
  DAY_START_MIN, DAY_END_MIN, AXIS_STEP_MIN, PX_PER_STEP, GRID_PX,
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

    const [tasks, travel, habits, logs, pushOpen, backlog, fixtureRows, bhRows] = await Promise.all([
      sb(`tasks?select=id,display_id,title,state,priority,due_date,completed_on,last_activity_at,scheduled_start,scheduled_end,slot_pinned,calendar_event_id,est_minutes,actual_minutes&scheduled_start=gte.${timeMin}&scheduled_start=lt.${timeMax}&order=scheduled_start.asc`),
      sb(`travel_blocks?select=*&starts_at=gte.${timeMin}&starts_at=lt.${timeMax}&order=starts_at.asc`),
      sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,active,last_done&active=eq.true'),
      sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at&scheduled_date=gte.${from}&scheduled_date=lte.${to}&order=scheduled_date.asc`),
      listOpenPush(sb),
      listAwaySpanBacklog(sb),
      sb(`fixture_blocks?select=id,fixture_event_id,title,fixture_start,fixture_end,block_start,block_end,buffer_min,status&status=eq.active&fixture_start=gte.${timeMin}&fixture_start=lt.${timeMax}&order=fixture_start.asc`),
      sb(`bank_holidays?select=holiday_date,title&holiday_date=gte.${from}&holiday_date=lte.${to}`),
    ]);

    const habitMap = new Map((habits || []).map((h) => [h.id, h]));
    const holidays = holidayMapFromRows(bhRows);
    let busyBlocks = [];
    let dayBanners = [];
    let gcalHealth = null;
    let busyEvents = [];
    if (gcalConfigured()) {
      const { events, assessment } = await fetchHorizonEvents(timeMin, timeMax);
      gcalHealth = assessment;
      const split = splitMcAndBusy(events, ruleMap);
      // DB already paints tasks/habits — drop their GCal twins or they stack as CONFLICT.
      const tiedIds = new Set([
        ...(tasks || []).map((t) => t.calendar_event_id).filter(Boolean),
        ...(logs || []).map((l) => l.calendar_event_id).filter(Boolean),
        ...(travel || []).map((t) => t.calendar_event_id).filter(Boolean),
      ]);
      busyEvents = (split.busy || []).filter((e) => !e?.id || !tiedIds.has(e.id));
      const fixtures = (split.fixtures || []).filter((e) => !e?.id || !tiedIds.has(e.id));
      busyBlocks = busyToBlocks(busyEvents, fixtures);
      dayBanners = allDayBannersFromBusy(busyEvents);
    }
    for (const [day, title] of Object.entries(holidays)) {
      if (!dayBanners.some((b) => b.day === day && /bank holiday/i.test(b.title))) {
        dayBanners.push({ day, title, source: 'bank_holidays', id: `bh:${day}` });
      }
    }

    const awaySpans = awaySpansFromTravelBlocks(travel || []);
    const teachingSpans = teachingDaySpansFromEvents(busyEvents || [], ruleMap);
    const restSpans = restDaySpansFromWorkshopEvents(busyEvents || [], ruleMap);
    const rawBlocks = [
      ...tasksToBlocks(tasks, today),
      ...habitLogsToBlocks(logs, habitMap),
      ...travelToBlocks(travel),
      ...busyBlocks,
      ...fixtureFlanksToBlocks(fixtureRows),
    ];
    const blocks = insertDecompressStrips(rawBlocks, ruleMap);

    const awayDays = {};
    for (const span of awaySpans) {
      let d = span.startDay;
      while (d <= span.endDay) {
        awayDays[d] = {
          label: 'AWAY',
          summary: span.summary || null,
          kind: 'away_span',
        };
        d = addDaysYmd(d, 1);
      }
    }
    for (const span of restSpans) {
      if (awayDays[span.restDay]?.kind === 'away_span') continue;
      awayDays[span.restDay] = {
        label: 'REST',
        summary: span.summary || 'Rest day after multi-day workshop',
        kind: 'rest_after_workshop',
        workshop_title: span.workshop_title || null,
        workshop_last_day: span.lastDay || null,
      };
    }
    for (const span of teachingSpans) {
      if (awayDays[span.startDay]?.kind === 'away_span') continue;
      if (awayDays[span.startDay]?.kind === 'rest_after_workshop') continue;
      awayDays[span.startDay] = {
        label: 'TEACHING',
        summary: span.summary || 'Teaching / client day',
        kind: 'teaching_day',
      };
    }
    for (const [day, meta] of Object.entries(awayDays)) {
      if (meta.kind === 'rest_after_workshop' || meta.kind === 'teaching_day') {
        dayBanners.push({
          day,
          title: meta.label === 'REST' ? 'REST (after multi-day workshop)' : 'TEACHING / client day',
          source: meta.kind,
          id: `${meta.kind}:${day}`,
        });
      }
    }

    return json(res, 200, {
      from,
      to,
      today,
      weeks: attachWeekCapacity(weeksFrom(from, weeks), blocks, awayDays, ruleMap),
      day_axis: {
        start_min: DAY_START_MIN,
        end_min: DAY_END_MIN,
        step_min: AXIS_STEP_MIN,
        px_per_step: PX_PER_STEP,
        grid_px: GRID_PX,
      },
      blocks,
      away_days: awayDays,
      away_spans: awaySpans,
      rest_spans: restSpans,
      holidays,
      day_banners: dayBanners,
      rules: {
        daily_task_cap_min: Number(ruleMap.daily_task_cap_min || 240),
        decompress_after_task_min: Number(ruleMap.decompress_after_task_min || 30),
        buffer_scope: ruleMap.buffer_scope || 'home_only',
        gcal_writes_available: writesAvailable,
        rest_day_after_multiday_workshop: String(
          ruleMap.rest_day_after_multiday_workshop != null
            ? ruleMap.rest_day_after_multiday_workshop
            : 'true',
        ) === 'true',
        teaching_day_whole_day_block: String(
          ruleMap.teaching_day_whole_day_block || 'false',
        ) === 'true',
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
        'habit-placer-lib.restDaySpansFromWorkshopEvents',
        'habit-placer-lib.dayBlockedForPlacement',
        'habit-placer-lib.teachingDaySpansFromEvents',
      ],
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'diary error', detail: e.data });
  }
};
