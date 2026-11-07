/**
 * One-shot: delete Primary MC 🔁 ghosts this week.
 * - Untied → delete
 * - Duplicate title per day → keep best (not on hard busy if possible)
 * - Remaining on hard personal busy → delete (DB re-pins via placer)
 */
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
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib.js');
const { buildBusyIntervals } = require('../api/mc/habit-placer-lib.js');
const { ruleMapFromRows, isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');

const FROM = '2026-08-10';
const TO = '2026-08-16';

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function onHardBusy(e, busy) {
  const s = Date.parse(e.start.dateTime);
  const en = Date.parse(e.end?.dateTime || e.start.dateTime);
  return busy.some((b) => overlaps(s, en, b.startMs, b.endMs) && !b.is_mc_recurring_gcal);
}

(async () => {
  const rules = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const logs = await sb(
    'recurring_log?select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change'
    + `&scheduled_date=gte.${FROM}&scheduled_date=lte.${TO}&limit=2000`,
  );
  const tied = new Set((logs || []).map((r) => r.calendar_event_id).filter(Boolean));

  const { events } = await fetchHorizonEvents(`${FROM}T00:00:00Z`, `${TO}T23:59:59Z`);
  const busy = buildBusyIntervals(events || [], rules).filter((b) => !b.is_mc_recurring_gcal);

  let mc = (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary'
      && e.start?.dateTime && e.status !== 'cancelled'
      && /^MC\s*🔁/u.test(String(e.summary || '')),
  );

  const kill = new Set();
  const reasons = [];

  // 1) Untied
  for (const e of mc) {
    if (!tied.has(e.id)) {
      kill.add(e.id);
      reasons.push(['untied', e.id, e.summary, isoToLondonDate(e.start.dateTime)]);
    }
  }

  // 2) Same title same day — keep one: prefer free slot, then later start, then tied
  const groups = new Map();
  for (const e of mc) {
    if (kill.has(e.id)) continue;
    const day = isoToLondonDate(e.start.dateTime);
    const key = `${day}|${String(e.summary || '').trim()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => {
      const ab = onHardBusy(a, busy) ? 1 : 0;
      const bb = onHardBusy(b, busy) ? 1 : 0;
      if (ab !== bb) return ab - bb;
      const at = tied.has(a.id) ? 0 : 1;
      const bt = tied.has(b.id) ? 0 : 1;
      if (at !== bt) return at - bt;
      return Date.parse(b.start.dateTime) - Date.parse(a.start.dateTime);
    });
    for (const e of list.slice(1)) {
      kill.add(e.id);
      reasons.push(['dup_day', e.id, e.summary, isoToLondonDate(e.start.dateTime)]);
    }
  }

  // 3) Still on hard personal busy → delete (re-create via placer later)
  for (const e of mc) {
    if (kill.has(e.id)) continue;
    if (onHardBusy(e, busy)) {
      kill.add(e.id);
      reasons.push(['on_busy', e.id, e.summary, isoToLondonDate(e.start.dateTime)]);
    }
  }

  // Claude: keep one this week (earliest free if any, else earliest)
  const claude = mc.filter((e) => /Claude monthly hotel scan/i.test(String(e.summary || '')) && !kill.has(e.id));
  claude.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  for (const e of claude.slice(1)) {
    kill.add(e.id);
    reasons.push(['claude_keep_one', e.id, e.summary, isoToLondonDate(e.start.dateTime)]);
  }

  console.log('to delete', kill.size);
  for (const r of reasons) console.log('-', r.join(' | '));

  // Clear log pointers for killed tied events
  for (const log of logs || []) {
    if (log.calendar_event_id && kill.has(log.calendar_event_id)) {
      await sb(`recurring_log?id=eq.${log.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: { calendar_event_id: null },
      });
      console.log('cleared log calendar_event_id', log.id, log.ideal_date);
    }
  }

  for (const id of kill) {
    try {
      await deletePrimaryEvent(id);
      console.log('deleted', id);
    } catch (err) {
      console.error('delete failed', id, err.message);
    }
  }

  const { events: after } = await fetchHorizonEvents(`${FROM}T00:00:00Z`, `${TO}T23:59:59Z`);
  mc = (after || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime
      && /^MC\s*🔁/u.test(String(e.summary || '')),
  ).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  console.log('\nRemaining MC 🔁 this week:');
  for (const e of mc) {
    const day = isoToLondonDate(e.start.dateTime);
    const bus = onHardBusy(e, buildBusyIntervals(after || [], rules).filter((b) => !b.is_mc_recurring_gcal));
    console.log(day, String(e.start.dateTime).slice(11, 16), bus ? 'BUSY!' : 'ok', e.summary);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
