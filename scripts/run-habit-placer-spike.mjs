#!/usr/bin/env node
/**
 * Offline joint habit placer spike — no Calendar writes.
 * Usage: node scripts/run-habit-placer-spike.mjs
 * Kill switch: exits 1 if §5 proof fails on real data.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

function loadEnvLocal() {
  const p = path.join(root, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

const { sb } = require('../api/mc/_lib.js');
const { ruleMapFromRows, bankHolidaySet, addDays } = require('../api/mc/scheduling-rules-lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { loadScheduleEvents } = require('../api/mc/scheduleCsv.js');
const {
  buildBusyIntervals, placeHabits, buildAmendments, provePlacement, londonYmdHmToUtcMs,
} = require('../api/mc/habit-placer-lib.js');

const IPSWICH = 'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com';

function todayLondon() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function findCleaner(events) {
  const re = /clean|house\s*clean|cleaner|studio\s*clean/i;
  return (events || []).filter((e) => {
    if ((e._calendarId || e.calendarId) !== 'primary') return false;
    return re.test(String(e.summary || ''));
  });
}

function csvToEvents(rows, from, to) {
  return (rows || []).flatMap((r) => {
    if (r.start_date < from || r.start_date > to) return [];
    const st = String(r.start_time || '09:00').slice(0, 5);
    const et = String(r.end_time || '17:00').slice(0, 5);
    const endDate = r.end_date || r.start_date;
    if (!String(r.start_time || '').includes(':')) {
      return [{
        summary: r.title,
        start: { date: r.start_date },
        end: { date: addDays(endDate, 1) },
      }];
    }
    return [{
      summary: r.title,
      start: { dateTime: new Date(londonYmdHmToUtcMs(r.start_date, st)).toISOString() },
      end: { dateTime: new Date(londonYmdHmToUtcMs(endDate, et)).toISOString() },
    }];
  });
}

function fixturesToEvents(rows) {
  return (rows || []).filter((r) => r.status === 'active').map((r) => ({
    summary: r.title || 'Ipswich fixture',
    _calendarId: IPSWICH,
    transparency: 'transparent',
    start: { dateTime: new Date(r.fixture_start).toISOString() },
    end: { dateTime: new Date(r.fixture_end).toISOString() },
  }));
}

async function loadBusyEvents(from, to) {
  if (gcalConfigured()) {
    const timeMin = new Date(`${from}T00:00:00Z`).toISOString();
    const timeMax = new Date(`${to}T23:59:59Z`).toISOString();
    const { events, assessment } = await fetchHorizonEvents(timeMin, timeMax);
    if (!assessment.ok) {
      throw new Error(`calendar health fault: ${assessment.label}`);
    }
    return { events, source: 'gcal', notes: [] };
  }

  const notes = [
    'FLAG: GCAL_* not in local .env — Primary (cleaner / personal) absent from busy map.',
    'Using workshops/lessons CSV + fixture_blocks as partial real busy map.',
  ];
  const [{ events: csvRows }, fixtures] = await Promise.all([
    loadScheduleEvents(),
    sb('fixture_blocks?select=title,fixture_start,fixture_end,status&status=eq.active'),
  ]);
  const events = [...csvToEvents(csvRows, from, to), ...fixturesToEvents(fixtures)];
  return { events, source: 'csv+fixture_blocks', notes };
}

async function main() {
  const from = todayLondon();
  const rulesRows = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rulesRows);
  const weeks = Number(ruleMap.habit_horizon_weeks || 26);
  const to = addDays(from, weeks * 7);
  const holidays = bankHolidaySet(Number(from.slice(0, 4)), Number(to.slice(0, 4)));

  const [habits, deps] = await Promise.all([
    sb('recurring_tasks?select=id,title,priority,duration_min,ideal_time,window_days,time_critical,rrule&active=eq.true'),
    sb('recurring_task_deps?select=habit_id,depends_on_habit_id,dep_type,within_hours'),
  ]);

  const { events, source, notes } = await loadBusyEvents(from, to);
  for (const n of notes) console.log(n);

  const cleanerHits = findCleaner(events);
  console.log('=== Cleaner check (Primary) ===');
  if (source !== 'gcal') {
    console.log('FLAG: cannot verify cleaner without Primary via GCal — Alan says it is real; add GCAL_* locally or ensure the event exists on Primary.');
  } else if (!cleanerHits.length) {
    console.log('FLAG: no Primary event matching clean/cleaner/house-clean — '
      + 'Alan confirmed every-other-Friday cleaner is real; it must be a calendar event (or rule) for the placer to honour it.');
  } else {
    for (const e of cleanerHits.slice(0, 8)) {
      console.log(`  found: ${e.summary} @ ${e.start?.dateTime || e.start?.date}`);
    }
  }

  const clientBusy = buildBusyIntervals(events, ruleMap);
  const { placements, unplaced } = placeHabits(
    habits || [], deps || [], clientBusy.slice(), ruleMap, holidays, from, to,
  );
  const proof = provePlacement(placements, clientBusy, deps || [], ruleMap);
  const amendments = buildAmendments(placements, []); // spike: no existing keyed log yet

  const counts = amendments.reduce((acc, a) => {
    acc[a.action] = (acc[a.action] || 0) + 1;
    return acc;
  }, {});

  const outDir = path.join(root, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `habit-placer-spike-${from}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    from, to, weeks, calendar_writes: 0,
    busy_source: source,
    habit_count: (habits || []).length,
    placement_count: placements.length,
    unplaced_count: unplaced.length,
    amendment_counts: counts,
    cleaner_on_primary: cleanerHits.length > 0,
    cleaner_samples: cleanerHits.slice(0, 5).map((e) => ({
      summary: e.summary, start: e.start?.dateTime || e.start?.date,
    })),
    notes,
    proof,
    unplaced: unplaced.slice(0, 40),
    sample_placements: placements.slice(0, 20),
    sample_amendments: amendments.slice(0, 20),
  }, null, 2));

  console.log('=== Joint habit placer spike ===');
  console.log(`busy source: ${source}`);
  console.log(`horizon: ${from} → ${to} (${weeks}w)`);
  console.log(`habits: ${(habits || []).length}; placements: ${placements.length}; unplaced: ${unplaced.length}`);
  console.log('amendments (vs empty existing):', counts);
  console.log(`busy intervals (client/fixture, MC stripped): ${clientBusy.length}`);
  console.log(`proof ok: ${proof.ok}`);
  if (!proof.ok) {
    console.error('§5 FAILS:');
    for (const f of proof.fails.slice(0, 30)) console.error(' ', f);
    if (proof.fails.length > 30) console.error(`  … +${proof.fails.length - 30}`);
  }
  if (unplaced.length) {
    console.log('unplaced sample:');
    for (const u of unplaced.slice(0, 15)) console.log(`  ${u.ideal_date} ${u.title}`);
  }
  console.log('wrote', outPath);

  if (!proof.ok) {
    console.error('KILL SWITCH: §5 proof failed — stopping');
    process.exit(1);
  }
  console.log('SPIKE GREEN — no calendar writes performed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
