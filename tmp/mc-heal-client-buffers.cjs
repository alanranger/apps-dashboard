/**
 * Diagnose + heal Caroline client buffers (and any detached).
 * node tmp/mc-heal-client-buffers.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { getPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { runClientBufferReconcile, isClientParent } = require('../api/mc/client-buffer-reconcile-lib');
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
  const carolParents = (events || []).filter((e) => /caroline/i.test(e.summary || ''));
  console.log(JSON.stringify({
    phase: 'gcal_caroline',
    count: carolParents.length,
    rows: carolParents.map((e) => ({
      id: e.id,
      cal: e._calendarId,
      summary: e.summary,
      start: e.start,
      end: e.end,
      status: e.status,
      isClientParent: isClientParent(e),
    })),
  }, null, 2));

  for (const id of ['csm1g0lvgdur0m34iu2inf5l7c']) {
    try {
      const live = await getPrimaryEvent(id);
      console.log(JSON.stringify({ phase: 'old_parent_primary', id, status: live?.status, summary: live?.summary, start: live?.start }));
    } catch (e) {
      console.log(JSON.stringify({ phase: 'old_parent_primary', id, error: e.message, status: e.status }));
    }
  }

  const notes = [];
  const inserted = [];
  const existingPending = async () => false;
  const stats = await runClientBufferReconcile({
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
  console.log(JSON.stringify({ phase: 'reconcile', stats, notes, today, horizonEnd }, null, 2));

  const blocks = await sb(
    "travel_blocks?select=id,block_type,workshop_title,starts_at,ends_at,parent_event_id,calendar_event_id"
    + "&workshop_title=ilike.*caroline*&order=starts_at.asc",
  ) || [];
  console.log(JSON.stringify({ phase: 'travel_blocks_after', blocks }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
