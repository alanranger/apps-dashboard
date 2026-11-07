/**
 * Audit pending_diary_changes — report only, no accept/dismiss.
 * node scripts/mc-audit-pending-diary.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { getAccessToken } = require('../api/mc/gcal-lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');

const ANCHOR = '2026-07-30';

function patternKey(summary) {
  return String(summary || '')
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/MC-\d+/g, 'MC-N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function getEvent(token, id) {
  if (!id || !String(id).startsWith && false) return null;
  const eid = String(id).replace(/^gcal:/, '').replace(/^event:/, '');
  // related_id formats vary
  const m = /([a-z0-9]{20,})$/i.exec(String(id));
  const eventId = m ? m[1] : null;
  if (!eventId) return { skipped: true, related: id };
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  return { http: res.status, status: j.status, summary: j.summary, start: j.start, end: j.end, err: j.error?.message };
}

(async () => {
  const rows = await sb(
    'pending_diary_changes?status=eq.pending&select=*&order=change_type.asc,target_date.asc&limit=500',
  );
  console.log('total_pending', (rows || []).length);

  const byType = {};
  for (const r of rows || []) {
    if (!byType[r.change_type]) byType[r.change_type] = [];
    byType[r.change_type].push(r);
  }

  const token = await getAccessToken();
  const habits = await sb('recurring_tasks?active=eq.true&select=id,title,rrule');
  const habitById = Object.fromEntries((habits || []).map((h) => [h.id, h]));

  // Correct-phase ideals for active habits
  const correctIdeals = new Map(); // habitId -> Set
  for (const h of habits || []) {
    try {
      correctIdeals.set(h.id, new Set(idealsInHorizon(h.rrule, ANCHOR, '2027-03-01', 200, ANCHOR)));
    } catch (_) {
      correctIdeals.set(h.id, new Set());
    }
  }

  const assessment = {};

  for (const [type, list] of Object.entries(byType)) {
    const patterns = {};
    for (const r of list) {
      const k = patternKey(r.summary);
      patterns[k] = (patterns[k] || 0) + 1;
    }
    const dates = list.map((r) => r.target_date).filter(Boolean).sort();
    console.log(`\n==== ${type} (${list.length}) ====`);
    console.log('date_range', dates[0], '->', dates[dates.length - 1]);
    console.log('top_patterns', Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 10));

    const typeAssess = {
      count: list.length,
      likely_stale: 0,
      likely_still_valid: 0,
      unclear: 0,
      samples: [],
      notes: [],
    };

    // Type-specific checks
    if (type === 'missed_habit') {
      for (const r of list) {
        // related_id often habitId|ideal or similar
        const rid = String(r.related_id || '');
        let habitId = null;
        let ideal = r.target_date;
        const parts = rid.split('|');
        if (parts[0] && habitById[parts[0]]) {
          habitId = parts[0];
          if (parts[1] && /^\d{4}-\d{2}-\d{2}$/.test(parts[1])) ideal = parts[1];
        } else if (habitById[rid]) habitId = rid;

        const habit = habitId ? habitById[habitId] : null;
        const ideals = habitId ? correctIdeals.get(habitId) : null;
        const wrongPhase = ideals && ideal && !ideals.has(ideal);
        const titleHit = (habits || []).find((h) => (r.summary || '').includes(h.title.slice(0, 20)));

        // latest log for that ideal
        let latestLog = null;
        if (habitId && ideal) {
          const logs = await sb(
            `recurring_log?recurring_task_id=eq.${habitId}&ideal_date=eq.${ideal}&select=change,calendar_event_id,scheduled_date,at&order=at.desc&limit=1`,
          );
          latestLog = logs?.[0] || null;
        }

        const pinned = latestLog && /diary_pin/i.test(latestLog.change || '') && latestLog.calendar_event_id;
        const retired = latestLog && /retired|cleared stale|wrong_phase/i.test(latestLog.change || '');
        const unplaced = latestLog && /unplaced/i.test(latestLog.change || '');

        let verdict = 'unclear';
        if (wrongPhase || retired) verdict = 'stale_wrong_phase';
        else if (pinned) verdict = 'stale_already_pinned';
        else if (unplaced) verdict = 'still_open_unplaced';
        else if (!latestLog && wrongPhase) verdict = 'stale_wrong_phase';
        else verdict = 'unclear';

        if (verdict.startsWith('stale')) typeAssess.likely_stale += 1;
        else if (verdict.startsWith('still')) typeAssess.likely_still_valid += 1;
        else typeAssess.unclear += 1;

        if (typeAssess.samples.length < 8) {
          typeAssess.samples.push({
            date: r.target_date,
            summary: (r.summary || '').slice(0, 90),
            action: (r.proposed_action || '').slice(0, 120),
            related: r.related_id,
            habit: habit?.title?.slice(0, 40),
            ideal,
            wrongPhase: !!wrongPhase,
            latest: latestLog ? (latestLog.change || '').slice(0, 70) : null,
            verdict,
          });
        }
      }
    } else if (type === 'fixture_block') {
      // Usually "create decompress / prep / travel fixture" — check if GCal already has similar
      for (const r of list.slice(0, 12)) {
        typeAssess.samples.push({
          date: r.target_date,
          summary: (r.summary || '').slice(0, 90),
          action: (r.proposed_action || '').slice(0, 140),
          reason: (r.reason || '').slice(0, 100),
          related: r.related_id,
        });
      }
      typeAssess.notes.push('fixture_block rows are engine proposals to add MC fixture events (decompress/prep/etc). Need overlap check vs live GCal before accepting.');
      typeAssess.unclear = list.length;
    } else if (type === 'rule_breach') {
      for (const r of list.slice(0, 10)) {
        typeAssess.samples.push({
          date: r.target_date,
          summary: (r.summary || '').slice(0, 90),
          action: (r.proposed_action || '').slice(0, 140),
          reason: (r.reason || '').slice(0, 120),
          related: r.related_id,
          urgency: r.urgency,
        });
      }
      typeAssess.notes.push('rule_breach = heal/detect findings (overlap, decompress gap, blocked day). Many may be stale after resync moves.');
      typeAssess.unclear = list.length;
    } else if (type === 'cap_over_target') {
      for (const r of list) {
        typeAssess.samples.push({
          date: r.target_date,
          summary: (r.summary || '').slice(0, 100),
          action: (r.proposed_action || '').slice(0, 120),
          reason: (r.reason || '').slice(0, 100),
        });
      }
      typeAssess.unclear = list.length;
    } else if (type === 'diary_manual_move') {
      for (const r of list) {
        typeAssess.samples.push({
          date: r.target_date,
          summary: (r.summary || '').slice(0, 100),
          action: (r.proposed_action || '').slice(0, 140),
          reason: (r.reason || '').slice(0, 120),
          related: r.related_id,
        });
      }
      typeAssess.unclear = list.length;
    } else if (type === 'hotel_deadline') {
      for (const r of list) {
        typeAssess.samples.push({
          date: r.target_date,
          summary: (r.summary || '').slice(0, 100),
          action: (r.proposed_action || '').slice(0, 140),
          reason: (r.reason || '').slice(0, 120),
          related: r.related_id,
        });
      }
      typeAssess.unclear = list.length;
    }

    assessment[type] = typeAssess;
    console.log('assessment', JSON.stringify(typeAssess, null, 2));
  }

  // Spot-check a few rule_breach / fixture related GCal events
  console.log('\n==== LIVE SPOT CHECKS (rule_breach / fixture related_ids) ====');
  const spot = (rows || [])
    .filter((r) => r.change_type === 'rule_breach' || r.change_type === 'fixture_block')
    .slice(0, 15);
  for (const r of spot) {
    const ev = await getEvent(token, r.related_id);
    console.log({
      type: r.change_type,
      date: r.target_date,
      summary: (r.summary || '').slice(0, 80),
      related: r.related_id,
      gcal: ev,
    });
  }

  console.log('\n==== ROLLUP ====');
  let stale = 0; let open = 0; let unclear = 0;
  for (const a of Object.values(assessment)) {
    stale += a.likely_stale || 0;
    open += a.likely_still_valid || 0;
    unclear += a.unclear || 0;
  }
  console.log({ total: rows.length, likely_stale_missed_habit: assessment.missed_habit?.likely_stale, still_open_missed_habit: assessment.missed_habit?.likely_still_valid, unclear_other_types: unclear - (assessment.missed_habit?.unclear || 0) + (assessment.missed_habit?.unclear || 0) });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
