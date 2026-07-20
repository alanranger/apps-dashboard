const { envReady, json, cors, sb } = require('./_lib');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return json(res, 405, { count: 0 });
  if (!envReady()) return json(res, 200, { count: 0, configured: false });
  try {
    const rows = await sb('tasks?state=eq.done_claimed&select=id', {
      headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' },
    });
    const n = Array.isArray(rows) ? rows.length : 0;
    // Prefer Content-Range via a second head-style call is awkward; count via full select for small tables
    const all = await sb('tasks?state=eq.done_claimed&select=id');
    return json(res, 200, { count: Array.isArray(all) ? all.length : n, configured: true });
  } catch (e) {
    return json(res, 200, { count: 0, configured: true, error: 'fail-silent' });
  }
};
