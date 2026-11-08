-- =====================================================================
-- TaxMate - DATABASE (Supabase / PostgreSQL, Sydney region)
-- =====================================================================
-- How to use: Supabase dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run. Safe to run again (it updates in place).
--
-- Privacy design (APP 11):
--   * The database stores ONLY masked document lines (<PII_TFN_1> etc.),
--     the calculated result and the audit trail.
--   * Original files and the token map (real TFN, name, address...) stay
--     encrypted on the taxpayer's own device. They are never uploaded.
--
-- Security design (Capstone 1 FR-001, NFR-011, NFR-012):
--   * Row Level Security: taxpayers see only their own returns;
--     accountants see all returns in the practice.
--   * You can only become an accountant with the practice code.
--   * The audit log is append-only and SHA-256 hash-chained by the
--     database itself, so nobody (not even an accountant) can quietly
--     change or delete an entry.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Private settings (not reachable through the website's API)
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.settings (
  key   text primary key,
  value text not null
);
-- Accountants enter this code when they create their account.
-- CHANGE IT: edit the value below before running, or later with
--   update private.settings set value = 'NEW-CODE' where key = 'practice_code';
insert into private.settings (key, value) values ('practice_code', 'TaxMate-2026')
  on conflict (key) do nothing;
alter table private.settings enable row level security;  -- no policies = no website access at all

-- ---------------------------------------------------------------------
-- 1. Profiles: one row per user, with their role
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null default '',
  role       text not null default 'taxpayer' check (role in ('taxpayer', 'accountant', 'admin')),
  created_at timestamptz not null default now()
);

-- Runs automatically when someone signs up. The role is decided HERE,
-- on the server, so a user cannot make themselves an accountant.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  wanted    text := new.raw_user_meta_data ->> 'role';
  code      text := new.raw_user_meta_data ->> 'practice_code';
  real_code text;
begin
  select value into real_code from private.settings where key = 'practice_code';
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    case when wanted = 'accountant' and code is not null and code = real_code then 'accountant' else 'taxpayer' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Anyone who signed up before this file was run gets a (taxpayer) profile too.
insert into public.profiles (id, full_name, role)
  select id, coalesce(nullif(trim(raw_user_meta_data ->> 'full_name'), ''), split_part(email, '@', 1)), 'taxpayer'
  from auth.users
  on conflict (id) do nothing;

-- Helper used by the security rules below.
create or replace function public.is_accountant()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('accountant', 'admin'));
$$;

-- ---------------------------------------------------------------------
-- 2. Returns: one row per tax return (masked data + results only)
-- ---------------------------------------------------------------------
create table if not exists public.returns (
  id             text primary key,
  owner          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  owner_name     text not null default '',
  status         text not null default 'draft' check (status in ('draft', 'submitted', 'approved')),
  financial_year text not null,
  risk_score     integer not null default 0,
  docs           jsonb not null default '[]'::jsonb,  -- file list (masked names)
  masked         jsonb not null default '[]'::jsonb,  -- masked lines + positions
  analysis       jsonb,                                -- agents' facts and flags
  result         jsonb,                                -- rules engine output
  approved_by    text,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists returns_owner_idx on public.returns (owner);

-- Stamps the time, and who approved, on the server (cannot be faked).
create or replace function private.returns_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    new.approved_by := (select full_name from public.profiles where id = auth.uid());
    new.approved_at := now();
  elsif new.status <> 'approved' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists returns_stamp on public.returns;
create trigger returns_stamp
  before insert or update on public.returns
  for each row execute function private.returns_stamp();

-- ---------------------------------------------------------------------
-- 3. Audit log: append-only, hash-chained by the database
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  seq           bigint primary key,
  time          timestamptz not null default now(),
  user_id       uuid,
  user_name     text not null default '',
  role          text not null default '',
  action        text not null,
  return_id     text,
  field         text,
  from_value    jsonb,
  to_value      jsonb,
  justification text,
  source_refs   jsonb not null default '[]'::jsonb,
  status        text not null default 'success',
  interface     text not null default 'web',
  prev_hash     text,
  hash          text
);

