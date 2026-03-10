// Supabase client initialization
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://cjbfdcgopbpjifnxcslt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6hruRap1k1vxb15jmD_Nlg_zuMDzkPq';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Safety: ensure body is always visible when returning from background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    document.body.style.opacity = '1';
  }
});
