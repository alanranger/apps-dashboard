/**
 * Delete orphan MC 🔁/⏰ Google events the placer already unplaced or moved.
 * node scripts/mc-purge-orphan-habit-events.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

async function main() {
  const today = londonToday();
  const [habits, logs, gcal] = await Promise.all([
    sb('recurring_tasks?select=id,title&active=eq.true'),
    sb(
      'recurring_log?select=recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change,at'
      + '&order=at.desc&limit=8000',
    ),
    fetchHorizonEvents(
      `${addDaysYmd(today, -14)}T00:00:00.000Z`,
      `${addDaysYmd(today, 220)}T00:00:00.000Z`,
    ),
  ]);

  const latestByIdeal = new Map();
  for (const row of logs || []) {
    if (!row.recurring_task_id) continue;
    const ideal = row.ideal_date || row.scheduled_date;
    if (!ideal) continue;
    const k = `${row.recurring_task_id}|${ideal}`;
    if (!latestByIdeal.has(k)) latestByIdeal.set(k, row);
  }
  const claimedIds = new Set(
    [...latestByIdeal.values()]
      .filter((r) => r.calendar_event_id && r.scheduled_date)
      .map((r) => r.calendar_event_id),
  );

  let deleted = 0;
  for (const e of gcal.events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) continue;
    const t = String(e.summary || '');
    if (!/^MC\s*[🔁⏰]/u.test(t)) continue;
    if (claimedIds.has(e.id)) continue;
    const bare = t.replace(/^MC\s*[^\s]+\s+/, '').trim();
    const habit = (habits || []).find((h) => {
      const ht = String(h.title || '');
      return bare.startsWith(ht.slice(0, Math.min(36, ht.length)));
    });
    if (!habit) continue;

    const day = isoToLondonDate(e.start.dateTime);
    // Prefer ideal-day log; also check if this day was a rolled scheduled_date then moved away
    const idealLog = latestByIdeal.get(`${habit.id}|${day}`);
    const unplaced = idealLog && (!idealLog.scheduled_date || /unplaced/i.test(idealLog.change || ''));
    const movedAway = idealLog && idealLog.scheduled_date && idealLog.scheduled_date !== day
      && idealLog.calendar_event_id && idealLog.calendar_event_id !== e.id;
    const neverClaimed = !idealLog && ![...latestByIdeal.values()].some(
      (r) => r.recurring_task_id === habit.id && r.calendar_event_id === e.id,
    );

    if (!unplaced && !movedAway && !neverClaimed) continue;

    await deletePrimaryEvent(e.id);
    deleted += 1;
    console.log('deleted', day, t.slice(0, 65), unplaced ? 'unplaced' : movedAway ? 'moved' : 'unclaimed');
  }
  console.log(JSON.stringify({ deleted, claimed: claimedIds.size }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
