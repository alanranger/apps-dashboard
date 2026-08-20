/**
 * Audit + purge MC Primary orphans: Google events not referenced by DB.
 * Safe deletes only: habit/task/deadline-style MC blocks with no DB claim.
 * Never deletes travel / rest / away / fixture / decompress masters blindly.
 *
 * Dry-run: node scripts/mc-audit-purge-orphans.cjs
 * Apply:   node scripts/mc-audit-purge-orphans.cjs --fix
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
const { londonToday, addDaysYmd } = require('../api/mc/diary-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function bareTitle(summary) {
  return String(summary || '')
    .replace(/^DONE\s*[·•-]?\s*/i, '')
    .replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '')
    .replace(/^MC-\d+\s*[·—–-]\s*/i, '')
    .replace(/^MC\s*\S+\s+/u, '')
    .trim()
    .toLowerCase();
}

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

async function collectClaimedIds() {
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

async function main() {
  const today = londonToday();
  const from = addDaysYmd(today, -21);
  const to = addDaysYmd(today, 280);
  console.log(JSON.stringify({ mode: FIX ? 'FIX' : 'DRY_RUN', from, to }, null, 2));

  const [claimed, snap] = await Promise.all([
    collectClaimedIds(),
    fetchHorizonEvents(`${from}T00:00:00.000Z`, `${to}T00:00:00.000Z`),
  ]);

  const primary = (snap.events || []).filter(
    (e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime && e.id,
  );

  const orphans = [];
  const protectedKept = [];
  for (const e of primary) {
    if (!isPurgeableMc(e.summary)) {
      if (/^MC\b|^P\d\s*·\s*MC-/i.test(e.summary || '')) {
        protectedKept.push({
          day: isoToLondonDate(e.start.dateTime),
          summary: e.summary,
        });
      }
      continue;
    }
    if (claimed.has(e.id)) continue;
    orphans.push({
      id: e.id,
      day: isoToLondonDate(e.start.dateTime),
      start: e.start.dateTime,
      summary: e.summary,
      bare: bareTitle(e.summary),
    });
  }

  orphans.sort((a, b) => a.start.localeCompare(b.start));

  // Same-day exact-title dups where one is claimed: also flag extras even if both claimed wrongly
  const byDayBare = new Map();
  for (const e of primary.filter((x) => isPurgeableMc(x.summary))) {
    const key = `${isoToLondonDate(e.start.dateTime)}|${bareTitle(e.summary)}`;
    if (!byDayBare.has(key)) byDayBare.set(key, []);
    byDayBare.get(key).push(e);
  }
  const sameDayDupes = [];
  for (const [key, group] of byDayBare) {
    if (group.length < 2) continue;
    const claimedOnes = group.filter((e) => claimed.has(e.id));
    const unclaimed = group.filter((e) => !claimed.has(e.id));
    if (unclaimed.length) {
      for (const e of unclaimed) {
        if (!orphans.some((o) => o.id === e.id)) {
          orphans.push({
            id: e.id,
            day: isoToLondonDate(e.start.dateTime),
            start: e.start.dateTime,
            summary: e.summary,
            bare: bareTitle(e.summary),
            reason: 'same_day_dupe_unclaimed',
          });
        }
      }
    } else if (claimedOnes.length > 1) {
      sameDayDupes.push({
        key,
        count: group.length,
        ids: group.map((e) => e.id),
        summaries: group.map((e) => e.summary),
      });
    }
  }

  console.log('\n=== ORPHANS (no DB calendar_event_id claim) ===');
  console.log('count', orphans.length);
  for (const o of orphans) {
    console.log(o.day, o.start.slice(11, 16), (o.summary || '').slice(0, 80), o.reason || 'untied');
  }

  if (sameDayDupes.length) {
    console.log('\n=== SAME-DAY DUPES (all claimed — manual) ===');
    for (const d of sameDayDupes) console.log(d.key, d.count);
  }

  // Highlight Bank Genie specifically
  const bg = primary.filter((e) => /Bank Genie|Monthly Accounts/i.test(e.summary || ''));
  console.log('\n=== Bank Genie / Monthly Accounts on Primary ===');
  for (const e of bg.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime))) {
    console.log(
      isoToLondonDate(e.start.dateTime),
      e.start.dateTime.slice(11, 16),
      claimed.has(e.id) ? 'CLAIMED' : 'ORPHAN',
      (e.summary || '').slice(0, 70),
      e.id.slice(0, 12),
    );
  }

  let deleted = 0;
  const failed = [];
  if (FIX) {
    for (const o of orphans) {
      try {
        await deletePrimaryEvent(o.id);
        deleted += 1;
        console.log('DELETED', o.day, (o.summary || '').slice(0, 70));
      } catch (err) {
        failed.push({ id: o.id, error: err.message });
      }
    }
  }

  console.log(JSON.stringify({
    mode: FIX ? 'FIX' : 'DRY_RUN',
    primary_timed: primary.length,
    claimed_ids: claimed.size,
    orphans: orphans.length,
    deleted,
    failed: failed.length,
    protected_mc_sample: protectedKept.slice(0, 5).length,
    tip: FIX ? 'done' : 'Re-run with --fix to delete orphans',
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
