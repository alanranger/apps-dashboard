/**
 * Liveable-diary converge: placer → gap sync → travel → flush → LIVE validate.
 * Spot-checks known-bad weeks. Stops only when liveable OR max passes.
 *
 * node scripts/mc-liveable-converge.cjs
 * node scripts/mc-liveable-converge.cjs --max=4
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const OUT = path.join(
  'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude',
  'mc-liveable-converge-LATEST.json',
);

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { ruleMapFromRows, bankHolidaySet, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { planTravelRegenerate } = require('../api/mc/travel-regenerate-lib');
const { pushSync, reconcileReport } = require('../api/mc/gcal-auto-sync-lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');
const { validateLiveableDiary } = require('../api/mc/liveable-diary-lib');
const { deletePrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { travelGcalTitle, travelGcalLocation, travelGcalDescription } = require('../api/mc/gcal-title-lib');

async function clearPushLock() {
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});
}

async function purgeDuplicateDecompress(events) {
  const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
  const groups = new Map();
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary') continue;
    if (!e.start?.dateTime) continue;
    const t = String(e.summary || '');
    if (!t.includes('MC ⏳') || !/Decompress/i.test(t)) continue;
    // Same title + London day = one decompress only (not exact timestamp).
    const key = `${t}|${isoToLondonDate(e.start.dateTime)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let deleted = 0;
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
    for (const e of group.slice(1)) {
      try {
        await deletePrimaryEvent(e.id);
        deleted += 1;
      } catch (_) { /* ignore */ }
    }
  }
  return deleted;
}

