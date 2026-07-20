const crypto = require('crypto');
const {
  envReady, json, cors, readBody, requireAuth, actorFromSession, sb, logChange, touchActivity,
} = require('./_lib');

async function signedUpload(path) {
  const url = `${process.env.MC_SUPABASE_URL}/storage/v1/object/upload/sign/mc-attachments/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.MC_SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.MC_SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || 'sign upload failed');
    err.status = res.status;
    throw err;
  }
  const token = data.token;
  return {
    path,
    uploadUrl: `${process.env.MC_SUPABASE_URL}/storage/v1/object/upload/sign/mc-attachments/${path}?token=${token}`,
  };
}

async function signedRead(path) {
  const url = `${process.env.MC_SUPABASE_URL}/storage/v1/object/sign/mc-attachments/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: process.env.MC_SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.MC_SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const data = await res.json();
  if (!res.ok) return null;
  return `${process.env.MC_SUPABASE_URL}/storage/v1${data.signedURL || data.signedUrl}`;
}

async function postComment(body, actor) {
  const taskId = body.task_id;
  const text = String(body.body_md || '').trim();
  if (!taskId || !text) {
    const err = new Error('task_id and body_md required');
    err.status = 400;
    throw err;
  }
  const images = Array.isArray(body.image_urls) ? body.image_urls : [];
  const rows = await sb('task_comments', {
    method: 'POST',
    body: {
      task_id: taskId,
      author: actor,
      body_md: text,
      image_urls: images,
      kind: body.kind || 'comment',
    },
  });
  await touchActivity(taskId);
  await logChange(taskId, actor, `comment: ${text.slice(0, 80)}`);
  const comment = rows?.[0];
  const signed = [];
  for (const p of images) {
    signed.push(await signedRead(p));
  }
  return { comment, signed_urls: signed };
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  const session = requireAuth(req, res);
  if (!session) return;
  try {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const actor = actorFromSession(session, body);
      if (body.action === 'sign_upload') {
        const ext = String(body.ext || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const path = `${body.task_id || 'misc'}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
        return json(res, 200, await signedUpload(path));
      }
      if (body.action === 'sign_read') {
        return json(res, 200, { url: await signedRead(body.path) });
      }
      return json(res, 201, await postComment(body, actor));
    }
    return json(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message || 'comment error', detail: e.data });
  }
};
