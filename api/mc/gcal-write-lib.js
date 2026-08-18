/**
 * Google Calendar write helpers (primary). Read helpers stay in gcal-lib.js.
 * Scope required: https://www.googleapis.com/auth/calendar
 */
const { getAccessToken, gcalConfigured } = require('./gcal-lib');

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const PRIMARY = 'primary';
const TOL_MS = 2 * 60 * 1000;

async function gcalFetch(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${CAL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `gcal ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function mcShowsAsFree(summary) {
  const t = String(summary || '');
  if (/MC\s*🚗|Travel out|Travel back|Travel —/i.test(t)) return false;
  if (/MC\s*⏳|Decompress|Prep —/i.test(t)) return false;
  if (/MC\s*🚫|MC\s*🛌|AWAY —|REST —/i.test(t)) return false;
  if (/MC\s*⚽/i.test(t)) return false;
  if (/MC\s*🔁/.test(t)) return true;
  if (/^P\d\s*·\s*MC-/i.test(t)) return true;
  if (/^MC\b/i.test(t)) return true;
  return false;
}

function transparencyForSummary(summary, explicit) {
  if (explicit === 'transparent' || explicit === 'opaque') return explicit;
  return mcShowsAsFree(summary) ? 'transparent' : 'opaque';
}

function timedEventBody({ summary, startIso, endIso, description, location, transparency }) {
  const body = {
    summary: summary || 'MC event',
    start: { dateTime: startIso, timeZone: 'Europe/London' },
    end: { dateTime: endIso, timeZone: 'Europe/London' },
    colorId: '10',
    transparency: transparencyForSummary(summary, transparency),
    reminders: { useDefault: false, overrides: [] },
  };
  if (description) body.description = description;
  if (location) body.location = location;
  return body;
}

/** All-day primary event. endDate is exclusive (Google all-day convention). */
function allDayEventBody({ summary, startDate, endDateExclusive, description }) {
  return {
    summary: summary || 'MC event',
    description: description || undefined,
    start: { date: startDate },
    end: { date: endDateExclusive },
    colorId: '10',
    reminders: { useDefault: false, overrides: [] },
  };
}

async function insertPrimaryEvent(opts) {
  return gcalFetch('POST', `/calendars/${encodeURIComponent(PRIMARY)}/events`, timedEventBody(opts));
}

async function insertPrimaryAllDayEvent(opts) {
  return gcalFetch('POST', `/calendars/${encodeURIComponent(PRIMARY)}/events`, allDayEventBody(opts));
}

async function patchPrimaryEvent(eventId, opts) {
  const body = {};
  if (opts.summary != null) body.summary = opts.summary;
  if (opts.description != null) body.description = opts.description;
  if (opts.location != null) body.location = opts.location;
  if (opts.startIso && opts.endIso) {
    body.start = { dateTime: opts.startIso, timeZone: 'Europe/London' };
    body.end = { dateTime: opts.endIso, timeZone: 'Europe/London' };
  }
  if (opts.colorId != null) body.colorId = opts.colorId;
  if (opts.reminders != null) body.reminders = opts.reminders;
  if (opts.transparency != null || opts.summary != null) {
    body.transparency = transparencyForSummary(opts.summary, opts.transparency);
  }
  return gcalFetch(
    'PATCH',
    `/calendars/${encodeURIComponent(PRIMARY)}/events/${encodeURIComponent(eventId)}`,
    body,
  );
}

async function deletePrimaryEvent(eventId) {
  try {
    return await gcalFetch(
      'DELETE',
      `/calendars/${encodeURIComponent(PRIMARY)}/events/${encodeURIComponent(eventId)}`,
    );
  } catch (e) {
    if (e.status === 404 || e.status === 410) return { deleted: false, missing: true };
    throw e;
  }
}

async function getPrimaryEvent(eventId) {
  return gcalFetch(
    'GET',
    `/calendars/${encodeURIComponent(PRIMARY)}/events/${encodeURIComponent(eventId)}`,
  );
}

function eventWallIso(ev, which) {
  const node = which === 'end' ? ev?.end : ev?.start;
  return node?.dateTime || (node?.date ? `${node.date}T00:00:00.000Z` : null);
}

function closeEnough(a, b) {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= TOL_MS;
}

/** Read-back: title + times must match before a write may be marked applied. */
async function verifyPrimaryEvent(eventId, expect) {
  const live = await getPrimaryEvent(eventId);
  const liveStart = eventWallIso(live, 'start');
  const liveEnd = eventWallIso(live, 'end');
  const titleOk = expect.summary == null || String(live.summary || '') === String(expect.summary);
  let startOk = true;
  let endOk = true;
  if (expect.startDate) {
    startOk = String(live.start?.date || '') === String(expect.startDate);
    endOk = expect.endDateExclusive == null
      || String(live.end?.date || '') === String(expect.endDateExclusive);
  } else {
    startOk = expect.startIso == null || closeEnough(liveStart, expect.startIso);
    endOk = expect.endIso == null || closeEnough(liveEnd, expect.endIso);
  }
  const ok = !!(titleOk && startOk && endOk);
  return {
    ok,
    event_id: eventId,
    live: { summary: live.summary, start: liveStart, end: liveEnd, colorId: live.colorId },
    expect,
    titleOk,
    startOk,
    endOk,
  };
}

/** Create then delete a throwaway primary event — proves write scope. */
async function testWriteRoundTrip() {
  if (!gcalConfigured()) {
    return { ok: false, error: 'GCAL_NOT_CONFIGURED' };
  }
  const stamp = new Date().toISOString();
  const start = new Date(Date.now() + 365 * 86400000);
  const end = new Date(start.getTime() + 30 * 60000);
  let created;
  try {
    created = await insertPrimaryEvent({
      summary: `MC write-test (delete me) ${stamp}`,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      description: 'Cursor Phase 1 calendar write probe — safe to delete',
    });
    await deletePrimaryEvent(created.id);
    return {
      ok: true,
      scope_assumed: 'https://www.googleapis.com/auth/calendar',
      created_id: created.id,
      deleted: true,
    };
  } catch (e) {
    if (created?.id) {
      try { await deletePrimaryEvent(created.id); } catch (_) { /* ignore */ }
    }
    return {
      ok: false,
      error: e.message,
      status: e.status || null,
      detail: e.data || null,
    };
  }
}

async function applyMcShowAsFree(events, { limit = 40 } = {}) {
  const patched = [];
  const skipped = [];
  for (const e of events || []) {
    if (patched.length >= limit) break;
    if ((e._calendarId || 'primary') !== 'primary' || !e.id) continue;
    if (!mcShowsAsFree(e.summary)) continue;
    if (e.transparency === 'transparent') {
      skipped.push(e.id);
      continue;
    }
    await patchPrimaryEvent(e.id, { transparency: 'transparent' });
    patched.push({ id: e.id, summary: e.summary });
  }
  return { patched, already_free: skipped.length };
}

module.exports = {
  PRIMARY,
  mcShowsAsFree,
  insertPrimaryEvent,
  insertPrimaryAllDayEvent,
  patchPrimaryEvent,
  deletePrimaryEvent,
  getPrimaryEvent,
  verifyPrimaryEvent,
  testWriteRoundTrip,
  timedEventBody,
  allDayEventBody,
  applyMcShowAsFree,
};
