/**
 * Clear placeable MC issues with rules/habits logic.
 * - Dismiss false-positive noise
 * - Create missing travel/buffers → travel_blocks + Google
 * - Auto-move lower-priority overlaps
 * - Sync decompress gap buffers
 * - Leave real exceptions for Alan
 *
 * node scripts/mc-clear-placeable.cjs [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents, gcalConfigured } = require('../api/mc/gcal-lib');
const { ruleMapFromRows, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { desiredTravelTimes } = require('../api/mc/travel-regenerate-lib');
const { insertPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const {
  travelGcalTitle, travelGcalLocation, travelGcalDescription,
} = require('../api/mc/gcal-title-lib');
const { previewConflict, resolveOverlap, resolveDayBlock } = require('../api/mc/conflict-resolve-lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');

const DRY = process.argv.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function londonDay(iso) {
  return isoToLondonDate(iso) || String(iso).slice(0, 10);
}

function eventBounds(e) {
  const startRaw = e.start?.dateTime || (e.start?.date ? `${e.start.date}T09:00:00Z` : null);
  const endRaw = e.end?.dateTime || (e.end?.date ? `${e.end.date}T17:00:00Z` : null);
  if (!startRaw || !String(startRaw).includes('T')) return null;
  const startMs = Date.parse(startRaw);
  const endMs = Date.parse(endRaw || startRaw);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startMs, endMs, startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleHit(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 80;
  const aw = na.split(' ').filter((w) => w.length > 3);
  let hit = 0;
  for (const w of aw) if (nb.includes(w)) hit += 1;
  return aw.length ? Math.round((hit / aw.length) * 70) : 0;
}

async function markPending(id, status) {
  if (DRY) return;
  await sb(`pending_diary_changes?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status,
      resolved_at: new Date().toISOString(),
      resolved_by: 'cursor',
    },
  });
}

async function counts() {
  const rows = await sb('pending_diary_changes?status=eq.pending&select=change_type,reason,related_id,summary,target_date,id,proposed_action');
  const by = {};
  for (const r of rows || []) by[r.change_type] = (by[r.change_type] || 0) + 1;
  return { by, rows: rows || [] };
}

async function dismissNoise(rows) {
  let n = 0;
  const travel = await sb('travel_blocks?select=id,block_type,starts_at,workshop_title,venue_name,workshop_row_key');
  const hasPeakLegs = (travel || []).some((b) => b.block_type === 'travel_leg'
    && /peak|heather|rudyard/i.test(`${b.workshop_title || ''} ${b.venue_name || ''}`));

  for (const r of rows) {
    let why = null;
    if (r.change_type === 'rule_breach' && /residential_or_all_day/i.test(r.reason || '')) {
      why = 'all-day hotel/reminder — not a diary clash';
    }
    if (r.change_type === 'missing_travel_block' && /peak district.*heathers/i.test(r.summary || '') && hasPeakLegs) {
      why = 'Peak overnight multi-leg already exists (false missing_travel)';
    }
    if (r.change_type === 'rule_breach' && r.target_date && r.target_date < '2026-07-27'
      && /decompress|MC-\?/.test(r.summary || '')) {
      why = 'past gap noise';
    }
    if (r.change_type === 'diary_manual_move' && r.target_date && r.target_date < '2026-07-27') {
      why = 'past diary move audit row';
    }
    if (!why) continue;
    console.log(`  dismiss [${r.change_type}] ${r.summary?.slice(0, 70)} — ${why}`);
    await markPending(r.id, 'dismissed');
    n += 1;
  }
  return n;
}

async function driveMin(venues, locationHint, fallback = 90) {
  const loc = norm(locationHint);
  const hit = (venues || []).find((v) => {
    const vn = norm(v.venue_name);
    return vn && loc && (loc.includes(vn) || vn.includes(loc.split(' ')[0]));
  });
  if (hit?.minutes_from_home) return Number(hit.minutes_from_home);
  if (/kenilworth/i.test(locationHint)) return 15;
  if (/gower/i.test(locationHint)) return 195;
  if (/hartland/i.test(locationHint)) return 240;
  if (/coventry|home/i.test(locationHint)) return 20;
  return fallback;
}

async function createTravelPair({
  ev, bounds, drive, arriveMin, ruleMap, rowKey, venue, isHome,
}) {
  const prefixes = {
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  const title = ev.summary || 'Workshop';

  if (isHome) {
    const prepMin = Number(ruleMap.prep_before_start_min || 30);
    const decompMin = Number(ruleMap.decompress_after_task_min || 30);
    const prepEnd = bounds.startMs;
    const prepStart = prepEnd - prepMin * 60000;
    const decStart = bounds.endMs;
    const decEnd = decStart + decompMin * 60000;
    const legs = [
      {
        block_type: 'prep',
        starts_at: new Date(prepStart).toISOString(),
        ends_at: new Date(prepEnd).toISOString(),
        label: 'Prep',
      },
      {
        block_type: 'decompress',
        starts_at: new Date(decStart).toISOString(),
        ends_at: new Date(decEnd).toISOString(),
        label: 'Decompress',
      },
    ];
    for (const leg of legs) {
      const block = {
        block_type: leg.block_type,
        venue_name: venue,
        workshop_title: title,
        drive_minutes_used: 0,
      };
      const summary = travelGcalTitle(block, prefixes);
      if (DRY) {
        console.log(`    would create ${leg.block_type} ${leg.starts_at}–${leg.ends_at}`);
        continue;
      }
      const created = await insertPrimaryEvent({
        summary, startIso: leg.starts_at, endIso: leg.ends_at,
      });
      await verifyPrimaryEvent(created.id, {
        summary, startIso: leg.starts_at, endIso: leg.ends_at,
      });
      await sb('travel_blocks', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          block_type: leg.block_type,
          starts_at: leg.starts_at,
          ends_at: leg.ends_at,
          calendar_event_id: created.id,
          venue_name: venue,
          workshop_title: title,
          workshop_start: bounds.startIso,
          workshop_row_key: rowKey,
          drive_minutes_used: 0,
          created_by: 'cursor',
        },
      });
      await sleep(80);
    }
    return true;
  }

  const fakePair = {
    out: { starts_at: bounds.startIso, venue_name: venue, workshop_title: title },
    back: { starts_at: bounds.endIso, venue_name: venue, workshop_title: title },
  };
  const times = desiredTravelTimes(bounds, drive, arriveMin, fakePair, ruleMap);
  const legs = [
    { block_type: 'travel_out', ...times.out, from: 'home', to: venue },
    { block_type: 'travel_back', ...times.back, from: venue, to: 'home' },
  ];
  for (const leg of legs) {
    const block = {
      block_type: leg.block_type,
      venue_name: venue,
      workshop_title: title,
      leg_from: leg.from,
      leg_to: leg.to,
      drive_minutes_used: drive,
    };
    const summary = travelGcalTitle(block, prefixes);
    if (DRY) {
      console.log(`    would create ${leg.block_type} ${leg.starts_at}–${leg.ends_at} (${drive}m)`);
      continue;
    }
    const created = await insertPrimaryEvent({
      summary,
      startIso: leg.starts_at,
      endIso: leg.ends_at,
      location: travelGcalLocation(block),
      description: travelGcalDescription(block),
    });
    await verifyPrimaryEvent(created.id, {
      summary, startIso: leg.starts_at, endIso: leg.ends_at,
    });
    await sb('travel_blocks', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        block_type: leg.block_type,
        starts_at: leg.starts_at,
        ends_at: leg.ends_at,
        calendar_event_id: created.id,
        venue_name: venue,
        workshop_title: title,
        workshop_start: bounds.startIso,
        workshop_row_key: rowKey,
        leg_from: leg.from,
        leg_to: leg.to,
        drive_minutes_used: drive,
        created_by: 'cursor',
      },
    });
    await sleep(80);
  }
  return true;
}

async function fillMissingTravel(rows, ruleMap, venues, events) {
  let created = 0;
  let failed = 0;
  const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
  const missing = rows.filter((r) => r.change_type === 'missing_travel_block');

  for (const r of missing) {
    const isHome = String(r.related_id || '').startsWith('buffer_block:');
    const day = r.target_date;
    const titleHint = String(r.summary || '').replace(/^Missing (travel|buffers) in horizon:\s*/i, '');
    let best = null;
    let bestScore = 0;
    for (const e of events || []) {
      const b = eventBounds(e);
      if (!b) continue;
      if (day && londonDay(b.startIso) !== day && londonDay(b.endIso) !== day) continue;
      const score = titleHit(titleHint, e.summary);
      if (score > bestScore) {
        bestScore = score;
        best = { e, b };
      }
    }
    if (!best || bestScore < 40) {
      console.log(`  SKIP no GCal match (${bestScore}): ${titleHint.slice(0, 60)}`);
      failed += 1;
      continue;
    }
    const venueMatch = /Location:\s*([^.]+)/i.exec(r.proposed_action || '');
    const venue = (venueMatch?.[1] || best.e.location || titleHint).trim();
    const drive = isHome ? 0 : await driveMin(venues, `${venue} ${titleHint}`);
    console.log(`  CREATE ${isHome ? 'buffers' : 'travel'} for ${day} ${titleHint.slice(0, 50)} (${drive}m) score=${bestScore}`);
    try {
      await createTravelPair({
        ev: best.e,
        bounds: best.b,
        drive,
        arriveMin,
        ruleMap,
        rowKey: String(r.related_id || '').replace(/^(travel_block|buffer_block):/, ''),
        venue,
        isHome,
      });
      await markPending(r.id, 'applied');
      created += 1;
    } catch (e) {
      console.log(`    FAIL: ${e.message}`);
      failed += 1;
    }
  }
  return { created, failed };
}

