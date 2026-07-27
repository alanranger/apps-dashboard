import { token, agentActor } from './session.js';

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
    throw Object.assign(new Error(data.error || res.statusText), { data, status: res.status });
  }
  return data;
}
