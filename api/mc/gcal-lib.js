/**
 * Google Calendar readonly helper for Mission Control diary-drift.
 * Env: GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REFRESH_TOKEN
 * Optional: GCAL_CALENDAR_IDS (comma-separated override of the expected set)
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

/** Canonical busy-map calendars. Short of this set is a FAULT, not "ok". */
const EXPECTED_CALENDARS = [
  { id: 'primary', label: 'Primary' },
  { id: 'ic364d06u5bjt60d91q0nrqps6ulk7b2@import.calendar.google.com', label: 'Workshops' },
  { id: 'nht93uaqhhd191kc3fg1kjs57k6bunhn@import.calendar.google.com', label: 'Lessons' },
  { id: 'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com', label: 'Ipswich Town' },
];

const DEFAULT_CALENDARS = EXPECTED_CALENDARS.map((c) => c.id);

/** Ipswich fixtures are transparent/free in Google — still block the diary. */
const FORCE_BUSY_CALENDAR_IDS = new Set([
  'c_0e7gnac3odl7ki0jfjiaedot9g@group.calendar.google.com',
]);

function gcalConfigured() {
  return !!(process.env.GCAL_CLIENT_ID
    && process.env.GCAL_CLIENT_SECRET
    && process.env.GCAL_REFRESH_TOKEN);
}

function calendarIds() {
  const raw = process.env.GCAL_CALENDAR_IDS;
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_CALENDARS];
}

function isForceBusyCalendar(calendarId) {
  return FORCE_BUSY_CALENDAR_IDS.has(calendarId);
}

function expectedCalendarCount() {
  return calendarIds().length;
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

/**
 * Assess calendar health. Short of the expected set, or any configured calendar
 * returning zero events over the horizon, is a FAULT — never report as a clean ok.
 */
function assessCalendarHealth(health) {
  const expected = expectedCalendarCount();
  const ok = (health || []).filter((h) => h.ok);
  const empty = ok.filter((h) => (h.count || 0) === 0);
  const failed = (health || []).filter((h) => !h.ok);
  const faults = [];
  if ((health || []).length < expected) {
    faults.push(`short:${(health || []).length}/${expected}`);
  }
  for (const h of empty) faults.push(`empty:${h.id}`);
  for (const h of failed) faults.push(`fail:${h.id}`);
  if (faults.length) {
    return {
      label: `${ok.length}/${expected} calendars — ${faults.join(', ')}`,
      ok: false,
      faults,
    };
  }
  return { label: `${ok.length} calendars ok`, ok: true, faults: [] };
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
      health.push({ id, ok: false, error: e.message, count: 0 });
    }
  }
  return { events: all, health, assessment: assessCalendarHealth(health) };
}

module.exports = {
  gcalConfigured,
  calendarIds,
  expectedCalendarCount,
  isForceBusyCalendar,
  assessCalendarHealth,
  getAccessToken,
  fetchHorizonEvents,
  EXPECTED_CALENDARS,
  DEFAULT_CALENDARS,
  FORCE_BUSY_CALENDAR_IDS,
};
