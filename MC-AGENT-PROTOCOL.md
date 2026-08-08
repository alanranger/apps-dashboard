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

## Alan-authorized terminal closes (MC-55)

Claude closes a task **only** when Alan confirms in writing in chat, **naming the task and the outcome**. Never on Claude's own initiative, never to tidy up, never batch, never reading silence as approval. **`verified` is never Claude's to set.**

Invoke via Supabase MCP (`postgres-rw`):

```sql
SELECT mc_agent_close_task(
  p_display_id := 44,
  p_new_state := 'done',
  p_authorized_by := 'alan',
  p_reason := 'Alan confirmed in chat — …',
  p_superseded_by_display_id := NULL,
  p_actor := 'claude'
);
```

Allowed `p_new_state`: `done`, `superseded`, `wont_do` only. For `superseded`, set `p_superseded_by_display_id` (e.g. `53`). DB rejects `verified` at the function and via trigger (`mc_block_direct_verified`). Audit: `close_authorized_by`, `close_authorized_at`, `close_reason`, `task_log`, and a `status-close` comment on the task.

## Preserve-interactions invariant (Alan-ruled)

No UI change may remove or alter an existing interaction (sorts, filters, clicks, expanded-by-default states) unless the change is **explicitly listed** in the instruction **and** Alan approved that listed change.

**Standing defaults:** exec summary tiles + priority matrix stay **OPEN** (Alan overruled collapse-by-default).

## Disclosure rule

Every UI-affecting response includes a **"What changes visibly for Alan"** list.

## Why-line duty

Any task an agent touches gets/keeps a one-line `why` (what it unblocks or costs).

## Events & residential conventions (Alan-ruled)

Per event: create **"Prep joining details"** due event−10 days; send deadline event−7 days; red if not done by event−5.  
Per hotel booking: decision task due at the booking’s free-cancellation deadline −3 days (deadlines from Booking.com confirmation emails). Claude reads and creates these tasks — no Cursor Calendar build. Claude adds a **"📅 Events & residential"** project and seeds in a later pass.

## Diary placement — standing law (Alan-ruled 25 Jul 2026)

### Division of labour

| Who | Does | Does not |
|-----|------|----------|
| **Cursor** | Plans slots, adjudicates, builds detectors, Supabase, repos, **routing API** (`/api/mc/drive-time` + Google Distance Matrix), calendar **READ-ONLY** | Write Google Calendar; invent business rulings |
| **Claude** | Calendar **read and write**, Gmail, Drive, Supabase SQL | HTTP to the MC app; run deterministic diary code; **choose slots** |
| **Alan** | Rules on unplaceable / policy | — |

**Cursor plans → Claude writes → Alan rules.** Claude does not pick slots to “make it fit.”

### Diary tab (26 Jul 2026) — DB master + consolidated push

Mission Control **Diary** tab (`/mission-control` → Diary): Outlook-style 4-week grid for reschedule without depending on live GCal writes.

| Piece | Role |
|-------|------|
| `GET /api/mc/diary` | Busy map (GCal **READ**) + DB tasks/habits/travel/away |
| `POST /api/mc/diary-action` | Drag/menu → DB + upsert `gcal_push_queue` (latest state wins per `related_id`) |
| `GET/PATCH /api/mc/gcal-push` | Consolidated manifest; `mark_ready` when `gcal_writes_available=true` |
| Warn-checks | `habit-placer-lib.requiredGapMins` / `dayCapLimits` / `awaySpansFromTravelBlocks` — never a flat reimplementation |

**Push button does not write Google.** It marks the queue `ready` for Claude. While Anthropic GCal writes are down, `scheduling_rules.gcal_writes_available=false` and the button stays disabled. Away-span backlog remains in `pending_diary_changes` and is listed beside the queue for the **same** Claude flush path.

**UI (26 Jul evening):** Diary top has a standout **Google Calendar flush** panel (amber when writes available + items waiting; red when blocked). Counts = diary edit queue + away-span backlog. Button copy: “Hand N to Claude → Google” / “Blocked · N waiting”. Explainer on-panel: edits already save to DB + `gcal_push_queue` (latest `related_id` wins); Push only marks `ready`.

