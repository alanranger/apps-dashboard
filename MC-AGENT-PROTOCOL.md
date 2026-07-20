# Mission Control — agent protocol

Canonical task IDs look like **MC-14**. Chat instructions such as “work on MC-14” refer to that display ID. Related QUESTION/RESPONSE filenames SHOULD include the ID (e.g. `QUESTION-2026-07-22-MC-14-…`).

Both Claude and Cursor write to the same Mission Control database (alan-chat-rag). The board is the single source of truth for **tasks**. Drive inbox/outbox remains the transport for **long-form** handoffs; MC stores references + short summaries + Alan’s notes/screenshots — not full Drive file copies.

Map page: https://apps-dashboard-lilac.vercel.app/handoff

## Credentials

- Use the **agent** password / session (`role=agent`).
- Server rejects `verified` for agent role. Never attempt to verify.
- Pass `actor: claude` or `actor: cursor` on API writes so the log is accurate.

## When instructed on MC-{n}

1. Open the task. **Read all notes and screenshots first** — that is Alan’s reply channel.
2. Set state `in_progress`.
3. Add a comment: `started via {cursor|claude} instruction`.
4. Do the work (only if you are the sensible owner, or after coordinating in comments).
5. Set `evidence_url` (commit, RESPONSE path, URL, etc.).
6. Set state `done_claimed` (API requires evidence).
7. Add a short summary comment (2–3 lines). If a Drive RESPONSE was written, set `response_file` / `question_file` and comment the summary.

Do not skip state writes. `task_log` actor must be accurate (`cursor` or `claude`).

## Impact × Difficulty (priority matrix)

Each task has `impact` and `difficulty` (`HIGH` | `MEDIUM` | `LOW`) for the Dashboard priority matrix (same pattern as URL Money Pages). Agents may set these via PATCH `/api/mc/tasks` or the task drawer. Keep ops `priority` (p0/p1/p2) for urgency separately.

## Task `why` (Next up card)

Each task may have a nullable `why` text field — one line explaining what the task unblocks or what it costs if delayed. **Every task you touch gets/keeps a one-line why.** Set via drawer or PATCH `/api/mc/tasks`. If empty, the UI falls back to `Blocks {n} task(s)` from reverse `depends_on` count; omit the line if zero.

## Alan notes + screenshots

- Alan posts via **Post note** (text and/or images) on the task drawer.
- Images live in Storage bucket `mc-attachments`; comments in `task_comments`.
- **Both agents must treat new Alan notes/screenshots as blocking input** before claiming done.
- Owner field (`alan` / `claude` / `cursor`) says who should act next.

## Relationship to “check claude”

| Layer | What | Where |
|-------|------|--------|
| Board | Tasks, verify, notes | Mission Control (`apps-dashboard`) |
| Long-form | QUESTION / RESPONSE markdown | Google Drive inbox / outbox |
| Manifest | pending count for Cursor poll | `update-handoff-manifest.mjs` |

When a Drive RESPONSE lands for a linked task, the processing agent adds a 2–3 line MC comment + moves state per protocol.

## Collisions

If the other agent is already on the task, read `task_log` / comments and coordinate there — do not silently overwrite.

## Session closing habit

Claude: update the board as the last act of each session for any MC tasks touched.

## Recurring tasks tab (Reclaim replacement)

Google Calendar scheduling stays **Claude-only** (see Drive RESPONSE-2026-07-20-calendar-mc-protocol-ruling). Mission Control stores habits in `recurring_tasks`; **no Calendar API or OAuth in apps-dashboard**.

### Claude Monday sweep (with MC-7)

1. Open the **Recurring** tab; read all active rows.
2. For the coming week, compute each instance from `rrule` + `ideal_time` + `window_days`.
3. Read Alan's Google Calendar; place each instance around fixed commitments within the window.
4. Create busy calendar events titled `🔁 {title}` (not MC-{n} — those are project tasks).
5. Write the placed slot into **Scheduled by Claude** on that row (PATCH `/api/mc/recurring` → `scheduled_note`, e.g. `Thu 23 11:00–13:00`). Optionally set `last_scheduled`.

### Alan / agents on the tab

- **Mark done** sets `last_done` to today and appends `recurring_log`.
- Missed instances show red until marked done or deactivated.
- Edit cadence via human `cadence_text` + `rrule` (six presets in UI + custom).
- Reclaim runs in parallel until each habit has fired once (~mid-Aug); Alan cancels Reclaim after proof.

## Standing rules (20 Jul night orders — Alan-approved)

### Preserve-interactions invariant

No UI change may remove or alter an existing interaction (sorts, filters, clicks, expanded-by-default states) unless the change is explicitly listed in the instruction **and** Alan approved that listed change. **Defaults:** exec tiles + matrix stay **OPEN** (Alan's standing overrule).

### Disclosure rule

Every UI-affecting response includes a **"What changes visibly for Alan"** list.

### Why-line duty

Any task an agent touches gets/keeps a one-line `why` (what it unblocks or what it costs if delayed).

### Events & residential conventions (Alan-ruled 20 Jul)

- **Per event:** "Prep joining details" task due event−10 days; send deadline event−7 days; red if not done by event−5.
- **Per hotel booking:** decision task due at the booking's exact free-cancellation deadline −3 days (deadlines from Booking.com confirmation emails; Claude reads and creates these tasks — no build needed from Cursor).
- Claude adds a **"📅 Events & residential"** project and seeds tasks in Claude's pass.
