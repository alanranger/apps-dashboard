// Read-only: recurring_log rows for "Monthly Accounts — Bank Genie" (Alan moved it on 2 Nov).
import fs from 'node:fs';

const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const sb = async (q) => (await fetch(`${get('MC_SUPABASE_URL')}/rest/v1/${q}`, {
  headers: { apikey: get('MC_SUPABASE_SERVICE_KEY'), Authorization: `Bearer ${get('MC_SUPABASE_SERVICE_KEY')}` } })).json();

const HABIT = '02d10c2d-15bf-4684-8b1a-ff65aaa6cd3b';
const logs = await sb(`recurring_log?recurring_task_id=eq.${HABIT}&or=(roll_reason.eq.diary_manual_pin,scheduled_date.gte.2026-11-01)&select=id,at,actor,change,roll_reason,ideal_date,scheduled_date,calendar_event_id,projection_key&order=scheduled_date.asc&limit=12`);
console.log(JSON.stringify(logs, null, 1));
const push = await sb(`gcal_push_queue?summary=ilike.*bank%20genie*&select=created_at,status,change_kind,summary&order=created_at.desc&limit=4`);
console.log('push queue:', JSON.stringify(push, null, 1));
