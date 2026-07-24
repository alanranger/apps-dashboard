/**
 * Gmail readonly helper for Mission Control (OAuth refresh token).
 * Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, optional GMAIL_USER
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

function gmailEnvFlags() {
  return {
    GMAIL_CLIENT_ID: !!process.env.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: !!process.env.GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: !!process.env.GMAIL_REFRESH_TOKEN,
    GMAIL_USER: !!process.env.GMAIL_USER,
    GMAIL_HOTEL_LABEL_ID: !!process.env.GMAIL_HOTEL_LABEL_ID,
  };
}

function gmailConfigured() {
  const f = gmailEnvFlags();
  return !!(f.GMAIL_CLIENT_ID && f.GMAIL_CLIENT_SECRET && f.GMAIL_REFRESH_TOKEN);
}

async function getAccessToken() {
  if (!gmailConfigured()) {
    const err = new Error('GMAIL_NOT_CONFIGURED');
    err.status = 503;
    throw err;
  }
  const body = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: process.env.GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    const err = new Error(json.error_description || json.error || 'gmail token refresh failed');
    err.status = 502;
    err.data = json;
    throw err;
  }
  return json.access_token;
}

async function gmailFetch(path, accessToken, opts = {}) {
  const url = path.startsWith('http') ? path : `${GMAIL_API}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || res.statusText || 'gmail api error');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * List message ids under a label (newest first).
 */
async function listLabelMessageIds(accessToken, labelId, max = 120) {
  const ids = [];
  let pageToken = null;
  while (ids.length < max) {
    const params = new URLSearchParams({
      labelIds: labelId,
      maxResults: String(Math.min(50, max - ids.length)),
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gmailFetch(`/users/me/messages?${params}`, accessToken);
    for (const m of data.messages || []) ids.push(m.id);
    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }
  return ids;
}

function headerMap(payload) {
  const out = {};
  for (const h of payload?.headers || []) {
    out[String(h.name || '').toLowerCase()] = h.value || '';
  }
  return out;
}

function decodePartData(data) {
  if (!data) return '';
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function collectBodies(part, acc) {
  if (!part) return;
  if (part.body?.data && (!part.mimeType || /text\/(plain|html)/i.test(part.mimeType))) {
    acc.push(decodePartData(part.body.data));
  }
  for (const p of part.parts || []) collectBodies(p, acc);
}

async function getMessage(accessToken, id) {
  const data = await gmailFetch(
    `/users/me/messages/${id}?format=full`,
    accessToken,
  );
  const headers = headerMap(data.payload);
  const bodies = [];
  collectBodies(data.payload, bodies);
  const bodyText = bodies.join('\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    id: data.id,
    threadId: data.threadId,
    internalDate: data.internalDate ? new Date(Number(data.internalDate)).toISOString() : null,
    subject: headers.subject || '',
    from: headers.from || '',
    snippet: data.snippet || '',
    bodyText: bodyText.slice(0, 12000),
  };
}

module.exports = {
  gmailConfigured,
  gmailEnvFlags,
  getAccessToken,
  listLabelMessageIds,
  getMessage,
};
