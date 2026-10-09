/**
 * Clean orphans/dupes after SEO Performance Review → Business Performance Review rename + weekly reanchor.
 * node scripts/mc-cleanup-business-perf-review.cjs
 * node scripts/mc-cleanup-business-perf-review.cjs --fix
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const FIX = process.argv.includes('--fix');
const HABIT_ID = '6ec9689d-5426-4276-9e17-824cb4ea4fc1';
const OLD_TITLE_RE = /SEO\s*Performance\s*Review/i;
const ANY_PERF_RE = /Performance\s*Review/i;

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPin(change) {
  return /^diary_pin:/i.test(String(change || ''));
}

function isSkipped(change) {
  return /skipped occurrence/i.test(String(change || ''));
}

function isDone(change) {
  return /^done\b/i.test(String(change || ''));
}

function isRetired(change) {
  return /retired wrong_phase|reanchor cull|wrong_phase_cleanup|rename_cleanup/i.test(String(change || ''));
}

function endFromStart(startIso, durationMin) {
  return new Date(Date.parse(startIso) + (Number(durationMin) || 120) * 60000).toISOString();
}

async function main() {
  const habit = (await sb(`recurring_tasks?id=eq.${HABIT_ID}&select=*`))?.[0];
  if (!habit) throw new Error('habit not found');
  console.log('HABIT', habit.title, habit.rrule, habit.duration_min, habit.ideal_time);

  const today = londonToday();
  const to = addDaysYmd(today, 220);
  const keepIdeals = new Set(idealsInHorizon(habit.rrule, today, to, 200) || []);
  console.log('CORRECT_IDEALS', [...keepIdeals].slice(0, 12));

  const { events } = await fetchHorizonEvents(
    `${addDaysYmd(today, -45)}T00:00:00.000Z`,
    `${to}T00:00:00.000Z`,
  );
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);
  const perf = primary
    .filter((e) => ANY_PERF_RE.test(e.summary || '') || OLD_TITLE_RE.test(e.summary || ''))
    .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));

  console.log('\n=== GCal performance-review events ===');
  for (const e of perf) {
    console.log(
      isoToLondonDate(e.start.dateTime),
      e.start.dateTime.slice(11, 16),
      '-',
      e.end.dateTime.slice(11, 16),
      e.id,
      e.summary,
    );
  }

  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${HABIT_ID}`
      + '&select=id,ideal_date,scheduled_date,calendar_event_id,change,roll_reason,at'
      + '&order=at.desc&limit=200',
  ) || [];

  const latestByIdeal = new Map();
  for (const l of logs) {
    if (!l.ideal_date || latestByIdeal.has(l.ideal_date)) continue;
    latestByIdeal.set(l.ideal_date, l);
  }

  const plan = {
    deleteGcal: [],
    renameGcal: [],
    retirePins: [],
    repinKeep: [],
    clearBadSkips: [],
    dismissPending: [],
  };

  const byDay = new Map();
  for (const e of perf) {
    const day = isoToLondonDate(e.start.dateTime);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  const keepEventIds = new Set();
  for (const day of keepIdeals) {
    const list = (byDay.get(day) || []).slice().sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
    if (!list.length) continue;
    const keep = list[0];
    keepEventIds.add(keep.id);
    plan.renameGcal.push(keep);
    for (const extra of list.slice(1)) {
      plan.deleteGcal.push({
        id: extra.id,
        reason: `same_day_dupe ${day}`,
        summary: extra.summary,
        day,
      });
    }
    plan.repinKeep.push({ day, event: keep });
  }

  for (const [ideal, l] of latestByIdeal) {
    if (ideal < today) continue;
    if (keepIdeals.has(ideal)) continue;
    if (isDone(l.change) || isSkipped(l.change) || isRetired(l.change)) continue;
    if (!isPin(l.change) && !/^unplaced/i.test(String(l.change || ''))) continue;
    plan.retirePins.push(l);
    if (l.calendar_event_id && !keepEventIds.has(l.calendar_event_id)) {
      plan.deleteGcal.push({
        id: l.calendar_event_id,
        reason: `wrong_phase_pin ${ideal}`,
        summary: null,
        day: l.scheduled_date || ideal,
      });
    }
  }

  for (const e of perf) {
    const day = isoToLondonDate(e.start.dateTime);
    if (keepEventIds.has(e.id)) continue;
    if (plan.deleteGcal.some((d) => d.id === e.id)) continue;
    plan.deleteGcal.push({
      id: e.id,
      reason: OLD_TITLE_RE.test(e.summary || '') ? `orphan_old_title ${day}` : `orphan_unclaimed ${day}`,
      summary: e.summary,
      day,
    });
  }

  for (const [ideal, l] of latestByIdeal) {
    if (!keepIdeals.has(ideal)) continue;
    if (!isSkipped(l.change)) continue;
    if (/reanchor_phase|rename_cleanup/i.test(String(l.roll_reason || l.change || ''))) {
      plan.clearBadSkips.push(l);
    }
  }

  const seenDel = new Set();
  plan.deleteGcal = plan.deleteGcal.filter((d) => {
    if (seenDel.has(d.id)) return false;
    seenDel.add(d.id);
    return true;
  });

  plan.dismissPending = await sb(
    'pending_diary_changes?status=eq.pending&select=id,change_type,summary,related_id,target_date'
      + '&or=(summary.ilike.*Performance*Review*,related_id.ilike.*6ec9689d*)'
      + '&limit=200',
  ) || [];

  console.log('\n=== PLAN ===');
  console.log('retirePins', plan.retirePins.map((p) => p.ideal_date));
  console.log('repinKeep', plan.repinKeep.map((p) => `${p.day}:${p.event.id}`));
  console.log('clearBadSkips', plan.clearBadSkips.map((p) => p.ideal_date));
  console.log('deleteGcal', plan.deleteGcal.length);
  for (const d of plan.deleteGcal) console.log('  DEL', d.day || '', d.id, d.reason, (d.summary || '').slice(0, 60));
  console.log('renameGcal', plan.renameGcal.length);
  for (const e of plan.renameGcal) console.log('  REN', isoToLondonDate(e.start.dateTime), e.id, e.summary);
  console.log('dismissPending', plan.dismissPending.length);

  if (!FIX) {
    console.log('\nDry-run only. Re-run with --fix to apply.');
    return;
  }

  const out = {
    deleted: [], renamed: [], retired: [], repinned: [], clearedSkips: [], dismissed: 0, errors: [],
  };
  const newTitle = `MC 🔁 ${habit.title}`;

  for (const pin of plan.retirePins) {
    try {
      await sb(`recurring_log?id=eq.${pin.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          change: `skipped occurrence ${pin.ideal_date}: rename_cleanup`,
          roll_reason: 'rename_cleanup',
          calendar_event_id: null,
          at: new Date().toISOString(),
        },
      });
      out.retired.push(pin.ideal_date);
    } catch (e) {
      out.errors.push({ op: 'retire', ideal: pin.ideal_date, error: e.message });
    }
  }

  for (const d of plan.deleteGcal) {
    try {
      await deletePrimaryEvent(d.id);
      out.deleted.push(d);
      await sleep(80);
    } catch (e) {
      out.errors.push({ op: 'delete', id: d.id, error: e.message });
    }
  }

  for (const e of plan.renameGcal) {
    try {
      const day = isoToLondonDate(e.start.dateTime);
      const startIso = e.start.dateTime;
      const endIso = endFromStart(startIso, habit.duration_min || 120);
      await patchPrimaryEvent(e.id, {
        summary: newTitle,
        start: { dateTime: startIso, timeZone: 'Europe/London' },
        end: { dateTime: endIso, timeZone: 'Europe/London' },
      });
      out.renamed.push({ id: e.id, day });
      await sleep(80);
    } catch (err) {
      out.errors.push({ op: 'rename', id: e.id, error: err.message });
    }
  }

  for (const { day, event } of plan.repinKeep) {
    try {
      const startIso = event.start.dateTime;
      const endIso = endFromStart(startIso, habit.duration_min || 120);
      await sb('recurring_log', {
        method: 'POST',
        body: {
          recurring_task_id: HABIT_ID,
          actor: 'cursor',
          change: `diary_pin:${startIso}|${endIso}`,
          ideal_date: day,
          scheduled_date: day,
          calendar_event_id: event.id,
          roll_reason: 'rename_cleanup_repin',
          projection_key: `placer:${HABIT_ID}:${day}`,
        },
      });
      out.repinned.push(day);
    } catch (e) {
      out.errors.push({ op: 'repin', day, error: e.message });
    }
  }

  for (const l of plan.clearBadSkips) {
    try {
      await sb(`recurring_log?id=eq.${l.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          change: `cleared bad skip ${l.ideal_date}: now valid weekly ideal`,
          roll_reason: 'rename_cleanup_unskip',
          calendar_event_id: null,
          at: new Date().toISOString(),
        },
      });
      out.clearedSkips.push(l.ideal_date);
    } catch (e) {
      out.errors.push({ op: 'unskip', ideal: l.ideal_date, error: e.message });
    }
  }

  if (plan.dismissPending.length) {
    const now = new Date().toISOString();
    for (let i = 0; i < plan.dismissPending.length; i += 40) {
      const chunk = plan.dismissPending.slice(i, i + 40);
      const ids = chunk.map((r) => r.id).join(',');
      await sb(`pending_diary_changes?id=in.(${ids})`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          status: 'dismissed',
          resolved_at: now,
          resolved_by: 'cursor-cleanup-business-perf',
        },
      });
      out.dismissed += chunk.length;
    }
  }

  const pushRows = await sb(
    'gcal_push_queue?status=eq.pending&select=id,summary,related_id'
      + '&or=(summary.ilike.*Performance*Review*,related_id.ilike.*6ec9689d*)'
      + '&limit=100',
  ) || [];
  for (const row of pushRows) {
    try {
      await sb(`gcal_push_queue?id=eq.${row.id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          status: 'dismissed',
          resolved_at: new Date().toISOString(),
          resolved_by: 'cursor-cleanup-business-perf',
        },
      });
    } catch (_) { /* ignore */ }
  }

  await sb('recurring_log', {
    method: 'POST',
    body: {
      recurring_task_id: HABIT_ID,
      actor: 'cursor',
      change: `cleanup after rename: deleted ${out.deleted.length} gcal, retired ${out.retired.length}, repinned ${out.repinned.length}, renamed ${out.renamed.length}, dismissed ${out.dismissed} pending`,
    },
  });

  console.log('\n=== DONE ===');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
