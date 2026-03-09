// Main app module — routing and state
import { initAuth, onAuthChange, renderAuth, signOut, getUser } from './auth.js';
import { renderGroups } from './group.js';
import { startSession, cleanupSession } from './session.js';
import { showView, toast } from './utils.js';

let currentGroupRef = null;

async function init() {
  const user = await initAuth();

  onAuthChange((user, event) => {
    if (user) {
      renderApp();
    } else {
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
  // Render splash directly on body
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
  const splash = document.getElementById('authSplash');
  if (splash) splash.remove();
}

function renderApp() {
  const user = getUser();
  if (!user) return;

  dismissAuthScreen();
  // Update header
  document.getElementById('headerAlias').textContent = user.alias;
  showNav();
  navigateTo('groups');
}

function navigateTo(page) {
  cleanupSession();

  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));

  if (page === 'groups') {
    showView('groupsView');
    currentGroupRef = renderGroups(
      document.getElementById('groupsView'),
      (groupId) => { /* group detail — future */ },
      (groupId, workoutType) => {
        // Start session with chosen workout type
        showView('sessionView');
        startSession(groupId, document.getElementById('sessionView'), () => {
          navigateTo('groups');
        }, workoutType);
      }
    );
  } else if (page === 'profile') {
    showView('profileView');
    renderProfile();
  }
}

function renderProfile() {
  const user = getUser();
  const container = document.getElementById('profileView');
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
      <button class="btn btn-danger" id="signOutBtn" style="margin-top:16px">Sign Out</button>
    </div>
  `;
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

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Boot
init();
