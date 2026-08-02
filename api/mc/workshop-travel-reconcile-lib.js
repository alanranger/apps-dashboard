/**
 * Retire workshop travel_out / travel_leg / travel_back when the parent
 * workshop is gone or moved far away. Client prep/decompress already die
 * with parent; workshop travel previously only unmatched / manual_lock'd.
 */
const { deletePrimaryEvent } = require('./gcal-write-lib');
const { gcalConfigured, getEventAcrossCalendars } = require('./gcal-lib');

/** Parent workshop more than this many days from travel → orphan. */
const ORPHAN_DRIFT_DAYS = 14;

function gcalIdFromRowKey(key) {
  const m = String(key || '').match(/^gcal:(.+)$/i);
  return m ? m[1] : null;
}

function eventStartIso(e) {
  if (!e?.start) return null;
  if (e.start.dateTime) return e.start.dateTime;
  if (e.start.date) return `${e.start.date}T12:00:00Z`;
  return null;
}

function daysApart(a, b) {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
  return Math.abs(da - db) / 86400000;
}

function isOrphanAgainstParent(row, parent) {
  if (!parent || parent.status === 'cancelled') return true;
  const parentStart = eventStartIso(parent);
  const anchor = row.workshop_start || row.starts_at;
  if (!parentStart || !anchor) return false;
  return daysApart(parentStart, anchor) > ORPHAN_DRIFT_DAYS;
}

async function resolveParent(row, byId) {
  const eid = gcalIdFromRowKey(row.workshop_row_key);
  if (!eid) return { parent: null, reason: 'no_row_key' };
  if (byId.has(eid)) {
    const cached = byId.get(eid);
    return { parent: cached || null, reason: cached ? 'cache' : 'missing' };
  }
  try {
    const live = await getEventAcrossCalendars(eid);
    if (!live || live.status === 'cancelled') {
      byId.set(eid, null);
      return { parent: null, reason: 'missing_or_cancelled' };
    }
    byId.set(eid, live);
    return { parent: live, reason: 'fetched' };
  } catch (e) {
    throw e;
  }
}

async function deleteTravelRow(sb, row, notes, stats) {
  if (row.calendar_event_id) {
    try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* gone ok */ }
  }
  await sb(`travel_blocks?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE' });
  stats.deleted += 1;
  notes.push(
    `workshop_travel_orphan_delete: ${row.block_type} ${row.workshop_title || row.venue_name}`
    + (row.manual_lock ? ' (was manual_lock)' : ''),
  );
}

/**
 * @param {{ sb: Function, gcalEvents?: any[], today: string, horizonEnd: string, notes?: string[] }} ctx
 */
async function runWorkshopTravelReconcile(ctx) {
  const {
    sb, gcalEvents = [], today, horizonEnd, notes = [],
  } = ctx;
  const stats = { checked: 0, deleted: 0, skipped: 0 };

  if (!today || !horizonEnd) {
    notes.push('workshop_travel_reconcile: missing today/horizonEnd');
    return stats;
  }
  if (!gcalConfigured()) {
    notes.push('workshop_travel_reconcile: gcal_not_configured');
    return { ...stats, skipped: true, reason: 'gcal_not_configured' };
  }

  let rows = [];
  try {
    rows = await sb(
      'travel_blocks?select=id,block_type,starts_at,ends_at,calendar_event_id,'
      + 'workshop_title,workshop_start,workshop_row_key,venue_name,manual_lock'
      + '&block_type=in.(travel_out,travel_back,travel_leg)'
      + `&starts_at=gte.${today}T00:00:00Z&starts_at=lte.${horizonEnd}T23:59:59Z`
      + '&order=starts_at.asc&limit=500',
    ) || [];
  } catch (e) {
    notes.push(`workshop_travel_reconcile_read_error: ${e.message}`);
    return stats;
  }

  const byId = new Map();
  for (const e of gcalEvents) {
    if (e?.id) byId.set(e.id, e);
  }

  const outs = rows.filter((r) => r.block_type === 'travel_out');
  const backs = rows.filter((r) => r.block_type === 'travel_back');
  const legs = rows.filter((r) => r.block_type === 'travel_leg');
  const orphanAnchors = [];

  for (const row of [...outs, ...backs]) {
    stats.checked += 1;
    let orphan = false;
    if (!row.workshop_row_key) {
      // Soft-linked only: orphan if no nearby workshop title match in horizon.
      const title = String(row.workshop_title || '').toLowerCase();
      const near = (gcalEvents || []).some((e) => {
        const sum = String(e.summary || '').toLowerCase();
        if (!title || !sum) return false;
        const hit = title.split(/\s+/).filter((w) => w.length > 4).some((w) => sum.includes(w));
        if (!hit) return false;
        const ps = eventStartIso(e);
        return ps && daysApart(ps, row.starts_at) <= ORPHAN_DRIFT_DAYS;
      });
      orphan = !near;
    } else {
      const { parent } = await resolveParent(row, byId);
      orphan = isOrphanAgainstParent(row, parent);
    }
    if (!orphan) {
      stats.skipped += 1;
      continue;
    }
    orphanAnchors.push(row);
    await deleteTravelRow(sb, row, notes, stats);
  }

  for (const leg of legs) {
    stats.checked += 1;
    const t = Date.parse(leg.starts_at);
    const outsOrphan = orphanAnchors.filter((a) => a.block_type === 'travel_out');
    const backsOrphan = orphanAnchors.filter((a) => a.block_type === 'travel_back');
    let between = false;
    for (const o of outsOrphan) {
      const back = backsOrphan.find((b) => {
        const gap = Date.parse(b.starts_at) - Date.parse(o.starts_at);
        return gap >= 0 && gap <= 4 * 86400000;
      });
      const lo = Date.parse(o.starts_at);
      const hi = back
        ? Date.parse(back.ends_at || back.starts_at)
        : lo + 2 * 86400000;
      if (t > lo && t < hi) { between = true; break; }
    }
    const titleHit = orphanAnchors.some((a) => {
      const at = String(a.workshop_title || '').toLowerCase();
      const lt = String(leg.workshop_title || '').toLowerCase();
      if (!at || !lt) return false;
      const words = at.split(/\s+/).filter((w) => w.length > 4);
      return words.some((w) => lt.includes(w)) && daysApart(a.starts_at, leg.starts_at) <= 2;
    });
    if (!between && !titleHit) {
      stats.skipped += 1;
      continue;
    }
    await deleteTravelRow(sb, leg, notes, stats);
  }

  notes.push(`workshop_travel_reconcile: checked=${stats.checked} deleted=${stats.deleted}`);
  return stats;
}

module.exports = {
  ORPHAN_DRIFT_DAYS,
  gcalIdFromRowKey,
  isOrphanAgainstParent,
  runWorkshopTravelReconcile,
};