### Alan capacity model — LOCKED (26 Jul 2026)

Do **not** invent alternate denominators. Fuel gauge + 8-week horizon board use this only (`weekCapacity` in `api/mc/diary-lib.js`).

1. **Teaching / client days** (workshop, class, lesson, Zoom 1-2-1, client booking): **DISABLED for now** (`scheduling_rules.teaching_day_whole_day_block=false`). Workshop/lesson blocks still show as fixed GCal truth and block their own time slots; there is **no** whole-day TEACHING banner / placer hard-block / zero admin capacity until that toggle is turned back on after baseline is stable.
2. **Residential / away** (travel-out → travel_back inclusive, plus bank holidays treated as away for capacity): on-location ≈ **05:00–22:00** committed and capacity. **Rest day:** the calendar day **after the last day** of each **multi-day (2+ day) workshop calendar event** (UK timezone for date boundaries) — derived per event start/end range (never grouped by title; travel irrelevant). Single-day workshops (home / day-trips) get **no** rest day. Toggle: editable `scheduling_rules.rest_day_after_multiday_workshop` (default `true`). **Enforced in placer** via `restDaySpansFromWorkshopEvents` + `dayBlockedForPlacement`.
   - **AWAY pairing rule (29 Jul):** `awaySpansFromTravelBlocks` pairs `travel_out`↔`travel_back` by matching `workshop_row_key` / venue only — **never** the next return of another trip. Cross-venue fallback caused false multi-day `MC 🚫 AWAY` banners.
   - **AWAY span (Alan rule):** from **travel-out start day through travel-back end day inclusive** (e.g. Hartland Fri out → Sun back = AWAY Fri+Sat+Sun). Not middle-only.
   - **Peak overnight exception:** Sat sunset → Hotel Rudyard overnight → Sun Roaches sunrise → home. Covered by overnight `travel_leg`s + locked `travel_back` after sunrise.
   - **Manual lock:** `travel_blocks.manual_lock` / `away_day_blocks.manual_lock` (+ `lock_reason`). When true, travel-regenerate and AWAY sync must **not** move, re-pair, or prune that row. Use for Alan-approved exception chains (Peak is locked).
3. **Normal desk days:** core window from `scheduling_rules` — weekday **10:00–17:00**, weekend **11:00–16:00** — plus optional **19:00–21:00** catch-up **unless** evening class/fixture. Display axis remains 07:00–23:00; **fuel = realistic load, not display axis**.
4. **Separately:** `daily_task_cap_min=240` (4h admin) is a placer/breach rule for desk days — **not** the fuel-gauge denominator.
5. **Movable vs fixed (UX):** editable = blue **tasks** + green **habits**. Everything else (client/workshop, lesson, fixture, travel, buffers, personal) is read-only GCal truth. Horizon tiles show Fixed / Movable hours + “how to stay human” tips.
6. **Teaching / client whole-day block (placer):** when `teaching_day_whole_day_block=true`, Workshops + Lessons calendars + Zoom 1-2-1s → `teaching_day` hard spans (`teachingDaySpansFromEvents`). Currently **off**.

### Editable vs read-only (Alan UX)

- Drag / ☑ / amend / skip: **tasks + habits** only.
- Habit complete: occurrence-level; can set actual minutes; skip logs without `last_done`.
- DONE messages must be plain English (not “read-only calendar” for completed work).

### MC blocks are OUTPUT, never INPUT

> **MC-generated blocks are never part of the busy map.**

Worked failure (24 Jul): a hand re-lay treated already-placed MC blocks as fixed constraints. Wrong placements became “busy,” so overlaps, zero gaps, and 240-cap breaches were faithfully preserved. Strip all MC-tied events (`tasks.calendar_event_id`, `recurring_log.calendar_event_id`, `travel_blocks.calendar_event_id`) before planning. `colorId=10` with **no** tie-back = **UNMATCHED** — list it; do not classify, delete, or plan around it.

### Two independent horizons

