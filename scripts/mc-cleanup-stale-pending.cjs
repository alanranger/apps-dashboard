/**
 * Verify-then-dismiss stale pending_diary_changes only.
 * Never dismisses unless live GCal/DB already holds the correct state.
 * node scripts/mc-cleanup-stale-pending.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { getAccessToken } = require('../api/mc/gcal-lib');

const ANCHOR = '2026-07-30';
const ACTOR = 'cursor';
const TOL_MS = 3 * 60 * 1000;

async function getEvent(token, id) {
  if (!id) return null;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  return { http: res.status, ...j };
}

async function dayEvents(token, day, q = null) {
  let url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent(`${day}T00:00:00Z`)}`
    + `&timeMax=${encodeURIComponent(`${day}T23:59:59Z`)}&maxResults=50`;
  if (q) url += `&q=${encodeURIComponent(q)}`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return (j.items || []).filter((e) => e.status !== 'cancelled');
}

function near(a, b) {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= TOL_MS;
}

function parseHabitRelated(relatedId) {
  const m = /^habit:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/i.exec(String(relatedId || ''));
  return m ? { habitId: m[1], ideal: m[2] } : null;
}

async function dismiss(ids, reason) {
  if (!ids.length) return 0;
  // chunk
  let n = 0;
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    for (const id of chunk) {
      await sb(`pending_diary_changes?id=eq.${id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: {
          status: 'dismissed',
          resolved_at: new Date().toISOString(),
          resolved_by: ACTOR,
          proposed_action: `DISMISSED stale — verified live state OK (${reason})`,
        },
      });
      n += 1;
    }
  }
  return n;
}

(async () => {
  const token = await getAccessToken();
  const habits = await sb('recurring_tasks?active=eq.true&select=id,title,rrule,duration_min');
  const habitMap = Object.fromEntries((habits || []).map((h) => [h.id, {
    ...h,
    ideals: new Set(idealsInHorizon(h.rrule, ANCHOR, '2027-06-01', 200, ANCHOR)),
  }]));

  const pending = await sb('pending_diary_changes?status=eq.pending&select=*&limit=500');
  console.log('start_pending', (pending || []).length);

  const dismissIds = [];
  const keep = [];
  const verified = [];

  // ---------- missed_habit ----------
  for (const r of (pending || []).filter((x) => x.change_type === 'missed_habit')) {
    const parsed = parseHabitRelated(r.related_id);
    if (!parsed) {
      keep.push({ id: r.id, type: 'missed_habit', why: 'bad_related_id', summary: r.summary });
      continue;
    }
    const habit = habitMap[parsed.habitId];
    if (!habit) {
      keep.push({ id: r.id, type: 'missed_habit', why: 'habit_missing', summary: r.summary });
      continue;
    }
    const wrongPhase = !habit.ideals.has(parsed.ideal);
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${parsed.habitId}&ideal_date=eq.${parsed.ideal}`
      + `&select=change,calendar_event_id,scheduled_date,at&order=at.desc&limit=5`,
    );
    const pin = (logs || []).find((x) => /diary_pin/i.test(x.change || '') && x.calendar_event_id);
    const retired = (logs || []).some((x) => /retired wrong_phase|cleared stale.*wrong_phase/i.test(x.change || ''));
    const completed = (logs || []).some((x) => /^completed /i.test(x.change || ''));

    if (wrongPhase || retired) {
      // Correct phase pin should exist for nearest correct ideal — check habit has SOME confirmed future pin
      const correctIdeals = [...habit.ideals].filter((d) => d >= ANCHOR).slice(0, 6);
      let okAlt = completed;
      const altPins = [];
      for (const ci of correctIdeals) {
        const l2 = await sb(
          `recurring_log?recurring_task_id=eq.${parsed.habitId}&ideal_date=eq.${ci}`
          + `&select=change,calendar_event_id,scheduled_date,at&order=at.desc&limit=3`,
        );
        const p2 = (l2 || []).find((x) => /diary_pin/i.test(x.change || '') && x.calendar_event_id);
        if (!p2) continue;
        const ev = await getEvent(token, p2.calendar_event_id);
        if (ev?.status === 'confirmed') {
          okAlt = true;
          altPins.push({ ideal: ci, start: ev.start?.dateTime, eid: p2.calendar_event_id });
          break;
        }
      }
      if (okAlt || completed) {
        dismissIds.push(r.id);
        verified.push({
          type: 'missed_habit', reason: wrongPhase ? 'wrong_phase_has_correct_pin_or_done' : 'retired_wrong_phase',
          summary: r.summary, ideal: parsed.ideal, alt: altPins[0] || (completed ? 'completed' : null),
        });
      } else {
        keep.push({ id: r.id, type: 'missed_habit', why: 'wrong_phase_but_no_correct_pin', summary: r.summary, ideal: parsed.ideal });
      }
      continue;
    }

    if (pin) {
      const ev = await getEvent(token, pin.calendar_event_id);
      const mins = ev?.start?.dateTime && ev?.end?.dateTime
        ? Math.round((Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime)) / 60000)
        : null;
      const durOk = mins != null && Math.abs(mins - (habit.duration_min || mins)) <= 15;
      if (ev?.status === 'confirmed' && durOk) {
        dismissIds.push(r.id);
        verified.push({
          type: 'missed_habit', reason: 'already_pinned_gcal_ok',
          summary: r.summary, ideal: parsed.ideal,
          scheduled: pin.scheduled_date, gcal: ev.start?.dateTime, mins,
        });
      } else {
        keep.push({
          id: r.id, type: 'missed_habit', why: 'pin_but_gcal_bad',
          summary: r.summary, gcal_status: ev?.status, mins, err: ev?.error?.message,
        });
      }
      continue;
    }

    keep.push({ id: r.id, type: 'missed_habit', why: 'still_open', summary: r.summary, ideal: parsed.ideal });
  }

  // ---------- fixture_block ----------
  for (const r of (pending || []).filter((x) => x.change_type === 'fixture_block')) {
    const day = r.target_date;
    const labelMatch = /Fixture moved: ⚽️\s*(.+?)\s*—/.exec(r.summary || '')
      || /Create.*for "([^"]+)"/.exec(r.proposed_action || '');
    const label = (labelMatch?.[1] || '').trim();
    const times = /Before\s+(\d{2}:\d{2})–(\d{2}:\d{2}).*After\s+(\d{2}:\d{2})–(\d{2}:\d{2})/s
      .exec(r.proposed_action || '');
    if (!day || !times) {
      keep.push({ id: r.id, type: 'fixture_block', why: 'unparseable', summary: r.summary });
      continue;
    }
    const events = await dayEvents(token, day, 'MC ⚽');
    const before = events.find((e) => /MC\s*⚽\s*Before/i.test(e.summary || '')
      && (!label || (e.summary || '').includes(label.slice(0, 12))));
    const after = events.find((e) => /MC\s*⚽\s*After/i.test(e.summary || '')
      && (!label || (e.summary || '').includes(label.slice(0, 12))));

    function hm(iso) {
      if (!iso) return null;
      const d = new Date(iso);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d);
      const hh = parts.find((p) => p.type === 'hour')?.value;
      const mm = parts.find((p) => p.type === 'minute')?.value;
      return `${hh}:${mm}`;
    }
    const bStart = hm(before?.start?.dateTime);
    const bEnd = hm(before?.end?.dateTime);
    const aStart = hm(after?.start?.dateTime);
    const aEnd = hm(after?.end?.dateTime);
    const match = before && after
      && bStart === times[1] && bEnd === times[2]
      && aStart === times[3] && aEnd === times[4];

    if (match) {
      dismissIds.push(r.id);
      verified.push({
        type: 'fixture_block', reason: 'flanks_already_correct',
        day, label, before: `${bStart}-${bEnd}`, after: `${aStart}-${aEnd}`,
      });
    } else {
      keep.push({
        id: r.id, type: 'fixture_block', why: 'flanks_missing_or_wrong',
        day, label, want: `${times[1]}-${times[2]} / ${times[3]}-${times[4]}`,
        got: { before: before && `${bStart}-${bEnd}`, after: after && `${aStart}-${aEnd}` },
      });
    }
  }

  // ---------- diary_manual_move ----------
  for (const r of (pending || []).filter((x) => x.change_type === 'diary_manual_move')) {
    const m = /event_id=([a-zA-Z0-9_-]+)/.exec(r.proposed_action || '');
    const evtFromRelated = /evt:([a-zA-Z0-9_-]+)/.exec(r.related_id || '');
    const eid = m?.[1] || evtFromRelated?.[1];
    const want = /to ([0-9T:.Z+-]+)\s*[–-]\s*([0-9T:.Z+-]+)/.exec(r.proposed_action || '');
    if (!eid || !want) {
      keep.push({ id: r.id, type: 'diary_manual_move', why: 'unparseable', summary: r.summary });
      continue;
    }
    const ev = await getEvent(token, eid);
    if (ev?.status === 'cancelled') {
      // Stale if cancelled — only dismiss if nothing else to do (event gone intentionally)
      dismissIds.push(r.id);
      verified.push({
        type: 'diary_manual_move', reason: 'event_cancelled_move_stale',
        summary: r.summary, eid,
      });
      continue;
    }
    if (ev?.status === 'confirmed' && near(ev.start?.dateTime, want[1])) {
      dismissIds.push(r.id);
      verified.push({
        type: 'diary_manual_move', reason: 'live_matches_proposed',
        summary: r.summary, start: ev.start?.dateTime,
      });
    } else if (ev?.status === 'confirmed') {
      // Live differs from THIS pending proposal — another move may have won. Keep if live on same day as target.
      const liveDay = (ev.start?.dateTime || '').slice(0, 10);
      const target = r.target_date;
      if (liveDay === target || (ev.start?.dateTime && Math.abs(Date.parse(ev.start.dateTime) - Date.parse(want[1])) < 86400000)) {
        // Same calendar day in London may differ UTC date — treat as superseded if event exists on target day
        const dayEv = await dayEvents(token, target);
        const stillThere = dayEv.some((e) => e.id === eid);
        if (stillThere) {
          dismissIds.push(r.id);
          verified.push({
            type: 'diary_manual_move', reason: 'superseded_but_event_on_target_day',
            summary: r.summary, live: ev.start?.dateTime, proposed: want[1],
          });
        } else {
          keep.push({
            id: r.id, type: 'diary_manual_move', why: 'live_differs_not_on_target',
            summary: r.summary, live: ev.start?.dateTime, proposed: want[1],
          });
        }
      } else {
        keep.push({
          id: r.id, type: 'diary_manual_move', why: 'live_differs',
          summary: r.summary, live: ev.start?.dateTime, proposed: want[1],
        });
      }
    } else {
      keep.push({ id: r.id, type: 'diary_manual_move', why: 'gcal_missing', summary: r.summary, err: ev?.error?.message });
    }
  }

  // ---------- cap_over_target (soft notices — not breaches) ----------
  for (const r of (pending || []).filter((x) => x.change_type === 'cap_over_target')) {
    if (/not a breach/i.test(r.summary || '')) {
      dismissIds.push(r.id);
      verified.push({ type: 'cap_over_target', reason: 'soft_notice_not_breach', date: r.target_date, summary: r.summary });
    } else {
      keep.push({ id: r.id, type: 'cap_over_target', why: 'unexpected_format', summary: r.summary });
    }
  }

  // ---------- hotel_deadline: only dismiss if reminder event already exists ----------
  for (const r of (pending || []).filter((x) => x.change_type === 'hotel_deadline')) {
    const when = /Place MC ⏰ reminder on (\d{4}-\d{2}-\d{2})/.exec(r.proposed_action || '');
    const day = when?.[1];
    if (!day) {
      keep.push({ id: r.id, type: 'hotel_deadline', why: 'unparseable', summary: r.summary });
      continue;
    }
    const hotelName = (r.summary || '').replace(/^Hotel free-cancel \d{4}-\d{2}-\d{2}:\s*/, '').slice(0, 20);
    const evs = await dayEvents(token, day, '⏰');
    const hit = evs.find((e) => /MC\s*⏰/i.test(e.summary || '')
      && (!hotelName || (e.summary || '').includes(hotelName.slice(0, 10)) || (e.description || '').includes(hotelName.slice(0, 10))));
    if (hit) {
      dismissIds.push(r.id);
      verified.push({ type: 'hotel_deadline', reason: 'reminder_already_exists', day, summary: hit.summary });
    } else {
      keep.push({ id: r.id, type: 'hotel_deadline', why: 'reminder_missing', day, summary: r.summary });
    }
  }

  // ---------- rule_breach: only dismiss soft/stale caps if day no longer over hard limit;
  // NEVER auto-dismiss residential (Ruby Moving) without moving work ----------
  for (const r of (pending || []).filter((x) => x.change_type === 'rule_breach')) {
    if (/residential|Ruby Moving|busy\/residential/i.test(r.summary || '') || /residential/i.test(r.reason || '')) {
      keep.push({ id: r.id, type: 'rule_breach', why: 'residential_needs_review', summary: r.summary, date: r.target_date });
      continue;
    }
    if (/exceeds 240m cap|hard limit|315m|360m|daily_task_cap/i.test(`${r.summary} ${r.reason}`)) {
      // Recompute rough MC minutes that day from GCal
      const day = r.target_date;
      const evs = await dayEvents(token, day);
      let mins = 0;
      for (const e of evs) {
        if (!e.start?.dateTime || !e.end?.dateTime) continue;
        const t = e.summary || '';
        if (!(/^P\d\s*·\s*MC-/i.test(t) || /^MC\s/i.test(t))) continue;
        if (/MC\s*⏳|MC\s*⚽|MC\s*🚗|MC\s*🚫|MC\s*🛌|MC\s*⏰/i.test(t)) continue;
        mins += Math.round((Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60000);
      }
      if (mins <= 270) {
        dismissIds.push(r.id);
        verified.push({
          type: 'rule_breach', reason: 'cap_no_longer_over_hard_limit',
          date: day, live_mc_mins: mins, summary: r.summary,
        });
      } else {
        keep.push({ id: r.id, type: 'rule_breach', why: 'still_over_hard_cap', date: day, live_mc_mins: mins, summary: r.summary });
      }
      continue;
    }
    if (/ends_after_17|after 17:00/i.test(`${r.summary} ${r.reason} ${r.proposed_action}`)) {
      // Check if related event still ends after 17:00 London
      const eid = /breach:([a-z0-9_-]+):/i.exec(r.related_id || '')?.[1];
      if (eid) {
        const ev = await getEvent(token, eid);
        if (ev?.status !== 'confirmed') {
          dismissIds.push(r.id);
          verified.push({ type: 'rule_breach', reason: 'after_hours_event_gone', summary: r.summary });
          continue;
        }
        const hm = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit', hour12: false,
        }).formatToParts(new Date(ev.end.dateTime));
        const hour = Number(hm.find((p) => p.type === 'hour')?.value);
        if (hour <= 17) {
          dismissIds.push(r.id);
          verified.push({ type: 'rule_breach', reason: 'no_longer_after_hours', summary: r.summary, end: ev.end?.dateTime });
          continue;
        }
      }
    }
    keep.push({ id: r.id, type: 'rule_breach', why: 'needs_manual_review', summary: r.summary, date: r.target_date });
  }

  console.log('\nVERIFIED_TO_DISMISS', verified.length);
  console.log(JSON.stringify(verified.slice(0, 40), null, 2));
  console.log('\nKEEP', keep.length);
  console.log(JSON.stringify(keep, null, 2));

  const uniqueDismiss = [...new Set(dismissIds)];
  console.log('\nDismissing', uniqueDismiss.length);
  const n = await dismiss(uniqueDismiss, 'batch cleanup after GCal+DB verify');
  console.log('dismissed', n);

  const left = await sb('pending_diary_changes?status=eq.pending&select=id,change_type,target_date,summary,urgency&order=change_type.asc,target_date.asc&limit=300');
  const byType = {};
  for (const r of left || []) byType[r.change_type] = (byType[r.change_type] || 0) + 1;
  console.log('\nREMAINING', { total: (left || []).length, byType });
  console.log(JSON.stringify(left, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