async function applyTravel(actor) {
  const today = londonToday();
  const [blocks, rules, venues, gcal] = await Promise.all([
    sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    sb('venue_drive_times?select=venue_name,minutes_from_home'),
    fetchHorizonEvents(`${addDaysYmd(today, -14)}T00:00:00.000Z`, `${addDaysYmd(today, 400)}T00:00:00.000Z`),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const plan = planTravelRegenerate(blocks || [], gcal.events || [], ruleMap, venues || []);
  const prefixes = { travel: ruleMap.title_prefix_travel || 'MC 🚗' };
  let applied = 0;
  for (const row of plan.changes || []) {
    for (const leg of ['out', 'back']) {
      if (!row[leg].changed) continue;
      await sb(`travel_blocks?id=eq.${row[leg].id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          starts_at: row[leg].to.starts_at,
          ends_at: row[leg].to.ends_at,
          workshop_start: row.workshop_live_start,
          workshop_row_key: row.workshop_row_key,
          workshop_title: row.title,
          drive_minutes_used: row.drive_minutes,
        },
      });
      if (row[leg].calendar_event_id) {
        const db = (blocks || []).find((b) => b.id === row[leg].id) || {};
        const block = {
          block_type: leg === 'out' ? 'travel_out' : 'travel_back',
          venue_name: row.venue,
          workshop_title: row.title,
          leg_from: db.leg_from,
          leg_to: db.leg_to,
          drive_minutes_used: row.drive_minutes,
        };
        await patchPrimaryEvent(row[leg].calendar_event_id, {
          startIso: row[leg].to.starts_at,
          endIso: row[leg].to.ends_at,
          summary: travelGcalTitle(block, prefixes),
          location: travelGcalLocation(block),
          description: travelGcalDescription(block),
        }).catch(() => {});
      }
      applied += 1;
    }
  }
  return { changed: (plan.changes || []).length, applied };
}

async function placerPass() {
  const today = londonToday();
  const fromYmd = today;
  const toYmd = addDays(today, 180);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const holidays = bankHolidaySet(ruleMap);
  const { events } = await fetchHorizonEvents(
    `${addDays(fromYmd, -14)}T00:00:00.000Z`,
    `${toYmd}T23:59:59.000Z`,
  );
  const result = await runHabitPlacerPropose({
    sb, ruleMap, holidays, fromYmd, toYmd,
    gcalEvents: events || [],
    existingPending: async () => false,
    inserted: [],
    writePending: true,
  });
  return {
    proof_ok: !!result.proof?.ok,
    proof_fails: (result.proof?.fails || []).slice(0, 15),
    counts: result.amendment_counts,
    habit_db_applied: result.habit_db_applied || 0,
  };
}

async function validateSpotWeeks() {
  const windows = [
    { label: '3-9 Aug', min: '2026-08-03T00:00:00.000Z', max: '2026-08-10T00:00:00.000Z' },
    { label: '10-17 Aug', min: '2026-08-10T00:00:00.000Z', max: '2026-08-18T00:00:00.000Z' },
  ];
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const out = [];
  for (const w of windows) {
    const [gcal, travel, restDb] = await Promise.all([
      fetchHorizonEvents(w.min, w.max),
      sb(`travel_blocks?select=*&starts_at=gte.${w.min}&starts_at=lt.${w.max}`),
      sb('rest_day_blocks?status=eq.active&select=rest_date,workshop_title'),
    ]);
    const liveable = validateLiveableDiary({
      events: gcal.events || [],
      travelBlocks: travel || [],
      ruleMap,
      restDb: restDb || [],
    });
    out.push({
      label: w.label,
      ok: liveable.ok,
      by_rule: liveable.by_rule,
      violation_count: liveable.violation_count,
      sample: (liveable.violations || []).slice(0, 12),
      health: gcal.assessment,
    });
  }
  return out;
}

async function main() {
  const max = Math.min(6, Math.max(1, Number((process.argv.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 4));
  const report = { generated_at: new Date().toISOString(), max, passes: [], spot: null, stable: false };

  for (let i = 1; i <= max; i += 1) {
    console.log(`\n=== LIVEABLE PASS ${i}/${max} ===`);
    await clearPushLock();
    const placer = await placerPass();
    console.log('placer', placer);
    const gaps = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 26 });
    console.log('gaps', gaps?.gaps);
    const travel = await applyTravel('cursor-liveable');
    console.log('travel', travel);
    await clearPushLock();
    const flush = await pushSync(sb, 'cursor-liveable', { includeRuleMasters: false });
    await clearPushLock();
    const flushApplied = flush?.flush?.applied || 0;
    console.log('flush', flushApplied);

    // Purge duplicate decompress on live primary for full placer horizon
    const today = londonToday();
    const near = await fetchHorizonEvents(
      `${addDaysYmd(today, -7)}T00:00:00.000Z`,
      `${addDaysYmd(today, 200)}T00:00:00.000Z`,
    );
    const purgedDup = await purgeDuplicateDecompress(near.events || []);
    console.log('purged_decompress_dupes', purgedDup);

    const spot = await validateSpotWeeks();
    console.log('spot', spot.map((s) => ({ label: s.label, ok: s.ok, n: s.violation_count, by: s.by_rule })));
    const rec = await reconcileReport(sb);
    console.log('status', rec.status_line);

    const pass = {
      pass: i, placer, travel, flushApplied, purgedDup, spot,
      status_line: rec.status_line,
      diary_liveable: rec.diary_liveable,
      liveable_by_rule: rec.liveable?.by_rule,
      liveable_count: rec.liveable?.violation_count,
    };
    report.passes.push(pass);
    report.spot = spot;

    if (rec.diary_liveable && spot.every((s) => s.ok)) {
      report.stable = true;
      report.exceptions = [];
      break;
    }
    if (placer.habit_db_applied === 0 && flushApplied === 0 && travel.applied === 0 && purgedDup === 0) {
      report.stable = false;
      report.stop_reason = 'no_engine_work_remaining';
      report.exceptions = (rec.liveable?.violations || []).slice(0, 40).map((v) => ({
        what: v.summary || v.a?.summary || v.rule,
        rule: v.rule,
        detail: v,
        why_engine_cannot_resolve: 'No further placer/travel/dedupe write applied',
        options: ['Alan pin/unplace', 'Retire conflicting personal', 'Accept exception'],
      }));
      break;
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\nWrote', OUT);
  console.log('stable', report.stable, 'exceptions', (report.exceptions || []).length);
}

main().catch((e) => { console.error(e); process.exit(1); });
