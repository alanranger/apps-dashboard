const crypto = require('crypto');

function envReady() {
  return !!(
    process.env.MC_SUPABASE_URL &&
    process.env.MC_SUPABASE_SERVICE_KEY &&
    process.env.MC_SESSION_SECRET &&
    process.env.MC_ALAN_PASSWORD &&
    process.env.MC_AGENT_PASSWORD
  );
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mc-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.end(JSON.stringify(body));
}

function cors(req, res) {
  if (req.method === 'OPTIONS') {
    json(res, 204, {});
    return true;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e6) reject(new Error('body too large')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signSession(role) {
  const payload = b64url(JSON.stringify({ role, iat: Date.now() }));
  const sig = crypto.createHmac('sha256', process.env.MC_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function parseSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = crypto.createHmac('sha256', process.env.MC_SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.role !== 'alan' && data.role !== 'agent') return null;
    return data;
  } catch (e) {
    return null;
  }
}

function getToken(req) {
  const h = req.headers.authorization || req.headers['x-mc-token'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return h;
}

function requireAuth(req, res) {
  const session = parseSession(getToken(req));
  if (!session) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  return session;
}

function actorFromSession(session, body) {
  if (session.role === 'alan') return 'alan';
  const want = String((body && body.actor) || 'cursor');
  return want === 'claude' ? 'claude' : 'cursor';
}

async function sb(path, opts = {}) {
  const url = `${process.env.MC_SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: process.env.MC_SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${process.env.MC_SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: opts.prefer || 'return=representation',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText || 'supabase error');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function logChange(taskId, actor, change) {
  await sb('task_log', { method: 'POST', body: { task_id: taskId, actor, change } });
}

async function touchActivity(taskId) {
  await sb(`tasks?id=eq.${taskId}`, {
    method: 'PATCH',
    body: { last_activity_at: new Date().toISOString() },
  });
}

function nextDueFromRecurrence(recurrence, fromDate) {
  if (!recurrence) return null;
  const base = fromDate ? new Date(fromDate) : new Date();
  if (recurrence.startsWith('weekly:')) {
    const dow = Number(recurrence.split(':')[1]);
    const d = new Date(base);
    d.setDate(d.getDate() + 1);
    while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (recurrence.startsWith('monthly:')) {
    const dom = Number(recurrence.split(':')[1]);
    const d = new Date(base.getFullYear(), base.getMonth() + 1, Math.min(dom, 28));
    return d.toISOString().slice(0, 10);
  }
  return null;
}

async function spawnRecurrence(task, actor) {
  if (!task.recurrence) return null;
  const due = nextDueFromRecurrence(task.recurrence, task.due_date || new Date());
  const rows = await sb('tasks', {
    method: 'POST',
    body: {
      project_id: task.project_id,
      title: task.title,
      detail_md: task.detail_md,
      owner: task.owner,
      state: 'todo',
      next_step: task.next_step,
      due_date: due,
      waiting_on: null,
      priority: task.priority,
      recurrence: task.recurrence,
    },
  });
  const spawned = Array.isArray(rows) ? rows[0] : rows;
  if (spawned?.id) {
    await logChange(spawned.id, actor, `spawned from MC-${task.display_id} recurrence`);
  }
  return spawned;
}

module.exports = {
  envReady,
  json,
  cors,
  readBody,
  signSession,
  requireAuth,
  actorFromSession,
  sb,
  logChange,
  touchActivity,
  spawnRecurrence,
};
