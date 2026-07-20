# Mission Control setup

**Database host:** existing Supabase project **alan-chat-rag** (`igzvwbvgvmzvvzoclufx`) — shared with Chat/AI GEO to avoid a fourth compute bill. Schema applied 20 Jul 2026.

Do **not** create a new Supabase project for Mission Control.

## Alan — remaining step (Vercel env + passwords)

In Vercel → project **apps-dashboard** → Environment Variables (Production + Preview), set:

| Name | Value |
|------|--------|
| `MC_SUPABASE_URL` | `https://igzvwbvgvmzvvzoclufx.supabase.co` |
| `MC_SUPABASE_SERVICE_KEY` | Same **service_role** key as AI GEO / Chat for this project (Settings → API) |
| `MC_SESSION_SECRET` | Long random string (password manager generate) |
| `MC_ALAN_PASSWORD` | Your Mission Control login (sole Verify) |
| `MC_AGENT_PASSWORD` | Shared Claude + Cursor agent login |

Then **redeploy** apps-dashboard.

## URLs

- UI: https://apps-dashboard-lilac.vercel.app/mission-control  
- Public count: `GET /api/mc/public-count`

## Cost follow-up (seeded on board)

Project **Platform & costs** includes task: *Migrate football-tracker Supabase into alan-chat-rag* (retire the MICRO project after cut-over).
