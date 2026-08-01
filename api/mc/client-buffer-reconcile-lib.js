/**
 * Parent-linked client prep/decompress — same pattern as fixture Before/After
 * and workshop travel_out/back. Auto-applies GCal + travel_blocks (clients
 * self-move via Acuity; propose-only would leave orphans).
 */
const { isOnlineClientHome } = require('./scheduleCsv');
const { isoToLondonDate } = require('./scheduling-rules-lib');
const {
  insertPrimaryEvent, patchPrimaryEvent, deletePrimaryEvent,
} = require('./gcal-write-lib');
const { gcalConfigured } = require('./gcal-lib');
const { travelGcalTitle, travelGcalDescription } = require('./gcal-title-lib');

function shiftIso(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

function isoClose(a, b, tolMin = 2) {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= tolMin * 60000;
}

/** Prep = S−prepMin→S ; Decompress = E→E+decompMin (fixture flank shape). */
function flankWindows(parent, prepMin, decompMin) {
  const start = parent.start?.dateTime || parent.start;
  const end = parent.end?.dateTime || parent.end;
  if (!start || !end || !String(start).includes('T')) return null;
  return {
    parent_start: start,
    parent_end: end,
    prep_start: shiftIso(start, -Number(prepMin) || -30),
    prep_end: start,
    decomp_start: end,
    decomp_end: shiftIso(end, Number(decompMin) || 30),
  };
}

function clientWorkshopTitle(summary) {
  const s = String(summary || '');
  const name = s.split(':')[0].trim();
  if (/1\s*[-–]?\s*2\s*[-–]?\s*1/i.test(s) || /\bzoom\b/i.test(s)) {
    return `${name} 1-2-1 Zoom`;
  }
  return name || s.slice(0, 48);
}

function isClientParent(e) {
  const summary = e?.summary || e?.title || '';
  if (!e?.start?.dateTime) return false;
  if (/^MC\b/i.test(summary)) return false;
  return isOnlineClientHome(summary);
}

function overlaps(a0, a1, b0, b1) {
  return Date.parse(a0) < Date.parse(b1) && Date.parse(b0) < Date.parse(a1);
}

function otherClientClash(parents, selfId, startIso, endIso) {
  return (parents || []).find((p) => {
    if (!p.id || p.id === selfId) return false;
    const s = p.start?.dateTime;
    const e = p.end?.dateTime || s;
    return s && overlaps(startIso, endIso, s, e);
  }) || null;
}

function blockMeta(blockType, workshop) {
  return {
    block_type: blockType,
    workshop_title: workshop,
    venue_name: 'HOME',
  };
}

async function insertPending(sb, existingPending, inserted, row) {
  if (!existingPending || (await existingPending(row.change_type, row.related_id))) return;
  const out = await sb('pending_diary_changes', { method: 'POST', body: row });
  const id = Array.isArray(out) ? out[0]?.id : out?.id;
  if (id) inserted.push(id);
}

async function ensureFlank(ctx, parent, win, blockType, startIso, endIso) {
  const {
    sb, notes, prefixes, workshop, byParentType, stats, parents,
    existingPending, inserted,
  } = ctx;
  const parentId = parent.id;
  const clash = otherClientClash(parents, parentId, startIso, endIso);
  if (clash) {
    await insertPending(sb, existingPending, inserted, {
      change_type: 'client_buffer_clash',
      target_date: isoToLondonDate(win.parent_start),
      summary: `Client buffer clash: ${workshop} ${blockType}`,
      proposed_action: `Prep/decompress for "${workshop}" overlaps another client ("${clash.summary}"). Resolve booking times; reconciler will not stack two clients.`,
      reason: `parent=${parentId}; clash=${clash.id}`,
      urgency: 'high',
      status: 'pending',
      related_id: `client_clash:${parentId}:${blockType}`,
    });
    stats.clash += 1;
    return;
  }

  const key = `${parentId}:${blockType}`;
  let row = byParentType.get(key);
  const meta = blockMeta(blockType, workshop);
  const summary = travelGcalTitle(meta, prefixes);
  const description = travelGcalDescription(meta);
  const body = {
    block_type: blockType,
    starts_at: startIso,
    ends_at: endIso,
    venue_name: 'HOME',
    workshop_title: workshop,
    workshop_start: win.parent_start,
    parent_event_id: parentId,
    created_by: 'client_buffer_reconcile',
  };

  if (!row) {
    const created = await insertPrimaryEvent({
      summary, startIso, endIso, description, location: 'HOME',
    });
    const out = await sb('travel_blocks', {
      method: 'POST',
      body: { ...body, calendar_event_id: created.id },
    });
    row = Array.isArray(out) ? out[0] : out;
    byParentType.set(key, row);
    stats.created += 1;
    notes.push(`client_buffer_create: ${blockType} ${workshop}`);
    return;
  }

  const needsMove = !isoClose(row.starts_at, startIso) || !isoClose(row.ends_at, endIso);
  const needsLink = row.parent_event_id !== parentId;
  if (!needsMove && !needsLink) {
    stats.ok += 1;
    return;
  }
  if (needsMove && row.calendar_event_id) {
    await patchPrimaryEvent(row.calendar_event_id, {
      summary, startIso, endIso, description, location: 'HOME',
    });
  }
  await sb(`travel_blocks?id=eq.${row.id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      starts_at: startIso,
      ends_at: endIso,
      workshop_title: workshop,
      workshop_start: win.parent_start,
      parent_event_id: parentId,
      venue_name: 'HOME',
    },
  });
  stats.moved += 1;
  notes.push(`client_buffer_move: ${blockType} ${workshop}`);
}

function backfillParentId(row, parents) {
  if (row.parent_event_id) return row.parent_event_id;
  const anchor = row.block_type === 'prep' ? row.ends_at : row.starts_at;
  const hit = (parents || []).find((p) => {
    const edge = row.block_type === 'prep' ? p.start?.dateTime : p.end?.dateTime;
    return edge && isoClose(anchor, edge, 5);
  });
  return hit?.id || null;
}

async function retireOrphans(ctx, liveParentIds, today, horizonEnd) {
  const { sb, byParentType, stats, notes } = ctx;
  const seen = new Set();
  for (const [key, row] of byParentType) {
    if (!row?.parent_event_id || liveParentIds.has(row.parent_event_id)) continue;
    const day = isoToLondonDate(row.workshop_start || row.starts_at);
    // Only retire inside the fetched horizon — outside window parents were not loaded.
    if (day && today && day < today) continue;
    if (day && horizonEnd && day > horizonEnd) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.calendar_event_id) {
      try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* gone ok */ }
    }
    await sb(`travel_blocks?id=eq.${row.id}`, { method: 'DELETE' });
    byParentType.delete(key);
    stats.deleted += 1;
    notes.push(`client_buffer_delete: orphan ${row.block_type} ${row.workshop_title}`);
  }
}

async function resolveMissingBufferPending(sb, parentId) {
  try {
    const rows = await sb(
      `pending_diary_changes?status=eq.pending&change_type=eq.missing_buffer`
      + `&related_id=eq.${encodeURIComponent(`client_buffer:${parentId}`)}&select=id`,
    ) || [];
    for (const p of rows) {
      await sb(`pending_diary_changes?id=eq.${p.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          status: 'resolved_externally',
          resolved_at: new Date().toISOString(),
          resolved_by: 'client_buffer_reconcile',
        },
      });
    }
  } catch (_) { /* non-fatal */ }
}

