-- BAU B re-reads only pages whose main content changed (Alan 3 Nov, option 5). One row per page URL:
-- fingerprint = runner/content-fingerprint.mjs (main-region text + image paths + hosted schema refs), the time it was
-- last checked, last seen to change, and last fully re-ingested. Additive; nothing else reads it.
create table if not exists public.page_content_fingerprints (
  url text primary key,
  fingerprint text not null,
  checked_at timestamptz not null default now(),
  changed_at timestamptz,
  ingested_at timestamptz,
  run_id uuid
);
alter table public.page_content_fingerprints enable row level security;
