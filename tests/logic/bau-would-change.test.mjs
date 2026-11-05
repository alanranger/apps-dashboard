import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wouldChange } from '../../runner/engine.mjs';

test('B: CSV rows + pages re-read + 05 rows; 0 only when every count is 0', () => {
  const zero = [{ counts: { db_rows_changed: 0, refetch_plan: { reingest: 0 }, export_rows_changed_vs_live: 0 } }];
  assert.equal(wouldChange(zero), 0);
  const reread = [{ counts: { db_rows_changed: 0, refetch_plan: { reingest: 1 }, export_rows_changed_vs_live: 0 } }];
  assert.equal(wouldChange(reread), 1);
});

test('H: final ingest rows count', () => {
  assert.equal(wouldChange([{ counts: { db_rows_changed: 38 } }, { counts: { files: [] } }]), 38);
  assert.equal(wouldChange([{ counts: { db_rows_changed: 0 } }, { counts: { files: [] } }]), 0);
});

test('no db_rows_changed (other stages, or checks before it was recorded): null, never "nothing"', () => {
  assert.equal(wouldChange([{ counts: { files: [] } }]), null);
  assert.equal(wouldChange([{ counts: { refetch_plan: { reingest: 0 }, export_rows_changed_vs_live: 0 } }]), null);
});
