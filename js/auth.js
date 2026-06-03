// Authentication module
import { supabase, withTimeout, TimeoutError } from './supabase.js';
import { toast, STARTING_WEIGHT } from './utils.js';
import { BUILD_TIME as BUILD_TIME_FROM_FILE } from './version.js';

// Prefer the inline-stamped BUILD_TIME from index.html (which is cache-busted
// per deploy, see ?v=BUILD_TIMESTAMP). Fall back to the import only if the
// inline script didn't run (e.g. dev with literal placeholder).
const BUILD_TIME = (typeof window !== 'undefined' && window.FUBZ_BUILD_TIME && window.FUBZ_BUILD_TIME !== 'BUILD_TIMESTAMP')
  ? window.FUBZ_BUILD_TIME
  : BUILD_TIME_FROM_FILE;

let currentUser = null;

export function getUser() { return currentUser; }

/** Initialize auth — check existing session */
export async function initAuth() {
  // getSession() revalidates a cached refresh token over the network and, after
  // iOS suspension / a zombie socket, can hang forever (never resolves OR
  // rejects). Unwrapped, that leaves the boot splash covering a dead page (the
  // "spinner forever on open" bug). Wrap it so a hang throws TimeoutError, which
  // init() in app.js catches and falls back to the auth screen.
  const { data: { session } } = await withTimeout(
    supabase.auth.getSession(), 8000, 'initAuth.getSession'
  );
  if (session) {
    await loadProfile(session.user);
    return currentUser;
  }
  return null;
}

/** Listen for auth state changes */
export function onAuthChange(callback) {
  supabase.auth.onAuthStateChange(async (event, session) => {
    if (session) {
      await loadProfile(session.user);
    } else {
      currentUser = null;
    }
    callback(currentUser, event);
  });
}

/** Load user profile from public.users, with retry and fallback.
 *  Every supabase call here is on the boot + sign-in critical path, so each is
 *  timeout-guarded: a hung query on a degraded socket must not stall the whole
 *  app (boot splash forever / submit button stuck on "Loading…"). On a timeout
 *  we fall straight through to the auth-metadata last resort so the app still
 *  boots with a usable (minimal) profile. */
async function loadProfile(authUser) {
  const alias = authUser.user_metadata?.alias || 'Lifter';

  for (let i = 0; i < 3; i++) {
    let data = null;
    try {
      const res = await withTimeout(
        supabase.from('users').select('*').eq('id', authUser.id).single(),
        6000, 'loadProfile.select'
      );
      data = res.data;
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      // Socket hung — retries and the upsert would hang too. Skip straight to
      // the metadata last resort so the app boots instead of freezing.
      console.warn('[FubzLifts] loadProfile select timed out — using auth metadata');
      currentUser = { id: authUser.id, alias, avatar_url: null };
      ensureProfileWeights(authUser.id).catch(() => {});
      return currentUser;
    }
    if (data) {
      currentUser = data;
      await ensureProfileWeights(data.id);
      return data;
    }
    if (i < 2) await new Promise(r => setTimeout(r, 600));
  }

  // Fallback: create profile client-side if trigger didn't fire
  try {
    const { data: inserted } = await withTimeout(
      supabase.from('users').upsert({ id: authUser.id, alias }).select().single(),
      6000, 'loadProfile.upsert'
    );
    if (inserted) {
      currentUser = inserted;
      await ensureProfileWeights(inserted.id);
      return inserted;
    }
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    // fall through to last resort
  }

  // Last resort: use auth metadata so the app still works
  console.warn('Could not load/create profile, using auth metadata');
  currentUser = { id: authUser.id, alias, avatar_url: null };
  await ensureProfileWeights(authUser.id).catch(() => {});
  return currentUser;
}

/** Ensure profile_weights rows exist for a user (seeds defaults if missing).
 *  Best-effort: this is awaited on the boot path, so a hung query is swallowed
 *  (timeout → return) rather than allowed to block render. */
