/**
 * Persist rule-driven calendar layers as DB masters + GCal mirror:
 *   rest_day_blocks, away_day_blocks, fixture_blocks (before/after link),
 *   gap_buffer_blocks (task→task decompress strips).
 * Idempotent upsert + prune; read-back verify before storing calendar_event_id.
 */
const {
  awaySpansFromTravelBlocks,
  restDayRuleEnabled, multidayWorkshopRestRows,
} = require('./habit-placer-lib');
const { addDaysYmd, londonToday } = require('./diary-lib');
const { fetchHorizonEvents } = require('./gcal-lib');
const {
  insertPrimaryAllDayEvent, insertPrimaryEvent,
  deletePrimaryEvent, verifyPrimaryEvent,
} = require('./gcal-write-lib');
const { restDayGcalTitle, awaySpanGcalTitle } = require('./gcal-title-lib');
const { flankWindows, matchLabel } = require('./fixture-coverage-lib');
const { ruleMapFromRows, isoToLondonDate } = require('./scheduling-rules-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function allDayMatches(e, startDate, endExclusive, title) {
  if (!e?.start?.date) return false;
  if (e.start.date !== startDate) return false;
  if ((e.end?.date || '') !== endExclusive) return false;
  return String(e.summary || '') === String(title);
}

/** Delete other primary all-day clones for the same slot (Push race leftovers). */
async function purgeSiblingAllDay(events, {
  startDate, endExclusive, keepId, titlePrefixRe,
}) {
  let purged = 0;
  for (const e of events || []) {
    if (e._calendarId && e._calendarId !== 'primary') continue;
    if (!e.start?.date || e.id === keepId) continue;
    if (e.start.date !== startDate) continue;
    if ((e.end?.date || '') !== endExclusive) continue;
    const t = String(e.summary || '');
    if (titlePrefixRe && !titlePrefixRe.test(t)) continue;
    try {
      await deletePrimaryEvent(e.id);
      purged += 1;
      await sleep(40);
    } catch (_) { /* ignore */ }
  }
  return purged;
}

/**
 * Link existing live all-day if ok; only insert when missing.
 * Never delete+recreate a healthy master (that race created triple AWAYs).
 */
async function ensureAllDayLinked({
  row, title, startDate, endExclusive, events, titlePrefixRe,
}) {
  const expect = { summary: title, startDate, endDateExclusive: endExclusive };
  if (row?.calendar_event_id) {
    const v = await verifyPrimaryEvent(row.calendar_event_id, expect);
    if (v.ok) {
      const purged = await purgeSiblingAllDay(events, {
        startDate, endExclusive, keepId: row.calendar_event_id, titlePrefixRe,
      });
      return { eventId: row.calendar_event_id, created: false, purged };
    }
  }
  const live = (events || []).find((e) => allDayMatches(e, startDate, endExclusive, title));
  if (live?.id) {
    const purged = await purgeSiblingAllDay(events, {
      startDate, endExclusive, keepId: live.id, titlePrefixRe,
    });
    return { eventId: live.id, created: false, purged };
  }
  const ev = await insertPrimaryAllDayEvent({
    summary: title, startDate, endDateExclusive: endExclusive,
  });
  const v = await verifyPrimaryEvent(ev.id, expect);
  if (!v.ok) {
    const err = new Error('readback_mismatch');
    err.verify = v;
    throw err;
  }
  const purged = await purgeSiblingAllDay(events, {
    startDate, endExclusive, keepId: ev.id, titlePrefixRe,
  });
  return { eventId: ev.id, created: true, purged };
}

