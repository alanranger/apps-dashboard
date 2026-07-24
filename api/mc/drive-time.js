/**
 * Authenticated drive-time endpoint for Claude placer + MC UI.
 * POST: live Distance Matrix, optional write-back to venue_drive_times / travel_blocks.
 * Never writes Google Calendar.
 */
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb,
} = require('./_lib');
const { mapsKey, isStale, STALE_DAYS, fetchDriveMinutes } = require('./drive-time-lib');

async function resolveHomePostcode() {
  const rows = await sb('scheduling_rules?key=eq.home_postcode&select=value');
  return rows?.[0]?.value || 'CV4 9HW';
}

async function findVenue(venueName, postcode) {
  if (venueName) {
    const exact = await sb(
      `venue_drive_times?venue_name=eq.${encodeURIComponent(venueName)}&limit=1`,
    );
    if (exact?.[0]) return exact[0];
  }
  if (postcode) {
    const byPc = await sb(
      `venue_drive_times?postcode=eq.${encodeURIComponent(postcode)}&limit=1`,
    );
    if (byPc?.[0]) return byPc[0];
  }
  return null;
}

async function writeBackVenue(venue, minutes, actor) {
  if (!venue?.id) return null;
  const rows = await sb(`venue_drive_times?id=eq.${venue.id}`, {
    method: 'PATCH',
    body: {
      minutes_from_home: minutes,
      verified_by: 'google_directions',
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  return rows?.[0] || null;
}

async function stampTravelBlock(body, minutes, trafficModel, actor) {
  if (!body.calendar_event_id || !body.block_type) return null;
  const row = {
    block_type: body.block_type,
    starts_at: body.starts_at,
    ends_at: body.ends_at,
    calendar_event_id: body.calendar_event_id,
    venue_name: body.venue_name || null,
    workshop_title: body.workshop_title || null,
    workshop_start: body.workshop_start || null,
    workshop_row_key: body.workshop_row_key || null,
    leg_from: body.leg_from || null,
    leg_to: body.leg_to || null,
    drive_minutes_used: minutes,
    drive_time_verified_at: new Date().toISOString(),
    departure_traffic_model: trafficModel || null,
    created_by: actor || 'claude',
  };
  const inserted = await sb('travel_blocks', {
    method: 'POST',
    body: row,
    prefer: 'resolution=merge-duplicates,return=representation',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      maps_configured: !!mapsKey(),
      stale_days: STALE_DAYS,
      usage: {
        POST: {
          destination: 'postcode or lat,lng (required)',
          origin: 'optional — defaults to scheduling_rules.home_postcode',
          venue_name: 'optional — match venue_drive_times',
          departure_time: 'optional ISO or unix — enables traffic_model',
          traffic_model: 'optional — default pessimistic when departure_time set',
          write_back: 'optional bool — update venue_drive_times',
          stamp_block: 'optional object fields for travel_blocks upsert by calendar_event_id',
        },
      },
    });
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

  try {
    const body = await readBody(req);
    const actor = actorFromSession(session, body);
    const home = await resolveHomePostcode();
    const venue = await findVenue(body.venue_name, body.destination || body.postcode);
    const origin = body.origin || home;
    const destination = body.destination || venue?.postcode || body.postcode;
    if (!destination) {
      return json(res, 400, { error: 'destination or venue_name with postcode required' });
    }

    const forceLive = body.force_live === true || body.write_back === true;
    const cachedFresh = venue && !isStale(venue.verified_at) && !forceLive;
    if (cachedFresh && body.live_only !== true) {
      return json(res, 200, {
        ok: true,
        source: 'venue_drive_times',
        minutes: venue.minutes_from_home,
        venue,
        stale: false,
        traffic_model: 'static',
      });
    }

    if (!mapsKey()) {
      return json(res, 503, {
        error: 'GOOGLE_MAPS_API_KEY not set',
        cached_minutes: venue?.minutes_from_home ?? null,
        stale: venue ? isStale(venue.verified_at) : null,
      });
    }

    const live = await fetchDriveMinutes({
      origin,
      destination,
      departureTime: body.departure_time,
      trafficModel: body.traffic_model,
    });
    if (!live.ok) {
      return json(res, 502, {
        error: live.error,
        cached_minutes: venue?.minutes_from_home ?? null,
      });
    }

    let updatedVenue = null;
    if (body.write_back === true && venue) {
      updatedVenue = await writeBackVenue(venue, live.minutes, actor);
    }

    let travelBlock = null;
    if (body.stamp_block === true || body.calendar_event_id) {
      travelBlock = await stampTravelBlock(body, live.minutes, live.traffic_model, actor);
    }

    return json(res, 200, {
      ok: true,
      source: 'distance_matrix',
      minutes: live.minutes,
      meters: live.meters,
      traffic_model: live.traffic_model,
      origin,
      destination,
      venue: updatedVenue || venue,
      travel_block: travelBlock,
      wrote_venue: !!updatedVenue,
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'drive-time error', detail: e.data });
  }
};
