# Mission Control test suite

## Prerequisites

Set env vars (from Vercel **apps-dashboard** project or local `.env.local`):

| Variable | Purpose |
|----------|---------|
| `MC_BASE_URL` | Default `https://apps-dashboard-lilac.vercel.app` |
| `MC_SUPABASE_URL` | DB assertions |
| `MC_SUPABASE_SERVICE_KEY` | Read-only row snapshots |
| `MC_AGENT_PASSWORD` | API integration tests |
| `MC_ALAN_PASSWORD` | UI Skip chip test (optional) |

## Run

```bash
cd apps-dashboard
npm install
npm run test:logic    # RRULE, rule_breach, regression — no secrets
npm run test:e2e      # Playwright API + UI (needs env above)
```

## CI

- **`test:logic`** runs on every push (no secrets).
- **`test:e2e`** needs the five `MC_*` vars as GitHub Actions secrets; skip gracefully when missing.

## Evidence format

E2E tests `console.log` **before/after** JSON for `last_done`, `rolls_used`, `scheduled_note`, plus the newest `recurring_log` row. Collateral writes fail the assertion.

## Calendar

Google Calendar is **not** accessed in tests. Habit placement is stubbed via API write-back only; calendar-dependent flows are documented as manual / Claude-side.

## Coverage map

| Area | Logic | E2E API | E2E UI |
|------|-------|---------|--------|
| Skip no last_done | — | ✅ | ✅ chip |
| Mark done | — | ✅ | — |
| RRULE 10 habits | ✅ | — | — |
| rule_breach 11 Aug | ✅ | — | — |
| habit-projection source | ✅ | — | — |
| Dropbox caption regression | ✅ | — | — |
| Scheduling rules save + cap behaviour | — | ✅ | — |
| Pending dismiss / applied | — | ✅ | — |
| CSV freshness badge | — | ✅ | — |
| Task drawer estimate / complete / unpin | — | ✅ | — |

Extend `tests/e2e/` following the same before/after snapshot pattern.
