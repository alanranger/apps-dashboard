/**
 * Persist rule-driven calendar layers as DB masters + GCal mirror:
 *   rest_day_blocks, away_day_blocks, fixture_blocks (before/after link).
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
  deletePrimaryEvent, verifyPrimaryEvent, getPrimaryEvent,
} = require('./gcal-write-lib');
const { restDayGcalTitle, awaySpanGcalTitle } = require('./gcal-title-lib');
const { flankWindows, matchLabel } = require('./fixture-coverage-lib');
const { ruleMapFromRows } = require('./scheduling-rules-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      if (row?.calendar_event_id) {
        try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
      }
      const ev = await insertPrimaryAllDayEvent({
        summary: title,
        startDate: span.restDay,
        endDateExclusive: endExclusive,
      });
      const v = await verifyPrimaryEvent(ev.id, {
        summary: title,
        startDate: span.restDay,
        endDateExclusive: endExclusive,
      });
      if (!v.ok) {
        failed.push({ key, error: 'readback_mismatch', verify: v });
        continue;
      }
      body.calendar_event_id = ev.id;
      if (row) {
        await sb(`rest_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('rest_day_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(key);
      }
      await sleep(60);
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

async function syncAwayDays(sb, travel, { writeGcal = true } = {}) {
  const spans = awaySpansFromTravelBlocks(travel || []);
  const existing = await sb('away_day_blocks?status=eq.active&select=*') || [];
  const byKey = new Map(existing.map((r) => {
    const wk = r.workshop_row_key || `${r.venue_name || ''}|${r.start_date}`;
    return [`${r.start_date}|${r.end_date}|${wk}`, r];
  }));
  const keep = new Set();
  const created = [];
  const updated = [];
  const failed = [];

  for (const span of spans) {
    const venue = String(span.summary || '').replace(/^away:/, '');
    const workshopRowKey = venue;
    const key = `${span.startDay}|${span.endDay}|${workshopRowKey}`;
    keep.add(key);
    const title = awaySpanGcalTitle({ venue_name: venue });
    const endExclusive = addDaysYmd(span.endDay, 1);
    let row = byKey.get(key);
    const body = {
      start_date: span.startDay,
      end_date: span.endDay,
      venue_name: venue,
      workshop_title: venue,
      workshop_row_key: workshopRowKey,
      status: 'active',
      updated_at: new Date().toISOString(),
    };

    if (!writeGcal) {
      if (row) {
        await sb(`away_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('away_day_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(key);
      }
      continue;
    }

    try {
      if (row?.calendar_event_id) {
        try { await deletePrimaryEvent(row.calendar_event_id); } catch (_) { /* ignore */ }
      }
      const ev = await insertPrimaryAllDayEvent({
        summary: title,
        startDate: span.startDay,
        endDateExclusive: endExclusive,
      });
      const v = await verifyPrimaryEvent(ev.id, {
        summary: title,
        startDate: span.startDay,
        endDateExclusive: endExclusive,
      });
      if (!v.ok) {
        failed.push({ key, error: 'readback_mismatch', verify: v });
        continue;
      }
      body.calendar_event_id = ev.id;
      if (row) {
        await sb(`away_day_blocks?id=eq.${row.id}`, { method: 'PATCH', prefer: 'return=minimal', body });
        updated.push(row.id);
      } else {
        await sb('away_day_blocks', { method: 'POST', prefer: 'return=minimal', body });
        created.push(key);
      }
      await sleep(60);
    } catch (e) {
      failed.push({ key, error: e.message });
    }
  }

  let pruned = 0;
  for (const row of existing) {
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

async function syncFixtureBuffers(sb, ruleMap, { writeGcal = true } = {}) {
  const prefix = ruleMap.title_prefix_fixture || 'MC ⚽';
  const rows = await sb('fixture_blocks?status=eq.active&select=*') || [];
  const linked = [];
  const created = [];
  const failed = [];
  const already = [];

  for (const row of rows) {
    const label = matchLabel({ summary: row.title });
    const beforeTitle = `${prefix} Before: ${label}`;
    const afterTitle = `${prefix} After: ${label}`;
    const bufferMin = Number(row.buffer_min || 60);

    // Derive flank windows from stored fixture times
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

    if (row.before_event_id && row.after_event_id) {
      // Confirm live; if missing, recreate
      let beforeOk = false;
      let afterOk = false;
      try {
        const b = await getPrimaryEvent(row.before_event_id);
        beforeOk = !!b?.id;
      } catch (_) { beforeOk = false; }
      try {
        const a = await getPrimaryEvent(row.after_event_id);
        afterOk = !!a?.id;
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
  const away = await syncAwayDays(sb, travel || [], { writeGcal });
  const fixtures = await syncFixtureBuffers(sb, ruleMap, { writeGcal });

  return {
    horizon: { timeMin, timeMax, weeks },
    rest,
    away,
    fixtures,
    writeGcal,
  };
}

module.exports = {
  syncRestDays,
  syncAwayDays,
  syncFixtureBuffers,
  runRuleEventMasterSync,
};
