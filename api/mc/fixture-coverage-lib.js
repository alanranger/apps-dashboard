/**
 * Ipswich fixture flank blocks — informational MC ⚽ Before / After.
 * Proposals only (Claude applies). Tie-back: fixture_blocks.before_event_id +
 * after_event_id. Retirement re-keys on fixture_event_id every run.
 *
 * Shape (per match start S / end E from the live feed):
 *   Before: S−buffer → S
 *   After:  E → E+buffer
 * Match itself is never duplicated (stays on Ipswich feed).
 *
 * Flank blocks are NOT binding: rule-breach-lib excludes MC ⚽ from breach checks.
 */
const { isoToLondonDate, isoToLondonMinutes } = require('./scheduling-rules-lib');

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

function createAction(prefix, win, fixture) {
  const label = matchLabel(fixture);
  const day = isoToLondonDate(win.fixture_start);
  return `Create TWO informational ${prefix} blocks on ${day} for "${label}" `
    + `(match itself stays on Ipswich feed — do not duplicate):\n`
    + `1) "${prefix} Before: ${label}" ${londonHm(win.before_start)}–${londonHm(win.before_end)}\n`
    + `2) "${prefix} After: ${label}" ${londonHm(win.after_start)}–${londonHm(win.after_end)}\n`
    + 'NOT binding — never displaces a class or MC admin, never costs a roll. '
    + 'Then set before_event_id + after_event_id on the fixture_blocks row.';
}

function moveAction(prefix, win, fixture) {
  const label = matchLabel(fixture);
  const day = isoToLondonDate(win.fixture_start);
  return `Move BOTH ${prefix} flanks on ${day} for "${label}" to `
    + `Before ${londonHm(win.before_start)}–${londonHm(win.before_end)} and `
    + `After ${londonHm(win.after_start)}–${londonHm(win.after_end)} `
    + '(kick-off/end shifted). Informational only.';
}

function timesMoved(row, win) {
  return String(row.fixture_start) !== String(win.fixture_start)
    || String(row.fixture_end) !== String(win.fixture_end);
}

function flanksPlaced(row) {
  return !!(row?.before_event_id && row?.after_event_id);
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

async function insertPending(sb, existingPending, inserted, row) {
  if (await existingPending(row.change_type, row.related_id)) return;
  const out = await sb('pending_diary_changes', { method: 'POST', body: row });
  const id = Array.isArray(out) ? out[0]?.id : out?.id;
  if (id) inserted.push(id);
}

async function proposeCreateOrMove(ctx, fixture, row) {
  const {
    sb, existingPending, inserted, prefix, bufferMin,
  } = ctx;
  const win = flankWindows(fixture, bufferMin);
  if (!win) return false;
  await writeRow(sb, fixture, row, win, bufferMin);
  const day = isoToLondonDate(win.fixture_start);

  if (!flanksPlaced(row)) {
    await insertPending(sb, existingPending, inserted, {
      change_type: 'fixture_block',
      target_date: day,
      summary: `Fixture flanks: ${fixture.summary || 'Ipswich Town'} — ${day}`,
      proposed_action: createAction(prefix, win, fixture),
      reason: 'Ipswich fixture needs MC ⚽ Before + After (informational; two blocks)',
      urgency: 'low',
      status: 'pending',
      related_id: `fixture:${fixture.id}`,
    });
    return true;
  }
  if (timesMoved(row, win)) {
    // Unique related_id per kick-off left prior move rows forever. Clear siblings first.
    try {
      const old = await sb(
        `pending_diary_changes?status=eq.pending&change_type=eq.fixture_block`
        + `&related_id=like.${encodeURIComponent(`fixture_move:${fixture.id}:*`)}`
        + '&select=id',
      );
      for (const p of old || []) {
        await sb(`pending_diary_changes?id=eq.${p.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'dismissed',
            resolved_at: new Date().toISOString(),
            resolved_by: 'fixture_move_supersede',
            proposed_action: 'DISMISSED — superseded by newer fixture kick-off',
          },
        });
      }
    } catch (_) { /* non-fatal */ }
    await insertPending(sb, existingPending, inserted, {
      change_type: 'fixture_block',
      target_date: day,
      summary: `Fixture moved: ${fixture.summary || 'Ipswich Town'} — ${day}`,
      proposed_action: moveAction(prefix, win, fixture),
      reason: `Fixture time changed; was ${row.fixture_start}`,
      urgency: 'low',
      status: 'pending',
      related_id: `fixture_move:${fixture.id}:${win.fixture_start}`,
    });
    return true;
  }
  return false;
}

async function retireGoneFixtures(ctx, feedIds, activeRows) {
  const {
    sb, existingPending, inserted, prefix,
  } = ctx;
  let retired = 0;
  for (const row of activeRows) {
    if (feedIds.has(row.fixture_event_id)) continue;
    await sb(`fixture_blocks?id=eq.${row.id}`, {
      method: 'PATCH',
      body: { status: 'retired', updated_at: new Date().toISOString() },
    });
    if (row.before_event_id || row.after_event_id || row.calendar_event_id) {
      await insertPending(sb, existingPending, inserted, {
        change_type: 'fixture_block_retire',
        target_date: isoToLondonDate(row.fixture_start),
        summary: `Fixture gone: ${row.title || 'Ipswich fixture'}`,
        proposed_action: `Delete BOTH ${prefix} Before and After blocks for this fixture `
          + '(and any legacy single block) — it left the feed. Informational only.',
        reason: `fixture_event_id ${row.fixture_event_id} absent from current feed`,
        urgency: 'low',
        status: 'pending',
        related_id: `fixture_retire:${row.fixture_event_id}`,
      });
    }
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
  let proposed = 0;
  for (const fixture of fixtures || []) {
    if (!fixture.id) continue;
    feedIds.add(fixture.id);
    const changed = await proposeCreateOrMove(ctx, fixture, rowByFixture.get(fixture.id));
    if (changed) proposed += 1;
  }
  const activeRows = allRows.filter((r) => r.status === 'active');
  const retired = await retireGoneFixtures(ctx, feedIds, activeRows);
  notes.push(
    `fixture_block_scan: ${fixtures?.length || 0} feed fixtures; ${proposed} create/move proposal(s); ${retired} retired`,
  );
}

module.exports = {
  runFixtureBlockScan, flankWindows, blockWindow, londonHm, matchLabel,
};
