/**
 * Full-horizon travel/buffer coverage + stale drive + hotel deadline gap.
 * Used by diary-drift.js — proposals only, no Calendar writes.
 * Client Zoom prep/decompress auto-apply lives in client-buffer-reconcile-lib.js.
 */
const { isStale, STALE_DAYS } = require('./drive-time-lib');

function typesForEvent(home, bufferScope) {
  if (!home) return ['travel_out', 'travel_back'];
  if (bufferScope === 'home_only' || bufferScope === 'all') return ['prep', 'decompress'];
  return [];
}

function hasTypes(blocks, need) {
  const have = new Set((blocks || []).map((b) => b.block_type));
  return need.every((t) => have.has(t));
}

function matchBlocks(byKey, byStart, ev) {
  const fromKey = byKey.get(ev.row_key) || [];
  if (fromKey.length) return fromKey;
  const day = ev.start_date;
  return byStart.get(day) || [];
}

/** Peak-style overnight: day-2 sunrise is hotel→venue travel_leg, not home travel_out+back. */
function coveredByOvernightLegs(blocks, ev) {
  const day = ev.start_date;
  const blob = `${ev.title || ''} ${ev.location_name || ''} ${ev.postcode || ''}`.toLowerCase();
  const peakish = /peak|heather|roaches|rudyard|padley|hathersage/.test(blob);
  const legs = (blocks || []).filter((b) => {
    if (b.block_type !== 'travel_leg') return false;
    const startDay = b.starts_at ? String(b.starts_at).slice(0, 10) : '';
    const wsDay = b.workshop_start ? String(b.workshop_start).slice(0, 10) : '';
    return startDay === day || wsDay === day;
  });
  if (!legs.length) return false;
  if (peakish) return true;
  const title = String(ev.title || '').toLowerCase().slice(0, 24);
  return legs.some((b) => {
    const t = `${b.workshop_title || ''} ${b.venue_name || ''}`.toLowerCase();
    return title && t && (t.includes(title.slice(0, 16)) || title.includes(t.slice(0, 16)));
  });
}

async function insertPending(sb, existingPending, inserted, row) {
  if (await existingPending(row.change_type, row.related_id)) return;
  const out = await sb('pending_diary_changes', { method: 'POST', body: row });
  const id = Array.isArray(out) ? out[0]?.id : out?.id;
  if (id) inserted.push(id);
}

/**
 * Full-horizon missing travel/buffer vs travel_blocks (safety net).
 */
async function runMissingTravelBlockScan(ctx) {
  const {
    sb, existingPending, inserted, inHorizon, isHomeBased, homePc, bufferScope,
    travelPrefix, bufferPrefix, prepMin, decompMin, arriveMin, driveHint, horizonWeeks,
  } = ctx;

  let blocks = [];
  try {
    blocks = await sb(
      'travel_blocks?select=workshop_row_key,workshop_start,workshop_title,venue_name,block_type,calendar_event_id,starts_at',
    ) || [];
  } catch (e) {
    ctx.notes.push(`travel_blocks_read_error: ${e.message}`);
    return;
  }

  const byKey = new Map();
  const byStart = new Map();
  for (const b of blocks) {
    if (b.workshop_row_key) {
      if (!byKey.has(b.workshop_row_key)) byKey.set(b.workshop_row_key, []);
      byKey.get(b.workshop_row_key).push(b);
    }
    if (b.workshop_start) {
      const day = String(b.workshop_start).slice(0, 10);
      if (!byStart.has(day)) byStart.set(day, []);
      byStart.get(day).push(b);
    }
  }

  let missing = 0;
  for (const ev of inHorizon) {
    const home = isHomeBased(ev, homePc);
    const need = typesForEvent(home, bufferScope);
    if (!need.length) continue;
    const matched = matchBlocks(byKey, byStart, ev);
    if (hasTypes(matched, need)) continue;
    // Overnight multi-leg (e.g. Peak Heathers Sat→Sun + Hotel Rudyard) already covers day-2.
    if (!home && coveredByOvernightLegs(blocks, ev)) continue;

    const relatedId = home ? `buffer_block:${ev.row_key}` : `travel_block:${ev.row_key}`;
    const prefix = home ? bufferPrefix : travelPrefix;
    const action = home
      ? `Ensure ${prefix} prep ${prepMin}m before and decompress ${decompMin}m after on ${ev.start_date}. Home (${homePc}). Log rows in travel_blocks after placing.`
      : `Ensure ${prefix} travel_out + travel_back for ${ev.start_date} (arrive ${arriveMin}m before ${ev.start_time || 'start'}). ${driveHint(ev)}. Location: ${ev.location_name || ev.postcode}. Log in travel_blocks after placing.`;

    await insertPending(sb, existingPending, inserted, {
      change_type: 'missing_travel_block',
      target_date: ev.start_date,
      summary: `Missing ${home ? 'buffers' : 'travel'} in horizon: ${ev.title}`,
      proposed_action: action,
      reason: `Full-horizon scan vs travel_blocks; inside ${horizonWeeks}w; need ${need.join('+')}`,
      urgency: 'normal',
      status: 'pending',
      related_id: relatedId,
    });
    missing += 1;
  }
  ctx.notes.push(`missing_travel_block_scan: ${missing} proposal(s) from ${inHorizon.length} horizon events`);
}

