/**
 * Corrective DB → GCal sync for reconcile mismatches.
 * Patches time mismatches; inserts missing events; updates recurring_log event ids.
 * Usage: node tmp/gcal-reconcile-fix.cjs
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib.js');
const { ruleMapFromRows } = require('../api/mc/scheduling-rules-lib.js');
const { insertPrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib.js');

async function main() {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'tmp/gcal-reconcile-diary-LATEST.json'), 'utf8'));
  const rules = await sb('scheduling_rules?select=key,value');
  const ruleMap = ruleMapFromRows(rules || []);
  const habitPrefix = ruleMap.title_prefix_recurring || 'MC 🔁';
  const travelPrefix = ruleMap.title_prefix_travel || 'MC 🚗';

  const results = [];

  for (const row of report.time_mismatch || []) {
    const prefix = row.kind === 'travel' ? travelPrefix : row.kind === 'habit' ? habitPrefix : '';
    const summary = prefix ? `${prefix} ${row.title}` : row.title;
    try {
      await patchPrimaryEvent(row.event_id, {
        startIso: row.db.start,
        endIso: row.db.end,
        summary,
      });
      results.push({ action: 'patch', ok: true, ...row });
    } catch (e) {
      results.push({ action: 'patch', ok: false, error: e.message, ...row });
    }
  }

  for (const row of report.missing_in_gcal || []) {
    const prefix = row.kind === 'travel' ? travelPrefix : row.kind === 'habit' ? habitPrefix : '';
    const summary = prefix ? `${prefix} ${row.title}` : row.title;
    try {
      const created = await insertPrimaryEvent({
        summary,
        startIso: row.start,
        endIso: row.end,
        description: `reconcile-fix; prior_event_id=${row.event_id}`,
      });
      // Update DB pointer to new event
      if (row.kind === 'habit' && row.id?.startsWith('habit:')) {
        const parts = row.id.split(':');
        const habitId = parts[1];
        const day = parts[2];
        await sb(
          `recurring_log?recurring_task_id=eq.${habitId}&scheduled_date=eq.${day}`,
          {
            method: 'PATCH', prefer: 'return=minimal',
            body: { calendar_event_id: created.id },
          },
        );
      } else if (row.kind === 'task' && row.id?.startsWith('task:')) {
        const taskId = row.id.slice(5);
        await sb(`tasks?id=eq.${taskId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { calendar_event_id: created.id },
        });
      } else if (row.kind === 'travel' && row.id?.startsWith('travel:')) {
        const travelId = row.id.slice(7);
        await sb(`travel_blocks?id=eq.${travelId}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: { calendar_event_id: created.id },
        });
      }
      results.push({
        action: 'insert', ok: true, new_event_id: created.id, old_event_id: row.event_id,
        title: row.title, kind: row.kind,
      });
    } catch (e) {
      results.push({ action: 'insert', ok: false, error: e.message, ...row });
    }
  }

  const out = {
    at: new Date().toISOString(),
    patched: results.filter((r) => r.action === 'patch' && r.ok).length,
    inserted: results.filter((r) => r.action === 'insert' && r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
  fs.writeFileSync(path.join(root, 'tmp/gcal-reconcile-fix-LATEST.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    patched: out.patched, inserted: out.inserted, failed: out.failed,
    failures: results.filter((r) => !r.ok).map((r) => ({ action: r.action, title: r.title, error: r.error })),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
