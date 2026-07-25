const {
  bankHolidaySet, workingWindow, isSchedulableDay,
  isoToLondonDate, isoToLondonMinutes,
} = require('./scheduling-rules-lib');
const { isForceBusyCalendar } = require('./gcal-lib');

function isReminderBlock(block, ruleMap) {
  const t = String(block.summary || block.title || '');
  const prefix = ruleMap.title_prefix_deadline || 'MC ⏰';
  return t.includes(prefix) || t.includes('⏰');
}

function isTravelOrBuffer(block, ruleMap) {
  const t = String(block.summary || block.title || '');
  const travel = ruleMap.title_prefix_travel || 'MC 🚗';
  const buffer = ruleMap.title_prefix_buffer || 'MC ⏳';
  return t.includes(travel) || t.includes(buffer)
    || t.includes('Travel out') || t.includes('Travel back')
    || t.includes('Prep —') || t.includes('Decompress —');
}

function isMcBlock(block) {
  if (block.is_mc === true || block.colorId === '10') return true;
  const t = String(block.summary || block.title || '');
  return t.includes('MC ') || t.includes('MC-');
}

/**
 * Informational Ipswich fixture block (MC ⚽). NOT binding: excluded from every
 * breach check (cap, window, gap, overlap, residential). It must never displace,
 * flag or cost a roll to a class or MC admin — Alan just wants to see the match.
 */
function isFixtureBlock(block, ruleMap = {}) {
  const t = String(block.summary || block.title || '');
  const prefix = ruleMap.title_prefix_fixture || 'MC ⚽';
  return t.includes(prefix) || t.includes('⚽');
}

/** Day has a real commitment matching window_overrun_blocked_by (justifies overrun). */
function dayHasJustifyingBusy(day, busyEvents, ruleMap) {
  const keys = String(ruleMap.window_overrun_blocked_by || '')
    .split(',').map((s) => s.trim().toLowerCase().replace(/_/g, ' ')).filter(Boolean);
  if (!keys.length || !busyEvents?.length) return false;
  const aliases = {
    workshop: ['workshop', 'woodland', 'residential'],
    class: ['class', 'lesson', 'tuition'],
    tuition: ['tuition', 'mentoring', '1-2-1', '121'],
    'client shoot': ['shoot', 'commission', 'client'],
    'personal block': ['block out', 'personal', 'birthday', 'holiday'],
  };
  return busyEvents.some((e) => {
    if (e.start?.date) {
      if (!(day >= e.start.date && day < (e.end?.date || e.start.date))) return false;
    } else {
      const start = typeof e.start === 'string' ? e.start : e.start?.dateTime;
      if (!start || isoToLondonDate(start) !== day) return false;
    }
    const blob = `${e.summary || ''} ${e.title || ''}`.toLowerCase();
    return keys.some((k) => {
      if (blob.includes(k)) return true;
      return (aliases[k] || []).some((a) => blob.includes(a));
    });
  });
}

function breachesForBlock(block, ruleMap, holidays, busyEvents = []) {
  const date = isoToLondonDate(block.start);
  const endDate = isoToLondonDate(block.end);
  const win = workingWindow(ruleMap, date);
  const startMin = isoToLondonMinutes(block.start);
  const endMin = endDate === date ? isoToLondonMinutes(block.end) : win.end_min;
  const reminder = isReminderBlock(block, ruleMap);
  // Travel/buffers attach to real sessions (often evenings/sunrise). Reminders may
  // be window-exempt per Alan. Justifying busy (workshop/class/…) covers evening
  // workshop-adjacent admin. Neither is an admin-window breach.
  const windowExempt = isTravelOrBuffer(block, ruleMap)
    || (ruleMap.deadline_reminder_window_exempt === 'true' && reminder)
    || dayHasJustifyingBusy(date, busyEvents, ruleMap);
  const overrunMax = Number(ruleMap.window_overrun_max_min || 0);
  const reasons = [];
  if (!isSchedulableDay(date, ruleMap, holidays)) reasons.push('non_schedulable_day');
  if (ruleMap.exclude_bank_holidays === 'true' && holidays.has(date)) reasons.push('bank_holiday');
  if (!windowExempt) {
    if (startMin != null && win.start_min != null && startMin < win.start_min) {
      reasons.push(`starts_before_${win.start}`);
    }
    if (endMin != null && win.end_min != null && endMin > win.end_min) {
      const over = endMin - win.end_min;
      // ≤ window_overrun_max_min past close = tolerance, not a breach (Alan §7a).
      if (over > overrunMax) reasons.push(`ends_after_${win.end}`);
    }
  }
  return {
    date, reasons, win, reminder, duration: Math.max(0, (endMin || 0) - (startMin || 0)),
  };
}

