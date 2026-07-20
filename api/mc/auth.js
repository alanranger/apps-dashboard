const { envReady, json, cors, readBody, signSession } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (!envReady()) return json(res, 503, { error: 'MC_SUPABASE_NOT_CONFIGURED' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  try {
    const body = await readBody(req);
    const password = String(body.password || '');
    if (password && password === process.env.MC_ALAN_PASSWORD) {
      return json(res, 200, { token: signSession('alan'), role: 'alan' });
    }
    if (password && password === process.env.MC_AGENT_PASSWORD) {
      return json(res, 200, { token: signSession('agent'), role: 'agent' });
    }
    return json(res, 401, { error: 'invalid password' });
  } catch (e) {
    return json(res, 400, { error: e.message || 'bad request' });
  }
};
