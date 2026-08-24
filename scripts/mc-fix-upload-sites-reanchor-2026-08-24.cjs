/**
 * Repair Upload sites: re-anchor to 24 Aug (every 3 months on day 24),
 * keep the 11:00 Google event, delete the orphan earlier block.
 * node scripts/mc-fix-upload-sites-reanchor-2026-08-24.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { sb } = require('../api/mc/_lib');
const { getAccessToken } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');

const TITLE_RE = /Upload sites.*LocalViking/i;
const NEW_RRULE = 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=24;X-PHASE-START=2026-08-24';
const NEW_CADENCE = '24th day every 3 months';
const IDEAL = '2026-08-24';
const START = '2026-08-24T10:00:00.000Z'; // 11:00 London (BST)
const END = '2026-08-24T12:00:00.000Z'; // 13:00 London

function londonHm(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

(async () => {
  const habits = await sb(
    'recurring_tasks?select=id,title,rrule,cadence_text,ideal_time,duration_min&title=ilike.*Upload sites*',
  ) || [];
  const habit = habits.find((h) => TITLE_RE.test(h.title)) || habits[0];
  if (!habit) throw new Error('Upload sites habit not found');
  console.log('habit', habit.id, habit.title, habit.rrule);

  const token = await getAccessToken();
  const dayEvents = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent('2026-08-24T00:00:00+01:00')}`
    + `&timeMax=${encodeURIComponent('2026-08-24T23:59:59+01:00')}`
    + `&q=${encodeURIComponent('Upload sites')}`,
    { headers: { Authorization: `Bearer ${token}` } },
  ).then((r) => r.json());

  const uploads = (dayEvents.items || []).filter(
    (e) => e.status !== 'cancelled' && TITLE_RE.test(e.summary || ''),
  );
  console.log('gcal_today', uploads.map((e) => ({
    id: e.id,
    start: e.start?.dateTime,
    hm: e.start?.dateTime ? londonHm(e.start.dateTime) : null,
  })));

  // Prefer the 11:00 block; delete others as orphans.
  let keep = uploads.find((e) => e.start?.dateTime && londonHm(e.start.dateTime) === '11:00');
  if (!keep && uploads.length) keep = uploads.sort((a, b) => String(b.start?.dateTime).localeCompare(String(a.start?.dateTime)))[0];
  for (const e of uploads) {
    if (keep && e.id === keep.id) continue;
    await deletePrimaryEvent(e.id);
    console.log('deleted_orphan', e.id, e.start?.dateTime);
  }

  if (keep) {
    await patchPrimaryEvent(keep.id, {
      startIso: START,
      endIso: END,
      summary: keep.summary,
    });
    console.log('patched_keep', keep.id, '11:00-13:00');
  }

  await sb(`recurring_tasks?id=eq.${habit.id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      rrule: NEW_RRULE,
      cadence_text: NEW_CADENCE,
      ideal_time: '11:00',
      scheduled_note: '2026-08-24 11:00 (diary pin)',
      last_scheduled: IDEAL,
      updated_at: new Date().toISOString(),
    },
  });

  const logs = await sb(
    `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=gte.2026-08-01`
    + '&select=id,ideal_date,scheduled_date,calendar_event_id,change&order=at.desc&limit=40',
  ) || [];
  console.log('logs_before', logs.map((l) => ({ id: l.id, ideal: l.ideal_date, day: l.scheduled_date, evt: l.calendar_event_id, ch: String(l.change || '').slice(0, 40) })));

  // Skip obsolete future ideals (e.g. Oct 19 / Jan phase) that are not on the new series.
  for (const l of logs) {
    if (!l.ideal_date || l.ideal_date === IDEAL) continue;
    if (l.ideal_date < IDEAL) continue;
    if (/^skipped|^completed/i.test(String(l.change || ''))) continue;
    await sb(`recurring_log?id=eq.${l.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `skipped occurrence ${l.ideal_date}: reanchor_phase`,
        roll_reason: 'reanchor_phase',
        at: new Date().toISOString(),
      },
    });
    console.log('skipped_old_ideal', l.ideal_date);
  }

  const pinChange = `diary_pin:${START}|${END}`;
  const existing = logs.filter((l) => l.ideal_date === IDEAL);
  const pinBody = {
    change: pinChange,
    ideal_date: IDEAL,
    scheduled_date: IDEAL,
    calendar_event_id: keep?.id || existing[0]?.calendar_event_id || null,
    roll_reason: 'diary_manual_pin',
    at: new Date().toISOString(),
    projection_key: `diary:${habit.id}:${IDEAL}`,
  };
  if (existing[0]?.id) {
    await sb(`recurring_log?id=eq.${existing[0].id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: pinBody,
    });
  } else {
    await sb('recurring_log', {
      method: 'POST', prefer: 'return=minimal',
      body: { recurring_task_id: habit.id, actor: 'cursor', ...pinBody },
    });
  }
  console.log('pinned', IDEAL, pinBody.calendar_event_id);
  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