async function ensureProfileWeights(userId) {
  try {
    const { data } = await withTimeout(
      supabase.from('profile_weights').select('exercise').eq('user_id', userId),
      6000, 'ensureProfileWeights.select'
    );
    const existing = (data || []).map(r => r.exercise);
    const exercises = ['squat', 'bench', 'ohp', 'row', 'deadlift'];
    const missing = exercises.filter(e => !existing.includes(e));
    if (missing.length > 0) {
      await withTimeout(
        supabase.from('profile_weights').insert(
          missing.map(exercise => ({
            user_id: userId,
            exercise,
            weight_lbs: STARTING_WEIGHT,
          }))
        ),
        6000, 'ensureProfileWeights.insert'
      );
    }
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn('[FubzLifts] ensureProfileWeights timed out — skipping seed');
      return;
    }
    throw e;
  }
}

/** Sign up with email + password — profile created by DB trigger.
 *  Timeout-guarded: if the GoTrue call hangs (zombie socket), return a normal
 *  error so the submit handler re-enables the button instead of leaving it
 *  stuck on "Loading…" forever. */
export async function signUp(email, password, alias) {
  let error;
  try {
    const res = await withTimeout(
      supabase.auth.signUp({ email, password, options: { data: { alias } } }),
      12000, 'signUp'
    );
    error = res.error;
  } catch (e) {
    if (e instanceof TimeoutError) return { ok: false, msg: 'Connection timed out — try again.' };
    return { ok: false, msg: 'Something went wrong — try again.' };
  }
  if (error) return { ok: false, msg: error.message };
  return { ok: true };
}

/** Sign in with email + password */
export async function signIn(email, password) {
  let error;
  try {
    const res = await withTimeout(
      supabase.auth.signInWithPassword({ email, password }),
      12000, 'signIn'
    );
    error = res.error;
  } catch (e) {
    if (e instanceof TimeoutError) return { ok: false, msg: 'Connection timed out — try again.' };
    return { ok: false, msg: 'Something went wrong — try again.' };
  }
  if (error) {
    // Make Supabase error messages friendlier
    let msg = error.message;
    if (msg.includes('Invalid login')) msg = 'Wrong email or password.';
    return { ok: false, msg };
  }
  return { ok: true };
}

/** Sign out */
export async function signOut() {
  await supabase.auth.signOut();
  currentUser = null;
}

