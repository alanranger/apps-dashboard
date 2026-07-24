/**
 * Hotel source reconcile — Gmail Label (Workshops Hotels) vs workshop_hotels.
 * Writes pending_diary_changes ONLY. Never Calendar.
 * Separate from diary-drift (Gmail outage must not kill habit/travel detection).
 */
const { json, sb } = require('../mc/_lib');
const { gmailConfigured, getAccessToken, listLabelMessageIds, getMessage } = require('../mc/gmail-lib');
const { parseHotelMessage, refsMatch, costMismatch, normalizeRef } = require('../mc/hotel-parse-lib');

const DEFAULT_LABEL = 'Label_209';
const MAX_MESSAGES = 120;

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

async function insertPending(inserted, row) {
  if (await existingPending(row.change_type, row.related_id)) return;
  const out = await sb('pending_diary_changes', { method: 'POST', body: row });
  const id = Array.isArray(out) ? out[0]?.id : out?.id;
  if (id) inserted.push({ id, change_type: row.change_type, related_id: row.related_id });
}

function findHotelByRef(hotels, ref) {
  if (!ref) return null;
  return (hotels || []).find((h) => h.booking_ref && refsMatch(h.booking_ref, ref)) || null;
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
  if (!gmailConfigured()) {
    return json(res, 503, { error: 'GMAIL_NOT_CONFIGURED' });
  }

  const labelId = process.env.GMAIL_HOTEL_LABEL_ID || DEFAULT_LABEL;
  const inserted = [];
  const notes = ['calendar_writes: 0', `label: ${labelId}`, `max_messages: ${MAX_MESSAGES}`];
  const counts = {
    messages: 0,
    parsed: 0,
    unregistered: 0,
    unconfirmed: 0,
    mismatch: 0,
    cancelled_registered: 0,
    parse_weak: 0,
  };

  try {
    const token = await getAccessToken();
    const ids = await listLabelMessageIds(token, labelId, MAX_MESSAGES);
    counts.messages = ids.length;
    notes.push(`gmail_messages_fetched: ${ids.length}`);

    const parsed = [];
    for (const id of ids) {
      const msg = await getMessage(token, id);
      const p = parseHotelMessage(msg);
      parsed.push(p);
      if (!p.parse_ok) counts.parse_weak += 1;
    }
    counts.parsed = parsed.length;

    const hotels = await sb(
      'workshop_hotels?select=id,workshop_name,hotel,booking_ref,total_cost,free_cancel_until,check_in_date,booked_via',
    ) || [];

    const matchedHotelIds = new Set();
    const seenUnreg = new Set();

    for (const p of parsed) {
      if (p.cancelled) {
        for (const ref of p.refs.length ? p.refs : [p.primary_ref].filter(Boolean)) {
          const hit = findHotelByRef(hotels, ref);
          if (!hit) continue;
          matchedHotelIds.add(hit.id);
          counts.cancelled_registered += 1;
          await insertPending(inserted, {
            change_type: 'hotel_cancelled_but_registered',
            target_date: hit.check_in_date || null,
            summary: `Cancellation email for registered hotel: ${hit.hotel || hit.workshop_name}`,
            proposed_action: `Confirm booking ${ref} is cancelled. Update or remove workshop_hotels row "${hit.workshop_name}". Gmail: ${p.subject}`,
            reason: `Gmail cancel signal matched booking_ref; message ${p.message_id}`,
            urgency: 'high',
            status: 'pending',
            related_id: `hotel_src:cancel:${normalizeRef(ref)}`,
          });
        }
        continue;
      }

      let hit = null;
      for (const ref of p.refs) {
        hit = findHotelByRef(hotels, ref);
        if (hit) break;
      }

      if (hit) {
        matchedHotelIds.add(hit.id);
        const mismatches = [];
        if (costMismatch(hit.total_cost, p.amount)) {
          mismatches.push(`cost DB £${hit.total_cost} vs email £${p.amount}`);
        }
        if (p.hotel_hint && hit.hotel && !String(hit.hotel).toLowerCase().includes(String(p.hotel_hint).toLowerCase().slice(0, 12))
          && !String(p.hotel_hint).toLowerCase().includes(String(hit.hotel).toLowerCase().slice(0, 12))) {
          // soft name check — only if both look specific
          if (p.hotel_hint.length > 8 && hit.hotel.length > 8) {
            mismatches.push(`name DB "${hit.hotel}" vs email hint "${p.hotel_hint}"`);
          }
        }
        if (mismatches.length) {
          counts.mismatch += 1;
          await insertPending(inserted, {
            change_type: 'hotel_detail_mismatch',
            target_date: hit.check_in_date || null,
            summary: `Hotel register mismatch: ${hit.workshop_name}`,
            proposed_action: `Reconcile workshop_hotels vs Gmail. ${mismatches.join('; ')}. Subject: ${p.subject}. Ref: ${p.primary_ref || '—'}.`,
            reason: `Gmail vs register disagreement; message ${p.message_id}`,
            urgency: 'normal',
            status: 'pending',
            related_id: `hotel_src:mismatch:${hit.id}:${p.message_id}`,
          });
        }
        continue;
      }

      // Unregistered confirmation (needs a ref so we don't flood on newsletters)
      if (p.primary_ref && p.parse_ok) {
        const key = normalizeRef(p.primary_ref);
        if (seenUnreg.has(key)) continue;
        seenUnreg.add(key);
        counts.unregistered += 1;
        await insertPending(inserted, {
          change_type: 'hotel_booking_unregistered',
          target_date: null,
          summary: `Gmail booking not in workshop_hotels: ${p.hotel_hint || p.subject.slice(0, 80)}`,
          proposed_action: `Add workshop_hotels row for ref ${p.primary_ref}${p.amount != null ? ` (£${p.amount})` : ''}. Subject: ${p.subject}. From: ${p.from}.`,
          reason: `Confirmation in label ${labelId}; no booking_ref match`,
          urgency: 'high',
          status: 'pending',
          related_id: `hotel_src:${key}`,
        });
      }
    }

    // Upcoming register rows with a booking_ref but no Gmail match in this scan
    const today = new Date().toISOString().slice(0, 10);
    for (const h of hotels) {
      if (!h.booking_ref) continue;
      if (matchedHotelIds.has(h.id)) continue;
      const upcoming = (h.check_in_date && h.check_in_date >= today)
        || (h.free_cancel_until && h.free_cancel_until >= today);
      if (!upcoming) continue;
      counts.unconfirmed += 1;
      await insertPending(inserted, {
        change_type: 'hotel_row_unconfirmed',
        target_date: h.check_in_date || null,
        summary: `Upcoming hotel row with no matching Gmail confirmation: ${h.hotel || h.workshop_name}`,
        proposed_action: `Find confirmation for "${h.workshop_name}" ref ${h.booking_ref} in Inbox/Workshops Hotels, or fix booking_ref / mark cancelled.`,
        reason: `No message in last ${MAX_MESSAGES} label messages matched this booking_ref`,
        urgency: 'normal',
        status: 'pending',
        related_id: `hotel_src:row:${h.id}`,
      });
    }

    notes.push(`proposals: ${inserted.length}`);
    return json(res, 200, {
      ok: true,
      inserted: inserted.length,
      ids: inserted,
      counts,
      notes,
      calendar_writes: 0,
      user: process.env.GMAIL_USER || null,
    });
  } catch (e) {
    return json(res, e.status || 500, {
      error: e.message || 'hotel-source-reconcile failed',
      detail: e.data || null,
      notes,
      counts,
    });
  }
};
