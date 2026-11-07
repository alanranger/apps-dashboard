/**
 * Audit orphan decompress, duplicate hotel items, Light & Logic placements.
 * Optionally --fix to purge orphans/dupes.
 * node scripts/mc-audit-orphans-dupes-lightlogic.cjs
 * node scripts/mc-audit-orphans-dupes-lightlogic.cjs --fix
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
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { isoToLondonDate, addDays } = require('../api/mc/scheduling-rules-lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

function bareAfter(summary) {
  const t = String(summary || '');
  const m = /Decompress — after (.+)$/i.exec(t) || /Decompress — (.+)$/i.exec(t);
  return (m ? m[1] : '').trim();
}

function habitBare(summary) {
  return String(summary || '').replace(/^MC\s*[^\s]+\s+/, '').trim();
}

function isMcWorkTitle(t) {
  const s = String(t || '');
  if (/Decompress|Prep —|Travel |AWAY|REST|⚽/i.test(s)) return false;
  return /^MC\b/i.test(s) || /^P\d\s*·\s*MC-/i.test(s);
}

function overlapsTitle(a, b) {
  const aa = a.toLowerCase().slice(0, 36);
  const bb = b.toLowerCase().slice(0, 36);
  return aa && bb && (aa.includes(bb.slice(0, 20)) || bb.includes(aa.slice(0, 20)));
}

async function main() {
  const today = londonToday();
  const { events } = await fetchHorizonEvents(
    `${addDaysYmd(today, -14)}T00:00:00.000Z`,
    `${addDaysYmd(today, 280)}T00:00:00.000Z`,
  );
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  console.log('=== Light & Logic / newsletter ===');
  const ll = primary.filter((e) => /Light\s*&\s*Logic|newsletter issue/i.test(e.summary || ''));
  for (const e of ll.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.summary);
  }
  console.log('light_logic_count', ll.length);

  const habits = await sb('recurring_tasks?select=id,title,active&active=eq.true');
  const llHabit = (habits || []).filter((h) => /Light|Logic|newsletter/i.test(h.title || ''));
  const hotelHabits = (habits || []).filter((h) => /Hotel bookings/i.test(h.title || ''));
  console.log('\nDB Light/Logic habits', llHabit);
  console.log('DB Hotel bookings habits', hotelHabits.map((h) => ({ id: h.id, title: h.title })));

  for (const h of llHabit) {
    const logs = await sb(
      `recurring_log?recurring_task_id=eq.${h.id}&select=ideal_date,scheduled_date,calendar_event_id,change`
      + '&order=ideal_date.asc&limit=40',
    );
    console.log('\nLog', h.title);
    for (const r of logs || []) {
      console.log(' ', r.ideal_date, '->', r.scheduled_date, r.change?.slice(0, 40), r.calendar_event_id ? 'gcal' : 'NO_GCAL');
    }
  }

  console.log('\n=== White Horse / OVERSTRAND ===');
  const wh = primary.filter((e) => /White Horse|OVERSTRAND/i.test(e.summary || ''));
  for (const e of wh) console.log(isoToLondonDate(e.start.dateTime), e.id, e.summary.slice(0, 85));

  console.log('\n=== Nov 9-15 hotel / decompress / joining ===');
  for (const e of primary.filter((e) => {
    const d = isoToLondonDate(e.start.dateTime);
    return d >= '2026-11-09' && d <= '2026-11-15'
      && /Hotel|Decompress|Joining|deadline/i.test(e.summary || '');
  }).sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(isoToLondonDate(e.start.dateTime), e.start.dateTime.slice(11, 16), e.summary.slice(0, 75));
  }

  // Duplicate same title + day (habits / deadlines)
  console.log('\n=== Duplicate title+day ===');
  const byKey = new Map();
  for (const e of primary) {
    const t = e.summary || '';
    if (!/MC\s/i.test(t)) continue;
    if (/Travel|AWAY|REST|Prep —|⚽/i.test(t)) continue;
    const key = `${isoToLondonDate(e.start.dateTime)}|${t}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  let dupDeleted = 0;
  for (const [key, group] of byKey) {
    if (group.length < 2) continue;
    console.log('DUP', group.length, key.slice(0, 100));
    if (FIX) {
      group.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
      for (const e of group.slice(1)) {
        await deletePrimaryEvent(e.id);
        dupDeleted += 1;
      }
    }
  }

  // Near-duplicate hotel deadlines (same hotel key, within 3 days)
  console.log('\n=== Near-dup hotel deadlines (same hotel, ≤3d) ===');
  // Only cluster same reminder *kind* (deadline vs decision) — never merge them.
  const deadlines = primary.filter((e) => /MC\s*⏰/i.test(e.summary || '') && /Hotel deadline|Room release/i.test(e.summary || ''));
  const hotelKey = (s) => {
    const t = String(s).toLowerCase();
    if (/white horse|overstrand/i.test(t)) return 'whitehorse';
    if (/ravenstone/i.test(t)) return 'ravenstone';
    if (/vyrnwy/i.test(t)) return 'vyrnwy';
    if (/eagles|llanrwst/i.test(t)) return 'eagles';
    if (/ellerby/i.test(t)) return 'ellerby';
    if (/angel|wangford/i.test(t)) return 'angel';
    if (/hartland/i.test(t)) return 'hartland';
    if (/rudyard/i.test(t)) return 'rudyard';
    return t.replace(/[^a-z0-9]+/g, '').slice(0, 20);
  };
  const byHotel = new Map();
  for (const e of deadlines) {
    const k = hotelKey(e.summary);
    if (!byHotel.has(k)) byHotel.set(k, []);
    byHotel.get(k).push(e);
  }
  let nearDupDeleted = 0;
  for (const [k, group] of byHotel) {
    group.sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime));
    const keep = new Set();
    for (let i = 0; i < group.length; i += 1) {
      const a = group[i];
      const aDay = isoToLondonDate(a.start.dateTime);
      let clustered = false;
      for (const id of keep) {
        const b = group.find((g) => g.id === id);
        const bDay = isoToLondonDate(b.start.dateTime);
        const dist = Math.abs(Date.parse(`${aDay}T12:00:00Z`) - Date.parse(`${bDay}T12:00:00Z`)) / 86400000;
        if (dist <= 3) {
          clustered = true;
          console.log('NEAR_DUP', k, aDay, 'vs', bDay, a.summary.slice(0, 55));
          if (FIX) {
            await deletePrimaryEvent(a.id);
            // clear workshop_hotels link if pointed here
            await sb(`workshop_hotels?reminder_event_id=eq.${encodeURIComponent(a.id)}`, {
              method: 'PATCH', prefer: 'return=minimal',
              body: { reminder_event_id: null, reminder_placed: false },
            }).catch(() => {});
            nearDupDeleted += 1;
          }
          break;
        }
      }
      if (!clustered) keep.add(a.id);
    }
  }

  // Orphan decompress
  // Gap-buffer "after X" must share the same London day as parent MC work.
  // Workshop-style "Decompress — Title" (no "after") may pair with Prep or teaching.
  console.log('\n=== Orphan decompress ===');
  const allTimed = (events || []).filter((e) => e.start?.dateTime);
  const decomps = primary.filter((e) => /MC\s*⏳/i.test(e.summary || '') && /Decompress/i.test(e.summary || ''));
  let orphanDeleted = 0;
  for (const d of decomps) {
    const day = isoToLondonDate(d.start.dateTime);
    const after = bareAfter(d.summary);
    if (!after) continue;
    const isAfterForm = /Decompress — after /i.test(d.summary || '');
    let parents = [];
    if (isAfterForm) {
      parents = primary.filter((e) => {
        if (e.id === d.id) return false;
        if (!isMcWorkTitle(e.summary)) return false;
        if (isoToLondonDate(e.start.dateTime) !== day) return false;
        return overlapsTitle(habitBare(e.summary), after) || overlapsTitle(after, habitBare(e.summary));
      });
    } else {
      parents = allTimed.filter((e) => {
        if (e.id === d.id) return false;
        if (/Decompress|Travel |AWAY|REST|⚽/i.test(e.summary || '')) return false;
        if (isoToLondonDate(e.start.dateTime) !== day) return false;
        const bare = habitBare(e.summary).replace(/^Prep —\s*/i, '');
        return overlapsTitle(bare, after) || overlapsTitle(after, bare);
      });
    }
    if (parents.length) continue;
    console.log('ORPHAN', day, d.summary.slice(0, 75));
    if (FIX) {
      await deletePrimaryEvent(d.id);
      await sb(
        `gap_buffer_blocks?calendar_event_id=eq.${encodeURIComponent(d.id)}`,
        {
          method: 'PATCH', prefer: 'return=minimal',
          body: { status: 'retired', calendar_event_id: null },
        },
      ).catch(() => {});
      orphanDeleted += 1;
    }
  }

  console.log(JSON.stringify({
    fix: FIX,
    light_logic: ll.length,
    dup_deleted: dupDeleted,
    near_dup_deleted: nearDupDeleted,
    orphan_deleted: orphanDeleted,
    decomps: decomps.length,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
