// One-off: set Show As = Busy on Google events Alan pinned by hand. Dry unless --apply.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const m of env.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)) {
  if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const { loadPinnedEventIds } = require('../api/mc/pin-busy-lib.js');
const { getPrimaryEvent, patchPrimaryEvent } = require('../api/mc/gcal-write-lib.js');

const base = process.env.MC_SUPABASE_URL;
const key = process.env.MC_SUPABASE_SERVICE_KEY;
const sb = async (q) => (await fetch(`${base}/rest/v1/${q}`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` } })).json();

const apply = process.argv.includes('--apply');
const ids = await loadPinnedEventIds(sb);
console.log(`pinned events: ${ids.size} (${apply ? 'APPLY' : 'dry run'})`);
for (const id of ids) {
  try {
    const ev = await getPrimaryEvent(id);
    if (!ev?.id || ev.status === 'cancelled') { console.log(`- ${id} gone`); continue; }
    const now = ev.transparency || 'opaque';
    const when = ev.start?.dateTime || ev.start?.date;
    console.log(`- ${when} ${ev.summary} · now ${now === 'opaque' ? 'Busy' : 'Free'}`);
    if (apply && now !== 'opaque') {
      await patchPrimaryEvent(id, { transparency: 'opaque' });
      console.log('  → set Busy');
    }
  } catch (e) {
    console.log(`- ${id} error ${e.status || ''} ${e.message}`);
  }
}
