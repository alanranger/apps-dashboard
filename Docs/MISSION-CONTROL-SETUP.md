# Mission Control setup

## Repo (keep this clean)

| Item | Location |
|------|----------|
| **GitHub repo** | `alanranger/apps-dashboard` only |
| **Not in** | AI GEO Audit, Chat AI Bot, Academy |
| **Live URL** | https://apps-dashboard-lilac.vercel.app |
| **Vercel project** | Must be the one wired to `apps-dashboard-lilac` — **not** ai-geo-audit |

If Mission Control shows `MC_SUPABASE_NOT_CONFIGURED` while Version pill shows an `apps-dashboard` commit, the five `MC_*` env vars were almost certainly added on the **wrong** Vercel project (e.g. one that also has `GOOGLE_*` / `ACADEMY_*` keys).

## Frontend modules (`mc/`)

| File | Role |
|------|------|
| `app.js` | Boot, login, wiring |
| `api.js` | Fetch + auth header |
| `session.js` | Token / role |
| `store.js` | In-memory board state |
| `render-home.js` | Home queues |
| `render-board.js` | Project board |
| `drawer.js` | Task drawer + comments |
| `modal.js` | New task modal |
| `util.js` | Shared helpers |
| `tokens.css` / `styles.css` | UI law + layout |
| `version-pill.js` | Version / Built / Loaded |

API lives under `api/mc/` (already modular). SQL: `sql/001_mission_control.sql`.

## Database

Hosted on existing Supabase **alan-chat-rag** (`igzvwbvgvmzvvzoclufx`) — schema already applied.

## Env vars (on **apps-dashboard** Vercel project only)

| Name | Value |
|------|--------|
| `MC_SUPABASE_URL` | `https://igzvwbvgvmzvvzoclufx.supabase.co` |
| `MC_SUPABASE_SERVICE_KEY` | service_role for alan-chat-rag |
| `MC_SESSION_SECRET` | long random string |
| `MC_ALAN_PASSWORD` | Alan login |
| `MC_AGENT_PASSWORD` | Claude/Cursor agent login |

Redeploy after saving. Confirm Production scope.
