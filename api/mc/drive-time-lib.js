/**
 * Google Distance Matrix helper for Mission Control.
 * Server-only — uses GOOGLE_MAPS_API_KEY. No Calendar writes.
 */

const MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const STALE_DAYS = 90;

function mapsKey() {
  return process.env.GOOGLE_MAPS_API_KEY || '';
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  return ms / 86400000;
}

function isStale(verifiedAt, thresholdDays = STALE_DAYS) {
  return daysSince(verifiedAt) > thresholdDays;
}

/**
 * @param {{ origin: string, destination: string, departureTime?: Date|string|number, trafficModel?: string }} opts
 * origin/destination: postcode or "lat,lng"
 */
async function fetchDriveMinutes(opts) {
  const key = mapsKey();
  if (!key) {
    return { ok: false, error: 'GOOGLE_MAPS_API_KEY not set', minutes: null };
  }
  const origin = String(opts.origin || '').trim();
  const destination = String(opts.destination || '').trim();
  if (!origin || !destination) {
    return { ok: false, error: 'origin and destination required', minutes: null };
  }

  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode: 'driving',
    units: 'metric',
    key,
  });

  let trafficModel = opts.trafficModel || null;
  if (opts.departureTime) {
    const dep = opts.departureTime instanceof Date
      ? opts.departureTime
      : new Date(typeof opts.departureTime === 'number'
        ? (opts.departureTime < 1e12 ? opts.departureTime * 1000 : opts.departureTime)
        : opts.departureTime);
    if (!Number.isNaN(dep.getTime())) {
      params.set('departure_time', String(Math.floor(dep.getTime() / 1000)));
      trafficModel = trafficModel || 'pessimistic';
      params.set('traffic_model', trafficModel);
    }
  }

  const res = await fetch(`${MATRIX_URL}?${params}`);
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}`, minutes: null };
  }
  const data = await res.json();
  if (data.status !== 'OK') {
    return { ok: false, error: `matrix ${data.status}: ${data.error_message || ''}`.trim(), minutes: null };
  }
  const el = data.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK') {
    return { ok: false, error: `element ${el?.status || 'missing'}`, minutes: null };
  }
  const seconds = el.duration_in_traffic?.value ?? el.duration?.value;
  if (seconds == null) {
    return { ok: false, error: 'no duration', minutes: null };
  }
  return {
    ok: true,
    minutes: Math.ceil(seconds / 60),
    meters: el.distance?.value ?? null,
    traffic_model: trafficModel || 'static',
    raw_status: data.status,
  };
}

module.exports = {
  STALE_DAYS,
  mapsKey,
  daysSince,
  isStale,
  fetchDriveMinutes,
};
