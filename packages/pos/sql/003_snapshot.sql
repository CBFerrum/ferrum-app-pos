-- The snapshots of prices, taxes and promotions the tills were given (src/snapshot.rs), kept by version so a
-- sale made offline can be priced again with exactly the one its till used. Not a record: never read through the API.
create table if not exists pos_snapshot (
  tenant_id uuid not null,
  pos_profile uuid not null,
  version text not null,
  body jsonb not null,
  given_at timestamptz not null default now(),
  primary key (tenant_id, pos_profile, version)
);
create index if not exists ix_pos_snapshot_given on pos_snapshot (given_at);
alter table pos_snapshot enable row level security;
alter table pos_snapshot force row level security;
do $$ begin
  create policy tenant_isolation on pos_snapshot using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
    with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
exception when duplicate_object then null; end $$;
