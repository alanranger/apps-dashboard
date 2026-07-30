/**
 * Post-detect heal for manual Scheduling "Run check now".
 * Overlaps/gaps queue GCal via push; orphan decompress deletes apply immediately
 * (queue-only left zombies when flush did not run).
 */
const { resolveOverlap } = require('./conflict-resolve-lib');
const { relatedIdForTask, upsertPushRow } = require('./gcal-push-lib');
const { fetchHorizonEvents, gcalConfigured } = require('./gcal-lib');
const { deletePrimaryEvent } = require('./gcal-write-lib');
const { londonToday, addDaysYmd } = require('./diary-lib');
const { isoToLondonDate, ruleMapFromRows } = require('./scheduling-rules-lib');
const { workPairs, gapBufferTitle } = require('./buffer-gap-lib');
const { awaySpansFromTravelBlocks, londonYmdHmToUtcMs } = require('./habit-placer-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isOverlapPending(row) {
  return row.change_type === 'rule_breach'
    && (/breach:overlap:/.test(row.related_id || '') || /overlaps/i.test(row.summary || ''));
}

function isGapPending(row) {
  return row.change_type === 'rule_breach'
    && (/breach:gap:/.test(row.related_id || '')
      || /gap -?\d+m < \d+m decompress/i.test(row.summary || ''));
}

async function healOverlaps(sb, actor, maxOverlaps = 25) {
  const rows = await sb(
    'pending_diary_changes?status=eq.pending&select=*&order=detected_at.asc',
  ) || [];
  const overlaps = rows.filter(isOverlapPending).slice(0, Math.max(1, maxOverlaps));
  let overlaps_fixed = 0;
  let overlaps_failed = 0;
  let push_queued = 0;
  for (const row of overlaps) {
    try {
      await resolveOverlap(sb, row, 'lower', actor);
      overlaps_fixed += 1;
      push_queued += 1;
      await sleep(40);
    } catch (_) {
      overlaps_failed += 1;
    }
  }
  return {
    overlaps_fixed,
    overlaps_failed,
    push_queued,
    overlaps_left: Math.max(0, rows.filter(isOverlapPending).length - overlaps.length),
  };
}

/** Apply concrete MOVE from gap breach proposed_action (same shapes as flush). */
async function healGaps(sb, actor, maxGaps = 25) {
  const rows = await sb(
    'pending_diary_changes?status=eq.pending&select=*&order=detected_at.asc',
  ) || [];
  const gaps = rows.filter(isGapPending).slice(0, Math.max(1, maxGaps));
  let gaps_fixed = 0;
  let gaps_failed = 0;
  let push_queued = 0;

  for (const row of gaps) {
    try {
      const action = String(row.proposed_action || '');
      const moveTask = /MOVE MC-(\d+).*?event ([A-Za-z0-9_-]+) to (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[–-](\d{2}:\d{2})/i
        .exec(action);
      const movePrimary = /MOVE Primary event ([A-Za-z0-9_-]+) to (\S+)\s*[–-]\s*(\S+)/i
        .exec(action);
      if (moveTask) {
        const displayId = Number(moveTask[1]);
        const eventId = moveTask[2];
        const day = moveTask[3];
        const startIso = new Date(londonYmdHmToUtcMs(day, moveTask[4])).toISOString();
        const endIso = new Date(londonYmdHmToUtcMs(day, moveTask[5])).toISOString();
        const tasks = await sb(
          `tasks?display_id=eq.${displayId}&select=id,display_id,title,calendar_event_id&limit=1`,
        );
        const task = tasks?.[0];
        if (!task) {
          gaps_failed += 1;
          continue;
        }
        await sb(`tasks?id=eq.${task.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            scheduled_start: startIso,
            scheduled_end: endIso,
            last_activity_at: new Date().toISOString(),
          },
        });
        await upsertPushRow(sb, {
          related_id: relatedIdForTask(task.id),
          entity_type: 'task',
          change_kind: 'move',
          summary: `Heal gap: slide MC-${displayId} for decompress`,
          proposed_action: action,
          payload: {
            action: 'patch',
            event_id: eventId || task.calendar_event_id,
            startIso,
            endIso,
            display_id: displayId,
          },
        });
      } else if (movePrimary) {
        const eventId = movePrimary[1];
        const startIso = movePrimary[2];
        const endIso = movePrimary[3];
        await upsertPushRow(sb, {
          related_id: `gcal:gap_slide:${eventId}`,
          entity_type: 'habit',
          change_kind: 'move',
          summary: `Heal gap: slide Primary ${eventId}`,
          proposed_action: action,
          payload: {
            action: 'patch',
            event_id: eventId,
            startIso,
            endIso,
          },
        });
      } else {
        gaps_failed += 1;
        continue;
      }
      await sb(`pending_diary_changes?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          status: 'applied',
          resolved_at: new Date().toISOString(),
          resolved_by: actor || 'scheduling-heal',
        },
      });
      gaps_fixed += 1;
      push_queued += 1;
      await sleep(40);
    } catch (_) {
      gaps_failed += 1;
    }
  }
  return {
    gaps_fixed,
    gaps_failed,
    push_queued,
    gaps_left: Math.max(0, rows.filter(isGapPending).length - gaps.length),
  };
}

