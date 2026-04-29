// Main app module — routing and state
import { initAuth, onAuthChange, renderAuth, signOut, getUser } from './auth.js';
import { renderGroups, clearGroupsCache } from './group.js';
import { startSession, cleanupSession } from './session.js';
import { supabase } from './supabase.js';
import { showView, toast, EXERCISE_NAMES } from './utils.js';

let currentGroupRef = null;
let currentPage = null;
let activeGroupId = null; // track which group we're in a session for

// ─── Invisible reload on tab resume ───────────────────────
// Saves current page + session group, reloads from SW cache (instant),
// restores position. Fixes all handler/token/realtime issues.
let wasHidden = false;

function saveResumeState() {
  if (getUser()) {
    sessionStorage.setItem('fubz_resume', JSON.stringify({
      page: currentPage || 'groups',
      groupId: activeGroupId,
    }));
  }
}

// All recovery paths funnel through invisibleReload. Two layers of guard:
//   1. MIN_RELOAD_INTERVAL_MS: no two reloads within 30s. Catches fast
//      cascades (multiple triggers firing on the same event).
//   2. MAX_RELOADS_PER_SESSION: cap at 2 reloads per tab session. Catches
//      slow loops (e.g., a stale SW reactivating on every load, or auth
//      stuck in a bad cached state). Reset on first successful click —
//      that's strong evidence the page is functional, so future reloads
//      (overnight resume etc.) should work normally.
// Counter and timestamp both live in sessionStorage so they survive the
// reload itself but reset on tab close.
const MIN_RELOAD_INTERVAL_MS = 30 * 1000;
const MAX_RELOADS_PER_SESSION = 2;

function invisibleReload() {
  const last = parseInt(sessionStorage.getItem('fubz_last_reload') || '0', 10);
  const sinceLast = Date.now() - last;
  if (sinceLast < MIN_RELOAD_INTERVAL_MS) {
    console.warn('[FubzLifts] Reload suppressed — last reload was', Math.round(sinceLast / 1000) + 's ago');
    return;
  }
  const count = parseInt(sessionStorage.getItem('fubz_reload_count') || '0', 10);
  if (count >= MAX_RELOADS_PER_SESSION) {
    console.warn('[FubzLifts] Reload suppressed — already reloaded', count, 'times this session. Likely a stuck loop; clear site data or close + reopen the tab to reset.');
    return;
  }
  sessionStorage.setItem('fubz_last_reload', String(Date.now()));
  sessionStorage.setItem('fubz_reload_count', String(count + 1));
  // Re-show the boot loader so the page-being-replaced is masked by the
  // same loading UI the user sees on a normal load. No fade-to-black flash.
  document.getElementById('bootSplash')?.classList.remove('hide');
  window.location.reload();
}

// First successful click ⇒ the page is functional ⇒ clear the reload
// counter so legitimate future reloads (auth refresh, deploy detection,
// stall recovery) aren't blocked.
document.addEventListener('click', () => {
  sessionStorage.removeItem('fubz_reload_count');
}, { once: true, passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    wasHidden = true;
    saveResumeState();
  } else if (wasHidden) {
    wasHidden = false;
    invisibleReload();
  }
});

// iOS Safari: pageshow fires when restoring from BFCache (app switcher)
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    saveResumeState();
    invisibleReload();
  }
});

// Fallback: window focus after being hidden (covers edge cases on iOS/Android)
window.addEventListener('focus', () => {
  if (wasHidden) {
    wasHidden = false;
    invisibleReload();
  }
});

// ─── Health watchdog ─────────────────────────────────────
// Catches the case where someone keeps the tab in the foreground for an
// hour straight (typical gym session) and the JWT silently expires or the
// realtime websocket dies without firing visibilitychange. Every 5 minutes:
//   1. supabase.auth.getSession() — also proactively refreshes the access
//      token if it's near expiry, which is the primary thing keeping the
//      session alive across long workouts.
//   2. If the session is gone or any realtime channel is in errored/closed
//      state, fire invisibleReload() — same recovery path the visibility
//      handler uses, so resume state is preserved.
// Track when the watchdog last actually ran. setInterval gets aggressively
// throttled (or paused entirely) when the OS suspends the tab/app — coming
// back hours later, the next "tick" might fire wildly late, but checking
// this timestamp lets us notice and force-reload regardless.
let lastWatchdogTickAt = Date.now();
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;
const WATCHDOG_STALL_MS = 5 * 60 * 1000; // missed ≥2 ticks ⇒ system slept

