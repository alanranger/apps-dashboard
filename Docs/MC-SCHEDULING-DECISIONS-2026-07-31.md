# Mission Control scheduling decisions — 2026-07-31

Agreed with Alan before implementation. Source of truth for placer / Diary / Google Calendar behaviour.

## Decision 1 — Project tasks stay off auto-scheduling

- Project / board tasks are **not** auto-dated into Diary or Google Calendar.
- Alan picks them up from the board and marks done there.
- Implementation: stop placer soft-task bumps / auto-dating; clear existing dated project-task pins and Primary calendar events that were auto-scheduled from tasks.

## Decision 2 — Habit cadence cleanup

| Habit | Decision |
|---|---|
| **Review/Amend Course & Workshop Dates** (renamed; dropped “+ check Hotel Bookings”) | Fortnightly, any workable day, **30 min** default |
| **Send Out Joining Details** | Friday preferred, **30 min**; if Friday blocked → **Thursday same week** (earlier only; time_critical backward roll) |
| **Hotel bookings check (Claude)** weekly | **Remove** (deactivate) |
| **Hotel bookings — Alan actions** | Keep weekly, **any day**, no Claude same-day dependency; often skipped; real trigger remains free-cancel deadline reminders |
| **Claude monthly hotel scan** (new) | Monthly, **30 min** in Alan’s diary (Alan instructs Claude) |

Hotel free-cancel deadline reminders (diary-drift → `workshop_hotels`) stay as the operational safety net.

## Decision 3 — Buffers (two different rules — do not conflate)

| Rule | Size | Diary / Google |
|---|---:|---|
| After **admin** habits | **15 min** | **Spacing only** in placer — do **not** write separate `MC ⏳` events |
| Before **and** after client / teaching (workshops, classes, client bookings) | **30 min** | **Visible** `MC ⏳` blocks, **parent-linked** to the teaching/client event |
| Buffers may **push habits** | — | Yes — reality overruns plans |

Every visible buffer must die with its parent (move/cancel parent → buffer goes). No free-floating decompress orphans.

## Decision 4 — Never silent vanish

Placement order:

1. Shuffle within rules (priority, deps, roll windows; buffers may displace habits).
2. Soft daily hour cap — may **break the cap** and use **later same day / evening** if clock time is free.
3. If still impossible → leave explicit **UNPLACED** + Mission Control alert/exception + clear Diary signal; optional Google warning event `MC ⚠️ UNSCHEDULED: …`.

**Never** delete or omit an occurrence without an alert. Cap is a preference, not a silent drop.

## Decision 5 — Horizons

| Layer | Horizon |
|---|---|
| **Habits** | **12 weeks rolling** |
| **Long** | Football fixtures (ITFC calendar) + workshops & lessons from the **2 CSVs** + their travel times + their buffers |

## Out of scope / do not re-enable without asking

- `teaching_day_whole_day_block` stays off unless Alan asks.

## Verification bar (morning)

DB recurring_tasks + scheduling_rules match this doc; Mission Control Diary reflects it; Google Calendar Primary has no auto-scheduled project tasks, habit pins align, no silent unplaced habits without alerts.

**Also required (missed 2026-07-31 overnight — fixed morning):** Primary must have **zero** `MC ⏳ Decompress — after …` gap-paint orphans (admin/habit/task). Workshop/client Prep + travel buffers may remain. Re-check with GCal search `Decompress — after` + `gap_buffer_blocks status=active` count = 0. Script: `node scripts/mc-purge-admin-decompress.cjs`.
