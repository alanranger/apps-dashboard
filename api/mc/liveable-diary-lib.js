/**
 * Liveable-diary validation — LIVE Google events, not mirror-only reconcile.
 * Green only when the board is physically liveable under existing rules.
 */
const { isoToLondonDate, isoToLondonMinutes, workingWindow } = require('./scheduling-rules-lib');
const { isForceBusyCalendar } = require('./gcal-lib');
const {
  buildBusyIntervals, dayBlockedForHabits, awaySpansFromTravelBlocks,
  teachingDaySpansFromEvents, restDaySpansFromWorkshopEvents,
} = require('./habit-placer-lib');

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function isMcTitle(summary) {
  const t = String(summary || '');
  return t.includes('MC ') || t.includes('MC-') || /^MC\b/u.test(t);
}

function eventBounds(e) {
  if (e.start?.date && !e.start?.dateTime) {
    const startMs = Date.parse(`${e.start.date}T00:00:00Z`);
    const endDay = e.end?.date || e.start.date;
    const endMs = Date.parse(`${endDay}T00:00:00Z`);
    return { startMs, endMs, allDay: true, day: e.start.date };
  }
  const startRaw = e.start?.dateTime;
  const endRaw = e.end?.dateTime || startRaw;
  if (!startRaw) return null;
  const startMs = Date.parse(startRaw);
  const endMs = Date.parse(endRaw);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    startMs, endMs, allDay: false, day: isoToLondonDate(startRaw),
  };
}

function countsAsCommitment(e) {
  if (!e || e.status === 'cancelled') return false;
  const cal = e._calendarId || e.calendarId || 'primary';
  const force = isForceBusyCalendar(cal);
  if (e.transparency === 'transparent' && !force) return false;
  return !!eventBounds(e);
}

/**
 * Validate live Google events (+ optional travel DB) for a liveable diary.
 */
