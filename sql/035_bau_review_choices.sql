-- BAU Monthly batch 8: Alan's decision on a held Google review, made from the Needs Alan panel.
-- review_key is an opaque hash of reviewer + date (the page never gets the full name). The PC runner turns each
-- choice into a row of csv processed/15-review-attribution-overrides.csv on the next run (dry: the sandbox copy).
create table if not exists public.bau_review_choices (
  review_key text primary key,
  choice text not null check (choice in ('product', 'business_level', 'exclude')),
  product_slug text,
  reason text,
  suggested text,
  decided_by text,
  decided_at timestamptz not null default now(),
  check (choice <> 'product' or product_slug is not null),
  check (choice <> 'exclude' or coalesce(reason, '') <> '')
);
alter table public.bau_review_choices enable row level security;
