-- ───────────────────────────────────────────────────────────────────────────
-- Fix: deleting a group must fully remove its sessions, members, and set logs.
--
-- Why this is needed: deleteGroup() in js/group.js deletes child rows from the
-- client, but Row-Level Security only lets a user delete their OWN set_logs /
-- session_members / group_members. So when an owner deletes a group, OTHER
-- members' rows survive and the sessions row stays (orphaned), leaving the group
-- visible to those members with a phantom "Workout in progress". Foreign-key
-- ON DELETE CASCADE actions run as the table owner and BYPASS RLS, so making the
-- FKs cascade lets a single `delete from groups` clean everything in one shot.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to run more than once.
--
-- NOTE ON CONSTRAINT NAMES: these use Postgres' default `<table>_<column>_fkey`
-- names. If an `alter table ... add constraint` fails with "already exists", a
-- differently-named FK exists on that column — find it with:
--     select conname from pg_constraint
--      where conrelid = 'public.sessions'::regclass and contype = 'f';
-- then drop that name instead.
-- ───────────────────────────────────────────────────────────────────────────

-- group_members.group_id → groups.id
alter table public.group_members drop constraint if exists group_members_group_id_fkey;
alter table public.group_members
  add constraint group_members_group_id_fkey
  foreign key (group_id) references public.groups(id) on delete cascade;

-- sessions.group_id → groups.id   (deleting a group removes its sessions)
alter table public.sessions drop constraint if exists sessions_group_id_fkey;
alter table public.sessions
  add constraint sessions_group_id_fkey
  foreign key (group_id) references public.groups(id) on delete cascade;

-- session_members.session_id → sessions.id   (removing a session removes its members)
alter table public.session_members drop constraint if exists session_members_session_id_fkey;
alter table public.session_members
  add constraint session_members_session_id_fkey
  foreign key (session_id) references public.sessions(id) on delete cascade;

-- set_logs.session_id → sessions.id   (removing a session removes its set logs)
alter table public.set_logs drop constraint if exists set_logs_session_id_fkey;
alter table public.set_logs
  add constraint set_logs_session_id_fkey
  foreign key (session_id) references public.sessions(id) on delete cascade;

-- Make sure the group owner is allowed to delete the group row (the cascade
-- above does the rest). Skip if you already have an equivalent DELETE policy.
drop policy if exists "owner can delete group" on public.groups;
create policy "owner can delete group" on public.groups
  for delete using (auth.uid() = owner_id);

-- ── OPTIONAL one-time cleanup of orphans left by the old buggy delete ─────────
-- Removes sessions whose group no longer exists (now harmless to run since the
-- cascade is in place going forward). Uncomment to run:
-- delete from public.set_logs        where session_id in (select id from public.sessions where group_id not in (select id from public.groups));
-- delete from public.session_members where session_id in (select id from public.sessions where group_id not in (select id from public.groups));
-- delete from public.sessions        where group_id not in (select id from public.groups);
-- delete from public.group_members   where group_id  not in (select id from public.groups);
