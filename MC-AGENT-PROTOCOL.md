# Mission Control — agent protocol

Canonical task IDs look like **MC-14**. Chat instructions such as “work on MC-14” refer to that display ID. Related QUESTION/RESPONSE filenames SHOULD include the ID (e.g. `QUESTION-2026-07-22-MC-14-…`).

Both Claude and Cursor write to the same Mission Control Supabase project. The board is the single source of truth. Drive inbox/outbox remains the transport for long-form handoffs; MC stores **references + short summaries**, not file copies.

## Credentials

- Use the **agent** password / session (`role=agent`).
- Server rejects `verified` for agent role. Never attempt to verify.

## When instructed on MC-{n}

1. Set state `in_progress`.
2. Add a comment: `started via {cursor|claude} instruction`.
3. Do the work.
4. Set `evidence_url` (commit, RESPONSE path, URL, etc.).
5. Set state `done_claimed` (API requires evidence).
6. Add a short summary comment (2–3 lines). If a Drive RESPONSE was written, also set `response_file` / `question_file` and comment the summary.

Do not skip state writes. `task_log` actor must be accurate (`cursor` or `claude`).

## Collisions

If the other agent is already on the task, read `task_log` / comments and coordinate there — do not silently overwrite.

## Session closing habit

Claude: update the board as the last act of each session for any MC tasks touched.