async function healthCheck() {
  lastWatchdogTickAt = Date.now();
  if (!getUser()) return;
  if (document.visibilityState === 'hidden') return; // resume path will catch it
  try {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session) {
      console.warn('[FubzLifts] Health check: auth session missing, reloading');
      invisibleReload();
      return;
    }
    const channels = supabase.getChannels();
    const broken = channels.find(c => c.state === 'errored' || c.state === 'closed');
    if (broken) {
      console.warn('[FubzLifts] Health check: realtime channel broken', broken.topic, broken.state);
      invisibleReload();
    }
  } catch (e) {
    console.error('[FubzLifts] Health check failed:', e);
  }
}
setInterval(healthCheck, WATCHDOG_INTERVAL_MS);

// Stall detector — runs on every focus/visibility-resume. If the watchdog
// hasn't ticked recently (background throttling, OS suspend, laptop lid),
// the in-memory state is almost certainly stale: JWT may be expired, realtime
// dead, optimistic updates lost. Force a clean reload.
function checkForStall() {
  if (!getUser()) return;
  if (document.visibilityState === 'hidden') return;
  const idle = Date.now() - lastWatchdogTickAt;
  if (idle > WATCHDOG_STALL_MS) {
    console.warn('[FubzLifts] Watchdog stall detected — reloading after', Math.round(idle / 1000), 's idle');
    invisibleReload();
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForStall();
});
window.addEventListener('focus', checkForStall);

// ─── Init ────────────────────────────────────────────────

async function init() {
  // initAuth can throw if Supabase is unreachable or the cached refresh
  // token rejects on revalidation (common after long idle). If we let that
  // bubble out, body.opacity stays at 0 (CSS default) and the user sees a
  // blank page — exactly the "timed out" symptom. Catch it, surface the
  // auth screen, and let them re-sign-in.
  let user = null;
  try {
    user = await initAuth();
  } catch (e) {
    console.error('[FubzLifts] initAuth threw — falling back to auth screen:', e);
  }

  onAuthChange((user, event) => {
    if (event === 'SIGNED_IN') {
      if (user) renderApp();
    } else if (event === 'SIGNED_OUT') {
      // Drop per-user caches so a different user signing in next doesn't
      // briefly see the previous user's data while revalidation runs.
      clearGroupsCache();
      clearProfileCache();
      showAuthScreen();
    }
  });

  if (user) {
    renderApp();
  } else {
    showAuthScreen();
  }
}

function showAuthScreen() {
  document.querySelector('header').style.display = 'none';
  document.querySelector('.container').style.display = 'none';
  hideNav();
  let splash = document.getElementById('authSplash');
  if (!splash) {
    splash = document.createElement('div');
    splash.id = 'authSplash';
    document.body.appendChild(splash);
  }
  renderAuth(splash);
}

function dismissAuthScreen() {
  document.querySelector('header').style.display = '';
  document.querySelector('.container').style.display = '';
  document.getElementById('bootSplash')?.classList.add('hide');
  const splash = document.getElementById('authSplash');
  if (splash) {
    const screen = splash.querySelector('.splash-screen');
    if (screen) {
      screen.classList.add('hidden');
      setTimeout(() => splash.remove(), 260);
    } else {
      splash.remove();
    }
  }
}

function renderApp() {
  const user = getUser();
  if (!user) return;

  dismissAuthScreen();
  document.getElementById('headerAlias').textContent = user.alias;
  showNav();

  // Check for saved resume state (from invisible reload)
  const resume = JSON.parse(sessionStorage.getItem('fubz_resume') || 'null');
  sessionStorage.removeItem('fubz_resume');

  if (resume?.page === 'session' && resume.groupId) {
    // Restore into session/lobby for the same group
    navigateToSession(resume.groupId);
  } else if (resume?.page === 'profile') {
    navigateTo('profile');
  } else {
    navigateTo('groups');
  }
}

async function navigateTo(page) {
  cleanupSession();
  currentPage = page;
  activeGroupId = null;

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));

  // Render new content into the (currently inactive) view BEFORE triggering
  // showView. The View Transitions API snapshots both the old and new states
  // when the active class flips — if we swap first and render after, the user
  // sees the transition complete onto stale/empty content and the real data
  // pops in afterward (the "flashing" the user reports).
  if (page === 'groups') {
    currentGroupRef = await renderGroups(
      document.getElementById('groupsView'),
      (groupId) => { /* group detail — future */ },
      (groupId) => navigateToSession(groupId)
    );
    showView('groupsView');
  } else if (page === 'profile') {
    await renderProfile();
    showView('profileView');
  }
}

/** Navigate into a session (from group start button or resume) */
async function navigateToSession(groupId) {
  cleanupSession();
  currentPage = 'session';
  activeGroupId = groupId;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  // Same pattern as navigateTo — populate the new view before flipping it on,
  // so the View Transition snapshots a fully-rendered session view.
  await startSession(groupId, document.getElementById('sessionView'), () => {
    navigateTo('groups');
  });
  showView('sessionView');
}

// Cache the user's weights so Profile can render instantly on revisit.
// Populated by the fetch path, updated in place by Save.
let cachedProfileWeights = null;
function clearProfileCache() { cachedProfileWeights = null; }

