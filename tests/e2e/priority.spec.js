import { test, expect } from '@playwright/test';
import {
  mcLogin, mcApi, assertOnlyChanged, pickRow, sbWrite, firstProjectId, taskFromBootstrap,
} from '../helpers/mc.mjs';

const HABIT_COLS = ['priority', 'last_done', 'rolls_used', 'scheduled_note'];
const TASK_PRI_COL = 'priority';

test.describe.configure({ mode: 'serial' });

test.describe('Priority — tasks', () => {
  test.skip(!process.env.MC_AGENT_PASSWORD, 'requires MC_AGENT_PASSWORD');

  test('all six enum values accepted on task PATCH', async () => {
    const { token } = await mcLogin('agent');
    const projectId = await firstProjectId(token);
    const created = await mcApi('/api/mc/tasks', {
      token,
      method: 'POST',
      body: { project_id: projectId, title: `TEST priority task (auto ${Date.now()})`, actor: 'cursor' },
    });
    const id = created.task.id;
    const before = await taskFromBootstrap(token, id);
    expect(['p0', 'p1', 'p2']).toContain(before.priority);

    for (const p of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) {
      const patched = await mcApi('/api/mc/tasks', {
        token, method: 'PATCH', body: { id, priority: p, actor: 'cursor' },
      });
      expect(patched.task.priority).toBe(p);
    }

    const after = await taskFromBootstrap(token, id);
    console.log('TASK PRIORITY ENUM EVIDENCE', JSON.stringify({
      before: pickRow(before, [TASK_PRI_COL]),
      after: pickRow(after, [TASK_PRI_COL]),
    }, null, 2));

    if (process.env.MC_SUPABASE_SERVICE_KEY) {
      await sbWrite(`tasks?id=eq.${id}`, { method: 'DELETE' });
    }
  });
});

test.describe('Priority — habits', () => {
  test.skip(!process.env.MC_SUPABASE_SERVICE_KEY, 'requires MC_SUPABASE_SERVICE_KEY');

  test('priority editable and persisting on habit', async () => {
    const { token } = await mcLogin('agent');
    const created = await mcApi('/api/mc/recurring', {
      token,
      method: 'POST',
      body: {
        title: 'TEST habit priority (auto)',
        cadence_text: 'Weekly Fri',
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
        duration_min: 15,
        priority: 'p4',
        actor: 'cursor',
      },
    });
    const id = created.task.id;
    const before = await mcApi('/api/mc/recurring', { token });
    const beforeRow = before.recurring.find((r) => r.id === id);

    const patched = await mcApi('/api/mc/recurring', {
      token,
      method: 'PATCH',
      body: { id, priority: 'p0', actor: 'cursor' },
    });

    console.log('HABIT PRIORITY EVIDENCE', JSON.stringify({
      before: pickRow(beforeRow, HABIT_COLS),
      after: pickRow(patched.task, HABIT_COLS),
    }, null, 2));

    expect(beforeRow.priority).toBe('p4');
    expect(patched.task.priority).toBe('p0');
    assertOnlyChanged(beforeRow, patched.task, ['priority', 'updated_at']);

    await sbWrite(`recurring_tasks?id=eq.${id}`, { method: 'DELETE' });
  });
});

test.describe('Priority — placement API', () => {
  test.skip(!process.env.MC_AGENT_PASSWORD, 'requires MC_AGENT_PASSWORD');

  test('day-capacity exposes priority competition with displacement', async () => {
    const { token } = await mcLogin('agent');
    const cap = await mcApi('/api/mc/day-capacity?from=2026-08-01&to=2026-08-01', { token });
    expect(cap.priority_order).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(cap.placement_rule).toMatch(/roll_forward/);
    const day = cap.days?.[0];
    expect(day?.priority_competition).toBeTruthy();
    expect(Array.isArray(day.priority_competition.placed)).toBe(true);
    expect(Array.isArray(day.priority_competition.displaced)).toBe(true);
    console.log('DAY CAPACITY PRIORITY EVIDENCE', JSON.stringify({
      date: day?.date,
      displaced_count: day?.priority_competition?.displaced?.length,
      sample_displaced: day?.priority_competition?.displaced?.[0] || null,
    }, null, 2));
  });

  test('habit-projection carries priority per occurrence', async () => {
    const { token } = await mcLogin('agent');
    const proj = await mcApi('/api/mc/habit-projection.json?days=14', { token });
    expect(proj.priority_order?.length).toBe(6);
    if (proj.occurrences?.length) {
      expect(proj.occurrences[0].priority).toMatch(/^p[0-5]$/);
      expect(proj.occurrences[0].placement).toBeTruthy();
    }
    console.log('HABIT PROJECTION PRIORITY EVIDENCE', JSON.stringify({
      count: proj.count,
      sample: proj.occurrences?.[0]
        ? pickRow(proj.occurrences[0], ['title', 'priority', 'placement', 'roll_forward'])
        : null,
    }, null, 2));
  });
});
