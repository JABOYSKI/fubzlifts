// Supabase client initialization
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://cjbfdcgopbpjifnxcslt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6hruRap1k1vxb15jmD_Nlg_zuMDzkPq';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Surface any silently-swallowed promise errors
window.addEventListener('unhandledrejection', e => {
  console.error('[FubzLifts] Unhandled rejection:', e.reason);
});

// Centralized resume: fire app-resumed IMMEDIATELY (no blocking network calls)
// Supabase's built-in autoRefreshToken handles token refresh on its own
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  document.body.style.opacity = '1';
  console.warn('[FubzLifts] Tab resumed — dispatching app-resumed');
  window.dispatchEvent(new CustomEvent('app-resumed'));
});
