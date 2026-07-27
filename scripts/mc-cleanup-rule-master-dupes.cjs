/**
 * One-off: purge duplicate MC REST / AWAY all-day masters on primary.
 * Keep calendar_event_id from active rest_day_blocks / away_day_blocks;
 * delete other same-slot or orphan REST/AWAY events.
 *
 * Usage (from apps-dashboard): node scripts/mc-cleanup-rule-master-dupes.mjs
 */
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();

const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { sb } = require('../api/mc/_lib');
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');

function isRestOrAway(summary) {
  const t = String(summary || '');
  return /MC\s*.*\bAWAY\b/i.test(t) || /MC\s*.*\bREST\b/i.test(t)
    || t.includes('🚫') || t.includes('🛌');
}

function slotKey(e) {
  const start = e.start?.date || (e.start?.dateTime || '').slice(0, 10);
  const end = e.end?.date || (e.end?.dateTime || '').slice(0, 10);
  const title = String(e.summary || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${start}|${end}|${title}`;
}

async function main() {
  const today = londonToday();
  const from = addDaysYmd(today, -30);
  const to = addDaysYmd(today, 400);
  const timeMin = `${from}T00:00:00.000Z`;
  const timeMax = `${to}T00:00:00.000Z`;

  const [restRows, awayRows, gcal] = await Promise.all([
    sb('rest_day_blocks?status=eq.active&select=id,rest_date,calendar_event_id,workshop_title'),
    sb('away_day_blocks?status=eq.active&select=id,start_date,end_date,calendar_event_id,venue_name'),
    fetchHorizonEvents(timeMin, timeMax),
  ]);

  const keepIds = new Set([
    ...(restRows || []).map((r) => r.calendar_event_id).filter(Boolean),
    ...(awayRows || []).map((r) => r.calendar_event_id).filter(Boolean),
  ]);

  const primary = (gcal.events || []).filter((e) => e._calendarId === 'primary' && e.start?.date);
  const candidates = primary.filter((e) => isRestOrAway(e.summary));

  const bySlot = new Map();
  for (const e of candidates) {
    const k = slotKey(e);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(e);
  }

  const toDelete = [];
  const kept = [];

  for (const [, group] of bySlot) {
    if (group.length === 1) {
      const only = group[0];
      // Orphan single: not in DB keep set → still delete if we can match a DB row by dates
      if (keepIds.has(only.id)) {
        kept.push(only);
        continue;
      }
      // Prefer linking: if any active rest/away covers this slot, delete orphan
      // (DB already has its own event id). Otherwise keep unique singles that aren't tracked
      // only when no DB row exists for that date — leave them for sync prune.
      const start = only.start.date;
      const endEx = only.end.date;
      const restHit = (restRows || []).some((r) => r.rest_date === start);
      const awayHit = (awayRows || []).some((r) => {
        const ex = addDaysYmd(r.end_date, 1);
        return r.start_date === start && ex === endEx;
      });
      if (restHit || awayHit) toDelete.push(only);
      else kept.push(only);
      continue;
    }

    // Duplicates: prefer DB-tracked id, else first
    const preferred = group.find((e) => keepIds.has(e.id)) || group[0];
    kept.push(preferred);
    for (const e of group) {
      if (e.id !== preferred.id) toDelete.push(e);
    }
  }

  // Also delete extras that share dates with a kept DB event but different title (emoji drift)
  for (const e of candidates) {
    if (toDelete.some((d) => d.id === e.id) || kept.some((k) => k.id === e.id)) continue;
    if (keepIds.has(e.id)) continue;
    const start = e.start.date;
    const endEx = e.end.date;
    const clashRest = (restRows || []).some((r) => r.rest_date === start && r.calendar_event_id
      && r.calendar_event_id !== e.id);
    const clashAway = (awayRows || []).some((r) => {
      const ex = addDaysYmd(r.end_date, 1);
      return r.start_date === start && ex === endEx && r.calendar_event_id
        && r.calendar_event_id !== e.id;
    });
    if (clashRest || clashAway) toDelete.push(e);
  }

  console.log(JSON.stringify({
    scanned: candidates.length,
    slots: bySlot.size,
    keep_ids: keepIds.size,
    will_delete: toDelete.length,
    deletes: toDelete.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start.date,
      end: e.end.date,
    })),
  }, null, 2));

  if (process.argv.includes('--dry-run')) {
    console.log('dry-run only');
    return;
  }

  let deleted = 0;
  const failed = [];
  for (const e of toDelete) {
    try {
      await deletePrimaryEvent(e.id);
      deleted += 1;
      await new Promise((r) => setTimeout(r, 40));
    } catch (err) {
      failed.push({ id: e.id, error: err.message });
    }
  }
  console.log(JSON.stringify({ deleted, failed }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
