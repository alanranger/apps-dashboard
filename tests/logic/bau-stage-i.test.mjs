import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDLERS } from '../../runner/steps.mjs';

const monday = new Date().getUTCDay() === 1;

test('live stage I starts ①, confirms its run row and finishes ok at once (no 3-hour poll)', { skip: monday && 'refused on Mondays by design' }, async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push([String(url), opts?.method || 'GET']);
    return { ok: true, json: async () => ({ ok: true, run_id: 'aaaabbbb-run' }) };
  };
  // "is ① already running?" (status=in.(…)) → no; the started run's own row → yes.
  const store = { query: async (q) => (q.includes('status=in.') ? [] : [{ id: 'aaaabbbb-run', status: 'running', started_at: '2026-11-04T10:00:00Z', pages_planned: 443 }]) };
  try {
    const t0 = Date.now();
    const out = await HANDLERS.audit({ mode: 'live', includeAudit: true, store });
    assert.ok(Date.now() - t0 < 5000, 'returns without waiting for ①');
    assert.equal(out.status, 'ok');
    assert.match(out.plain, /Full audit ① started \(run aaaabbbb\)\. It runs in the background \(about 3 h\)/);
    assert.equal(out.counts.pages_planned, 443);
    assert.deepEqual(calls.map((c) => c[1]), ['POST'], 'one start call, no status polling');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('live stage I warns (does not hang) when no run row appears after the start', { skip: monday && 'refused on Mondays by design' }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, run_id: 'ccccdddd-run' }) });
  const store = { query: async () => [] };
  try {
    const p = HANDLERS.audit({ mode: 'live', includeAudit: true, store });
    for (let i = 0; i < 8; i += 1) { await new Promise((r) => setImmediate(r)); t.mock.timers.tick(10000); }
    const out = await p;
    assert.equal(out.status, 'warn');
    assert.match(out.warnings[0], /no fault_monitor_runs row appeared/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
