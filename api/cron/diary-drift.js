/**
 * MC-43 nightly diary-drift detector.
 * Writes pending_diary_changes ONLY — never Google Calendar.
 */
const { json, sb } = require('../mc/_lib');
const { loadScheduleEvents, isHomeBased } = require('../mc/scheduleCsv');
const { holidaySetFromRows, bankHolidaySet } = require('../mc/scheduling-rules-lib');
const { buildRuleBreachProposals, splitMcAndBusy } = require('../mc/rule-breach-lib');
const { gcalConfigured, fetchHorizonEvents, fetchFixtureEvents } = require('../mc/gcal-lib');
const { runFixtureBlockScan } = require('../mc/fixture-coverage-lib');
const { computeMissedProposal } = require('../mc/missed-habit-lib');
const { runHabitPlacerPropose } = require('../mc/habit-placer-propose-lib');
const {
  runMissingTravelBlockScan,
  runStaleDriveTimeScan,
  runStaleTravelVsWorkshopScan,
  runHotelDeadlineGapScan,
  runHorizonEdgeScan,
  runPendingRetirement,
  hotelReminderLeadDays,
} = require('../mc/travel-coverage-lib');

async function insertProposals(proposals, inserted) {
  for (const p of proposals) {
    if (await existingPending(p.change_type, p.related_id)) continue;
    const row = await sb('pending_diary_changes', { method: 'POST', body: { ...p, status: 'pending' } });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    if (id) inserted.push(id);
  }
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}


