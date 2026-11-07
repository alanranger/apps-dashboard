/**
 * One-shot: delete wrong-phase habit ghosts from Google + DB,
 * re-patch duration mismatches on correct-phase pins, clear stale unplaced,
 * then flush push queue.
 *
 * node scripts/mc-resync-habits-gcal.cjs
 */
const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { deletePrimaryEvent, patchPrimaryEvent, verifyPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { pushSync, loadFlags } = require('../api/mc/gcal-auto-sync-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parsePin(change) {
  const m = String(change || '').match(/^diary_pin:([^|]+)\|(.+)$/);
  if (!m) return null;
  return { startIso: m[1], endIso: m[2] };
}

function minsBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

async function latestPins() {
  const rows = await sb(
    'recurring_log?change=like.diary_pin:*&calendar_event_id=not.is.null'
    + '&ideal_date=gte.2026-07-01&ideal_date=lte.2027-03-01'
    + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at'
    + '&order=at.desc&limit=3000',
  );
  const map = new Map();
  for (const r of rows || []) {
    const k = `${r.recurring_task_id}|${r.ideal_date}`;
    if (!map.has(k)) map.set(k, r);
  }
  return [...map.values()];
}

async function main() {
  const today = todayYmd();
  const horizonEnd = addDaysYmd(today, 200);
  const habits = await sb(
    'recurring_tasks?active=eq.true&select=id,title,duration_min,rrule',
  );
  const byId = new Map((habits || []).map((h) => [h.id, h]));
  const correctByHabit = new Map();
  for (const h of habits || []) {
    try {
      correctByHabit.set(h.id, new Set(idealsInHorizon(h.rrule, today, horizonEnd, 200)));
    } catch (_) {
      correctByHabit.set(h.id, new Set());
    }
  }

  const pins = await latestPins();
  const deleted = [];
  const patched = [];
  const skipped = [];
  const errors = [];

  for (const pin of pins) {
    const habit = byId.get(pin.recurring_task_id);
    if (!habit) continue;
    const correct = correctByHabit.get(habit.id) || new Set();
    const parsed = parsePin(pin.change);
    const eventId = pin.calendar_event_id;
    if (!eventId || !parsed) continue;

    // Wrong phase → delete Google + supersede log
    if (correct.size && !correct.has(pin.ideal_date)) {
      try {
        await deletePrimaryEvent(eventId);
        await sb('recurring_log', {
          method: 'POST',
          body: {
            recurring_task_id: habit.id,
            actor: 'cursor',
            change: `retired wrong_phase ${pin.ideal_date}|resync`,
            ideal_date: pin.ideal_date,
            scheduled_date: null,
            calendar_event_id: null,
            roll_reason: 'wrong_phase_cleanup',
          },
        });
        deleted.push({
          title: habit.title, ideal: pin.ideal_date, eventId, day: pin.scheduled_date,
        });
        await sleep(80);
      } catch (e) {
        errors.push({ op: 'delete', eventId, error: e.message });
      }
      continue;
    }

    // Correct phase → fix duration if needed
    const want = Number(habit.duration_min) || 60;
    const have = minsBetween(parsed.startIso, parsed.endIso);
    if (Math.abs(have - want) <= 1) {
      skipped.push({ title: habit.title, ideal: pin.ideal_date, mins: have });
      continue;
    }
    const newEnd = new Date(Date.parse(parsed.startIso) + want * 60000).toISOString();
    try {
      await patchPrimaryEvent(eventId, { startIso: parsed.startIso, endIso: newEnd });
      const v = await verifyPrimaryEvent(eventId, {
        startIso: parsed.startIso, endIso: newEnd,
      });
      await sb('recurring_log', {
        method: 'POST',
        body: {
          recurring_task_id: habit.id,
          actor: 'cursor',
          change: `diary_pin:${parsed.startIso}|${newEnd}`,
          ideal_date: pin.ideal_date,
          scheduled_date: pin.scheduled_date,
          calendar_event_id: eventId,
          roll_reason: 'duration_resync',
        },
      });
      patched.push({
        title: habit.title, ideal: pin.ideal_date, from: have, to: want, ok: !!v?.ok,
      });
      await sleep(80);
    } catch (e) {
      errors.push({ op: 'patch', eventId, error: e.message });
    }
  }

  // Clear stale unplaced rows for wrong-phase ideals (log only — insert superseding note)
  let unplacedCleared = 0;
  for (const h of habits || []) {
    const correct = correctByHabit.get(h.id) || new Set();
    if (!correct.size) continue;
    const unplaced = await sb(
      `recurring_log?recurring_task_id=eq.${h.id}&change=like.unplaced*&ideal_date=gte.${today}`
      + '&ideal_date=lte.' + horizonEnd
      + '&select=id,ideal_date,change,at&order=at.desc&limit=200',
    );
    const seen = new Set();
    for (const u of unplaced || []) {
      if (seen.has(u.ideal_date)) continue;
      seen.add(u.ideal_date);
      if (correct.has(u.ideal_date)) continue;
      await sb('recurring_log', {
        method: 'POST',
        body: {
          recurring_task_id: h.id,
          actor: 'cursor',
          change: `cleared stale unplaced ${u.ideal_date}|wrong_phase`,
          ideal_date: u.ideal_date,
          scheduled_date: null,
          calendar_event_id: null,
          roll_reason: 'wrong_phase_cleanup',
        },
      });
      unplacedCleared += 1;
    }
  }

  // Flush any pending push (gap slides etc.)
  console.log('flags', await loadFlags(sb));
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  }).catch(() => {});
  const flush = await pushSync(sb, 'cursor-resync-habits', {
    includeBacklog: false, includeRuleMasters: true,
  });

  console.log(JSON.stringify({
    today,
    horizonEnd,
    deleted_ghosts: deleted.length,
    deleted_sample: deleted.slice(0, 20),
    patched_durations: patched.length,
    patched_sample: patched.slice(0, 20),
    duration_ok: skipped.length,
    unplaced_cleared: unplacedCleared,
    errors,
    flush: {
      planned: flush.flush?.planned,
      applied: flush.flush?.applied,
      failed: flush.flush?.failed,
    },
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
