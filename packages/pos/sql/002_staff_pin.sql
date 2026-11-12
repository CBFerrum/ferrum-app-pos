-- A short PIN per person (approvals at the till, src/limits.rs): kept only as an argon2id hash, with
-- the wrong tries that lock it for a while. Never a column of a record, so never read through the API.
create table if not exists pos_staff_pin (
  tenant_id uuid not null,
  email text not null,
  pin_hash text not null,
  failures int not null default 0,
  locked_until timestamptz,
  set_at timestamptz not null default now(),
  primary key (tenant_id, email)
);
alter table pos_staff_pin enable row level security;
alter table pos_staff_pin force row level security;
do $$ begin
  create policy tenant_isolation on pos_staff_pin using (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()))
    with check (tenant_id = (select ferrum_tenant()) or (select ferrum_is_system()));
exception when duplicate_object then null; end $$;
