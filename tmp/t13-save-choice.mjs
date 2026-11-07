// Batch 8 task 13: Alan decided the real held review (QUESTION addendum 16:02) — saved through the held-review
// buttons' API (POST /api/update-all {action:'review_choice'}), keyed by the opaque review key only.
import { mcBaseUrl, mcLogin } from '../tests/helpers/mc.mjs';

const { token } = await mcLogin('agent');
const res = await fetch(`${mcBaseUrl()}/api/update-all`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-mc-token': token },
  body: JSON.stringify({ action: 'review_choice', review_key: '75cd3928df67481b806c', choice: 'product',
    product_slug: 'landscape-peak-district-photography-workshops-derbyshire', suggested: 'landscape-peak-district-photography-workshops-derbyshire' }),
});
const body = await res.json();
console.log(res.status, JSON.stringify({ review_key: body.choice?.review_key, choice: body.choice?.choice, product_slug: body.choice?.product_slug, decided_at: body.choice?.decided_at, error: body.error }));
