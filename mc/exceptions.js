/**
 * Scheduling-tab "Needs your decision" view — display enrichment + queue helpers.
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
export function parseOverlapPair(summary) {
  const m = String(summary).match(/Rule breach:\s*(.+?)\s+overlaps\s+(.+?)(?:\s+by\s+\d+m)?(?:\s+on\s+\d{4}-\d{2}-\d{2})?$/i);
  if (!m) return null;
  return { a: m[1].trim(), b: m[2].trim() };
}

/** related_id = breach:overlap:eventA:eventB:YYYY-MM-DD */
export function parseOverlapRelated(relatedId) {
  const m = String(relatedId || '').match(
    /^breach:overlap:([^:]+):([^:]+):(\d{4}-\d{2}-\d{2})$/,
  );
  if (!m) return null;
  return { idA: m[1], idB: m[2], day: m[3] };
}

function parseCapDay(summary, relatedId, targetDate) {
  const m = String(summary).match(/(\d+)m MC work on (\d{4}-\d{2}-\d{2})/);
  if (m) return { minutes: Number(m[1]), day: m[2] };
  const id = String(relatedId || '').match(/breach:cap:(\d{4}-\d{2}-\d{2})/);
  return { minutes: null, day: id?.[1] || targetDate || '—' };
}

function shortTitle(s) {
  const t = String(s || '');
  const parts = t.split(' · ');
  const last = parts[parts.length - 1] || t;
  return last.length > 48 ? `${last.slice(0, 45)}…` : last;
}

function enrichException(p) {
  const kind = exceptionKind(p);
  const pair = kind === 'overlap' ? parseOverlapPair(p.summary) : null;
  const overlapIds = kind === 'overlap' ? parseOverlapRelated(p.related_id) : null;
  const base = {
    id: p.id,
    date: p.target_date || overlapIds?.day || null,
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
    titleA: pair?.a || null,
    titleB: pair?.b || null,
    shortA: pair ? shortTitle(pair.a) : null,
    shortB: pair ? shortTitle(pair.b) : null,
    eventIdA: overlapIds?.idA || null,
    eventIdB: overlapIds?.idB || null,
  };

  if (kind === 'overlap') {
    const clash = pair
      ? `${pair.a}\n↔ ${pair.b}`
      : String(p.summary || '').replace(/^Rule breach:\s*/i, '');
    return {
      ...base,
      clashing: clash,
      why: 'Two MC blocks share the same time — pick which one moves.',
      options: pair
        ? `Move “${shortTitle(pair.a)}” · or move “${shortTitle(pair.b)}” · or Dismiss`
        : 'Pick one block to move · or Dismiss',
    };
  }

  if (kind === 'cap') {
    const { minutes, day } = parseCapDay(p.summary, p.related_id, p.target_date);
    const over = minutes != null ? `${minutes}m` : 'over';
    return {
      ...base,
      date: day,
      clashing: `${over} of MC work booked on ${day}`,
      why: 'Hard cap is 270m (240 + 30). Orange blocks count. Move enough off this day to clear the overload.',
      options: 'Move blocks off this day · or Dismiss',
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
        ? `Decompress gap under ${gapM}m, but block IDs were missing.`
        : `Gap under the ${gapM}m decompress rule; no concrete new slot proposed.`,
      options: 'Open Diary and add gap / move later block · or Dismiss',
    };
  }

  if (kind === 'unplaceable') {
    const habit = (String(p.summary).match(/Missed habit:\s*(.+)$/i) || [])[1] || 'habit';
    const ideal = p.target_date || 'ideal day';
    return {
      ...base,
      clashing: `${habit} (ideal ${ideal})`,
      why: 'Time-critical habit — must roll earlier, not later.',
      options: 'Do ASAP · Skip · or Dismiss',
    };
  }

  return {
    ...base,
    clashing: p.summary || '—',
    why: p.reason || 'No single concrete slot was computed.',
    options: p.proposed_action || 'Decide manually · or Dismiss',
  };
}

export function buildExceptions(pending) {
  return (pending || []).filter(isException).map(enrichException);
}

/** Sort soonest first; undated last. */
export function sortExceptions(exceptions) {
  return [...(exceptions || [])].sort((a, b) => {
    const da = a.date || '9999-99-99';
    const db = b.date || '9999-99-99';
    if (da !== db) return da.localeCompare(db);
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * @param {object[]} exceptions
 * @param {'4w'|'8w'|'all'} horizon
 * @param {string} todayYmd London YMD
 */
export function filterExceptionsByHorizon(exceptions, horizon, todayYmd) {
  const sorted = sortExceptions(exceptions);
  if (horizon === 'all') {
    return { visible: sorted, total: sorted.length, horizon };
  }
  const weeks = horizon === '8w' ? 8 : 4;
  const end = addDaysYmd(todayYmd, weeks * 7 - 1);
  const visible = sorted.filter((ex) => {
    if (!ex.date) return true;
    return ex.date >= todayYmd && ex.date <= end;
  });
  return { visible, total: sorted.length, horizon, from: todayYmd, to: end };
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function londonTodayYmd() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}