/**
 * Stale or null verified_at on venue_drive_times used for upcoming travel.
 */
async function runStaleDriveTimeScan(ctx) {
  const { sb, existingPending, inserted, drives, notes } = ctx;
  let n = 0;
  for (const d of drives || []) {
    if (!isStale(d.verified_at)) continue;
    const relatedId = `stale_drive:${d.venue_name}`;
    const age = d.verified_at ? `verified_at ${d.verified_at}` : 'verified_at NULL';
    await insertPending(sb, existingPending, inserted, {
      change_type: 'stale_drive_time',
      target_date: null,
      summary: `Stale drive time: ${d.venue_name}`,
      proposed_action: `POST /api/mc/drive-time with venue_name="${d.venue_name}", write_back=true (and departure_time for away mornings). Refresh venue_drive_times then rebuild affected travel_blocks.`,
      reason: `${age}; threshold ${STALE_DAYS}d`,
      urgency: 'normal',
      status: 'pending',
      related_id: relatedId,
    });
    n += 1;
  }
  notes.push(`stale_drive_time_scan: ${n} venue(s)`);
}

/**
 * Booked hotels with free_cancel_until NULL (Ravenstone-class gap).
 */
async function runHotelDeadlineGapScan(ctx) {
  const { sb, existingPending, inserted, notes } = ctx;
  let hotels = [];
  try {
    hotels = await sb('workshop_hotels?select=id,workshop_name,hotel,booking_ref,free_cancel_until,status') || [];
  } catch (e) {
    notes.push(`hotel_deadline_gap_read_error: ${e.message}`);
    return;
  }
  let n = 0;
  for (const h of hotels) {
    const booked = !!(h.hotel || h.booking_ref);
    // cancelled = kept for history; awaiting_booking = empty row is expected.
    if (h.status && h.status !== 'active') continue;
    if (!booked || h.free_cancel_until) continue;
    const relatedId = `hotel_gap:${h.id}`;
    await insertPending(sb, existingPending, inserted, {
      change_type: 'hotel_deadline_gap',
      target_date: null,
      summary: `Hotel free-cancel date missing: ${h.hotel || h.workshop_name}`,
      proposed_action: `Set free_cancel_until on workshop_hotels for "${h.workshop_name}" (hotel: ${h.hotel || '—'}, ref: ${h.booking_ref || '—'}). Then place MC ⏰ reminder when date known.`,
      reason: 'Booking present but free_cancel_until IS NULL',
      urgency: 'high',
      status: 'pending',
      related_id: relatedId,
    });
    n += 1;
  }
  notes.push(`hotel_deadline_gap_scan: ${n} hotel(s)`);
}

/**
 * Re-test the condition behind each pending row and auto-retire the ones whose
 * gap has closed (status resolved_externally, not deleted). A row otherwise only
 * clears on an explicit Apply/Dismiss, so a self-fixed problem sat there forever.
 * Only types with a cheap, reliable re-test are retired; anything else is left.
 */