function lastDueSimple(rrule, today) {
  const parts = {};
  String(rrule || '').split(';').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  });
  const freq = parts.FREQ;
  if (freq === 'WEEKLY' && parts.BYDAY) {
    const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const want = map[String(parts.BYDAY).replace(/^-?\d+/, '').toUpperCase()];
    if (want == null) return null;
    let d = new Date(`${today}T12:00:00Z`);
    for (let i = 0; i < 14; i += 1) {
      const ymd = d.toISOString().slice(0, 10);
      if (d.getUTCDay() === want && ymd < today) return ymd;
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  if (freq === 'MONTHLY' && parts.BYMONTHDAY) {
    const dom = Number(parts.BYMONTHDAY);
    let y = Number(today.slice(0, 4));
    let m = Number(today.slice(5, 7)) - 1;
    for (let i = 0; i < 3; i += 1) {
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const day = Math.min(dom, last);
      const cand = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (cand < today) return cand;
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
    }
  }
  return null;
}

function authOk(req) {
  const secret = process.env.CRON_SECRET || process.env.MC_CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  const q = req.query || {};
  return h === `Bearer ${secret}` || q.force === '1';
}

/**
 * One-time-style re-eval of ALL pending missed_habit rows under the new rule.
 * Only rewrites TIME-CRITICAL rows (their forward-only proposals are now wrong);
 * flexible forward rolls are left as-is. Idempotent — safe to run every cron.
 */
async function reevalPendingMissedHabits(ctx) {
  const {
    sb, inserted, notes, ruleMap, holidays, today, maxRolls,
  } = ctx;
  if (ruleMap.missed_habit_direction !== 'backward_if_time_critical') return;
  let pending = [];
  let habits = [];
  try {
    pending = await sb('pending_diary_changes?status=eq.pending&change_type=eq.missed_habit&select=id,related_id,proposed_action') || [];
    habits = await sb('recurring_tasks?select=id,title,ideal_time,rolls_used,time_critical,rrule,window_days') || [];
  } catch (e) {
    notes.push(`missed_habit_reeval_read_error: ${e.message}`);
    return;
  }
  const byId = new Map(habits.map((h) => [h.id, h]));
  let n = 0;
  for (const p of pending) {
    const m = /^habit:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(p.related_id || '');
    if (!m) continue;
    const habit = byId.get(m[1]);
    if (!habit || habit.time_critical !== true) continue;
    const prop = computeMissedProposal({
      habit, lastDue: m[2], today, ruleMap, holidays, maxRolls,
    });
    if (prop.proposed === p.proposed_action) continue;
    await sb(`pending_diary_changes?id=eq.${p.id}`, {
      method: 'PATCH',
      body: { proposed_action: prop.proposed, reason: prop.reason, urgency: prop.urgency },
    });
    inserted.push(`reeval:${p.id}`);
    n += 1;
  }
  notes.push(`missed_habit_reeval: ${n} time-critical fossil(s) rewritten`);
}

/**
 * Retire stale window rule_breach rows that the current detector would not raise
 * (travel/buffer false-positives from before §7a, or within overrun tolerance).
 * Only touches starts_before / ends_after reasons — never overlaps/caps/residential.
 */
async function retireStaleWindowBreaches(ctx) {
  const {
    sb, inserted, notes, freshRelatedIds,
  } = ctx;
  let pending = [];
  try {
    pending = await sb(
      'pending_diary_changes?status=eq.pending&change_type=eq.rule_breach&select=id,related_id,reason',
    ) || [];
  } catch (e) {
    notes.push(`stale_window_breach_read_error: ${e.message}`);
    return;
  }
  let n = 0;
  for (const p of pending) {
    if (!/starts_before|ends_after/.test(p.reason || '')) continue;
    if (freshRelatedIds.has(p.related_id)) continue;
    await sb(`pending_diary_changes?id=eq.${p.id}`, {
      method: 'PATCH',
      body: {
        status: 'resolved_externally',
        resolved_at: new Date().toISOString(),
        resolved_by: 'detector',
      },
    });
    inserted.push(`retired:${p.id}`);
    n += 1;
  }
  notes.push(`stale_window_breach_retirement: ${n} row(s)`);
}

async function maybeRunFixtureScan(ctx) {
  const {
    sb, existingPending, inserted, notes, ruleMap, today,
  } = ctx;
  try {
    const fixWeeks = Number(ruleMap.fixture_horizon_weeks || 60);
    const fixEnd = addDaysYmd(today, fixWeeks * 7);
    const { fixtures, health } = await fetchFixtureEvents(
      `${today}T00:00:00Z`, `${fixEnd}T23:59:59Z`,
    );
    await runFixtureBlockScan({
      sb,
      existingPending,
      inserted,
      notes,
      fixtures,
      prefix: ruleMap.title_prefix_fixture || 'MC ⚽',
      bufferMin: Number(ruleMap.fixture_buffer_min || 60),
    });
    const feed = health.map((h) => `${h.id}:${h.ok ? h.count : 'FAIL'}`).join(' | ');
    notes.push(`fixture_feed: ${feed} (horizon ${fixWeeks}w → ${fixEnd})`);
  } catch (e) {
    notes.push(`fixture_scan_error: ${e.message}`);
  }
}

async function existingPending(changeType, relatedId) {
  const rows = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.${encodeURIComponent(changeType)}&related_id=eq.${encodeURIComponent(relatedId)}&limit=1`,
  );
  return rows?.[0];
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
  if (!(process.env.MC_SUPABASE_URL && (process.env.MC_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY))) {
    return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  }

  const today = todayYmd();
  const inserted = [];
  const { sources, events, errors } = await loadScheduleEvents();
  const notes = [
    'calendar_writes: 0 (hard constraint)',
    ...sources.map((s) => `source ${s.id}: ${s.ok ? `${s.display} (${s.path})` : `FAIL ${s.error}`}`),
  ];

  // Stale / missing CSV → pending (never silent)
  for (const src of sources) {
    if (!src.ok) {
      const relatedId = `source_missing:${src.id}`;
      if (!(await existingPending('source_missing', relatedId))) {
        const row = await sb('pending_diary_changes', {
          method: 'POST',
          body: {
            change_type: 'source_missing',
            target_date: today,
            summary: `${src.label} missing or unreadable`,
            proposed_action: `Ensure ${src.name} exists in alan-shared-resources/csv on GitHub (auto-pushed ~every 10 min). Local dev override: MC_SCHEDULE_CSV_DIR.`,
            reason: src.error || 'missing',
            urgency: 'high',
            status: 'pending',
            related_id: relatedId,
          },
        });
        const id = Array.isArray(row) ? row[0]?.id : row?.id;
        if (id) inserted.push(id);
      }
      continue;
    }
    if (src.age_days != null && src.age_days > 14) {
      const relatedId = `source_stale:${src.id}:${Math.floor(src.age_days)}`;
      if (!(await existingPending('source_stale', relatedId))) {
        const row = await sb('pending_diary_changes', {
          method: 'POST',
          body: {
            change_type: 'source_stale',
            target_date: today,
            summary: `${src.label} is ${Math.floor(src.age_days)} days old — re-export from Squarespace before trusting this detection run.`,
            proposed_action: `Re-export ${src.name} from Squarespace into alan-shared-resources/csv (auto-pushes to GitHub within ~10 min), then re-run detector.`,
            reason: `mtime ${src.mtime}; threshold 14 days (Alan)`,
            urgency: 'high',
            status: 'pending',
            related_id: relatedId,
          },
        });
        const id = Array.isArray(row) ? row[0]?.id : row?.id;
        if (id) inserted.push(id);
      }
    }
  }

  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  const maxRolls = Number(ruleMap.missed_habit_max_rolls || 3);
  // Scope: the 06:00 cron (no scope) and the Scheduling-tab button call THIS same
  // endpoint. scope=8w → next 8 weeks; scope=full → travel horizon (manual is capped —
  // travel_horizon_weeks can be 104 and will timeout Vercel if unbounded).
  const q = req.query || {};
  const scope = String(q.scope || '').toLowerCase();
  const runMode = q.mode === 'manual' ? 'manual' : 'auto';
  const defaultWeeks = Number(ruleMap.travel_horizon_weeks || 12);
  const habitWeeksCfg = Number(ruleMap.habit_horizon_weeks || 26);
  const manualFullCap = Number(ruleMap.manual_full_horizon_weeks || habitWeeksCfg || 26);
  const cronCap = Number(ruleMap.cron_horizon_cap_weeks || 52);
  let scopeWeeks = null;
  if (scope === '8w') {
    scopeWeeks = 8;
  } else if (scope === 'full') {
    const cap = runMode === 'manual' ? manualFullCap : cronCap;
    scopeWeeks = Math.min(defaultWeeks, Math.max(8, cap));
  } else if (!scope) {
    // Overnight cron default: never run unbounded 104w in one shot.
    scopeWeeks = Math.min(defaultWeeks, Math.max(8, cronCap));
  }
  const horizonWeeks = scopeWeeks || defaultWeeks;
  const horizonEnd = addDaysYmd(today, horizonWeeks * 7);
  if (defaultWeeks > horizonWeeks) {
    notes.push(
      `horizon_capped: travel_horizon_weeks=${defaultWeeks} → ${horizonWeeks}w `
      + `(mode=${runMode}, scope=${scope || 'default'}; raise manual_full_horizon_weeks / cron_horizon_cap_weeks if needed)`,
    );
  }

  // Bank-holiday source health. A holiday input that returns 0 rows over the
  // scheduling horizon is a FAULT (empty is indistinguishable from "no holidays"),
  // not a clean pass — the exact hole that let exclude_bank_holidays sit dead.
  let holidaySet = null;
  let holidaysHealth = 'n/a';
  if (ruleMap.exclude_bank_holidays === 'true') {
    let bhRows = [];
    try {
      bhRows = await sb(`bank_holidays?select=holiday_date&holiday_date=gte.${today}&holiday_date=lte.${horizonEnd}`);
    } catch (e) { notes.push(`bank_holidays_read_error: ${e.message}`); }
    holidaySet = holidaySetFromRows(bhRows);
    if (holidaySet.size === 0) {
      const relatedId = `source_empty:bank_holidays:${today}`;
      if (!(await existingPending('source_empty', relatedId))) {
        const row = await sb('pending_diary_changes', {
          method: 'POST',
          body: {
            change_type: 'source_empty',
            target_date: today,
            summary: 'Bank-holiday source returned 0 rows over the scheduling horizon — exclude_bank_holidays is currently unenforceable.',
            proposed_action: 'Re-seed public.bank_holidays from https://www.gov.uk/bank-holidays.json (england-and-wales division). See sql/018_bank_holidays.sql. Falling back to the computed last-Monday set until fixed.',
            reason: `bank_holidays empty for ${today}..${horizonEnd}; rule exclude_bank_holidays=true`,
            urgency: 'high',
            status: 'pending',
            related_id: relatedId,
          },
        });
        const id = Array.isArray(row) ? row[0]?.id : row?.id;
        if (id) inserted.push(id);
      }
      notes.push('bank_holidays: EMPTY over horizon — source_empty fault raised; using computed fallback');
      holidaySet = null;
      holidaysHealth = 'no data';
    } else {
      notes.push(`bank_holidays: ${holidaySet.size} in horizon (${today}..${horizonEnd})`);
      holidaysHealth = 'ok';
    }
  }

  // Retire pending rows whose underlying condition has since closed.
  await runPendingRetirement({ sb, inserted, notes });
  const homePc = ruleMap.home_postcode || 'CV4 9HW';
  const bufferScope = ruleMap.buffer_scope || 'home_only';
  const prepMin = Number(ruleMap.prep_buffer_min || 30);
  const decompMin = Number(ruleMap.decompress_buffer_min || 30);
  const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
  const travelPrefix = ruleMap.title_prefix_travel || 'MC 🚗';
  const bufferPrefix = ruleMap.title_prefix_buffer || 'MC ⏳';

  const drives = await sb('venue_drive_times?select=venue_name,postcode,minutes_from_home,verified_at');
  const driveHint = (ev) => {
    const blob = `${ev.location_name} ${ev.address} ${ev.postcode}`.toLowerCase();
    const hit = (drives || []).find((d) => blob.includes(String(d.venue_name).toLowerCase().split('/')[0].trim()));
    return hit ? `${hit.minutes_from_home} min from home (${hit.venue_name})` : 'look up drive time in Scheduling → Drive times';
  };

  // CSV events in horizon → travel / buffers for NEW rows only (vs snapshot).
  // First run with empty snapshot = baseline only (no flood of "missing" for whole year).
  const inHorizon = events.filter((e) => e.start_date >= today && e.start_date <= horizonEnd);

  // Full-horizon safety net vs travel_blocks (catches Oct-16 class gaps the snapshot miss).
  await runMissingTravelBlockScan({
    sb,
    existingPending,
    inserted,
    notes,
    inHorizon,
    isHomeBased,
    homePc,
    bufferScope,
    travelPrefix,
    bufferPrefix,
    prepMin,
    decompMin,
    arriveMin,
    driveHint,
    horizonWeeks,
  });
  await runStaleDriveTimeScan({ sb, existingPending, inserted, drives, notes });
  await runHorizonEdgeScan({
    sb,
    existingPending,
    inserted,
    notes,
    today,
    addDaysYmd,
    habitEdgeWeeks: Number(ruleMap.habit_horizon_edge_weeks || 4),
    travelEdgeWeeks: Number(ruleMap.travel_horizon_edge_weeks || 4),
    habitHorizonWeeks: Number(ruleMap.habit_horizon_weeks || 13),
    travelHorizonWeeks: horizonWeeks,
  });
  const currentKeys = new Set(events.map((e) => e.row_key));

  let prev = [];
  try {
    prev = await sb('schedule_csv_snapshot?select=row_key,title,start_date,kind');
  } catch (e) {
    notes.push(`snapshot_read_error: ${e.message}`);
  }
  const prevKeys = new Set((prev || []).map((p) => p.row_key));
  const isBaseline = prevKeys.size === 0;

  if (isBaseline) {
    notes.push(`baseline_snapshot: ${events.length} CSV events recorded; travel/buffer proposals start on next change`);
  } else {
    for (const ev of inHorizon) {
      if (prevKeys.has(ev.row_key)) continue; // not new
      const home = isHomeBased(ev, homePc);
      if (!home) {
        const relatedId = `travel:${ev.row_key}`;
        if (!(await existingPending('missing_travel', relatedId))) {
          const row = await sb('pending_diary_changes', {
            method: 'POST',
            body: {
              change_type: 'missing_travel',
              target_date: ev.start_date,
              summary: `New located event — travel needed: ${ev.title}`,
              proposed_action: `Ensure ${travelPrefix} travel block on ${ev.start_date} (arrive ${arriveMin}m before ${ev.start_time || 'start'}). ${driveHint(ev)}. Location: ${ev.location_name || ev.postcode}. URL: ${ev.url || '—'}. Claude checks diary clashes when applying.`,
              reason: `New in CSV ${ev.source_id} vs previous snapshot; inside ${horizonWeeks}w horizon`,
              urgency: 'normal',
              status: 'pending',
              related_id: relatedId,
            },
          });
          const id = Array.isArray(row) ? row[0]?.id : row?.id;
          if (id) inserted.push(id);
        }
      } else if (bufferScope === 'home_only' || bufferScope === 'all') {
        const relatedId = `buffer:${ev.row_key}`;
        if (!(await existingPending('missing_buffer', relatedId))) {
          const row = await sb('pending_diary_changes', {
            method: 'POST',
            body: {
              change_type: 'missing_buffer',
              target_date: ev.start_date,
              summary: `New home session — buffers: ${ev.title}`,
              proposed_action: `Ensure ${bufferPrefix} prep ${prepMin}m before and decompress ${decompMin}m after on ${ev.start_date} ${ev.start_time || ''}–${ev.end_time || ''}. Home (${homePc}). Claude verifies clashes when applying.`,
              reason: `New in CSV ${ev.source_id}; buffer_scope=${bufferScope}`,
              urgency: 'normal',
              status: 'pending',
              related_id: relatedId,
            },
          });
          const id = Array.isArray(row) ? row[0]?.id : row?.id;
          if (id) inserted.push(id);
        }
      }
    }
  }

  // Cancelled / removed from CSV vs last snapshot
  if (!isBaseline) {
    for (const old of prev || []) {
      if (currentKeys.has(old.row_key)) continue;
      if (old.start_date < today) continue;
      const relatedId = `orphan:${old.row_key}`;
      if (await existingPending('orphaned_block', relatedId)) continue;
      const row = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          change_type: 'orphaned_block',
          target_date: old.start_date,
          summary: `Removed from CSV: ${old.title}`,
          proposed_action: `Remove orphaned ${travelPrefix}/${bufferPrefix} MC blocks for "${old.title}" on ${old.start_date} (no longer in workshop/lesson CSV).`,
          reason: 'Present in previous snapshot, absent from current CSV export',
          urgency: 'normal',
          status: 'pending',
          related_id: relatedId,
        },
      });
      const id = Array.isArray(row) ? row[0]?.id : row?.id;
      if (id) inserted.push(id);
    }
  }

  // Refresh snapshot
  try {
    await sb('schedule_csv_snapshot?kind=eq.lesson', { method: 'DELETE', prefer: 'return=minimal' });
    await sb('schedule_csv_snapshot?kind=eq.workshop', { method: 'DELETE', prefer: 'return=minimal' });
    if (events.length) {
      const srcById = Object.fromEntries(sources.filter((s) => s.ok).map((s) => [s.id, s]));
      const chunk = events.slice(0, 500).map((e) => ({
        row_key: e.row_key,
        title: e.title,
        start_date: e.start_date,
        kind: e.kind,
        location_name: e.location_name || null,
        seen_at: new Date().toISOString(),
        source_mtime: srcById[e.source_id]?.mtime || null,
        source_name: srcById[e.source_id]?.name || null,
      }));
      await sb('schedule_csv_snapshot', {
        method: 'POST',
        body: chunk,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }
    notes.push(`snapshot_refreshed: ${events.length} events from CSV`);
  } catch (e) {
    notes.push(`snapshot_write_error: ${e.message}`);
  }

  // Resolve a holiday set for legality checks (DB source preferred, computed fallback).
  const nowYr = Number(today.slice(0, 4));
  const habitHolidays = (holidaySet && holidaySet.size)
    ? holidaySet
    : bankHolidaySet(nowYr - 1, nowYr + 1);

  const habits = await sb('recurring_tasks?active=eq.true');
  for (const h of habits || []) {
    const lastDue = lastDueSimple(h.rrule, today);
    if (!lastDue || lastDue >= today) continue;
    if (h.last_done && h.last_done >= lastDue) continue;
    const skipRows = await sb(
      `recurring_log?recurring_task_id=eq.${h.id}&ideal_date=eq.${lastDue}&change=like.${encodeURIComponent('skipped%')}&limit=1`,
    );
    if (skipRows?.[0]) continue;

    const relatedId = `habit:${h.id}:${lastDue}`;
    const prop = computeMissedProposal({
      habit: h, lastDue, today, ruleMap, holidays: habitHolidays, maxRolls,
    });

    // Existing rows are re-evaluated by reevalPendingMissedHabits (covers ALL
    // pending occurrences, not just the most recent one this loop computes).
    if (await existingPending('missed_habit', relatedId)) {
      continue;
    }

    if (prop.rollsDelta) {
      await sb(`recurring_tasks?id=eq.${h.id}`, {
        method: 'PATCH',
        body: { rolls_used: Number(h.rolls_used || 0) + prop.rollsDelta, updated_at: new Date().toISOString() },
      });
    }
    const row = await sb('pending_diary_changes', {
      method: 'POST',
      body: {
        change_type: 'missed_habit',
        target_date: lastDue,
        summary: `Missed habit: ${h.title}`,
        proposed_action: prop.proposed,
        reason: prop.reason,
        urgency: prop.urgency,
        status: 'pending',
        related_id: relatedId,
      },
    });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    if (id) inserted.push(id);
  }

  await reevalPendingMissedHabits({
    sb, inserted, notes, ruleMap, holidays: habitHolidays, today, maxRolls,
  });

  const horizon = addDaysYmd(today, 30);
  const hotels = await sb(
    `workshop_hotels?status=eq.active&free_cancel_until=gte.${today}&free_cancel_until=lte.${horizon}&reminder_placed=eq.false&select=*`,
  );
  const fallbackRemind = Number(ruleMap.hotel_deadline_reminder_days || 3);
  for (const hotel of hotels || []) {
    if (!hotel.free_cancel_until) continue;
    if (hotel.status && hotel.status !== 'active') continue;
    const relatedId = `hotel:${hotel.id}:${hotel.free_cancel_until}`;
    if (await existingPending('hotel_deadline', relatedId)) continue;
    const remindDays = hotelReminderLeadDays(hotel, fallbackRemind);
    const daysLeft = Math.round(
      (new Date(`${hotel.free_cancel_until}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000,
    );
    const remindOn = addDaysYmd(hotel.free_cancel_until, -remindDays);
    const urgency = daysLeft <= 7 ? 'high' : 'normal';
    const policyNote = hotel.cancellation_policy === 'release_window'
      ? ' RELEASE decision (not fixed cancel).'
      : '';
    const row = await sb('pending_diary_changes', {
      method: 'POST',
      body: {
        change_type: 'hotel_deadline',
        target_date: hotel.free_cancel_until,
        summary: `Hotel free-cancel ${hotel.free_cancel_until}: ${hotel.hotel || hotel.workshop_name}`,
        proposed_action: `Place ${ruleMap.title_prefix_deadline || 'MC ⏰'} reminder on ${remindOn} (deadline−${remindDays}${hotel.reminder_lead_days != null ? ' override' : hotel.cancellation_window_days != null ? ` from window ${hotel.cancellation_window_days}d` : ''}). Workshop: ${hotel.workshop_name}. Ref: ${hotel.booking_ref || '—'}.${policyNote} Then set reminder_placed=true on hotel row.`,
        reason: 'Free cancel within 30 days; reminder_placed=false',
        urgency,
        status: 'pending',
        related_id: relatedId,
      },
    });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    if (id) inserted.push(id);
  }

  await runHotelDeadlineGapScan({ sb, existingPending, inserted, notes });

  const readable = sources.filter((s) => s.ok).length;
  if (inserted.length === 0) {
    notes.push(
      `no_new_proposals: read ${readable}/2 CSV sources, ${events.length} events, ${inHorizon.length} in ${horizonWeeks}w horizon — not a silent skip`,
    );
  }

  // Part 6: rule_breach — prefer Calendar readonly fetch; POST body still accepted.
  let blocks = [];
  let busyEvents = [];
  let calendarsHealth = 'not configured';
  let mcAdjudicated = 0;
  if (req.method === 'POST') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(data ? JSON.parse(data) : {}));
        req.on('error', reject);
      });
      blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
      busyEvents = Array.isArray(raw?.busy) ? raw.busy : [];
    } catch (e) { /* ignore body parse */ }
  }
  if (!blocks.length && gcalConfigured()) {
    try {
      const timeMin = `${today}T00:00:00Z`;
      const timeMax = `${horizonEnd}T23:59:59Z`;
      const { events: calEvents, health, assessment } = await fetchHorizonEvents(timeMin, timeMax);
      const split = splitMcAndBusy(calEvents, ruleMap);
      blocks = split.mc;
      busyEvents = split.busy;
      calendarsHealth = assessment.label;
      notes.push(`gcal: fetched ${calEvents.length} events → ${blocks.length} MC / ${busyEvents.length} busy`);
      notes.push(`gcal_ids: ${health.map((h) => `${h.id}:${h.ok ? h.count : 'FAIL'}`).join(' | ')}`);
      await runStaleTravelVsWorkshopScan({
        sb,
        existingPending,
        inserted,
        notes,
        gcalEvents: calEvents,
        ruleMap,
        venues: drives,
      });
      // Short busy map / empty calendar is a FAULT — never report as a clean pass.
      if (!assessment.ok) {
        const relatedId = `source_empty:calendars:${today}:${assessment.faults.join(',')}`;
        if (!(await existingPending('source_empty', relatedId))) {
          const row = await sb('pending_diary_changes', {
            method: 'POST',
            body: {
              change_type: 'source_empty',
              target_date: today,
              summary: `Busy-map calendar source fault: ${assessment.label}`,
              proposed_action: 'Expected Primary + Workshops + Lessons + Ipswich Town. Fix GCAL_CALENDAR_IDS / default set, or investigate a calendar that returned zero events over the horizon.',
              reason: `calendars_fault=${assessment.faults.join(';')}`,
              urgency: 'high',
              status: 'pending',
              related_id: relatedId,
            },
          });
          const id = Array.isArray(row) ? row[0]?.id : row?.id;
          if (id) inserted.push(id);
        }
        notes.push(`calendars: FAULT — ${assessment.faults.join(', ')}`);
      }
    } catch (e) {
      calendarsHealth = 'error';
      notes.push(`gcal_fetch_error: ${e.message}`);
    }
  } else if (!blocks.length) {
    calendarsHealth = 'not configured';
    notes.push('rule_breach: skipped (GCAL_* env not set — mint via scripts/gcal-mint-refresh-token.cjs)');
  }

  if (blocks.length) {
    const pinnedIds = new Set();
    const pinned = await sb('tasks?select=display_id&slot_pinned=eq.true');
    for (const t of pinned || []) pinnedIds.add(Number(t.display_id));
    const proposals = buildRuleBreachProposals(blocks, ruleMap, pinnedIds, holidaySet, busyEvents);
    mcAdjudicated = blocks.length;
    await insertProposals(proposals, inserted);
    notes.push(`rule_breach: ${proposals.length} proposal(s) from ${blocks.length} MC block(s)`);
    await retireStaleWindowBreaches({
      sb,
      inserted,
      notes,
      freshRelatedIds: new Set(proposals.map((p) => p.related_id)),
    });
  }

  // Fixture blocks — dedicated season-length fetch (main busy-map horizon is only
  // 12w; the feed runs ~11 months). Informational MC ⚽ proposals only.
  if (gcalConfigured()) {
    await maybeRunFixtureScan({
      sb, existingPending, inserted, notes, ruleMap, today,
    });
  }

  // Joint habit placer → pending amendments (KEEP omitted; no calendar writes).
  if (gcalConfigured()) {
    try {
      const habitWeeks = Number(ruleMap.habit_horizon_weeks || 26);
      const habitTo = addDaysYmd(today, habitWeeks * 7);
      const timeMin = `${today}T00:00:00Z`;
      const timeMax = `${habitTo}T23:59:59Z`;
      const { events: habitEvents, assessment } = await fetchHorizonEvents(timeMin, timeMax);
      if (!assessment.ok) {
        notes.push(`habit_placer: skipped (calendar fault ${assessment.label})`);
      } else {
        const result = await runHabitPlacerPropose({
          sb,
          ruleMap,
          holidays: habitHolidays,
          fromYmd: today,
          toYmd: habitTo,
          gcalEvents: habitEvents,
          existingPending,
          inserted,
          writePending: true,
        });
        notes.push(
          `habit_placer: ${result.amendment_counts.CREATE || 0} CREATE / `
          + `${result.amendment_counts.MOVE || 0} MOVE / `
          + `${result.amendment_counts.KEEP || 0} KEEP / `
          + `${result.amendment_counts.DELETE || 0} DELETE; `
          + `matched ${result.existing_matched}; pending+${result.pending_wrote}; `
          + `unplaced ${result.unplaced.length}; proof=${result.proof.ok}`,
        );
        if (!result.proof.ok) {
          notes.push(`habit_placer_KILL: ${result.proof.fails.slice(0, 5).join(' | ')}`);
        }
      }
    } catch (e) {
      notes.push(`habit_placer_error: ${e.message}`);
    }
  }

  // Record the run so the Scheduling panel can show last-run + coverage + source health.
  const sourcesHealth = {
    csv: sources.map((s) => ({ id: s.id, ok: s.ok, age_days: s.age_days ?? null })),
    holidays: holidaysHealth,
    calendars: calendarsHealth,
  };
  let runId = null;
  try {
    const runRow = await sb('diary_check_runs', {
      method: 'POST',
      body: {
        mode: runMode,
        scope: scope || 'default',
        covered_from: today,
        covered_to: horizonEnd,
        blocks_adjudicated: mcAdjudicated || inHorizon.length,
        inserted_count: inserted.length,
        sources_health: sourcesHealth,
      },
    });
    runId = Array.isArray(runRow) ? runRow[0]?.id : runRow?.id;
  } catch (e) {
    notes.push(`diary_check_run_write_error: ${e.message}`);
  }

  return json(res, 200, {
    ok: true,
    today,
    run_id: runId,
    mode: runMode,
    scope: scope || 'default',
    covered: { from: today, to: horizonEnd, weeks: horizonWeeks },
    inserted: inserted.length,
    ids: inserted,
    sources,
    sources_health: sourcesHealth,
    events_total: events.length,
    events_in_horizon: inHorizon.length,
    errors: errors.map((e) => ({ id: e.id, error: e.error })),
    notes,
    calendar_writes: 0,
  });
};

module.exports = handler;
module.exports.config = { maxDuration: 300 };
