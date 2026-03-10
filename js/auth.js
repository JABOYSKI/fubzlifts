// Authentication module
import { supabase } from './supabase.js';
import { toast, STARTING_WEIGHT } from './utils.js';
import { BUILD_TIME } from './version.js';

let currentUser = null;

export function getUser() { return currentUser; }

/** Initialize auth — check existing session */
export async function initAuth() {
  const { data: { session } } = await supabase.auth.getSession();
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

/** Load user profile from public.users, with retry and fallback */
async function loadProfile(authUser) {
  for (let i = 0; i < 3; i++) {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUser.id)
      .single();
    if (data) {
      currentUser = data;
      await ensureProfileWeights(data.id);
      return data;
    }
    if (i < 2) await new Promise(r => setTimeout(r, 600));
  }

  // Fallback: create profile client-side if trigger didn't fire
  const alias = authUser.user_metadata?.alias || 'Lifter';
  const { data: inserted } = await supabase
    .from('users')
    .upsert({ id: authUser.id, alias })
    .select()
    .single();
  if (inserted) {
    currentUser = inserted;
    await ensureProfileWeights(inserted.id);
    return inserted;
  }

  // Last resort: use auth metadata so the app still works
  console.warn('Could not load/create profile, using auth metadata');
  currentUser = { id: authUser.id, alias, avatar_url: null };
  await ensureProfileWeights(authUser.id);
  return currentUser;
}

/** Ensure profile_weights rows exist for a user (seeds defaults if missing) */
async function ensureProfileWeights(userId) {
  const { data } = await supabase
    .from('profile_weights')
    .select('exercise')
    .eq('user_id', userId);
  const existing = (data || []).map(r => r.exercise);
  const exercises = ['squat', 'bench', 'ohp', 'row', 'deadlift'];
  const missing = exercises.filter(e => !existing.includes(e));
  if (missing.length > 0) {
    await supabase.from('profile_weights').insert(
      missing.map(exercise => ({
        user_id: userId,
        exercise,
        weight_lbs: STARTING_WEIGHT,
      }))
    );
  }
}

/** Sign up with email + password — profile created by DB trigger */
export async function signUp(email, password, alias) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { alias } },
  });
  if (error) return { ok: false, msg: error.message };
  return { ok: true };
}

/** Sign in with email + password */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
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
            <img src="icons/icon-192.png" alt="FubzLifts" style="width:96px;height:96px;border-radius:50%" />
          </div>
          <h1 class="splash-title">FubzLifts</h1>
          <p class="splash-sub">${isLogin
            ? 'Sign in to sync with your crew.'
            : 'Create an account to start lifting.'}</p>

          ${!isLogin ? `
            <div class="splash-field">
              <label class="splash-label">Alias (visible to group)</label>
              <input class="field" id="authAlias" placeholder="e.g. BigLifter42" maxlength="20" autocomplete="off" />
            </div>
          ` : ''}
          <div class="splash-field">
            <label class="splash-label">Email</label>
            <input class="field" id="authEmail" type="email" placeholder="you@email.com" autocomplete="email" />
          </div>
          <div class="splash-field">
            <label class="splash-label">Password</label>
            <input class="field" id="authPass" type="password" placeholder="••••••••" minlength="6" autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
          </div>
          <div class="splash-field" style="flex-direction:row;align-items:center;gap:8px">
            <input type="checkbox" id="authRemember" style="accent-color:var(--orange);width:16px;height:16px" />
            <label for="authRemember" class="splash-label" style="margin:0;font-size:13px;cursor:pointer">Remember me</label>
          </div>
          <div id="authError" class="splash-error"></div>
          <button class="btn btn-primary splash-submit" id="authSubmit">
            ${isLogin ? 'Sign In' : 'Create Account'}
          </button>
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

    // Fade body in once splash is painted
    requestAnimationFrame(() => { document.body.style.opacity = '1'; });

    container.querySelector('#authToggle').addEventListener('click', () => {
      mode = isLogin ? 'register' : 'login';
      render();
    });

    container.querySelector('#authSubmit').addEventListener('click', async () => {
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

    // Enter key submits
    container.querySelectorAll('.field').forEach(f => {
      f.addEventListener('keydown', e => {
        if (e.key === 'Enter') container.querySelector('#authSubmit').click();
      });
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
      document.body.style.transition = 'opacity 0.3s ease';
      document.body.style.opacity = '0';
      // Navigate with cache-busting param to bypass browser HTTP cache
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set('_cb', Date.now());
        window.location.replace(url.href);
      }, 350);
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
