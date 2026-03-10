// Supabase client initialization
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://cjbfdcgopbpjifnxcslt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6hruRap1k1vxb15jmD_Nlg_zuMDzkPq';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Track whether a token refresh is needed (only after tab was hidden)
let _needsRefresh = false;
let _refreshPromise = null;

/**
 * Ensures the Supabase auth token is fresh after returning from background.
 * No-op if the tab was never hidden. Multiple callers share one in-flight request.
 */
export async function ensureFreshAuth() {
  if (!_needsRefresh) return;
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = supabase.auth.refreshSession()
    .then(() => { _needsRefresh = false; })
    .catch(() => { _needsRefresh = false; })
    .finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

// When tab is hidden, flag that we need a refresh on return
// When tab is visible again, ensure body is shown and kick off refresh
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    _needsRefresh = true;
  } else if (document.visibilityState === 'visible') {
    document.body.style.opacity = '1';
    ensureFreshAuth();
  }
});
