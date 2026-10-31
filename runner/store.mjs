/**
 * Run/step state for the Update-all runner: Supabase (update_all_runs / update_all_steps) or in-memory (tests).
 */
import fs from 'node:fs';

export function loadEnv(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, '')]));
}

export function supabaseStore({ url, key }) {
  const call = async (path, { method = 'GET', body, prefer = 'return=representation' } = {}) => {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: prefer }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`supabase ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    createRun: async (run) => (await call('update_all_runs', { method: 'POST', body: run }))[0],
    getRun: async (id) => (await call(`update_all_runs?id=eq.${id}`))[0] || null,
    /** Oldest requested run whose Squarespace cool-down (cooldown_until, live only) has passed. */
    nextRequested: async () => (await call(`update_all_runs?status=eq.requested&or=(cooldown_until.is.null,cooldown_until.lte.${new Date().toISOString()})&order=requested_at.asc&limit=1`))[0] || null,
    updateRun: (id, patch) => call(`update_all_runs?id=eq.${id}`, { method: 'PATCH', body: patch }),
    listSteps: (runId) => call(`update_all_steps?run_id=eq.${runId}&order=ord.asc`),
    insertSteps: (rows) => call('update_all_steps?on_conflict=run_id,step_id', { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates,return=minimal' }),
    updateStep: (runId, stepId, patch) => call(`update_all_steps?run_id=eq.${runId}&step_id=eq.${stepId}`, { method: 'PATCH', body: patch }),
    query: call,
    /** Paged read of every row (PostgREST caps a single response at 1000). */
    queryAll: async (pathAndQuery) => {
      const rows = [];
      for (let offset = 0; ; offset += 1000) {
        const page = await call(`${pathAndQuery}&order=id.asc&limit=1000&offset=${offset}`);
        rows.push(...page);
        if (page.length < 1000) return rows;
      }
    }
  };
}

export function memoryStore() {
  const runs = new Map();
  const steps = [];
  let n = 0;
  return {
    runs, steps,
    createRun: async (run) => { const r = { id: `run-${(n += 1)}`, status: 'requested', ...run }; runs.set(r.id, r); return r; },
    getRun: async (id) => runs.get(id) || null,
    nextRequested: async () => [...runs.values()].find((r) => r.status === 'requested' && !(r.cooldown_until && Date.parse(r.cooldown_until) > Date.now())) || null,
    updateRun: async (id, patch) => Object.assign(runs.get(id), patch),
    listSteps: async (runId) => steps.filter((s) => s.run_id === runId).sort((a, b) => a.ord - b.ord),
    insertSteps: async (rows) => rows.forEach((r) => { if (!steps.some((s) => s.run_id === r.run_id && s.step_id === r.step_id)) steps.push({ ...r }); }),
    updateStep: async (runId, stepId, patch) => Object.assign(steps.find((s) => s.run_id === runId && s.step_id === stepId), patch)
  };
}
