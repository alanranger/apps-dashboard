/**
 * Independent MC ↔ Supabase ↔ Google Calendar verification (read-only).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outbox =
  'C:/Users/alan/Google Drive/Claude shared resources/Cursor Outputs for Claude';

function loadJson(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  // PowerShell-escaped array dump: [{"..."}] with backslashes
  if (t.includes('\\"')) {
    try {
      return JSON.parse(JSON.parse('"' + t.replace(/\r?\n/g, '\\n') + '"'));
    } catch {
      t = t.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  const m = t.match(/\[[\s\S]*\]/);
  if (m) return JSON.parse(m[0]);
  return JSON.parse(t);
}

function loadGcal(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j.events || j;
}

const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, 'verify-tasks.json'), 'utf8'));
const log = JSON.parse(fs.readFileSync(path.join(__dirname, 'verify-log-clean.json'), 'utf8'));

const g1 = loadGcal(path.join(__dirname, 'verify-gcal-jul-oct.json'));
const g2 = loadGcal(path.join(__dirname, 'verify-gcal-oct-jan.json'));
const byId = new Map();
for (const e of [...g1, ...g2]) {
  if (e && e.id) byId.set(e.id, e);
  // also store base id without _YYYYMMDD recurrence suffix
  if (e && e.id && e.id.includes('_')) {
    const base = e.id.split('_')[0];
    if (!byId.has(base)) byId.set(base, e);
  }
}

function findEvent(id) {
  if (!id) return null;
  if (byId.has(id)) return byId.get(id);
  // google sometimes returns with @google.com suffix in links only
  for (const [k, v] of byId) {
    if (k === id || k.startsWith(id) || id.startsWith(k)) return v;
  }
  return null;
}

function londonParts(iso) {
  // scheduled_start like 2026-07-25 10:00:00+00
  let s = String(iso).trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  s = s.replace(/\+00$/, '+00:00').replace(/Z$/, '+00:00');
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error('bad date ' + iso);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function eventStartParts(e) {
  const s = e.start?.dateTime || e.start?.date;
  if (!s) return { date: null, time: null };
  if (s.length === 10) return { date: s, time: '00:00' };
  return londonParts(s);
}

const mcEvents = [...byId.values()].filter((e) => {
  const s = e.summary || '';
  return /^MC\b/i.test(s) || s.startsWith('MC ');
});
// dedupe by id
const mcUnique = [];
const seen = new Set();
for (const e of [...g1, ...g2]) {
  if (!e?.id || seen.has(e.id)) continue;
  seen.add(e.id);
  if (/^MC\b/i.test(e.summary || '')) mcUnique.push(e);
}

const taskResults = [];
const taskMissing = [];
const taskMismatch = [];
for (const t of tasks) {
  const ev = findEvent(t.calendar_event_id);
  const db = londonParts(t.scheduled_start);
  const dbEnd = londonParts(t.scheduled_end);
  if (!ev) {
    taskMissing.push({ ...t, dbDate: db.date, dbStart: db.time });
    continue;
  }
  const gs = eventStartParts(ev);
  const ge = ev.end?.dateTime ? londonParts(ev.end.dateTime) : { date: null, time: null };
  const titleOk = (ev.summary || '').includes(`MC-${t.display_id}`) || (ev.summary || '').includes(t.title.slice(0, 20));
  const dateOk = gs.date === db.date;
  const startOk = gs.time === db.time;
  const row = {
    display_id: t.display_id,
    title: t.title,
    due_date: t.due_date,
    db_start: `${db.date} ${db.time}`,
    db_end: `${dbEnd.date} ${dbEnd.time}`,
    gcal_start: `${gs.date} ${gs.time}`,
    gcal_end: ge.date ? `${ge.date} ${ge.time}` : null,
    gcal_summary: ev.summary,
    calendar_event_id: t.calendar_event_id,
    dateOk,
    startOk,
    titleOk,
  };
  taskResults.push(row);
  if (!dateOk || !startOk || !titleOk) taskMismatch.push(row);
}

const logResults = [];
const logMissing = [];
const logMismatch = [];
for (const r of log) {
  const ev = findEvent(r.calendar_event_id);
  if (!ev) {
    logMissing.push(r);
    continue;
  }
  const gs = eventStartParts(ev);
  const dateOk = gs.date === r.scheduled_date;
  const titleOk =
    (ev.summary || '').toLowerCase().includes((r.title || '').slice(0, 18).toLowerCase()) ||
    (ev.summary || '').includes('MC 🔁') ||
    (ev.summary || '').includes('MC');
  const row = {
    title: r.title,
    ideal_date: r.ideal_date,
    scheduled_date: r.scheduled_date,
    duration_min: r.duration_min,
    gcal_date: gs.date,
    gcal_time: gs.time,
    gcal_summary: ev.summary,
    calendar_event_id: r.calendar_event_id,
    roll_reason: r.roll_reason,
    dateOk,
    titleOk,
  };
  logResults.push(row);
  if (!dateOk || !titleOk) logMismatch.push(row);
}

// Orphan MC calendar events not referenced by DB
const dbIds = new Set([
  ...tasks.map((t) => t.calendar_event_id).filter(Boolean),
  ...log.map((r) => r.calendar_event_id).filter(Boolean),
]);
const orphans = mcUnique.filter((e) => !dbIds.has(e.id));

// Classify orphans
const orphanTravel = orphans.filter((e) => /MC [⏳🚗⏰]/.test(e.summary || '') || /Prep —|Decompress —|Travel |Hotel deadline/i.test(e.summary || ''));
const orphanOther = orphans.filter((e) => !orphanTravel.includes(e));

// Habit coverage by title
const byHabit = {};
for (const r of log) {
  byHabit[r.title] = (byHabit[r.title] || 0) + 1;
}

const report = {
  verified_at: new Date().toISOString(),
  sources: {
    tasks: tasks.length,
    recurring_log: log.length,
    gcal_events_total: g1.length + g2.length,
    gcal_mc_unique: mcUnique.length,
  },
  tasks: {
    checked: taskResults.length,
    missing_on_gcal: taskMissing,
    mismatches: taskMismatch,
    ok: taskResults.length - taskMismatch.length,
  },
  habits: {
    checked: logResults.length,
    missing_on_gcal: logMissing,
    mismatches: logMismatch,
    ok: logResults.length - logMismatch.length,
    by_title: byHabit,
    date_range: log.length
      ? {
          min: log.map((r) => r.scheduled_date).sort()[0],
          max: log.map((r) => r.scheduled_date).sort().at(-1),
        }
      : null,
  },
  orphans: {
    total: orphans.length,
    travel_buffer_deadline: orphanTravel.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
    })),
    other: orphanOther.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
    })),
  },
};

fs.writeFileSync(path.join(__dirname, 'verify-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  sources: report.sources,
  tasks_ok: report.tasks.ok,
  tasks_missing: report.tasks.missing_on_gcal.length,
  tasks_mismatch: report.tasks.mismatches.length,
  habits_ok: report.habits.ok,
  habits_missing: report.habits.missing_on_gcal.length,
  habits_mismatch: report.habits.mismatches.length,
  orphans_travel: report.orphans.travel_buffer_deadline.length,
  orphans_other: report.orphans.other.length,
  habit_range: report.habits.date_range,
  byHabit,
}, null, 2));
if (taskMissing.length) console.log('TASK MISSING', taskMissing.map((t) => t.display_id));
if (taskMismatch.length) console.log('TASK MISMATCH', taskMismatch.slice(0, 10));
if (logMissing.length) console.log('LOG MISSING sample', logMissing.slice(0, 5).map((r) => r.calendar_event_id + ' ' + r.title));
if (logMismatch.length) console.log('LOG MISMATCH sample', logMismatch.slice(0, 8));
