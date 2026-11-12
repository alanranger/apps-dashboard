// Stage E alone must build from what is PUBLISHED: live B's 05 export (new events linked to their products) and D's
// latest live 04 (each product's review set, owner replies included). 12 Nov: build a4166f97 read the stale shared 04
// (every review reply dropped → "@type Comment" removals) and dry B's pre-ingest 05 (the 2 new events unlinked).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { seedSandbox, eventInputSources } from '../../runner/steps.mjs';
import { findRemovals } from '../../runner/removals.mjs';

const { publishedReads, liveDoneHistory, seedSources, P04, P05 } = createRequire(import.meta.url)('../../runner/stages.cjs');

const live = (stage, dryRun) => ({ status: 'ok', mode: 'live', sandbox: `C:/TEMP/update-all/${dryRun}`, promoted_from: dryRun });
const LIVE_BD = [{ id: 'live-d', stage_results: { D: live('D', 'dry-d') } }, { id: 'live-b', stage_results: { B: live('B', 'dry-b') } }];

test('stage E alone reads live B\'s 05 export and D\'s live 04 (optional seeds)', () => {
  assert.deepEqual(publishedReads(['E'], liveDoneHistory(LIVE_BD)), [
    { stage: 'B', run_id: 'dry-b', sandbox: 'C:/TEMP/update-all/dry-b', seeds: [['live-05-export.csv', P05]], optional: true },
    { stage: 'D', run_id: 'dry-d', sandbox: 'C:/TEMP/update-all/dry-d', seeds: [P04], optional: true }]);
});

test('no published read for a stage in the run, a stage never published, or one whose last live was an undo', () => {
  assert.deepEqual(publishedReads(['D', 'E'], liveDoneHistory(LIVE_BD)).map((r) => r.stage), ['B'], 'the chain builds its own 04');
  assert.deepEqual(publishedReads(['E'], {}), []);
  const undo = { id: 'u', stage_results: { D: { status: 'ok', mode: 'live', undo_of: 'live-d' } } };
  assert.deepEqual(publishedReads(['E'], liveDoneHistory([undo, ...LIVE_BD])).map((r) => r.stage), ['B']);
  assert.deepEqual(publishedReads(['F'], liveDoneHistory(LIVE_BD)), [], 'only stages that declare reads');
  assert.deepEqual(publishedReads(null, liveDoneHistory(LIVE_BD)), [], 'Run all builds B and D itself');
});

function tempSandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bau-e-inputs-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ctx = { sandboxBase: base, runId: 'e-run', stages: ['E'] };
  const root = path.join(base, 'e-run');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.ready'), 'test');
  const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, dir, rel)), { recursive: true }); fs.writeFileSync(path.join(base, dir, rel), text); };
  return { base, ctx, root, write };
}

test('the published copies replace the dry seeds in E\'s sandbox, and the event index names them', (t) => {
  const { base, ctx, root, write } = tempSandbox(t);
  write('dry-b', P05, 'event_url\nold-only\n');
  write('dry-b', 'live-05-export.csv', 'event_url\nold-only\nnew-kenilworth-feb\n');
  write('dry-d', P04, 'url,schema_html\nreplies,"Comment"\n');
  const history = { A: { status: 'ok', run_id: 'dry-a', sandbox: path.join(base, 'dry-a') }, B: { status: 'ok', run_id: 'dry-b', sandbox: path.join(base, 'dry-b') } };
  write('dry-a', 'alan-shared-resources/csv/x.csv', 'a');
  write('dry-a', 'feeds/f.json', '{}');
  const reads = [{ stage: 'B', run_id: 'dry-b', sandbox: path.join(base, 'dry-b'), seeds: [['live-05-export.csv', P05]], optional: true },
    { stage: 'D', run_id: 'dry-d', sandbox: path.join(base, 'dry-d'), seeds: [P04], optional: true }];
  const out = seedSandbox(ctx, [...seedSources(['E'], history), ...reads]);
  assert.equal(out.missing, undefined);
  assert.match(fs.readFileSync(path.join(root, P05), 'utf8'), /new-kenilworth-feb/, 'live B export wins over the dry 05');
  assert.match(fs.readFileSync(path.join(root, P04), 'utf8'), /Comment/);
  assert.deepEqual(eventInputSources(ctx), { lines: ["event-product links (05) from: live B's export (run dry-b)", "reviews (04) from: D's live publish (run dry-d)"], notes: [] });
});

test('a missing optional seed is skipped (no failure) and the event index flags the copy it used', (t) => {
  const { base, ctx } = tempSandbox(t);
  const out = seedSandbox(ctx, [{ stage: 'D', run_id: 'gone', sandbox: path.join(base, 'gone'), seeds: [P04], optional: true }]);
  assert.equal(out.missing, undefined);
  const src = eventInputSources(ctx);
  assert.deepEqual(src.notes.map((n) => n.level), ['check', 'check']);
  assert.match(src.notes[1].text, /reviews \(04\) from a copy that may be out of date/);
  assert.match(seedSandbox(ctx, [{ stage: 'A', run_id: 'a', sandbox: path.join(base, 'gone'), seeds: ['x'] }]).missing, /stage A/, 'required seeds still fail');
});

test('Run all, or a chain with B and D: the run\'s own 05 and 04 are used', (t) => {
  const { ctx } = tempSandbox(t);
  assert.deepEqual(eventInputSources({ ...ctx, stages: null }).notes, []);
  assert.deepEqual(eventInputSources({ ...ctx, stages: ['B', 'D', 'E'] }).notes, []);
});

test('the removal check still blocks losing owner replies (the 12 Nov flag was a real loss, not a false positive)', () => {
  const reply = { '@type': 'Comment', author: { '@type': 'Organization', name: 'Alan Ranger Photography' }, text: 'Thanks Gerry' };
  const event = (comment) => ({ '@type': 'Event', '@id': 'e1', organizer: { '@type': 'Organization', name: 'Alan Ranger Photography' },
    review: [{ '@type': 'Review', reviewBody: 'Great', ...(comment ? { comment } : {}) }] });
  const lost = findRemovals({ '@graph': [event(reply)] }, { '@graph': [event(null)] });
  assert.deepEqual(lost.map((r) => r.what), ['@type Comment no longer anywhere in the file']);
  assert.deepEqual(findRemovals({ '@graph': [event(reply)] }, { '@graph': [event(reply), { '@type': 'Event', '@id': 'new' }] }), []);
});
