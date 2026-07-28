/**
 * Dedupe overlapping MC ⏰ Hotel deadline reminders same day / same hotel.
 * Prefer workshop_hotels.reminder_event_id when present.
 * node scripts/mc-dedupe-hotel-deadline-reminders.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function hotelKey(summary) {
  const t = String(summary || '').toLowerCase();
  if (/ravenstone/i.test(t)) return 'ravenstone';
  if (/eagles|llanrwst/i.test(t)) return 'eagles';
  if (/white horse|overstrand/i.test(t)) return 'whitehorse';
  if (/angel inn|wangford/i.test(t)) return 'angel';
  if (/rudyard/i.test(t)) return 'rudyard';
  const m = /hotel deadline —\s*([^—(]+)/i.exec(summary || '');
  return (m ? m[1] : summary || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

async function main() {
  const today = londonToday();
  const hotels = await sb(
    'workshop_hotels?select=id,hotel,workshop_name,reminder_event_id,free_cancel_until&status=eq.active',
  ).catch(() => []);
  const keepPreferred = new Set(
    (hotels || []).map((h) => h.reminder_event_id).filter(Boolean),
  );

  const { events } = await fetchHorizonEvents(
    `${addDaysYmd(today, -7)}T00:00:00.000Z`,
    `${addDaysYmd(today, 220)}T00:00:00.000Z`,
  );
  const reminders = (events || []).filter((e) => {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime) return false;
    return /MC\s*⏰/i.test(e.summary || '') && /Hotel deadline/i.test(e.summary || '');
  });

  const groups = new Map();
  for (const e of reminders) {
    const day = isoToLondonDate(e.start.dateTime);
    const key = `${day}|${hotelKey(e.summary)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  let deleted = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    // Keep DB-linked if any; else keep longest title / earliest id
    let keep = group.find((e) => keepPreferred.has(e.id));
    if (!keep) {
      keep = group.slice().sort((a, b) => String(b.summary).length - String(a.summary).length)[0];
    }
    for (const e of group) {
      if (e.id === keep.id) continue;
      await deletePrimaryEvent(e.id);
      deleted += 1;
      console.log('deleted dup', key, e.summary.slice(0, 70), 'kept', keep.id);
    }
  }
  console.log(JSON.stringify({ deleted, groups: groups.size, reminders: reminders.length }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