/**
 * Auto-apply prep+decompress for Zoom/online client bookings in horizon.
 * @param {object} ctx
 */
async function runClientBufferReconcile(ctx) {
  const {
    sb, notes, gcalEvents, prepMin, decompMin, today, horizonEnd,
    existingPending, inserted, ruleMap,
  } = ctx;
  const stats = {
    created: 0, moved: 0, deleted: 0, ok: 0, clash: 0, skipped: 0,
  };

  if (!gcalConfigured()) {
    notes.push('client_buffer_reconcile: skipped (gcal not configured)');
    return stats;
  }
  if (!gcalEvents?.length) {
    notes.push('client_buffer_reconcile: skipped (no gcal)');
    return stats;
  }

  const prefixes = {
    buffer: ruleMap?.title_prefix_buffer || 'MC ⏳',
    travel: ruleMap?.title_prefix_travel || 'MC 🚗',
  };

  const parents = (gcalEvents || []).filter((e) => {
    if (!isClientParent(e)) return false;
    const day = isoToLondonDate(e.start.dateTime);
    if (!day || (today && day < today)) return false;
    if (horizonEnd && day > horizonEnd) return false;
    return true;
  });

  let blocks = [];
  try {
    blocks = await sb(
      'travel_blocks?select=*&block_type=in.(prep,decompress)',
    ) || [];
  } catch (e) {
    notes.push(`client_buffer_reconcile_read_error: ${e.message}`);
    return stats;
  }

  const byParentType = new Map();
  for (const b of blocks) {
    let pid = b.parent_event_id || backfillParentId(b, parents);
    if (pid && !b.parent_event_id) {
      await sb(`travel_blocks?id=eq.${b.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { parent_event_id: pid },
      });
      b.parent_event_id = pid;
    }
    if (b.parent_event_id) {
      byParentType.set(`${b.parent_event_id}:${b.block_type}`, b);
    }
  }

  const liveIds = new Set();
  const runCtx = {
    sb, notes, prefixes, byParentType, stats, parents,
    existingPending, inserted,
  };

  for (const parent of parents) {
    liveIds.add(parent.id);
    const win = flankWindows(parent, prepMin, decompMin);
    if (!win) {
      stats.skipped += 1;
      continue;
    }
    const workshop = clientWorkshopTitle(parent.summary);
    runCtx.workshop = workshop;
    await ensureFlank(runCtx, parent, win, 'prep', win.prep_start, win.prep_end);
    await ensureFlank(runCtx, parent, win, 'decompress', win.decomp_start, win.decomp_end);
    await resolveMissingBufferPending(sb, parent.id);
  }

  await retireOrphans(runCtx, liveIds, today, horizonEnd);

  notes.push(
    `client_buffer_reconcile: parents=${parents.length} `
    + `created=${stats.created} moved=${stats.moved} deleted=${stats.deleted} `
    + `ok=${stats.ok} clash=${stats.clash}`,
  );
  return stats;
}

module.exports = {
  runClientBufferReconcile,
  flankWindows,
  clientWorkshopTitle,
  isClientParent,
  isoClose,
  shiftIso,
};
