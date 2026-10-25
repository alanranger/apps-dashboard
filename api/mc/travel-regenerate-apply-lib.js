/**
 * Travel follows live GCal workshops:
 * 1) delete orphan travel (parent gone)
 * 2) move existing travel_out/back to live times (direct GCal + DB)
 * 3) create missing travel for uncovered workshops
 * 4) re-sync AWAY / REST masters
 */
const {
  planTravelRegenerate,
  desiredTravelTimes,
  isTravelWorkshopEvent,
  eventBounds,
  titleScore,
} = require('./travel-regenerate-lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');
const { gcalConfigured, fetchHorizonEvents } = require('./gcal-lib');
const { insertPrimaryEvent, patchPrimaryEvent } = require('./gcal-write-lib');
const {
  travelGcalTitle, travelGcalLocation, travelGcalDescription,
} = require('./gcal-title-lib');
const { runWorkshopTravelReconcile } = require('./workshop-travel-reconcile-lib');
const { londonToday, addDaysYmd } = require('./diary-lib');

function boundsOf(e) {
  return eventBounds(e);
}

function driveMinutesForVenue(venue, venues, fallback) {
  const v = String(venue || '').toLowerCase();
  const pc = (String(venue || '').match(/\b([a-z]{1,2}\d{1,2}\s*\d[a-z]{2})\b/i) || [])[1];
  const hit = (venues || []).find((row) => {
    const name = String(row.venue_name || '').toLowerCase();
    const rpc = String(row.postcode || '').toLowerCase().replace(/\s+/g, '');
    if (pc && rpc && rpc === pc.toLowerCase().replace(/\s+/g, '')) return true;
    return v && name && (name.includes(v.split(/[|,]/)[0].trim()) || v.includes(name));
  });
  if (hit?.minutes_from_home) return Number(hit.minutes_from_home);
  const fb = Number(fallback);
  return Number.isFinite(fb) ? fb : 90;
}

function venueFromWorkshop(w) {
  const loc = String(w.location || '');
  const pc = (loc.match(/\b([A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2})\b/i) || [])[1];
  if (pc) return pc.toUpperCase().replace(/\s+/, ' ');
  const sum = String(w.summary || '');
  if (/bluebell/i.test(sum)) return 'Bluebell Woodlands';
  if (/hartland/i.test(sum)) return 'Hartland Quay';
  const part = loc.split(',').map((s) => s.trim()).filter(Boolean);
  return part.find((p) => !/^england$/i.test(p) && !/^united kingdom$/i.test(p)) || part[0] || 'Venue';}

function isLikelyHomeWorkshop(e, homePc) {
  const blob = `${e.summary || ''} ${e.location || ''}`.toLowerCase();
  if (/\bzoom\b|\bonline\b|\b1-2-1\b|\b121\b/.test(blob)) return true;
  if (/hathaway road|composition class|camera course/.test(blob)) return true;
  // Overnight Peak chains are multi-leg — never auto-mint simple out/back.
  if (/heathers?\s+(sunset|sunrise)|hotel rudyard|the roaches/.test(blob)) return true;
  const pc = String(homePc || 'CV4').toLowerCase().slice(0, 3);
  return pc && blob.includes(pc);
}

function isMultiDayWorkshop(bounds) {
  if (!bounds) return false;
  const a = String(bounds.startIso).slice(0, 10);
  const b = String(bounds.endIso).slice(0, 10);
  return a && b && b > a;
}

