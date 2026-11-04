/**
 * Guard for every Playwright spec that runs against the production BAU page (Alan 4 Nov). The test account signs in as
 * role alan, so it could really start, publish or undo. Specs import `test` / `expect` from here instead of
 * '@playwright/test':
 *  - every browser POST / PUT / PATCH / DELETE to /api/* is aborted before it leaves the browser and recorded;
 *  - a test that tried one fails (unless it sets test.use({ expectBlockedWrites: true }) to prove the block);
 *  - spec routes can't let a write through: their handlers only ever see reads (writes fall back to the guard);
 *  - page.request is read-only;
 *  - node-side writes: refusedLiveRunAll (refused by the API before anything is created) is the only one allowed.
 */
import { test as base, expect } from '@playwright/test';
import { mcBaseUrl } from './mc.mjs';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const apiUrl = (u) => u.pathname.startsWith('/api/');
const isWrite = (req) => WRITE.has(req.method()) && apiUrl(new URL(req.url()));

function blocker(blocked) {
  return (route) => {
    const req = route.request();
    if (!isWrite(req)) return route.fallback();
    blocked.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() || '' });
    return route.abort('blockedbyclient');
  };
}

/** page.request with reads only: any write is recorded and throws. */
function readOnlyRequest(real, blocked) {
  const deny = (method, url) => { blocked.push({ method, path: String(url), body: '(page.request)' }); throw new Error(`BAU guard: page.request ${method} ${url} blocked`); };
  return {
    get: (url, opts) => real.get(url, opts),
    head: (url, opts) => real.head(url, opts),
    fetch: (url, opts = {}) => (WRITE.has(String(opts.method || 'GET').toUpperCase()) ? deny(opts.method, url) : real.fetch(url, opts)),
    post: (url) => deny('POST', url), put: (url) => deny('PUT', url), patch: (url) => deny('PATCH', url), delete: (url) => deny('DELETE', url),
  };
}

async function guardPage(page, blocked) {
  await page.context().route(apiUrl, blocker(blocked));
  await page.route(apiUrl, blocker(blocked));
  const route = page.route.bind(page);
  page.route = (url, handler, opts) => route(url, (r, req) => (isWrite(r.request()) ? r.fallback() : handler(r, req)), opts);
  const request = readOnlyRequest(page.request, blocked);
  Object.defineProperty(page, 'request', { get: () => request });
}

export const test = base.extend({
  expectBlockedWrites: [false, { option: true }],
  blockedWrites: async ({}, use) => { await use([]); },
  page: async ({ page, blockedWrites, expectBlockedWrites }, use) => {
    await guardPage(page, blockedWrites);
    await use(page);
    if (!expectBlockedWrites) expect(blockedWrites, 'BAU guard: this test tried to write (start / publish / undo / save) and was blocked').toEqual([]);
  },
});
export { expect };

/** The one node-side write BAU specs may send: a Live Run all, which the API refuses (400) before creating anything. */
export async function refusedLiveRunAll(token) {
  const res = await fetch(`${mcBaseUrl()}/api/update-all`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-mc-token': token, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'start', mode: 'live' }) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, message: data.error || '' };
}

/** Any other node-side write from a BAU spec is refused here, so the spec fails instead of sending it. */
export function nodeWrite(what) {
  throw new Error(`BAU guard: node-side write blocked (${what}). BAU specs may not start, publish, undo or save anything.`);
}
