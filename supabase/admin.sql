-- =====================================================================
-- TaxMate - ADMIN SETTINGS, EDITABLE PROMPTS AND AI MONITORING
-- Run once in the Supabase SQL editor, AFTER schema.sql. Safe to run again.
--
--   ai_prompts   every version of each agent's instructions (history kept)
--   ai_settings  admin settings, e.g. which connectors (tools) each agent may use
--   ai_runs      one row per agent run: speed, success, fallback, checks
--                (numbers only - never any document text)
--
-- Only an ADMIN can change prompts and settings or read the AI monitoring.
-- To make an account an admin (here, in the SQL editor):
--   update public.profiles set role = 'admin'
--   where id = (select id from auth.users where email = 'you@example.com');
-- =====================================================================

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------- prompts (append-only history)
create table if not exists public.ai_prompts (
  id               bigserial primary key,
  agent            text not null,
  instructions     text not null check (length(instructions) between 20 and 8000),
  note             text,
  created_by       uuid default auth.uid(),
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index if not exists ai_prompts_agent_idx on public.ai_prompts (agent, id desc);
alter table public.ai_prompts enable row level security;

drop policy if exists "anyone reads prompts" on public.ai_prompts;
create policy "anyone reads prompts" on public.ai_prompts for select using (true);  -- the cloud agents read them; no personal data
drop policy if exists "admins add prompt versions" on public.ai_prompts;
create policy "admins add prompt versions" on public.ai_prompts for insert to authenticated with check (public.is_admin());

create or replace function private.stamp_prompt() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_by := auth.uid();
  new.created_by_name := coalesce((select full_name from public.profiles where id = auth.uid()), 'admin');
  new.created_at := now();
  return new;
end $$;
drop trigger if exists ai_prompts_stamp on public.ai_prompts;
create trigger ai_prompts_stamp before insert on public.ai_prompts for each row execute function private.stamp_prompt();

-- ---------------------------------------------------------------- settings
create table if not exists public.ai_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
alter table public.ai_settings enable row level security;
drop policy if exists "anyone reads settings" on public.ai_settings;
create policy "anyone reads settings" on public.ai_settings for select using (true);
drop policy if exists "admins add settings" on public.ai_settings;
create policy "admins add settings" on public.ai_settings for insert to authenticated with check (public.is_admin());
drop policy if exists "admins change settings" on public.ai_settings;
create policy "admins change settings" on public.ai_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- AI monitoring (numbers only)
create table if not exists public.ai_runs (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  user_id    uuid default auth.uid(),
  return_id  text,
  agent      text not null check (length(agent) <= 40),
  engine     text check (length(engine) <= 20),
  ms         integer,
  ok         boolean not null default true,
  fallback   boolean not null default false,
  steps      integer,
  grounded   integer,
  rejected   integer,
  agreed     integer,
  disagreed  integer,
  prompt_version bigint            -- which version of the instructions the agent used
);
alter table public.ai_runs add column if not exists prompt_version bigint;
create index if not exists ai_runs_at_idx on public.ai_runs (at desc);
alter table public.ai_runs enable row level security;
drop policy if exists "users log their own runs" on public.ai_runs;
create policy "users log their own runs" on public.ai_runs for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "admins read runs" on public.ai_runs;
create policy "admins read runs" on public.ai_runs for select to authenticated using (public.is_admin());

create or replace function private.stamp_setting() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_by := coalesce((select full_name from public.profiles where id = auth.uid()), 'admin');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists ai_settings_stamp on public.ai_settings;
create trigger ai_settings_stamp before insert or update on public.ai_settings for each row execute function private.stamp_setting();

grant select on public.ai_prompts, public.ai_settings to anon, authenticated;
grant insert (agent, instructions, note) on public.ai_prompts to authenticated;
grant insert, update on public.ai_settings to authenticated;
grant insert (return_id, agent, engine, ms, ok, fallback, steps, grounded, rejected, agreed, disagreed, prompt_version) on public.ai_runs to authenticated;
grant select on public.ai_runs to authenticated;
grant usage on sequence public.ai_prompts_id_seq, public.ai_runs_id_seq to authenticated;
