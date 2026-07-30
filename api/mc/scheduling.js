const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');

async function listAll() {
  const { getScheduleSources } = require('./scheduleCsv');
  const [rules, audit, drive_times, hotels, pending, runs] = await Promise.all([
    sb('scheduling_rules?order=key.asc'),
    sb('scheduling_rules_audit?order=at.desc&limit=50'),
    sb('venue_drive_times?order=venue_name.asc'),
    sb('workshop_hotels?order=check_in_date.asc.nullslast'),
    sb('pending_diary_changes?status=eq.pending&order=detected_at.desc'),
    sb('diary_check_runs?order=ran_at.desc&limit=1'),
  ]);
  let sources = [];
  try {
    sources = await getScheduleSources();
  } catch (e) {
    sources = [{ id: 'error', label: 'Schedule CSVs', ok: false, tone: 'red', display: `CSV read error: ${e.message}` }];
  }
  return {
    rules, audit, drive_times, hotels, pending, sources, last_run: runs?.[0] || null,
  };
}

// Run the diary-drift detector in-process — the SAME handler the 06:00 cron runs,
// so the button and the cron can never drift apart. scope: '8w' | 'full'.
function runDiaryCheck(scope) {
  const diaryDrift = require('../cron/diary-drift');
  return new Promise((resolve, reject) => {
    const mockReq = {
      method: 'GET', query: { scope, mode: 'manual', force: '1' }, headers: {}, on: () => {},
    };
    const mockRes = {
      statusCode: 200,
      setHeader: () => {},
      end: (s) => {
        try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({ raw: s }); }
      },
    };
    Promise.resolve(diaryDrift(mockReq, mockRes)).catch(reject);
  });
}

