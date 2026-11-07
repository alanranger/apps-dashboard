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

  const secret = process.env.MC_SESSION_SECRET;
  if (!secret) {
    console.log('=== VERCEL skipped (no MC_SESSION_SECRET) ===');
    return;
  }
  const payload = Buffer.from(JSON.stringify({ role: 'alan', iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const token = `${payload}.${sig}`;
  const url = 'https://apps-dashboard-lilac.vercel.app/api/mc/gcal-flush?probe=1';
  console.log('=== VERCEL probe ===');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'x-mc-token': token },
  });
  const text = await res.text();
  console.log('status', res.status);
  console.log(text.slice(0, 1200));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
