-- Hamly Inventory: server-side schema
-- Run this in Supabase Dashboard -> SQL Editor. Do not put DATABASE_URL in frontend code.
create extension if not exists pgcrypto;

create table if not exists public.hamly_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by bigint not null,
  created_at timestamptz not null default now(),
  unique (created_by, name)
);

create table if not exists public.hamly_org_members (
  org_id uuid not null references public.hamly_organizations(id) on delete cascade,
  user_id bigint not null,
  member_role text not null default 'User' check (member_role in ('Admin','User')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Compatibility store: preserves existing localStorage key names and JSON shapes.
create table if not exists public.hamly_inventory_records (
  org_id uuid not null references public.hamly_organizations(id) on delete cascade,
  record_key text not null check (length(record_key) between 1 and 240),
  record_value jsonb not null,
  updated_by bigint not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, record_key)
);

create index if not exists hamly_inventory_records_updated_at_idx
  on public.hamly_inventory_records (org_id, updated_at desc);

-- The app accesses these tables only through authenticated Netlify Functions.
-- Keep RLS enabled so browser anon/authenticated roles cannot access records directly.
alter table public.hamly_organizations enable row level security;
alter table public.hamly_org_members enable row level security;
alter table public.hamly_inventory_records enable row level security;

-- Intentionally no anon/authenticated policies. The server-side DATABASE_URL role
-- is used only in Netlify Functions; never expose it to the browser.
