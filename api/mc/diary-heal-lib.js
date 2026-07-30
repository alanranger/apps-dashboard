/**
 * Post-detect heal for manual Scheduling "Run check now".
 * DB + gcal_push_queue only — never writes Google Calendar directly.
 */
const { resolveOverlap } = require('./conflict-resolve-lib');
const { upsertPushRow } = require('./gcal-push-lib');
const { fetchHorizonEvents, gcalConfigured } = require('./gcal-lib');
const { londonToday, addDaysYmd } = require('./diary-lib');
const { isoToLondonDate, ruleMapFromRows } = require('./scheduling-rules-lib');
const { workPairs, gapBufferTitle } = require('./buffer-gap-lib');
const { awaySpansFromTravelBlocks } = require('./habit-placer-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isOverlapPending(row) {
  return row.change_type === 'rule_breach'
    && (/breach:overlap:/.test(row.related_id || '') || /overlaps/i.test(row.summary || ''));
}

async function healOverlaps(sb, actor) {
  const rows = await sb(
    'pending_diary_changes?status=eq.pending&select=*&order=detected_at.asc',
  ) || [];
  const overlaps = rows.filter(isOverlapPending);
  let overlaps_fixed = 0;
  let overlaps_failed = 0;
  let push_queued = 0;
  for (const row of overlaps) {
    try {
      await resolveOverlap(sb, row, 'lower', actor);
      overlaps_fixed += 1;
      push_queued += 1;
      await sleep(80);
    } catch (_) {
      overlaps_failed += 1;
    }
  }
  return { overlaps_fixed, overlaps_failed, push_queued };
}

function parentMatchesDecompress(primary, decompressEvent, afterLabel, day) {
  const after = String(afterLabel || '');
  return primary.some((e) => {
    if (e.id === decompressEvent.id) return false;
    if (/Decompress|Prep —|Travel |AWAY|REST|⚽/i.test(e.summary || '')) return false;
    if (!(/^MC\b/i.test(e.summary || '') || /^P\d\s*·\s*MC-/i.test(e.summary || '')
      || /^DONE\b/i.test(e.summary || ''))) {
      return false;
    }
    if (isoToLondonDate(e.start.dateTime) !== day) return false;
    const bare = String(e.summary || '')
      .replace(/^DONE\s*[·•\-–]\s*/i, '')
      .replace(/^MC\s*[^\s]+\s+/, '')
      .replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '');
    const a = after.toLowerCase().slice(0, 24);
    const b = bare.toLowerCase().slice(0, 24);
    return a && b && (a.includes(b.slice(0, 16)) || b.includes(a.slice(0, 16)));
  });
}

async function queueDeleteDecompress(sb, eventId, title) {
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

async function queueOrphanDecompress(sb) {
  if (!gcalConfigured()) return { orphans_queued: 0, push_queued: 0 };
  const today = londonToday();
  const to = addDaysYmd(today, 200);
  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T00:00:00.000Z`);
  const primary = (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime,
  );
  const strips = primary.filter((e) => /Decompress — after /i.test(e.summary || ''));
  let orphans_queued = 0;
  for (const d of strips) {
    const day = isoToLondonDate(d.start.dateTime);
    const after = (/Decompress — after (.+)$/i.exec(d.summary) || [])[1] || '';
    if (parentMatchesDecompress(primary, d, after, day)) continue;
    await queueDeleteDecompress(sb, d.id, d.summary);
    orphans_queued += 1;
  }
  return { orphans_queued, push_queued: orphans_queued };
}

async function queueStaleGapMasters(sb) {
  if (!gcalConfigured()) return { gaps_retired: 0, push_queued: 0 };
  const today = londonToday();
  const to = addDaysYmd(today, 200);
  const [rules, travel, gcal, existing] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('travel_blocks?select=*&order=starts_at.asc'),
    fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
    sb('gap_buffer_blocks?status=eq.active&select=*'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const awaySpans = awaySpansFromTravelBlocks(travel || []);
  const gapBlocks = (gcal.events || []).map((e) => ({
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
      await queueDeleteDecompress(
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

async function runDiaryHeal(sb, { actor } = {}) {
  const who = actor || 'scheduling-heal';
  const overlaps = await healOverlaps(sb, who);
  const orphans = await queueOrphanDecompress(sb);
  const stale = await queueStaleGapMasters(sb);
  const remaining = await sb(
    'pending_diary_changes?status=eq.pending&select=id',
  ) || [];
  return {
    overlaps_fixed: overlaps.overlaps_fixed,
    overlaps_failed: overlaps.overlaps_failed,
    orphans_queued: orphans.orphans_queued,
    gaps_retired: stale.gaps_retired,
    push_queued: overlaps.push_queued + orphans.push_queued + stale.push_queued,
    remaining_pending: remaining.length,
  };
}

module.exports = { runDiaryHeal };