async function runPendingRetirement(ctx) {
  const { sb, inserted, notes } = ctx;
  let pending = [];
  let hotels = [];
  try {
    pending = await sb('pending_diary_changes?status=eq.pending&select=id,change_type,related_id') || [];
    hotels = await sb('workshop_hotels?select=id,hotel,booking_ref,free_cancel_until,reminder_placed,status') || [];
  } catch (e) {
    notes.push(`pending_retirement_read_error: ${e.message}`);
    return;
  }
  const hotelById = new Map(hotels.map((h) => [h.id, h]));
  const resolvers = {
    hotel_deadline_gap: (rid) => {
      const h = hotelById.get(String(rid).replace('hotel_gap:', ''));
      if (!h) return 'hotel row removed';
      if (h.status && h.status !== 'active') return `status=${h.status}`;
      if (h.free_cancel_until) return 'free_cancel_until now set';
      if (!(h.hotel || h.booking_ref)) return 'no longer booked';
      return null;
    },
    hotel_deadline: (rid) => {
      const h = hotelById.get(String(rid).split(':')[1]);
      if (!h) return 'hotel row removed';
      if (h.status && h.status !== 'active') return `status=${h.status}`;
      if (h.reminder_placed) return 'reminder now placed';
      return null;
    },
  };
  let retired = 0;
  for (const p of pending) {
    const resolver = resolvers[p.change_type];
    const why = resolver ? resolver(p.related_id) : null;
    if (!why) continue;
    await sb(`pending_diary_changes?id=eq.${p.id}`, {
      method: 'PATCH',
      body: { status: 'resolved_externally', resolved_at: new Date().toISOString(), resolved_by: 'detector' },
    });
    inserted.push(`retired:${p.id}`);
    retired += 1;
  }
  notes.push(`pending_retirement: ${retired} row(s) auto-retired (resolved_externally)`);
}

function hotelReminderLeadDays(hotel, fallback = 3) {
  if (hotel?.reminder_lead_days != null && hotel.reminder_lead_days !== '') {
    return Number(hotel.reminder_lead_days);
  }
  if (hotel?.cancellation_window_days != null && hotel.cancellation_window_days !== '') {
    const w = Number(hotel.cancellation_window_days);
    if (Number.isFinite(w) && w > 0) return Math.min(21, Math.max(3, w * 3));
  }
  return Number(fallback) || 3;
}

/**
 * Raise when habit or travel placement runway drops below N weeks.
 * Does NOT flag 13-vs-26 divergence (deliberate).
 */
