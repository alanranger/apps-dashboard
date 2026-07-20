// Deployed build identity for Version / Built / Loaded pill (GAIO / football pattern).
const BUILD_TIMESTAMP = new Date().toISOString();

function shortSha(sha) {
  if (!sha || typeof sha !== 'string') return 'local';
  return sha.slice(0, 7);
}

module.exports = async function handler(req, res) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.statusCode = 200;
  res.end(JSON.stringify({
    commitHash: shortSha(sha),
    commitFull: sha || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    deploymentTimestamp: BUILD_TIMESTAMP,
    env: process.env.VERCEL_ENV || 'development',
    source: sha ? 'vercel' : 'local',
  }));
};
