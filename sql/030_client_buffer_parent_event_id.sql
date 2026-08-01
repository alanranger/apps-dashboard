-- Parent-linked client prep/decompress (Acuity Zoom on Primary).
-- Same pattern as fixture_event_id / workshop travel: flanks follow the parent.

alter table public.travel_blocks
  add column if not exists parent_event_id text;

comment on column public.travel_blocks.parent_event_id is
  'GCal event id of the parent client/teaching booking. Prep+decompress flanks follow this parent (create/move/delete).';

create index if not exists travel_blocks_parent_event_id_idx
  on public.travel_blocks (parent_event_id);

-- At most one prep and one decompress per parent booking.
create unique index if not exists travel_blocks_parent_prep_uidx
  on public.travel_blocks (parent_event_id)
  where parent_event_id is not null and block_type = 'prep';

create unique index if not exists travel_blocks_parent_decomp_uidx
  on public.travel_blocks (parent_event_id)
  where parent_event_id is not null and block_type = 'decompress';