function shiftIso(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

/** Expand a fixture to kick-off−buffer … end+buffer (reads fixture_buffer_min). */
function expandFixtureWindow(e, bufferMin) {
  const start = e.start?.dateTime || e.start;
  const end = e.end?.dateTime || e.end;
  if (!start || !end || !String(start).includes('T')) return null;
  return {
    id: e.id,
    summary: e.summary,
    start,
    end,
    busy_start: shiftIso(start, -bufferMin),
    busy_end: shiftIso(end, bufferMin),
    force_busy: true,
    buffer_min: bufferMin,
    _calendarId: e._calendarId,
  };
}

function proposeSlot(date, win, durationMin) {
  const startH = Math.floor(win.start_min / 60);
  const startM = win.start_min % 60;
  const endTotal = win.start_min + durationMin;
  const eh = Math.floor(endTotal / 60);
  const em = endTotal % 60;
  return `Move to ${date} ${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}–${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')} (next legal slot honouring ${durationMin}m block)`;
}

function hmLabel(mins) {
  if (mins == null) return '?';
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function windowProposal(b, br) {
  const did = Number(b.display_id);
  const startHm = isoToLondonMinutes(b.start);
  const endHm = isoToLondonMinutes(b.end);
  const why = br.reasons.find((r) => r.startsWith('starts_before') || r.startsWith('ends_after'))
    || br.reasons[0]
    || 'window';
  const summary = why.startsWith('ends_after')
    ? `Rule breach: MC-${did || '?'} ends ${hmLabel(endHm)}, after ${br.win.end} window`
    : `Rule breach: MC-${did || '?'} starts ${hmLabel(startHm)}, before ${br.win.start} window`;
  return {
    change_type: 'rule_breach',
    summary,
    proposed_action: proposeSlot(br.date, br.win, br.duration || 45),
    reason: br.reasons.join('; '),
    related_id: `breach:${did || b.id || 'x'}:${br.date}`,
    target_date: br.date,
    urgency: 'normal',
  };
}

function capProposal(day, total, cap) {
  if (total > cap.breachMin) {
    return {
      change_type: 'rule_breach',
      summary: `Rule breach: ${total}m MC work on ${day} exceeds ${cap.capMin}m cap +${cap.tolMin}m tolerance`,
      proposed_action: `Spread blocks across following legal days — over the ${cap.breachMin}m hard limit`,
      reason: `daily_task_cap_min=${cap.capMin}; tolerance=${cap.tolMin}; hard_limit=${cap.breachMin}`,
      related_id: `breach:cap:${day}`,
      target_date: day,
      urgency: 'normal',
    };
  }
  if (total > cap.capMin) {
    return {
      change_type: 'cap_over_target',
      summary: `Over target: ${total}m MC work on ${day} (target ${cap.capMin}m, within ${cap.tolMin}m tolerance — not a breach)`,
      proposed_action: `Acceptable only if it avoids a roll; otherwise trim toward ${cap.capMin}m. Placer must not fill to ${cap.breachMin}m by default.`,
      reason: `over target ${cap.capMin}; under hard limit ${cap.breachMin}`,
      related_id: `over_target:cap:${day}`,
      target_date: day,
      urgency: 'low',
    };
  }
  return null;
}

function gapProposal(a, b, gapMin, pinnedIds) {
  if (a.slot_pinned || b.slot_pinned) return null;
  if (isoToLondonDate(a.end) !== isoToLondonDate(b.start)) return null;
  const gap = isoToLondonMinutes(b.start) - isoToLondonMinutes(a.end);
  if (gap >= gapMin) return null;
  const did = Number(a.display_id);
  if (pinnedIds.has(did)) return null;
  return {
    change_type: 'rule_breach',
    summary: `Rule breach: MC-${did || '?'} → MC-${b.display_id || '?'} gap ${gap}m < ${gapMin}m decompress`,
    proposed_action: `Add ${gapMin - gap}m gap or move MC-${b.display_id || '?'} later`,
    reason: `decompress_after_task_min=${gapMin}`,
    related_id: `breach:gap:${did || a.id}:${isoToLondonDate(a.start)}`,
    target_date: isoToLondonDate(a.start),
    urgency: 'normal',
  };
}

function overlapProposal(a, b) {
  const aS = Date.parse(a.start); const aE = Date.parse(a.end);
  const bS = Date.parse(b.start); const bE = Date.parse(b.end);
  if (!(aS < bE && bS < aE)) return null;
  const day = isoToLondonDate(a.start);
  const mins = Math.round((Math.min(aE, bE) - Math.max(aS, bS)) / 60000);
  const labelA = a.display_id != null ? `MC-${a.display_id}` : (a.summary || a.title || a.id);
  const labelB = b.display_id != null ? `MC-${b.display_id}` : (b.summary || b.title || b.id);
  return {
    change_type: 'rule_breach',
    summary: `Rule breach: ${labelA} overlaps ${labelB} by ${mins}m on ${day}`,
    proposed_action: `Move one of the overlapping blocks so they do not share time`,
    reason: `mc_vs_mc_overlap=${mins}m`,
    related_id: `breach:overlap:${a.id || a.display_id}:${b.id || b.display_id}:${day}`,
    target_date: day,
    urgency: 'high',
  };
}

function residentialProposal(mc, busy) {
  const day = isoToLondonDate(mc.start);
  const label = mc.display_id != null ? `MC-${mc.display_id}` : (mc.summary || mc.title || mc.id);
  return {
    change_type: 'rule_breach',
    summary: `Rule breach: ${label} lands on busy/residential day ${day} (${busy.summary || busy.title || 'all-day'})`,
    proposed_action: `Move ${label} off ${day} — busy map excludes MC blocks; this day is blocked by a real commitment`,
    reason: `residential_or_all_day:${busy.id || busy.summary}`,
    related_id: `breach:residential:${mc.id || mc.display_id}:${day}`,
    target_date: day,
    urgency: 'high',
  };
}

function resolveHolidays(injectedHolidays) {
  if (injectedHolidays?.size) return injectedHolidays;
  const yr = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric',
  }).format(new Date()));
  return bankHolidaySet(yr - 1, yr + 1);
}

