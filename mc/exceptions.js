/**
 * Scheduling-tab "Needs your decision" view — display enrichment only.
 * Filters pending_diary_changes to unresolved exceptions (no single concrete slot).
 * Does not mutate data or write Calendar.
 */

/** True when the proposal does not resolve to one concrete destination slot. */
export function isException(p) {
  const action = String(p.proposed_action || '');
  const reason = String(p.reason || '');
  const summary = String(p.summary || '');
  if (/^UNPLACEABLE/i.test(action)) return true;
  if (/mc_vs_mc_overlap/i.test(reason) || /Move one of the overlapping/i.test(action)) return true;
  if (/breach:cap:/.test(p.related_id || '') || /Spread blocks across following/i.test(action)) return true;
  if (/decompress_after_task_min/i.test(reason) || /Add \d+m gap or move/i.test(action)) {
    // Unresolved when target is unidentified or no concrete slot given.
    return /MC-\?/.test(summary) || /MC-\?/.test(action) || !/Move to \d{4}-\d{2}-\d{2}/i.test(action);
  }
  return false;
}

function exceptionKind(p) {
  const action = String(p.proposed_action || '');
  const reason = String(p.reason || '');
  if (/^UNPLACEABLE/i.test(action)) return 'unplaceable';
  if (/mc_vs_mc_overlap/i.test(reason) || /Move one of the overlapping/i.test(action)) return 'overlap';
  if (/breach:cap:/.test(p.related_id || '') || /Spread blocks across/i.test(action)) return 'cap';
  if (/decompress_after_task_min/i.test(reason) || /Add \d+m gap/i.test(action)) return 'gap';
  return 'other';
}

/** Pull "A overlaps B" titles from the summary when present. */
function parseOverlapPair(summary) {
  const m = String(summary).match(/Rule breach:\s*(.+?)\s+overlaps\s+(.+?)(?:\s+by\s+\d+m)?$/i);
  if (!m) return null;
  return { a: m[1].trim(), b: m[2].trim() };
}

function parseCapDay(summary, relatedId, targetDate) {
  const m = String(summary).match(/(\d+)m MC work on (\d{4}-\d{2}-\d{2})/);
  if (m) return { minutes: Number(m[1]), day: m[2] };
  const id = String(relatedId || '').match(/breach:cap:(\d{4}-\d{2}-\d{2})/);
  return { minutes: null, day: id?.[1] || targetDate || '—' };
}

function enrichException(p) {
  const kind = exceptionKind(p);
  const base = {
    id: p.id,
    date: p.target_date || null,
    type: kind,
    typeLabel: {
      overlap: 'Overlap',
      cap: 'Cap overload',
      gap: 'Gap too small',
      unplaceable: 'Unplaceable habit',
      other: 'Needs decision',
    }[kind],
    urgency: p.urgency,
    raw: p,
  };

  if (kind === 'overlap') {
    const pair = parseOverlapPair(p.summary);
    const clash = pair
      ? `${pair.a}\n↔ ${pair.b}`
      : String(p.summary || '').replace(/^Rule breach:\s*/i, '');
    return {
      ...base,
      clashing: clash,
      why: 'Two MC blocks share the same time. Rules prefer lower priority to give way, but the detector does not auto-pick which one moves when priorities tie or both are pinned-adjacent.',
      options: pair
        ? `Move “${shortTitle(pair.a)}” to the next free legal slot · or move “${shortTitle(pair.b)}” · or keep both and Dismiss if intentional`
        : 'Pick one block to move to the next free legal slot · or Dismiss if intentional',
    };
  }

  if (kind === 'cap') {
    const { minutes, day } = parseCapDay(p.summary, p.related_id, p.target_date);
    const over = minutes != null ? `${minutes}m` : 'over';
    return {
      ...base,
      date: day,
      clashing: `${over} of MC work on ${day} (hard limit 270m = 240 + 30 tolerance)`,
      why: 'Day is over the hard cap. Spreading needs a target day/slots the placer has not chosen yet.',
      options: 'Move the lowest-priority block(s) on that day to the next legal day with spare capacity · or accept the over-cap and Dismiss · or split a long block',
    };
  }

  if (kind === 'gap') {
    const gapM = (String(p.reason).match(/decompress_after_task_min=(\d+)/) || [])[1] || '30';
    const unnamed = /MC-\?/.test(p.summary || '') || /MC-\?/.test(p.proposed_action || '');
    return {
      ...base,
      clashing: unnamed
        ? `Two adjacent MC blocks on ${p.target_date || 'that day'} (titles not resolved — shown as MC-?)`
        : String(p.summary || '').replace(/^Rule breach:\s*/i, ''),
      why: unnamed
        ? `Decompress gap under ${gapM}m, but one or both block IDs were missing from the calendar event — cannot name which to move.`
        : `Gap under the ${gapM}m decompress rule; no concrete new slot proposed.`,
      options: unnamed
        ? 'Open the diary on that date, identify the pair, add the decompress gap or move the later block · or Dismiss'
        : 'Add the missing decompress gap · or move the later block later the same day · or Dismiss',
    };
  }

  if (kind === 'unplaceable') {
    const habit = (String(p.summary).match(/Missed habit:\s*(.+)$/i) || [])[1] || 'habit';
    const ideal = p.target_date || 'ideal day';
    return {
      ...base,
      clashing: `${habit} (ideal ${ideal})`,
      why: 'Time-critical habit — must roll earlier, not later. Ideal day has passed and no legal earlier slot remains open.',
      options: 'Do it ASAP today (then Mark done on Recurring) · or Skip this occurrence · or Dismiss if already handled outside MC',
    };
  }

  return {
    ...base,
    clashing: p.summary || '—',
    why: p.reason || 'No single concrete slot was computed.',
    options: p.proposed_action || 'Decide manually · or Dismiss',
  };
}

function shortTitle(s) {
  const t = String(s || '');
  // Prefer the human title after the last " · "
  const parts = t.split(' · ');
  const last = parts[parts.length - 1] || t;
  return last.length > 48 ? `${last.slice(0, 45)}…` : last;
}

export function buildExceptions(pending) {
  return (pending || []).filter(isException).map(enrichException);
}
