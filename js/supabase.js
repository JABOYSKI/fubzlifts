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
 * No-op if the tab was never hidden. Times out after 3s to never block UI.
 */
export async function ensureFreshAuth() {
  if (!_needsRefresh) return;
  if (_refreshPromise) return _refreshPromise;

  const timeout = new Promise(r => setTimeout(r, 3000));
  const refresh = supabase.auth.refreshSession()
    .then(() => { _needsRefresh = false; })
    .catch(() => { _needsRefresh = false; });

  _refreshPromise = Promise.race([refresh, timeout])
    .finally(() => { _refreshPromise = null; });

  return _refreshPromise;
}

// When tab is hidden, flag that we need a refresh on return
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    _needsRefresh = true;
  } else if (document.visibilityState === 'visible') {
    document.body.style.opacity = '1';
    // Fire-and-forget: pre-warm the token but don't block anything
    ensureFreshAuth();
  }
});
