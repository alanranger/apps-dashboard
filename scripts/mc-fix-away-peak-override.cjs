/**
 * One-shot: prune bad AWAY GCal events, restore Peak overnight travel_back + locks,
 * re-sync correct middle-day AWAY masters.
 * Usage: node scripts/mc-fix-away-peak-override.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (!m) continue;
  const k = m[1].trim();
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[k]) process.env[k] = v;
}
const { sb } = require('../api/mc/_lib');
const { deletePrimaryEvent, insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');

const BAD_AWAY_IDS = [
  'e68ir5hvb4mqejv9a284fsj09o', // Surprise View false mega-span
  'dfb3hafu37qqgpq6g04dapsmh4', // Gower wrong cascade
  '3bg566deiesfqb6rkngoac2kek', // Kenilworth false
  'thjcpl1fhqt5h6m31vi9mavik4', // Hartland wrong cascade
  'ctn7hqrf88b0qh0dgii8k7klmc', // Priory false
  '85pmat8n1heqiqgar663r9c4rk', // Saltburn wrong cascade dates
];

const PEAK_OUT_KEY = 'gcal:_6lh64ohn6oqj6c9g6hhjeoho64rjacphcopj4oa0etrnebj1dhgmssj1dpjmashecdnmq';
const LOCK_REASON = 'Peak overnight Sat sunset → Rudyard → Sun Roaches sunrise; do not regenerate / re-pair';

async function main() {
  console.log('1) Retire bad away_day_blocks…');
  const badRows = await sb(
    'away_day_blocks?status=eq.active&start_date=gte.2026-08-10&start_date=lte.2026-09-15&select=id,venue_name,calendar_event_id',
  );
  // PostgREST: use or filter by known bad calendar ids
  for (const row of badRows || []) {
    await sb(`away_day_blocks?id=eq.${row.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        status: 'retired',
        calendar_event_id: null,
        updated_at: new Date().toISOString(),
      },
    });
    console.log('  retired', row.venue_name, row.id);
  }

  console.log('2) Delete bad AWAY GCal events…');
  for (const id of BAD_AWAY_IDS) {
    try {
      await deletePrimaryEvent(id);
      console.log('  deleted', id);
    } catch (e) {
      console.log('  skip', id, e.message);
    }
  }

  console.log('3) Create Peak travel_back after Sunrise (08:45–10:45 London)…');
  let backEventId = null;
  try {
    const created = await insertPrimaryEvent({
      summary: 'MC 🚗 Travel back — Peak District Heathers Sunrise → home',
      description: [
        'Driving from → to: ST13 8UA → CV4 9HW',
        'Drive time: 120 minutes',
        'Venue: home',
        'Workshop: Peak District Heathers Sunrise',
        'MANUAL LOCK: Peak overnight chain — do not regenerate',
      ].join('\n'),
      location: 'CV4 9HW',
      startIso: '2026-08-16T08:45:00+01:00',
      endIso: '2026-08-16T10:45:00+01:00',
    });
    backEventId = created?.id || null;
    console.log('  gcal', backEventId);
  } catch (e) {
    console.log('  create failed', e.message);
  }

  console.log('4) Insert/lock Peak travel_back + lock overnight chain…');
  const existingBack = await sb(
    `travel_blocks?block_type=eq.travel_back&workshop_row_key=eq.${encodeURIComponent(PEAK_OUT_KEY)}&select=*`,
  );
  if (!existingBack?.length) {
    await sb('travel_blocks', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        block_type: 'travel_back',
        starts_at: '2026-08-16T07:45:00Z',
        ends_at: '2026-08-16T09:45:00Z',
        venue_name: 'Surprise View / Hathersage',
        workshop_title: 'Peak District Heathers Sunrise',
        workshop_start: '2026-08-16T04:45:00Z',
        workshop_row_key: PEAK_OUT_KEY,
        leg_from: 'ST13 8UA',
        leg_to: 'CV4 9HW',
        drive_minutes_used: 120,
        calendar_event_id: backEventId,
        created_by: 'cursor-peak-override',
        manual_lock: true,
        lock_reason: LOCK_REASON,
      },
    });
  } else {
    await sb(`travel_blocks?id=eq.${existingBack[0].id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        starts_at: '2026-08-16T07:45:00Z',
        ends_at: '2026-08-16T09:45:00Z',
        calendar_event_id: backEventId || existingBack[0].calendar_event_id,
        manual_lock: true,
        lock_reason: LOCK_REASON,
      },
    });
  }

  // Lock Peak out + overnight legs (by time window)
  await sb(
    'travel_blocks?starts_at=gte.2026-08-15T00:00:00Z&starts_at=lt.2026-08-17T00:00:00Z',
    {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { manual_lock: true, lock_reason: LOCK_REASON },
    },
  );

  console.log('5) Re-sync rule masters (correct AWAY middles)…');
  const sync = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 52 });
  console.log(JSON.stringify({ away: sync.away, rest: sync.rest }, null, 2));

  const active = await sb(
    'away_day_blocks?status=eq.active&start_date=gte.2026-08-10&start_date=lte.2026-09-20&select=start_date,end_date,venue_name,calendar_event_id&order=start_date.asc',
  );
  console.log('active away after fix:', active);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
