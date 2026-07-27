/**
 * Root-cause reconcile after exhaustive audit — DB master ↔ Google mirror.
 * Safe deletes only (managed titles / known habit leftovers). Lists uncertain.
 * node scripts/mc-resolve-audit-root-causes.cjs
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
const { deletePrimaryEvent, insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { ruleMapFromRows, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday, parseDiaryPin, isSkippedChange } = require('../api/mc/diary-lib');
const { classifyEvent, isManagedTitle } = require('../api/mc/gcal-rebuild-lib');
const { hotelReminderLeadDays } = require('../api/mc/travel-coverage-lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { bankHolidaySet } = require('../api/mc/scheduling-rules-lib');
const { pushSync, reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');
const {
  pairTravelBlocks, desiredTravelTimes, pickWorkshop, isTravelWorkshopEvent,
  hasIntermediateTravelLegs,
} = require('../api/mc/travel-regenerate-lib');

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripMcPrefix(summary, ruleMap) {
  let t = String(summary || '');
  for (const p of [
    ruleMap.title_prefix_recurring, ruleMap.title_prefix_travel,
    ruleMap.title_prefix_buffer, ruleMap.title_prefix_deadline,
    ruleMap.title_prefix_fixture, 'MC 🔁', 'MC 🚗', 'MC ⏳', 'MC ⏰', 'MC ⚽',
  ].filter(Boolean)) {
    if (t.includes(p)) t = t.split(p).slice(1).join(p);
  }
  return norm(t.replace(/^[\s—–\-·]+/, ''));
}

(async () => {
  const flags = await loadFlags(sb);
  const today = londonToday();
  const fromYmd = today;
  const toYmd = '2027-01-31';
  const timeMin = `${addDays(fromYmd, -14)}T00:00:00.000Z`;
  const timeMax = `${addDays(toYmd, 1)}T00:00:00.000Z`;
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const habitPrefix = ruleMap.title_prefix_recurring || 'MC 🔁';
  const travelPrefix = ruleMap.title_prefix_travel || 'MC 🚗';
  const bufferPrefix = ruleMap.title_prefix_buffer || 'MC ⏳';
  const deadlinePrefix = ruleMap.title_prefix_deadline || 'MC ⏰';

  console.log('FLAGS', flags);
  console.log('Fetching live Google…');
  const { events } = await fetchHorizonEvents(timeMin, timeMax);
  const byId = new Map((events || []).filter((e) => e?.id).map((e) => [e.id, e]));
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary');

  const [tasks, habits, logs, travel, restDb, awayDb, fixtures, hotels] = await Promise.all([
    sb(`tasks?select=id,calendar_event_id&calendar_event_id=not.is.null&scheduled_start=gte.${fromYmd}T00:00:00Z&scheduled_start=lte.${toYmd}T23:59:59Z`),
    sb('recurring_tasks?select=id,title,active&active=eq.true'),
    sb(`recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,roll_reason,at&order=at.desc&limit=8000`),
    sb(`travel_blocks?select=id,block_type,starts_at,ends_at,calendar_event_id,workshop_title,workshop_row_key,venue_name,workshop_start&starts_at=gte.${fromYmd}T00:00:00Z&starts_at=lte.${toYmd}T23:59:59Z`),
    sb(`rest_day_blocks?status=eq.active&select=id,rest_date,calendar_event_id`),
    sb(`away_day_blocks?status=eq.active&select=id,start_date,end_date,calendar_event_id`),
    sb(`fixture_blocks?select=id,before_event_id,after_event_id,fixture_event_id`),
    sb('workshop_hotels?select=id,workshop_name,check_in_date,free_cancel_until,reminder_event_id,reminder_placed,status,hotel,reminder_lead_days'),
  ]);

  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const habitTitles = new Set((habits || []).map((h) => norm(h.title)));

  const referenced = new Set();
  for (const t of tasks || []) if (t.calendar_event_id) referenced.add(t.calendar_event_id);
  for (const t of travel || []) if (t.calendar_event_id) referenced.add(t.calendar_event_id);
  for (const r of restDb || []) if (r.calendar_event_id) referenced.add(r.calendar_event_id);
  for (const r of awayDb || []) if (r.calendar_event_id) referenced.add(r.calendar_event_id);
  for (const f of fixtures || []) {
    if (f.before_event_id) referenced.add(f.before_event_id);
    if (f.after_event_id) referenced.add(f.after_event_id);
  }
  for (const h of hotels || []) if (h.reminder_event_id) referenced.add(h.reminder_event_id);

  // Latest log per habit|ideal
  const latest = new Map();
  for (const row of logs || []) {
    if (!row.recurring_task_id) continue;
    const ideal = row.ideal_date || row.scheduled_date;
    if (!ideal) continue;
    const k = `${row.recurring_task_id}|${ideal}`;
    if (!latest.has(k)) latest.set(k, row);
  }
  for (const row of latest.values()) {
    if (row.calendar_event_id) referenced.add(row.calendar_event_id);
  }

  const report = {
    generated_at: new Date().toISOString(),
    root_a: {
      stale_links_cleared: [],
      google_deleted: [],
      google_delete_failed: [],
      uncertain_listed: [],
    },
    root_c: {
      duplicate_logs_deleted: [],
      hotels_reminders_created: [],
      hotels_skipped: [],
    },
    travel_checkable: { checked: 0, violations: [] },
    placer: null,
    flush: null,
    reconcile: null,
  };

  // —— A1: clear stale DB links (event gone from live pull) ——
  for (const row of latest.values()) {
    if (!row.calendar_event_id) continue;
    if (byId.has(row.calendar_event_id)) continue;
    await sb(`recurring_log?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { calendar_event_id: null, roll_reason: 'stale_event_id_cleared' },
    });
    report.root_a.stale_links_cleared.push({
      log_id: row.id, event_id: row.calendar_event_id,
      title: habitMap.get(row.recurring_task_id)?.title, ideal: row.ideal_date,
    });
  }
  for (const t of tasks || []) {
    if (!t.calendar_event_id || byId.has(t.calendar_event_id)) continue;
    await sb(`tasks?id=eq.${t.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { calendar_event_id: null },
    });
    report.root_a.stale_links_cleared.push({ task_id: t.id, event_id: t.calendar_event_id });
  }
  for (const t of travel || []) {
    if (!t.calendar_event_id || byId.has(t.calendar_event_id)) continue;
    await sb(`travel_blocks?id=eq.${t.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { calendar_event_id: null },
    });
    report.root_a.stale_links_cleared.push({ travel_id: t.id, event_id: t.calendar_event_id });
  }
  console.log('stale_links_cleared', report.root_a.stale_links_cleared.length);

  // Rebuild referenced after clears
  for (const row of report.root_a.stale_links_cleared) {
    if (row.event_id) referenced.delete(row.event_id);
  }

  // Unplaced logs: any Google habit event matching title with no active scheduled master
  const activeHabitEventIds = new Set(
    [...latest.values()]
      .filter((r) => r.scheduled_date && r.calendar_event_id
        && !isSkippedChange(r.change) && !/^unplaced\b/i.test(r.change || ''))
      .map((r) => r.calendar_event_id),
  );

  async function safeDelete(e, reason) {
    try {
      await deletePrimaryEvent(e.id);
      report.root_a.google_deleted.push({
        id: e.id, summary: e.summary, day: isoToLondonDate(e.start?.dateTime || e.start?.date),
        reason,
      });
      return true;
    } catch (err) {
      report.root_a.google_delete_failed.push({ id: e.id, summary: e.summary, error: err.message });
      return false;
    }
  }

  // —— A2: delete safe orphans + leftover habit blocks for unplaced ——
  for (const e of primary) {
    if (referenced.has(e.id)) continue;
    const summary = e.summary || '';
    const action = classifyEvent(e, referenced, ruleMap);
    const day = isoToLondonDate(e.start?.dateTime || e.start?.date);

    // Habit-titled block whose event id is not an active scheduled master → leftover after unplace
    if (summary.includes(habitPrefix)) {
      const bare = stripMcPrefix(summary, ruleMap);
      const knownHabit = [...habitTitles].some((t) => bare === t || bare.includes(t) || t.includes(bare));
      if (knownHabit && !activeHabitEventIds.has(e.id)) {
        await safeDelete(e, 'unplaced_or_unreferenced_habit');
        continue;
      }
    }

    if (action === 'leave_protected' || action === 'leave_uncertain' || action === 'leave_other') {
      if (action !== 'leave_other') {
        report.root_a.uncertain_listed.push({
          id: e.id, summary, day, action, reason: 'not safe to auto-delete',
        });
      }
      continue;
    }

    // delete_pattern: travel without DB row; buffers without DB row stay listed (regenerated by gap sync)
    if (summary.includes(bufferPrefix)) {
      report.root_a.uncertain_listed.push({
        id: e.id, summary, day, action: 'buffer_no_db_fk',
        reason: 'Prep/Decompress — leave for gap sync; not deleted',
      });
      continue;
    }
    if (summary.includes(travelPrefix) || isManagedTitle(summary, ruleMap)) {
      await safeDelete(e, `classify:${action}`);
    }
  }
  console.log('google_deleted', report.root_a.google_deleted.length,
    'uncertain', report.root_a.uncertain_listed.length);

  // —— C1: duplicate linked logs same habit+scheduled_date ——
  const bySched = new Map();
  for (const row of logs || []) {
    if (!row.scheduled_date || !row.recurring_task_id || !row.calendar_event_id) continue;
    if (isSkippedChange(row.change) || /^unplaced\b/i.test(row.change || '')) continue;
    const k = `${row.recurring_task_id}|${row.scheduled_date}`;
    if (!bySched.has(k)) bySched.set(k, []);
    bySched.get(k).push(row);
  }
  for (const [, rows] of bySched) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const keep = rows[0];
    for (const drop of rows.slice(1)) {
      await sb(`recurring_log?id=eq.${drop.id}`, { method: 'DELETE', prefer: 'return=minimal' });
      report.root_c.duplicate_logs_deleted.push({
        deleted: drop.id, kept: keep.id, event_dropped: drop.calendar_event_id,
        day: drop.scheduled_date,
      });
      // orphan Google for dropped link
      if (drop.calendar_event_id && drop.calendar_event_id !== keep.calendar_event_id) {
        const ev = byId.get(drop.calendar_event_id);
        if (ev) await safeDelete(ev, 'duplicate_log_event');
      }
    }
  }
  console.log('dup_logs_deleted', report.root_c.duplicate_logs_deleted.length);

  // —— C2: hotel deadline reminders (existing policy) ——
  const leadDefault = Number(ruleMap.hotel_deadline_reminder_days || 3);
  for (const h of hotels || []) {
    if (h.reminder_event_id && byId.has(h.reminder_event_id)) continue;
    if (!h.free_cancel_until) {
      report.root_c.hotels_skipped.push({ id: h.id, name: h.workshop_name, reason: 'no_free_cancel_until' });
      continue;
    }
    const lead = hotelReminderLeadDays(h, leadDefault);
    const cancelDay = String(h.free_cancel_until).slice(0, 10);
    const remindDay = addDays(cancelDay, -lead);
    if (remindDay < today) {
      report.root_c.hotels_skipped.push({ id: h.id, name: h.workshop_name, reason: 'remind_day_past', remindDay });
      continue;
    }
    const startIso = `${remindDay}T09:00:00.000Z`;
    const endIso = `${remindDay}T09:30:00.000Z`;
    const title = `${deadlinePrefix} Hotel deadline — ${h.hotel || h.workshop_name} cancel by ${cancelDay}`;
    try {
      const created = await insertPrimaryEvent({ summary: title, startIso, endIso });
      const eid = created?.id || created?.data?.id;
      if (!eid) throw new Error('no event id returned');
      await sb(`workshop_hotels?id=eq.${h.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { reminder_event_id: eid, reminder_placed: true },
      });
      report.root_c.hotels_reminders_created.push({
        hotel_id: h.id, name: h.workshop_name, event_id: eid, remindDay, cancelDay,
      });
    } catch (err) {
      report.root_c.hotels_skipped.push({ id: h.id, name: h.workshop_name, reason: err.message });
    }
  }
  console.log('hotel_reminders', report.root_c.hotels_reminders_created.length);

  // —— D: travel arrive/depart/residential now checkable ——
  const workshops = (events || []).filter(isTravelWorkshopEvent);
  const pairs = pairTravelBlocks(travel || []);
  for (const pair of pairs) {
    report.travel_checkable.checked += 1;
    if (hasIntermediateTravelLegs(pair, travel || [])) continue;
    const match = pickWorkshop(pair, workshops);
    if (!match?.bounds) {
      report.travel_checkable.violations.push({
        pair: pair.out?.id, detail: 'no_workshop_match',
        title: pair.out?.workshop_title,
      });
      continue;
    }
    const drive = Number(pair.out?.drive_minutes_used || 90);
    const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
    const desired = desiredTravelTimes(match.bounds, drive, arriveMin, pair, ruleMap);
    if (!desired) continue;
    if (Math.abs(Date.parse(pair.out.ends_at) - Date.parse(desired.out.ends_at)) > 20 * 60000) {
      report.travel_checkable.violations.push({
        id: pair.out.id, rule: 'arrive_before_or_residential',
        db: pair.out.ends_at, want: desired.out.ends_at, title: pair.out.workshop_title,
        mode: desired.mode,
      });
    }
    if (Math.abs(Date.parse(pair.back.starts_at) - Date.parse(desired.back.starts_at)) > 20 * 60000) {
      report.travel_checkable.violations.push({
        id: pair.back.id, rule: 'depart_at_stated_end',
        db: pair.back.starts_at, want: desired.back.starts_at, title: pair.back.workshop_title,
        mode: desired.mode,
      });
    }
  }
  console.log('travel_checkable', report.travel_checkable.checked, 'viol', report.travel_checkable.violations.length);

  // —— B: re-place with proof gate ——
  console.log('Running placer enforce…');
  const { events: events2 } = await fetchHorizonEvents(timeMin, timeMax);
  const placer = await runHabitPlacerPropose({
    sb, ruleMap, holidays, fromYmd, toYmd,
    gcalEvents: events2 || [],
    existingPending: async () => false,
    inserted: [],
    writePending: true,
  });
  report.placer = {
    proof_ok: placer.proof?.ok,
    proof_fails: (placer.proof?.fails || []).slice(0, 40),
    amendment_counts: placer.amendment_counts,
    habit_db_applied: placer.habit_db_applied,
    task_db_applied: placer.task_db_applied,
    blocked_day_cleared: placer.blocked_day_cleared,
    unplaced: (placer.unplaced || []).length,
  };
  console.log('placer', report.placer);

  console.log('Flushing…');
  const flush = await pushSync(sb, 'cursor', { includeBacklog: false, includeRuleMasters: false });
  report.flush = {
    planned: flush.flush?.planned,
    applied: flush.flush?.applied,
    failed: flush.flush?.failed,
  };
  console.log('flush', report.flush);

  const rec = await reconcileReport(sb);
  report.reconcile = {
    status_line: rec.status_line,
    mismatch_count: rec.mismatch_count,
    google_matches_db: rec.google_matches_db,
  };
  console.log('reconcile', report.reconcile);

  const outPath = path.join(__dirname, '..', 'tmp', 'mc-resolve-audit-root-causes-LATEST.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('WROTE', outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