async function runHorizonEdgeScan(ctx) {
  const {
    sb, existingPending, inserted, notes, today, addDaysYmd,
    habitEdgeWeeks, travelEdgeWeeks, habitHorizonWeeks, travelHorizonWeeks,
  } = ctx;

  const habitEdgeEnd = addDaysYmd(today, habitEdgeWeeks * 7);
  const travelEdgeEnd = addDaysYmd(today, travelEdgeWeeks * 7);

  let habitLatest = null;
  try {
    const rows = await sb(
      'recurring_log?calendar_event_id=not.is.null&scheduled_date=not.is.null&select=scheduled_date&order=scheduled_date.desc&limit=1',
    );
    habitLatest = rows?.[0]?.scheduled_date || null;
  } catch (e) {
    notes.push(`horizon_edge_habit_read_error: ${e.message}`);
  }

  let travelLatest = null;
  try {
    const byStart = await sb(
      'travel_blocks?workshop_start=not.is.null&select=workshop_start&order=workshop_start.desc&limit=1',
    );
    const byEnd = await sb(
      'travel_blocks?select=ends_at&order=ends_at.desc&limit=1',
    );
    const a = byStart?.[0]?.workshop_start ? String(byStart[0].workshop_start).slice(0, 10) : null;
    const b = byEnd?.[0]?.ends_at ? String(byEnd[0].ends_at).slice(0, 10) : null;
    travelLatest = !a ? b : (!b ? a : (a > b ? a : b));
  } catch (e) {
    notes.push(`horizon_edge_travel_read_error: ${e.message}`);
  }

  let n = 0;
  if (!habitLatest || habitLatest < habitEdgeEnd) {
    const relatedId = `horizon_edge:habit:${habitLatest || 'none'}`;
    await insertPending(sb, existingPending, inserted, {
      change_type: 'horizon_edge',
      target_date: habitLatest,
      summary: habitLatest
        ? `Habit placement ends ${habitLatest} — under ${habitEdgeWeeks}w runway left`
        : 'No habit placements found with calendar_event_id',
      proposed_action: `Extend habit diary placement toward habit_horizon_weeks (${habitHorizonWeeks}). Latest scheduled_date=${habitLatest || 'none'}.`,
      reason: `horizon_edge habit check; edge=${habitEdgeWeeks}w; target_horizon=${habitHorizonWeeks}w`,
      urgency: 'normal',
      status: 'pending',
      related_id: relatedId,
    });
    n += 1;
  }

  if (!travelLatest || travelLatest < travelEdgeEnd) {
    const relatedId = `horizon_edge:travel:${travelLatest || 'none'}`;
    await insertPending(sb, existingPending, inserted, {
      change_type: 'horizon_edge',
      target_date: travelLatest,
      summary: travelLatest
        ? `Travel/buffer placement ends ${travelLatest} — under ${travelEdgeWeeks}w runway left`
        : 'No travel_blocks placements found',
      proposed_action: `Extend travel/buffer placement toward travel_horizon_weeks (${travelHorizonWeeks}). Latest=${travelLatest || 'none'}.`,
      reason: `horizon_edge travel check; edge=${travelEdgeWeeks}w; target_horizon=${travelHorizonWeeks}w`,
      urgency: 'normal',
      status: 'pending',
      related_id: relatedId,
    });
    n += 1;
  }

  notes.push(
    `horizon_edge_scan: habit_latest=${habitLatest || 'none'} travel_latest=${travelLatest || 'none'} proposals=${n}`,
  );
}

/**
 * When GCal workshop times drift from stamped travel_blocks — propose regenerate.
 */
async function runStaleTravelVsWorkshopScan(ctx) {
  const { sb, existingPending, inserted, notes, gcalEvents, ruleMap, venues } = ctx;
  if (!gcalEvents?.length) {
    notes.push('stale_travel_vs_workshop_scan: skipped (no gcal events)');
    return;
  }
  let blocks = [];
  try {
    blocks = await sb('travel_blocks?select=*&order=starts_at.asc') || [];
  } catch (e) {
    notes.push(`stale_travel_vs_workshop_read_error: ${e.message}`);
    return;
  }
  const { planTravelRegenerate } = require('./travel-regenerate-lib');
  const plan = planTravelRegenerate(blocks, gcalEvents, ruleMap || {}, venues || []);
  let n = 0;
  for (const ch of plan.changes || []) {
    if (!ch.out.times_changed && !ch.back.times_changed) continue;
    const relatedId = `stale_travel:${ch.workshop_row_key || ch.out.id}`;
    await insertPending(sb, existingPending, inserted, {
      change_type: 'stale_travel_vs_workshop',
      target_date: String(ch.workshop_live_start || '').slice(0, 10),
      summary: `Travel drifted from workshop: ${ch.title}`,
      proposed_action: `POST /api/mc/travel-regenerate apply=true (or fix ${ch.venue}). Live workshop ${ch.workshop_live_start}→${ch.workshop_live_end}; travel_out ${ch.out.from.starts_at}→${ch.out.to.starts_at}; travel_back ${ch.back.from.starts_at}→${ch.back.to.starts_at}.`,
      reason: 'travel_blocks snapshot vs live GCal workshop start/end',
      urgency: 'normal',
      status: 'pending',
      related_id: relatedId,
    });
    n += 1;
  }
  notes.push(`stale_travel_vs_workshop_scan: ${n} drift(s); linked=${plan.linked}; unmatched=${(plan.unmatched || []).length}`);
}

module.exports = {
  runMissingTravelBlockScan,
  runStaleDriveTimeScan,
  runStaleTravelVsWorkshopScan,
  runHotelDeadlineGapScan,
  runHorizonEdgeScan,
  runPendingRetirement,
  hotelReminderLeadDays,
  STALE_DAYS,
};
