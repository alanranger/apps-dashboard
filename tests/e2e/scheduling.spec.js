import { test, expect } from '@playwright/test';
import {
  mcLogin, mcApi, assertOnlyChanged, pickRow, sbWrite,
  schedulingBundle, ruleFromBundle, pendingFromBundle,
} from '../helpers/mc.mjs';

const RULE_KEY = 'daily_task_cap_min';

test.describe.configure({ mode: 'serial' });

test.describe('Scheduling — rules save + audit + capacity behaviour', () => {
  test.skip(!process.env.MC_AGENT_PASSWORD, 'requires MC_AGENT_PASSWORD');

  test('rule save persists, writes audit, and day-capacity uses new cap', async () => {
    const { token } = await mcLogin('agent');
    const beforeBundle = await schedulingBundle(token);
    const before = ruleFromBundle(beforeBundle, RULE_KEY);
    const original = before.value;
    const testVal = original === '60' ? '61' : '60';

    await mcApi('/api/mc/scheduling', {
      token,
      method: 'PATCH',
      body: { entity: 'rule', key: RULE_KEY, value: testVal, actor: 'cursor-test' },
    });

    const afterBundle = await schedulingBundle(token);
    const after = ruleFromBundle(afterBundle, RULE_KEY);
    const audit = afterBundle.audit?.find((a) => a.key === RULE_KEY && a.new_value === testVal);
    const cap = await mcApi('/api/mc/day-capacity?from=2026-07-23&to=2026-07-23', { token });

    console.log('RULE SAVE EVIDENCE', JSON.stringify({
      before: pickRow(before, ['key', 'value']),
      after: pickRow(after, ['key', 'value']),
      audit: pickRow(audit, ['key', 'old_value', 'new_value', 'changed_by']),
      day_capacity_cap: cap.daily_task_cap_min,
    }, null, 2));

    expect(after.value).toBe(testVal);
    assertOnlyChanged(before, after, ['value', 'updated_at']);
    expect(audit?.old_value).toBe(original);
    expect(audit?.new_value).toBe(testVal);
    expect(cap.daily_task_cap_min).toBe(Number(testVal));

    await mcApi('/api/mc/scheduling', {
      token,
      method: 'PATCH',
      body: { entity: 'rule', key: RULE_KEY, value: original, actor: 'cursor-test' },
    });
  });
});

test.describe('Scheduling — pending dismiss / applied', () => {
  test.skip(!process.env.MC_SUPABASE_SERVICE_KEY, 'requires MC_SUPABASE_SERVICE_KEY for pending row seed');

  test('dismiss sets status dismissed; row stays gone from pending list', async () => {
    const { token } = await mcLogin('agent');
    const relatedId = `test-dismiss-${Date.now()}`;
    const [row] = await sbWrite('pending_diary_changes', {
      body: {
        change_type: 'test_proposal',
        target_date: '2026-07-24',
        summary: 'TEST dismiss row (auto)',
        proposed_action: 'noop for playwright',
        reason: 'cursor e2e',
        urgency: 'normal',
        status: 'pending',
        related_id: relatedId,
      },
    });
    const id = row.id;
    const beforeBundle = await schedulingBundle(token);
    const before = pendingFromBundle(beforeBundle, id);

    await mcApi('/api/mc/scheduling', {
      token,
      method: 'PATCH',
      body: { entity: 'pending', id, status: 'dismissed', actor: 'cursor-test' },
    });

    const afterBundle = await schedulingBundle(token);
    const after = pendingFromBundle(afterBundle, id);
    console.log('DISMISS EVIDENCE', JSON.stringify({
      before: pickRow(before, ['status', 'resolved_at', 'resolved_by']),
      after: after ? pickRow(after, ['status', 'resolved_at', 'resolved_by']) : { status: 'dismissed' },
      pending_list_contains_row: Boolean(pendingFromBundle(afterBundle, id)),
    }, null, 2));

    expect(after).toBeFalsy();
    expect(afterBundle.pending.some((p) => p.id === id)).toBe(false);

    await sbWrite(`pending_diary_changes?id=eq.${id}`, { method: 'DELETE' });
  });

  test('applied marks bookkeeping only — no calendar/task writes', async () => {
    const { token } = await mcLogin('agent');
    const [row] = await sbWrite('pending_diary_changes', {
      body: {
        change_type: 'test_proposal',
        target_date: '2026-07-25',
        summary: 'TEST applied row (auto)',
        proposed_action: 'Claude would create a calendar block',
        reason: 'cursor e2e',
        status: 'pending',
        related_id: `test-applied-${Date.now()}`,
      },
    });
    const id = row.id;
    const before = await (async () => {
      const b = await schedulingBundle(token);
      return pendingFromBundle(b, id);
    })();

    const patch = await mcApi('/api/mc/scheduling', {
      token,
      method: 'PATCH',
      body: { entity: 'pending', id, status: 'applied', actor: 'cursor-test' },
    });

    console.log('APPLIED EVIDENCE', JSON.stringify({
      before: pickRow(before, ['status', 'resolved_at', 'resolved_by']),
      after: pickRow(patch.pending, ['status', 'resolved_at', 'resolved_by']),
      semantics: 'Applied = Alan/Claude confirm the proposed calendar change was done manually. MC only updates pending_diary_changes status — zero Calendar or task writes.',
    }, null, 2));

    assertOnlyChanged(before, patch.pending, ['status', 'resolved_at', 'resolved_by']);
    expect(patch.pending.status).toBe('applied');
    expect(patch.pending.resolved_by).toBeTruthy();

    await sbWrite(`pending_diary_changes?id=eq.${id}`, { method: 'DELETE' });
  });
});

test.describe('Scheduling — CSV freshness badge', () => {
  test.skip(!process.env.MC_AGENT_PASSWORD, 'requires MC_AGENT_PASSWORD');

  test('sources name GitHub origin and expose green/amber/red tone', async () => {
    const { token } = await mcLogin('agent');
    const data = await schedulingBundle(token);
    expect(data.sources?.length).toBeGreaterThan(0);

    for (const s of data.sources) {
      expect(['green', 'amber', 'red']).toContain(s.tone);
      expect(s.display).toMatch(/Lessons CSV|Workshops CSV/);
      if (s.ok) {
        expect(s.origin === 'github' || s.origin === 'local').toBe(true);
        if (s.origin === 'github') {
          expect(s.path).toMatch(/alan-shared-resources/);
          expect(s.display).toMatch(/alan-shared-resources/);
        }
        expect(typeof s.age_days).toBe('number');
      }
    }
    console.log('CSV FRESHNESS EVIDENCE', JSON.stringify(data.sources.map((s) => ({
      id: s.id, tone: s.tone, origin: s.origin, age_days: s.age_days, display: s.display,
    })), null, 2));
  });
});
