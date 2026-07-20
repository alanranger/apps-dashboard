# Mission Control setup (Alan — one provisioning step)

Code is shipped. Live data waits on a **new dedicated Supabase project** (do not reuse AI GEO / Academy / Chat).

## Your one step

1. **Create** a new Supabase project (name suggestion: `mission-control`).
2. In SQL Editor, run `sql/001_mission_control.sql` from this repo (creates tables, sequence, storage bucket row, seeds).
3. In Storage, confirm bucket `mc-attachments` exists and is **private**.
4. Add these **Vercel env vars** on project `apps-dashboard` (Production + Preview), then redeploy:

| Name | Value |
|------|--------|
| `MC_SUPABASE_URL` | Project URL |
| `MC_SUPABASE_SERVICE_KEY` | Service role key (server only) |
| `MC_SESSION_SECRET` | Long random string |
| `MC_ALAN_PASSWORD` | Your password (sole Verify) |
| `MC_AGENT_PASSWORD` | Shared agent password for Claude + Cursor |

5. Give Claude the new project connector (same service or scoped key per your usual practice).
6. Give Cursor the same five values in its env / Vercel (agent password — cannot verify).

## URLs

- UI: `https://apps-dashboard-lilac.vercel.app/mission-control`
- Public count (audit chip): `GET /api/mc/public-count` → `{ count }`

## Roles

| Role | Can |
|------|-----|
| `alan` | Everything including Verify + Send back |
| `agent` | Create/update/claim/comment — **not** Verify |