function decompressAfterLabel(summary) {
  const s = String(summary || '');
  const after = /Decompress\s*—\s*after\s+(.+)$/i.exec(s);
  if (after) return after[1].trim();
  const bare = /Decompress\s*—\s*(.+)$/i.exec(s);
  return bare ? bare[1].trim() : '';
}

function parentMatchesDecompress(primary, decompressEvent, afterLabel, day) {
  const after = String(afterLabel || '');
  if (!after) return false;
  const d0 = Date.parse(decompressEvent.start?.dateTime || 0);
  if (!d0) return false;
  return primary.some((e) => {
    if (e.id === decompressEvent.id) return false;
    // Prep is NEVER a decompress parent — decompress belongs after the workshop/work block.
    if (/Decompress|Travel |AWAY|REST|⚽|Prep\s*—/i.test(e.summary || '')) return false;
    const isMc = /^MC\b/i.test(e.summary || '') || /^P\d\s*·\s*MC-/i.test(e.summary || '')
      || /^DONE\b/i.test(e.summary || '');
    if (!isMc) return false;
    if (isoToLondonDate(e.start.dateTime) !== day) return false;
    const end = Date.parse(e.end?.dateTime || e.start.dateTime);
    const gapMin = (d0 - end) / 60000;
    if (gapMin < -1 || gapMin > 5) return false;
    const bare = String(e.summary || '')
      .replace(/^DONE\s*[·•\-–]\s*/i, '')
      .replace(/^MC\s*[^\s]+\s+/, '')
      .replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '');
    const a = after.toLowerCase().slice(0, 28);
    const b = bare.toLowerCase().slice(0, 28);
    return a && b && (a.includes(b.slice(0, 16)) || b.includes(a.slice(0, 16)));
  });
}

