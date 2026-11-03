import test from 'node:test';
import assert from 'node:assert/strict';
import { blobHash, servedCheck, servedText } from '../../runner/served-check.mjs';

const want = { 'a_schema.json': blobHash(Buffer.from('{"a":1}\n')), 'b_schema.json': blobHash(Buffer.from('{"b":1}\n')) };

test('served check: git blob ids, so CRLF on disk never matters (the live D false warning)', () => {
  assert.equal(blobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a', 'same id as git hash-object');
  assert.notEqual(blobHash(Buffer.from('{"a":1}\r\n')), want['a_schema.json']);
});

test('served check: every file matching → "served: N of N match", no warning, progress reported', async () => {
  const progress = [];
  const r = await servedCheck(want, { fetchBlob: async (f) => want[f], intervalMs: 1, timeoutMs: 50, onProgress: (l, d, t) => progress.push([l, d, t]) });
  assert.deepEqual(r.differ, []);
  assert.equal(servedText(r), 'served: 2 of 2 match');
  assert.deepEqual(progress.at(-1), ['Checking served files: {done} of {total} match', 2, 2]);
});

test('served check: a file that keeps differing → warns and names it after polling; a late file is picked up', async () => {
  let calls = 0;
  const fetchBlob = async (f) => {
    calls += 1;
    if (f === 'b_schema.json') return 'stale';
    return calls > 2 ? want[f] : 'not yet';
  };
  const r = await servedCheck(want, { fetchBlob, intervalMs: 5, timeoutMs: 60 });
  assert.deepEqual(r.differ, ['b_schema.json']);
  assert.equal(r.matched, 1, 'a_schema.json matched on a later poll');
  assert.ok(r.polls > 1);
  assert.match(servedText(r, 300000), /served: 1 of 2 match after 5 min; 1 still differ: b_schema\.json/);
});
