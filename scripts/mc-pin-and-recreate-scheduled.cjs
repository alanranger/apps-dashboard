/**
 * Patch change='scheduled' (no diary_pin) → pin + recreate GCal.
 * node scripts/mc-pin-and-recreate-scheduled.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { londonYmdHmToUtcMs } = require('../api/mc/habit-placer-lib');
const { ruleMapFromRows, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { habitGcalTitle } = require('../api/mc/gcal-title-lib');
const { upsertPushRow } = require('../api/mc/gcal-push-lib');
const { pushSync, reconcileReport } = require('../api/mc/gcal-auto-sync-lib');

async function main() {
  const today = londonToday();
  const to = addDays(today, 180);
  const [rules, habits, logs] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb('recurring_tasks?select=id,title,ideal_time,duration_min&active=eq.true'),
    sb(`recurring_log?scheduled_date=gte.${today}&scheduled_date=lte.${to}`
      + '&calendar_event_id=is.null'
      + '&select=id,recurring_task_id,ideal_date,scheduled_date,change&order=at.desc&limit=2000'),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const prefixes = { habit: ruleMap.title_prefix_recurring || 'MC 🔁' };
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  let n = 0;
  for (const row of logs || []) {
    if (!row.scheduled_date || /^skip|^unplaced/i.test(row.change || '')) continue;
    if (String(row.change || '').startsWith('diary_pin:')) continue;
    const habit = habitMap.get(row.recurring_task_id);
    if (!habit) continue;
    const hm = String(habit.ideal_time || '09:00').slice(0, 5);
    const dur = Math.max(30, Number(habit.duration_min) || 60);
    const startMs = londonYmdHmToUtcMs(row.scheduled_date, hm);
    const endMs = startMs + dur * 60000;
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const ideal = row.ideal_date || row.scheduled_date;
    await sb(`recurring_log?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `diary_pin:${startIso}|${endIso}`,
        roll_reason: 'pin_from_scheduled_for_gcal',
        ideal_date: ideal,
      },
    });
    const title = habitGcalTitle(habit.title, prefixes);
    await upsertPushRow(sb, {
      related_id: `habit_place:${row.recurring_task_id}:${ideal}`,
      entity_type: 'habit',
      change_kind: 'move',
      summary: `Pin+create: ${habit.title} → ${row.scheduled_date}`,
      proposed_action: `MOVE/CREATE habit "${habit.title}" block to ${startIso} – ${endIso}. Create Primary event ideal_date=${ideal}.`,
      payload: {
        habit_id: row.recurring_task_id,
        title,
        ideal_date: ideal,
        new_start: startIso,
        new_end: endIso,
        calendar_event_id: null,
      },
    });
    n += 1;
  }
  console.log('pinned_queued', n);
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });
  const flush = await pushSync(sb, 'cursor-pin-scheduled', { includeRuleMasters: false });
  console.log('flush', { planned: flush.flush?.planned, applied: flush.flush?.applied, failed: flush.flush?.failed });
  await sb(`scheduling_rules?key=eq.${encodeURIComponent('gcal_push_inflight_until')}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: { value: '0', updated_at: new Date().toISOString() },
  });
  const rec = await reconcileReport(sb);
  console.log('reconcile', rec.status_line, 'missing', rec.masters_missing_event_id);
}
main().catch((e) => { console.error(e); process.exit(1); });
