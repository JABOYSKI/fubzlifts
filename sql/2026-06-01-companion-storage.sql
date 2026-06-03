-- ───────────────────────────────────────────────────────────────────────────
-- Cat companion: clip storage bucket.
--
-- The on-screen cat companion (js/companion.js) plays short video clips that
-- live in a PUBLIC Supabase Storage bucket named `companion`, under a `clips/`
-- folder. The engine does two things against this bucket with the anon key:
--   1. storage.list('clips')            → enumerate the available clips
--   2. getPublicUrl('clips/<file>')     → stream the chosen clip
--
-- A bucket marked `public` allows the URL download (step 2) without a policy,
-- but listing via the JS client (step 1) still needs a SELECT policy on
-- storage.objects. This script creates the bucket and that read policy.
--
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to run more than once.
--
-- (You can instead create the bucket by hand: Dashboard → Storage → New bucket,
--  name it `companion`, toggle "Public bucket" ON — then run only the policy
--  block below.)
-- ───────────────────────────────────────────────────────────────────────────

-- Public bucket to hold the companion clips.
insert into storage.buckets (id, name, public)
values ('companion', 'companion', true)
on conflict (id) do update set public = true;

-- Allow anyone (signed-in or not) to LIST and READ objects in this bucket only.
-- This covers both storage.list('clips') and the public-URL downloads.
drop policy if exists "Public read companion clips" on storage.objects;
create policy "Public read companion clips" on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'companion');

-- NOTE: no INSERT/UPDATE/DELETE policy is granted here on purpose — clips are
-- uploaded by you from the Supabase dashboard (or a service-role script), not
-- by the app. The app only ever reads.
