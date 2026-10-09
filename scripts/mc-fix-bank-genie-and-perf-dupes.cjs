/**
 * Fix: Bank Genie same-week dupe + Business Performance Review double-pin on Mon 12.
 * node scripts/mc-fix-bank-genie-and-perf-dupes.cjs
 * node scripts/mc-fix-bank-genie-and-perf-dupes.cjs --fix
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const FIX = process.argv.includes('--fix');
const BANK_ID = '02d10c2d-15bf-4684-8b1a-ff65aaa6cd3b';
const PERF_ID = '6ec9689d-5426-4276-9e17-824cb4ea4fc1';
const BANK_KEEP_EVENT = 'da6l4iohiuk17ibe3jf9mjrm70'; // Oct 5 ideal → Oct 14 pin
const BANK_ORPHAN_EVENT = 's9p81fnsn5he3gjtduf34n8moc'; // Oct 12 ghost
const PERF_EVENT = '6hbhrulqnomq1trce2k64jepdo';

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { events } = await fetchHorizonEvents('2026-10-01T00:00:00.000Z', '2026-11-15T00:00:00.000Z');
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  const bank = primary.filter((e) => /bank\s*genie/i.test(e.summary || ''));
  const perf = primary.filter((e) => /performance\s*review/i.test(e.summary || ''));

  console.log('Bank GCal:');
  for (const e of bank) console.log(' ', isoToLondonDate(e.start.dateTime), e.id, e.summary);
  console.log('Perf GCal:');
  for (const e of perf) console.log(' ', isoToLondonDate(e.start.dateTime), e.id, e.summary);

  const plan = { deleteGcal: [], retireLogs: [], rename: [] };

  // Bank: keep Oct-ideal pin event; delete any other Bank Genie in Oct 12–18 week
  for (const e of bank) {
    const day = isoToLondonDate(e.start.dateTime);
    if (e.id === BANK_KEEP_EVENT) continue;
    if (day >= '2026-10-12' && day <= '2026-10-18') {
      plan.deleteGcal.push({ id: e.id, day, reason: 'bank_same_week_orphan', summary: e.summary });
    } else if (e.id === BANK_ORPHAN_EVENT) {
      plan.deleteGcal.push({ id: e.id, day, reason: 'bank_orphan', summary: e.summary });
    }
  }
  // Also delete by known orphan id if still present
  if (!plan.deleteGcal.some((d) => d.id === BANK_ORPHAN_EVENT)
      && bank.some((e) => e.id === BANK_ORPHAN_EVENT)) {
    plan.deleteGcal.push({
      id: BANK_ORPHAN_EVENT, day: '2026-10-12', reason: 'bank_orphan', summary: 'Bank Genie',
    });
  }

  // Perf: retire obsolete ideal 2026-10-06 pin (same GCal as 2026-10-12 — causes double block)
  const perfLogs = await sb(
    `recurring_log?recurring_task_id=eq.${PERF_ID}&ideal_date=in.(2026-10-06,2026-10-12)`
      + '&select=id,ideal_date,scheduled_date,calendar_event_id,change,at&order=at.desc',
  ) || [];
  const latest = new Map();
  for (const l of perfLogs) {
    if (!latest.has(l.ideal_date)) latest.set(l.ideal_date, l);
  }
  const oldPin = latest.get('2026-10-06');
  if (oldPin && /^diary_pin:/i.test(oldPin.change || '')) {
    plan.retireLogs.push(oldPin);
  }

  // Rename any leftover SEO titles
  for (const e of perf) {
    if (/SEO\s*Performance/i.test(e.summary || '')) {
      plan.rename.push(e);
    }
  }

  // Same-day perf GCal dupes: keep PERF_EVENT
  const byDay = new Map();
  for (const e of perf) {
    const d = isoToLondonDate(e.start.dateTime);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  for (const [day, list] of byDay) {
    if (list.length <= 1) continue;
    const keep = list.find((e) => e.id === PERF_EVENT) || list[0];
    for (const e of list) {
      if (e.id === keep.id) continue;
      plan.deleteGcal.push({ id: e.id, day, reason: 'perf_dupe', summary: e.summary });
    }
  }

  console.log('\nPLAN', JSON.stringify(plan, null, 2));
  if (!FIX) {
    console.log('Dry-run only');
    return;
  }

  for (const l of plan.retireLogs) {
    await sb(`recurring_log?id=eq.${l.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `skipped occurrence ${l.ideal_date}: superseded_by_weekly_ideal`,
        roll_reason: 'dupe_pin_cleanup',
        calendar_event_id: null,
        at: new Date().toISOString(),
      },
    });
    console.log('retired log', l.ideal_date, l.id);
  }

  for (const d of plan.deleteGcal) {
    await deletePrimaryEvent(d.id);
    console.log('deleted gcal', d.day, d.id, d.reason);
    await sleep(80);
  }

  for (const e of plan.rename) {
    await patchPrimaryEvent(e.id, {
      summary: String(e.summary).replace(/SEO\s*Performance\s*Review/ig, 'Business Performance Review'),
    });
    console.log('renamed', e.id);
    await sleep(80);
  }

  // If Bank orphan had a log claiming it, clear
  const bankOrphanLogs = await sb(
    `recurring_log?recurring_task_id=eq.${BANK_ID}&calendar_event_id=eq.${BANK_ORPHAN_EVENT}`
      + '&select=id,ideal_date,change&order=at.desc&limit=5',
  ) || [];
  for (const l of bankOrphanLogs) {
    if (!/^diary_pin:/i.test(l.change || '')) continue;
    await sb(`recurring_log?id=eq.${l.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `skipped occurrence ${l.ideal_date}: bank_orphan_cleanup`,
        roll_reason: 'bank_dupe_cleanup',
        calendar_event_id: null,
        at: new Date().toISOString(),
      },
    });
    console.log('retired bank orphan log', l.ideal_date);
  }

  await sb('recurring_log', {
    method: 'POST',
    body: {
      recurring_task_id: BANK_ID,
      actor: 'cursor',
      change: `cleanup: removed same-week Bank Genie orphan; kept ${BANK_KEEP_EVENT}`,
    },
  });

  console.log('DONE');
}

main().catch((e) => { console.error(e); process.exit(1); });
