/**
 * P25 (approved 31 Oct 2026): in LIVE runs a Squarespace 429 during pre-flight means "cool down 30 min, then start
 * automatically". Dry runs keep the old behaviour (retry and carry on).
 */
export const COOL_DOWN_MINUTES = 30;
const MS = COOL_DOWN_MINUTES * 60 * 1000;

/** ISO time the live run may start, or null to start now. status = the pre-flight home page status. */
export function cooldownUntil({ mode, last429At, status, now = Date.now() }) {
  if (mode !== 'live') return null;
  if (status === 429) return new Date(now + MS).toISOString();
  const last = Date.parse(last429At || '') || 0;
  return now - last < MS ? new Date(last + MS).toISOString() : null;
}

export const waitingText = (until) => `Waiting for Squarespace cool-down until ${new Date(until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })}`;
