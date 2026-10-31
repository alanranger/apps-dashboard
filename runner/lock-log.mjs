/**
 * Single-instance lock (stale after 6 h or when the holding process is gone) and a daily rotating log
 * (14 days kept) for the scheduled Update-all runner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LOCK_FILE = path.join(os.tmpdir(), 'alan-update-all-runner.lock');
export const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AlanUpdateAllRunner', 'logs');
const STALE_MS = 6 * 60 * 60 * 1000;
const KEEP_DAYS = 14;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Returns true when this process now holds the lock. */
export function acquireLock(file = LOCK_FILE) {
  if (fs.existsSync(file)) {
    const held = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    const fresh = Date.now() - Date.parse(held.at || 0) < STALE_MS;
    if (fresh && held.pid && alive(held.pid)) return false;
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: os.hostname() }));
  return true;
}

export function releaseLock(file = LOCK_FILE) {
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
    if (held.pid === process.pid) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

/** Append to today's log; prune logs older than KEEP_DAYS. */
export function logger(dir = LOG_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^runner-(\d{4}-\d\d-\d\d)\.log$/);
    if (m && Date.now() - Date.parse(m[1]) > KEEP_DAYS * 86400000) fs.unlinkSync(path.join(dir, f));
  }
  const file = path.join(dir, `runner-${day}.log`);
  return (msg) => fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
}
