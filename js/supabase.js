// Supabase client initialization
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://cjbfdcgopbpjifnxcslt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6hruRap1k1vxb15jmD_Nlg_zuMDzkPq';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Race a promise against a timeout. The Supabase SDK's HTTP/realtime layer
// can silently hang after iOS suspension or a zombie websocket — the awaited
// promise never resolves AND never throws, so try/catch in the caller does
// nothing and the user just sees buttons go unresponsive (the "timeout bug").
// Wrap critical-path calls in withTimeout so they fail fast and the caller
// can recover (typically by triggering an invisible reload).
export class TimeoutError extends Error {
  constructor(label) {
    super(`Timeout: ${label}`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout(promise, ms, label = 'supabase call') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
