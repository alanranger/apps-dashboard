/**
 * Apply concrete pending task_bumps to tasks DB + push queue (one-shot).
 * Also re-bump soft tasks on rest/away days via placer helpers.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { ruleMapFromRows, bankHolidaySet, isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');
const {
  awaySpansFromTravelBlocks, restDaySpansFromWorkshopEvents, teachingDaySpansFromEvents,
  datedTasksToIntervals, findBlockedDayTaskBumps, findSoftOverlapBumps, mergeTaskBumps,
  placeBumpedTasks, buildBusyIntervals, londonYmdHmToUtcMs,
} = require('../api/mc/habit-placer-lib.js');
const { applyTaskBumpToDb } = require('../api/mc/habit-placer-propose-lib.js');
const { gcalConfigured, fetchHorizonEvents } = require('../api/mc/gcal-lib.js');

const FROM = '2026-08-01';
const TO = '2026-09-15';

async function applyPendingSummaries() {
  const pending = await sb(
    "pending_diary_changes?status=eq.pending&change_type=eq.task_bump&select=id,summary,related_id&order=detected_at.desc&limit=200",
  );
  const applied = [];
  for (const row of pending || []) {
    const m = String(row.summary || '').match(
      /Bump MC-(\d+)\s*→\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})–(\d{2}:\d{2})/,
    );
    if (!m) continue;
    const bump = {
      display_id: Number(m[1]),
      new_day: m[2],
      new_start: new Date(londonYmdHmToUtcMs(m[2], m[3])).toISOString(),
      new_end: new Date(londonYmdHmToUtcMs(m[2], m[4])).toISOString(),
      reason: 'pending_catchup',
    };
    if (await applyTaskBumpToDb(sb, bump)) {
      await sb(`pending_diary_changes?id=eq.${row.id}`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: {
          status: 'applied',
          resolved_at: new Date().toISOString(),
          resolved_by: 'task_bump_catchup',
        },
      });
      applied.push({ id: row.id, ...bump });
    }
  }
  return applied;
}

async function clearBlockedAndConflicts() {
  const rules = ruleMapFromRows(await sb('scheduling_rules?select=key,value'));
  const holidays = bankHolidaySet(2026, 2027);
  if (!gcalConfigured()) throw new Error('gcal required');
  const { events } = await fetchHorizonEvents(`${FROM}T00:00:00.000Z`, `${TO}T23:59:59.000Z`);
  const travel = await sb(
    'travel_blocks?select=block_type,starts_at,ends_at,venue_name,workshop_title,workshop_start,workshop_row_key'
    + '&block_type=in.(travel_out,travel_back)'
    + `&starts_at=gte.${FROM}T00:00:00Z&starts_at=lte.${TO}T23:59:59Z`,
  );
  const tasks = await sb(
    'tasks?select=display_id,title,state,slot_pinned,scheduled_start,scheduled_end,calendar_event_id,'
    + 'depends_on:depends_on_task_id(display_id)'
    + `&scheduled_start=gte.${FROM}T00:00:00Z&scheduled_start=lte.${TO}T23:59:59Z`
    + '&state=not.in.(done,verified,wont_do,superseded)',
  );
  const norm = (tasks || []).map((t) => ({
    ...t,
    depends_on_display_id: t.depends_on?.display_id ?? null,
  }));
  const soft = datedTasksToIntervals(norm, { pinnedOnly: false });
  const pinned = datedTasksToIntervals(norm, { pinnedOnly: true });
  const away = awaySpansFromTravelBlocks(travel || []);
  const rest = restDaySpansFromWorkshopEvents(events || [], rules);
  const teach = teachingDaySpansFromEvents(events || [], rules);
  const blocked = away.concat(rest).concat(teach);
  const hard = buildBusyIntervals(events || [], rules).concat(pinned).concat(blocked)
    .sort((a, b) => a.startMs - b.startMs);
  const bumpsRaw = mergeTaskBumps(
    findBlockedDayTaskBumps(soft, blocked),
    findSoftOverlapBumps(soft),
  );
  const { scheduled } = placeBumpedTasks(
    bumpsRaw, soft, hard, [], rules, holidays, FROM,
  );
  const applied = [];
  for (const b of scheduled) {
    if (await applyTaskBumpToDb(sb, b)) applied.push(b);
  }
  return { bumps_raw: bumpsRaw.length, scheduled: scheduled.length, applied };
}

const pendingApplied = await applyPendingSummaries();
const fresh = await clearBlockedAndConflicts();
const left = await sb(
  `tasks?scheduled_start=gte.2026-08-07T00:00:00Z&scheduled_start=lt.2026-08-08T00:00:00Z`
  + '&state=not.in.(done,verified,wont_do,superseded)&select=display_id,title,scheduled_start,state',
);
const out = {
  pending_applied: pendingApplied.length,
  pending_sample: pendingApplied.slice(0, 10),
  fresh,
  remaining_on_2026_08_07: left,
};
fs.writeFileSync(path.join(root, 'tmp/task-bump-catchup-LATEST.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
