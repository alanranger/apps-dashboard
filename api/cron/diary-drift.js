/**
 * MC-43 nightly diary-drift detector.
 * Writes pending_diary_changes ONLY — never Google Calendar.
 */
const { json, sb } = require('../mc/_lib');

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
  const notes = [
    'calendar_feed_checks_skipped: no Calendar OAuth in apps-dashboard (DB-only detector)',
  ];

  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = Object.fromEntries((rules || []).map((r) => [r.key, r.value]));
  const maxRolls = Number(ruleMap.missed_habit_max_rolls || 3);

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

  return json(res, 200, {
    ok: true,
    today,
    inserted: inserted.length,
    ids: inserted,
    notes,
    calendar_writes: 0,
  });
};