async function syncRestDays(sb, events, ruleMap, { writeGcal = true } = {}) {
  const raw = restDayRuleEnabled(ruleMap) ? multidayWorkshopRestRows(events) : [];
  const byRest = new Map();
  for (const r of raw) {
    const prev = byRest.get(r.restDay);
    if (!prev || String(r.lastDay) > String(prev.lastDay)) byRest.set(r.restDay, r);
  }
  const desired = [...byRest.values()].map((r) => ({
    restDay: r.restDay,
    firstDay: r.firstDay,
    lastDay: r.lastDay,
    workshop_title: r.title,
    workshop_event_id: r.event_id || null,
    summary: `rest after multi-day: ${r.title}`,
  }));
  const existing = await sb('rest_day_blocks?status=eq.active&select=*') || [];
  // One active row per rest_date (rule collapses conflicts).
  const byDate = new Map(existing.map((r) => [String(r.rest_date), r]));
  const keep = new Set();
  const created = [];
  const updated = [];
  const failed = [];

  for (const span of desired) {
    const key = String(span.restDay);
    keep.add(key);
    const title = restDayGcalTitle(span.workshop_title || span.summary);
    const endExclusive = addDaysYmd(span.restDay, 1);
    let row = byDate.get(key);
    const body = {
      rest_date: span.restDay,
      workshop_event_id: span.workshop_event_id,
      workshop_title: span.workshop_title || null,
      workshop_first_day: span.firstDay || null,
      workshop_last_day: span.lastDay || null,
      status: 'active',
      updated_at: new Date().toISOString(),
    };

    if (!writeGcal) {
      if (row) {
        await sb(`rest_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('rest_day_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(key);
      }
      continue;
    }

    try {
      const linked = await ensureAllDayLinked({
        row,
        title,
        startDate: span.restDay,
        endExclusive,
        events,
        titlePrefixRe: /\bREST\b|🛌/,
      });
      body.calendar_event_id = linked.eventId;
      if (row) {
        await sb(`rest_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('rest_day_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(key);
      }
      await sleep(40);
    } catch (e) {
      failed.push({ key, error: e.message });
    }
  }

  let pruned = 0;
  for (const row of existing) {
    const key = String(row.rest_date);
    if (keep.has(key)) continue;
    if (row.calendar_event_id) {
      try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
    }
    await sb(`rest_day_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'retired', updated_at: new Date().toISOString(), calendar_event_id: null },
    });
    pruned += 1;
  }

  return {
    desired: desired.length, created: created.length, updated: updated.length, pruned, failed,
  };
}

async function syncAwayDays(sb, travel, events, { writeGcal = true } = {}) {
  const spans = awaySpansFromTravelBlocks(travel || [])
    .filter((s) => s.startDay && s.endDay && s.startDay !== s.endDay);
  const existing = await sb('away_day_blocks?status=eq.active&select=*') || [];
  const byKey = new Map(existing.map((r) => {
    const wk = r.workshop_row_key || `${r.venue_name || ''}|${r.start_date}`;
    return [`${r.start_date}|${r.end_date}|${wk}`, r];
  }));
  const keep = new Set();
  const keepIds = new Set();
  const created = [];
  const updated = [];
  const failed = [];
  // Never prune / rewrite Alan-locked AWAY masters.
  for (const row of existing) {
    if (row.manual_lock) keepIds.add(row.id);
  }

  for (const span of spans) {
    const venue = String(span.summary || '').replace(/^away:/, '');
    const workshopRowKey = venue;
    // Full trip: travel-out day → travel-back day inclusive (Hartland Fri–Sun = all three).
    const startDate = span.startDay;
    const endDate = span.endDay;
    const key = `${startDate}|${endDate}|${workshopRowKey}`;
    keep.add(key);
    const title = awaySpanGcalTitle({ venue_name: venue });
    const endExclusive = addDaysYmd(endDate, 1);
    let row = byKey.get(key);
    // Also match legacy rows that spanned full out→back dates
    if (!row) {
      const legacyKey = `${span.startDay}|${span.endDay}|${workshopRowKey}`;
      row = byKey.get(legacyKey) || null;
    }
    if (row?.manual_lock) {
      keepIds.add(row.id);
      continue;
    }
    const body = {
      start_date: startDate,
      end_date: endDate,
      venue_name: venue,
      workshop_title: venue,
      workshop_row_key: workshopRowKey,
      status: 'active',
      updated_at: new Date().toISOString(),
    };

    if (!writeGcal) {
      if (row) {
        await sb(`away_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        keepIds.add(row.id);
        updated.push(row.id);
      } else {
        await sb('away_day_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(key);
      }
      continue;
    }

    try {
      // Revive retired row with same unique key if present (avoids duplicate-key on re-sync).
      if (!row) {
        const prior = await sb(
          `away_day_blocks?start_date=eq.${startDate}&end_date=eq.${endDate}`
          + `&workshop_row_key=eq.${encodeURIComponent(workshopRowKey)}&select=*&limit=1`,
        );
        if (prior?.[0]) row = prior[0];
      }
      if (row?.manual_lock) {
        keepIds.add(row.id);
        continue;
      }
      const linked = await ensureAllDayLinked({
        row,
        title,
        startDate,
        endExclusive,
        events,
        titlePrefixRe: /\bAWAY\b|🚫/,
      });
      body.calendar_event_id = linked.eventId;
      if (row) {
        await sb(`away_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        keepIds.add(row.id);
        updated.push(row.id);
      } else {
        const inserted = await sb('away_day_blocks', { method: 'POST', prefer: 'return=representation', body });
        const id = Array.isArray(inserted) ? inserted[0]?.id : inserted?.id;
        if (id) keepIds.add(id);
        created.push(key);
      }
      await sleep(40);
    } catch (e) {
      failed.push({ key, error: e.message });
    }
  }

  let pruned = 0;
  for (const row of existing) {
    if (keepIds.has(row.id)) continue;
    if (row.manual_lock) continue;
    const wk = row.workshop_row_key || `${row.venue_name || ''}|${row.start_date}`;
    const key = `${row.start_date}|${row.end_date}|${wk}`;
    if (keep.has(key)) continue;
    if (row.calendar_event_id) {
      try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
    }
    await sb(`away_day_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { status: 'retired', updated_at: new Date().toISOString(), calendar_event_id: null },
    });
    pruned += 1;
  }

  return {
    desired: spans.length, created: created.length, updated: updated.length, pruned, failed,
  };
}

async function syncFixtureBuffers(sb, ruleMap, {
  writeGcal = true, events = [],
} = {}) {
  const prefix = ruleMap.title_prefix_fixture || 'MC ⚽';
  const rows = await sb('fixture_blocks?status=eq.active&select=*') || [];
  const linked = [];
  const created = [];
  const failed = [];
  const already = [];
  // Always paint 1h pre/post around every fixture (teaching day does not cancel).
  // Liveable/placer: flank vs existing non-MC is OK; other MC must not land in window.

  for (const row of rows) {
    const label = matchLabel({ summary: row.title });
    const beforeTitle = `${prefix} Before: ${label}`;
    const afterTitle = `${prefix} After: ${label}`;
    const bufferMin = Number(row.buffer_min || 60);

    const fake = {
      start: { dateTime: row.fixture_start },
      end: { dateTime: row.fixture_end },
      summary: row.title,
    };
    const win = flankWindows(fake, bufferMin);
    if (!win) {
      failed.push({ id: row.id, error: 'no_window' });
      continue;
    }

    // Must be live (not cancelled) AND match expected title/times — else recreate.
    // League Cup / late feed fixtures often kept stale IDs after cancel/wrong-day paint.
    if (row.before_event_id && row.after_event_id) {
      let beforeOk = false;
      let afterOk = false;
      try {
        const vb = await verifyPrimaryEvent(row.before_event_id, {
          summary: beforeTitle, startIso: win.before_start, endIso: win.before_end,
        });
        beforeOk = vb.ok;
      } catch (_) { beforeOk = false; }
      try {
        const va = await verifyPrimaryEvent(row.after_event_id, {
          summary: afterTitle, startIso: win.after_start, endIso: win.after_end,
        });
        afterOk = va.ok;
      } catch (_) { afterOk = false; }
      if (beforeOk && afterOk) {
        already.push(row.id);
        continue;
      }
    }

    if (!writeGcal) continue;

    try {
      if (row.before_event_id) {
        try { await deletePrimaryEvent(row.before_event_id); } catch (_) { /* ignore */ }
      }
      if (row.after_event_id) {
        try { await deletePrimaryEvent(row.after_event_id); } catch (_) { /* ignore */ }
      }
      const before = await insertPrimaryEvent({
        summary: beforeTitle,
        startIso: win.before_start,
        endIso: win.before_end,
      });
      const after = await insertPrimaryEvent({
        summary: afterTitle,
        startIso: win.after_start,
        endIso: win.after_end,
      });
      const vb = await verifyPrimaryEvent(before.id, {
        summary: beforeTitle, startIso: win.before_start, endIso: win.before_end,
      });
      const va = await verifyPrimaryEvent(after.id, {
        summary: afterTitle, startIso: win.after_start, endIso: win.after_end,
      });
      if (!vb.ok || !va.ok) {
        failed.push({ id: row.id, error: 'readback_mismatch' });
        continue;
      }
      await sb(`fixture_blocks?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          before_event_id: before.id,
          after_event_id: after.id,
          updated_at: new Date().toISOString(),
        },
      });
      created.push(row.id);
      await sleep(80);
    } catch (e) {
      failed.push({ id: row.id, error: e.message });
    }
  }

  return {
    rows: rows.length,
    already_linked_live: already.length,
    recreated: created.length,
    linked: linked.length,
    failed,
  };
}

async function runRuleEventMasterSync(sb, opts = {}) {
  const writeGcal = opts.writeGcal !== false;
  const weeks = Math.min(104, Math.max(8, Number(opts.weeks) || 52));
  const today = londonToday();
  const timeMin = `${addDaysYmd(today, -14)}T00:00:00.000Z`;
  const timeMax = `${addDaysYmd(today, weeks * 7)}T00:00:00.000Z`;

  const [rules, travel, gcal] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('travel_blocks?select=*&order=starts_at.asc'),
    fetchHorizonEvents(timeMin, timeMax),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);

  const rest = await syncRestDays(sb, gcal.events || [], ruleMap, { writeGcal });
  const away = await syncAwayDays(sb, travel || [], gcal.events || [], { writeGcal });
  const fixtures = await syncFixtureBuffers(sb, ruleMap, {
    writeGcal,
    events: gcal.events || [],
  });

  const { syncGapBuffers } = require('./buffer-gap-lib');
  const gapBlocks = (gcal.events || []).map((e) => ({
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
  }));
  const gaps = await syncGapBuffers(sb, gapBlocks, ruleMap, {
    writeGcal,
    travelBlocks: travel || [],
    events: gcal.events || [],
  });

  return {
    horizon: { timeMin, timeMax, weeks },
    rest,
    away,
    fixtures,
    gaps,
    writeGcal,
  };
}

module.exports = {
  syncRestDays,
  syncAwayDays,
  syncFixtureBuffers,
  runRuleEventMasterSync,
};
