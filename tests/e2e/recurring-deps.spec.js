import { test, expect } from '@playwright/test';
import {
  mcLogin, mcApi, sbWrite, sbGet, mcBaseUrl,
} from '../helpers/mc.mjs';

test.describe.configure({ mode: 'serial' });

async function createHabit(token, title, rrule = 'FREQ=WEEKLY;BYDAY=MO') {
  const data = await mcApi('/api/mc/recurring', {
    token,
    method: 'POST',
    body: {
      title,
      cadence_text: 'Weekly test',
      rrule,
      duration_min: 15,
      actor: 'cursor',
    },
  });
  return data.task.id;
}

async function depsForHabit(habitId) {
  const rows = await sbGet(`recurring_task_deps?habit_id=eq.${habitId}&select=id,dep_type,within_hours,depends_on_habit_id`);
  return rows;
}

async function fetchProjection() {
  const res = await fetch(`${mcBaseUrl()}/api/mc/habit-projection.json?days=90`);
  return res.json();
}

test.describe('Recurring deps — API validation + projection', () => {
  test.skip(!process.env.MC_SUPABASE_SERVICE_KEY, 'requires MC_SUPABASE_SERVICE_KEY');

  let token;
  let blockerId;
  let dependentId;
  let depId;

  test.beforeAll(async () => {
    ({ token } = await mcLogin('agent'));
    blockerId = await createHabit(token, 'TEST dep blocker (auto)');
    dependentId = await createHabit(token, 'TEST dep dependent (auto)');
  });

  test.afterAll(async () => {
    if (blockerId) await sbWrite(`recurring_tasks?id=eq.${blockerId}`, { method: 'DELETE' });
    if (dependentId) await sbWrite(`recurring_tasks?id=eq.${dependentId}`, { method: 'DELETE' });
  });

  test('rejects within_hours without a value', async () => {
    let err;
    try {
      await mcApi('/api/mc/recurring-deps', {
        token,
        method: 'POST',
        body: {
          habit_id: dependentId,
          depends_on_habit_id: blockerId,
          dep_type: 'within_hours',
          actor: 'cursor',
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(400);
    expect(String(err?.message)).toMatch(/within_hours/i);
  });

  test('adding must_complete_first persists', async () => {
    const before = await depsForHabit(dependentId);
    const created = await mcApi('/api/mc/recurring-deps', {
      token,
      method: 'POST',
      body: {
        habit_id: dependentId,
        depends_on_habit_id: blockerId,
        dep_type: 'must_complete_first',
        actor: 'cursor',
      },
    });
    depId = created.dep.id;
    const after = await depsForHabit(dependentId);
    console.log('DEP ADD EVIDENCE', JSON.stringify({ before_count: before.length, after_count: after.length, dep: created.dep }, null, 2));
    expect(after.length).toBe(before.length + 1);
    expect(created.dep.dep_type).toBe('must_complete_first');
  });

  test('rejects cycle A→B→A', async () => {
    let err;
    try {
      await mcApi('/api/mc/recurring-deps', {
        token,
        method: 'POST',
        body: {
          habit_id: blockerId,
          depends_on_habit_id: dependentId,
          dep_type: 'must_complete_first',
          actor: 'cursor',
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err?.status).toBe(400);
    expect(String(err?.message)).toMatch(/cycle/i);
  });

  test('dependent occurrence blocked until blocker marked done', async () => {
    const projBefore = await fetchProjection();
    const sample = (projBefore.occurrences || []).find((o) => o.habit_id === dependentId);
    expect(sample).toBeTruthy();
    expect(sample.blocked).toBe(true);
    expect(sample.blocked_by.some((b) => !b.satisfied)).toBe(true);

    await mcApi('/api/mc/recurring', {
      token,
      method: 'POST',
      body: { action: 'mark_done', id: blockerId, actor: 'cursor' },
    });

    const projAfter = await fetchProjection();
    const sampleAfter = (projAfter.occurrences || []).find((o) => o.habit_id === dependentId);
    console.log('BLOCKER EVIDENCE', JSON.stringify({
      before: { blocked: sample.blocked, blocked_by: sample.blocked_by },
      after: { blocked: sampleAfter.blocked, blocked_by: sampleAfter.blocked_by },
    }, null, 2));
    expect(sampleAfter.blocked).toBe(false);
  });

  test('within_hours window blocks occurrence outside 24h', async () => {
    await mcApi('/api/mc/recurring-deps', {
      token,
      method: 'POST',
      body: { action: 'delete', id: depId, actor: 'cursor' },
    });
    const created = await mcApi('/api/mc/recurring-deps', {
      token,
      method: 'POST',
      body: {
        habit_id: dependentId,
        depends_on_habit_id: blockerId,
        dep_type: 'within_hours',
        within_hours: 24,
        actor: 'cursor',
      },
    });
    depId = created.dep.id;

    const today = new Date().toISOString().slice(0, 10);
    await sbWrite(`recurring_tasks?id=eq.${blockerId}`, {
      method: 'PATCH',
      body: { last_done: today },
    });

    const proj = await fetchProjection();
    const sameDay = (proj.occurrences || []).find(
      (o) => o.habit_id === dependentId && o.ideal_date === today,
    );
    const farFuture = (proj.occurrences || []).slice(-1).find((o) => o.habit_id === dependentId);
    console.log('WITHIN_HOURS EVIDENCE', JSON.stringify({
      same_day: sameDay ? { ideal_date: sameDay.ideal_date, blocked: sameDay.blocked } : null,
      far: farFuture ? { ideal_date: farFuture.ideal_date, blocked: farFuture.blocked } : null,
    }, null, 2));
    if (sameDay) expect(sameDay.blocked).toBe(false);
    if (farFuture && farFuture.ideal_date > today) expect(farFuture.blocked).toBe(true);
  });

  test('removing dependency frees dependent habit', async () => {
    const before = await depsForHabit(dependentId);
    await mcApi('/api/mc/recurring-deps', {
      token,
      method: 'POST',
      body: { action: 'delete', id: depId, actor: 'cursor' },
    });
    depId = null;
    const after = await depsForHabit(dependentId);
    const proj = await fetchProjection();
    const sample = (proj.occurrences || []).find((o) => o.habit_id === dependentId);
    console.log('DEP REMOVE EVIDENCE', JSON.stringify({
      before_count: before.length,
      after_count: after.length,
      blocked: sample?.blocked,
      blocked_by: sample?.blocked_by,
    }, null, 2));
    expect(after.length).toBe(before.length - 1);
    expect(sample?.blocked).toBe(false);
    expect(sample?.blocked_by?.length ?? 0).toBe(0);
  });
});

test.describe('Recurring deps — UI add persists', () => {
  test.skip(!process.env.MC_ALAN_PASSWORD || !process.env.MC_SUPABASE_SERVICE_KEY, 'requires Alan login + Supabase');

  test('Recurring tab + dep modal writes one new edge', async ({ page }) => {
    const { token } = await mcLogin('agent');
    const blockerId = await createHabit(token, 'TEST UI dep blocker (auto)');
    const dependentId = await createHabit(token, 'TEST UI dep dependent (auto)');
    const before = await depsForHabit(dependentId);

    const base = mcBaseUrl();
    await page.goto(`${base}/mission-control.html`);
    await page.fill('#pw', process.env.MC_ALAN_PASSWORD);
    await page.click('#loginBtn');
    await page.waitForSelector('.view-btn[data-view="recurring"]');
    await page.click('.view-btn[data-view="recurring"]');
    await page.locator(`[data-dep-add="${dependentId}"]`).click();
    await page.selectOption('#depBlocker', blockerId);
    await page.selectOption('#depType', 'must_complete_first');
    await page.click('#depSave');
    await page.waitForTimeout(1500);

    const after = await depsForHabit(dependentId);
    console.log('UI DEP EVIDENCE', JSON.stringify({ before: before.length, after: after.length }, null, 2));
    expect(after.length).toBe(before.length + 1);

    for (const id of [dependentId, blockerId]) {
      await sbWrite(`recurring_tasks?id=eq.${id}`, { method: 'DELETE' });
    }
  });
});
