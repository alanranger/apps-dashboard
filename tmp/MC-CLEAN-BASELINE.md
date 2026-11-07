# Clean baseline — what you should see now

**Source of truth:** live Google Calendar (and Diary painted from it).

## Decompress (fixed)

**Bug:** decompress was painted after *anything* timed (Haircut, Cleaner, Peak workshops) and on Peak travel edge days (2-day trips have no “middle” away day, so home_only never skipped them). That looked random and overlapped travel.

**Now:** decompress only between **MC work ↔ MC work**, and **not** on travel/away days. Bad strips deleted from Google + DB (35 pruned).

Refresh Google for **27 Jul–16 Aug** — you should **not** see:
- Decompress after Haircut / Cleaner / Peak workshop
- Decompress sitting on Peak travel Sat/Sun

You **should** see decompress only where two MC tasks already have a proper gap (e.g. hotel check → Alan actions).

## Pending left (not noise)

| Count | What | Action |
|------:|------|--------|
| 35 | Real overlaps | One block is travel/fixed — move the habit in Diary |
| 15 | Window | Starts early / ends late — keep if travel/workshop, else move |
| 4 | Hard cap | Day over 240m+tolerance — cut something |
| 38 | Football fixtures | Separate fixture flank flow |
| 4 | Hotels | Your decision |
| 23 | Diary manual moves | Your pinned moves waiting push (or dismiss if done) |

Gap MOVE proposals (145+) were dismissed so they stop competing with the live calendar.

## Code that must stay deployed

`api/mc/buffer-gap-lib.js` — without this on Vercel, next Diary check can re-paint Haircut/Peak decompress.
