/**
 * Enforce decompress gaps between MC work blocks.
 * Tight gaps → concrete MOVE proposals (flush-parseable).
 * Adequate gaps → persist MC ⏳ gap buffer masters (GCal + gap_buffer_blocks).
 */
const {
  requiredGapMins, londonYmdHmToUtcMs,
  awaySpansFromTravelBlocks, dayInsideAwaySpan,
} = require('./habit-placer-lib');
const { isoToLondonDate, isoToLondonMinutes, workingWindow } = require('./scheduling-rules-lib');
const {
  insertPrimaryEvent, deletePrimaryEvent, verifyPrimaryEvent,
} = require('./gcal-write-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hmLabel(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function blockTitle(b) {
  return b.summary || b.title || '';
}

function parseDisplayId(b) {
  if (b.display_id != null) return Number(b.display_id);
  const m = /MC-(\d+)/i.exec(blockTitle(b));
  return m ? Number(m[1]) : null;
}

function isTravelOrBufferTitle(t, ruleMap) {
  const travel = ruleMap.title_prefix_travel || 'MC 🚗';
  const buffer = ruleMap.title_prefix_buffer || 'MC ⏳';
  return t.includes(travel) || t.includes(buffer)
    || t.includes('Travel out') || t.includes('Travel back')
    || t.includes('Prep —') || t.includes('Decompress —');
}

function isNonWorkBlock(b, ruleMap) {
  const t = blockTitle(b);
  if (!b?.start || !String(b.start).includes('T')) return true;
  if (t.includes(ruleMap.title_prefix_fixture || 'MC ⚽') || t.includes('⚽')) return true;
  if (t.includes(ruleMap.title_prefix_deadline || 'MC ⏰') || t.includes('⏰')) return true;
  if (isTravelOrBufferTitle(t, ruleMap)) return true;
  if (/MC 🛌|MC 🚫|REST —|AWAY —/.test(t)) return true;
  return false;
}

function durationMin(b) {
  const s = isoToLondonMinutes(b.start);
  const e = isoToLondonMinutes(b.end);
  if (s == null || e == null) return 30;
  return Math.max(15, e - s);
}

function homeOnlySkip(day, ruleMap, awaySpans) {
  if (String(ruleMap.buffer_scope || 'home_only') !== 'home_only') return false;
  return dayInsideAwaySpan(day, awaySpans || []);
}

/** Adjacent same-day work pairs with required decompress gap. */
function workPairs(blocks, ruleMap, awaySpans) {
  const work = (blocks || []).filter((b) => !isNonWorkBlock(b, ruleMap))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const pairs = [];
  for (let i = 0; i < work.length - 1; i += 1) {
    const a = work[i];
    const b = work[i + 1];
    const dayA = isoToLondonDate(a.start);
    const dayB = isoToLondonDate(b.start);
    if (!dayA || dayA !== dayB) continue;
    if (homeOnlySkip(dayA, ruleMap, awaySpans)) continue;
    const gap = isoToLondonMinutes(b.start) - isoToLondonMinutes(a.end);
    const need = requiredGapMins(blockTitle(a), blockTitle(b), ruleMap);
    pairs.push({
      a, b, day: dayA, gap, need, shortfall: Math.max(0, need - gap),
    });
  }
  return pairs;
}

function concreteSlideAction(pair, ruleMap) {
  const { a, b, day, need } = pair;
  if (b.slot_pinned) return null;
  const aEnd = isoToLondonMinutes(a.end);
  const dur = durationMin(b);
  const win = workingWindow(ruleMap, day);
  const newStartMin = aEnd + need;
  const newEndMin = newStartMin + dur;
  if (newStartMin < win.start_min || newEndMin > win.end_min) return null;
  const startIso = new Date(londonYmdHmToUtcMs(day, hmLabel(newStartMin))).toISOString();
  const endIso = new Date(londonYmdHmToUtcMs(day, hmLabel(newEndMin))).toISOString();
  const did = parseDisplayId(b);
  const evt = b.id || b.calendar_event_id;
  if (!evt) return null;
  if (did != null) {
    return {
      proposed_action: `MOVE MC-${did} ("${blockTitle(b)}") event ${evt} to ${day} ${hmLabel(newStartMin)}–${hmLabel(newEndMin)}. Enforce ${need}m decompress after prior block.`,
      startIso,
      endIso,
      display_id: did,
      event_id: evt,
    };
  }
  return {
    proposed_action: `MOVE Primary event ${evt} to ${startIso} – ${endIso}. Enforce ${need}m decompress after prior block.`,
    startIso,
    endIso,
    event_id: evt,
  };
}

