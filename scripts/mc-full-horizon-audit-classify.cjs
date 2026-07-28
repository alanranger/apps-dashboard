/**
 * FULL-HORIZON liveable audit — REPORT ONLY, no writes.
 * Classifies each violation: BUG | RESCHEDULE | EXCEPTION
 *
 * node scripts/mc-full-horizon-audit-classify.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const OUT_JSON = path.join(
  'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude',
  'mc-full-horizon-audit-classify-LATEST.json',
);
const OUT_MD = path.join(
  'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude',
  'RESPONSE-2026-07-27-full-horizon-audit-classify-LATEST.md',
);

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { ruleMapFromRows, addDays, isoToLondonDate } = require('../api/mc/scheduling-rules-lib');
const { londonToday } = require('../api/mc/diary-lib');
const { validateLiveableDiary, isMcTitle } = require('../api/mc/liveable-diary-lib');
const { dayCapLimits } = require('../api/mc/habit-placer-lib');

function classify(v) {
  const rule = v.rule;
  if (rule === 'duplicate') {
    return { class: 'BUG', reason: 'Engine generated duplicate MC identity on Google' };
  }
  if (rule === 'travel_overlap' || rule === 'travel_orphan') {
    return { class: 'BUG', reason: 'Travel incoherence / orphan — logic fault' };
  }
  if (rule === 'overlap') {
    const a = String(v.a?.summary || '');
    const b = String(v.b?.summary || '');
    const aMc = isMcTitle(a);
    const bMc = isMcTitle(b);
    const real = (t) => !isMcTitle(t) && !/MC ⏳|MC 🚗|MC ⚽|REST|AWAY/i.test(t);
    if ((aMc && real(b)) || (bMc && real(a))) {
      const aFix = /MC\s*⚽/u.test(a) || a.includes('MC ⚽');
      const bFix = /MC\s*⚽/u.test(b) || b.includes('MC ⚽');
      if ((aFix && !bMc) || (bFix && !aMc)) {
        return { class: 'EXCEPTION', reason: 'Fixture buffer alongside existing non-MC — allowed' };
      }
      return { class: 'BUG', reason: 'MC placed over real/teaching/personal commitment' };
    }
    if (/Decompress|Prep —/i.test(a) || /Decompress|Prep —/i.test(b)) {
      return { class: 'BUG', reason: 'Buffer painted over another commitment' };
    }
    if (aMc && bMc) {
      return { class: 'BUG', reason: 'Two MC commitments overlap — placer/buffer failed gap' };
    }
    return { class: 'BUG', reason: 'Opaque commitments overlap' };
  }
  if (rule === 'blocked_day') {
    return { class: 'BUG', reason: 'MC work dated on rest/away/teaching blocked day' };
  }
  if (rule === 'after_hours') {
    return { class: 'RESCHEDULE', reason: 'In-window move under working hours (unless pinned → exception later)' };
  }
  if (rule === 'cap') {
    return { class: 'RESCHEDULE', reason: 'Day over hard cap — roll/unplace under normal placer' };
  }
  if (rule === 'missing_gcal_link') {
    return { class: 'BUG', reason: 'Placed in DB with no calendar_event_id' };
  }
  if (rule === 'stale_gcal_link') {
    return { class: 'BUG', reason: 'DB points at missing/wrong Google event' };
  }
  return { class: 'EXCEPTION', reason: 'Unclassified — needs Alan review' };
}

async function fetchChunked(fromYmd, toYmd) {
  const all = [];
  const health = [];
  let cursor = fromYmd;
  while (cursor < toYmd) {
    const next = addDays(cursor, 45);
    const end = next < toYmd ? next : toYmd;
    const { events, health: h, assessment } = await fetchHorizonEvents(
      `${cursor}T00:00:00.000Z`,
      `${end}T00:00:00.000Z`,
    );
    all.push(...(events || []));
    health.push({ from: cursor, to: end, assessment, per: h });
    cursor = end;
  }
  // Dedupe by id+calendar
  const seen = new Set();
  const deduped = [];
  for (const e of all) {
    const k = `${e._calendarId || 'primary'}|${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(e);
  }
  return { events: deduped, health };
}

async function missingLinks(fromYmd, toYmd) {
  const logs = await sb(
    `recurring_log?scheduled_date=gte.${fromYmd}&scheduled_date=lte.${toYmd}`
    + '&select=id,recurring_task_id,ideal_date,scheduled_date,calendar_event_id,change'
    + '&order=scheduled_date.asc&limit=5000',
  );
  const habits = await sb('recurring_tasks?select=id,title&active=eq.true');
  const habitMap = new Map((habits || []).map((h) => [h.id, h]));
  const out = [];
  const seen = new Set();
  for (const row of logs || []) {
    if (!row.scheduled_date) continue;
    if (/^skip|^unplaced/i.test(row.change || '')) continue;
    if (row.calendar_event_id) continue;
    const ideal = row.ideal_date || row.scheduled_date;
    const k = `${row.recurring_task_id}|${ideal}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      rule: 'missing_gcal_link',
      day: row.scheduled_date,
      summary: habitMap.get(row.recurring_task_id)?.title || row.recurring_task_id,
      ideal_date: ideal,
    });
  }
  return out;
}

function whatLabel(v) {
  if (v.rule === 'overlap') return `${v.a?.summary || '?'} × ${v.b?.summary || '?'}`;
  if (v.rule === 'duplicate') return `${v.summary} (×${v.count})`;
  if (v.rule === 'travel_overlap') {
    return `${v.a?.type} ${v.a?.venue} × ${v.b?.type} ${v.b?.venue}`;
  }
  if (v.rule === 'travel_orphan') return `${v.type} ${v.venue || v.id}`;
  return v.summary || v.rule;
}

async function main() {
  const today = londonToday();
  const toYmd = '2027-01-31';
  console.log('horizon', today, '→', toYmd);

  const [rules, travel, restDb, gcal, missing] = await Promise.all([
    sb('scheduling_rules?select=key,value'),
    sb(`travel_blocks?select=*&starts_at=gte.${today}T00:00:00.000Z&starts_at=lt.${toYmd}T00:00:00.000Z&order=starts_at.asc`),
    sb('rest_day_blocks?status=eq.active&select=rest_date,workshop_title'),
    fetchChunked(today, toYmd),
    missingLinks(today, toYmd),
  ]);
  const ruleMap = ruleMapFromRows(rules || []);
  const liveable = validateLiveableDiary({
    events: gcal.events || [],
    travelBlocks: travel || [],
    ruleMap,
    restDb: restDb || [],
    limit: null,
  });

  const raw = [...(liveable.violations || []), ...missing];
  const rows = raw.map((v) => {
    let day = v.day || '';
    if (!day && v.a?.start) day = isoToLondonDate(v.a.start) || String(v.a.start).slice(0, 10);
    const cls = classify(v);
    return {
      date: day,
      what: whatLabel(v).slice(0, 160),
      rule: v.rule,
      classification: cls.class,
      reason: cls.reason,
      detail: v,
    };
  });

  // Cap check (rough): MC timed minutes per London day from primary
  const { hard } = dayCapLimits(ruleMap);
  const dayMins = {};
  for (const e of gcal.events || []) {
    if ((e._calendarId || 'primary') !== 'primary') continue;
    if (!e.start?.dateTime || !isMcTitle(e.summary)) continue;
    if (/Travel |Decompress|Prep —|REST|AWAY|⚽/i.test(e.summary || '')) continue;
    const day = isoToLondonDate(e.start.dateTime);
    const mins = (Date.parse(e.end?.dateTime || e.start.dateTime) - Date.parse(e.start.dateTime)) / 60000;
    if (!day || !Number.isFinite(mins)) continue;
    dayMins[day] = (dayMins[day] || 0) + mins;
  }
  for (const [day, mins] of Object.entries(dayMins)) {
    if (mins <= hard) continue;
    rows.push({
      date: day,
      what: `MC work ${Math.round(mins)}m > hard cap ${hard}m`,
      rule: 'cap',
      classification: 'RESCHEDULE',
      reason: 'Day over hard cap — roll/unplace under normal placer',
      detail: { rule: 'cap', day, mins, hard },
    });
  }

  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.rule.localeCompare(b.rule));

  const totals = { BUG: 0, RESCHEDULE: 0, EXCEPTION: 0 };
  for (const r of rows) totals[r.classification] = (totals[r.classification] || 0) + 1;

  const byWeek = {};
  for (const r of rows) {
    if (!r.date || r.date.length < 10) continue;
    const d = new Date(`${r.date}T12:00:00Z`);
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = weekStart.toISOString().slice(0, 10);
    if (!byWeek[key]) byWeek[key] = { BUG: 0, RESCHEDULE: 0, EXCEPTION: 0, n: 0 };
    byWeek[key][r.classification] += 1;
    byWeek[key].n += 1;
  }

  const report = {
    generated_at: new Date().toISOString(),
    horizon: { from: today, to: toYmd },
    live_events: (gcal.events || []).length,
    travel_blocks: (travel || []).length,
    liveable_ok: liveable.ok,
    liveable_by_rule: liveable.by_rule,
    totals,
    by_week: byWeek,
    rows,
    fetch_health_chunks: gcal.health,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

  const lines = [];
  lines.push('---');
  lines.push('answers_question: 2026-07-27-full-horizon-audit-classify');
  lines.push('question_file: QUESTION-2026-07-27-full-horizon-audit-classify.md');
  lines.push('answered_by: cursor');
  lines.push(`answered_at: ${new Date().toISOString()}`);
  lines.push('status: complete');
  lines.push('repos: [apps-dashboard]');
  lines.push('---');
  lines.push('');
  lines.push('# RESPONSE — Full-horizon audit (REPORT ONLY, no fixes)');
  lines.push('');
  lines.push(`Horizon: **${today} → ${toYmd}** · Live events fetched: **${report.live_events}** · Travel rows: **${report.travel_blocks}**`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`| Class | Count |`);
  lines.push(`|---|---:|`);
  lines.push(`| BUG | ${totals.BUG} |`);
  lines.push(`| RESCHEDULE | ${totals.RESCHEDULE} |`);
  lines.push(`| EXCEPTION | ${totals.EXCEPTION} |`);
  lines.push(`| **All** | **${rows.length}** |`);
  lines.push('');
  lines.push('## Classification rules used');
  lines.push('- **BUG:** duplicates; MC over real/teaching; buffer over work; MC↔MC overlap; travel overlap/orphan; blocked-day MC work; missing GCal link');
  lines.push('- **RESCHEDULE:** after-hours (movable); day over hard cap');
  lines.push('- **EXCEPTION:** unclassified only (none expected in this pass unless new rules)');
  lines.push('');
  lines.push('## Issues table');
  lines.push('');
  lines.push('| Date | What | Rule | Class | Reason |');
  lines.push('|---|---|---|---|---|');
  for (const r of rows) {
    const what = String(r.what).replace(/\|/g, '/').replace(/\n/g, ' ');
    lines.push(`| ${r.date || '—'} | ${what.slice(0, 100)} | ${r.rule} | **${r.classification}** | ${r.reason} |`);
  }
  lines.push('');
  lines.push('## Artifact');
  lines.push(`Full JSON: \`mc-full-horizon-audit-classify-LATEST.json\` (${rows.length} rows).`);
  lines.push('');
  lines.push('**No DB/Google writes in this pass.**');
  fs.writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
  console.log('Wrote', OUT_JSON);
  console.log('Wrote', OUT_MD);
  console.log('totals', totals, 'rows', rows.length);
}

main().catch((e) => { console.error(e); process.exit(1); });