function dayBlockedByBusy(day, busyEvents) {
  return (busyEvents || []).find((e) => {
    if (e.start?.date) {
      // all-day: end is exclusive
      return day >= e.start.date && day < (e.end?.date || e.start.date);
    }
    if (!e.start && e.date) return e.date === day; // fixture shape
    return false;
  });
}

function collectOverlapProposals(mcBlocks, pinnedIds) {
  const out = [];
  const norm = mcBlocks
    .map((b) => ({
      ...b,
      start: typeof b.start === 'string' ? b.start : (b.start?.dateTime || b.start),
      end: typeof b.end === 'string' ? b.end : (b.end?.dateTime || b.end),
    }))
    .filter((b) => b.start && b.end && String(b.start).includes('T'))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  for (let i = 0; i < norm.length; i += 1) {
    for (let j = i + 1; j < norm.length; j += 1) {
      if (Date.parse(norm[j].start) >= Date.parse(norm[i].end)) break;
      if (pinnedIds.has(Number(norm[i].display_id)) || pinnedIds.has(Number(norm[j].display_id))) continue;
      const p = overlapProposal(norm[i], norm[j]);
      if (p) out.push(p);
    }
  }
  return out;
}

function collectResidentialProposals(mcBlocks, busyEvents, ruleMap, pinnedIds) {
  const out = [];
  for (const b of mcBlocks) {
    if (pinnedIds.has(Number(b.display_id))) continue;
    if (isTravelOrBuffer(b, ruleMap)) continue;
    const start = typeof b.start === 'string' ? b.start : b.start?.dateTime;
    if (!start) continue;
    const day = isoToLondonDate(start);
    const hit = dayBlockedByBusy(day, busyEvents);
    if (hit) out.push(residentialProposal({ ...b, start }, hit));
  }
  return out;
}

/**
 * @param {object[]} blocks MC blocks (and optionally mixed events — MC filtered inside)
 * @param {object} ruleMap
 * @param {Set} pinnedIds
 * @param {Set|null} injectedHolidays
 * @param {object[]} busyEvents real commitments only — NEVER MC blocks
 */
function normalizeMcBlocks(blocks, ruleMap) {
  return (blocks || [])
    .filter(isMcBlock)
    .filter((b) => !isFixtureBlock(b, ruleMap)) // fixtures never adjudicated
    .map((b) => ({
      ...b,
      start: typeof b.start === 'string' ? b.start : (b.start?.dateTime || b.start),
      end: typeof b.end === 'string' ? b.end : (b.end?.dateTime || b.end),
      summary: b.summary || b.title,
    }));
}

