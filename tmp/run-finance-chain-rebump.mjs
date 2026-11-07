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
const {
  ruleMapFromRows, bankHolidaySet, isoToLondonDate, isoToLondonMinutes,
  isSchedulableDay, workingWindow,
} = require('../api/mc/scheduling-rules-lib.js');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib.js');
const { buildBusyIntervals, londonYmdHmToUtcMs } = require('../api/mc/habit-placer-lib.js');

const LAST_DAY = '2026-07-30'; // away starts 31 Jul
const FROM = '2026-07-29';
const GAP = 15;
const ORDER = [21, 23, 22]; // blocker → clear-down → card (Claude chain order)

function hm(iso) {
  const m = isoToLondonMinutes(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function hmLabel(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

const rulesRows = await sb('scheduling_rules?select=key,value');
const ruleMap = ruleMapFromRows(rulesRows);
const holidays = bankHolidaySet(2026, 2026);

const { events, health } = await fetchHorizonEvents(`${FROM}T00:00:00Z`, `${LAST_DAY}T23:59:59Z`);
const primary = (health || []).find((h) => h.id === 'primary');
if (!primary?.ok || !(primary.count > 0)) throw new Error('primary calendar fault');

const taskRows = await sb(
  'tasks?select=display_id,title,scheduled_start,scheduled_end,calendar_event_id,'
  + 'depends_on:depends_on_task_id(display_id)&display_id=in.(21,22,23)',
);
const byId = new Map((taskRows || []).map((t) => [Number(t.display_id), t]));
const chainEventIds = new Set([...byId.values()].map((t) => t.calendar_event_id).filter(Boolean));

const clientBusy = buildBusyIntervals(events, ruleMap);
const mcBusy = [];
for (const e of events || []) {
  if ((e._calendarId || e.calendarId || 'primary') !== 'primary') continue;
  if (chainEventIds.has(e.id)) continue;
  if (!e.start?.dateTime) continue;
  mcBusy.push({
    startMs: Date.parse(e.start.dateTime),
    endMs: Date.parse(e.end?.dateTime || e.start.dateTime),
    summary: e.summary || 'MC',
  });
}
const hardBusy = clientBusy.concat(mcBusy);

function overlapsBusy(startMs, endMs, extra) {
  const all = hardBusy.concat(extra || []);
  return all.some((b) => startMs < b.endMs && b.startMs < endMs);
}

function packDay(day) {
  const win = workingWindow(ruleMap, day);
  const durs = ORDER.map((id) => {
    const t = byId.get(id);
    return Math.max(15, Math.round((Date.parse(t.scheduled_end) - Date.parse(t.scheduled_start)) / 60000));
  });
  const need = durs.reduce((a, b) => a + b, 0) + GAP * (ORDER.length - 1);
  if (win.end_min - win.start_min < need) return null;

  for (let cursor = win.start_min; cursor + need <= win.end_min; cursor += 15) {
    const slots = [];
    const extra = [];
    let m = cursor;
    let ok = true;
    for (let i = 0; i < ORDER.length; i += 1) {
      const id = ORDER[i];
      const dur = durs[i];
      if (m + dur > win.end_min) { ok = false; break; }
      const startMs = londonYmdHmToUtcMs(day, hmLabel(m));
      const endMs = londonYmdHmToUtcMs(day, hmLabel(m + dur));
      if (overlapsBusy(startMs, endMs, extra)) { ok = false; break; }
      const t = byId.get(id);
      slots.push({
        display_id: id,
        title: t.title,
        calendar_event_id: t.calendar_event_id,
        depends_on_display_id: t.depends_on?.display_id ?? null,
        old_start: t.scheduled_start,
        old_end: t.scheduled_end,
        new_day: day,
        new_start: new Date(startMs).toISOString(),
        new_end: new Date(endMs).toISOString(),
        duration_min: dur,
      });
      extra.push({ startMs, endMs });
      m += dur + GAP;
    }
    if (ok) return slots;
  }
  return null;
}

let scheduled = null;
let dayUsed = null;
for (const day of [LAST_DAY, FROM]) {
  if (!isSchedulableDay(day, ruleMap, holidays)) continue;
  scheduled = packDay(day);
  if (scheduled) { dayUsed = day; break; }
}

const out = {
  ok: !!scheduled,
  cutoff: LAST_DAY,
  challenge: 'Away 31 Jul–6 Aug → last working day for finance chain = Thu 30 Jul (Fri 31 Jul is away — do not place MC-23 there).',
  packed_day: dayUsed,
  calendar_writes: 0,
  scheduled: (scheduled || []).map((s) => ({
    ...s,
    old_london: `${isoToLondonDate(s.old_start)} ${hm(s.old_start)}–${hm(s.old_end)}`,
    new_london: `${s.new_day} ${hm(s.new_start)}–${hm(s.new_end)}`,
    moves: !(isoToLondonDate(s.old_start) === s.new_day
      && hm(s.old_start) === hm(s.new_start)
      && hm(s.old_end) === hm(s.new_end)),
  })),
};

console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(root, 'tmp/finance-chain-rebump.json'), JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
