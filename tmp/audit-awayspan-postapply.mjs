/**
 * Day-by-day post-apply audit for away-span set.
 * Simulates applying spike amendments + bumps on top of live diary; asserts per trip.
 * No calendar writes.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const {
  isoToLondonDate, isoToLondonMinutes, addDays, ruleMapFromRows, bankHolidaySet,
} = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks, requiredGapMins, dayCapLimits, londonYmdHmToUtcMs,
} = require('../api/mc/habit-placer-lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { isMcBlock } = require('../api/mc/rule-breach-lib.js');

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

const TRIPS = [
  { name: 'David Ward / Rosedale', start: '2026-08-03', end: '2026-08-06', kind: 'residential' },
  { name: 'Surprise View overnight', start: '2026-08-15', end: '2026-08-16', kind: 'cascade' },
  { name: 'Hartland Quay', start: '2026-09-04', end: '2026-09-06', kind: 'cascade' },
  { name: 'Saltburn / Ellerby', start: '2026-09-10', end: '2026-09-13', kind: 'cascade' },
  { name: 'LD Sep Bassenthwaite', start: '2026-09-18', end: '2026-09-20', kind: 'residential' },
  { name: 'Snowdonia Capel Curig', start: '2026-09-26', end: '2026-09-27', kind: 'residential' },
  { name: 'Dorset Wareham', start: '2026-10-02', end: '2026-10-04', kind: 'residential' },
  { name: 'Wales Lake Vyrnwy', start: '2026-10-10', end: '2026-10-11', kind: 'residential' },
  { name: 'Cumbria Lake District', start: '2026-11-13', end: '2026-11-15', kind: 'residential' },
  { name: 'Norfolk Blakeney', start: '2026-11-20', end: '2026-11-22', kind: 'residential' },
  { name: 'Jan LD B5291', start: '2027-01-21', end: '2027-01-24', kind: 'residential' },
];

const spike = JSON.parse(
  fs.readFileSync(path.join(root, 'tmp/habit-placer-spike-2026-07-26.json'), 'utf8'),
);

async function main() {
  const rulesRows = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rulesRows);
  const from = '2026-07-26';
  const to = '2027-01-31';
  const holidays = bankHolidaySet(2026, 2027);
  const { hard: hardCap } = dayCapLimits(ruleMap);

  const travelBlocks = await sb(
    'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key,calendar_event_id'
    + '&block_type=in.(travel_out,travel_back)'
    + `&starts_at=gte.${from}T00:00:00Z&starts_at=lte.${to}T23:59:59Z`,
  );
  const awaySpans = awaySpansFromTravelBlocks(travelBlocks || []);

  const dwBack = (travelBlocks || []).find(
    (b) => b.block_type === 'travel_back' && /Rosedale|David Ward/i.test(`${b.venue_name} ${b.workshop_title}`),
  );

  if (!gcalConfigured()) throw new Error('GCAL required');
  const { events } = await fetchHorizonEvents(
    new Date(`${from}T00:00:00Z`).toISOString(),
    new Date(`${to}T23:59:59Z`).toISOString(),
  );

  const tasks = await sb(
    'tasks?select=display_id,title,state,scheduled_start,scheduled_end,calendar_event_id,'
    + 'depends_on:depends_on_task_id(display_id)'
    + '&scheduled_start=not.is.null'
    + `&scheduled_start=gte.${from}T00:00:00Z`
    + `&scheduled_start=lte.${to}T23:59:59Z`
    + '&state=not.in.(done,verified,wont_do,superseded)',
  );

  const habitTitles = new Set(
    ((await sb('recurring_tasks?select=title&active=eq.true')) || [])
      .map((h) => String(h.title || '').toLowerCase().replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  );
  function isHabitTitle(summary) {
    const s = String(summary || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s) return false;
    for (const t of habitTitles) {
      if (s === t || s.includes(t)) return true;
    }
    return false;
  }

  // Build post-apply habit blocks: start from Primary timed non-MC events, apply MOVEs/DELETEs
  const byEvent = new Map();
  for (const e of events || []) {
    const cal = e._calendarId || e.calendarId || 'primary';
    if (cal !== 'primary') continue;
    if (!e.id || !e.start?.dateTime) continue;
    if (isMcBlock(e)) continue;
    if (!isHabitTitle(e.summary)) continue;
    byEvent.set(e.id, {
      id: e.id,
      summary: e.summary || '',
      startIso: new Date(e.start.dateTime).toISOString(),
      endIso: new Date(e.end?.dateTime || e.start.dateTime).toISOString(),
      kind: 'habit',
    });
  }

  const amendments = (spike.amendments || []).filter((a) => a.action !== 'KEEP');
  const changedEventIds = new Set();
  for (const a of amendments) {
    if (a.action === 'DELETE' && a.calendar_event_id) {
      byEvent.delete(a.calendar_event_id);
      changedEventIds.add(a.calendar_event_id);
    }
    if (a.action === 'MOVE' && a.calendar_event_id) {
      byEvent.set(a.calendar_event_id, {
        id: a.calendar_event_id,
        summary: a.title,
        startIso: a.startIso,
        endIso: a.endIso,
        kind: 'habit',
        moved: true,
      });
      changedEventIds.add(a.calendar_event_id);
    }
  }

  // Tasks post-bump
  const taskById = new Map((tasks || []).map((t) => [Number(t.display_id), {
    display_id: Number(t.display_id),
    title: t.title,
    startIso: t.scheduled_start,
    endIso: t.scheduled_end,
    depends_on: t.depends_on?.display_id ?? null,
  }]));
  for (const b of spike.task_bumps || []) {
    if (b.unplaced || !b.new_start) continue;
    const t = taskById.get(Number(b.display_id));
    if (!t) continue;
    t.startIso = b.new_start;
    t.endIso = b.new_end;
    t.bumped = true;
  }
  // Remedial audit bumps (post-spike)
  const remedial = [
    { id: 13, start: '2026-08-09T08:00:00.000Z', end: '2026-08-09T08:30:00.000Z' },
    { id: 2, start: '2026-08-09T08:30:00.000Z', end: '2026-08-09T09:15:00.000Z' },
    { id: 1, start: '2026-08-09T09:15:00.000Z', end: '2026-08-09T10:15:00.000Z' },
    { id: 51, start: '2026-08-17T08:00:00.000Z', end: '2026-08-17T09:00:00.000Z' },
  ];
  for (const r of remedial) {
    const t = taskById.get(r.id);
    if (!t) continue;
    t.startIso = r.start;
    t.endIso = r.end;
    t.bumped = true;
  }

  const habitBlocks = [...byEvent.values()];
  const taskBlocks = [...taskById.values()];

  function dayInside(day, start, end) {
    return day >= start && day <= end;
  }

  function blocksOnDay(day) {
    const habits = habitBlocks.filter((b) => isoToLondonDate(b.startIso) === day);
    const tsk = taskBlocks.filter((b) => isoToLondonDate(b.startIso) === day);
    return { habits, tasks: tsk };
  }

  const tripReports = [];
  for (const trip of TRIPS) {
    const fails = [];
    const notes = [];
    const daysChanged = [];

    // Away days: no habit/task
    for (let d = trip.start; d <= trip.end; d = addDays(d, 1)) {
      const { habits, tasks: tsk } = blocksOnDay(d);
      // Exclude travel-looking titles? All Primary timed non-MC count as placement candidates.
      // Travel blocks are usually titled with MC 🚗 — stripped by isMcBlock. Good.
      const habitHits = habits;
      if (habitHits.length) {
        fails.push(`away-day habit on ${d}: ${habitHits.map((h) => `${h.summary} ${hm(h.startIso)}`).join('; ')}`);
      }
      if (tsk.length) {
        fails.push(`away-day task on ${d}: ${tsk.map((t) => `MC-${t.display_id} ${hm(t.startIso)}`).join('; ')}`);
      }
    }

    // Destination flank days (±2): cap, gap, MC overlap
    const flankStart = addDays(trip.start, -2);
    const flankEnd = addDays(trip.end, 2);
    for (let d = flankStart; d <= flankEnd; d = addDays(d, 1)) {
      if (dayInside(d, trip.start, trip.end)) continue;
      const { habits, tasks: tsk } = blocksOnDay(d);
      const blocks = [
        ...habits.map((h) => ({
          title: h.summary, startMs: Date.parse(h.startIso), endMs: Date.parse(h.endIso), kind: 'habit',
        })),
        ...tsk.map((t) => ({
          title: `MC-${t.display_id}`, startMs: Date.parse(t.startIso), endMs: Date.parse(t.endIso), kind: 'task',
          id: t.display_id,
        })),
      ].sort((a, b) => a.startMs - b.startMs);

      let dayMins = 0;
      for (const b of blocks) dayMins += Math.round((b.endMs - b.startMs) / 60000);
      if (dayMins > hardCap) fails.push(`cap ${d}: ${dayMins}m > ${hardCap}m`);

      for (let i = 0; i < blocks.length; i += 1) {
        for (let j = i + 1; j < blocks.length; j += 1) {
          if (overlaps(blocks[i].startMs, blocks[i].endMs, blocks[j].startMs, blocks[j].endMs)) {
            fails.push(`overlap ${d}: ${blocks[i].title} × ${blocks[j].title}`);
          }
        }
      }
      // Gap between consecutive habits only (admin/substantial)
      const habitOnly = blocks.filter((b) => b.kind === 'habit');
      for (let i = 0; i < habitOnly.length - 1; i += 1) {
        const a = habitOnly[i];
        const b = habitOnly[i + 1];
        const gap = (b.startMs - a.endMs) / 60000;
        if (gap >= 0) {
          const need = requiredGapMins(a.title, b.title, ruleMap);
          if (gap < need) fails.push(`gap ${d}: ${a.title} ↔ ${b.title} ${gap}m < ${need}m`);
        }
      }

      const movedHere = blocks.some((b) => {
        if (b.kind === 'habit') {
          const ev = habits.find((h) => h.summary === b.title);
          return ev?.moved;
        }
        return tsk.some((t) => t.bumped && Number(t.display_id) === b.id);
      });
      if (movedHere) daysChanged.push(d);
    }

    // Amendments touching this trip
    const touchAmend = amendments.filter((a) => {
      const from = a.from_startIso ? isoToLondonDate(a.from_startIso) : null;
      const toD = a.startIso ? isoToLondonDate(a.startIso) : null;
      const near = (x) => x && x >= addDays(trip.start, -2) && x <= addDays(trip.end, 2);
      return near(from) || near(toD) || (a.ideal_date && near(a.ideal_date));
    });

    tripReports.push({
      trip: trip.name,
      kind: trip.kind,
      away: `${trip.start}→${trip.end}`,
      ok: fails.length === 0,
      fails,
      amendments_touching: touchAmend.length,
      columns_changed: [...new Set(daysChanged)].sort(),
      notes,
    });
  }

  // Finance deps
  const finance = [21, 22, 23].map((id) => taskById.get(id)).filter(Boolean);
  const financeFails = [];
  const t21 = taskById.get(21);
  const t22 = taskById.get(22);
  const t23 = taskById.get(23);
  if (t21 && t22 && Date.parse(t22.startIso) < Date.parse(t21.endIso)) {
    financeFails.push('MC-22 starts before MC-21 ends');
  }
  if (t21 && t23 && Date.parse(t23.startIso) < Date.parse(t21.endIso)) {
    financeFails.push('MC-23 starts before MC-21 ends');
  }

  // Pending reconcile
  const pendingHabits = await sb(
    "pending_diary_changes?status=eq.pending&change_type=eq.habit_placement&select=related_id,summary&order=related_id",
  );
  const pendingBumps = await sb(
    "pending_diary_changes?status=eq.pending&change_type=eq.task_bump&select=related_id,summary&order=related_id",
  );
  const travelFix = await sb(
    "pending_diary_changes?status=eq.pending&related_id=eq.travel_back_fix:rosedale:2026-08-06&select=related_id,summary",
  );

  const spikeIds = new Set(amendments.map((a) => `habit_place:${a.habit_id}:${a.ideal_date}`));
  const bumpIds = new Set((spike.task_bumps || []).map((b) => `task_bump:MC-${b.display_id}:${b.habit_day}`));
  const remedialIds = [
    'task_bump:audit:MC-13:2026-08-09',
    'task_bump:audit:MC-2:2026-08-09',
    'task_bump:audit:MC-1:2026-08-09',
    'task_bump:audit:MC-51:2026-08-17',
  ];
  const pendingHabitIds = (pendingHabits || []).map((r) => r.related_id);
  const extraPending = pendingHabitIds.filter((id) => !spikeIds.has(id));
  const missingPending = [...spikeIds].filter((id) => !pendingHabitIds.includes(id));
  const pendingBumpIds = (pendingBumps || []).map((r) => r.related_id);
  const applyBumpIds = [...bumpIds, ...remedialIds];

  const out = {
    calendar_writes: 0,
    reconcile: {
      exact_apply_count: spikeIds.size + applyBumpIds.length + 1,
      breakdown: {
        habit_placement: spikeIds.size,
        task_bump_from_spike: bumpIds.size,
        task_bump_audit_remedial: remedialIds.length,
        travel_back_fix: 1,
      },
      why_was_36: 'Claude counted all pending habit_placement (32) incl 3 Dec orphans + 3 bumps + 1 travel. Orphans dismissed → 29+3+1=33 spike set; audit then added 4 remedial bumps → 37.',
      pending_habit_count_now: pendingHabitIds.length,
      pending_bump_count: pendingBumpIds.length,
      travel_fix_pending: (travelFix || []).length === 1,
      extra_pending_vs_spike: extraPending,
      missing_pending_vs_spike: missingPending,
      apply_related_ids: [...spikeIds].sort().concat(applyBumpIds.sort()).concat(['travel_back_fix:rosedale:2026-08-06']),
      sql_filter: "status=pending AND (change_type='habit_placement' OR related_id LIKE 'task_bump:MC-%' OR related_id LIKE 'task_bump:audit:%' OR related_id='travel_back_fix:rosedale:2026-08-06')",
    },
    david_ward_travel_back: {
      db_starts_at: dwBack?.starts_at || null,
      db_ends_at: dwBack?.ends_at || null,
      london: dwBack
        ? `${isoToLondonDate(dwBack.starts_at)} ${hm(dwBack.starts_at)}–${hm(dwBack.ends_at)}`
        : null,
      ok: dwBack
        && isoToLondonDate(dwBack.starts_at) === '2026-08-06'
        && hm(dwBack.starts_at) === '17:00'
        && hm(dwBack.ends_at) === '20:15',
      gcal_still_needs_move: true,
      event_id: dwBack?.calendar_event_id || null,
    },
    finance_deps: { tasks: finance, fails: financeFails, ok: financeFails.length === 0 },
    trips: tripReports,
    trips_ok: tripReports.filter((t) => t.ok).length,
    trips_fail: tripReports.filter((t) => !t.ok).length,
    ignore_detector_noise: {
      change_types: ['rule_breach', 'fixture_block', 'missing_travel_block', 'missed_habit', 'cap_over_target'],
      note: 'Do NOT apply these. Only exception in missing_travel_block: related_id=travel_back_fix:rosedale:2026-08-06',
      fixture_block: 'already applied+verified — do not re-apply',
    },
  };

  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(root, 'tmp/awayspan-reconcile-audit.json'), JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
