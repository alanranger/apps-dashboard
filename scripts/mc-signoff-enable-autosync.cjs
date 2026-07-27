/**
 * Alan-approved sign-off: enable auto-sync flags, confirm reconcile still ✓.
 * node scripts/mc-signoff-enable-autosync.cjs
 */
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sb } = require('../api/mc/_lib');
const { loadFlags, reconcileReport } = require('../api/mc/gcal-auto-sync-lib');

async function upsertRule(key, value, actor) {
  const cur = (await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`))?.[0];
  if (cur) {
    await sb(`scheduling_rules?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { value: String(value), updated_at: new Date().toISOString() },
    });
  } else {
    await sb('scheduling_rules', {
      method: 'POST', prefer: 'return=minimal',
      body: {
        key, value: String(value), value_type: 'bool',
        description: 'Phase 3 auto-sync flag',
      },
    });
  }
  try {
    await sb('scheduling_rules_audit', {
      method: 'POST',
      body: {
        key,
        old_value: cur?.value ?? null,
        new_value: String(value),
        changed_by: actor || 'cursor',
      },
    });
  } catch (_) { /* audit optional */ }
}

(async () => {
  console.log('FLAGS_BEFORE', JSON.stringify(await loadFlags(sb)));
  await upsertRule('auto_sync_signed_off', true, 'cursor');
  await upsertRule('auto_sync_enabled', true, 'cursor');
  const flags = await loadFlags(sb);
  console.log('FLAGS_AFTER', JSON.stringify(flags));
  const rec = await reconcileReport(sb);
  console.log('STATUS_LINE', rec.status_line);
  console.log('MISMATCH_COUNT', rec.mismatch_count);
  const out = {
    generated_at: new Date().toISOString(),
    flags,
    status_line: rec.status_line,
    mismatch_count: rec.mismatch_count,
    google_matches_db: rec.google_matches_db,
  };
  fs.mkdirSync(path.join(__dirname, '..', 'tmp'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, '..', 'tmp', 'mc-signoff-enable-LATEST.json'),
    JSON.stringify(out, null, 2),
  );
  if (!flags.auto_sync_enabled || !flags.auto_sync_signed_off) {
    console.error('ABORT: flags not both true');
    process.exit(2);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