async function patchBlock(sb, id, patch) {
  await sb(`travel_blocks?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: patch,
  });
}

async function writeTravelGcal(blockMeta, to, venue, title) {
  const block = {
    block_type: blockMeta.block_type,
    venue_name: venue,
    workshop_title: title,
    leg_from: blockMeta.leg_from,
    leg_to: blockMeta.leg_to,
    drive_minutes_used: blockMeta.drive_minutes_used,
  };
  const summary = travelGcalTitle(block, {});
  const description = travelGcalDescription(block);
  const location = travelGcalLocation(block);
  if (blockMeta.calendar_event_id) {
    await patchPrimaryEvent(blockMeta.calendar_event_id, {
      summary,
      description,
      location,
      startIso: to.starts_at,
      endIso: to.ends_at,
    });
    return blockMeta.calendar_event_id;
  }
  const created = await insertPrimaryEvent({
    summary,
    description,
    location,
    startIso: to.starts_at,
    endIso: to.ends_at,
  });
  return created.id;
}

async function applyTravelPlan(sb, plan, blocks, actor, weeks) {
  const applied = [];
  for (const row of plan.linked || []) {
    if (!row.out.changed && !row.back.changed) continue;
    const outRow = (blocks || []).find((b) => b.id === row.out.id) || {};
    const backRow = (blocks || []).find((b) => b.id === row.back.id) || {};
    const outPatch = {
      workshop_start: row.workshop_live_start,
      workshop_row_key: row.workshop_row_key,
      workshop_title: row.title,
      drive_minutes_used: row.drive_minutes,
    };
    const backPatch = { ...outPatch };
    if (row.out.changed) {
      outPatch.starts_at = row.out.to.starts_at;
      outPatch.ends_at = row.out.to.ends_at;
    }
    if (row.back.changed) {
      backPatch.starts_at = row.back.to.starts_at;
      backPatch.ends_at = row.back.to.ends_at;
    }
    if (row.out.times_changed || !row.out.calendar_event_id) {
      const eid = await writeTravelGcal({
        block_type: 'travel_out',
        calendar_event_id: row.out.calendar_event_id,
        leg_from: outRow.leg_from || 'home',
        leg_to: outRow.leg_to || row.venue,
        drive_minutes_used: row.drive_minutes,
      }, row.out.to, row.venue, row.title);
      outPatch.calendar_event_id = eid;
    }
    if (row.back.times_changed || !row.back.calendar_event_id) {
      const eid = await writeTravelGcal({
        block_type: 'travel_back',
        calendar_event_id: row.back.calendar_event_id,
        leg_from: backRow.leg_from || row.venue,
        leg_to: backRow.leg_to || 'home',
        drive_minutes_used: row.drive_minutes,
      }, row.back.to, row.venue, row.title);
      backPatch.calendar_event_id = eid;
    }
    await patchBlock(sb, row.out.id, outPatch);
    await patchBlock(sb, row.back.id, backPatch);
    applied.push({
      title: row.title,
      venue: row.venue,
      workshop_row_key: row.workshop_row_key,
      action: 'moved',
      out_to: row.out.to,
      back_to: row.back.to,
      actor,
    });
  }
  if (applied.length) {
    try {
      const { runRuleEventMasterSync } = require('./rule-event-masters-lib');
      await runRuleEventMasterSync(sb, { writeGcal: true, weeks: weeks || 52 });
    } catch (e) {
      applied.push({ rule_master_sync_error: e.message });
    }
  }
  return applied;
}

async function createMissingWorkshopTravel(ctx) {
  const {
    sb, events, blocks, venues, ruleMap, notes, homePc, today,
  } = ctx;
  const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
  const covered = new Set();
  for (const b of blocks || []) {
    if (b.workshop_row_key) covered.add(b.workshop_row_key);
  }
  const workshops = (events || []).filter(isTravelWorkshopEvent);
  const created = [];
  for (const w of workshops) {
    const rowKey = `gcal:${w.id}`;
    if (covered.has(rowKey)) continue;
    if (isLikelyHomeWorkshop(w, homePc)) continue;
    const b = boundsOf(w);
    if (!b) continue;
    const startDay = String(b.startIso || '').slice(0, 10);
    if (today && startDay && startDay < today) continue;
    // Skip if any travel pair already title-matches this workshop nearby.
    const already = (blocks || []).some((tb) => {
      if (tb.block_type !== 'travel_out') return false;
      return titleScore(tb.workshop_title, w.summary) >= 70
        && Math.abs(Date.parse(tb.workshop_start || tb.starts_at) - b.startMs) / 86400000 <= 90;
    });
    if (already) continue;

    const venue = venueFromWorkshop(w);
    const locBlob = `${venue} ${w.location || ''} ${w.summary || ''}`;
    const multi = isMultiDayWorkshop(b);
    // Only auto-create when we know drive time, or it's a residential multi-day.
    const known = driveMinutesForVenue(locBlob, venues, 0);
    if (!known && !multi) continue;
    const localish = /\b(CV\d|B\d{2})\b/i.test(locBlob);
    const drive = known || (localish ? 40 : 90);
    const pairStub = {
      out: { starts_at: b.startIso, workshop_title: w.summary, venue_name: venue },
      back: { starts_at: b.endIso },
    };
    const guest = /attending/i.test(w.summary || '');
    const desired = desiredTravelTimes(b, drive, arriveMin, pairStub, ruleMap, {
      teachingEvents: workshops,
      excludeEventId: w.id,
      guestOrAttending: guest,
    });
    const outMeta = {
      block_type: 'travel_out',
      venue_name: venue,
      workshop_title: w.summary,
      leg_from: 'home',
      leg_to: venue,
      drive_minutes_used: drive,
    };
    const backMeta = {
      block_type: 'travel_back',
      venue_name: venue,
      workshop_title: w.summary,
      leg_from: venue,
      leg_to: 'home',
      drive_minutes_used: drive,
    };
    const outId = await writeTravelGcal(outMeta, desired.out, venue, w.summary);
    const backId = await writeTravelGcal(backMeta, desired.back, venue, w.summary);
    const base = {
      workshop_start: desired.workshop_start,
      workshop_row_key: rowKey,
      workshop_title: w.summary,
      venue_name: venue,
      drive_minutes_used: drive,
      created_by: 'travel_follow_live',
    };
    await sb('travel_blocks', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        ...base,
        block_type: 'travel_out',
        starts_at: desired.out.starts_at,
        ends_at: desired.out.ends_at,
        calendar_event_id: outId,
        leg_from: 'home',
        leg_to: venue,
      },
    });
    await sb('travel_blocks', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        ...base,
        block_type: 'travel_back',
        starts_at: desired.back.starts_at,
        ends_at: desired.back.ends_at,
        calendar_event_id: backId,
        leg_from: venue,
        leg_to: 'home',
      },
    });
    covered.add(rowKey);
    created.push({ title: w.summary, venue, rowKey, out: desired.out, back: desired.back });
    notes.push(`travel_create: ${w.summary}`);
  }
  return created;
}

/**
 * Full follow-live pass used by cron + POST /api/mc/travel-regenerate.
 */
async function runTravelFollowLive(ctx) {
  const {
    sb, actor = 'cron', weeks = 52, apply = true, gcalEvents = null, notes = [],
  } = ctx;
  if (!gcalConfigured()) {
    notes.push('travel_follow_live: gcal_not_configured');
    return { skipped: true, reason: 'gcal_not_configured', applied: [] };
  }
  const w = Math.min(104, Math.max(4, Number(weeks) || 52));
  const today = londonToday();
  const horizonEnd = addDaysYmd(today, w * 7);
  const now = Date.now();
  const timeMin = new Date(now - 7 * 86400000).toISOString();
  const timeMax = new Date(now + w * 7 * 86400000).toISOString();

  const [blocks0, rules, venues] = await Promise.all([
    sb('travel_blocks?select=*&order=starts_at.asc'),
    sb('scheduling_rules?select=key,value'),
    sb('venue_drive_times?select=venue_name,postcode,minutes_from_home,verified_at'),
  ]);
  let events = gcalEvents;
  if (!events) {
    const gcal = await fetchHorizonEvents(timeMin, timeMax);
    events = gcal.events || [];
  }
  const ruleMap = ruleMapFromRows(rules || []);
  const homePc = ruleMap.home_postcode || 'CV4 9HW';

  // Plan first (never mutate on dry_run). Orphan deletes only when apply=true.
  let orphanStats = { checked: 0, deleted: 0, skipped: 0 };
  let blocks = blocks0 || [];
  if (apply) {
    orphanStats = await runWorkshopTravelReconcile({
      sb,
      gcalEvents: events,
      today,
      horizonEnd,
      notes,
    });
    if (orphanStats.deleted > 0) {
      blocks = (await sb('travel_blocks?select=*&order=starts_at.asc')) || [];
    }
  } else {
    notes.push('travel_follow_live: dry_run — skipped orphan deletes');
  }

  const plan = planTravelRegenerate(blocks, events, ruleMap, venues || [], { today });
  const timesChanged = (plan.changes || []).filter((c) => c.out.times_changed || c.back.times_changed);
  const toApply = (plan.linked || []).filter((r) => r.out.changed || r.back.changed);
  notes.push(
    `travel_follow_live: pairs=${plan.pairs} changes=${plan.changed_count}`
    + ` times=${timesChanged.length} unmatched=${(plan.unmatched || []).length}`
    + ` orphans_deleted=${orphanStats.deleted || 0}`,
  );

  if (!apply) {
    return {
      skipped: true,
      plan,
      orphan: orphanStats,
      applied: [],
      created: [],
      times_changed_count: timesChanged.length,
      would_apply: timesChanged.map((c) => ({
        title: c.title,
        out_from: c.out.from.starts_at,
        out_to: c.out.to.starts_at,
        back_from: c.back.from.starts_at,
        back_to: c.back.to.starts_at,
      })),
    };
  }

  // 2) Move existing to live times
  const applied = toApply.length
    ? await applyTravelPlan(sb, { ...plan, linked: toApply }, blocks, actor, w)
    : [];

  // 3) Create missing for uncovered workshops
  const blocksAfter = applied.length
    ? (await sb('travel_blocks?select=*&order=starts_at.asc')) || []
    : blocks;
  const created = await createMissingWorkshopTravel({
    sb,
    events,
    blocks: blocksAfter,
    venues: venues || [],
    ruleMap,
    notes,
    homePc,
    today,
  });

  // 4) AWAY/REST sync when anything changed
  if (applied.length || created.length || orphanStats.deleted > 0) {
    try {
      const { runRuleEventMasterSync } = require('./rule-event-masters-lib');
      await runRuleEventMasterSync(sb, { writeGcal: true, weeks: w });
      notes.push('travel_follow_live: AWAY/REST masters synced');
    } catch (e) {
      notes.push(`travel_follow_live_master_sync_error: ${e.message}`);
    }
  }

  notes.push(`travel_follow_live: applied=${applied.length} created=${created.length}`);
  return {
    skipped: false,
    plan,
    orphan: orphanStats,
    applied,
    created,
    times_changed_count: timesChanged.length,
  };
}

module.exports = {
  applyTravelPlan,
  runTravelFollowLive,
  createMissingWorkshopTravel,
  writeTravelGcal,
};
