#!/usr/bin/env node
/**
 * Mint a Google Calendar OAuth refresh token for Mission Control.
 * Scope: full calendar (read + write) — Cursor flush path.
 *
 * Usage (from apps-dashboard root):
 *   node scripts/gcal-mint-refresh-token.cjs
 *   node scripts/gcal-mint-refresh-token.cjs "C:\path\to\client_secret_....json"
 *
 * Without a JSON path, loads GCAL_CLIENT_ID / GCAL_CLIENT_SECRET from .env.local.
 * Prints the refresh token to THIS terminal only — never writes to disk/Drive/repo.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const PORT = 53683;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function loadClient(jsonPath) {
  if (jsonPath) {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const block = raw.installed || raw.web;
    if (!block?.client_id || !block?.client_secret) {
      throw new Error('JSON must contain installed/web.client_id and client_secret');
    }
    return block;
  }
  loadEnvLocal();
  if (!process.env.GCAL_CLIENT_ID || !process.env.GCAL_CLIENT_SECRET) {
    throw new Error('Pass client_secret.json OR set GCAL_CLIENT_ID + GCAL_CLIENT_SECRET in .env.local');
  }
  return {
    client_id: process.env.GCAL_CLIENT_ID,
    client_secret: process.env.GCAL_CLIENT_SECRET,
  };
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
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  return json;
}

function main() {
  const jsonPath = process.argv[2];
  if (jsonPath && !fs.existsSync(jsonPath)) {
    console.error('Usage: node scripts/gcal-mint-refresh-token.cjs [path-to-client-secret.json]');
    process.exit(1);
  }

  let client;
  try { client = loadClient(jsonPath || null); }
  catch (e) { console.error(e.message); process.exit(1); }

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
        res.writeHead(404); res.end('Not found'); return;
      }
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${err}`);
        console.error('Consent failed:', err);
        server.close(); process.exit(1);
      }
      const code = u.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing code'); return;
      }

      const tokens = await exchangeCode(client, code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>OK — return to the terminal.</h1><p>You can close this tab.</p>');

      console.log('');
      console.log('=== SUCCESS — paste into .env.local AND Vercel (apps-dashboard) ===');
      console.log('GCAL_CLIENT_ID=' + client.client_id);
      console.log('GCAL_USER=info@alanranger.com');
      console.log('Scope=https://www.googleapis.com/auth/calendar (read+write)');
      if (tokens.refresh_token) {
        console.log('GCAL_REFRESH_TOKEN=' + tokens.refresh_token);
      } else {
        console.error('ERROR: no refresh_token. Revoke prior access at https://myaccount.google.com/permissions and re-run.');
        server.close(); process.exit(1);
      }
      console.log('=== end — token was NOT saved to any file ===');
      setTimeout(() => { try { server.close(); } catch (_) { /* ignore */ } process.exit(0); }, 500);
    } catch (e) {
      console.error(e.message || e);
      try { res.writeHead(500); res.end('Token exchange failed — see terminal'); } catch (_) { /* ignore */ }
      setTimeout(() => { try { server.close(); } catch (_) { /* ignore */ } process.exit(1); }, 500);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Listening on ${REDIRECT}`);
    console.log('Opening browser for consent (calendar READ+WRITE)…');
    console.log('If the browser does not open, paste this URL manually:');
    console.log(auth.toString());
    console.log('');
    console.log('Sign in as info@alanranger.com. Unverified-app warning → Advanced → Continue.');
    openBrowser(auth.toString());
  });
}

main();