| Item type | Horizon |
|-----------|---------|
| Recurring tasks / habits | **6 months** rolling (`habit_horizon_weeks=26`) |
| Workshops, lessons, travel, buffers, hotel deadline reminders / gap tasks | **Indefinite** — as far as the CSVs go (`travel_horizon_weeks=104` practical cap; `workshop_derived_horizon=indefinite`) |

The busy map must extend to the **further** of the two.

### Busy-map fingerprint + re-read-before-write

Every placement/amendment plan returns the **exact list of real-commitment events** planned against (event id, start, end, calendar) for every day touched. Claude re-reads those days live immediately before writing. Match → apply. Differ → **that day is held** and returns to Cursor for re-planning. Claude does not adjust a slot himself.

### Validator independence

A validator that shares the placer’s busy-map assumption proves nothing (23 Jul: “0 overlaps” while 13 blocks sat on residentials). Assert overlaps / gaps / 240-cap **independently** of the placement pass.

### Agent tool inventory (do not re-guess)

- **Cursor:** calendar READ-ONLY (Google Calendar MCP), Gmail (OAuth mint + Label_209 reconcile), Supabase (`igzvwbvgvmzvvzoclufx`), git repos, **live routing** via Mission Control drive-time API / Distance Matrix, Vercel crons in `apps-dashboard`.
- **Claude:** calendar read **and** write, Gmail, Drive handoff folders, Supabase SQL; **no** HTTP to the MC app; cannot run the Node adjudicator.

## Recurring tasks tab (Reclaim replacement)

Google Calendar **writes** stay **Claude-only**. Mission Control may **read** Calendar (diary-drift / Diary tab via `gcal-lib`) and stores habits in `recurring_tasks`. Apps-dashboard never performs Calendar writes.

### Diary booking horizon (Alan-ruled — updated 25 Jul)

Habits: book **6 months** ahead. Workshop-derived travel/buffers/reminders: **indefinite** (CSV span). Older “28 days” Monday-sweep text below is superseded for horizon length; the sweep still places what is due.

### Claude Monday sweep (with MC-7)

1. Open the **Recurring** tab; read all active rows.
2. Compute instances for the next **28 days** from `rrule` + `ideal_time` + `window_days`.
3. Read Alan's Google Calendar; place each unscheduled instance in that horizon.
4. Create busy calendar events titled `🔁 {title}` (not MC-{n} — those are project tasks).
5. Write the placed slot into **Scheduled by Claude** on that row (PATCH `/api/mc/recurring` → `scheduled_note`, e.g. `Thu 23 11:00–13:00`). Optionally set `last_scheduled`.

### Alan / agents on the tab

- **Add habit** on the Recurring tab (not New task) — presets + custom RRULE.
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

---

## 2026-08-10 — Surface scoring + dashboard consistency round

**Purpose:** Give the next agent a single place to read this round without reconstructing Google Drive QUESTION files. Work landed primarily in **ai-geo-audit** (`audit-dashboard.html`, `lib/audit/surfaceScores.js`, `lib/audit/surfaceOutcomes.js`). This section is additive history for Mission Control context (Config integrity / MC-53 still open separately).

### Surface Visibility model

- **Scope:** money keywords only — **local-money + national-money**.
- **Regional-money RETIRED.** The five “regional” LOCKED keywords were remapped (e.g. “photography workshops near me” → local; macro/nature/one-day/portrait workshop-style terms → national). Headline overall no longer mixes a third money tier.
- **Weights** (`CLASS_WEIGHTS` in `lib/audit/surfaceScores.js`; mirrored in dashboard):

| Class | pack | organic | aio | fs | paa | kp |
|-------|------|---------|-----|----|-----|-----|
| local-money | 35 | 25 | 25 | 10 | 5 | **0** |
| national-money | 10 | 40 | 27 | 15 | 8 | **0** |

- **Live (as of this round):** Surface Visibility **~40**, Top of Page **~49**.
- **KP (Knowledge panel):** **show-only**, weight **0** (Alan already owns ~91%; scoring it would flatter SV).

### PAA (People Also Ask)

