// Supabase client initialization
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://cjbfdcgopbpjifnxcslt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6hruRap1k1vxb15jmD_Nlg_zuMDzkPq';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Centralized resume handler: refresh auth FIRST, then signal all modules
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  document.body.style.opacity = '1';

  // Force-refresh the auth token so all subsequent API calls use a valid JWT
  try {
    await supabase.auth.refreshSession();
  } catch (e) {
    // Offline or token totally invalid — continue with cached token
  }

  // Now signal that all modules can safely make API calls
  window.dispatchEvent(new CustomEvent('app-resumed'));
});