/** Render the auth view — Tasknari splash card style */
export function renderAuth(container) {
  let mode = 'login';

  function render() {
    const isLogin = mode === 'login';
    container.innerHTML = `
      <div class="splash-screen">
        <div class="splash-card">
          <div class="splash-logo">
            <img src="icons/icon-192.png" alt="FubzLifts" style="width:90px;height:90px;border-radius:50%;object-fit:cover;transform:translateZ(0)" />
          </div>
          <h1 class="splash-title">FubzLifts</h1>
          <p class="splash-sub">${isLogin
            ? 'Sign in to sync with your crew.'
            : 'Create an account to start lifting.'}</p>

          <form id="authForm" novalidate>
          ${!isLogin ? `
            <div class="splash-field">
              <label class="splash-label" for="authAlias">Alias (visible to group)</label>
              <input class="field" id="authAlias" name="alias" placeholder="e.g. BigLifter42" maxlength="20" autocomplete="off" />
            </div>
          ` : ''}
          <div class="splash-field">
            <label class="splash-label" for="authEmail">Email</label>
            <input class="field" id="authEmail" name="email" type="email" placeholder="you@email.com" autocomplete="email" />
          </div>
          <div class="splash-field">
            <label class="splash-label" for="authPass">Password</label>
            <input class="field" id="authPass" name="password" type="password" placeholder="••••••••" minlength="6" autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
          </div>
          <div class="splash-field" style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="authRemember" name="remember" style="accent-color:var(--orange);width:16px;height:16px" />
            <label for="authRemember" class="splash-label" style="margin:0;font-size:13px;cursor:pointer">Remember me</label>
          </div>
          <div id="authError" class="splash-error"></div>
          <button type="submit" class="btn btn-primary splash-submit" id="authSubmit">
            ${isLogin ? 'Sign In' : 'Create Account'}
          </button>
          </form>
          <div class="splash-toggle">
            ${isLogin
              ? 'No account? <a id="authToggle">Create one</a>'
              : 'Have an account? <a id="authToggle">Sign in</a>'}
          </div>
          <div class="splash-footer">
            <span class="splash-build">updated ${new Date(BUILD_TIME).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} ${new Date(BUILD_TIME).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}</span>
            <a id="splashCheckUpdate" class="splash-update-link">Check for update</a>
          </div>
        </div>
      </div>
    `;

    // Hide the boot loader once the splash is painted, so it crossfades
    // smoothly into the auth screen instead of flashing.
    requestAnimationFrame(() => {
      document.getElementById('bootSplash')?.classList.add('hide');
    });

    container.querySelector('#authToggle').addEventListener('click', () => {
      mode = isLogin ? 'register' : 'login';
      render();
    });

    container.querySelector('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = container.querySelector('#authSubmit');
      const errEl = container.querySelector('#authError');
      const email = container.querySelector('#authEmail').value.trim();
      const pass = container.querySelector('#authPass').value;
      errEl.textContent = '';

      if (!email || !pass) { errEl.textContent = 'Fill in all fields.'; return; }
      if (pass.length < 6) { errEl.textContent = 'Password must be 6+ characters.'; return; }

      // Save or clear remembered credentials
      const remember = container.querySelector('#authRemember').checked;
      if (remember) {
        localStorage.setItem('fubz_remember', JSON.stringify({ email, pass }));
      } else {
        localStorage.removeItem('fubz_remember');
      }

      btn.disabled = true;
      btn.textContent = 'Loading...';

      if (isLogin) {
        const result = await signIn(email, pass);
        if (!result.ok) { btn.disabled = false; btn.textContent = 'Sign In'; errEl.textContent = result.msg; }
      } else {
        const alias = container.querySelector('#authAlias').value.trim();
        if (!alias) { btn.disabled = false; btn.textContent = 'Create Account'; errEl.textContent = 'Pick an alias.'; return; }
        const result = await signUp(email, pass, alias);
        if (!result.ok) { btn.disabled = false; btn.textContent = 'Create Account'; errEl.textContent = result.msg; }
      }
    });

    // Check for update — clears all caches, unregisters SW, hard reloads with cache bust
    container.querySelector('#splashCheckUpdate').addEventListener('click', async () => {
      const btn = container.querySelector('#splashCheckUpdate');
      btn.textContent = 'Updating…';
      btn.style.pointerEvents = 'none';
      try {
        // Clear all SW caches
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(n => caches.delete(n)));
        // Unregister service worker
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch (e) {}
      // Hard navigate with cache-bust param to bypass browser HTTP cache
      const url = new URL(window.location.href);
      url.searchParams.set('_cb', Date.now());
      window.location.href = url.toString();
    });

    // Restore saved credentials if "Remember me" was checked
    const saved = JSON.parse(localStorage.getItem('fubz_remember') || 'null');
    if (saved) {
      const emailEl = container.querySelector('#authEmail');
      const passEl = container.querySelector('#authPass');
      const remEl = container.querySelector('#authRemember');
      emailEl.value = saved.email || '';
      passEl.value = saved.pass || '';
      remEl.checked = true;
    }

    // Auto-focus first empty field
    setTimeout(() => {
      const first = container.querySelector('#authAlias') || container.querySelector('#authEmail');
      if (first && !first.value) first.focus();
    }, 350);
  }

  render();
}
