/** Shared MC test helpers — reads env from process (never commit secrets). */

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} — copy from Vercel / .env.local`);
  return v;
}

export function mcBaseUrl() {
  return process.env.MC_BASE_URL || 'https://apps-dashboard-lilac.vercel.app';
}

export async function mcLogin(role = 'agent') {
  const password = role === 'alan'
    ? requireEnv('MC_ALAN_PASSWORD')
    : requireEnv('MC_AGENT_PASSWORD');
  const res = await fetch(`${mcBaseUrl()}/api/mc/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'login failed');
  return data;
}

export async function mcApi(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${mcBaseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  return data;
}

export async function sbGet(tableQuery) {
  const key = requireEnv('MC_SUPABASE_SERVICE_KEY');
  const url = `${requireEnv('MC_SUPABASE_URL')}/rest/v1/${tableQuery}`;
  const res = await fetch(url, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
  });
  if (!res.ok) throw new Error(`supabase GET ${tableQuery}: ${res.status}`);
  return res.json();
}

/** Pick columns for before/after evidence output. */
export function pickRow(row, cols) {
  const out = {};
  for (const c of cols) out[c] = row?.[c] ?? null;
  return out;
}

export async function recurringSnapshot(habitId) {
  const [tasks, logs] = await Promise.all([
    sbGet(`recurring_tasks?id=eq.${habitId}&select=id,title,priority,last_done,rolls_used,updated_at,scheduled_note`),
    sbGet(`recurring_log?recurring_task_id=eq.${habitId}&order=at.desc&limit=3&select=actor,change,ideal_date,scheduled_date,at`),
  ]);
  return { task: tasks[0] || null, recent_log: logs };
}

export async function sbWrite(tableQuery, { method = 'POST', body } = {}) {
  const key = requireEnv('MC_SUPABASE_SERVICE_KEY');
  const url = `${requireEnv('MC_SUPABASE_URL')}/rest/v1/${tableQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`supabase ${method} ${tableQuery}: ${res.status}`), { data });
  if (res.status === 204) return [];
  return data;
}

/** Fail if any column changed outside the allow-list (collateral-write guard). */
export function assertOnlyChanged(before, after, allowed) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const allow = new Set(allowed);
  for (const k of keys) {
    if ((before?.[k] ?? null) === (after?.[k] ?? null)) continue;
    if (!allow.has(k)) {
      throw new Error(`collateral write on ${k}: ${JSON.stringify(before?.[k])} -> ${JSON.stringify(after?.[k])}`);
    }
  }
}

const TASK_COLS = [
  'id', 'display_id', 'title', 'state', 'est_minutes', 'completed_on',
  'slot_pinned', 'slot_pinned_at', 'calendar_event_id', 'last_activity_at',
];

export async function taskSnapshot(taskId) {
  const rows = await sbGet(`tasks?id=eq.${taskId}&select=${TASK_COLS.join(',')}`);
  return rows[0] || null;
}

export async function ruleSnapshot(key) {
  const rows = await sbGet(`scheduling_rules?key=eq.${encodeURIComponent(key)}&select=key,value,updated_at`);
  return rows[0] || null;
}

export async function latestRuleAudit(key) {
  const rows = await sbGet(
    `scheduling_rules_audit?key=eq.${encodeURIComponent(key)}&order=at.desc&limit=1&select=key,old_value,new_value,changed_by,at`,
  );
  return rows[0] || null;
}

export async function pendingSnapshot(id) {
  const rows = await sbGet(
    `pending_diary_changes?id=eq.${id}&select=id,status,resolved_at,resolved_by,summary,detected_at`,
  );
  return rows[0] || null;
}

export async function taskFromBootstrap(token, taskId) {
  const data = await mcApi('/api/mc/bootstrap', { token });
  return data.tasks?.find((t) => t.id === taskId) || null;
}

export async function schedulingBundle(token) {
  return mcApi('/api/mc/scheduling', { token });
}

export function ruleFromBundle(bundle, key) {
  return bundle.rules?.find((r) => r.key === key) || null;
}

export function pendingFromBundle(bundle, id) {
  return bundle.pending?.find((p) => p.id === id) || null;
}

export async function firstProjectId(token) {
  const data = await mcApi('/api/mc/bootstrap', { token });
  const p = data.projects?.[0];
  if (!p?.id) throw new Error('no active project for test task');
  return p.id;
}
