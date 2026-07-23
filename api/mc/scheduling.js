const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');

async function listAll() {
  const { getScheduleSources } = require('./scheduleCsv');
  const [rules, audit, drive_times, hotels, pending] = await Promise.all([
    sb('scheduling_rules?order=key.asc'),
    sb('scheduling_rules_audit?order=at.desc&limit=50'),
    sb('venue_drive_times?order=venue_name.asc'),
    sb('workshop_hotels?order=check_in_date.asc.nullslast'),
    sb('pending_diary_changes?status=eq.pending&order=detected_at.desc'),
  ]);
  let sources = [];
  try {
    sources = await getScheduleSources();
  } catch (e) {
    sources = [{ id: 'error', label: 'Schedule CSVs', ok: false, tone: 'red', display: `CSV read error: ${e.message}` }];
  }
  return { rules, audit, drive_times, hotels, pending, sources };
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

module.exports = async function handler(req, res) {
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
      return json(res, 400, { error: 'entity required: rule|drive|hotel|pending' });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'scheduling error', detail: e.data });
  }
};
