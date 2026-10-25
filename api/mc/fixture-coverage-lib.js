/**
 * Ipswich fixture flank blocks — informational MC ⚽ Before / After.
 * Self-healing, no proposals: this scan keeps fixture_blocks in step with the feed
 * (new / moved kick-offs) and deletes flanks of fixtures that left the feed;
 * rule-event-masters-lib syncFixtureBuffers then (re)paints flanks at the row's
 * current kick-off. Tie-back: fixture_blocks.before_event_id + after_event_id.
 *
 * Shape (per match start S / end E from the live feed):
 *   Before: S−buffer → S
 *   After:  E → E+buffer
 * Match itself is never duplicated (stays on Ipswich feed).
 *
 * Flank blocks are NOT binding: rule-breach-lib excludes MC ⚽ from breach checks.
 */
const { isoToLondonMinutes } = require('./scheduling-rules-lib');
const { deletePrimaryEvent } = require('./gcal-write-lib');

function shiftIso(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

/** London wall-clock HH:MM for proposal text (never UTC slice). */
function londonHm(iso) {
  const mins = isoToLondonMinutes(iso);
  if (mins == null) return '?';
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Two flanks + envelope. Times are ISO instants from the feed (UTC or offset OK).
 * @returns {{ fixture_start, fixture_end, before_start, before_end, after_start, after_end, block_start, block_end }|null}
 */
function flankWindows(fixture, bufferMin) {
  const start = fixture.start?.dateTime || fixture.start;
  const end = fixture.end?.dateTime || fixture.end;
  if (!start || !end || !String(start).includes('T')) return null;
  const beforeStart = shiftIso(start, -bufferMin);
  const afterEnd = shiftIso(end, bufferMin);
  return {
    fixture_start: start,
    fixture_end: end,
    before_start: beforeStart,
    before_end: start,
    after_start: end,
    after_end: afterEnd,
    block_start: beforeStart,
    block_end: afterEnd,
  };
}

/** @deprecated use flankWindows — kept for older imports */
function blockWindow(fixture, bufferMin) {
  return flankWindows(fixture, bufferMin);
}

function matchLabel(fixture) {
  return (fixture.summary || 'Ipswich fixture').replace(/^⚽️\s*/, '').trim();
}

// DB returns "2026-12-02 20:00:00+00", the feed "2026-12-01T20:00:00Z" — compare instants.
function toMs(v) {
  const s = String(v || '').trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  return Date.parse(s);
}

function sameInstant(a, b) {
  return toMs(a) === toMs(b);
}

function timesMoved(row, win) {
  return !sameInstant(row.fixture_start, win.fixture_start)
    || !sameInstant(row.fixture_end, win.fixture_end);
}

function rowBody(fixture, win, bufferMin) {
  return {
    title: fixture.summary || null,
    fixture_start: win.fixture_start,
    fixture_end: win.fixture_end,
    block_start: win.block_start,
    block_end: win.block_end,
    buffer_min: bufferMin,
    status: 'active',
    updated_at: new Date().toISOString(),
  };
}

async function writeRow(sb, fixture, row, win, bufferMin) {
  if (row) {
    await sb(`fixture_blocks?id=eq.${row.id}`, {
      method: 'PATCH', prefer: 'return=minimal', body: rowBody(fixture, win, bufferMin),
    });
    return;
  }
  await sb('fixture_blocks', {
    method: 'POST',
    prefer: 'return=minimal',
    body: { fixture_event_id: fixture.id, ...rowBody(fixture, win, bufferMin) },
  });
}

/** Keep the row's kick-off in step with the feed; flanks are repainted by syncFixtureBuffers. */
async function upsertFixtureRow(ctx, fixture, row) {
  const { sb, bufferMin } = ctx;
  const win = flankWindows(fixture, bufferMin);
  if (!win) return false;
  const isNew = !row || row.status !== 'active';
  const retitled = !isNew && (fixture.summary || null) !== (row.title || null);
  if (!isNew && !retitled && !timesMoved(row, win)) return false;
  await writeRow(sb, fixture, row, win, bufferMin);
  return true;
}

async function deleteFlankEvents(row) {
  const ids = [row.before_event_id, row.after_event_id, row.calendar_event_id].filter(Boolean);
  for (const id of ids) {
    try { await deletePrimaryEvent(id); } catch (_) { /* already gone — purge sweep catches leftovers */ }
  }
  return ids.length;
}

function fixtureIsPast(row, nowMs = Date.now()) {
  const end = Date.parse(row.fixture_end || row.fixture_start || '');
  return Number.isFinite(end) && end < nowMs;
}

/**
 * Upcoming fixture left the feed: delete its flanks now and retire the row (no proposal).
 * Past fixtures are never in the feed (it starts today) — leave them as history.
 */
async function retireGoneFixtures(ctx, feedIds, activeRows) {
  const { sb } = ctx;
  let retired = 0;
  for (const row of activeRows) {
    if (feedIds.has(row.fixture_event_id) || fixtureIsPast(row)) continue;
    await deleteFlankEvents(row);
    await sb(`fixture_blocks?id=eq.${row.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        status: 'retired',
        before_event_id: null,
        after_event_id: null,
        calendar_event_id: null,
        updated_at: new Date().toISOString(),
      },
    });
    retired += 1;
  }
  return retired;
}

/**
 * Place/refresh/retire fixture flank blocks for every fixture in the feed.
 * @param {object} ctx { sb, existingPending, inserted, notes, fixtures, prefix, bufferMin }
 */
async function runFixtureBlockScan(ctx) {
  const {
    sb, notes, fixtures,
  } = ctx;
  let allRows = [];
  try {
    allRows = await sb('fixture_blocks?select=*') || [];
  } catch (e) {
    notes.push(`fixture_blocks_read_error: ${e.message}`);
    return;
  }
  const rowByFixture = new Map(allRows.map((r) => [r.fixture_event_id, r]));
  const feedIds = new Set();
  let updated = 0;
  for (const fixture of fixtures || []) {
    if (!fixture.id) continue;
    feedIds.add(fixture.id);
    if (await upsertFixtureRow(ctx, fixture, rowByFixture.get(fixture.id))) updated += 1;
  }
  // An empty/failed feed must never retire the whole season.
  if (!feedIds.size) {
    notes.push('fixture_block_scan: feed returned 0 fixtures — retire step skipped');
    return;
  }
  const activeRows = allRows.filter((r) => r.status === 'active');
  const retired = await retireGoneFixtures(ctx, feedIds, activeRows);
  notes.push(
    `fixture_block_scan: ${fixtures?.length || 0} feed fixtures; ${updated} new/moved; ${retired} retired (flanks deleted)`,
  );
}

module.exports = {
  runFixtureBlockScan, flankWindows, blockWindow, londonHm, matchLabel, fixtureIsPast, timesMoved,
};
