/**
 * Find travel_blocks + gap_buffer_blocks whose calendar_event_id is dead on Primary.
 * Optionally recreate missing Primary events.
 * node tmp/mc-heal-buffer-missing-gcal.cjs [--apply]
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const apply = process.argv.includes('--apply');
const { sb } = require('../api/mc/_lib');
const { getPrimaryEvent, insertPrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { travelGcalTitle, travelGcalDescription } = require('../api/mc/gcal-title-lib');
const { ruleMapFromRows, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

async function deadOrMissing(eventId) {
  if (!eventId) return true;
  try {
    const live = await getPrimaryEvent(eventId);
    return !live || live.status === 'cancelled';
  } catch (e) {
    if (e.status === 404 || e.status === 410) return true;
    throw e;
  }
}

(async () => {
  const from = londonToday();
  const to = addDaysYmd(from, 182);
  const rules = await sb('scheduling_rules?select=key,value') || [];
  const ruleMap = ruleMapFromRows(rules);
  const prefixes = {
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
  };

  const travel = await sb(
    `travel_blocks?select=*&block_type=in.(prep,decompress)`
    + `&starts_at=gte.${from}T00:00:00Z&starts_at=lte.${to}T23:59:59Z&order=starts_at.asc`,
  ) || [];
  const gaps = await sb(
    `gap_buffer_blocks?select=*&status=eq.active`
    + `&day=gte.${from}&day=lte.${to}&order=day.asc`,
  ) || [];

  const travelGhosts = [];
  for (const row of travel) {
    if (!(await deadOrMissing(row.calendar_event_id))) continue;
    travelGhosts.push(row);
  }
  const gapGhosts = [];
  for (const row of gaps) {
    if (!(await deadOrMissing(row.calendar_event_id))) continue;
    gapGhosts.push(row);
  }

  console.log(JSON.stringify({
    phase: 'scan',
    from,
    to,
    travel_ghosts: travelGhosts.length,
    gap_ghosts: gapGhosts.length,
    travel_sample: travelGhosts.slice(0, 20).map((r) => ({
      id: r.id,
      type: r.block_type,
      title: r.workshop_title,
      start: r.starts_at,
      end: r.ends_at,
      evt: r.calendar_event_id,
    })),
    gap_sample: gapGhosts.slice(0, 20).map((r) => ({
      id: r.id,
      day: r.day,
      after: r.after_label,
      start: r.starts_at,
      end: r.ends_at,
      evt: r.calendar_event_id,
    })),
  }, null, 2));

  if (!apply) {
    console.log('dry-run — pass --apply to recreate');
    return;
  }

  let travelFixed = 0;
  let gapFixed = 0;
  for (const row of travelGhosts) {
    const meta = {
      block_type: row.block_type,
      workshop_title: row.workshop_title,
      venue_name: row.venue_name || 'HOME',
    };
    const summary = travelGcalTitle(meta, prefixes);
    const description = travelGcalDescription(meta);
    const created = await insertPrimaryEvent({
      summary,
      startIso: row.starts_at,
      endIso: row.ends_at,
      description,
      location: row.venue_name || 'HOME',
    });
    await sb(`travel_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { calendar_event_id: created.id },
    });
    travelFixed += 1;
    console.log('travel_recreated', row.block_type, row.workshop_title, created.id);
  }

  for (const row of gapGhosts) {
    const summary = `${prefixes.buffer} Decompress — ${row.after_label || 'gap'}`;
    const created = await insertPrimaryEvent({
      summary,
      startIso: row.starts_at,
      endIso: row.ends_at,
      description: `Gap decompress after ${row.after_label || row.after_event_id}`,
      location: null,
    });
    await sb(`gap_buffer_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { calendar_event_id: created.id, updated_at: new Date().toISOString() },
    });
    gapFixed += 1;
    console.log('gap_recreated', row.day, row.after_label, created.id);
  }

  // Finish remaining habit ghosts via pin reconcile path
  const { runPinGcalReconcile } = require('../api/mc/pin-gcal-reconcile-lib');
  const { pushSync } = require('../api/mc/gcal-auto-sync-lib');
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});
  const reconcile = await runPinGcalReconcile(sb, { daysAhead: 182 });
  let applied = 0;
  for (let i = 0; i < 10; i += 1) {
    const res = await pushSync(sb, 'cursor-heal-buffer-missing', {
      includeBacklog: false, includeRuleMasters: false, limit: 25,
    });
    applied += Number(res.flush?.applied || 0);
    if (!res.flush?.more && Number(res.flush?.planned || 0) === 0) break;
  }

  console.log(JSON.stringify({
    phase: 'done',
    travelFixed,
    gapFixed,
    habit_reconcile: reconcile,
    habit_flush_applied: applied,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
