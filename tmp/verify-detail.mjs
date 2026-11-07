import fs from 'fs';

function london(iso) {
  let s = String(iso).trim();
  if (!s.includes('T')) s = s.replace(' ', 'T');
  if (/\+\d{2}$/.test(s)) s = s + ':00';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error('bad ' + iso + ' -> ' + s);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    mins: d.getTime(),
  };
}

const log = JSON.parse(
  fs.readFileSync(
    'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-log-clean.json',
    'utf8'
  )
);
const tasks = JSON.parse(
  fs.readFileSync(
    'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-tasks.json',
    'utf8'
  )
);
const g1 = JSON.parse(
  fs.readFileSync(
    'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-gcal-jul-oct.json',
    'utf8'
  )
);
const g2 = JSON.parse(
  fs.readFileSync(
    'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-gcal-oct-jan.json',
    'utf8'
  )
);
const all = [...(g1.events || g1), ...(g2.events || g2)];
const byId = new Map(all.map((e) => [e.id, e]));

const taskRows = [];
for (const t of tasks) {
  const e = byId.get(t.calendar_event_id);
  const dbS = london(t.scheduled_start);
  const dbE = london(t.scheduled_end);
  const gS = london(e.start.dateTime);
  const gE = london(e.end.dateTime);
  taskRows.push({
    display_id: t.display_id,
    title: t.title,
    due: t.due_date,
    db: `${dbS.date} ${dbS.time}`,
    gcal: `${gS.date} ${gS.time}`,
    dbEnd: `${dbE.date} ${dbE.time}`,
    gcalEnd: `${gE.date} ${gE.time}`,
    summary: e.summary,
    durDb: Math.round((dbE.mins - dbS.mins) / 60000),
    durG: Math.round((gE.mins - gS.mins) / 60000),
    dateOk: dbS.date === gS.date,
    timeOk: dbS.time === gS.time,
    endOk: dbE.time === gE.time,
    titleOk: (e.summary || '').includes('MC-' + t.display_id),
  });
}
const tMis = taskRows.filter((r) => !r.dateOk || !r.timeOk || !r.endOk || !r.titleOk);

const habitDurMis = [];
for (const r of log) {
  const e = byId.get(r.calendar_event_id);
  const gS = london(e.start.dateTime);
  const gE = london(e.end.dateTime);
  const durG = Math.round((gE.mins - gS.mins) / 60000);
  if (durG !== r.duration_min) {
    habitDurMis.push({
      title: r.title,
      scheduled: r.scheduled_date,
      expect: r.duration_min,
      got: durG,
      summary: e.summary,
      start: e.start.dateTime,
    });
  }
}

const mcAll = all.filter((e) => /MC /.test(e.summary || ''));
const census = { habit: 0, task: 0, travel: 0, prep: 0, decomp: 0, deadline: 0, other: 0 };
const otherSamples = [];
for (const e of mcAll) {
  const s = e.summary || '';
  if (s.includes('MC 🔁')) census.habit++;
  else if (s.includes('MC ✅') || /MC-\d+/.test(s)) census.task++;
  else if (/Travel/.test(s)) census.travel++;
  else if (/Prep —|Prep -/.test(s)) census.prep++;
  else if (/Decompress/.test(s)) census.decomp++;
  else if (/deadline|MC ⏰/.test(s)) census.deadline++;
  else {
    census.other++;
    if (otherSamples.length < 15) otherSamples.push(s);
  }
}

const drifts = taskRows
  .map((r) => ({
    id: r.display_id,
    due: r.due,
    scheduled: r.db.slice(0, 10),
    days: (Date.parse(r.db.slice(0, 10)) - Date.parse(r.due)) / 86400000,
  }))
  .filter((x) => x.days !== 0);

const bau = log
  .filter((r) => /BAU|Upload/.test(r.title))
  .map((r) => `${r.scheduled_date} | ${r.title}`);

const out = {
  verified_at: new Date().toISOString(),
  exact_id_hits: {
    habits: log.filter((r) => byId.has(r.calendar_event_id)).length,
    habits_total: log.length,
    tasks: tasks.filter((t) => byId.has(t.calendar_event_id)).length,
    tasks_total: tasks.length,
  },
  habit_date_mismatches: log.filter((r) => {
    const e = byId.get(r.calendar_event_id);
    return london(e.start.dateTime).date !== r.scheduled_date;
  }).length,
  habit_duration_mismatches: habitDurMis,
  task_mismatches: tMis,
  task_due_drifts: drifts,
  gcal_census: census,
  gcal_mc_total: mcAll.length,
  other_samples: otherSamples,
  bau_upload_rows: bau,
  title_cosmetic: [
    'Light & Logic (DB) vs Light and Logic (calendar) — 4 newsletter events',
    'Review/Amend Course & Workshop Dates + check Hotel Bookings (DB) shortened on calendar',
  ],
};
fs.writeFileSync(
  'G:/Dropbox/alan ranger photography/Website Code/apps-dashboard/tmp/verify-detail.json',
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify(out, null, 2));
