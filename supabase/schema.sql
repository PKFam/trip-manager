-- Trip Budget Tracker — Supabase schema
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query → paste → Run).
--
-- Access model: every table is locked via Row Level Security (RLS) to exactly
-- two email addresses. Nobody else — even with the public key exposed in the
-- app's source — can read or write a single row. Update the two emails below
-- if they ever change.

create or replace function is_trip_member()
returns boolean
language sql
stable
as $$
  select (auth.jwt() ->> 'email') in (
    'gilpeeri.eon@gmail.com',
    'tamikoza@gmail.com'
  );
$$;

-- ---------- settings (single row) ----------
create table if not exists settings (
  id int primary key default 1,
  trip_name text not null default 'Our Trip',
  trip_dates text not null default '',
  base_currency text not null default 'USD',
  display_currency text not null default 'USD',
  banner_image text,
  updated_at timestamptz not null default now(),
  constraint settings_singleton check (id = 1)
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------- currencies + rates ----------
create table if not exists currencies (
  code text primary key,
  symbol text not null default ''
);

create table if not exists rates (
  code text primary key references currencies(code) on delete cascade,
  rate numeric not null default 1
);

-- ---------- categories (2-level tree via parent_id) ----------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  icon text not null default '🏷️',
  color text not null default '#5b7cfa',
  budget numeric not null default 0,
  parent_id uuid references categories(id) on delete cascade,
  "order" int not null default 0,
  separate boolean not null default false  -- true = own bucket, excluded from trip totals (e.g. Shopping)
);
alter table categories add column if not exists separate boolean not null default false;

-- ---------- expenses ----------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  amount numeric not null,
  currency text not null references currencies(code),
  base_amount numeric not null,
  paid_amount numeric not null default 0,
  paid_base numeric not null default 0,
  note text not null default '',
  who text not null default '',        -- filled from the signed-in user's email
  created_at timestamptz not null default now()
);

-- ---------- itinerary ----------
create table if not exists itinerary (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  place text not null,
  lat numeric,
  lon numeric,
  line text not null default ''
);

-- ---------- Grants: open the Data API door for signed-in users ----------
-- The project was created with "Automatically expose new tables" OFF, so
-- privileges must be granted explicitly or every query fails with
-- "permission denied". RLS below still decides WHICH signed-in users get rows.
grant usage on schema public to authenticated;
grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;
alter default privileges in schema public grant all on tables to authenticated;

-- ---------- RLS: lock every table to the two trip members ----------
alter table settings enable row level security;
alter table currencies enable row level security;
alter table rates enable row level security;
alter table categories enable row level security;
alter table expenses enable row level security;
alter table itinerary enable row level security;

do $$
declare t text;
begin
  foreach t in array array['settings','currencies','rates','categories','expenses','itinerary']
  loop
    execute format('drop policy if exists trip_members_all on %I', t);
    execute format(
      'create policy trip_members_all on %I for all using (is_trip_member()) with check (is_trip_member())',
      t
    );
  end loop;
end $$;

-- ---------- Realtime: broadcast changes so both phones live-sync ----------
-- Tables are NOT broadcast by default; without this, the app's realtime
-- subscription listens on a channel the database never speaks on (data saves
-- fine but the other device only sees it after a manual refresh).
alter publication supabase_realtime
  add table settings, currencies, rates, categories, expenses, itinerary;
