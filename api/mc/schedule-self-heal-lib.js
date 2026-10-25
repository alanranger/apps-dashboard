/**
 * Schedule self-heal — runs every 15 min (gcal-auto-sync) and on every diary check.
 * No proposals, no manual step:
 *   1) fixture rows follow the Ipswich feed (new / moved / renamed; gone → flanks deleted)
 *   2) MC ⚽ flanks repainted at each fixture's current kick-off
 *   3) Primary MC events no DB row claims are deleted (orphan purge)
 *   4) stale fixture proposals closed (automation owns them)
 */
const { fetchFixtureEvents, fetchHorizonEvents } = require('./gcal-lib');
const { runFixtureBlockScan } = require('./fixture-coverage-lib');
const { syncFixtureBuffers } = require('./rule-event-masters-lib');
const { purgeUntiedMcOrphans } = require('./gcal-orphan-purge-lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('./diary-lib');

const PURGE_LOOKBACK_DAYS = 21;
const ORPHAN_MIN_AGE_MINUTES = 30;

async function loadRuleMap(sb, ruleMap) {
  if (ruleMap) return ruleMap;
  return ruleMapFromRows(await sb('scheduling_rules?select=key,value') || []);
}

async function scanFixtures(sb, ruleMap, today, notes) {
  const fixWeeks = Number(ruleMap.fixture_horizon_weeks || 60);
  const fixEnd = addDaysYmd(today, fixWeeks * 7);
  const { fixtures, health } = await fetchFixtureEvents(`${today}T00:00:00Z`, `${fixEnd}T23:59:59Z`);
  if (health.some((h) => !h.ok)) {
    notes.push(`fixture_feed_fault: ${health.map((h) => `${h.id}:${h.ok ? h.count : 'FAIL'}`).join(' | ')} — scan skipped`);
    return fixEnd;
  }
  await runFixtureBlockScan({
    sb, notes, fixtures, bufferMin: Number(ruleMap.fixture_buffer_min || 60),
  });
  return fixEnd;
}

async function fetchPrimaryPool(today, horizonEnd) {
  const snap = await fetchHorizonEvents(
    `${addDaysYmd(today, -PURGE_LOOKBACK_DAYS)}T00:00:00.000Z`,
    `${horizonEnd}T23:59:59.000Z`,
  );
  return snap.events || [];
}

async function dismissFixtureProposals(sb) {
  await sb('pending_diary_changes?status=eq.pending&change_type=in.(fixture_block,fixture_block_retire)', {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status: 'dismissed', resolved_at: new Date().toISOString(), resolved_by: 'schedule_self_heal' },
  });
}

async function runScheduleSelfHeal(sb, { ruleMap = null, notes = [], purgeLimit = 80 } = {}) {
  const today = londonToday();
  const rules = await loadRuleMap(sb, ruleMap);
  const out = { fixtures: null, purge: null };

  const horizonEnd = await scanFixtures(sb, rules, today, notes);
  let pool = await fetchPrimaryPool(today, horizonEnd);

  out.fixtures = await syncFixtureBuffers(sb, rules, { writeGcal: true, events: pool });
  notes.push(`fixture_flanks: ${out.fixtures.rows} active; ${out.fixtures.already_linked_live} ok; `
    + `${out.fixtures.recreated} repainted; ${out.fixtures.failed.length} failed`);
  if (out.fixtures.recreated > 0) pool = await fetchPrimaryPool(today, horizonEnd);

  out.purge = await purgeUntiedMcOrphans(sb, {
    events: pool, limit: purgeLimit, minAgeMinutes: ORPHAN_MIN_AGE_MINUTES,
  });
  notes.push(`orphan_purge: ${out.purge.orphans_found} found; ${out.purge.deleted} deleted; `
    + `${out.purge.remaining} left for next run`);

  if (!out.fixtures.failed.length) await dismissFixtureProposals(sb);
  return out;
}

module.exports = { runScheduleSelfHeal };
