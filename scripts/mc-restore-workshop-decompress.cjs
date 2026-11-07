/**
 * Restore decompress only when Prep/workshop parent still sits adjacent on Primary.
 * node scripts/mc-restore-workshop-decompress.cjs
 */
const fs = require('fs');
const path = require('path');
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { fetchHorizonEvents } = require('../api/mc/gcal-lib');
const { insertPrimaryEvent } = require('../api/mc/gcal-write-lib');
const { isoToLondonDate } = require('../api/mc/scheduling-rules-lib');

function bare(summary) {
  return String(summary || '')
    .replace(/^MC\s*[^\s]+\s+/, '')
    .replace(/^Prep\s*—\s*/i, '')
    .trim();
}

(async () => {
  const { events } = await fetchHorizonEvents('2026-08-01T00:00:00Z', '2027-03-01T23:59:59Z');
  const primary = (events || []).filter((e) => (e._calendarId || 'primary') === 'primary' && e.start?.dateTime);

  // Candidates: Prep — blocks with no decompress in next 35m
  const preps = primary.filter((e) => /MC\s*.*Prep\s*—/i.test(e.summary || ''));
  const created = [];
  for (const p of preps) {
    const end = Date.parse(p.end.dateTime);
    const day = isoToLondonDate(p.start.dateTime);
    const has = primary.some((d) => {
      if (!/Decompress/i.test(d.summary || '') || !d.start?.dateTime) return false;
      if (isoToLondonDate(d.start.dateTime) !== day) return false;
      const gap = (Date.parse(d.start.dateTime) - end) / 60000;
      return gap >= -1 && gap <= 5;
    });
    if (has) continue;
    // Only restore if next 30m is free
    const startIso = p.end.dateTime;
    const endIso = new Date(end + 30 * 60000).toISOString();
    const clash = primary.some((e) => {
      if (e.id === p.id || !e.start?.dateTime) return false;
      const a = Date.parse(startIso);
      const b = Date.parse(endIso);
      const o0 = Date.parse(e.start.dateTime);
      const o1 = Date.parse(e.end?.dateTime || e.start.dateTime);
      return a < o1 && o0 < b && e.transparency !== 'transparent';
    });
    if (clash) {
      console.log('skip_clash', day, p.summary);
      continue;
    }
    const title = `MC ⏳ Decompress — ${bare(p.summary).slice(0, 60)}`;
    const ev = await insertPrimaryEvent({
      summary: title,
      startIso,
      endIso,
      description: 'restored_after_orphan_purge|after_prep',
    });
    created.push({ day, title, id: ev.id, start: startIso });
    console.log('restored', created[created.length - 1]);
  }
  console.log('DONE', created.length);
})().catch((e) => { console.error(e); process.exit(1); });