/** Window breaches (returned) + per-day task minutes (accumulated into byDay). */
function collectWindowProposals(mcBlocks, ruleMap, holidays, pinnedIds, byDay, busyEvents) {
  const exemptReminders = ruleMap.deadline_reminder_window_exempt === 'true';
  const out = [];
  for (const b of mcBlocks) {
    if (b.slot_pinned || pinnedIds.has(Number(b.display_id))) continue;
    if (!b.start || !String(b.start).includes('T')) continue;
    const br = breachesForBlock(b, ruleMap, holidays, busyEvents);
    if (!br.reasons.length) {
      if (!(exemptReminders && br.reminder) && !isTravelOrBuffer(b, ruleMap)) {
        byDay[br.date] = (byDay[br.date] || 0) + br.duration;
      }
      continue;
    }
    // Only raise a window proposal when a window reason remains (day/holiday
    // reasons alone are handled elsewhere / still useful as window row).
    if (br.reasons.some((r) => r.startsWith('starts_before') || r.startsWith('ends_after')
      || r === 'non_schedulable_day' || r === 'bank_holiday')) {
      out.push(windowProposal(b, br));
    }
  }
  return out;
}

function collectGapProposals(mcBlocks, gapMin, pinnedIds) {
  const out = [];
  const sorted = [...mcBlocks]
    .filter((b) => b.start && String(b.start).includes('T'))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const gp = gapProposal(sorted[i], sorted[i + 1], gapMin, pinnedIds);
    if (gp) out.push(gp);
  }
  return out;
}

function buildRuleBreachProposals(blocks, ruleMap, pinnedIds, injectedHolidays, busyEvents = []) {
  const cap = {
    capMin: Number(ruleMap.daily_task_cap_min || 240),
    tolMin: Number(ruleMap.daily_task_cap_tolerance_min || 0),
  };
  cap.breachMin = cap.capMin + cap.tolMin;
  const gapMin = Number(ruleMap.decompress_after_task_min || 30);
  const holidays = resolveHolidays(injectedHolidays);
  const byDay = {};
  const mcBlocks = normalizeMcBlocks(blocks, ruleMap);
  const proposals = collectWindowProposals(mcBlocks, ruleMap, holidays, pinnedIds, byDay, busyEvents);

  for (const [day, total] of Object.entries(byDay)) {
    const cp = capProposal(day, total, cap);
    if (cp) proposals.push(cp);
  }

  proposals.push(...collectGapProposals(mcBlocks, gapMin, pinnedIds));
  proposals.push(...collectOverlapProposals(mcBlocks, pinnedIds));
  proposals.push(...collectResidentialProposals(mcBlocks, busyEvents, ruleMap, pinnedIds));
  // Fixtures are INFORMATIONAL — they never flag or displace MC work, so no
  // fixture-vs-MC breach pass here (Alan's 2026-07-25 ruling).

  return proposals;
}

/**
 * Split a mixed calendar dump into MC blocks vs busy-map inputs vs fixtures.
 * MC never enters busy. Ipswich (force-busy) events are routed to `fixtures`
 * (informational) and NEVER into the busy map — a fixture must not block or flag
 * a class or MC admin (Alan's 2026-07-25 ruling). MC ⚽ blocks are dropped from
 * the busy map for the same reason.
 */
function splitMcAndBusy(events, ruleMap = {}) {
  const mc = [];
  const busy = [];
  const fixtures = [];
  for (const e of events || []) {
    const forceBusy = isForceBusyCalendar(e._calendarId);
    if (forceBusy) {
      const start = e.start?.dateTime || e.start;
      const end = e.end?.dateTime || e.end;
      if (start && String(start).includes('T')) {
        fixtures.push({
          id: e.id, summary: e.summary, start, end, _calendarId: e._calendarId,
        });
      }
      continue;
    }
    if (e.transparency === 'transparent') continue;

    if (isMcBlock(e)) {
      mc.push({
        id: e.id,
        summary: e.summary,
        title: e.summary,
        colorId: e.colorId,
        display_id: e.display_id,
        slot_pinned: e.slot_pinned,
        is_mc: true,
        start: e.start?.dateTime || e.start,
        end: e.end?.dateTime || e.end,
      });
      continue;
    }

    if (e.start?.date) {
      busy.push({ id: e.id, summary: e.summary, start: e.start, end: e.end });
    } else if (e.start?.dateTime || (typeof e.start === 'string' && String(e.start).includes('T'))) {
      busy.push({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start,
        end: e.end?.dateTime || e.end,
      });
    }
  }
  return { mc, busy, fixtures };
}

module.exports = {
  buildRuleBreachProposals,
  splitMcAndBusy,
  expandFixtureWindow,
  isReminderBlock,
  isMcBlock,
  isFixtureBlock,
  isTravelOrBuffer,
};
