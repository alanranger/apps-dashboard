/**
 * Convergence loop: travel → placer → resolve audit → flush → reconcile.
 * Repeats until engine-resolvable work is 0 or maxPasses hit.
 *
 * node scripts/mc-convergence-loop.cjs
 * node scripts/mc-convergence-loop.cjs --max=6
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
const { ruleMapFromRows, bankHolidaySet, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { planTravelRegenerate } = require('../api/mc/travel-regenerate-lib');
const { runHabitPlacerPropose } = require('../api/mc/habit-placer-propose-lib');
const { pushSync, reconcileReport, loadFlags } = require('../api/mc/gcal-auto-sync-lib');
const { travelGcalTitle, travelGcalLocation, travelGcalDescription } = require('../api/mc/gcal-title-lib');
const { upsertPushRow } = require('../api/mc/gcal-push-lib');
const { patchPrimaryEvent } = require('../api/mc/gcal-write-lib');

async function clearPushLock() {
  try {
    await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { value: '0', updated_at: new Date().toISOString() },
    });
  } catch (_) { /* ignore */ }
}

const OUT = path.join(
  'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude',
  'mc-convergence-loop-LATEST.json',
);

function argMax() {
  const a = process.argv.find((x) => x.startsWith('--max='));
  return Math.min(10, Math.max(1, Number(a?.split('=')[1]) || 8));
}

