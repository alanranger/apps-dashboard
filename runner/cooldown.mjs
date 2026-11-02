/**
 * P25 (approved 31 Oct 2026): in LIVE runs a Squarespace 429 during pre-flight means "cool down 30 min, then start
 * automatically". Dry runs keep the old behaviour (retry and carry on).
 * Batch 8: Retry-After is honoured (when longer), the check after a cool-down probes a different lightweight URL,
 * and a run parked more than twice in a row goes to Needs Alan instead of looping silently.
 */
export const COOL_DOWN_MINUTES = 30;
const MS = COOL_DOWN_MINUTES * 60 * 1000;
export const MAX_PARKS = 2;
export const PROBES = ['https://www.alanranger.com/', 'https://www.alanranger.com/robots.txt'];

/** ISO time the live run may start, or null to start now. status = the pre-flight probe status. */
export function cooldownUntil({ mode, last429At, status, retryAfterMs = 0, now = Date.now() }) {
  if (mode !== 'live') return null;
  if (status === 429) return new Date(now + Math.max(MS, retryAfterMs || 0)).toISOString();
  const last = Date.parse(last429At || '') || 0;
  return now - last < MS ? new Date(last + MS).toISOString() : null;
}

/** Probe for this attempt: the home page first, then (after a cool-down) robots.txt, so the same request isn't repeated. */
export const probeFor = (parks) => PROBES[Math.min(parks, PROBES.length - 1)];

/**
 * What the runner does with a live run after its pre-flight probe:
 *   go         — no cool-down: start (and reset the park count);
 *   wait       — still inside an earlier cool-down (no new 429): stay parked, count unchanged;
 *   park       — a fresh 429: park until `until`, count + 1;
 *   needs_alan — a fresh 429 after MAX_PARKS parks in a row: stop and ask Alan.
 */
export function parkDecision({ status, until, parks = 0 }) {
  if (!until) return 'go';
  if (status !== 429) return 'wait';
  return parks >= MAX_PARKS ? 'needs_alan' : 'park';
}

export const rateLimitedNeed = (parks) => ({ kind: 'site_rate_limited', count: parks + 1,
  file: `Squarespace rate-limited the pre-flight check ${parks + 1} times in a row, so the live run was stopped. Start it again later (or tell Claude if it keeps happening).` });

export const waitingText = (until) => `Waiting for Squarespace cool-down until ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}`;
