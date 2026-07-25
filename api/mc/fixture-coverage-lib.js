/**
 * Ipswich fixture blocks — informational MC ⚽ placements. Proposals only, no
 * Calendar writes (Claude applies). The fixture_blocks table is the tie-back and
 * retirement is re-keyed on fixture_event_id every run.
 *
 * A fixture block is NOT binding: it never displaces/blocks/flags a class or MC
 * admin and never costs a habit a roll — that guarantee lives in rule-breach-lib
 * (fixtures excluded from the busy map + MC ⚽ excluded from all breach checks).
 */
const { isoToLondonDate } = require('./scheduling-rules-lib');

function shiftIso(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60000).toISOString();
}

/** Kick-off − buffer → stated end + buffer. */
function blockWindow(fixture, bufferMin) {
  const start = fixture.start?.dateTime || fixture.start;
  const end = fixture.end?.dateTime || fixture.end;
  if (!start || !end || !String(start).includes('T')) return null;
  return {
    fixture_start: start,
    fixture_end: end,
    block_start: shiftIso(start, -bufferMin),
    block_end: shiftIso(end, bufferMin),
  };
}

function hm(iso) {
  return String(iso).slice(11, 16);
}

function createAction(prefix, win, fixture) {
  return `Create informational ${prefix} block ${win.block_start.slice(0, 10)} `
    + `${hm(win.block_start)}–${hm(win.block_end)} for "${fixture.summary || 'Ipswich fixture'}" `
    + '(watch at home; NOT binding — never displaces a class or MC admin, never costs a roll). '
    + 'Then set calendar_event_id on the fixture_blocks row.';
}

function timesMoved(row, win) {
  return String(row.fixture_start) !== win.fixture_start
    || String(row.fixture_end) !== win.fixture_end;
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

// Insert new / update existing WITHOUT touching calendar_event_id (Claude's tie-back).
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
  const win = blockWindow(fixture, bufferMin);
  if (!win) return false;
  await writeRow(sb, fixture, row, win, bufferMin);
  const day = isoToLondonDate(win.fixture_start);

  // No MC ⚽ block yet (new fixture, or a retired one reappearing after its block
  // was deleted) → propose CREATE. Dedup on related_id keeps it to one open row.
  if (!row || !row.calendar_event_id) {
    await insertPending(sb, existingPending, inserted, {
      change_type: 'fixture_block',
      target_date: day,
      summary: `Fixture: ${fixture.summary || 'Ipswich Town'} — ${day}`,
      proposed_action: createAction(prefix, win, fixture),
      reason: 'Ipswich fixture with no MC ⚽ block yet (informational)',
      urgency: 'low',
      status: 'pending',
      related_id: `fixture:${fixture.id}`,
    });
    return true;
  }
  if (row.calendar_event_id && timesMoved(row, win)) {
    await insertPending(sb, existingPending, inserted, {
      change_type: 'fixture_block',
      target_date: day,
      summary: `Fixture moved: ${fixture.summary || 'Ipswich Town'} — ${day}`,
      proposed_action: `Move ${prefix} block to ${win.block_start.slice(0, 10)} `
        + `${hm(win.block_start)}–${hm(win.block_end)} (kick-off/end shifted). `
        + 'Informational only.',
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
    if (row.calendar_event_id) {
      await insertPending(sb, existingPending, inserted, {
        change_type: 'fixture_block_retire',
        target_date: isoToLondonDate(row.fixture_start),
        summary: `Fixture gone: ${row.title || 'Ipswich fixture'}`,
        proposed_action: `Delete the ${prefix} block for this fixture — it left the feed `
          + '(postponed/cancelled/replaced). Informational only.',
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
 * Place/refresh/retire fixture blocks for every fixture in the feed.
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
    // writeRow PATCHes an existing row (active or retired → reactivates), inserts if new.
    const changed = await proposeCreateOrMove(ctx, fixture, rowByFixture.get(fixture.id));
    if (changed) proposed += 1;
  }
  const activeRows = allRows.filter((r) => r.status === 'active');
  const retired = await retireGoneFixtures(ctx, feedIds, activeRows);
  notes.push(
    `fixture_block_scan: ${fixtures?.length || 0} feed fixtures; ${proposed} create/move proposal(s); ${retired} retired`,
  );
}

module.exports = { runFixtureBlockScan, blockWindow };