async function patchRule(key, value, actor) {
  const cur = (await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`))?.[0];
  if (!cur) {
    const err = new Error('rule not found');
    err.status = 404;
    throw err;
  }
  const rows = await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: { value: String(value), updated_at: new Date().toISOString() },
  });
  await sb('scheduling_rules_audit', {
    method: 'POST',
    body: {
      key, old_value: cur.value, new_value: String(value), changed_by: actor,
    },
  });
  return rows?.[0] || { ...cur, value: String(value) };
}

async function patchDrive(id, body) {
  const patch = { updated_at: new Date().toISOString() };
  for (const f of ['venue_name', 'postcode', 'minutes_from_home', 'minutes_from_hotel', 'notes', 'verified_by']) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
  }
  if (body.verified_by) patch.verified_at = new Date().toISOString();
  const rows = await sb(`venue_drive_times?id=eq.${id}`, { method: 'PATCH', body: patch });
  return rows?.[0];
}

async function patchHotel(id, body) {
  const patch = { updated_at: new Date().toISOString() };
  const fields = [
    'workshop_name', 'workshop_dates', 'hotel', 'booking_ref', 'booked_via',
    'rooms', 'total_cost', 'free_cancel_until', 'check_in_date', 'notes', 'reminder_placed',
    'cancellation_window_days', 'cancellation_policy', 'reminder_lead_days',
    'status', 'cancelled_at',
  ];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
  }
  const rows = await sb(`workshop_hotels?id=eq.${id}`, { method: 'PATCH', body: patch });
  return rows?.[0];
}

async function resolvePending(id, status, actor) {
  if (!['applied', 'dismissed'].includes(status)) {
    const err = new Error('status must be applied or dismissed');
    err.status = 400;
    throw err;
  }
  const cur = (await sb(`pending_diary_changes?id=eq.${id}&select=*`))?.[0];
  if (!cur) {
    const err = new Error('pending row not found');
    err.status = 404;
    throw err;
  }
  if (status === 'applied' && cur.change_type === 'task_bump') {
    // Summary like: "Bump MC-14 → 2026-08-09 13:30–14:15"
    const m = String(cur.summary || '').match(
      /Bump MC-(\d+)\s*→\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})–(\d{2}:\d{2})/,
    );
    if (m) {
      const { applyTaskBumpToDb } = require('./habit-placer-propose-lib');
      const { londonYmdHmToUtcMs } = require('./habit-placer-lib');
      const displayId = Number(m[1]);
      const day = m[2];
      const startIso = new Date(londonYmdHmToUtcMs(day, m[3])).toISOString();
      const endIso = new Date(londonYmdHmToUtcMs(day, m[4])).toISOString();
      await applyTaskBumpToDb(sb, {
        display_id: displayId,
        new_day: day,
        new_start: startIso,
        new_end: endIso,
        reason: 'pending_apply',
      });
    }
  }
  const rows = await sb(`pending_diary_changes?id=eq.${id}`, {
    method: 'PATCH',
    body: {
      status,
      resolved_at: new Date().toISOString(),
      resolved_by: actor,
    },
  });
  return rows?.[0];
}

async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const actor = actorFromSession(session, body);

    if (req.method === 'GET') {
      return json(res, 200, await listAll());
    }

    if (req.method === 'PATCH') {
      if (body.entity === 'rule') {
        if (!body.key) return json(res, 400, { error: 'key required' });
        return json(res, 200, { rule: await patchRule(body.key, body.value, actor) });
      }
      if (body.entity === 'drive') {
        if (!body.id) return json(res, 400, { error: 'id required' });
        return json(res, 200, { drive: await patchDrive(body.id, body) });
      }
      if (body.entity === 'hotel') {
        if (!body.id) return json(res, 400, { error: 'id required' });
        return json(res, 200, { hotel: await patchHotel(body.id, body) });
      }
      if (body.entity === 'pending') {
        if (!body.id || !body.status) return json(res, 400, { error: 'id and status required' });
        return json(res, 200, { pending: await resolvePending(body.id, body.status, actor) });
      }
      if (body.entity === 'conflict_preview') {
        if (!body.id) return json(res, 400, { error: 'id required' });
        const row = (await sb(`pending_diary_changes?id=eq.${body.id}&select=*`))?.[0];
        if (!row) return json(res, 404, { error: 'pending row not found' });
        const { previewConflict } = require('./conflict-resolve-lib');
        return json(res, 200, { preview: await previewConflict(sb, row) });
      }
      if (body.entity === 'resolve_overlap') {
        if (!body.id || !body.which) return json(res, 400, { error: 'id and which required' });
        if (!['a', 'b', 'lower'].includes(body.which)) {
          return json(res, 400, { error: 'which must be a|b|lower' });
        }
        const row = (await sb(`pending_diary_changes?id=eq.${body.id}&select=*`))?.[0];
        if (!row) return json(res, 404, { error: 'pending row not found' });
        if (row.status !== 'pending') return json(res, 409, { error: 'already resolved' });
        const { resolveOverlap } = require('./conflict-resolve-lib');
        const result = await resolveOverlap(sb, row, body.which, actor);
        return json(res, 200, { result, calendar_writes: 0 });
      }
      if (body.entity === 'resolve_block') {
        if (!body.id || !body.block_id) return json(res, 400, { error: 'id and block_id required' });
        const row = (await sb(`pending_diary_changes?id=eq.${body.id}&select=*`))?.[0];
        if (!row) return json(res, 404, { error: 'pending row not found' });
        if (row.status !== 'pending') return json(res, 409, { error: 'already resolved' });
        const { resolveDayBlock } = require('./conflict-resolve-lib');
        const result = await resolveDayBlock(sb, row, body.block_id, actor);
        return json(res, 200, { result, calendar_writes: 0 });
      }
      if (body.entity === 'run_check') {
        const scope = body.scope === 'full' ? 'full' : '8w';
        const detect = await runDiaryCheck(scope);
        let heal = null;
        // Full: client chains run_placer windows + run_heal (one request times out).
        if (scope === 'full') {
          heal = {
            overlaps_fixed: 0,
            overlaps_failed: 0,
            orphans_queued: 0,
            gaps_retired: 0,
            push_queued: 0,
            remaining_pending: null,
            skipped: true,
            note: 'Detect only in this pass — browser will run placer windows then heal.',
          };
        } else {
          try {
            const { runDiaryHeal } = require('./diary-heal-lib');
            heal = await runDiaryHeal(sb, {
              actor,
              maxOverlaps: 25,
              orphanDays: 120,
            });
          } catch (healErr) {
            heal = {
              overlaps_fixed: 0,
              overlaps_failed: 0,
              orphans_queued: 0,
              gaps_retired: 0,
              push_queued: 0,
              remaining_pending: null,
              error: healErr.message || 'heal failed',
            };
          }
        }
        const habitWeeks = Number(
          (await sb('scheduling_rules?key=eq.habit_horizon_weeks&select=value'))?.[0]?.value || 26,
        );
        return json(res, 200, {
          run: { ...(detect || {}), heal, habit_horizon_weeks: habitWeeks },
          calendar_writes: 0,
        });
      }
      if (body.entity === 'run_placer') {
        if (!body.from || !body.to) return json(res, 400, { error: 'from and to required (YYYY-MM-DD)' });
        const { runPlacerWindow } = require('./habit-placer-window-lib');
        const placer = await runPlacerWindow(sb, String(body.from), String(body.to), {
          phaseAnchorYmd: body.phase_anchor || body.from,
        });
        return json(res, 200, { placer, calendar_writes: 0 });
      }
      if (body.entity === 'run_heal') {
        try {
          const { runDiaryHeal } = require('./diary-heal-lib');
          const heal = await runDiaryHeal(sb, {
            actor,
            maxOverlaps: 25,
            orphanDays: 120,
          });
          return json(res, 200, { heal, calendar_writes: 0 });
        } catch (healErr) {
          return json(res, 200, {
            heal: {
              overlaps_fixed: 0,
              overlaps_failed: 0,
              orphans_queued: 0,
              gaps_retired: 0,
              push_queued: 0,
              remaining_pending: null,
              error: healErr.message || 'heal failed',
            },
            calendar_writes: 0,
          });
        }
      }
      return json(res, 400, {
        error: 'entity required: rule|drive|hotel|pending|conflict_preview|resolve_overlap|resolve_block|run_check|run_placer|run_heal',
      });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'scheduling error', detail: e.data });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 300 };