-- The exact text that is hashed for each entry.
create or replace function private.audit_canonical(e public.audit_log)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws('|',
    e.seq::text,
    to_char(e.time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(e.user_id::text, ''), e.user_name, e.role, e.action,
    coalesce(e.return_id, ''), coalesce(e.field, ''),
    coalesce(e.from_value::text, ''), coalesce(e.to_value::text, ''),
    coalesce(e.justification, ''), coalesce(e.source_refs::text, ''),
    e.status, e.interface, coalesce(e.prev_hash, ''));
$$;

-- Before each new entry: fill in who/when from the login (not from the
-- browser), link it to the previous entry's hash, and compute its own hash.
create or replace function private.audit_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(424242);  -- one entry at a time, so the chain never forks
  new.seq       := coalesce((select max(seq) from public.audit_log), 0) + 1;
  new.time      := now();
  new.user_id   := auth.uid();
  new.user_name := coalesce((select full_name from public.profiles where id = auth.uid()), '');
  new.role      := coalesce((select role from public.profiles where id = auth.uid()), '');
  new.prev_hash := coalesce((select hash from public.audit_log order by seq desc limit 1), repeat('0', 64));
  new.hash      := encode(sha256(convert_to(private.audit_canonical(new), 'UTF8')), 'hex');
  return new;
end;
$$;

drop trigger if exists audit_chain on public.audit_log;
create trigger audit_chain
  before insert on public.audit_log
  for each row execute function private.audit_chain();

-- Anyone signed in can check the whole chain is intact.
create or replace function public.verify_audit_chain()
returns table (ok boolean, broken_at bigint, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r    public.audit_log;
  prev text := repeat('0', 64);
  n    bigint := 0;
begin
  for r in select * from public.audit_log order by seq loop
    n := n + 1;
    if r.prev_hash is distinct from prev
       or r.hash is distinct from encode(sha256(convert_to(private.audit_canonical(r), 'UTF8')), 'hex') then
      return query select false, r.seq, (select count(*) from public.audit_log);
      return;
    end if;
    prev := r.hash;
  end loop;
  return query select true, null::bigint, n;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Row Level Security (who can see and change what)
-- ---------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.returns   enable row level security;
alter table public.audit_log enable row level security;

-- Profiles
drop policy if exists "read own profile or accountant reads all" on public.profiles;
create policy "read own profile or accountant reads all" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_accountant());
drop policy if exists "update own name" on public.profiles;
create policy "update own name" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Returns: taxpayers
drop policy if exists "taxpayer reads own returns" on public.returns;
create policy "taxpayer reads own returns" on public.returns
  for select to authenticated using (owner = auth.uid());
drop policy if exists "taxpayer creates own returns" on public.returns;
create policy "taxpayer creates own returns" on public.returns
  for insert to authenticated with check (owner = auth.uid() and status in ('draft', 'submitted'));
drop policy if exists "taxpayer edits own draft" on public.returns;
create policy "taxpayer edits own draft" on public.returns
  for update to authenticated
  using (owner = auth.uid() and status = 'draft')
  with check (owner = auth.uid() and status in ('draft', 'submitted'));
drop policy if exists "taxpayer deletes own draft" on public.returns;
create policy "taxpayer deletes own draft" on public.returns
  for delete to authenticated using (owner = auth.uid() and status = 'draft');

-- Returns: accountants
drop policy if exists "accountant reads all returns" on public.returns;
create policy "accountant reads all returns" on public.returns
  for select to authenticated using (public.is_accountant());
drop policy if exists "accountant reviews returns" on public.returns;
create policy "accountant reviews returns" on public.returns
  for update to authenticated using (public.is_accountant()) with check (public.is_accountant());

-- Audit log: add entries and read them; NO update or delete for anyone
drop policy if exists "signed-in users add audit entries" on public.audit_log;
create policy "signed-in users add audit entries" on public.audit_log
  for insert to authenticated with check (true);
drop policy if exists "read own entries or accountant reads all" on public.audit_log;
create policy "read own entries or accountant reads all" on public.audit_log
  for select to authenticated using (user_id = auth.uid() or public.is_accountant());

-- ---------------------------------------------------------------------
-- 5. Table permissions (the API only gets what it needs)
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.returns, public.audit_log from anon;
revoke all on public.profiles, public.returns, public.audit_log from authenticated;
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;   -- role can never be changed by users
grant select, insert, update, delete on public.returns to authenticated;
grant select on public.audit_log to authenticated;
grant insert (action, return_id, field, from_value, to_value, justification, source_refs, status, interface)
  on public.audit_log to authenticated;                          -- who/when/hash are set by the database
revoke execute on function public.verify_audit_chain() from public, anon;
grant execute on function public.verify_audit_chain() to authenticated;
grant execute on function public.is_accountant() to authenticated;
