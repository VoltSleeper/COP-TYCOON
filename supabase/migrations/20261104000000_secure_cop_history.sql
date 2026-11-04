-- COP TYCOON: shared-password admin access through a server-side Edge Function.
-- Prepared for review; this migration is NOT applied to the live project.

begin;

-- Public clients can read history. All writes go through cop-admin, which
-- verifies a short-lived admin session before using its server-side key.
alter table public.cop_history enable row level security;

drop policy if exists cop_history_select on public.cop_history;
drop policy if exists cop_history_insert on public.cop_history;
drop policy if exists cop_history_update on public.cop_history;
drop policy if exists cop_history_delete on public.cop_history;

create policy cop_history_select
on public.cop_history
for select
to anon, authenticated
using (true);

revoke all on table public.cop_history from public, anon, authenticated;
grant select on table public.cop_history to anon, authenticated;
grant all on table public.cop_history to service_role;

-- Hashed, short-lived bearer sessions. Raw session tokens never enter the DB.
create table if not exists public.cop_admin_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz not null default now()
);
alter table public.cop_admin_sessions enable row level security;
revoke all on table public.cop_admin_sessions from public, anon, authenticated;
grant all on table public.cop_admin_sessions to service_role;

-- Persistent per-IP login throttling. Only the Edge Function can use these.
create table if not exists public.cop_admin_login_attempts (
  fingerprint_hash text primary key,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  locked_until timestamptz
);
alter table public.cop_admin_login_attempts enable row level security;
revoke all on table public.cop_admin_login_attempts from public, anon, authenticated;
grant all on table public.cop_admin_login_attempts to service_role;

create or replace function public.cop_admin_login_allowed(p_fingerprint_hash text)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count integer;
  v_locked_until timestamptz;
begin
  insert into public.cop_admin_login_attempts (fingerprint_hash)
  values (p_fingerprint_hash)
  on conflict (fingerprint_hash) do nothing;

  select window_started_at, attempt_count, locked_until
    into v_window, v_count, v_locked_until
  from public.cop_admin_login_attempts
  where fingerprint_hash = p_fingerprint_hash
  for update;

  if v_locked_until is not null and v_locked_until > now() then
    return query select false, greatest(1, ceil(extract(epoch from (v_locked_until - now())))::integer);
    return;
  end if;

  if v_window < now() - interval '15 minutes' then
    update public.cop_admin_login_attempts
    set window_started_at = now(), attempt_count = 0, locked_until = null
    where fingerprint_hash = p_fingerprint_hash;
    v_count := 0;
  end if;

  if v_count >= 5 then
    update public.cop_admin_login_attempts
    set locked_until = now() + interval '15 minutes'
    where fingerprint_hash = p_fingerprint_hash;
    return query select false, 900;
    return;
  end if;

  return query select true, 0;
end;
$$;

create or replace function public.cop_admin_login_failure(p_fingerprint_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz;
  v_count integer;
begin
  insert into public.cop_admin_login_attempts (fingerprint_hash)
  values (p_fingerprint_hash)
  on conflict (fingerprint_hash) do nothing;

  select window_started_at, attempt_count
    into v_window, v_count
  from public.cop_admin_login_attempts
  where fingerprint_hash = p_fingerprint_hash
  for update;

  if v_window < now() - interval '15 minutes' then
    v_count := 0;
    v_window := now();
  end if;

  v_count := v_count + 1;

  update public.cop_admin_login_attempts
  set window_started_at = v_window,
      attempt_count = v_count,
      locked_until = case when v_count >= 5 then now() + interval '15 minutes' else null end
  where fingerprint_hash = p_fingerprint_hash;
end;
$$;

revoke all on function public.cop_admin_login_allowed(text) from public, anon, authenticated;
revoke all on function public.cop_admin_login_failure(text) from public, anon, authenticated;
grant execute on function public.cop_admin_login_allowed(text) to service_role;
grant execute on function public.cop_admin_login_failure(text) to service_role;

commit;
