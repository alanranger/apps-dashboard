/**
 * Heal Jackie Private 1-2-1 buffers (8 Sep) + Arsenal League Cup flanks (15 Sep).
 * node tmp/heal-private-and-arsenal-flanks.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { runClientBufferReconcile, isClientParent } = require('../api/mc/client-buffer-reconcile-lib');
const { syncFixtureBuffers } = require('../api/mc/rule-event-masters-lib');
const { ruleMapFromRows, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

(async () => {
  const today = londonToday();
  const horizonEnd = addDaysYmd(today, 56);
  const rules = await sb('scheduling_rules?select=key,value') || [];
  const ruleMap = ruleMapFromRows(rules);
  const prepMin = Number(ruleMap.prep_buffer_min || 30);
  const decompMin = Number(ruleMap.decompress_buffer_min || 30);

  const { events } = await fetchHorizonEvents(`${today}T00:00:00Z`, `${horizonEnd}T23:59:59Z`);
  const privateParents = (events || []).filter((e) => isClientParent(e)
    && /private/i.test(e.summary || ''));
  console.log(JSON.stringify({
    phase: 'private_parents',
    count: privateParents.length,
    rows: privateParents.map((e) => ({
      id: e.id, summary: e.summary, start: e.start?.dateTime, day: isoToLondonDate(e.start?.dateTime),
    })),
  }, null, 2));

  const notes = [];
  const inserted = [];
  const existingPending = async () => false;
  const clientStats = await runClientBufferReconcile({
    sb,
    notes,
    gcalEvents: events,
    prepMin,
    decompMin,
    today,
    horizonEnd,
    existingPending,
    inserted,
    ruleMap,
  });
  console.log(JSON.stringify({ phase: 'client_buffers', clientStats, notes }, null, 2));

  const fixtures = await syncFixtureBuffers(sb, ruleMap, { writeGcal: true, events });
  console.log(JSON.stringify({ phase: 'fixture_buffers', fixtures }, null, 2));

  const arsenal = await sb(
    'fixture_blocks?fixture_event_id=eq.6a8f62f254aa88426515c5ae&select=id,title,fixture_start,fixture_end,before_event_id,after_event_id,status',
  );
  console.log(JSON.stringify({ phase: 'arsenal_row', arsenal }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