async function resolveOverlaps(rows) {
  let ok = 0;
  let fail = 0;
  const overlaps = rows.filter((r) => r.change_type === 'rule_breach'
    && (/breach:overlap:/.test(r.related_id || '') || /overlaps/i.test(r.summary || '')));
  console.log(`Overlaps to try: ${overlaps.length}`);
  for (const r of overlaps) {
    if (DRY) {
      console.log(`  would resolve lower: ${r.summary?.slice(0, 70)}`);
      continue;
    }
    try {
      const preview = await previewConflict(sb, r);
      if (!preview.ok || !preview.pair) {
        fail += 1;
        continue;
      }
      await resolveOverlap(sb, r, 'lower', 'cursor');
      console.log(`  moved lower on ${preview.day}: ${r.summary?.slice(0, 60)}`);
      ok += 1;
      await sleep(100);
    } catch (e) {
      console.log(`  overlap fail ${r.target_date}: ${e.message}`);
      fail += 1;
    }
  }
  return { ok, fail };
}

async function easeCaps(rows) {
  let ok = 0;
  let fail = 0;
  const caps = rows.filter((r) => r.change_type === 'rule_breach'
    && (/breach:cap:/.test(r.related_id || '') || /hard_limit|exceeds .*cap/i.test(r.summary || '')));
  for (const r of caps) {
    if (DRY) continue;
    try {
      const preview = await previewConflict(sb, r);
      const movable = (preview.load_blocks || []).filter((b) => b.movable);
      if (!movable.length) {
        fail += 1;
        continue;
      }
      const target = movable[0];
      const result = await resolveDayBlock(sb, r, target.id, 'cursor');
      console.log(`  cap ${r.target_date}: moved ${target.title?.slice(0, 40)} → ${result.day}${result.still_over ? ' (still over)' : ''}`);
      ok += 1;
    } catch (e) {
      console.log(`  cap fail ${r.target_date}: ${e.message}`);
      fail += 1;
    }
  }
  return { ok, fail };
}

