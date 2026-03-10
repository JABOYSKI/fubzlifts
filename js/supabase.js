// Supabase client initialization
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://cjbfdcgopbpjifnxcslt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6hruRap1k1vxb15jmD_Nlg_zuMDzkPq';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Shared token-refresh promise so all code can await it after alt-tab
let _refreshPromise = null;

/**
 * Ensures the Supabase auth token is fresh.
 * Call this before any API operation that might run after returning from background.
 * Multiple concurrent calls share the same in-flight request.
 */
export async function ensureFreshAuth() {
  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = supabase.auth.refreshSession()
    .catch(() => {})
    .finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

// Automatically refresh token when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.body.style.opacity = '1';
    ensureFreshAuth();
  }
});
