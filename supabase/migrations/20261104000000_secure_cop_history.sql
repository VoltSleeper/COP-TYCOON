-- COP TYCOON: protect the shared history table.
-- Review and apply only after the matching frontend authentication changes are ready.
-- This migration is intentionally stored in the audit branch and is NOT deployed.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.cop_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table private.cop_admins enable row level security;
revoke all on table private.cop_admins from public, anon, authenticated;

create or replace function public.is_cop_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.cop_admins a
    where a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_cop_admin() from public, anon;
grant execute on function public.is_cop_admin() to authenticated;

alter table public.cop_history enable row level security;

drop policy if exists cop_history_select on public.cop_history;
drop policy if exists cop_history_insert on public.cop_history;
drop policy if exists cop_history_update on public.cop_history;
drop policy if exists cop_history_delete on public.cop_history;

-- History remains publicly readable. Admin-only actions are enforced in PostgreSQL,
-- not by a client-side flag or hidden button.
create policy cop_history_select
on public.cop_history
for select
to anon, authenticated
using (true);

create policy cop_history_insert
on public.cop_history
for insert
to authenticated
with check ((select public.is_cop_admin()));

create policy cop_history_update
on public.cop_history
for update
to authenticated
using ((select public.is_cop_admin()))
with check ((select public.is_cop_admin()));

create policy cop_history_delete
on public.cop_history
for delete
to authenticated
using ((select public.is_cop_admin()));

-- Remove anonymous write privileges entirely. Authenticated users receive SQL
-- privileges, but RLS limits their writes to the protected admin allowlist.
revoke all on table public.cop_history from anon, authenticated;
grant select on table public.cop_history to anon, authenticated;
grant insert, update, delete on table public.cop_history to authenticated;

commit;

-- ADMIN BOOTSTRAP (run separately after inviting users in Supabase Auth):
-- Insert only trusted Auth user IDs into private.cop_admins, for example:
-- insert into private.cop_admins (user_id)
-- select id from auth.users where email = 'admin@example.org';
-- Do not expose private.cop_admins to anon/authenticated clients.
-- Manage this allowlist only through the Supabase SQL editor as project owner.
