/**
 * Delete Primary MC habit/task/deadline events with no DB calendar_event_id claim.
 * Protects travel / rest / away / fixture / decompress masters.
 */
const { deletePrimaryEvent } = require('./gcal-write-lib');
const { fetchHorizonEvents } = require('./gcal-lib');
const { londonToday, addDaysYmd } = require('./diary-lib');
const { isoToLondonDate } = require('./scheduling-rules-lib');

function isProtectedMc(summary) {
  const t = String(summary || '');
  return /MC\s*🚗|Travel out|Travel back|Travel —/i.test(t)
    || /MC\s*⏳|Decompress|Prep —/i.test(t)
    || /MC\s*🚫|MC\s*🛌|AWAY —|REST —/i.test(t)
    || /MC\s*⚽/i.test(t);
}

function isPurgeableMc(summary) {
  const t = String(summary || '');
  if (!t || isProtectedMc(t)) return false;
  if (/^P\d\s*·\s*MC-/i.test(t)) return true;
  if (/^MC-\d+\b/i.test(t)) return true;
  if (/^DONE\b/i.test(t) && /MC\b/i.test(t)) return true;
  if (/^MC\b/i.test(t)) return true;
  return false;
}

async function collectClaimedIds(sb) {
  const claimed = new Set();
  const add = (id) => { if (id) claimed.add(id); };
  const [logs, tasks, travel, hotels, gaps, fixtures, rest, away] = await Promise.all([
    sb('recurring_log?select=calendar_event_id&calendar_event_id=not.is.null&limit=10000'),
    sb('tasks?select=calendar_event_id&calendar_event_id=not.is.null&limit=5000'),
    sb('travel_blocks?select=calendar_event_id&calendar_event_id=not.is.null&limit=5000'),
    sb('workshop_hotels?select=reminder_event_id&reminder_event_id=not.is.null&limit=2000'),
    sb('gap_buffer_blocks?select=calendar_event_id&status=eq.active&calendar_event_id=not.is.null&limit=5000'),
    sb('fixture_blocks?select=before_event_id,after_event_id,calendar_event_id&status=eq.active&limit=5000'),
    sb('rest_day_blocks?select=calendar_event_id&calendar_event_id=not.is.null&limit=2000').catch(() => []),
    sb('away_day_blocks?select=calendar_event_id&calendar_event_id=not.is.null&limit=2000').catch(() => []),
  ]);
  for (const r of logs || []) add(r.calendar_event_id);
  for (const r of tasks || []) add(r.calendar_event_id);
  for (const r of travel || []) add(r.calendar_event_id);
  for (const r of hotels || []) add(r.reminder_event_id);
  for (const r of gaps || []) add(r.calendar_event_id);
  for (const r of fixtures || []) {
    add(r.before_event_id);
    add(r.after_event_id);
    add(r.calendar_event_id);
  }
  for (const r of rest || []) add(r.calendar_event_id);
  for (const r of away || []) add(r.calendar_event_id);
  return claimed;
}

function listUntiedOrphans(events, claimed) {
  const out = [];
  for (const e of events || []) {
    if ((e._calendarId || 'primary') !== 'primary' || !e.start?.dateTime || !e.id) continue;
    if (!isPurgeableMc(e.summary)) continue;
    if (claimed.has(e.id)) continue;
    out.push({
      id: e.id,
      day: isoToLondonDate(e.start.dateTime),
      summary: e.summary,
      start: e.start.dateTime,
    });
  }
  return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

async function purgeUntiedMcOrphans(sb, {
  events = null,
  limit = 40,
  lookbackDays = 21,
  aheadDays = 280,
} = {}) {
  const claimed = await collectClaimedIds(sb);
  let pool = events;
  if (!pool) {
    const today = londonToday();
    const snap = await fetchHorizonEvents(
      `${addDaysYmd(today, -lookbackDays)}T00:00:00.000Z`,
      `${addDaysYmd(today, aheadDays)}T00:00:00.000Z`,
    );
    pool = snap.events || [];
  }
  const orphans = listUntiedOrphans(pool, claimed);
  const deleted = [];
  const failed = [];
  for (const o of orphans.slice(0, Math.max(1, limit))) {
    try {
      await deletePrimaryEvent(o.id);
      deleted.push({ id: o.id, day: o.day, summary: o.summary });
    } catch (e) {
      failed.push({ id: o.id, error: e.message });
    }
  }
  return {
    claimed: claimed.size,
    orphans_found: orphans.length,
    deleted: deleted.length,
    remaining: Math.max(0, orphans.length - deleted.length),
    sample: deleted.slice(0, 8).map((d) => `${d.day} ${String(d.summary || '').slice(0, 50)}`),
    failed,
  };
}

/** Once per London day — stamp scheduling_rules so 15-min cron does not hammer GCal. */
async function purgeUntiedMcOrphansDaily(sb, opts = {}) {
  const today = londonToday();
  const key = 'gcal_orphan_purge_last_ymd';
  const rows = await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}&select=key,value`);
  if (String(rows?.[0]?.value || '') === today) {
    return { skipped: true, reason: 'already_ran_today', day: today };
  }
  const result = await purgeUntiedMcOrphans(sb, opts);
  const body = {
    key,
    value: today,
    value_type: 'string',
    description: 'London YMD of last automatic MC orphan GCal purge',
    updated_at: new Date().toISOString(),
  };
  if (rows?.[0]) {
    await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH', prefer: 'return=minimal', body,
    });
  } else {
    await sb('scheduling_rules', { method: 'POST', prefer: 'return=minimal', body });
  }
  return { skipped: false, day: today, ...result };
}

module.exports = {
  isPurgeableMc,
  isProtectedMc,
  collectClaimedIds,
  listUntiedOrphans,
  purgeUntiedMcOrphans,
  purgeUntiedMcOrphansDaily,
};
