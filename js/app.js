// Main app module — routing and state
import { initAuth, onAuthChange, renderAuth, signOut, getUser } from './auth.js';
import { renderGroups } from './group.js';
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    wasHidden = true;
    // Save state before we go
    if (getUser()) {
      sessionStorage.setItem('fubz_resume', JSON.stringify({
        page: currentPage || 'groups',
        groupId: activeGroupId,
      }));
    }
  } else if (wasHidden) {
    // Tab just became visible after being hidden — reload
    wasHidden = false;
    // Hide instantly before reload so there's no visible flash
    document.body.style.transition = 'none';
    document.body.style.opacity = '0';
    window.location.reload();
  }
});

// ─── Init ────────────────────────────────────────────────

async function init() {
  const user = await initAuth();

  onAuthChange((user, event) => {
    if (event === 'SIGNED_IN') {
      if (user) renderApp();
    } else if (event === 'SIGNED_OUT') {
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
  document.body.style.opacity = '1';
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

function navigateTo(page) {
  cleanupSession();
  currentPage = page;
  activeGroupId = null;

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));

  if (page === 'groups') {
    showView('groupsView');
    currentGroupRef = renderGroups(
      document.getElementById('groupsView'),
      (groupId) => { /* group detail — future */ },
      (groupId) => navigateToSession(groupId)
    );
  } else if (page === 'profile') {
    showView('profileView');
    renderProfile();
  }
}

/** Navigate into a session (from group start button or resume) */
function navigateToSession(groupId) {
  cleanupSession();
  currentPage = 'session';
  activeGroupId = groupId;
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  showView('sessionView');
  startSession(groupId, document.getElementById('sessionView'), () => {
    navigateTo('groups');
  });
}

async function renderProfile() {
  const user = getUser();
  const container = document.getElementById('profileView');

  const { data: weights } = await supabase
    .from('profile_weights')
    .select('*')
    .eq('user_id', user.id);

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
          return `
            <div class="form-group" style="flex-direction:row;align-items:center;justify-content:space-between;gap:8px">
              <label style="margin:0;min-width:100px">${EXERCISE_NAMES[ex]}</label>
              <div style="display:flex;align-items:center;gap:6px">
                <input type="number" class="field weight-input" data-exercise="${ex}"
                  value="${weight}" min="0" step="5" style="width:80px;text-align:center" />
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

// Boot
init();
