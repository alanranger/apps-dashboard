/**
 * Audit Bank Genie + Performance Review on a target week.
 * node scripts/mc-audit-bank-genie-week.cjs
 * node scripts/mc-audit-bank-genie-week.cjs --fix
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const FIX = process.argv.includes('--fix');
const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { idealsInHorizon } = require('../api/mc/rrule-core');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const today = londonToday();
  const from = '2026-10-10';
  const to = '2026-10-20';
  const { events } = await fetchHorizonEvents(`${from}T00:00:00.000Z`, `${to}T23:59:59.000Z`);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  const bank = primary.filter((e) => /bank\s*genie|monthly\s*accounts/i.test(e.summary || ''));
  const perf = primary.filter((e) => /performance\s*review/i.test(e.summary || ''));

  console.log('=== GCal Bank Genie / Monthly Accounts ===');
  for (const e of bank.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.id, e.summary);
  }
  console.log('=== GCal Performance Review ===');
  for (const e of perf.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.id, e.summary);
  }

  const habits = await sb(
    'recurring_tasks?select=id,title,rrule,duration_min,ideal_time,active'
      + '&or=(title.ilike.*Bank*Genie*,title.ilike.*Performance*Review*)&active=eq.true',
  ) || [];
  console.log('\n=== Habits ===');
  for (const h of habits) {
    const ideals = idealsInHorizon(h.rrule, today, addDaysYmd(today, 90), 40);
    console.log(h.id, h.title, h.rrule, 'ideals', ideals.slice(0, 8));
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${h.id}&ideal_date=gte.2026-09-01&ideal_date=lte.2026-11-30`
        + '&select=id,ideal_date,scheduled_date,calendar_event_id,change,roll_reason,at&order=at.desc&limit=40',
    ) || [];
    const latest = new Map();
    for (const l of logs) {
      if (!l.ideal_date || latest.has(l.ideal_date)) continue;
      latest.set(l.ideal_date, l);
    }
    for (const [ideal, l] of [...latest.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(' ', ideal, '->', l.scheduled_date, (l.change || '').slice(0, 70), l.calendar_event_id || '');
    }
  }

  // Bank Genie: keep one per occurrence ideal; if two in same week, keep correct ideal day, delete other
  const bankHabit = habits.find((h) => /bank\s*genie/i.test(h.title));
  if (!bankHabit) {
    console.log('No bank genie habit');
    return;
  }
  const keepIdeals = new Set(idealsInHorizon(bankHabit.rrule, today, addDaysYmd(today, 120), 40) || []);
  console.log('\nBank keep ideals near Oct:', [...keepIdeals].filter((d) => d >= '2026-10-01' && d <= '2026-10-31'));

  const weekEvents = bank.filter((e) => {
    const d = isoToLondonDate(e.start.dateTime);
    return d >= '2026-10-12' && d <= '2026-10-18';
  }).sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));

  console.log('\nWeek Bank events:', weekEvents.length);
  const plan = { delete: [], rename: [], retire: [] };

  if (weekEvents.length > 1) {
    // Prefer event whose day is a keep ideal; else earliest
    let keep = weekEvents.find((e) => keepIdeals.has(isoToLondonDate(e.start.dateTime))) || weekEvents[0];
    for (const e of weekEvents) {
      if (e.id === keep.id) continue;
      plan.delete.push({ id: e.id, day: isoToLondonDate(e.start.dateTime), summary: e.summary, reason: 'same_week_dupe' });
    }
    console.log('Keep Bank', isoToLondonDate(keep.start.dateTime), keep.id, keep.summary);
  }

  // Also list any bank events not on keep ideals in Oct-Nov
  for (const e of bank) {
    const day = isoToLondonDate(e.start.dateTime);
    if (day < today) continue;
    if (keepIdeals.has(day)) continue;
    if (plan.delete.some((d) => d.id === e.id)) continue;
    // scheduled_date may differ from ideal — check logs
    const tied = await sb(
      `recurring_log?recurring_task_id=eq.${bankHabit.id}&calendar_event_id=eq.${e.id}`
        + '&select=id,ideal_date,scheduled_date,change&order=at.desc&limit=3',
    ) || [];
    const pin = tied[0];
    if (pin && keepIdeals.has(pin.ideal_date) && isPin(pin.change)) {
      console.log('Bank event on', day, 'tied to keep ideal', pin.ideal_date, '— OK');
      continue;
    }
    if (pin && isPin(pin.change) && !keepIdeals.has(pin.ideal_date)) {
      plan.delete.push({ id: e.id, day, summary: e.summary, reason: `wrong_phase ${pin.ideal_date}` });
      plan.retire.push(pin);
    }
  }

  // Performance review: anything still SEO titled
  for (const e of perf) {
    if (/SEO\s*Performance/i.test(e.summary || '')) {
      plan.rename.push(e);
    }
  }
  // Same-day perf dupes
  const perfByDay = new Map();
  for (const e of perf) {
    const d = isoToLondonDate(e.start.dateTime);
    if (!perfByDay.has(d)) perfByDay.set(d, []);
    perfByDay.get(d).push(e);
  }
  for (const [day, list] of perfByDay) {
    if (list.length <= 1) continue;
    list.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
    for (const extra of list.slice(1)) {
      if (!plan.delete.some((d) => d.id === extra.id)) {
        plan.delete.push({ id: extra.id, day, summary: extra.summary, reason: 'perf_same_day_dupe' });
      }
    }
  }

  console.log('\n=== PLAN ===');
  console.log(JSON.stringify(plan, null, 2));
  if (!FIX) {
    console.log('Dry-run. Re-run with --fix');
    return;
  }

  for (const pin of plan.retire) {
    await sb(`recurring_log?id=eq.${pin.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: {
        change: `skipped occurrence ${pin.ideal_date}: bank_dupe_cleanup`,
        roll_reason: 'bank_dupe_cleanup',
        calendar_event_id: null,
        at: new Date().toISOString(),
      },
    });
  }
  for (const d of plan.delete) {
    await deletePrimaryEvent(d.id);
    console.log('deleted', d.day, d.id, d.reason);
    await sleep(80);
  }
  for (const e of plan.rename) {
    await patchPrimaryEvent(e.id, { summary: e.summary.replace(/SEO\s*Performance\s*Review/i, 'Business Performance Review') });
    console.log('renamed', e.id);
    await sleep(80);
  }
  console.log('DONE');
}

function isPin(change) {
  return /^diary_pin:/i.test(String(change || ''));
}

main().catch((e) => { console.error(e); process.exit(1); });
