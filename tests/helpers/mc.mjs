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
    sbGet(`recurring_tasks?id=eq.${habitId}&select=id,title,last_done,rolls_used,updated_at,scheduled_note`),
    sbGet(`recurring_log?recurring_task_id=eq.${habitId}&order=at.desc&limit=3&select=actor,change,ideal_date,scheduled_date,at`),
  ]);
  return { task: tasks[0] || null, recent_log: logs };
}
