import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const password = env.MC_AGENT_PASSWORD || env.MC_ALAN_PASSWORD;
if (!password) {
  console.error('no MC password in .env.local');
  process.exit(1);
}
const res = await fetch('https://apps-dashboard-lilac.vercel.app/api/mc/auth', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password }),
});
const j = await res.json();
if (!j.token) {
  console.error('auth fail', j);
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'tmp/mc-agent-token.txt'), j.token);
console.log('ok role=' + (j.role || '?') + ' len=' + j.token.length);