function validateLiveableDiary({
  events = [], travelBlocks = [], ruleMap = {}, restDb = [], limit = 100,
} = {}) {
  const violations = [];
  const commits = (events || []).filter(countsAsCommitment).map((e) => {
    const b = eventBounds(e);
    return {
      id: e.id,
      summary: e.summary || '',
      cal: e._calendarId || e.calendarId || 'primary',
      ...b,
      isMc: isMcTitle(e.summary),
    };
  }).filter((c) => c.startMs != null);

  // —— Overlaps (MC commitment vs anything opaque, or two MC) ——
  // Personal×personal (Cleaner×Haircut) is not an MC engine fault — skip.
  // Fixture flanks (MC ⚽) always stay; overlap with existing non-MC is OK.
  // Other MC work inside a fixture flank window IS a fault.
  const isFixtureFlank = (s) => /^MC\s*⚽/u.test(String(s || '')) || String(s || '').includes('MC ⚽');
  for (let i = 0; i < commits.length; i += 1) {
    for (let j = i + 1; j < commits.length; j += 1) {
      const a = commits[i];
      const b = commits[j];
      if (a.allDay || b.allDay) continue;
      if (!overlaps(a.startMs, a.endMs, b.startMs, b.endMs)) continue;
      if (a.id === b.id) continue;
      if (!a.isMc && !b.isMc) continue;
      const aFix = isFixtureFlank(a.summary);
      const bFix = isFixtureFlank(b.summary);
      if (aFix && bFix) continue;
      if ((aFix && !b.isMc) || (bFix && !a.isMc)) continue;
      violations.push({
        rule: 'overlap',
        day: a.day,
        a: { id: a.id, summary: a.summary, cal: a.cal },
        b: { id: b.id, summary: b.summary, cal: b.cal },
      });
    }
  }

  // —— Duplicate MC (same title + start within 2 min on primary) ——
  const bySlot = new Map();
  for (const c of commits) {
    if (!c.isMc || c.allDay || c.cal !== 'primary') continue;
    const key = `${c.summary}|${Math.round(c.startMs / 120000)}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(c);
  }
  for (const [, group] of bySlot) {
    if (group.length < 2) continue;
    violations.push({
      rule: 'duplicate',
      day: group[0].day,
      count: group.length,
      summary: group[0].summary,
      ids: group.map((g) => g.id),
    });
  }

  // —— Blocked days (habits/tasks MC on rest/away/teaching whole-day) ——
  const awaySpans = awaySpansFromTravelBlocks(travelBlocks || []);
  const teachingSpans = teachingDaySpansFromEvents(events || [], ruleMap);
  const restSpans = restDaySpansFromWorkshopEvents(events || [], ruleMap)
    .concat((restDb || []).map((r) => ({
      startDay: r.rest_date, endDay: r.rest_date, restDay: r.rest_date,
      kind: 'rest_after_workshop',
      startMs: 0, endMs: 0,
    })));
  const blocked = awaySpans.concat(teachingSpans).concat(restSpans);
  for (const c of commits) {
    if (!c.isMc || !c.day || c.allDay) continue;
    // Travel/rest banners belong on away/rest edge days — not violations.
    if (/REST|AWAY|⚽|Travel |Prep —|Decompress/i.test(c.summary)) continue;
    // Hotel/deadline reminders may legally sit on blocked days (rule exempt).
    if (String(ruleMap.deadline_reminder_window_exempt) === 'true'
      && /MC ⏰|deadline|Room release|cancel by/i.test(c.summary)) {
      continue;
    }
    if (dayBlockedForHabits(c.day, blocked)) {
      violations.push({
        rule: 'blocked_day',
        day: c.day,
        summary: c.summary,
        id: c.id,
      });
    }
  }

  // —— After-hours non-pinned MC work (buffers/travel exempt) ——
  const win = workingWindow(ruleMap);
  const startBound = win?.start_min ?? 8 * 60;
  const endBound = win?.end_min ?? 18 * 60;
  for (const c of commits) {
    if (!c.isMc || c.allDay || c.cal !== 'primary') continue;
    if (/Travel|Decompress|Prep —|REST|AWAY|⚽/i.test(c.summary)) continue;
    const s = isoToLondonMinutes(new Date(c.startMs).toISOString());
    const e = isoToLondonMinutes(new Date(c.endMs).toISOString());
    if (s < startBound || e > endBound) {
      violations.push({
        rule: 'after_hours',
        day: c.day,
        summary: c.summary,
        id: c.id,
        window: `${startBound}-${endBound}`,
      });
    }
  }

  // —— Travel contradictions (DB) ——
  const travels = (travelBlocks || []).slice().sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  for (let i = 0; i < travels.length; i += 1) {
    for (let j = i + 1; j < travels.length; j += 1) {
      const a = travels[i];
      const b = travels[j];
      const a0 = Date.parse(a.starts_at);
      const a1 = Date.parse(a.ends_at);
      const b0 = Date.parse(b.starts_at);
      const b1 = Date.parse(b.ends_at);
      if (!overlaps(a0, a1, b0, b1)) continue;
      violations.push({
        rule: 'travel_overlap',
        a: { id: a.id, type: a.block_type, venue: a.venue_name, start: a.starts_at },
        b: { id: b.id, type: b.block_type, venue: b.venue_name, start: b.starts_at },
      });
    }
    if (!travels[i].workshop_row_key && !travels[i].workshop_title) {
      violations.push({
        rule: 'travel_orphan',
        id: travels[i].id,
        type: travels[i].block_type,
        venue: travels[i].venue_name,
      });
    }
  }

  // Cap sample via busy map length proxy — detailed cap stays in placer proof
  const busy = buildBusyIntervals(events || [], ruleMap);

  const byRule = {};
  for (const v of violations) {
    byRule[v.rule] = (byRule[v.rule] || 0) + 1;
  }

  return {
    ok: violations.length === 0,
    violation_count: violations.length,
    by_rule: byRule,
    violations: limit == null ? violations : violations.slice(0, limit),
    commitment_count: commits.length,
    busy_interval_count: busy.length,
  };
}

module.exports = {
  validateLiveableDiary,
  countsAsCommitment,
  isMcTitle,
  eventBounds,
};
