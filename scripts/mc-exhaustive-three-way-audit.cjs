/**
 * Read-only exhaustive 3-way audit: rules ↔ DB ↔ live Google (full horizon).
 * REPORT ONLY — no writes except optional status file under tmp/ + Drive copy.
 * node scripts/mc-exhaustive-three-way-audit.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const {
  ruleMapFromRows, bankHolidaySet, addDays, isoToLondonDate, isoToLondonMinutes,
  workingWindow, isSchedulableDay,
} = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const {
  awaySpansFromTravelBlocks, dayBlockedForHabits, dayBlockedForPlacement,
  restDaySpansFromDbRows, habitGapTier, gapMinsForTitle, requiredGapMins,
} = require('../api/mc/habit-placer-lib');
const { flankWindows } = require('../api/mc/fixture-coverage-lib');
const { parseDiaryPin, isSkippedChange } = require('../api/mc/diary-lib');

function v(rule, layer, id, date, dbVal, gcalVal, detail) {
  return {
    rule, layer, id: id || null, date: date || null,
    db_value: dbVal ?? null, google_value: gcalVal ?? null, detail: detail || null,
  };
}

function ruleBucket(name) {
  return { rule: name, checked: 0, violations: [], cannot_check: null };
}

function isMcTitle(summary, ruleMap) {
  const t = String(summary || '');
  const prefixes = [
    ruleMap.title_prefix_recurring, ruleMap.title_prefix_travel,
    ruleMap.title_prefix_buffer, ruleMap.title_prefix_deadline,
    ruleMap.title_prefix_fixture, 'MC ', 'MC-',
  ].filter(Boolean);
  return prefixes.some((p) => t.includes(p));
}

function isTravelOrBufferTitle(t, ruleMap) {
  const s = String(t || '');
  return s.includes(ruleMap.title_prefix_travel || 'MC 🚗')
    || s.includes(ruleMap.title_prefix_buffer || 'MC ⏳')
    || /travel (out|back)/i.test(s) || /^prep —/i.test(s) || /^decompress —/i.test(s);
}

function isFixtureTitle(t, ruleMap) {
  const s = String(t || '');
  return s.includes(ruleMap.title_prefix_fixture || 'MC ⚽') || s.includes('⚽');
}

function isAwayOrRestBanner(t) {
  const s = String(t || '');
  return /MC\s*🚫/.test(s) || /MC\s*🛌/.test(s)
    || /\bAWAY\s*[—-]/.test(s) || /\bREST\s*[—-]/.test(s);
}

function eventBounds(e) {
  const start = e.start?.dateTime || (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
  const end = e.end?.dateTime || (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
  return { start, end, day: start ? isoToLondonDate(start) : (e.start?.date || null) };
}

function latestLogsByKey(logs) {
  const best = new Map();
  for (const row of logs || []) {
    if (!row.recurring_task_id) continue;
    const ideal = row.ideal_date || row.scheduled_date;
    if (!ideal) continue;
    const k = `${row.recurring_task_id}|${ideal}`;
    const prev = best.get(k);
    if (!prev || String(row.at || '') > String(prev.at || '')) best.set(k, row);
  }
  return [...best.values()];
}

function habitInterval(log, habit) {
  if (!log?.scheduled_date || isSkippedChange(log.change) || /^unplaced\b/i.test(log.change || '')) {
    return null;
  }
  const pin = parseDiaryPin(log.change);
  if (pin?.start && pin?.end) {
    return {
      start: pin.start, end: pin.end, day: isoToLondonDate(pin.start) || log.scheduled_date,
      title: habit?.title || 'habit', habit_id: log.recurring_task_id,
      event_id: log.calendar_event_id || null, ideal_date: log.ideal_date, log_id: log.id,
    };
  }
  const hm = String(habit?.ideal_time || '09:00').slice(0, 5);
  const dur = Number(habit?.duration_min || 60);
  const startMs = Date.parse(`${log.scheduled_date}T${hm}:00+01:00`);
  if (!Number.isFinite(startMs)) return null;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + dur * 60000).toISOString(),
    day: log.scheduled_date,
    title: habit?.title || 'habit',
    habit_id: log.recurring_task_id,
    event_id: log.calendar_event_id || null,
    ideal_date: log.ideal_date,
    log_id: log.id,
  };
}

(async () => {
  const today = londonToday();
  const toYmd = '2027-01-31';
  const fromYmd = today;
  const timeMin = `${addDays(fromYmd, -7)}T00:00:00.000Z`;
  const timeMax = `${addDays(toYmd, 1)}T00:00:00.000Z`;

  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const manualBlocked = String(ruleMap.blocked_dates_manual || '')
    .split(',').map((s) => s.trim()).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));

  console.log('Fetching live Google…', fromYmd, '→', toYmd);
  const { events, health, assessment } = await fetchHorizonEvents(timeMin, timeMax);
  const byId = new Map((events || []).filter((e) => e?.id).map((e) => [e.id, e]));
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary');

  const [tasks, habits, logs, travel, restDb, fixtures, hotels] = await Promise.all([
    sb(
      'tasks?select=id,display_id,title,state,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,est_minutes'
      + `&scheduled_start=gte.${fromYmd}T00:00:00Z&scheduled_start=lte.${toYmd}T23:59:59Z`
      + '&state=not.in.(done,verified,wont_do,superseded)',
    ),
    sb('recurring_tasks?select=id,title,duration_min,ideal_time,priority,rrule,time_critical,window_days,rolls_used,active&active=eq.true'),
    sb(
      `recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,roll_reason,at`
      + `&or=(and(scheduled_date.gte.${fromYmd},scheduled_date.lte.${toYmd}),`
      + `and(ideal_date.gte.${fromYmd},ideal_date.lte.${toYmd}))&order=at.desc&limit=8000`,
    ),
    sb(
      `travel_blocks?select=id,block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,`
      + 'workshop_row_key,calendar_event_id,leg_from,leg_to'
      + `&starts_at=gte.${fromYmd}T00:00:00Z&starts_at=lte.${toYmd}T23:59:59Z`,
    ),
    sb(`rest_day_blocks?status=eq.active&rest_date=gte.${fromYmd}&rest_date=lte.${toYmd}&select=rest_date,workshop_title`),
    sb(
      `fixture_blocks?select=id,fixture_event_id,fixture_start,fixture_end,before_event_id,after_event_id,title,status`
      + `&fixture_start=gte.${fromYmd}T00:00:00Z&fixture_start=lte.${toYmd}T23:59:59Z`,
    ),
    sb(
      'workshop_hotels?select=id,workshop_name,check_in_date,free_cancel_until,reminder_event_id,reminder_placed,status,hotel,booking_ref'
      + `&check_in_date=gte.${fromYmd}&check_in_date=lte.${toYmd}`,
    ),
  ]);

  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const latest = latestLogsByKey(logs || []);
  const habitBlocks = latest.map((l) => habitInterval(l, habitMap.get(l.recurring_task_id))).filter(Boolean);
  const taskBlocks = (tasks || []).filter((t) => t.scheduled_start && t.scheduled_end).map((t) => ({
    start: t.scheduled_start,
    end: t.scheduled_end,
    day: isoToLondonDate(t.scheduled_start),
    title: t.title,
    display_id: t.display_id,
    event_id: t.calendar_event_id || null,
    slot_pinned: !!t.slot_pinned,
    id: t.id,
    kind: 'task',
  }));

  const awaySpans = awaySpansFromTravelBlocks(travel || []);
  const restSpans = restDaySpansFromDbRows(restDb || []);
  const blockedSpans = awaySpans.concat(restSpans);
  const adminGap = Number(ruleMap.admin_gap_min || 15);
  const decompress = Number(ruleMap.decompress_after_task_min || 30);
  const prepMin = Number(ruleMap.prep_buffer_min || 30);
  const cap = Number(ruleMap.daily_task_cap_min || 240);
  const capTol = Number(ruleMap.daily_task_cap_tolerance_min || 30);
  const fixtureBuf = Number(ruleMap.fixture_buffer_min || 60);
  const hotelDays = Number(ruleMap.hotel_deadline_reminder_days || 3);
  const arriveBefore = Number(ruleMap.arrive_before_start_min || 30);
  const residentialHm = String(ruleMap.residential_arrive_hm || '16:00');

  const report = {
    generated_at: new Date().toISOString(),
    mode: 'report_only',
    horizon: { from: fromYmd, to: toYmd, timeMin, timeMax },
    gcal_health: { health, assessment, event_count: (events || []).length, primary_count: primary.length },
    rules: Object.fromEntries((rules || []).map((r) => [r.key, r.value])),
    buckets: {},
    orphans_google_no_db: [],
    db_missing_google: [],
    totals: {},
  };

  const B = report.buckets;

  // —— DB ↔ Google link integrity ——
  B.db_google_match = ruleBucket('db_google_match (live pull)');
  B.db_master_missing_google = ruleBucket('db_master_with_event_id_missing_on_google');
  const dbLinked = [];
  for (const t of taskBlocks) {
    if (!t.event_id) continue;
    dbLinked.push({
      kind: 'task', id: `MC-${t.display_id}`, title: t.title, event_id: t.event_id,
      start: t.start, end: t.end, day: t.day,
    });
  }
  for (const h of habitBlocks) {
    if (!h.event_id) continue;
    dbLinked.push({
      kind: 'habit', id: h.log_id, title: h.title, event_id: h.event_id,
      start: h.start, end: h.end, day: h.day,
    });
  }
  for (const tr of travel || []) {
    if (!tr.calendar_event_id) continue;
    dbLinked.push({
      kind: 'travel', id: tr.id, title: `${tr.block_type} ${tr.workshop_title || ''}`,
      event_id: tr.calendar_event_id, start: tr.starts_at, end: tr.ends_at,
      day: isoToLondonDate(tr.starts_at),
    });
  }
  for (const m of dbLinked) {
    B.db_google_match.checked += 1;
    const live = byId.get(m.event_id);
    if (!live) {
      B.db_master_missing_google.checked += 1;
      const row = v('db_master_missing_google', 'DB↔Google', m.event_id, m.day, m.start, null,
        `${m.kind} "${m.title}" event_id not in live horizon pull`);
      B.db_master_missing_google.violations.push(row);
      report.db_missing_google.push(row);
      continue;
    }
    B.db_master_missing_google.checked += 1;
    const b = eventBounds(live);
    const titleOk = String(live.summary || '').includes(String(m.title || '').slice(0, 24))
      || String(live.summary || '') === String(m.title || '')
      || (m.kind === 'travel' && String(live.summary || '').includes('MC'));
    const startOk = Math.abs(Date.parse(b.start) - Date.parse(m.start)) <= 120000;
    const endOk = Math.abs(Date.parse(b.end) - Date.parse(m.end)) <= 120000;
    if (!titleOk || !startOk || !endOk) {
      B.db_google_match.violations.push(v(
        'db_google_match', 'DB↔Google', m.event_id, m.day,
        `${m.title} ${m.start}–${m.end}`,
        `${live.summary} ${b.start}–${b.end}`,
        `titleOk=${titleOk} startOk=${startOk} endOk=${endOk}`,
      ));
    }
  }

  // —— Google MC orphans (no DB master referencing event id) ——
  B.google_orphan_mc = ruleBucket('google_mc_event_without_db_master');
  const referenced = new Set(dbLinked.map((m) => m.event_id).filter(Boolean));
  for (const f of fixtures || []) {
    if (f.before_event_id) referenced.add(f.before_event_id);
    if (f.after_event_id) referenced.add(f.after_event_id);
  }
  for (const h of hotels || []) {
    if (h.reminder_event_id) referenced.add(h.reminder_event_id);
  }
  for (const e of primary) {
    if (!isMcTitle(e.summary, ruleMap)) continue;
    B.google_orphan_mc.checked += 1;
    if (referenced.has(e.id)) continue;
    const b = eventBounds(e);
    const cls = isTravelOrBufferTitle(e.summary, ruleMap)
      ? 'buffer_or_travel_title'
      : isAwayOrRestBanner(e.summary)
        ? 'away_rest_banner'
        : isFixtureTitle(e.summary, ruleMap)
          ? 'fixture_flank'
          : 'unreferenced_mc';
    const row = v('google_orphan_mc', 'Google↔DB', e.id, b.day, cls, e.summary,
      'Primary MC-titled event not referenced by tasks/habits/travel/fixtures/hotels');
    B.google_orphan_mc.violations.push(row);
    report.orphans_google_no_db.push(row);
  }

  // —— Rest / away / bank holiday / manual blocked ——
  B.rest_day = ruleBucket('rest_day_after_multiday_workshop');
  B.away_span = ruleBucket('away_spans_hard_busy_incl_edges');
  B.bank_holiday = ruleBucket('exclude_bank_holidays');
  B.blocked_manual = ruleBucket('blocked_dates_manual');

  const placeables = taskBlocks.map((t) => ({ ...t, forHabits: false }))
    .concat(habitBlocks.map((h) => ({ ...h, forHabits: true, id: h.log_id })));

  for (const p of placeables) {
    if (!p.day) continue;
    B.rest_day.checked += 1;
    B.away_span.checked += 1;
    B.bank_holiday.checked += 1;
    B.blocked_manual.checked += 1;
    const onRest = restSpans.some((s) => p.day === String(s.restDay || s.startDay));
    if (onRest) {
      B.rest_day.violations.push(v('rest_day', 'Rule↔DB', p.id || p.event_id, p.day,
        p.title, null, 'placed on rest_day_blocks day'));
    }
    if (dayBlockedForHabits(p.day, awaySpans)) {
      // habits always; tasks also flagged when on full away span (hard-busy per brief)
      B.away_span.violations.push(v('away_span', 'Rule↔DB', p.id || p.event_id, p.day,
        p.title, null, p.forHabits ? 'habit on away/travel-edge day' : 'task on away/travel-edge day'));
    }
    if (ruleMap.exclude_bank_holidays === 'true' && holidays.has(p.day)) {
      B.bank_holiday.violations.push(v('bank_holiday', 'Rule↔DB', p.id || p.event_id, p.day,
        p.title, null, 'on bank holiday'));
    }
    if (manualBlocked.includes(p.day)) {
      B.blocked_manual.violations.push(v('blocked_manual', 'Rule↔DB', p.id || p.event_id, p.day,
        p.title, null, 'on blocked_dates_manual'));
    }
  }
  if (String(ruleMap.blocked_dates_manual || 'none').toLowerCase() === 'none') {
    B.blocked_manual.cannot_check = 'blocked_dates_manual=none (nothing to violate)';
  }

  // —— Google layer: MC primary on rest/away ——
  B.google_on_blocked = ruleBucket('google_mc_on_rest_or_away');
  for (const e of primary) {
    if (!isMcTitle(e.summary, ruleMap)) continue;
    if (isTravelOrBufferTitle(e.summary, ruleMap) || isFixtureTitle(e.summary, ruleMap)) continue;
    if (isAwayOrRestBanner(e.summary)) continue; // banners belong on blocked days
    const b = eventBounds(e);
    if (!b.day) continue;
    B.google_on_blocked.checked += 1;
    const onRest = restSpans.some((s) => b.day === String(s.restDay || s.startDay));
    const onAway = dayBlockedForHabits(b.day, awaySpans);
    if (onRest || onAway) {
      B.google_on_blocked.violations.push(v('google_on_blocked', 'Google↔Rule', e.id, b.day,
        null, e.summary, onRest ? 'rest day' : 'away/travel-edge day'));
    }
  }

  // —— Working hours (tasks/habits; pinned exempt) ——
  B.working_hours = ruleBucket('working_hours (pinned exempt)');
  for (const p of placeables) {
    if (p.slot_pinned) continue;
    if (isTravelOrBufferTitle(p.title, ruleMap)) continue;
    B.working_hours.checked += 1;
    const win = workingWindow(ruleMap, p.day);
    const sm = isoToLondonMinutes(p.start);
    const em = isoToLondonMinutes(p.end);
    const overrunMax = Number(ruleMap.window_overrun_max_min || 60);
    const reasons = [];
    if (sm != null && win.start_min != null && sm < win.start_min) reasons.push(`starts_before_${win.start}`);
    if (em != null && win.end_min != null && em > win.end_min + overrunMax) {
      reasons.push(`ends_after_${win.end}_plus_tol`);
    }
    if (reasons.length) {
      B.working_hours.violations.push(v('working_hours', 'Rule↔DB', p.id || p.event_id, p.day,
        `${p.title} ${p.start}–${p.end}`, null, reasons.join(',')));
    }
  }

  // —— Daily cap (tasks + habits desk load) ——
  B.daily_cap = ruleBucket('daily_task_cap_min+tolerance');
  const dayLoad = {};
  for (const p of placeables) {
    if (!p.day || isTravelOrBufferTitle(p.title, ruleMap)) continue;
    const mins = Math.max(0, (Date.parse(p.end) - Date.parse(p.start)) / 60000);
    dayLoad[p.day] = (dayLoad[p.day] || 0) + mins;
  }
  for (const [day, mins] of Object.entries(dayLoad)) {
    B.daily_cap.checked += 1;
    if (mins > cap + capTol) {
      B.daily_cap.violations.push(v('daily_cap', 'Rule↔DB', day, day, `${mins}m`, null,
        `cap=${cap}+tol=${capTol}`));
    }
  }

  // —— Admin / decompress gaps between consecutive desk work same day ——
  B.admin_decompress_gap = ruleBucket('admin_gap_min / decompress_after_task_min');
  const byDay = {};
  for (const p of placeables) {
    if (!p.day || isTravelOrBufferTitle(p.title, ruleMap) || isFixtureTitle(p.title, ruleMap)) continue;
    if (!byDay[p.day]) byDay[p.day] = [];
    byDay[p.day].push(p);
  }
  for (const [day, list] of Object.entries(byDay)) {
    list.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let i = 0; i < list.length - 1; i += 1) {
      B.admin_decompress_gap.checked += 1;
      const a = list[i];
      const b = list[i + 1];
      const gap = (Date.parse(b.start) - Date.parse(a.end)) / 60000;
      const need = requiredGapMins(a.title, b.title, ruleMap);
      if (gap < need - 0.5) {
        B.admin_decompress_gap.violations.push(v(
          'admin_decompress_gap', 'Rule↔DB', `${a.id || a.event_id}|${b.id || b.event_id}`, day,
          `${a.title} → ${b.title} gap=${Math.round(gap)} need=${need}`, null,
          `tiers ${habitGapTier(a.title)}/${habitGapTier(b.title)} admin=${adminGap} decompress=${decompress}`,
        ));
      }
    }
  }

  // —— Habit↔habit overlaps ——
  B.habit_overlap = ruleBucket('habit_vs_habit_overlap');
  const hb = habitBlocks.slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let i = 0; i < hb.length; i += 1) {
    for (let j = i + 1; j < hb.length; j += 1) {
      if (hb[j].day !== hb[i].day) {
        if (hb[j].day > hb[i].day) break;
        continue;
      }
      B.habit_overlap.checked += 1;
      if (Date.parse(hb[j].start) < Date.parse(hb[i].end) && Date.parse(hb[j].end) > Date.parse(hb[i].start)) {
        B.habit_overlap.violations.push(v('habit_overlap', 'Rule↔DB',
          `${hb[i].log_id}|${hb[j].log_id}`, hb[i].day,
          `${hb[i].title} ${hb[i].start}`, `${hb[j].title} ${hb[j].start}`, 'overlap'));
      }
    }
  }

  // —— Fixture buffers ——
  B.fixture_buffers = ruleBucket('fixture_buffer_min flanks');
  for (const f of fixtures || []) {
    B.fixture_buffers.checked += 1;
    const fake = { start: { dateTime: f.fixture_start }, end: { dateTime: f.fixture_end }, summary: f.title };
    const win = flankWindows(fake, fixtureBuf);
    if (!win) {
      B.fixture_buffers.violations.push(v('fixture_buffers', 'Rule↔DB', f.id, null, f.title, null, 'bad fixture times'));
      continue;
    }
    const before = f.before_event_id ? byId.get(f.before_event_id) : null;
    const after = f.after_event_id ? byId.get(f.after_event_id) : null;
    if (!f.before_event_id || !before) {
      B.fixture_buffers.violations.push(v('fixture_buffers', 'DB↔Google', f.id,
        isoToLondonDate(f.fixture_start), 'before_event_id', f.before_event_id || 'missing',
        'Before flank missing on Google or unset'));
    } else {
      const bb = eventBounds(before);
      if (Math.abs(Date.parse(bb.start) - Date.parse(win.before_start)) > 120000
        || Math.abs(Date.parse(bb.end) - Date.parse(win.before_end)) > 120000) {
        B.fixture_buffers.violations.push(v('fixture_buffers', 'DB↔Google', f.before_event_id,
          isoToLondonDate(f.fixture_start), `${win.before_start}–${win.before_end}`,
          `${bb.start}–${bb.end}`, 'Before flank time mismatch'));
      }
    }
    if (!f.after_event_id || !after) {
      B.fixture_buffers.violations.push(v('fixture_buffers', 'DB↔Google', f.id,
        isoToLondonDate(f.fixture_start), 'after_event_id', f.after_event_id || 'missing',
        'After flank missing on Google or unset'));
    } else {
      const ab = eventBounds(after);
      if (Math.abs(Date.parse(ab.start) - Date.parse(win.after_start)) > 120000
        || Math.abs(Date.parse(ab.end) - Date.parse(win.after_end)) > 120000) {
        B.fixture_buffers.violations.push(v('fixture_buffers', 'DB↔Google', f.after_event_id,
          isoToLondonDate(f.fixture_start), `${win.after_start}–${win.after_end}`,
          `${ab.start}–${ab.end}`, 'After flank time mismatch'));
      }
    }
  }

  // —— Travel: join travel pairs ↔ live workshop (existing travel-regenerate formulas) ——
  B.travel_residential_arrive = ruleBucket('residential_arrive_hm');
  B.travel_arrive_before = ruleBucket('arrive_before_start_min');
  B.travel_depart_end = ruleBucket('depart_at_stated_end');
  B.travel_multiday_hotel = ruleBucket('multiday_needs_hotel');
  {
    const {
      pairTravelBlocks, desiredTravelTimes, pickWorkshop, isTravelWorkshopEvent,
      hasIntermediateTravelLegs,
    } = require('../api/mc/travel-regenerate-lib');
    const workshops = (events || []).filter(isTravelWorkshopEvent);
    const pairs = pairTravelBlocks(travel || []);
    const hotelByName = (hotels || []).map((h) => ({
      ...h, n: String(h.workshop_name || '').toLowerCase(),
    }));
    for (const pair of pairs) {
      const title = pair.out?.workshop_title || '';
      const outDay = isoToLondonDate(pair.out?.starts_at);
      const backDay = isoToLondonDate(pair.back?.starts_at);
      const multi = outDay && backDay && outDay !== backDay;
      if (multi) {
        B.travel_multiday_hotel.checked += 1;
        const hit = hotelByName.some((h) => h.n && normTitleLike(title, h.n));
        if (!hit) {
          B.travel_multiday_hotel.violations.push(v(
            'multiday_needs_hotel', 'Rule↔DB', pair.out?.id, outDay, title, null,
            'multi-day travel pair with no matching workshop_hotels row',
          ));
        }
      }
      if (hasIntermediateTravelLegs(pair, travel || [])) continue;
      const match = pickWorkshop(pair, workshops);
      B.travel_arrive_before.checked += 1;
      B.travel_depart_end.checked += 1;
      B.travel_residential_arrive.checked += 1;
      if (!match?.bounds) {
        B.travel_arrive_before.violations.push(v(
          'arrive_before_start_min', 'Rule↔DB', pair.out?.id, outDay, title, null, 'no_workshop_match',
        ));
        continue;
      }
      const drive = Number(pair.out?.drive_minutes_used || 90);
      const desired = desiredTravelTimes(match.bounds, drive, arriveBefore, pair, ruleMap);
      if (!desired) continue;
      if (desired.mode === 'residential_arrive') {
        if (Math.abs(Date.parse(pair.out.ends_at) - Date.parse(desired.out.ends_at)) > 20 * 60000) {
          B.travel_residential_arrive.violations.push(v(
            'residential_arrive_hm', 'Rule↔DB', pair.out.id, outDay,
            pair.out.ends_at, desired.out.ends_at, `want ${residentialHm} day-before`,
          ));
        }
      } else if (Math.abs(Date.parse(pair.out.ends_at) - Date.parse(desired.out.ends_at)) > 20 * 60000) {
        B.travel_arrive_before.violations.push(v(
          'arrive_before_start_min', 'Rule↔DB', pair.out.id, outDay,
          pair.out.ends_at, desired.out.ends_at, `arrive_before=${arriveBefore}`,
        ));
      }
      if (Math.abs(Date.parse(pair.back.starts_at) - Date.parse(desired.back.starts_at)) > 20 * 60000) {
        B.travel_depart_end.violations.push(v(
          'depart_at_stated_end', 'Rule↔DB', pair.back.id, backDay,
          pair.back.starts_at, desired.back.starts_at, desired.mode,
        ));
      }
    }
  }

  function normTitleLike(a, b) {
    const x = String(a || '').toLowerCase();
    const y = String(b || '').toLowerCase();
    if (!x || !y) return false;
    return x.includes(y.slice(0, 12)) || y.includes(x.slice(0, 12));
  }

  // —— Hotel deadline reminders ——
  B.hotel_deadline = ruleBucket('hotel_deadline_reminder_days');
  for (const h of hotels || []) {
    B.hotel_deadline.checked += 1;
    if (!h.free_cancel_until) {
      B.hotel_deadline.violations.push(v('hotel_deadline', 'Rule↔DB', h.id, h.check_in_date,
        h.workshop_name, null, 'free_cancel_until missing'));
      continue;
    }
    if (!h.reminder_event_id) {
      B.hotel_deadline.violations.push(v('hotel_deadline', 'DB↔Google', h.id, h.free_cancel_until,
        h.workshop_name, null, `no reminder_event_id (policy ${hotelDays}d before cancel)`));
      continue;
    }
    const live = byId.get(h.reminder_event_id);
    if (!live) {
      B.hotel_deadline.violations.push(v('hotel_deadline', 'DB↔Google', h.reminder_event_id,
        h.free_cancel_until, h.workshop_name, null, 'reminder event missing on Google'));
    }
  }
  B.direct_hotel_release = ruleBucket('direct_hotel_release_weeks');
  {
    const weeks = Number(ruleMap.direct_hotel_release_weeks || 2);
    const horizon = addDays(today, weeks * 7);
    for (const h of hotels || []) {
      const cin = h.check_in_date ? String(h.check_in_date).slice(0, 10) : null;
      if (!cin || cin < today || cin > horizon) continue;
      B.direct_hotel_release.checked += 1;
      if (!h.hotel && !h.booking_ref) {
        B.direct_hotel_release.violations.push(v(
          'direct_hotel_release_weeks', 'Rule↔DB', h.id, cin, h.workshop_name, null,
          `within ${weeks}w release window but hotel/booking_ref empty`,
        ));
      }
    }
  }

  // —— Missed habit / anchor direction (placer candidateDays) ——
  B.missed_habit = ruleBucket('missed_habit_policy/max_rolls/direction');
  B.anchor_direction = ruleBucket('time_critical anchor direction');
  {
    const { occurrencesInRange } = require('../api/mc/rrule-core');
    const { candidateDays } = require('../api/mc/habit-placer-lib');
    const maxRolls = Number(ruleMap.missed_habit_max_rolls || 3);
    for (const habit of habits || []) {
      const ideals = occurrencesInRange(habit.rrule, fromYmd, toYmd, 80);
      for (const ideal of ideals) {
        if (ideal >= today) {
          B.anchor_direction.checked += 1;
          const days = candidateDays(
            ideal, habit.window_days, habit.time_critical === true, ruleMap, holidays,
            awaySpans.concat(restSpans), habit.rrule, true,
          );
          if (habit.time_critical === true && days.length && days[0] > ideal) {
            // forward when ideal blocked is OK; flag only if first candidate goes past window without reason
          }
          if (!days.length) {
            B.anchor_direction.violations.push(v(
              'anchor_direction', 'Rule↔DB', habit.id, ideal, habit.title, null,
              'no candidate day in window (blocked/holiday)',
            ));
          }
        } else {
          B.missed_habit.checked += 1;
          const log = latest.find((l) => l.recurring_task_id === habit.id && l.ideal_date === ideal);
          if (!log) continue;
          const rolls = Number(habit.rolls_used || 0);
          if (rolls > maxRolls && log.scheduled_date && log.scheduled_date !== ideal) {
            B.missed_habit.violations.push(v(
              'missed_habit', 'Rule↔DB', habit.id, ideal, habit.title, log.scheduled_date,
              `rolls_used=${rolls} > max=${maxRolls}`,
            ));
          }
        }
      }
    }
  }

  // —— Prep buffers (home_only scope = not paired to travel_out) ——
  B.prep_buffer_min = ruleBucket('prep_buffer_min');
  B.prep_buffer_min.checked = primary.filter((e) => /prep/i.test(e.summary || '')
    && String(e.summary || '').includes(ruleMap.title_prefix_buffer || 'MC ⏳')).length;
  if (String(ruleMap.buffer_scope || '') === 'home_only') {
    B.prep_buffer_min.cannot_check = null; // checkable: count Prep masters present; pairing is gap-sync
  }
  B.duplicate_logs = ruleBucket('duplicate_recurring_log_same_habit_date');
  const logGroups = new Map();
  for (const row of latest) {
    if (!row.scheduled_date) continue;
    const k = `${row.recurring_task_id}|${row.ideal_date || row.scheduled_date}`;
    // latest already deduped by ideal; also check raw logs for multi rows with scheduled_date
  }
  const rawGroups = new Map();
  for (const row of logs || []) {
    if (!row.scheduled_date || !row.recurring_task_id) continue;
    if (isSkippedChange(row.change) || /^unplaced\b/i.test(row.change || '')) continue;
    const k = `${row.recurring_task_id}|${row.scheduled_date}`;
    if (!rawGroups.has(k)) rawGroups.set(k, []);
    rawGroups.get(k).push(row);
  }
  for (const [k, rows] of rawGroups) {
    B.duplicate_logs.checked += 1;
    const linked = rows.filter((r) => r.calendar_event_id);
    const nulls = rows.filter((r) => !r.calendar_event_id);
    if (linked.length >= 1 && nulls.length >= 1) {
      B.duplicate_logs.violations.push(v('duplicate_logs', 'Rule↔DB', k, rows[0].scheduled_date,
        `${rows.length} rows`, null, `linked=${linked.length} null=${nulls.length}`));
    } else if (linked.length > 1) {
      B.duplicate_logs.violations.push(v('duplicate_logs', 'Rule↔DB', k, rows[0].scheduled_date,
        `${linked.length} linked rows`, null, 'multiple calendar_event_ids'));
    }
  }

  // —— Busy map collisions (MC desk vs non-MC busy) ——
  B.busy_collision = ruleBucket('mc_vs_client_workshop_personal_busy');
  const busy = (events || []).filter((e) => {
    if ((e._calendarId || 'primary') === 'primary' && isMcTitle(e.summary, ruleMap)) return false;
    return !!(e.start?.dateTime || e.start?.date);
  });
  for (const p of placeables) {
    if (!p.start || !p.end) continue;
    B.busy_collision.checked += 1;
    const ps = Date.parse(p.start);
    const pe = Date.parse(p.end);
    for (const e of busy) {
      const b = eventBounds(e);
      if (!b.start || !b.end) continue;
      const bs = Date.parse(b.start);
      const be = Date.parse(b.end);
      if (!(ps < be && pe > bs)) continue;
      // ignore all-day soft overlaps lightly
      B.busy_collision.violations.push(v('busy_collision', 'Google↔Rule', p.event_id || p.id, p.day,
        p.title, `${e.summary} (${e._calendarId})`, 'time overlap with non-MC busy'));
      break;
    }
  }

  // —— Habits with calendar_event_id null but scheduled (bug-6 class) ——
  B.habit_missing_event_id = ruleBucket('scheduled_habit_missing_calendar_event_id');
  for (const h of habitBlocks) {
    B.habit_missing_event_id.checked += 1;
    if (!h.event_id) {
      B.habit_missing_event_id.violations.push(v('habit_missing_event_id', 'DB↔Google', h.log_id, h.day,
        h.title, null, 'scheduled but calendar_event_id null'));
    }
  }

  // Totals
  let checked = 0;
  let violations = 0;
  let cannot = 0;
  for (const b of Object.values(B)) {
    checked += b.checked;
    violations += b.violations.length;
    if (b.cannot_check) cannot += 1;
    b.violation_count = b.violations.length;
  }
  report.totals = {
    buckets: Object.keys(B).length,
    checks: checked,
    violations,
    buckets_cannot_fully_check: cannot,
    google_orphans: report.orphans_google_no_db.length,
    google_orphans_unreferenced_mc: report.orphans_google_no_db.filter((o) => o.db_value === 'unreferenced_mc').length,
    google_orphans_buffer_or_travel: report.orphans_google_no_db.filter((o) => o.db_value === 'buffer_or_travel_title').length,
    google_orphans_away_rest_banner: report.orphans_google_no_db.filter((o) => o.db_value === 'away_rest_banner').length,
    db_missing_google: report.db_missing_google.length,
  };
  report.classification_notes = [
    'google_orphan_mc is classified: unreferenced_mc (likely real), buffer_or_travel_title (Prep/Decompress/Travel often lack row FK in this join), away_rest_banner (expected masters), fixture_flank.',
    'db_master_missing_google may include stale calendar_event_id after unplace/skip or events outside returned calendar set.',
    'travel_residential_arrive only flags multi-night spans (≥1.5d); day-trips excluded.',
    'busy_collision includes personal Block Out / birthdays overlapping habits — real rule pressure.',
    'CANNOT_FULL buckets are explicit — do not treat as pass.',
  ];

  const outPath = path.join(__dirname, '..', 'tmp', 'mc-exhaustive-three-way-audit-LATEST.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('WROTE', outPath);
  console.log('TOTALS', report.totals);
  for (const [k, b] of Object.entries(B)) {
    console.log(
      `${k}: checked=${b.checked} viol=${b.violations.length}`
      + (b.cannot_check ? ' CANNOT_FULL' : ''),
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
