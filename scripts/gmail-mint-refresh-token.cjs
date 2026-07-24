#!/usr/bin/env node
/**
 * ONE-OFF: mint a Gmail OAuth refresh token for Mission Control.
 *
 * Usage (from apps-dashboard root):
 *   node scripts/gmail-mint-refresh-token.cjs "C:\path\to\client_secret_....json"
 *
 * - Opens a browser for consent (gmail.readonly only)
 * - Prints the refresh token to THIS terminal only
 * - Does NOT write the token to disk, Drive, or the repo
 *
 * After success: paste into Vercel env as GMAIL_REFRESH_TOKEN, then delete this script if you like.
 */
const fs = require('fs');
const http = require('http');
const { URL } = require('url');
const { exec } = require('child_process');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;

function loadClient(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const block = raw.installed || raw.web;
  if (!block?.client_id || !block?.client_secret) {
    throw new Error('JSON must contain installed/web.client_id and client_secret');
  }
  return block;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd);
}

async function exchangeCode(client, code) {
  const body = new URLSearchParams({
    code,
    client_id: client.client_id,
    client_secret: client.client_secret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  }
  return json;
}

function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error('Usage: node scripts/gmail-mint-refresh-token.cjs <path-to-client-secret.json>');
    process.exit(1);
  }
  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }

  const client = loadClient(jsonPath);
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', client.client_id);
  auth.searchParams.set('redirect_uri', REDIRECT);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', SCOPE);
  auth.searchParams.set('access_type', 'offline');
  auth.searchParams.set('prompt', 'consent');
  auth.searchParams.set('include_granted_scopes', 'false');

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      if (u.pathname !== '/oauth2callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${err}`);
        console.error('Consent failed:', err);
        server.close();
        process.exit(1);
      }
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code');
        return;
      }

      const tokens = await exchangeCode(client, code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>OK — return to the terminal.</h1><p>You can close this tab.</p>');

      console.log('');
      console.log('=== SUCCESS — copy into Vercel (apps-dashboard) ===');
      console.log('GMAIL_CLIENT_ID=' + client.client_id);
      console.log('GMAIL_CLIENT_SECRET=(from your JSON — not re-printed here)');
      console.log('GMAIL_USER=info@alanranger.com');
      if (tokens.refresh_token) {
        console.log('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);
      } else {
        console.error('ERROR: no refresh_token in response. Re-run with prompt=consent (already set), or revoke prior access at https://myaccount.google.com/permissions and try again.');
        console.error('Keys received:', Object.keys(tokens).join(', '));
        server.close();
        process.exit(1);
      }
      console.log('=== end — token was NOT saved to any file ===');
      console.log('');
      server.close();
      process.exit(0);
    } catch (e) {
      console.error(e.message || e);
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Token exchange failed — see terminal');
      } catch (_) { /* ignore */ }
      server.close();
      process.exit(1);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Listening on ${REDIRECT}`);
    console.log('Opening browser for consent (gmail.readonly only)…');
    console.log('If the browser does not open, paste this URL manually:');
    console.log(auth.toString());
    console.log('');
    console.log('Sign in as info@alanranger.com. Unverified-app warning → Advanced → Continue.');
    openBrowser(auth.toString());
  });
}

main();