function gapProposalEnforced(pair, ruleMap, pinnedIds) {
  const { a, b, day, gap, need } = pair;
  if (gap >= need) return null;
  if (a.slot_pinned || b.slot_pinned) return null;
  const didA = parseDisplayId(a);
  if (didA != null && pinnedIds?.has(didA)) return null;
  const slide = concreteSlideAction(pair, ruleMap);
  const labelA = didA != null ? `MC-${didA}` : blockTitle(a);
  const didB = parseDisplayId(b);
  const labelB = didB != null ? `MC-${didB}` : blockTitle(b);
  return {
    change_type: 'rule_breach',
    summary: `Rule breach: ${labelA} → ${labelB} gap ${gap}m < ${need}m decompress`,
    proposed_action: slide?.proposed_action
      || `Add ${need - gap}m gap or move ${labelB} later (no same-day slide found)`,
    reason: `decompress_gap_need=${need}; actual=${gap}`,
    related_id: `breach:gap:${a.id || didA}:${day}`,
    target_date: day,
    urgency: 'normal',
  };
}

function collectEnforcedGapProposals(blocks, ruleMap, pinnedIds, awaySpans) {
  return workPairs(blocks, ruleMap, awaySpans)
    .map((p) => gapProposalEnforced(p, ruleMap, pinnedIds))
    .filter(Boolean);
}

function gapBufferTitle(afterLabel) {
  const bare = String(afterLabel || 'block').replace(/^MC\s+[^\s]+\s+/, '').trim();
  return `MC ⏳ Decompress — after ${bare.slice(0, 60)}`;
}

/**
 * Persist decompress buffers where gap already meets need (paint protected space).
 * Tight pairs stay as MOVE proposals — never overlap-paint.
 */
async function syncGapBuffers(sb, blocks, ruleMap, {
  writeGcal = true, travelBlocks = [],
} = {}) {
  const awaySpans = awaySpansFromTravelBlocks(travelBlocks);
  const pairs = workPairs(blocks, ruleMap, awaySpans)
    .filter((p) => p.gap >= p.need && p.need > 0);
  const existing = await sb('gap_buffer_blocks?status=eq.active&select=*') || [];
  const byAfter = new Map(existing.map((r) => [String(r.after_event_id || ''), r]));
  const keep = new Set();
  const created = [];
  const updated = [];
  const failed = [];

  for (const p of pairs) {
    const afterId = String(p.a.id || p.a.calendar_event_id || '');
    if (!afterId) continue;
    keep.add(afterId);
    const startMin = isoToLondonMinutes(p.a.end);
    const endMin = startMin + p.need;
    if (endMin > isoToLondonMinutes(p.b.start)) continue;
    const startIso = new Date(londonYmdHmToUtcMs(p.day, hmLabel(startMin))).toISOString();
    const endIso = new Date(londonYmdHmToUtcMs(p.day, hmLabel(endMin))).toISOString();
    const title = gapBufferTitle(blockTitle(p.a));
    const row = byAfter.get(afterId);
    const body = {
      day: p.day,
      starts_at: startIso,
      ends_at: endIso,
      duration_min: p.need,
      after_event_id: afterId,
      before_event_id: p.b.id || p.b.calendar_event_id || null,
      after_label: blockTitle(p.a),
      before_label: blockTitle(p.b),
      status: 'active',
      updated_at: new Date().toISOString(),
    };

    if (!writeGcal) {
      if (row) {
        await sb(`gap_buffer_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('gap_buffer_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(afterId);
      }
      continue;
    }

    try {
      if (row?.calendar_event_id) {
        const v = await verifyPrimaryEvent(row.calendar_event_id, {
          summary: title, startIso, endIso,
        });
        if (v.ok) {
          body.calendar_event_id = row.calendar_event_id;
          await sb(`gap_buffer_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
          updated.push(row.id);
          continue;
        }
        try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
      }
      const ev = await insertPrimaryEvent({ summary: title, startIso, endIso });
      const v = await verifyPrimaryEvent(ev.id, { summary: title, startIso, endIso });
      if (!v.ok) {
        failed.push({ afterId, error: 'readback_mismatch' });
        continue;
      }
      body.calendar_event_id = ev.id;
      if (row) {
        await sb(`gap_buffer_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('gap_buffer_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(afterId);
      }
      await sleep(50);
    } catch (e) {
      failed.push({ afterId, error: e.message });
    }
  }

  let pruned = 0;
  for (const row of existing) {
    const key = String(row.after_event_id || '');
    if (keep.has(key)) continue;
    if (row.calendar_event_id) {
      try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
    }
    await sb(`gap_buffer_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'retired', calendar_event_id: null, updated_at: new Date().toISOString() },
    });
    pruned += 1;
  }

  return {
    adequate_pairs: pairs.length,
    created: created.length,
    updated: updated.length,
    pruned,
    failed,
    tight_pairs: workPairs(blocks, ruleMap, awaySpans).filter((p) => p.gap < p.need).length,
  };
}

module.exports = {
  workPairs,
  collectEnforcedGapProposals,
  syncGapBuffers,
  gapBufferTitle,
  concreteSlideAction,
};
