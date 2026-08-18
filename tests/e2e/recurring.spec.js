import { test, expect } from '@playwright/test';
import {
  mcLogin, mcApi, recurringSnapshot, pickRow, requireEnv, sbWrite,
} from '../helpers/mc.mjs';

const COLS = ['last_done', 'rolls_used', 'scheduled_note'];

test.describe.configure({ mode: 'serial' });

test.describe('Recurring — Skip (API + DB evidence)', () => {
  test.skip(!process.env.MC_SUPABASE_SERVICE_KEY, 'requires MC_SUPABASE_SERVICE_KEY');

  test('skip does not write last_done; logs ideal occurrence date', async () => {
    const { token } = await mcLogin('agent');
    // Use YESTERDAY's weekday so the most-recent RRULE occurrence is strictly
    // before today. Otherwise (e.g. skipping a weekly-Thursday habit ON a
    // Thursday) the true occurrence date legitimately equals today, and the
    // "occurrence date, not click date" guard on line ~51 cannot discriminate
    // the Skip bug from correct behaviour.
    const yday = new Date();
    yday.setUTCDate(yday.getUTCDate() - 1);
    const bydayCode = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][yday.getUTCDay()];
    const created = await mcApi('/api/mc/recurring', {
      token,
      method: 'POST',
      body: {
        title: 'TEST skip habit (auto)',
        cadence_text: `Weekly test (${bydayCode})`,
        rrule: `FREQ=WEEKLY;BYDAY=${bydayCode}`,
        duration_min: 15,
        ideal_time: '09:00',
        actor: 'cursor',
      },
    });
    const id = created.task.id;

    const before = await recurringSnapshot(id);
    const beforeLastDone = before.task.last_done;
    const beforeRolls = before.task.rolls_used;

    await mcApi('/api/mc/recurring', {
      token,
      method: 'POST',
      body: { action: 'skip', id, reason: 'test skip — not done', actor: 'cursor' },
    });

    const after = await recurringSnapshot(id);
    const evidence = {
      before: pickRow(before.task, COLS),
      after: pickRow(after.task, COLS),
      new_log: after.recent_log[0],
    };
    console.log('SKIP EVIDENCE', JSON.stringify(evidence, null, 2));

    expect(after.task.last_done).toBe(beforeLastDone);
    expect(after.task.rolls_used).toBe(beforeRolls);
    expect(String(after.recent_log[0].change)).toMatch(/^skipped occurrence \d{4}-\d{2}-\d{2}:/);
    expect(after.recent_log[0].ideal_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(after.recent_log[0].ideal_date).not.toBe(new Date().toISOString().slice(0, 10));

    // Delete the throwaway habit (cascade removes its recurring_log rows) so the
    // suite leaves nothing behind — deactivating was leaving residue.
    await sbWrite(`recurring_tasks?id=eq.${id}`, { method: 'DELETE' });
  });
});

test.describe('Recurring — Mark done (API + DB evidence)', () => {
  test.skip(!process.env.MC_SUPABASE_SERVICE_KEY, 'requires MC_SUPABASE_SERVICE_KEY');

  test('mark done sets last_done only; rolls unchanged unless reset by UI path', async () => {
    const { token } = await mcLogin('agent');
    const created = await mcApi('/api/mc/recurring', {
      token,
      method: 'POST',
      body: {
        title: 'TEST mark-done habit (auto)',
        cadence_text: 'Every Friday',
        rrule: 'FREQ=WEEKLY;BYDAY=FR',
        duration_min: 15,
        actor: 'cursor',
      },
    });
    const id = created.task.id;
    const before = await recurringSnapshot(id);
    const rollsBefore = before.task.rolls_used;

    await mcApi('/api/mc/recurring', {
      token,
      method: 'POST',
      body: { action: 'mark_done', id, actor: 'cursor' },
    });

    const after = await recurringSnapshot(id);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    console.log('MARK-DONE EVIDENCE', JSON.stringify({
      before: pickRow(before.task, COLS),
      after: pickRow(after.task, COLS),
      new_log: after.recent_log[0],
    }, null, 2));

    expect(after.task.last_done).toBe(today);
    expect(after.task.rolls_used).toBe(0);
    expect(after.recent_log[0].change).toMatch(/^completed |^marked done/);

    // Delete the throwaway habit (cascade removes its recurring_log rows).
    await sbWrite(`recurring_tasks?id=eq.${id}`, { method: 'DELETE' });
  });
});

test.describe('Recurring — Skip UI chip', () => {
  test.skip(!process.env.MC_ALAN_PASSWORD, 'requires Alan login for UI');

  test('clicking Skip shows skipped pill in table', async ({ page }) => {
    const base = process.env.MC_BASE_URL || 'https://apps-dashboard-lilac.vercel.app';
    await page.goto(`${base}/mission-control.html`);
    await page.fill('#pw', requireEnv('MC_ALAN_PASSWORD'));
    await page.click('#loginBtn');
    await page.waitForSelector('.view-btn[data-view="recurring"]');
    await page.click('.view-btn[data-view="recurring"]');

    page.once('dialog', (d) => d.accept('playwright ui skip test'));
    const skipBtn = page.locator('[data-rec-skip]').first();
    test.skip(await skipBtn.count() === 0, 'no habits to skip');
    await skipBtn.click();
    await expect(page.locator('.rec-skipped-pill').first()).toBeVisible({ timeout: 10000 });
  });
});
