import { test, expect } from '@playwright/test';
import {
  mcLogin, mcApi, assertOnlyChanged, pickRow,
  firstProjectId, taskFromBootstrap, sbWrite,
} from '../helpers/mc.mjs';

const TASK_COLS = [
  'est_minutes', 'completed_on', 'slot_pinned', 'slot_pinned_at', 'state', 'calendar_event_id',
];

test.describe.configure({ mode: 'serial' });

test.describe('Task drawer — estimate, complete, unpin', () => {
  test.skip(!process.env.MC_AGENT_PASSWORD, 'requires MC_AGENT_PASSWORD');

  test('set estimate saves est_minutes only (+ last_activity_at)', async () => {
    const { token } = await mcLogin('agent');
    const projectId = await firstProjectId(token);
    const created = await mcApi('/api/mc/tasks', {
      token,
      method: 'POST',
      body: {
        project_id: projectId,
        title: `TEST est_minutes (auto ${Date.now()})`,
        actor: 'cursor',
      },
    });
    const id = created.task.id;
    const before = await taskFromBootstrap(token, id);

    const patched = await mcApi('/api/mc/tasks', {
      token,
      method: 'PATCH',
      body: { id, est_minutes: 45, actor: 'cursor' },
    });
    const after = patched.task;

    console.log('ESTIMATE EVIDENCE', JSON.stringify({
      before: pickRow(before, TASK_COLS),
      after: pickRow(after, TASK_COLS),
    }, null, 2));

    expect(after.est_minutes).toBe(45);
    assertOnlyChanged(before, after, ['est_minutes', 'last_activity_at']);

    if (process.env.MC_SUPABASE_SERVICE_KEY) {
      await sbWrite(`tasks?id=eq.${id}`, { method: 'DELETE' });
    }
  });

  test('mark done sets completed_on + slot_pinned; state stays not verified', async () => {
    const { token } = await mcLogin('agent');
    const projectId = await firstProjectId(token);
    const created = await mcApi('/api/mc/tasks', {
      token,
      method: 'POST',
      body: {
        project_id: projectId,
        title: `TEST complete (auto ${Date.now()})`,
        actor: 'cursor',
      },
    });
    const displayId = created.task.display_id;
    const id = created.task.id;
    const before = await taskFromBootstrap(token, id);
    const today = new Date().toISOString().slice(0, 10);

    const result = await mcApi('/api/mc/task-completed', {
      token,
      method: 'POST',
      body: { display_id: displayId, completed_on: today, source: 'app', actor: 'cursor' },
    });

    const after = await taskFromBootstrap(token, id);
    console.log('COMPLETE EVIDENCE', JSON.stringify({
      api: result,
      before: pickRow(before, TASK_COLS),
      after: pickRow(after, TASK_COLS),
    }, null, 2));

    expect(result.verified).toBe(false);
    expect(after.completed_on).toBe(today);
    expect(after.slot_pinned).toBe(true);
    expect(after.state).not.toBe('verified');
    assertOnlyChanged(before, after, [
      'completed_on', 'slot_pinned', 'slot_pinned_at', 'last_activity_at',
    ]);

    if (process.env.MC_SUPABASE_SERVICE_KEY) {
      await sbWrite(`tasks?id=eq.${id}`, { method: 'DELETE' });
    }
  });

  test('unpin clears slot_pinned; task becomes reschedulable', async () => {
    const { token } = await mcLogin('agent');
    const projectId = await firstProjectId(token);
    const created = await mcApi('/api/mc/tasks', {
      token,
      method: 'POST',
      body: {
        project_id: projectId,
        title: `TEST unpin (auto ${Date.now()})`,
        actor: 'cursor',
      },
    });
    const id = created.task.id;
    await mcApi('/api/mc/tasks', {
      token,
      method: 'PATCH',
      body: { id, slot_pinned: true, actor: 'cursor' },
    });
    const before = await taskFromBootstrap(token, id);

    const patched = await mcApi('/api/mc/tasks', {
      token,
      method: 'PATCH',
      body: { id, slot_pinned: false, actor: 'cursor' },
    });
    const after = patched.task;

    console.log('UNPIN EVIDENCE', JSON.stringify({
      before: pickRow(before, TASK_COLS),
      after: pickRow(after, TASK_COLS),
    }, null, 2));

    expect(after.slot_pinned).toBe(false);
    assertOnlyChanged(before, after, ['slot_pinned', 'last_activity_at']);

    if (process.env.MC_SUPABASE_SERVICE_KEY) {
      await sbWrite(`tasks?id=eq.${id}`, { method: 'DELETE' });
    }
  });
});