async function applyTravelPass(actor) {
  const today = londonToday();
  const from = addDaysYmd(today, -14);
  const to = addDaysYmd(today, 400);
  const [blocks, rules, venues, gcal] = await Promise.all([
    sb('travel_blocks?select=*&block_type=in.(travel_out,travel_back)&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    sb('venue_drive_times?select=venue_name,minutes_from_home'),
    fetchHorizonEvents(`${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const plan = planTravelRegenerate(blocks || [], gcal.events || [], ruleMap, venues || []);
  const prefixes = {
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  let applied = 0;
  for (const row of plan.changes || []) {
    if (row.out.changed) {
      await sb(`travel_blocks?id=eq.${row.out.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          starts_at: row.out.to.starts_at,
          ends_at: row.out.to.ends_at,
          workshop_start: row.workshop_live_start,
          workshop_row_key: row.workshop_row_key,
          workshop_title: row.title,
          drive_minutes_used: row.drive_minutes,
        },
      });
      const outDb = (blocks || []).find((b) => b.id === row.out.id) || {};
      const outBlock = {
        block_type: 'travel_out',
        venue_name: row.venue,
        workshop_title: row.title,
        leg_from: outDb.leg_from,
        leg_to: outDb.leg_to,
        drive_minutes_used: row.drive_minutes,
      };
      if (row.out.calendar_event_id) {
        await patchPrimaryEvent(row.out.calendar_event_id, {
          startIso: row.out.to.starts_at,
          endIso: row.out.to.ends_at,
          summary: travelGcalTitle(outBlock, prefixes),
          location: travelGcalLocation(outBlock),
          description: travelGcalDescription(outBlock),
        });
      } else {
        await upsertPushRow(sb, {
          related_id: `gcal:travel:${row.out.id}`,
          entity_type: 'travel',
          change_kind: 'move',
          summary: `Move travel_out ${row.venue}`,
          proposed_action: `MOVE travel_out to ${row.out.to.starts_at}`,
          payload: {
            block_id: row.out.id,
            block_type: 'travel_out',
            new_start: row.out.to.starts_at,
            new_end: row.out.to.ends_at,
            venue: row.venue,
            workshop_title: row.title,
            title: travelGcalTitle(outBlock, prefixes),
            actor,
          },
        });
      }
      applied += 1;
    }
    if (row.back.changed) {
      await sb(`travel_blocks?id=eq.${row.back.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          starts_at: row.back.to.starts_at,
          ends_at: row.back.to.ends_at,
          workshop_start: row.workshop_live_start,
          workshop_row_key: row.workshop_row_key,
          workshop_title: row.title,
          drive_minutes_used: row.drive_minutes,
        },
      });
      const backDb = (blocks || []).find((b) => b.id === row.back.id) || {};
      const backBlock = {
        block_type: 'travel_back',
        venue_name: row.venue,
        workshop_title: row.title,
        leg_from: backDb.leg_from,
        leg_to: backDb.leg_to,
        drive_minutes_used: row.drive_minutes,
      };
      if (row.back.calendar_event_id) {
        await patchPrimaryEvent(row.back.calendar_event_id, {
          startIso: row.back.to.starts_at,
          endIso: row.back.to.ends_at,
          summary: travelGcalTitle(backBlock, prefixes),
          location: travelGcalLocation(backBlock),
          description: travelGcalDescription(backBlock),
        });
      }
      applied += 1;
    }
  }
  return {
    changed_count: (plan.changes || []).length,
    applied,
    deferred: (plan.changes || [])
      .filter((c) => c.deferred_for_local_teaching)
      .map((c) => ({ venue: c.venue, mode: c.mode, to: c.out.to })),
  };
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
    sb,
    ruleMap,
    holidays,
    fromYmd,
    toYmd,
    gcalEvents: events || [],
    existingPending: async () => false,
    inserted: [],
    writePending: true,
  });
  const creates = (result.amendments || []).filter((a) => a.action === 'CREATE').length;
  const moves = (result.amendments || []).filter((a) => a.action === 'MOVE').length;
  return {
    proof_ok: !!result.proof?.ok,
    creates,
    moves,
    deletes: (result.amendments || []).filter((a) => a.action === 'DELETE').length,
    habit_db_applied: result.habit_db_applied || 0,
    task_db_applied: result.task_db_applied || 0,
    amendment_counts: result.amendment_counts || {},
  };
}

async function main() {
  const maxPasses = argMax();
  const flags = await loadFlags(sb);
  const report = {
    generated_at: new Date().toISOString(),
    maxPasses,
    flags,
    passes: [],
    stable: false,
    exceptions: [],
  };

  for (let i = 1; i <= maxPasses; i += 1) {
    console.log(`\n=== PASS ${i}/${maxPasses} ===`);
    const travel = await applyTravelPass('cursor-convergence');
    console.log('travel', travel);
    const placer = await placerPass();
    console.log('placer', placer);
    await clearPushLock();
    const flush = await pushSync(sb, 'cursor-convergence', { includeRuleMasters: true });
    await clearPushLock();
    const flushApplied = Array.isArray(flush?.flush?.applied)
      ? flush.flush.applied.length
      : (flush?.flush?.planned || 0);
    console.log('flush applied', flushApplied, 'failed', flush?.flush?.failed?.length || 0);
    const rec = await reconcileReport(sb);
    console.log('reconcile', rec.status_line, 'missing_ids', rec.masters_missing_event_id);

    const engineWork = (travel.applied || 0)
      + (placer.habit_db_applied || 0)
      + (placer.task_db_applied || 0)
      + flushApplied;

    const pass = {
      pass: i,
      travel,
      placer,
      flush_write_count: flushApplied,
      flush_failed: flush?.flush?.failed?.length || 0,
      reconcile: {
        google_matches_db: rec.google_matches_db,
        status_line: rec.status_line,
        mismatch_count: rec.mismatch_count,
        masters_missing_event_id: rec.masters_missing_event_id,
        pending_flush_writes: rec.pending_flush_writes,
        mismatch_sample: (rec.mismatches || []).slice(0, 15),
      },
      engine_work: engineWork,
    };
    report.passes.push(pass);

    const prev = report.passes[report.passes.length - 2];
    if (prev && prev.placer && placer.creates > 0 && prev.placer.deletes > 0
      && placer.creates === prev.placer.deletes) {
      report.stable = false;
      report.stop_reason = 'create_delete_oscillation';
      report.exceptions.push({
        what: 'Placer CREATE/DELETE oscillation',
        reason: 'create_delete_oscillation',
        why_engine_cannot_resolve: 'Stopped to avoid thrash — inspect capacity/cull',
        options: ['Inspect packed days', 'Unplace low-priority habits manually'],
      });
      break;
    }

    if (engineWork === 0 && rec.pending_flush_writes === 0) {
      report.stable = true;
      // Genuine exceptions = remaining mismatches the engine did not clear
      report.exceptions = (rec.mismatches || []).map((m) => ({
        what: m.title || m.kind,
        kind: m.kind,
        reason: m.reason || m.error || (
          (!m.titleOk && 'title_drift')
          || (!m.startOk && 'start_drift')
          || (!m.endOk && 'end_drift')
          || 'mismatch'
        ),
        db_start: m.db_start || null,
        gcal_start: m.gcal_start || null,
        event_id: m.event_id || null,
        why_engine_cannot_resolve: m.reason === 'placed_missing_calendar_event_id'
          ? 'CREATE should have run — re-check placer proof / flush'
          : m.kind === 'google_orphan'
            ? 'Ownership uncertain or delete skipped — needs Alan decision if still present'
            : 'Pinned, title-only drift, or live Google differs outside engine write path',
        options: m.kind === 'google_orphan'
          ? ['Delete from Google', 'Re-link to DB master', 'Leave as personal/non-MC']
          : ['Accept pin/manual', 'Unplace', 'Re-run placer after freeing capacity'],
      }));
      break;
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('\nWrote', OUT);
  console.log('stable', report.stable, 'passes', report.passes.length);
  console.log('exceptions', report.exceptions.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
