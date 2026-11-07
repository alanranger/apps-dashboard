/** Align diary_pin times to live free Primary MC 🔁 events after kill. */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { sb } = require('../api/mc/_lib.js');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');
const { relatedIdForHabit, upsertPushRow } = require('../api/mc/gcal-push-lib.js');
const { buildFlushPlan, applyFlushPlan } = require('../api/mc/gcal-flush-lib.js');

const FROM = '2026-08-10';
const TO = '2026-08-16';

function norm(t) {
  return String(t || '')
    .replace(/^MC\s*/i, '')
    .replace(/^[🔁⏳]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

(async () => {
  // Skip twin ideals first
  const logs = await sb(
    'recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at'
    + `&scheduled_date=gte.${FROM}&scheduled_date=lte.${TO}&order=at.desc&limit=2000`,
  );
  const habits = await sb('recurring_tasks?select=id,title&active=eq.true');
  const titleById = new Map((habits || []).map((h) => [h.id, h.title]));
  const byHabitDay = new Map();
  for (const l of logs || []) {
    if (!String(l.change || '').startsWith('diary_pin:')) continue;
    const k = `${l.recurring_task_id}|${l.scheduled_date}`;
    if (!byHabitDay.has(k)) byHabitDay.set(k, []);
    byHabitDay.get(k).push(l);
  }
  for (const list of byHabitDay.values()) {
    if (list.length < 2) continue;
    for (const extra of list.slice(1)) {
      await sb(`recurring_log?id=eq.${extra.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `skipped ${extra.ideal_date} (auto_dedupe twin pin)`,
          calendar_event_id: null,
        },
      });
      console.log('skipped twin', titleById.get(extra.recurring_task_id), extra.ideal_date);
    }
  }

  const kept = [];
  for (const list of byHabitDay.values()) kept.push(list[0]);

  const { events } = await fetchHorizonEvents(`${FROM}T00:00:00Z`, `${TO}T23:59:59Z`);
  const mc = (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime
      && /^MC\s*🔁/u.test(String(e.summary || '')),
  );

  for (const log of kept) {
    const title = titleById.get(log.recurring_task_id) || '';
    const day = log.scheduled_date;
    const cands = mc.filter((e) => {
      if (isoToLondonDate(e.start.dateTime) !== day) return false;
      const nt = norm(e.summary);
      const nh = norm(title);
      return nt === nh || nt.startsWith(nh) || nh.startsWith(nt) || nt.includes(nh.slice(0, 12));
    });
    if (!cands.length) {
      console.log('no gcal for', title, day);
      continue;
    }
    cands.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
    const e = cands[0];
    const start = e.start.dateTime;
    const end = e.end?.dateTime || e.start.dateTime;
    await sb(`recurring_log?id=eq.${log.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `diary_pin:${start}|${end}`,
        calendar_event_id: e.id,
        scheduled_date: day,
      },
    });
    console.log('synced', title, day, start.slice(11, 16), e.id);
  }

  // Recreate missing Monthly Accounts if gone
  const accountsHabit = (habits || []).find((h) => /Monthly Accounts/i.test(h.title));
  if (accountsHabit && !mc.some((e) => /Monthly Accounts/i.test(e.summary || ''))) {
    const start = '2026-08-14T13:15:00+01:00';
    const end = '2026-08-14T14:45:00+01:00';
    await upsertPushRow(sb, {
      related_id: relatedIdForHabit(accountsHabit.id, '2026-08-14', null),
      entity_type: 'habit',
      change_kind: 'move',
      summary: 'Recreate Monthly Accounts after clash cleanup',
      proposed_action: `CREATE Primary block MC 🔁 ${accountsHabit.title} ${start} – ${end}`,
      payload: {
        habit_id: accountsHabit.id,
        title: accountsHabit.title,
        ideal_date: '2026-08-14',
        new_start: start,
        new_end: end,
      },
    });
    // ensure log pin
    const alogs = await sb(
      `recurring_log?recurring_task_id=eq.${accountsHabit.id}&ideal_date=eq.2026-08-14&select=id&limit=1`,
    );
    if (alogs?.[0]?.id) {
      await sb(`recurring_log?id=eq.${alogs[0].id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          change: `diary_pin:${start}|${end}`,
          scheduled_date: '2026-08-14',
        },
      });
    } else {
      await sb('recurring_log', {
        method: 'POST', prefer: 'return=minimal',
        body: {
          recurring_task_id: accountsHabit.id,
          actor: 'cursor',
          ideal_date: '2026-08-14',
          scheduled_date: '2026-08-14',
          change: `diary_pin:${start}|${end}`,
          roll_reason: 'post_clash_recreate',
        },
      });
    }
    console.log('queued recreate Monthly Accounts');
  }

  const plan = await buildFlushPlan(sb);
  console.log('flush plan', plan.write_count ?? (plan.writes || []).length);
  const result = await applyFlushPlan(sb, plan, 'cursor');
  console.log('flush', result.applied, 'fail', result.failed, (result.errors || []).slice(0, 3));

  const { events: after } = await fetchHorizonEvents(`${FROM}T00:00:00Z`, `${TO}T23:59:59Z`);
  for (const e of (after || [])
    .filter((x) => (x._calendarId || 'primary') === 'primary' && x.start?.dateTime
      && /^MC\s*🔁/u.test(String(x.summary || '')))
    .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), String(e.start.dateTime).slice(11, 16), e.summary);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
