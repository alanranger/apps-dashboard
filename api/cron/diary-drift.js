/**
 * MC-43 nightly diary-drift detector.
 * Writes pending_diary_changes ONLY — never Google Calendar.
 */
const { json, sb } = require('../mc/_lib');
const { loadScheduleEvents, isHomeBased } = require('../mc/scheduleCsv');
const { ruleMapFromRows } = require('../mc/scheduling-rules-lib');
const { buildRuleBreachProposals } = require('../mc/rule-breach-lib');

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysYmd(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nextWorkingDay(ymd) {
  let d = addDaysYmd(ymd, 1);
  for (let i = 0; i < 7; i += 1) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDaysYmd(d, 1);
  }
  return d;
}

function lastDueSimple(rrule, today) {
  const parts = {};
  String(rrule || '').split(';').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.toUpperCase()] = v;
  });
  const freq = parts.FREQ;
  if (freq === 'WEEKLY' && parts.BYDAY) {
    const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    const want = map[String(parts.BYDAY).replace(/^-?\d+/, '').toUpperCase()];
    if (want == null) return null;
    let d = new Date(`${today}T12:00:00Z`);
    for (let i = 0; i < 14; i += 1) {
      const ymd = d.toISOString().slice(0, 10);
      if (d.getUTCDay() === want && ymd < today) return ymd;
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  if (freq === 'MONTHLY' && parts.BYMONTHDAY) {
    const dom = Number(parts.BYMONTHDAY);
    let y = Number(today.slice(0, 4));
    let m = Number(today.slice(5, 7)) - 1;
    for (let i = 0; i < 3; i += 1) {
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const day = Math.min(dom, last);
      const cand = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (cand < today) return cand;
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
    }
  }
  return null;
}

function authOk(req) {
  const secret = process.env.CRON_SECRET || process.env.MC_CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  const q = req.query || {};
  return h === `Bearer ${secret}` || q.force === '1';
}

async function existingPending(changeType, relatedId) {
  const rows = await sb(
    `pending_diary_changes?status=eq.pending&change_type=eq.${encodeURIComponent(changeType)}&related_id=eq.${encodeURIComponent(relatedId)}&limit=1`,
  );
  return rows?.[0];
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(res, 405, { error: 'method not allowed' });
  }
  if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
  if (!(process.env.MC_SUPABASE_URL && (process.env.MC_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY))) {
    return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  }

  const today = todayYmd();
  const inserted = [];
  const { sources, events, errors } = await loadScheduleEvents();
  const notes = [
    'calendar_writes: 0 (hard constraint)',
    ...sources.map((s) => `source ${s.id}: ${s.ok ? `${s.display} (${s.path})` : `FAIL ${s.error}`}`),
  ];

  // Stale / missing CSV → pending (never silent)
  for (const src of sources) {
    if (!src.ok) {
      const relatedId = `source_missing:${src.id}`;
      if (!(await existingPending('source_missing', relatedId))) {
        const row = await sb('pending_diary_changes', {
          method: 'POST',
          body: {
            change_type: 'source_missing',
            target_date: today,
            summary: `${src.label} missing or unreadable`,
            proposed_action: `Ensure ${src.name} exists in alan-shared-resources/csv on GitHub (auto-pushed ~every 10 min). Local dev override: MC_SCHEDULE_CSV_DIR.`,
            reason: src.error || 'missing',
            urgency: 'high',
            status: 'pending',
            related_id: relatedId,
          },
        });
        const id = Array.isArray(row) ? row[0]?.id : row?.id;
        if (id) inserted.push(id);
      }
      continue;
    }
    if (src.age_days != null && src.age_days > 14) {
      const relatedId = `source_stale:${src.id}:${Math.floor(src.age_days)}`;
      if (!(await existingPending('source_stale', relatedId))) {
        const row = await sb('pending_diary_changes', {
          method: 'POST',
          body: {
            change_type: 'source_stale',
            target_date: today,
            summary: `${src.label} is ${Math.floor(src.age_days)} days old — re-export from Squarespace before trusting this detection run.`,
            proposed_action: `Re-export ${src.name} from Squarespace into alan-shared-resources/csv (auto-pushes to GitHub within ~10 min), then re-run detector.`,
            reason: `mtime ${src.mtime}; threshold 14 days (Alan)`,
            urgency: 'high',
            status: 'pending',
            related_id: relatedId,
          },
        });
        const id = Array.isArray(row) ? row[0]?.id : row?.id;
        if (id) inserted.push(id);
      }
    }
  }

  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  const maxRolls = Number(ruleMap.missed_habit_max_rolls || 3);
  const horizonWeeks = Number(ruleMap.travel_horizon_weeks || 12);
  const horizonEnd = addDaysYmd(today, horizonWeeks * 7);
  const homePc = ruleMap.home_postcode || 'CV4 9HW';
  const bufferScope = ruleMap.buffer_scope || 'home_only';
  const prepMin = Number(ruleMap.prep_buffer_min || 30);
  const decompMin = Number(ruleMap.decompress_buffer_min || 30);
  const arriveMin = Number(ruleMap.arrive_before_start_min || 30);
  const travelPrefix = ruleMap.title_prefix_travel || 'MC 🚗';
  const bufferPrefix = ruleMap.title_prefix_buffer || 'MC ⏳';

  const drives = await sb('venue_drive_times?select=venue_name,minutes_from_home');
  const driveHint = (ev) => {
    const blob = `${ev.location_name} ${ev.address} ${ev.postcode}`.toLowerCase();
    const hit = (drives || []).find((d) => blob.includes(String(d.venue_name).toLowerCase().split('/')[0].trim()));
    return hit ? `${hit.minutes_from_home} min from home (${hit.venue_name})` : 'look up drive time in Scheduling → Drive times';
  };

  // CSV events in horizon → travel / buffers for NEW rows only (vs snapshot).
  // First run with empty snapshot = baseline only (no flood of "missing" for whole year).
  const inHorizon = events.filter((e) => e.start_date >= today && e.start_date <= horizonEnd);
  const currentKeys = new Set(events.map((e) => e.row_key));

  let prev = [];
  try {
    prev = await sb('schedule_csv_snapshot?select=row_key,title,start_date,kind');
  } catch (e) {
    notes.push(`snapshot_read_error: ${e.message}`);
  }
  const prevKeys = new Set((prev || []).map((p) => p.row_key));
  const isBaseline = prevKeys.size === 0;

  if (isBaseline) {
    notes.push(`baseline_snapshot: ${events.length} CSV events recorded; travel/buffer proposals start on next change`);
  } else {
    for (const ev of inHorizon) {
      if (prevKeys.has(ev.row_key)) continue; // not new
      const home = isHomeBased(ev, homePc);
      if (!home) {
        const relatedId = `travel:${ev.row_key}`;
        if (!(await existingPending('missing_travel', relatedId))) {
          const row = await sb('pending_diary_changes', {
            method: 'POST',
            body: {
              change_type: 'missing_travel',
              target_date: ev.start_date,
              summary: `New located event — travel needed: ${ev.title}`,
              proposed_action: `Ensure ${travelPrefix} travel block on ${ev.start_date} (arrive ${arriveMin}m before ${ev.start_time || 'start'}). ${driveHint(ev)}. Location: ${ev.location_name || ev.postcode}. URL: ${ev.url || '—'}. Claude checks diary clashes when applying.`,
              reason: `New in CSV ${ev.source_id} vs previous snapshot; inside ${horizonWeeks}w horizon`,
              urgency: 'normal',
              status: 'pending',
              related_id: relatedId,
            },
          });
          const id = Array.isArray(row) ? row[0]?.id : row?.id;
          if (id) inserted.push(id);
        }
      } else if (bufferScope === 'home_only' || bufferScope === 'all') {
        const relatedId = `buffer:${ev.row_key}`;
        if (!(await existingPending('missing_buffer', relatedId))) {
          const row = await sb('pending_diary_changes', {
            method: 'POST',
            body: {
              change_type: 'missing_buffer',
              target_date: ev.start_date,
              summary: `New home session — buffers: ${ev.title}`,
              proposed_action: `Ensure ${bufferPrefix} prep ${prepMin}m before and decompress ${decompMin}m after on ${ev.start_date} ${ev.start_time || ''}–${ev.end_time || ''}. Home (${homePc}). Claude verifies clashes when applying.`,
              reason: `New in CSV ${ev.source_id}; buffer_scope=${bufferScope}`,
              urgency: 'normal',
              status: 'pending',
              related_id: relatedId,
            },
          });
          const id = Array.isArray(row) ? row[0]?.id : row?.id;
          if (id) inserted.push(id);
        }
      }
    }
  }

  // Cancelled / removed from CSV vs last snapshot
  if (!isBaseline) {
    for (const old of prev || []) {
      if (currentKeys.has(old.row_key)) continue;
      if (old.start_date < today) continue;
      const relatedId = `orphan:${old.row_key}`;
      if (await existingPending('orphaned_block', relatedId)) continue;
      const row = await sb('pending_diary_changes', {
        method: 'POST',
        body: {
          change_type: 'orphaned_block',
          target_date: old.start_date,
          summary: `Removed from CSV: ${old.title}`,
          proposed_action: `Remove orphaned ${travelPrefix}/${bufferPrefix} MC blocks for "${old.title}" on ${old.start_date} (no longer in workshop/lesson CSV).`,
          reason: 'Present in previous snapshot, absent from current CSV export',
          urgency: 'normal',
          status: 'pending',
          related_id: relatedId,
        },
      });
      const id = Array.isArray(row) ? row[0]?.id : row?.id;
      if (id) inserted.push(id);
    }
  }

  // Refresh snapshot
  try {
    await sb('schedule_csv_snapshot?kind=eq.lesson', { method: 'DELETE', prefer: 'return=minimal' });
    await sb('schedule_csv_snapshot?kind=eq.workshop', { method: 'DELETE', prefer: 'return=minimal' });
    if (events.length) {
      const srcById = Object.fromEntries(sources.filter((s) => s.ok).map((s) => [s.id, s]));
      const chunk = events.slice(0, 500).map((e) => ({
        row_key: e.row_key,
        title: e.title,
        start_date: e.start_date,
        kind: e.kind,
        location_name: e.location_name || null,
        seen_at: new Date().toISOString(),
        source_mtime: srcById[e.source_id]?.mtime || null,
        source_name: srcById[e.source_id]?.name || null,
      }));
      await sb('schedule_csv_snapshot', {
        method: 'POST',
        body: chunk,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }
    notes.push(`snapshot_refreshed: ${events.length} events from CSV`);
  } catch (e) {
    notes.push(`snapshot_write_error: ${e.message}`);
  }

  const habits = await sb('recurring_tasks?active=eq.true');
  for (const h of habits || []) {
    const lastDue = lastDueSimple(h.rrule, today);
    if (!lastDue || lastDue >= today) continue;
    if (h.last_done && h.last_done >= lastDue) continue;

    const relatedId = `habit:${h.id}:${lastDue}`;
    if (await existingPending('missed_habit', relatedId)) continue;

    const rolls = Number(h.rolls_used || 0);
    let proposed;
    let reason;
    if (rolls < maxRolls) {
      const target = nextWorkingDay(today);
      proposed = `Roll forward to next working day ${target} at ${String(h.ideal_time || '09:00').slice(0, 5)} (roll ${rolls + 1}/${maxRolls}). Title: ${ruleMap.title_prefix_recurring || 'MC 🔁'} ${h.title}`;
      reason = `Missed occurrence ${lastDue}; policy roll_forward_capped`;
      await sb(`recurring_tasks?id=eq.${h.id}`, {
        method: 'PATCH',
        body: { rolls_used: rolls + 1, updated_at: new Date().toISOString() },
      });
    } else {
      proposed = `Max rolls (${maxRolls}) used — wait for next natural occurrence of "${h.title}". Do not auto-clear.`;
      reason = `Missed ${lastDue}; rolls_used=${rolls} at cap`;
    }

    const row = await sb('pending_diary_changes', {
      method: 'POST',
      body: {
        change_type: 'missed_habit',
        target_date: lastDue,
        summary: `Missed habit: ${h.title}`,
        proposed_action: proposed,
        reason,
        urgency: 'normal',
        status: 'pending',
        related_id: relatedId,
      },
    });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    if (id) inserted.push(id);
  }

  const horizon = addDaysYmd(today, 30);
  const hotels = await sb(
    `workshop_hotels?free_cancel_until=gte.${today}&free_cancel_until=lte.${horizon}&reminder_placed=eq.false`,
  );
  const remindDays = Number(ruleMap.hotel_deadline_reminder_days || 3);
  for (const hotel of hotels || []) {
    if (!hotel.free_cancel_until) continue;
    const relatedId = `hotel:${hotel.id}:${hotel.free_cancel_until}`;
    if (await existingPending('hotel_deadline', relatedId)) continue;
    const daysLeft = Math.round(
      (new Date(`${hotel.free_cancel_until}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400000,
    );
    const remindOn = addDaysYmd(hotel.free_cancel_until, -remindDays);
    const urgency = daysLeft <= 7 ? 'high' : 'normal';
    const row = await sb('pending_diary_changes', {
      method: 'POST',
      body: {
        change_type: 'hotel_deadline',
        target_date: hotel.free_cancel_until,
        summary: `Hotel free-cancel ${hotel.free_cancel_until}: ${hotel.hotel || hotel.workshop_name}`,
        proposed_action: `Place ${ruleMap.title_prefix_deadline || 'MC ⏰'} reminder on ${remindOn} (deadline−${remindDays}). Workshop: ${hotel.workshop_name}. Ref: ${hotel.booking_ref || '—'}. Then set reminder_placed=true on hotel row.`,
        reason: 'Free cancel within 30 days; reminder_placed=false',
        urgency,
        status: 'pending',
        related_id: relatedId,
      },
    });
    const id = Array.isArray(row) ? row[0]?.id : row?.id;
    if (id) inserted.push(id);
  }

  const readable = sources.filter((s) => s.ok).length;
  if (inserted.length === 0) {
    notes.push(
      `no_new_proposals: read ${readable}/2 CSV sources, ${events.length} events, ${inHorizon.length} in ${horizonWeeks}w horizon — not a silent skip`,
    );
  }

  // Part 6: rule_breach — Claude POSTs block list (cron has no Calendar access)
  let blocks = [];
  if (req.method === 'POST') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => resolve(data ? JSON.parse(data) : {}));
        req.on('error', reject);
      });
      blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
    } catch (e) { /* GET cron — no blocks */ }
  }
  if (blocks.length) {
    const pinnedIds = new Set();
    const pinned = await sb('tasks?select=display_id&slot_pinned=eq.true');
    for (const t of pinned || []) pinnedIds.add(Number(t.display_id));
    const proposals = buildRuleBreachProposals(blocks, ruleMap, pinnedIds);
    for (const p of proposals) {
      if (await existingPending('rule_breach', p.related_id)) continue;
      const row = await sb('pending_diary_changes', { method: 'POST', body: { ...p, status: 'pending' } });
      const id = Array.isArray(row) ? row[0]?.id : row?.id;
      if (id) inserted.push(id);
    }
    notes.push(`rule_breach: ${proposals.length} proposal(s) from ${blocks.length} block(s)`);
  } else {
    notes.push('rule_breach: skipped (no blocks — Claude POSTs block list to /api/cron/diary-drift or /api/mc/rule-breach-check)');
  }

  return json(res, 200, {
    ok: true,
    today,
    inserted: inserted.length,
    ids: inserted,
    sources,
    events_total: events.length,
    events_in_horizon: inHorizon.length,
    errors: errors.map((e) => ({ id: e.id, error: e.error })),
    notes,
    calendar_writes: 0,
  });
};