- **Scored**, **stack-gated** only: `serp_surface_stack` entry `type=people_also_ask` with slot (+ `ours` for ownership). Flags `paa_present_any` / `paa_ours` alone do **not** count for SV/outcomes after the reconcile pass.
- Outcomes: owned **~5 of 108** money when stack-gated.
- Gap callout soft-language: per-scrape unowned demand (e.g. historic “~92%”) is volatile across location/login; do not treat as a settled permanent share. Optional **2-of-3 presence confidence gate** was evaluated and **not built** (would barely move the headline).
- Product note: many PAA strings are informational (“how much does a course cost”, “how to start”) → content on info pages may win more than commercial booking pages alone.

### AI surfaces (do not conflate Google products)

| Surface | Role |
|---------|------|
| **Google AI Overview** (was “AI answer”) | Classic SERP AIO in `serp_surface_stack` — feeds score/ownership when stack-gated. |
| **Google AI Mode** | Separate product (`ai_engines.google_ai_mode`) — **diagnostic only**, never feeds SV/ToP. High cite counts are expected; not a “data bug” vs AIO. |

### Three instruments (labelling fixed this round)

| Instrument | ~Value | What it measures |
|------------|--------|------------------|
| **Surface Visibility** | ~40 | Demand-weighted **ownership** of served answer surfaces on money keywords |
| **Top of Page / “Where you stand” capture** | ToP ~49 / capture ~23 | **Different** formulae (slot quality vs capture share) — not interchangeable with SV |
| **GAIO / AI Health 5-pillar** | ~77 | Authority .30 / Content·Schema .25 / Visibility .20 / Local Entity .15 / Service Area .10 — **not** components of SV |

“Weakest class” labels now name the score family: **(Surface Visibility)** on Main Dashboard Ranking tile vs **(Top-of-Page)** on Ranking & AI hero.

### Main Dashboard “Search performance” card

- **Before:** dial titled Surface Visibility + radar of full **GAIO pillars** (including dead-ish Local Entity / Service Area ~100) under one heading — two systems, one label; legacy strip “Visibility **80**” was old GSC-position pillar, not SV 40.
- **After (Alan-approved):**
  - Card title **Search performance** (umbrella — not confused with “Surface Visibility”)
  - **Dial** = Surface Visibility only (labelled in subtitle; value ~40)
  - **Search visibility levers** radar/strip: five independent 0–100 action levers — **Surface Visibility, Top of Page, Authority, Content/Schema, CTR vs target** (money-page CTR as % of **2.5%** target, capped 100 — same progress as Money Pages tile). Local Entity / Service Area / legacy Visibility **removed** from this card.
  - Caption copy: “CTR **uses** money-page % of 2.5% target…” (typo “speaks use” fixed same day).
- Deliberately **not** identical to AI Health radar (that one keeps **Brand demand** instead of CTR vs target).

### Ranking & AI tab panel reconcile

Surface Outcomes, Where you stand, and Surface ownership census now share **stack-gated** PAA/FS definitions (no flag-hybrid 8/111 vs outcomes 5/108 split). Organic labels: top-3 on capture tile vs top-10 on census/outcomes as instrument design.

### Key ai-geo-audit commits (this round)

| Hash | Topic |
|------|--------|
| `1e9d578` | Google AI Overview rename; diagnostic AI Mode row |
| `64ae87f` | Retire regional-money; overall = local + national |
| `cde2bf0` / `9f705da` / `760dea8` | Outcomes / Pages labels + base weights |
| `3410d84` / `6acb753` | KP show-only |
| `90a37d5` | PAA scored (organic-funded weights) |
| `2c0e982` | Soften PAA gap callout (volatility) |
| `b156b45` | SV footers, tips, Featured snippet wording |
| `f80edc4` | Stack-gate census/standings PAA; weakest-class labels |
| `76eb0de` | Main Dashboard 5-spoke Search visibility levers |
| `10ce6c9` | Caption typo: “CTR uses money-page %…” |
| `0d640a8` | Card title **Search performance**; dial remains Surface Visibility |

### Open / optional

- PAA **informational content** play — not started.
- Config integrity RED (~40) still tracked as **MC-53**.

Drive RESPONSES for this round live under `Claude shared resources/Cursor Outputs for Claude/` (`RESPONSE-2026-08-10-*`).
