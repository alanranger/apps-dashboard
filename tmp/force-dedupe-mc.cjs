const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const { sb } = require('../api/mc/_lib.js');
const { fetchHorizonEvents, gcalConfigured } = require('../api/mc/gcal-lib.js');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib.js');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib.js');
const { upsertPushRow } = require('../api/mc/gcal-push-lib.js');

(async () => {
  if (!gcalConfigured()) throw new Error('no gcal');
  const from = '2026-08-10';
  const to = '2026-08-16';
  const { events } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  const logs = await sb(
    `recurring_log?select=calendar_event_id,scheduled_date,ideal_date,recurring_task_id`
    + `&or=(and(scheduled_date.gte.${from},scheduled_date.lte.${to}),and(ideal_date.gte.${from},ideal_date.lte.${to}))`,
  );
  const tied = new Set((logs || []).map((r) => r.calendar_event_id).filter(Boolean));
  const primary = (events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime
      && /^MC\s*🔁/u.test(String(e.summary || '')) && e.status !== 'cancelled',
  );
  const groups = new Map();
  for (const e of primary) {
    const key = `${String(e.summary).trim()}|${Date.parse(e.start.dateTime)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let deleted = 0;
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => {
      const at = tied.has(a.id) ? 0 : 1;
      const bt = tied.has(b.id) ? 0 : 1;
      if (at !== bt) return at - bt;
      return String(a.id).localeCompare(String(b.id));
    });
    console.log('DUPE group', key, list.map((e) => e.id));
    for (const e of list.slice(1)) {
      await deletePrimaryEvent(e.id);
      deleted += 1;
      console.log(' deleted', e.id, e.summary);
    }
  }
  // Orphans not in logs at all
  for (const e of primary) {
    if (tied.has(e.id)) continue;
    // still present (not deleted as dup)?
    const day = isoToLondonDate(e.start.dateTime);
    // Keep if unique title+start among survivors
    // For this force pass: leave if only one with this title that day unless explicitly orphan week clutter
    console.log('ORPHAN (untied)', day, e.summary, e.id);
  }
  console.log('deleted', deleted);

  const { events: after } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  const mc = (after || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime
      && /^MC\s*🔁/u.test(String(e.summary || '')),
  ).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
  console.log('\nMC 🔁 after dedupe:');
  for (const e of mc) {
    console.log(
      isoToLondonDate(e.start.dateTime),
      String(e.start.dateTime).slice(11, 16),
      '-',
      String(e.end.dateTime).slice(11, 16),
      e.summary,
    );
  }
})().catch((e) => { console.error(e); process.exit(1); });
