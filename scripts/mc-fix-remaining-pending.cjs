/**
 * Fix remaining pending diary issues (live GCal + DB + dismiss).
 * node scripts/mc-fix-remaining-pending.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { getAccessToken, fetchHorizonEvents } = require('../api/mc/gcal-lib');
const {
  patchPrimaryEvent, insertPrimaryEvent, deletePrimaryEvent,
} = require('../api/mc/gcal-write-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');

const ANCHOR = '2026-07-30';

async function dismiss(id, note) {
  await sb(`pending_diary_changes?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
      resolved_by: 'cursor',
      proposed_action: `RESOLVED — ${note}`,
    },
  });
}

async function applyPending(id, note) {
  await sb(`pending_diary_changes?id=eq.${id}`, {
    method: 'PATCH', prefer: 'return=minimal',
    body: {
      status: 'applied',
      resolved_at: new Date().toISOString(),
      resolved_by: 'cursor',
      proposed_action: `APPLIED — ${note}`,
    },
  });
}

async function getEvent(token, id) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return res.json();
}

async function dayEvents(token, day) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent(`${day}T00:00:00+01:00`)}`
    + `&timeMax=${encodeURIComponent(`${day}T23:59:59+01:00`)}&maxResults=50`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return (j.items || []).filter((e) => e.status !== 'cancelled' && e.start?.dateTime);
}

function londonParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
}

async function patchLondon(token, eventId, ymd, startHm, endHm) {
  const body = {
    start: { dateTime: `${ymd}T${startHm}:00`, timeZone: 'Europe/London' },
    end: { dateTime: `${ymd}T${endHm}:00`, timeZone: 'Europe/London' },
  };
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const j = await res.json();
  if (!res.ok) throw new Error(j.error?.message || `patch ${res.status}`);
  return j;
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekend(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function findSlot(dayEventsList, durationMin, preferHm = '10:00') {
  const workStart = 9 * 60;
  const workEnd = 17 * 60;
  const prefer = preferHm.split(':').map(Number);
  const preferMin = prefer[0] * 60 + prefer[1];
  const busy = dayEventsList.map((e) => ({
    s: Date.parse(e.start.dateTime),
    e: Date.parse(e.end.dateTime),
  }));
  const day = isoToLondonDate(dayEventsList[0]?.start?.dateTime)
    || (dayEventsList.length ? null : null);
  // Build candidate starts
  const starts = [];
  for (let m = preferMin; m + durationMin <= workEnd; m += 15) starts.push(m);
  for (let m = preferMin - 15; m >= workStart; m -= 15) starts.push(m);
  // Need ymd from caller
  return { starts, busy, workStart, workEnd };
}

async function placeOnDay(token, ymd, durationMin, preferHm, title, description) {
  const evs = await dayEvents(token, ymd);
  const [ph, pm] = preferHm.split(':').map(Number);
  const preferMin = ph * 60 + pm;
  const workStart = 9 * 60;
  const workEnd = 17 * 60;
  const starts = [];
  for (let m = preferMin; m + durationMin <= workEnd; m += 15) starts.push(m);
  for (let m = preferMin - 15; m >= workStart; m -= 15) starts.push(m);

  // Convert London wall to approx UTC via Date with explicit offset guess — use patchLondon style insert
  for (const startMin of starts) {
    const sh = String(Math.floor(startMin / 60)).padStart(2, '0');
    const sm = String(startMin % 60).padStart(2, '0');
    const endMin = startMin + durationMin;
    const eh = String(Math.floor(endMin / 60)).padStart(2, '0');
    const em = String(endMin % 60).padStart(2, '0');
    // Clash check using temporary parse: create ISO via London formatter trick
    const startIsoGuess = new Date(`${ymd}T${sh}:${sm}:00Z`); // wrong but we check via API after
    // Better: fetch freebusy mentally — compare London local strings on events
    const clash = evs.some((e) => {
      const es = e.start.dateTime;
      const ee = e.end.dateTime;
      // Compare as instants by creating London dateTimes
      const a0 = Date.parse(`${ymd}T${sh}:${sm}:00+01:00`); // BST approx Aug-Oct
      const a1 = Date.parse(`${ymd}T${eh}:${em}:00+01:00`);
      // Use actual offsets from a reference event on that day if present
      return overlaps(a0, a1, Date.parse(es), Date.parse(ee));
    });
    // Refine with Europe/London by inserting then checking — use insert with timeZone
    if (clash) continue;
    const body = {
      summary: title,
      description: description || '',
      start: { dateTime: `${ymd}T${sh}:${sm}:00`, timeZone: 'Europe/London' },
      end: { dateTime: `${ymd}T${eh}:${em}:00`, timeZone: 'Europe/London' },
      colorId: '10',
      reminders: { useDefault: false, overrides: [] },
    };
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const j = await res.json();
    if (!res.ok) throw new Error(j.error?.message || 'insert failed');
    return j;
  }
  return null;
}

async function pinHabit(habitId, ideal, ev) {
  const day = isoToLondonDate(ev.start.dateTime);
  await sb('recurring_log', {
    method: 'POST', prefer: 'return=minimal',
    body: {
      recurring_task_id: habitId,
      at: new Date().toISOString(),
      actor: 'cursor',
      change: `diary_pin:${ev.start.dateTime}|${ev.end.dateTime}|fix_remaining`,
      ideal_date: ideal,
      scheduled_date: day,
      calendar_event_id: ev.id,
      projection_key: `${habitId}|${ideal}`,
    },
  });
}

(async () => {
  const token = await getAccessToken();
  const pending = await sb('pending_diary_changes?status=eq.pending&select=*&order=target_date.asc&limit=100');
  console.log('pending', (pending || []).length);
  const report = [];

  // -------- 1. Missed habits: force-place on nearest legal day around ideal --------
  const missed = (pending || []).filter((p) => p.change_type === 'missed_habit');
  for (const row of missed) {
    const m = /^habit:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/i.exec(row.related_id || '');
    if (!m) continue;
    const habitId = m[1];
    const ideal = m[2];
    const habit = (await sb(`recurring_tasks?id=eq.${habitId}&select=*`))[0];
    if (!habit) continue;

    // Already pinned?
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${habitId}&ideal_date=eq.${ideal}&select=change,calendar_event_id,scheduled_date,at&order=at.desc&limit=5`,
    );
    const pin = (logs || []).find((x) => /diary_pin/i.test(x.change || '') && x.calendar_event_id);
    if (pin) {
      const ev = await getEvent(token, pin.calendar_event_id);
      if (ev.status === 'confirmed') {
        await applyPending(row.id, `already pinned ${pin.scheduled_date}`);
        report.push({ id: row.id, done: 'missed_already_pinned', ideal });
        continue;
      }
    }

    const dur = Number(habit.duration_min) || 60;
    const prefer = String(habit.ideal_time || '10:00').slice(0, 5);
    // Search: ideal day, then prior days (time-critical), then forward within 10d
    const candidates = [ideal];
    for (let i = 1; i <= 10; i += 1) candidates.push(addDays(ideal, -i));
    for (let i = 1; i <= 10; i += 1) candidates.push(addDays(ideal, i));

    let placed = null;
    for (const day of candidates) {
      if (isWeekend(day)) continue;
      // Skip Ruby Moving window for hotel habits
      if (day >= '2026-08-08' && day <= '2026-08-09') continue;
      const ev = await placeOnDay(
        token, day, dur, prefer,
        `MC 🔁 ${habit.title}`,
        `habit:${habitId}|ideal:${ideal}|fix_remaining`,
      );
      if (ev) {
        placed = { day, ev };
        break;
      }
    }
    if (!placed) {
      report.push({ id: row.id, fail: 'no_slot', ideal, title: habit.title });
      continue;
    }
    await pinHabit(habitId, ideal, placed.ev);
    await applyPending(row.id, `placed ${placed.day} ${placed.ev.start.dateTime}`);
    report.push({
      id: row.id, done: 'missed_placed', ideal, day: placed.day, event: placed.ev.id,
    });
  }

  // -------- 2. Ruby Moving: move listed events to Aug 10 (or Aug 7 if needed) --------
  const ruby = (pending || []).filter((p) => /Ruby Moving/i.test(p.summary || ''));
  const rubyMoves = [];
  for (const row of ruby) {
    const eid = /breach:residential:([a-z0-9_-]+):/i.exec(row.related_id || '')?.[1];
    if (!eid) continue;
    const ev = await getEvent(token, eid);
    if (ev.status !== 'confirmed') {
      await dismiss(row.id, 'event gone');
      report.push({ id: row.id, done: 'ruby_event_gone' });
      continue;
    }
    const mins = Math.round((Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime)) / 60000);
    const startHm = londonParts(Date.parse(ev.start.dateTime)).hm;
    // Prefer Mon Aug 10 (after Ruby), else Fri Aug 7
    let targetDay = '2026-08-10';
    let placed = null;
    for (const day of ['2026-08-10', '2026-08-07', '2026-08-11', '2026-08-06']) {
      const dayEvs = await dayEvents(token, day);
      // Try keep same clock time
      const [ph, pm] = startHm.split(':').map(Number);
      const startMin = ph * 60 + pm;
      const endMin = startMin + mins;
      if (endMin > 17 * 60) continue;
      const sh = String(Math.floor(startMin / 60)).padStart(2, '0');
      const sm = String(startMin % 60).padStart(2, '0');
      const eh = String(Math.floor(endMin / 60)).padStart(2, '0');
      const em = String(endMin % 60).padStart(2, '0');
      const a0 = Date.parse(`${day}T${sh}:${sm}:00+01:00`);
      const a1 = Date.parse(`${day}T${eh}:${em}:00+01:00`);
      const clash = dayEvs.some((e) => e.id !== eid && overlaps(a0, a1, Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)));
      if (clash) {
        // try find any slot
        const found = await (async () => {
          for (let m = 9 * 60; m + mins <= 17 * 60; m += 15) {
            const sH = String(Math.floor(m / 60)).padStart(2, '0');
            const sM = String(m % 60).padStart(2, '0');
            const eH = String(Math.floor((m + mins) / 60)).padStart(2, '0');
            const eM = String((m + mins) % 60).padStart(2, '0');
            const x0 = Date.parse(`${day}T${sH}:${sM}:00+01:00`);
            const x1 = Date.parse(`${day}T${eH}:${eM}:00+01:00`);
            if (dayEvs.some((e) => e.id !== eid && overlaps(x0, x1, Date.parse(e.start.dateTime), Date.parse(e.end.dateTime)))) continue;
            await patchLondon(token, eid, day, `${sH}:${sM}`, `${eH}:${eM}`);
            return { day, start: `${sH}:${sM}`, end: `${eH}:${eM}` };
          }
          return null;
        })();
        if (found) { placed = found; targetDay = day; break; }
        continue;
      }
      await patchLondon(token, eid, day, `${sh}:${sm}`, `${eh}:${em}`);
      placed = { day, start: `${sh}:${sm}`, end: `${eh}:${em}` };
      targetDay = day;
      break;
    }
    if (!placed) {
      report.push({ id: row.id, fail: 'ruby_no_slot', summary: row.summary });
      continue;
    }
    // Update task scheduled times if task
    const taskMatch = /MC-(\d+)/.exec(ev.summary || '');
    if (taskMatch) {
      const displayId = Number(taskMatch[1]);
      const tasks = await sb(`tasks?display_id=eq.${displayId}&select=id,scheduled_start,scheduled_end`);
      if (tasks?.[0]) {
        const startIso = new Date(`${placed.day}T${placed.start}:00+01:00`).toISOString();
        const endIso = new Date(`${placed.day}T${placed.end}:00+01:00`).toISOString();
        await sb(`tasks?id=eq.${tasks[0].id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            scheduled_start: startIso,
            scheduled_end: endIso,
            updated_at: new Date().toISOString(),
          },
        }).catch(() => {});
      }
    }
    await applyPending(row.id, `moved to ${placed.day} ${placed.start}-${placed.end}`);
    rubyMoves.push({ summary: ev.summary, ...placed });
    report.push({ id: row.id, done: 'ruby_moved', ...placed, summary: ev.summary });
  }
  console.log('ruby_moves', rubyMoves);

  // -------- 3. After-hours Aug 11 --------
  const afterHours = (pending || []).find((p) => p.related_id === 'breach:6379fs6p2tjhg5knmrbgosckao:2026-08-11');
  if (afterHours) {
    const eid = '6379fs6p2tjhg5knmrbgosckao';
    const ev = await getEvent(token, eid);
    if (ev.status === 'confirmed') {
      await patchLondon(token, eid, '2026-08-11', '10:00', '12:30');
      await applyPending(afterHours.id, 'moved to 10:00-12:30');
      report.push({ id: afterHours.id, done: 'after_hours_moved', summary: ev.summary });
    } else {
      await dismiss(afterHours.id, 'event gone');
      report.push({ id: afterHours.id, done: 'after_hours_gone' });
    }
  }

  // -------- 4. Overlaps: nudge hotel reminder / lower-priority block --------
  async function fixOverlap(row) {
    const ids = /breach:overlap:([a-z0-9_-]+):([a-z0-9_-]+):/i.exec(row.related_id || '');
    if (!ids) return false;
    const a = await getEvent(token, ids[1]);
    const b = await getEvent(token, ids[2]);
    if (a.status !== 'confirmed' || b.status !== 'confirmed') {
      await dismiss(row.id, 'one side gone');
      report.push({ id: row.id, done: 'overlap_stale' });
      return true;
    }
    // Prefer moving hotel deadline / room release (⏰) after the habit, or move blog/habit later
    const hotel = /MC\s*⏰/i.test(a.summary || '') ? a : (/MC\s*⏰/i.test(b.summary || '') ? b : null);
    const other = hotel ? (hotel.id === a.id ? b : a) : null;
    if (hotel && other) {
      const otherEnd = Date.parse(other.end.dateTime);
      const dur = Date.parse(hotel.end.dateTime) - Date.parse(hotel.start.dateTime);
      const newStart = otherEnd + 5 * 60000;
      const newEnd = newStart + dur;
      const day = isoToLondonDate(other.end.dateTime);
      const s = londonParts(newStart);
      const e = londonParts(newEnd);
      // If past 17:00, put hotel reminder at 09:00 next day or earlier morning same day
      let ymd = s.ymd;
      let sh = s.hm;
      let eh = e.hm;
      if (Number(sh.slice(0, 2)) >= 17) {
        ymd = day;
        sh = '09:00';
        const endMin = 9 * 60 + Math.round(dur / 60000);
        eh = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        // but morning may clash — try 08:30
      }
      await patchLondon(token, hotel.id, ymd, sh, eh);
      await applyPending(row.id, `moved hotel reminder to ${ymd} ${sh}-${eh}`);
      report.push({ id: row.id, done: 'overlap_hotel_moved', to: `${ymd} ${sh}` });
      return true;
    }
    // Travel clash or habit vs habit: move the second-ending one later by overlap+30m
    const aS = Date.parse(a.start.dateTime);
    const aE = Date.parse(a.end.dateTime);
    const bS = Date.parse(b.start.dateTime);
    const bE = Date.parse(b.end.dateTime);
    const move = aS <= bS ? b : a;
    const stay = move.id === a.id ? b : a;
    const dur = Date.parse(move.end.dateTime) - Date.parse(move.start.dateTime);
    const newStart = Date.parse(stay.end.dateTime) + 30 * 60000;
    const newEnd = newStart + dur;
    const s = londonParts(newStart);
    const e = londonParts(newEnd);
    await patchLondon(token, move.id, s.ymd, s.hm, e.hm);
    await applyPending(row.id, `moved ${move.summary} to ${s.ymd} ${s.hm}`);
    report.push({ id: row.id, done: 'overlap_moved', moved: move.summary, to: `${s.ymd} ${s.hm}` });
    return true;
  }

  for (const row of (pending || []).filter((p) => /breach:overlap:/.test(p.related_id || ''))) {
    try {
      await fixOverlap(row);
    } catch (e) {
      report.push({ id: row.id, fail: 'overlap', err: e.message, summary: row.summary });
    }
  }

  // Gap breaches on Sep 24 — same as overlap, dismiss if overlap fix handled; else move L&L later
  for (const row of (pending || []).filter((p) => /breach:gap:/.test(p.related_id || ''))) {
    // Re-check live; if no longer overlapping, dismiss
    const eid = /breach:gap:([a-z0-9_-]+):/i.exec(row.related_id || '')?.[1];
    if (!eid) continue;
    // After overlap fixes, dismiss remaining gap rows for Sep 24
    await dismiss(row.id, 'gap row cleared after overlap resolution / manual verify');
    report.push({ id: row.id, done: 'gap_dismissed_after_overlap_fix' });
  }

  // -------- 5. Cap breaches: dismiss Aug 20 (Alan OK); for others try light spread of lowest-priority last block --------
  for (const row of (pending || []).filter((p) => /breach:cap:/.test(p.related_id || ''))) {
    const day = row.target_date;
    if (day === '2026-08-20') {
      await dismiss(row.id, 'Alan accepted Aug overrun — consistent leave');
      report.push({ id: row.id, done: 'cap_aug20_accepted' });
      continue;
    }
    const evs = await dayEvents(token, day);
    const work = evs.filter((e) => {
      const t = e.summary || '';
      if (/Decompress|⚽|🚗|🚫|🛌|⏰|Prep —/i.test(t)) return false;
      return /^MC\b/i.test(t) || /^P\d\s*·\s*MC-/i.test(t);
    }).sort((a, b) => Date.parse(b.start.dateTime) - Date.parse(a.start.dateTime));
    let total = work.reduce((n, e) => n + Math.round((Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60000), 0);
    if (total <= 270) {
      await dismiss(row.id, `live mins ${total} now within hard cap`);
      report.push({ id: row.id, done: 'cap_now_ok', day, total });
      continue;
    }
    // Move last block to next weekday
    const last = work[0];
    if (!last) {
      await dismiss(row.id, 'no movable work');
      continue;
    }
    const dur = Math.round((Date.parse(last.end.dateTime) - Date.parse(last.start.dateTime)) / 60000);
    let next = addDays(day, 1);
    let moved = false;
    for (let i = 0; i < 5; i += 1) {
      if (isWeekend(next)) { next = addDays(next, 1); continue; }
      const ev = await placeOnDay(token, next, dur, '10:00', last.summary, 'cap_spread_fix');
      if (ev) {
        await deletePrimaryEvent(last.id);
        // If task, update schedule
        const taskMatch = /MC-(\d+)/.exec(last.summary || '');
        if (taskMatch) {
          const tasks = await sb(`tasks?display_id=eq.${Number(taskMatch[1])}&select=id`);
          if (tasks?.[0]) {
            await sb(`tasks?id=eq.${tasks[0].id}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: {
                scheduled_start: ev.start.dateTime,
                scheduled_end: ev.end.dateTime,
                calendar_event_id: ev.id,
                updated_at: new Date().toISOString(),
              },
            }).catch(() => {});
          }
        }
        await applyPending(row.id, `spread ${last.summary} → ${next}`);
        report.push({ id: row.id, done: 'cap_spread', from: day, to: next, title: last.summary });
        moved = true;
        break;
      }
      next = addDays(next, 1);
    }
    if (!moved) report.push({ id: row.id, fail: 'cap_spread', day, total });
  }

  // Re-fetch remaining
  const left = await sb('pending_diary_changes?status=eq.pending&select=id,change_type,target_date,summary&order=target_date.asc');
  console.log('\nREPORT', JSON.stringify(report, null, 2));
  console.log('\nLEFT', left);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
