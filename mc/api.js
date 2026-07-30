import { token, agentActor } from './session.js';

function errorMessage(data, res) {
  const raw = data?.error ?? data?.message ?? null;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (raw && typeof raw === 'object') {
    const nested = raw.message || raw.error || raw.code;
    if (nested) return String(nested);
    try { return JSON.stringify(raw); } catch (_) { /* ignore */ }
  }
  if (data?.detail) {
    const d = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    if (d && d !== '{}') return d.slice(0, 300);
  }
  const st = res.statusText && res.statusText !== 'Error' ? res.statusText : '';
  if (st) return `${res.status} ${st}`;
  if (res.status === 504 || res.status === 502) {
    return `${res.status} gateway timeout — try Next 8 weeks first, or wait and retry Full horizon`;
  }
  if (res.status === 500) {
    return 'HTTP 500 — server timed out or crashed. Use Next 8 weeks for placer/heal; Full is detect-only after deploy.';
  }
  return `HTTP ${res.status || '?'} (no error body)`;
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  let body = opts.body;
  if (body && typeof body === 'object' && !body.actor) body = { ...body, actor: agentActor() };
  const { signal, ...rest } = opts;
  const res = await fetch(path, {
    ...rest,
    signal,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(errorMessage(data, res)), { data, status: res.status });
  }
  return data;
}
