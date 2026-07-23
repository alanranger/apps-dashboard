#!/usr/bin/env node
/** Apply one SQL file to MC Supabase via DATABASE_URL or MC_DATABASE_URL in .env.local */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadEnvLocal() {
  const p = path.join(root, '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

loadEnvLocal();
const sqlFile = process.argv[2] || 'sql/014_mc_priority_p0_p5.sql';
const sql = fs.readFileSync(path.join(root, sqlFile), 'utf8');
const conn = process.env.MC_DATABASE_URL || process.env.DATABASE_URL;
if (!conn) {
  console.error('Set MC_DATABASE_URL or DATABASE_URL in .env.local');
  process.exit(1);
}

const pg = await import('pg');
const client = new pg.default.Client({
  connectionString: conn,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
try {
  await client.query(sql);
  const enums = await client.query(
    "select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='mc_priority' order by e.enumsortorder",
  );
  const cols = await client.query(
    "select column_name, column_default from information_schema.columns where table_name='recurring_tasks' and column_name='priority'",
  );
  console.log('OK', sqlFile);
  console.log('mc_priority:', enums.rows.map((r) => r.enumlabel).join(','));
  console.log('recurring_tasks.priority:', cols.rows[0] || 'MISSING');
} finally {
  await client.end();
}
