-- Reelytics — Supabase schema
-- Run these statements in the Supabase SQL editor (or via psql) before starting the server.

create extension if not exists "pgcrypto";

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  composio_user_id text not null,
  selected_connected_account_id text,
  last_report_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  connected_account_id text not null unique,
  alias text,
  username text,
  status text not null default 'pending',
  connected_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists connected_accounts_user_idx on connected_accounts(user_id);

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  connected_account_id text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists reports_user_account_idx on reports(user_id, connected_account_id, created_at desc);

-- Email verification (2FA via 6-digit code)
alter table users add column if not exists email_verified boolean default false;
alter table users add column if not exists verification_code text;
alter table users add column if not exists verification_code_expires_at timestamptz;
-- Grandfather existing users so they don't get locked out
update users set email_verified = true where email_verified is not true;

-- Team memberships: share a connected_account with additional users
create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  connected_account_id text not null references connected_accounts(connected_account_id) on delete cascade,
  invited_email text not null,
  invited_by_user_id uuid references users(id) on delete set null,
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_user_id uuid references users(id),
  accepted_at timestamptz,
  unique (connected_account_id, invited_email)
);
create index if not exists memberships_email_idx on memberships(invited_email);
create index if not exists memberships_account_idx on memberships(connected_account_id);

-- Row-level security: this server uses the Supabase publishable/service key, so RLS is bypassed.
-- If you expose these tables to the browser, add policies before enabling RLS.
