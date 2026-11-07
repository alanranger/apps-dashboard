const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { testWriteRoundTrip } = require('../api/mc/gcal-write-lib.js');

async function main() {
  console.log('=== LOCAL probe ===');
  const local = await testWriteRoundTrip();
  console.log(JSON.stringify(local));

  console.log('=== VERCEL probe ===');
  const authRes = await fetch('https://apps-dashboard-lilac.vercel.app/api/mc/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.MC_AGENT_PASSWORD || process.env.MC_ALAN_PASSWORD }),
  });
  const auth = await authRes.json();
  console.log('auth', authRes.status, auth.role || auth.error);
  if (!auth.token) return;
  const res = await fetch('https://apps-dashboard-lilac.vercel.app/api/mc/gcal-flush?probe=1', {
    headers: { Authorization: `Bearer ${auth.token}`, 'x-mc-token': auth.token },
  });
  const text = await res.text();
  console.log('status', res.status);
  console.log(text.slice(0, 1200));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