function sameWeights(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const byEx = arr => Object.fromEntries((arr || []).map(r => [r.exercise, r.weight_lbs]));
  const A = byEx(a), B = byEx(b);
  for (const k of Object.keys(A)) if (A[k] !== B[k]) return false;
  for (const k of Object.keys(B)) if (A[k] !== B[k]) return false;
  return true;
}

async function renderProfile() {
  const user = getUser();
  const container = document.getElementById('profileView');

  // Optimistic path: render cached weights immediately, revalidate in background.
  if (cachedProfileWeights) {
    drawProfile(container, user, cachedProfileWeights);
    // Background revalidate — only re-render if weights actually changed
    // (e.g. progression after a session) AND no input is currently focused
    // (don't yank a value out from under a user typing into it).
    (async () => {
      const { data: fresh } = await supabase
        .from('profile_weights').select('*').eq('user_id', user.id);
      if (!fresh || sameWeights(fresh, cachedProfileWeights)) return;
      cachedProfileWeights = fresh;
      const focused = container.contains(document.activeElement) &&
        document.activeElement?.classList.contains('weight-input');
      if (focused) return;
      drawProfile(container, user, fresh);
    })();
    return;
  }

  // First load: must await so the View Transition snapshots populated content
  const { data: weights } = await supabase
    .from('profile_weights')
    .select('*')
    .eq('user_id', user.id);
  cachedProfileWeights = weights || [];
  drawProfile(container, user, cachedProfileWeights);
}

function drawProfile(container, user, weights) {
  const exercises = ['squat', 'bench', 'ohp', 'row', 'deadlift'];

  container.innerHTML = `
    <div class="section">
      <h2>Profile</h2>
      <div class="card">
        <div class="form-group">
          <label>Alias</label>
          <div style="font-size:16px;font-weight:600;color:var(--orange)">${esc(user.alias)}</div>
        </div>
        <div class="form-group">
          <label>User ID</label>
          <div class="muted" style="font-size:11px;word-break:break-all">${user.id}</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h3>My Weights</h3>
      <div class="card">
        ${exercises.map(ex => {
          const w = (weights || []).find(r => r.exercise === ex);
          const weight = w?.weight_lbs || 45;
          const inputId = `weight-${ex}`;
          return `
            <div class="form-group" style="flex-direction:row;align-items:center;justify-content:space-between;gap:8px">
              <label for="${inputId}" style="margin:0;min-width:100px">${EXERCISE_NAMES[ex]}</label>
              <div style="display:flex;align-items:center;gap:6px">
                <input type="number" id="${inputId}" class="field weight-input" data-exercise="${ex}"
                  value="${weight}" min="0" max="999" step="5" inputmode="numeric" style="width:80px;text-align:center" />
                <span class="muted" style="font-size:12px">lbs</span>
              </div>
            </div>
          `;
        }).join('')}
        <button class="btn btn-primary" id="saveWeightsBtn" style="margin-top:12px;width:100%">Save Weights</button>
      </div>
    </div>

    <button class="btn btn-danger" id="signOutBtn" style="margin-top:16px">Sign Out</button>
  `;

  container.querySelector('#saveWeightsBtn').addEventListener('click', async () => {
    const btn = container.querySelector('#saveWeightsBtn');
    const inputs = container.querySelectorAll('.weight-input');
    const rows = [];
    inputs.forEach(input => {
      rows.push({
        user_id: user.id,
        exercise: input.dataset.exercise,
        weight_lbs: parseInt(input.value) || 45,
      });
    });
    const { error } = await supabase.from('profile_weights').upsert(rows);
    if (error) { toast(error.message); return; }
    // Mirror the save into the cache so the next visit to Profile doesn't
    // briefly show stale values before silently revalidating.
    cachedProfileWeights = rows;
    toast('Weights saved!');
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = 'Save Weights'; }, 1500);
  });

  container.querySelector('#signOutBtn').addEventListener('click', async () => {
    await signOut();
    showAuthScreen();
  });
}

function showNav() {
  document.getElementById('navBar').style.display = 'flex';
  document.getElementById('headerRight').style.display = 'flex';
}

function hideNav() {
  document.getElementById('navBar').style.display = 'none';
  document.getElementById('headerRight').style.display = 'none';
}

// Nav tab clicks
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => navigateTo(tab.dataset.page));
});

// Header logo → groups, header alias → profile
document.getElementById('headerLogo').addEventListener('click', () => {
  if (getUser()) navigateTo('groups');
});
document.getElementById('headerAlias').addEventListener('click', () => {
  if (getUser()) navigateTo('profile');
});

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Boot — last-ditch fallback so any unexpected init failure still shows the
// auth screen instead of leaving the body permanently invisible.
init().catch(e => {
  console.error('[FubzLifts] init() rejected:', e);
  showAuthScreen();
});