async function main() {
  if (!gcalConfigured()) throw new Error('GCAL not configured');
  console.log(DRY ? 'DRY RUN' : 'APPLY');
  let { by, rows } = await counts();
  console.log('Before:', by);

  console.log('\n== Dismiss noise ==');
  const dismissed = await dismissNoise(rows);
  console.log(`Dismissed ${dismissed}`);

  ({ by, rows } = await counts());
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const venues = await sb('venue_drive_times?select=venue_name,postcode,minutes_from_home');
  const timeMin = new Date(Date.now() - 7 * 86400000).toISOString();
  const timeMax = new Date(Date.now() + 520 * 86400000).toISOString();
  const { events } = await fetchHorizonEvents(timeMin, timeMax);

  console.log('\n== Create missing travel/buffers ==');
  const travel = await fillMissingTravel(rows, ruleMap, venues || [], events || []);
  console.log(`Travel created=${travel.created} failed/skipped=${travel.failed}`);

  ({ by, rows } = await counts());

  console.log('\n== Resolve overlaps (move lower priority) ==');
  const overlaps = await resolveOverlaps(rows);
  console.log(`Overlaps ok=${overlaps.ok} fail=${overlaps.fail}`);

  ({ by, rows } = await counts());

  console.log('\n== Ease caps (move longest movable) ==');
  const caps = await easeCaps(rows);
  console.log(`Caps eased=${caps.ok} fail=${caps.fail}`);

  if (!DRY) {
    console.log('\n== Sync gap buffers / rule masters ==');
    try {
      const sync = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 52 });
      console.log('rule masters', {
        rest: sync.rest, away: sync.away, gaps: sync.gaps, fixtures: sync.fixtures,
      });
    } catch (e) {
      console.log('rule master sync error', e.message);
    }
  }

  ({ by, rows } = await counts());
  console.log('\nAfter pending:', by);

  // Real exceptions report
  const real = [];
  for (const r of rows) {
    if (r.change_type === 'hotel_booking_unregistered'
      || r.change_type === 'hotel_cancelled_but_registered'
      || r.change_type === 'hotel_row_unconfirmed') {
      real.push({ kind: 'hotel', why: 'Needs Alan hotel decision', row: r });
      continue;
    }
    if (r.change_type === 'missed_habit') {
      real.push({ kind: 'missed_habit', why: 'Habit occurrence missed — skip or place manually', row: r });
      continue;
    }
    if (r.change_type === 'cap_over_target' || (/breach:cap:/.test(r.related_id || '') || /exceeds .*cap/i.test(r.summary || ''))) {
      real.push({ kind: 'cap', why: 'Day still over hard cap after auto-moves — pick what to cut', row: r });
      continue;
    }
    if (/breach:overlap:/.test(r.related_id || '') || /overlaps/i.test(r.summary || '')) {
      real.push({ kind: 'overlap', why: 'Both blocks fixed/unmovable or no free slot in 14d', row: r });
      continue;
    }
    if (r.change_type === 'missing_travel_block') {
      real.push({ kind: 'missing_travel', why: 'Could not match workshop on GCal or create failed', row: r });
      continue;
    }
    if (r.change_type === 'fixture_block') {
      real.push({ kind: 'fixture', why: 'Fixture flank create/move still pending', row: r });
      continue;
    }
    if (r.change_type === 'rule_breach' && /decompress/i.test(r.reason || '')) {
      real.push({ kind: 'gap', why: 'Tight gap — need manual slide (no legal auto slot)', row: r });
      continue;
    }
    if (r.change_type === 'rule_breach' && /starts_before|ends_after|bank_holiday|non_schedulable/i.test(r.reason || '')) {
      real.push({ kind: 'window', why: 'Outside working window / bank holiday — confirm keep or move', row: r });
      continue;
    }
    if (r.change_type === 'diary_manual_move') {
      // leftover audit — not an exception for Alan
      continue;
    }
    real.push({ kind: r.change_type, why: 'Unresolved', row: r });
  }

  // Collapse gap noise: only keep from today forward, unique days
  const today = '2026-07-27';
  const gapsByDay = new Map();
  const report = [];
  for (const x of real) {
    if (x.kind === 'gap') {
      const d = x.row.target_date || '';
      if (d && d < today) continue;
      if (!gapsByDay.has(d)) gapsByDay.set(d, x);
      continue;
    }
    report.push(x);
  }
  for (const x of gapsByDay.values()) report.push(x);

  console.log('\n========== REAL EXCEPTIONS FOR ALAN ==========');
  const byKind = {};
  for (const x of report) {
    byKind[x.kind] = (byKind[x.kind] || 0) + 1;
  }
  console.log('Counts:', byKind);
  for (const x of report.slice(0, 40)) {
    console.log(`- [${x.kind}] ${x.row.target_date || '—'} | ${x.why}`);
    console.log(`    ${x.row.summary?.slice(0, 100)}`);
  }
  if (report.length > 40) console.log(`... +${report.length - 40} more`);

  fs.writeFileSync(
    path.join(__dirname, '..', 'tmp', 'mc-real-exceptions.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), byKind, report: report.map((x) => ({
      kind: x.kind, why: x.why, date: x.row.target_date, summary: x.row.summary, id: x.row.id,
    })) }, null, 2),
  );
  console.log('\nWrote tmp/mc-real-exceptions.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
