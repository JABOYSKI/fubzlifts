-- ───────────────────────────────────────────────────────────────────────────
-- Paw badge: users.paw_count
--
-- The paw badge (a small dark-red paw next to a member's alias) is awarded the
-- first time a user initiates a successful "6th-set" vote, and counts up from
-- there. The count is a permanent, profile-global property of the user, stored
-- on users.paw_count. See js/utils.js pawBadge(), js/session.js bumpMyPawCount().
--
-- How the app uses the column:
--   • READ:   getGroupMembers() selects users(*), so every member's paw_count
--             rides along on the already-readable group-member rows — no new
--             SELECT policy needed (reading group members already works in v1.1).
--   • WRITE:  each client updates ONLY ITS OWN users row
--             (update({paw_count}).eq('id', auth.uid())). That needs an own-row
--             UPDATE policy on public.users (block 2 below).
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to run more than once.
-- ───────────────────────────────────────────────────────────────────────────

-- 1) The column. Default 0 (not null) so pawBadge(0) hides the badge for
--    everyone until they earn one. The app also tolerates null/undefined
--    (row?.paw_count || 0), so re-running or partial state never breaks.
alter table public.users
  add column if not exists paw_count integer not null default 0;

-- 2) Let a signed-in user UPDATE THEIR OWN users row (covers the paw_count bump).
--    Permissive policies are OR-combined, so this only GRANTS own-row updates and
--    cannot tighten anything you already have (e.g. if profile alias/avatar edits
--    already work, that existing policy stays in force and this is redundant but
--    harmless). with check (auth.uid() = id) stops a row from being reassigned to
--    another user. Idempotent via drop-if-exists on this specific policy name.
drop policy if exists "Users can update their own row" on public.users;
create policy "Users can update their own row" on public.users
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);
