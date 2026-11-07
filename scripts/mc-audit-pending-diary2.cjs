/**
 * Classify missed_habit pending rows vs current recurring_log / phase.
 * Also check one fixture flank day + Ruby Moving day on GCal.
 * node scripts/mc-audit-pending-diary2.cjs
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

(async () => {
  const habits = await sb('recurring_tasks?active=eq.true&select=id,title,rrule');
  const byTitle = (habits || []).map((h) => ({
    ...h,
    ideals: new Set(idealsInHorizon(h.rrule, ANCHOR, '2027-06-01', 200, ANCHOR)),
  }));

  const missed = await sb(
    "pending_diary_changes?status=eq.pending&change_type=eq.missed_habit&select=*&order=target_date.asc&limit=100",
  );

  const counts = {
    stale_wrong_phase: 0,
    stale_already_pinned: 0,
    still_unplaced: 0,
    no_matching_habit: 0,
    unclear: 0,
  };
  const samples = { stale_wrong_phase: [], stale_already_pinned: [], still_unplaced: [], no_matching_habit: [], unclear: [] };

  for (const r of missed || []) {
    const sum = r.summary || '';
    const habit = byTitle.find((h) => sum.includes(h.title) || sum.includes(h.title.slice(0, 28)));
    const ideal = r.target_date;
    if (!habit) {
      counts.no_matching_habit += 1;
      if (samples.no_matching_habit.length < 5) samples.no_matching_habit.push({ date: ideal, summary: sum.slice(0, 100), related: r.related_id });
      continue;
    }
    const wrongPhase = ideal && !habit.ideals.has(ideal);
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${habit.id}&ideal_date=eq.${ideal}&select=change,calendar_event_id,scheduled_date,at&order=at.desc&limit=3`,
    );
    const latest = logs?.[0];
    const anyPin = (logs || []).find((x) => /diary_pin/i.test(x.change || '') && x.calendar_event_id);
    let verdict = 'unclear';
    if (wrongPhase) verdict = 'stale_wrong_phase';
    else if (anyPin) verdict = 'stale_already_pinned';
    else if (latest && /unplaced|retired|cleared/i.test(latest.change || '')) verdict = 'still_unplaced';
    else if (!latest) verdict = 'still_unplaced';
    counts[verdict] += 1;
    if (samples[verdict].length < 6) {
      samples[verdict].push({
        date: ideal,
        habit: habit.title.slice(0, 45),
        summary: sum.slice(0, 90),
        action: (r.proposed_action || '').slice(0, 110),
        latest: latest ? (latest.change || '').slice(0, 70) : null,
        related: r.related_id,
      });
    }
  }
  console.log('missed_habit_verdicts', counts);
  console.log(JSON.stringify(samples, null, 2));

  // Ruby Moving / Easy Moving on Aug 8-9
  const token = await getAccessToken();
  for (const day of ['2026-08-08', '2026-08-09']) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
      + `&timeMin=${encodeURIComponent(`${day}T00:00:00Z`)}`
      + `&timeMax=${encodeURIComponent(`${day}T23:59:59Z`)}&maxResults=40`;
    const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
    const items = (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      transparency: e.transparency || 'opaque',
    }));
    console.log(`\nDAY ${day}`, items.filter((e) => /Ruby|Moving|MC-|P\d/i.test(e.summary || '')));
  }

  // Fixture flank check for first Ipswich fixture day
  const day = '2026-08-22';
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent(`${day}T00:00:00Z`)}`
    + `&timeMax=${encodeURIComponent(`${day}T23:59:59Z`)}`
    + `&q=${encodeURIComponent('Ipswich')}&maxResults=20`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  console.log('\nFIXTURE 2026-08-22', (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    summary: e.summary, start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
  })));

  // diary_manual_move: compare proposed time vs live event
  const moves = await sb("pending_diary_changes?status=eq.pending&change_type=eq.diary_manual_move&select=*&limit=20");
  console.log('\nMANUAL_MOVES_CHECK');
  for (const r of moves || []) {
    const m = /event_id=([a-zA-Z0-9_-]+)/.exec(r.proposed_action || '');
    const evtFromRelated = /evt:([a-zA-Z0-9_-]+)/.exec(r.related_id || '');
    const eid = m?.[1] || evtFromRelated?.[1];
    if (!eid) { console.log({ summary: r.summary, no_eid: true, related: r.related_id }); continue; }
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eid)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const ev = await res.json();
    const want = /to ([0-9T:.Z+-]+) – ([0-9T:.Z+-]+)/.exec(r.proposed_action || '')
      || /to ([0-9T:.Z+-]+) - ([0-9T:.Z+-]+)/.exec(r.proposed_action || '');
    console.log({
      summary: (r.summary || '').slice(0, 80),
      proposed: want ? [want[1], want[2]] : null,
      live: { status: ev.status, start: ev.start?.dateTime, end: ev.end?.dateTime, err: ev.error?.message },
      already_matches: want && ev.start?.dateTime && (
        Math.abs(Date.parse(ev.start.dateTime) - Date.parse(want[1])) < 120000
      ),
    });
  }
})().catch((e) => { console.error(e); process.exit(1); });