async function deleteOrphanDecompressNow(sb, eventId, title) {
  try {
    await deletePrimaryEvent(eventId);
  } catch (_) { /* missing is fine */ }
  await upsertPushRow(sb, {
    related_id: `gcal:gap_buffer:orphan:${eventId}`,
    entity_type: 'habit',
    change_kind: 'skip',
    summary: `Retire orphan decompress: ${String(title || '').slice(0, 80)}`,
    proposed_action: `Delete Primary decompress ${eventId}`,
    payload: {
      calendar_event_id: eventId,
      action: 'delete_event',
      title: title || 'MC ⏳ Decompress',
    },
  });
  // Mark the push row applied — delete already done live.
  await sb(
    `gcal_push_queue?related_id=eq.${encodeURIComponent(`gcal:gap_buffer:orphan:${eventId}`)}&status=eq.pending`,
    {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        status: 'applied',
        resolved_at: new Date().toISOString(),
        resolved_by: 'scheduling-heal',
        updated_at: new Date().toISOString(),
      },
    },
  ).catch(() => {});
  await sb(
    `gap_buffer_blocks?calendar_event_id=eq.${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        status: 'retired',
        calendar_event_id: null,
        updated_at: new Date().toISOString(),
      },
    },
  ).catch(() => {});
}

async function loadPrimaryEvents(daysAhead) {
  if (!gcalConfigured()) return [];
  const today = londonToday();
  const to = addDaysYmd(today, daysAhead);
  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
  return (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime,
  );
}

async function queueOrphanDecompress(sb, primary) {
  const strips = (primary || []).filter((e) => {
    const t = e.summary || '';
    return /Decompress/i.test(t) && (/^MC\b/i.test(t) || /⏳/.test(t));
  });
  let orphans_queued = 0;
  for (const d of strips) {
    const day = isoToLondonDate(d.start.dateTime);
    const after = decompressAfterLabel(d.summary);
    if (parentMatchesDecompress(primary, d, after, day)) continue;
    await deleteOrphanDecompressNow(sb, d.id, d.summary);
    orphans_queued += 1;
  }
  return { orphans_queued, push_queued: orphans_queued };
}

async function queueStaleGapMasters(sb, primary) {
  const today = londonToday();
  const [rules, travel, existing] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('travel_blocks?select=*&order=starts_at.asc'),
    sb('gap_buffer_blocks?status=eq.active&select=*'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const awaySpans = awaySpansFromTravelBlocks(travel || []);
  const gapBlocks = (primary || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
  }));
  const keep = new Set();
  for (const p of workPairs(gapBlocks, ruleMap, awaySpans)) {
    if (p.gap < p.need || p.need <= 0) continue;
    const afterId = String(p.a.id || '');
    if (afterId) keep.add(`${p.day}|${afterId}`);
  }
  let gaps_retired = 0;
  let push_queued = 0;
  for (const row of existing || []) {
    const key = `${row.day}|${String(row.after_event_id || '')}`;
    if (keep.has(key)) continue;
    if (row.calendar_event_id) {
      await deleteOrphanDecompressNow(
        sb,
        row.calendar_event_id,
        gapBufferTitle(row.after_label),
      );
      push_queued += 1;
    } else {
      await sb(`gap_buffer_blocks?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          status: 'retired',
          calendar_event_id: null,
          updated_at: new Date().toISOString(),
        },
      });
    }
    gaps_retired += 1;
  }
  return { gaps_retired, push_queued };
}

async function runDiaryHeal(sb, {
  actor,
  maxOverlaps = 25,
  maxGaps = 25,
  orphanDays = 200,
  flushAfter = false,
} = {}) {
  const who = actor || 'scheduling-heal';
  const overlaps = await healOverlaps(sb, who, maxOverlaps);
  const gapHeal = await healGaps(sb, who, maxGaps);
  const primary = await loadPrimaryEvents(orphanDays);
  const orphans = await queueOrphanDecompress(sb, primary);
  const stale = await queueStaleGapMasters(sb, primary);
  let reconcile = null;
  try {
    const { runPinGcalReconcile } = require('./pin-gcal-reconcile-lib');
    reconcile = await runPinGcalReconcile(sb, { daysAhead: orphanDays });
  } catch (e) {
    reconcile = { error: e.message || 'reconcile failed' };
  }
  let flush = null;
  if (flushAfter) {
    try {
      const { pushSync } = require('./gcal-auto-sync-lib');
      let applied = 0;
      let failed = 0;
      for (let i = 0; i < 12; i += 1) {
        const batch = await pushSync(sb, who, {
          includeRuleMasters: i === 11,
          includeBacklog: false,
          limit: 40,
          force: i === 0,
        });
        const f = batch.flush || batch;
        applied += f.applied || 0;
        failed += f.failed || 0;
        if (!(f.remaining_planned > 0) && !(f.applied > 0)) break;
      }
      flush = { applied, failed };
    } catch (e) {
      flush = { error: e.message || 'flush failed' };
    }
  }
  const remaining = await sb(
    'pending_diary_changes?status=eq.pending&select=id',
  ) || [];
  return {
    overlaps_fixed: overlaps.overlaps_fixed,
    overlaps_failed: overlaps.overlaps_failed,
    overlaps_left: overlaps.overlaps_left || 0,
    gaps_fixed: gapHeal.gaps_fixed,
    gaps_failed: gapHeal.gaps_failed,
    gaps_left: gapHeal.gaps_left || 0,
    orphans_queued: orphans.orphans_queued,
    gaps_retired: stale.gaps_retired,
    push_queued: overlaps.push_queued + gapHeal.push_queued
      + orphans.push_queued + stale.push_queued
      + (reconcile?.push_queued || 0),
    remaining_pending: remaining.length,
    reconcile,
    flush,
  };
}

module.exports = { runDiaryHeal };
