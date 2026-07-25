#!/usr/bin/env node
/**
 * Offline joint habit placer spike — no Calendar writes by default.
 * Usage:
 *   node scripts/run-habit-placer-spike.mjs
 *   node scripts/run-habit-placer-spike.mjs --write-pending
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
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib.js');

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

async function existingPending(changeType, relatedId) {
  const rows = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.${encodeURIComponent(changeType)}`
    + `&related_id=eq.${encodeURIComponent(relatedId)}&limit=1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function main() {
  const writePending = process.argv.includes('--write-pending');
  const from = todayLondon();
  const rulesRows = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rulesRows);
  const weeks = Number(ruleMap.habit_horizon_weeks || 26);
  const to = addDays(from, weeks * 7);
  const holidays = bankHolidaySet(Number(from.slice(0, 4)), Number(to.slice(0, 4)));

  if (!gcalConfigured()) {
    console.error('GCAL_* required for full busy-map spike');
    process.exit(1);
  }

  const timeMin = new Date(`${from}T00:00:00Z`).toISOString();
  const timeMax = new Date(`${to}T23:59:59Z`).toISOString();
  const { events, assessment } = await fetchHorizonEvents(timeMin, timeMax);
  if (!assessment.ok) {
    console.error('calendar health fault:', assessment.label);
    process.exit(1);
  }

  const cleanerHits = findCleaner(events);
  console.log('=== Cleaner check (Primary) ===');
  if (!cleanerHits.length) {
    console.log('FLAG: no Primary Cleaner event matched');
  } else {
    for (const e of cleanerHits.slice(0, 8)) {
      console.log(`  found: ${e.summary} @ ${e.start?.dateTime || e.start?.date}`);
    }
  }

  const blog = (await sb(
    "recurring_tasks?select=title,rrule,cadence_text&title=eq.Publish%20Blog%20Post&limit=1",
  ))?.[0];

  const inserted = [];
  const result = await runHabitPlacerPropose({
    sb,
    ruleMap,
    holidays,
    fromYmd: from,
    toYmd: to,
    gcalEvents: events,
    existingPending,
    inserted,
    writePending,
  });

  const outDir = path.join(root, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `habit-placer-spike-${from}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    from, to, weeks, calendar_writes: 0,
    busy_source: 'gcal',
    write_pending: writePending,
    blog_rrule: blog?.rrule || null,
    blog_cadence: blog?.cadence_text || null,
    admin_gap_min: ruleMap.admin_gap_min,
    decompress_after_task_min: ruleMap.decompress_after_task_min,
    ...result,
    sample_unplaced: result.unplaced.slice(0, 40),
    sample_amendments: result.amendments.slice(0, 30),
    cleaner_on_primary: cleanerHits.length > 0,
  }, null, 2));

  console.log('=== Joint habit placer spike ===');
  console.log('busy source: gcal');
  console.log(`horizon: ${from} → ${to} (${weeks}w)`);
  console.log(`blog: ${blog?.rrule} (${blog?.cadence_text})`);
  console.log(`gaps: admin=${ruleMap.admin_gap_min}m substantial=${ruleMap.decompress_after_task_min}m`);
  console.log(`matched existing: ${result.existing_matched}`);
  console.log(`dated tasks: ${result.dated_tasks_seen} (pinned hard ${result.pinned_busy}, soft ${result.soft_tasks}, bumps ${result.task_bump_count})`);
  console.log('amendments:', result.amendment_counts);
  console.log(`placements: ${result.placements.length}; unplaced: ${result.unplaced.length}`);
  console.log(`proof ok: ${result.proof.ok}`);
  if (writePending) console.log(`pending wrote: ${result.pending_wrote}`);
  if (!result.proof.ok) {
    console.error('§5 FAILS:');
    for (const f of result.proof.fails.slice(0, 30)) console.error(' ', f);
  }
  if (result.unplaced.length) {
    console.log('unplaced:');
    for (const u of result.unplaced.slice(0, 20)) console.log(`  ${u.ideal_date} ${u.title}`);
  }
  console.log('wrote', outPath);

  if (!result.proof.ok) {
    console.error('KILL SWITCH: §5 proof failed — stopping');
    process.exit(1);
  }
  console.log('SPIKE GREEN — no calendar writes performed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
