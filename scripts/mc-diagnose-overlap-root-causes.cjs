/**
 * Horizon overlap + capacity diagnosis.
 * node scripts/mc-diagnose-overlap-root-causes.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { ruleMapFromRows, isoToLondonDate, isoToLondonMinutes, workingWindow, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { dayCapLimits, requiredGapMins } = require('../api/mc/habit-placer-lib');

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function isMcWork(t) {
  const s = String(t || '');
  if (/Decompress|Prep —|Travel |AWAY|REST|⚽|⏰/i.test(s)) return false;
  return /^MC\b/i.test(s) || /^P\d\s*·\s*MC-/i.test(s);
}

function isBuffer(t) {
  return /Decompress|Prep —/i.test(String(t || ''));
}

(async () => {
  const today = londonToday();
  const to = addDays(today, 180);
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const cap = dayCapLimits(ruleMap);
  const winMon = workingWindow(ruleMap, '2026-08-03'); // weekday sample
  console.log('=== RULES ===');
  console.log({
    daily_task_cap_min: ruleMap.daily_task_cap_min,
    daily_task_cap_tolerance_min: ruleMap.daily_task_cap_tolerance_min,
    dayCap: cap,
    work_start: ruleMap.work_start || ruleMap.working_day_start,
    work_end: ruleMap.work_end || ruleMap.working_day_end,
    weekday_window_sample: winMon,
    decompress_after_task_min: ruleMap.decompress_after_task_min,
    admin_gap_min: ruleMap.admin_gap_min,
  });
  const interesting = [
    'daily_task_cap_min', 'daily_task_cap_tolerance_min', 'working_day_start', 'working_day_end',
    'work_start', 'work_end', 'decompress_after_task_min', 'admin_gap_min', 'buffer_scope',
  ];
  for (const r of rules || []) {
    if (interesting.includes(r.key) || /cap|work|decompress|gap|window/i.test(r.key)) {
      console.log('rule', r.key, '=', String(r.value).slice(0, 80));
    }
  }

  const { events } = await fetchHorizonEvents(`${today}T00:00:00.000Z`, `${to}T23:59:59.000Z`);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  const byDay = new Map();
  for (const e of primary) {
    const d = isoToLondonDate(e.start.dateTime);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }

  let mcMc = 0;
  let decompOverWork = 0;
  let afterHours = 0;
  let overCapDays = 0;
  const mcMcSamples = [];
  const decompSamples = [];
  const afterHoursSamples = [];
  const overCapSamples = [];

  for (const [day, list] of [...byDay.entries()].sort()) {
    const win = workingWindow(ruleMap, day);
    const work = list.filter((e) => isMcWork(e.summary));
    const buffs = list.filter((e) => isBuffer(e.summary));

    // MC work minutes toward cap (habits+tasks, not buffers/travel)
    let used = 0;
    for (const e of work) {
      const s = isoToLondonMinutes(e.start.dateTime);
      const en = isoToLondonMinutes(e.end?.dateTime || e.start.dateTime);
      if (s == null || en == null) continue;
      used += Math.max(0, en - s);
      if (s < win.start_min || en > win.end_min) {
        afterHours += 1;
        if (afterHoursSamples.length < 12) {
          afterHoursSamples.push(`${day} ${e.summary.slice(0, 50)} ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}-${String(Math.floor(en / 60)).padStart(2, '0')}:${String(en % 60).padStart(2, '0')} win=${win.start_min}-${win.end_min}`);
        }
      }
    }
    if (used > cap.hard) {
      overCapDays += 1;
      if (overCapSamples.length < 12) overCapSamples.push(`${day} used=${used} hard=${cap.hard}`);
    }

    for (let i = 0; i < work.length; i += 1) {
      const a = work[i];
      const a0 = Date.parse(a.start.dateTime);
      const a1 = Date.parse(a.end?.dateTime || a.start.dateTime);
      for (let j = i + 1; j < work.length; j += 1) {
        const b = work[j];
        const b0 = Date.parse(b.start.dateTime);
        const b1 = Date.parse(b.end?.dateTime || b.start.dateTime);
        if (!overlaps(a0, a1, b0, b1)) continue;
        mcMc += 1;
        if (mcMcSamples.length < 20) {
          mcMcSamples.push(`${day} ${(a.summary || '').slice(0, 40)} × ${(b.summary || '').slice(0, 40)}`);
        }
      }
    }

    for (const d of buffs) {
      if (!/Decompress/i.test(d.summary || '')) continue;
      const d0 = Date.parse(d.start.dateTime);
      const d1 = Date.parse(d.end?.dateTime || d.start.dateTime);
      for (const w of work) {
        const w0 = Date.parse(w.start.dateTime);
        const w1 = Date.parse(w.end?.dateTime || w.start.dateTime);
        if (!overlaps(d0, d1, w0, w1)) continue;
        decompOverWork += 1;
        if (decompSamples.length < 15) {
          decompSamples.push(`${day} ${(d.summary || '').slice(0, 40)} × ${(w.summary || '').slice(0, 40)}`);
        }
      }
    }
  }

  // Stuck unplaced
  const logs = await sb(
    `recurring_log?ideal_date=gte.${today}&ideal_date=lte.${to}`
    + '&select=scheduled_date,calendar_event_id,change&limit=5000',
  );
  let stuck = 0;
  for (const r of logs || []) {
    if (r.calendar_event_id) continue;
    if (!r.scheduled_date || /^unplaced/i.test(r.change || '')) stuck += 1;
  }

  console.log('\n=== HORIZON COUNTS', today, '→', to, '===');
  console.log({
    primary_timed: primary.length,
    days: byDay.size,
    mc_mc_overlap_pairs: mcMc,
    decompress_over_mc_work: decompOverWork,
    mc_work_after_hours_blocks: afterHours,
    days_over_hard_cap: overCapDays,
    stuck_unplaced_logs: stuck,
  });
  console.log('\nMC×MC samples');
  for (const s of mcMcSamples) console.log(' ', s);
  console.log('\nDecomp×work samples');
  for (const s of decompSamples) console.log(' ', s);
  console.log('\nAfter-hours samples');
  for (const s of afterHoursSamples) console.log(' ', s);
  console.log('\nOver-cap samples');
  for (const s of overCapSamples) console.log(' ', s);
})().catch((e) => { console.error(e); process.exit(1); });
