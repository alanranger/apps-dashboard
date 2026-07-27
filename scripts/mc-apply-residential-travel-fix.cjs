/**
 * Apply residential travel retime + middle-day AWAY sync (local, uses .env.local).
 * node scripts/mc-apply-residential-travel-fix.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { travelGcalTitle, travelGcalLocation, travelGcalDescription } = require('../api/mc/gcal-title-lib');
const { planTravelRegenerate } = require('../api/mc/travel-regenerate-lib');
const { runRuleEventMasterSync } = require('../api/mc/rule-event-masters-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

async function main() {
  const dry = process.argv.includes('--dry-run');
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
  const rosedale = (plan.linked || []).filter((c) => /rosedale|david ward|post processing/i.test(`${c.venue} ${c.title}`));
  const unmatchedR = (plan.unmatched || []).filter((c) => /rosedale|ward/i.test(JSON.stringify(c)));
  console.log(JSON.stringify({
    changes: (plan.changes || []).length,
    linked: (plan.linked || []).length,
    rosedale,
    unmatchedR,
    sample: (plan.changes || []).slice(0, 3).map((c) => ({
      venue: c.venue,
      out: { from: c.out.from, to: c.out.to },
      back: { from: c.back.from, to: c.back.to },
      drive: c.drive_minutes,
    })),
  }, null, 2));

  if (dry) return;

  const prefixes = {
    travel: ruleMap.title_prefix_travel || 'MC 🚗',
    buffer: ruleMap.title_prefix_buffer || 'MC ⏳',
  };
  const applied = [];
  for (const row of plan.changes || []) {
    const outPatch = {
      workshop_start: row.workshop_live_start,
      workshop_row_key: row.workshop_row_key,
      workshop_title: row.title,
      drive_minutes_used: row.drive_minutes,
      starts_at: row.out.to.starts_at,
      ends_at: row.out.to.ends_at,
    };
    const backPatch = {
      workshop_start: row.workshop_live_start,
      workshop_row_key: row.workshop_row_key,
      workshop_title: row.title,
      drive_minutes_used: row.drive_minutes,
      starts_at: row.back.to.starts_at,
      ends_at: row.back.to.ends_at,
    };
    await sb(`travel_blocks?id=eq.${row.out.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: outPatch,
    });
    await sb(`travel_blocks?id=eq.${row.back.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: backPatch,
    });

    const outDb = (blocks || []).find((b) => b.id === row.out.id) || {};
    const backDb = (blocks || []).find((b) => b.id === row.back.id) || {};
    const outBlock = {
      block_type: 'travel_out',
      venue_name: row.venue,
      workshop_title: row.title,
      leg_from: outDb.leg_from,
      leg_to: outDb.leg_to,
      drive_minutes_used: row.drive_minutes ?? outDb.drive_minutes_used,
    };
    const backBlock = {
      block_type: 'travel_back',
      venue_name: row.venue,
      workshop_title: row.title,
      leg_from: backDb.leg_from,
      leg_to: backDb.leg_to,
      drive_minutes_used: row.drive_minutes ?? backDb.drive_minutes_used,
    };
    const outTitle = travelGcalTitle(outBlock, prefixes);
    const backTitle = travelGcalTitle(backBlock, prefixes);

    if (row.out.calendar_event_id && row.out.times_changed) {
      await patchPrimaryEvent(row.out.calendar_event_id, {
        summary: outTitle,
        location: travelGcalLocation(outBlock),
        description: travelGcalDescription(outBlock),
        startIso: row.out.to.starts_at,
        endIso: row.out.to.ends_at,
      });
      await verifyPrimaryEvent(row.out.calendar_event_id, {
        summary: outTitle,
        startIso: row.out.to.starts_at,
        endIso: row.out.to.ends_at,
      });
    }
    if (row.back.calendar_event_id && row.back.times_changed) {
      await patchPrimaryEvent(row.back.calendar_event_id, {
        summary: backTitle,
        location: travelGcalLocation(backBlock),
        description: travelGcalDescription(backBlock),
        startIso: row.back.to.starts_at,
        endIso: row.back.to.ends_at,
      });
      await verifyPrimaryEvent(row.back.calendar_event_id, {
        summary: backTitle,
        startIso: row.back.to.starts_at,
        endIso: row.back.to.ends_at,
      });
    }
    applied.push({ venue: row.venue, out: row.out.to, back: row.back.to });
  }

  const masters = await runRuleEventMasterSync(sb, { writeGcal: true, weeks: 52 });
  console.log(JSON.stringify({
    applied_count: applied.length,
    applied: applied.filter((a) => /rosedale/i.test(a.venue)),
    away: masters.away,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
