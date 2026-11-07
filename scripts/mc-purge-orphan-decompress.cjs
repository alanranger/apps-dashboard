/**
 * Purge orphan MC decompress strips (no adjacent parent). Apply deletes now.
 * node scripts/mc-purge-orphan-decompress.cjs [fromYmd] [toYmd]
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { fetchHorizonEvents, getAccessToken } = require('../api/mc/gcal-lib');
const { deletePrimaryEvent } = require('../api/mc/gcal-write-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

const from = process.argv[2] || '2026-08-01';
const to = process.argv[3] || '2027-03-01';

function afterLabel(summary) {
  const s = String(summary || '');
  const after = /Decompress\s*—\s*after\s+(.+)$/i.exec(s);
  if (after) return after[1].trim();
  const bare = /Decompress\s*—\s*(.+)$/i.exec(s);
  return bare ? bare[1].trim() : '';
}

function bareTitle(summary) {
  return String(summary || '')
    .replace(/^DONE\s*[·•\-–]\s*/i, '')
    .replace(/^MC\s*[^\s]+\s+/, '')
    .replace(/^P\d\s*·\s*MC-\d+\s*·\s*/i, '')
    .replace(/^Prep\s*—\s*/i, '')
    .trim();
}

function isDecompress(e) {
  const t = e.summary || '';
  return /Decompress/i.test(t) && (/^MC\b/i.test(t) || /⏳/.test(t));
}

function isMcWork(e) {
  const t = e.summary || '';
  if (isDecompress(e)) return false;
  if (/Travel |AWAY|REST|⚽|🚫|🛌|⏰/i.test(t)) return false;
  return /^MC\b/i.test(t) || /^P\d\s*·\s*MC-/i.test(t) || /^DONE\b/i.test(t);
}

/** Parent must end within 5 minutes before decompress starts (true adjacency). */
function hasAdjacentParent(primary, d) {
  const d0 = Date.parse(d.start.dateTime);
  const day = isoToLondonDate(d.start.dateTime);
  const after = afterLabel(d.summary).toLowerCase();
  return primary.some((e) => {
    if (e.id === d.id || !e.start?.dateTime || !e.end?.dateTime) return false;
    if (!isMcWork(e)) return false;
    if (isoToLondonDate(e.start.dateTime) !== day) return false;
    const end = Date.parse(e.end.dateTime);
    const gapMin = (d0 - end) / 60000;
    if (gapMin < -1 || gapMin > 5) return false;
    const b = bareTitle(e.summary).toLowerCase();
    const a = after.slice(0, 28);
    const bb = b.slice(0, 28);
    return a && bb && (a.includes(bb.slice(0, 16)) || bb.includes(a.slice(0, 16)));
  });
}

(async () => {
  const { events, assessment } = await fetchHorizonEvents(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
  console.log('assessment', assessment, 'events', (events || []).length);
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  const strips = primary.filter(isDecompress);
  const orphans = [];
  const keep = [];
  for (const d of strips) {
    if (hasAdjacentParent(primary, d)) keep.push(d);
    else orphans.push(d);
  }

  console.log('decompress_total', strips.length, 'orphans', orphans.length, 'kept', keep.length);
  console.log('orphan_sample', orphans.slice(0, 25).map((d) => ({
    day: isoToLondonDate(d.start.dateTime),
    start: d.start.dateTime,
    end: d.end?.dateTime,
    summary: d.summary,
    id: d.id,
  })));

  let deleted = 0;
  let failed = 0;
  for (const d of orphans) {
    try {
      await deletePrimaryEvent(d.id);
      deleted += 1;
      await sb(
        `gap_buffer_blocks?calendar_event_id=eq.${encodeURIComponent(d.id)}`,
        {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'retired',
            calendar_event_id: null,
            updated_at: new Date().toISOString(),
          },
        },
      ).catch(() => {});
      // Resolve any pending push for this orphan
      await sb(
        `gcal_push_queue?related_id=eq.${encodeURIComponent(`gcal:gap_buffer:orphan:${d.id}`)}&status=eq.pending`,
        {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            status: 'applied',
            resolved_at: new Date().toISOString(),
            resolved_by: 'cursor',
            updated_at: new Date().toISOString(),
          },
        },
      ).catch(() => {});
    } catch (e) {
      failed += 1;
      console.log('fail', d.id, e.message);
    }
  }
  console.log({ deleted, failed, kept: keep.length });

  // Verify Aug 17-23 remaining decompress
  const token = await getAccessToken();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime`
    + `&timeMin=${encodeURIComponent('2026-08-17T00:00:00Z')}`
    + `&timeMax=${encodeURIComponent('2026-08-24T00:00:00Z')}`
    + `&q=${encodeURIComponent('Decompress')}&maxResults=50`;
  const j = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  console.log('aug17_23_decompress_left', (j.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
    start: e.start?.dateTime, summary: e.summary,
  })));
})().catch((e) => { console.error(e); process.exit(1); });
