/**
 * Google Calendar readonly helper for Mission Control diary-drift.
 * Env: GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN
 * Optional: GCAL_CALENDAR_IDS (comma-separated; default primary + known imports)
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

const DEFAULT_CALENDARS = [
  'primary',
  'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com',
  'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com',
];

function gcalConfigured() {
  return !!(process.env.GCAL_CLIENT_ID
    && process.env.GCAL_CLIENT_SECRET
    && process.env.GCAL_REFRESH_TOKEN);
}

function calendarIds() {
  const raw = process.env.GCAL_CALENDAR_IDS;
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return DEFAULT_CALENDARS;
}

async function getAccessToken() {
  if (!gcalConfigured()) {
    const err = new Error('GCAL_NOT_CONFIGURED');
    err.status = 503;
    throw err;
  }
  const body = new URLSearchParams({
    client_id: process.env.GCAL_CLIENT_ID,
    client_secret: process.env.GCAL_CLIENT_SECRET,
    refresh_token: process.env.GCAL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || 'gcal token refresh failed');
    err.status = 502;
    throw err;
  }
  return json.access_token;
}

async function listEvents(accessToken, calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin, timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  });
  const url = `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || `gcal list failed for ${calendarId}`);
    err.status = res.status;
    throw err;
  }
  return data.items || [];
}

/** Fetch timed + all-day events across configured calendars. */
async function fetchHorizonEvents(timeMinIso, timeMaxIso) {
  const token = await getAccessToken();
  const ids = calendarIds();
  const all = [];
  const health = [];
  for (const id of ids) {
    try {
      const items = await listEvents(token, id, timeMinIso, timeMaxIso);
      for (const e of items) {
        if (e.status === 'cancelled') continue;
        all.push({ ...e, _calendarId: id });
      }
      health.push({ id, ok: true, count: items.length });
    } catch (e) {
      health.push({ id, ok: false, error: e.message });
    }
  }
  return { events: all, health };
}

module.exports = { gcalConfigured, calendarIds, getAccessToken, fetchHorizonEvents };
