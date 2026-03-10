// Session flow module — the heart of FubzLifts
import { supabase } from './supabase.js';
import { getUser } from './auth.js';
import { getGroupMembers } from './group.js';
import {
  toast, formatTime, showView,
  WORKOUTS, EXERCISE_NAMES, DEFAULT_SETS,
} from './utils.js';

let activeSession = null;
let sessionMembers = []; // { id, alias, avatar_url, is_admin }
let memberWeights = {};  // { odified: { exercise: weight_lbs } }
let setLogs = [];
let timers = {};
let timerInterval = null;
let realtimeChannel = null;
let onSessionEnd = null;

let groupOwnerId = null; // the group's actual owner
let visibilityHandler = null; // track the handler so we can remove it on cleanup
let lobbyContainer = null; // ref for visibility reconnect

/** Determine who is the session admin (host).
 *  Priority: group owner if present, otherwise first in turn_order. */
function getSessionAdmin() {
  if (!activeSession) return null;
  const order = activeSession.turn_order || [];
  // Group owner takes priority if they're in the session
  if (groupOwnerId && order.includes(groupOwnerId)) return groupOwnerId;
  // Otherwise first person in turn order is de facto admin
  return order[0] || null;
}

/** Get max sets for an exercise, respecting lobby DL override */
function getMaxSets(exercise) {
  if (exercise === 'deadlift' && activeSession?.lobby_state?.dl_sets) {
    return activeSession.lobby_state.dl_sets;
  }
  return DEFAULT_SETS[exercise];
}

/** Start or join a session/lobby for a group */
export async function startSession(groupId, container, onEnd) {
  onSessionEnd = onEnd;
  const user = getUser();

  // Check for active or lobby session in this group
  let { data: existing } = await supabase
    .from('sessions')
    .select('*')
    .eq('group_id', groupId)
    .in('status', ['active', 'lobby'])
    .order('started_at', { ascending: false })
    .limit(1);

  if (existing && existing.length > 0) {
    activeSession = existing[0];
    // Join if not already a member
    await supabase.from('session_members').upsert({
      session_id: activeSession.id,
      user_id: user.id,
    });
    // Add to turn order if not present
    if (!activeSession.turn_order.includes(user.id)) {
      const newOrder = [...activeSession.turn_order, user.id];
      const lobbyState = activeSession.lobby_state || { members: {} };
      if (activeSession.status === 'lobby' && !lobbyState.members[user.id]) {
        lobbyState.members[user.id] = { workout_vote: 'A', ready: false };
      }
      await supabase.from('sessions').update({
        turn_order: newOrder,
        lobby_state: lobbyState,
      }).eq('id', activeSession.id);
      activeSession.turn_order = newOrder;
      activeSession.lobby_state = lobbyState;
    }
  } else {
    // Create new lobby session
    const lobbyState = {
      members: {
        [user.id]: { workout_vote: 'A', ready: false }
      },
      dl_sets: 1,
    };
    const { data: session, error } = await supabase
      .from('sessions')
      .insert({
        group_id: groupId,
        workout_type: 'A',
        status: 'lobby',
        turn_order: [user.id],
        current_exercise: 'squat',
        current_turn_index: 0,
        current_set: 1,
        lobby_state: lobbyState,
      })
      .select()
      .single();
    if (error) { toast(error.message); return; }
    activeSession = session;

    await supabase.from('session_members').insert({
      session_id: session.id,
      user_id: user.id,
    });
  }

  // Load group owner
  const { data: groupData } = await supabase
    .from('groups')
    .select('owner_id')
    .eq('id', activeSession.group_id)
    .single();
  groupOwnerId = groupData?.owner_id || null;

  // Load members and their profile weights
  const members = await getGroupMembers(activeSession.group_id);
  sessionMembers = members;
  const { data: weights } = await supabase
    .from('profile_weights')
    .select('*')
    .in('user_id', activeSession.turn_order);
  memberWeights = {};
  (weights || []).forEach(w => {
    if (!memberWeights[w.user_id]) memberWeights[w.user_id] = {};
    memberWeights[w.user_id][w.exercise] = w.weight_lbs;
  });

  // Subscribe to real-time changes
  subscribeToSession(container);

  if (activeSession.status === 'lobby') {
    renderLobby(container);
  } else {
    // Active session — load logs, start timers
    await loadSessionState(container);
  }
}

/** Load set logs and start timers for an active session */
async function loadSessionState(container) {
  const { data: logs } = await supabase
    .from('set_logs')
    .select('*')
    .eq('session_id', activeSession.id)
    .order('logged_at', { ascending: true });
  setLogs = logs || [];

  timers = {};
  activeSession.turn_order.forEach(uid => { timers[uid] = 0; });
  startTimerTick(container);
  renderSession(container);
}

/** Subscribe to real-time session updates + visibility reconnect */
function subscribeToSession(container) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  lobbyContainer = container;

  // Reconnect realtime when tab becomes visible again (fixes alt-tab issue)
  if (!visibilityHandler) {
    visibilityHandler = async () => {
      if (document.visibilityState === 'visible' && activeSession && lobbyContainer) {
        const { data } = await supabase.from('sessions').select('*').eq('id', activeSession.id).single();
        if (data) {
          activeSession = data;
          if (activeSession.status === 'lobby') {
            lobbyRendered = false;
            renderLobby(lobbyContainer);
          } else if (activeSession.status === 'active') {
            renderSession(lobbyContainer);
          }
        }
        if (realtimeChannel) supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
        setupRealtimeChannel(lobbyContainer);
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }

  setupRealtimeChannel(container);
}

/** Wire up the Supabase realtime channel (separated so visibility handler can reconnect) */
function setupRealtimeChannel(container) {
  realtimeChannel = supabase
    .channel(`session_${activeSession.id}_${Date.now()}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'sessions',
      filter: `id=eq.${activeSession.id}`,
    }, async payload => {
      if (!payload.new) return;
      const prevStatus = activeSession.status;
      activeSession = payload.new;

      if (activeSession.status === 'completed') {
        clearInterval(timerInterval);
        renderSessionSummary(container);
      } else if (activeSession.status === 'active' && prevStatus === 'lobby') {
        lobbyRendered = false;
        await loadSessionState(container);
      } else if (activeSession.status === 'active') {
        renderSession(container);
      } else if (activeSession.status === 'lobby') {
        renderLobby(container);
      }
    })
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'set_logs',
      filter: `session_id=eq.${activeSession.id}`,
    }, payload => {
      if (payload.new) {
        if (!setLogs.find(l => l.id === payload.new.id)) {
          setLogs.push(payload.new);
        }
        timers[payload.new.user_id] = 0;
        renderSession(container);
      }
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'session_members',
      filter: `session_id=eq.${activeSession.id}`,
    }, async payload => {
      const members = await getGroupMembers(activeSession.group_id);
      sessionMembers = members;
      if (payload.new && !timers[payload.new.user_id]) {
        timers[payload.new.user_id] = 0;
      }
      if (activeSession.status === 'lobby') {
        renderLobby(container);
      } else {
        renderSession(container);
      }
    })
    .subscribe();
}

// ─── LOBBY ───────────────────────────────────────────────

let lobbyRendered = false; // track if lobby skeleton is already in DOM

/** Render the pre-session lobby — uses DOM patching to avoid full re-renders */
function renderLobby(container) {
  if (!activeSession || activeSession.status !== 'lobby') return;

  const user = getUser();
  const lobbyState = activeSession.lobby_state || { members: {} };
  const adminId = getSessionAdmin();
  const isHost = adminId === user.id;
  const myVote = lobbyState.members?.[user.id] || { workout_vote: 'A', ready: false };

  const allMembers = activeSession.turn_order.map(uid => {
    const member = sessionMembers.find(m => m.id === uid);
    const vote = lobbyState.members?.[uid] || {};
    return { uid, alias: member?.alias || 'Unknown', ...vote };
  });

  const readyCount = allMembers.filter(m => m.ready).length;
  const allReady = allMembers.length > 0 && allMembers.every(m => m.ready);

  const aVotes = allMembers.filter(m => m.workout_vote === 'A').length;
  const bVotes = allMembers.filter(m => m.workout_vote === 'B').length;

  // If already rendered, patch in-place instead of full innerHTML swap
  if (lobbyRendered && container.querySelector('#lobbyRoot')) {
    patchLobby(container, { myVote, allMembers, adminId, isHost, readyCount, allReady, aVotes, bVotes, lobbyState });
    return;
  }

  lobbyRendered = true;

  container.innerHTML = `
    <div id="lobbyRoot">
      <div class="exercise-banner">
        <div class="exercise-name">Workout Lobby</div>
        <div class="exercise-meta" id="lobbyMeta">${allMembers.length} member${allMembers.length !== 1 ? 's' : ''} · ${readyCount} ready</div>
      </div>

      <!-- Your preferences -->
      <div class="card" style="margin-top:16px">
        <div style="font-size:12px;color:var(--muted-color);text-transform:uppercase;letter-spacing:.6px;font-weight:600;margin-bottom:10px">Your Vote</div>
        <div class="form-group">
          <label>Workout Type</label>
          <div class="btn-group" id="lobbyWorkoutBtns">
            <button class="btn ${myVote.workout_vote === 'A' ? 'btn-primary' : ''} lobby-vote-workout" data-type="A">
              A — Squat/Bench/Row
            </button>
            <button class="btn ${myVote.workout_vote === 'B' ? 'btn-primary' : ''} lobby-vote-workout" data-type="B">
              B — Squat/OHP/DL
            </button>
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px" id="lobbyVoteTally">Votes: A(${aVotes}) · B(${bVotes})</div>
        </div>
        <button class="btn ${myVote.ready ? 'btn-primary' : 'btn-secondary'}" id="lobbyReadyBtn" style="margin-top:12px;width:100%">
          ${myVote.ready ? '✓ Ready — Tap to Unready' : 'Ready Up'}
        </button>
      </div>

      <!-- Members list -->
      <div class="section" style="margin-top:16px">
        <h3>Members</h3>
        <div id="lobbyMembersList">
          ${renderMemberCards(allMembers, adminId)}
        </div>
      </div>

      <div id="lobbyHostArea">
        ${renderHostArea(isHost, allReady, readyCount, allMembers.length, lobbyState, allMembers)}
      </div>

      <button class="btn" id="lobbyLeaveBtn" style="margin-top:16px;width:100%">Leave Lobby</button>
    </div>
  `;

  bindLobbyEvents(container, myVote);
}

/** Render member cards HTML */
function renderMemberCards(allMembers, adminId) {
  return allMembers.map(m => `
    <div class="card lobby-member-card" data-uid="${m.uid}" style="margin-bottom:6px">
      <div class="card-row">
        <div class="card-info">
          <div class="card-title lobby-member-name">
            ${esc(m.alias)}
            ${m.uid === adminId ? '<span class="muted" style="font-size:11px"> (host)</span>' : ''}
          </div>
          <div class="card-subtitle muted lobby-member-vote">
            Vote: <strong>${m.workout_vote || '?'}</strong>
          </div>
        </div>
        <div class="lobby-member-ready" style="font-size:22px;color:${m.ready ? 'var(--teal)' : 'var(--muted-color)'}">${m.ready ? '✓' : '○'}</div>
      </div>
    </div>
  `).join('');
}

/** Patch member cards in-place, only rebuilding if member count changed */
function patchMemberCards(container, allMembers, adminId) {
  const list = container.querySelector('#lobbyMembersList');
  if (!list) return;

  const existing = list.querySelectorAll('.lobby-member-card');
  // If member count changed, rebuild the list
  if (existing.length !== allMembers.length) {
    list.innerHTML = renderMemberCards(allMembers, adminId);
    return;
  }

  // Patch each card in-place
  allMembers.forEach((m, i) => {
    const card = existing[i];
    if (!card) return;

    const nameEl = card.querySelector('.lobby-member-name');
    if (nameEl) {
      const newName = `${esc(m.alias)}${m.uid === adminId ? '<span class="muted" style="font-size:11px"> (host)</span>' : ''}`;
      if (nameEl.innerHTML !== newName) nameEl.innerHTML = newName;
    }

    const voteEl = card.querySelector('.lobby-member-vote');
    if (voteEl) {
      const newVote = `Vote: <strong>${m.workout_vote || '?'}</strong>`;
      if (voteEl.innerHTML !== newVote) voteEl.innerHTML = newVote;
    }

    const readyEl = card.querySelector('.lobby-member-ready');
    if (readyEl) {
      readyEl.style.color = m.ready ? 'var(--teal)' : 'var(--muted-color)';
      readyEl.textContent = m.ready ? '✓' : '○';
    }
  });
}

/** Get the winning workout vote (A or B), defaulting to A on tie */
function getWinningVote(allMembers) {
  const aVotes = allMembers.filter(m => m.workout_vote === 'A').length;
  const bVotes = allMembers.filter(m => m.workout_vote === 'B').length;
  return bVotes > aVotes ? 'B' : 'A';
}

let hostUsurped = false; // tracks whether host manually overrode the vote

/** Render host controls area HTML */
function renderHostArea(isHost, allReady, readyCount, totalMembers, lobbyState, allMembers) {
  if (isHost) {
    const winningVote = getWinningVote(allMembers || []);
    const currentType = activeSession.workout_type;
    const isUsurped = currentType !== winningVote;
    return `
      <div class="card" style="border:1px solid var(--orange);margin-top:16px">
        <div style="font-size:12px;color:var(--orange);text-transform:uppercase;letter-spacing:.6px;font-weight:600;margin-bottom:10px">Host Controls</div>
        <div class="form-group">
          <label>Workout Type <span class="muted" style="font-size:11px;font-weight:400">(follows vote${isUsurped ? ' — overridden' : ''})</span></label>
          <div class="btn-group" id="adminWorkoutBtns">
            <button class="btn ${currentType === 'A' ? 'btn-primary' : ''} admin-set-workout" data-type="A">A</button>
            <button class="btn ${currentType === 'B' ? 'btn-primary' : ''} admin-set-workout" data-type="B">B</button>
          </div>
          <div id="usurpConfirm" style="display:none;margin-top:8px">
            <div style="font-size:12px;color:var(--orange);margin-bottom:6px">Override the group vote?</div>
            <div class="btn-group">
              <button class="btn btn-primary" id="usurpYes" style="font-size:12px">Yes, override</button>
              <button class="btn" id="usurpNo" style="font-size:12px">Cancel</button>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label>Deadlift Sets</label>
          <div class="btn-group" id="adminDlBtns">
            ${[1,2,3,4,5].map(n => `
              <button class="btn ${(lobbyState.dl_sets || 1) === n ? 'btn-primary' : ''} admin-set-dl" data-sets="${n}">${n}</button>
            `).join('')}
          </div>
        </div>
        <button class="btn btn-primary btn-large" id="lobbyStartBtn" style="margin-top:12px;width:100%" ${allReady ? '' : 'disabled'}>
          Start Workout (${readyCount}/${totalMembers} ready)
        </button>
      </div>
    `;
  }
  return `
    <div class="card" style="margin-top:16px">
      <div class="muted" style="text-align:center;padding:8px 0" id="lobbyWaitMsg">
        Waiting for host to start... (${readyCount}/${totalMembers} ready)
      </div>
    </div>
  `;
}

/** Patch lobby DOM in-place without full re-render */
function patchLobby(container, state) {
  const { myVote, allMembers, adminId, isHost, readyCount, allReady, aVotes, bVotes, lobbyState } = state;

  // Patch meta
  const meta = container.querySelector('#lobbyMeta');
  if (meta) meta.textContent = `${allMembers.length} member${allMembers.length !== 1 ? 's' : ''} · ${readyCount} ready`;

  // Patch vote buttons highlight
  container.querySelectorAll('.lobby-vote-workout').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.dataset.type === myVote.workout_vote);
  });

  // Patch vote tally
  const tally = container.querySelector('#lobbyVoteTally');
  if (tally) tally.textContent = `Votes: A(${aVotes}) · B(${bVotes})`;

  // Patch ready button
  const readyBtn = container.querySelector('#lobbyReadyBtn');
  if (readyBtn) {
    readyBtn.classList.toggle('btn-primary', !!myVote.ready);
    readyBtn.classList.toggle('btn-secondary', !myVote.ready);
    readyBtn.textContent = myVote.ready ? '✓ Ready — Tap to Unready' : 'Ready Up';
  }

  // Patch members list in-place
  patchMemberCards(container, allMembers, adminId);

  // Patch host area in-place
  if (isHost) {
    const currentType = activeSession.workout_type;
    // Patch admin workout buttons
    container.querySelectorAll('.admin-set-workout').forEach(btn => {
      btn.classList.toggle('btn-primary', btn.dataset.type === currentType);
    });
    // Patch admin DL buttons
    container.querySelectorAll('.admin-set-dl').forEach(btn => {
      btn.classList.toggle('btn-primary', parseInt(btn.dataset.sets) === (lobbyState.dl_sets || 1));
    });
    // Patch start button
    const startBtn = container.querySelector('#lobbyStartBtn');
    if (startBtn) {
      startBtn.disabled = !allReady;
      startBtn.textContent = `Start Workout (${readyCount}/${allMembers.length} ready)`;
    }
    // Auto-follow vote unless host usurped (applied when votes change via realtime)
    const winningVote = getWinningVote(allMembers);
    if (!hostUsurped && currentType !== winningVote) {
      activeSession.workout_type = winningVote;
      container.querySelectorAll('.admin-set-workout').forEach(btn => {
        btn.classList.toggle('btn-primary', btn.dataset.type === winningVote);
      });
      supabase.from('sessions').update({ workout_type: winningVote }).eq('id', activeSession.id);
    }
  } else {
    // Non-host: patch wait message
    const waitMsg = container.querySelector('#lobbyWaitMsg');
    if (waitMsg) waitMsg.textContent = `Waiting for host to start... (${readyCount}/${allMembers.length} ready)`;
    // If host area was showing host controls but we're no longer host, rebuild it
    if (container.querySelector('#adminWorkoutBtns')) {
      const hostArea = container.querySelector('#lobbyHostArea');
      if (hostArea) {
        hostArea.innerHTML = renderHostArea(false, allReady, readyCount, allMembers.length, lobbyState, allMembers);
      }
    }
  }
}

/** Bind all lobby event handlers */
function bindLobbyEvents(container, myVote) {
  // Vote workout type
  container.querySelectorAll('.lobby-vote-workout').forEach(btn => {
    btn.addEventListener('click', () => updateMyLobbyState({ workout_vote: btn.dataset.type }));
  });

  // Ready toggle
  container.querySelector('#lobbyReadyBtn').addEventListener('click', () => {
    const currentVote = activeSession.lobby_state?.members?.[getUser().id] || {};
    updateMyLobbyState({ ready: !currentVote.ready });
  });

  // Host events
  bindHostEvents(container);

  // Leave lobby
  container.querySelector('#lobbyLeaveBtn').addEventListener('click', () => leaveLobby());
}

/** Bind host-only event handlers (called on initial render and on patch) */
function bindHostEvents(container) {
  let pendingUsurpType = null;

  container.querySelectorAll('.admin-set-workout').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const lobbyState = activeSession.lobby_state || { members: {} };
      const allMembers = activeSession.turn_order.map(uid => {
        const vote = lobbyState.members?.[uid] || {};
        return vote;
      });
      const winningVote = getWinningVote(allMembers.map((v, i) => ({
        workout_vote: v.workout_vote,
        uid: activeSession.turn_order[i],
      })));

      if (type !== winningVote) {
        // Show usurp confirmation
        pendingUsurpType = type;
        const confirm = container.querySelector('#usurpConfirm');
        if (confirm) confirm.style.display = 'block';
      } else {
        // Matches vote — just set it, clear usurp
        hostUsurped = false;
        supabase.from('sessions').update({ workout_type: type }).eq('id', activeSession.id);
      }
    });
  });

  container.querySelector('#usurpYes')?.addEventListener('click', async () => {
    if (pendingUsurpType) {
      hostUsurped = true;
      await supabase.from('sessions').update({ workout_type: pendingUsurpType }).eq('id', activeSession.id);
      const confirm = container.querySelector('#usurpConfirm');
      if (confirm) confirm.style.display = 'none';
      pendingUsurpType = null;
    }
  });

  container.querySelector('#usurpNo')?.addEventListener('click', () => {
    pendingUsurpType = null;
    const confirm = container.querySelector('#usurpConfirm');
    if (confirm) confirm.style.display = 'none';
  });

  container.querySelectorAll('.admin-set-dl').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ls = { ...activeSession.lobby_state, dl_sets: parseInt(btn.dataset.sets) };
      // Optimistic local update
      activeSession.lobby_state = ls;
      container.querySelectorAll('.admin-set-dl').forEach(b => {
        b.classList.toggle('btn-primary', parseInt(b.dataset.sets) === parseInt(btn.dataset.sets));
      });
      await supabase.from('sessions').update({ lobby_state: ls }).eq('id', activeSession.id);
    });
  });

  container.querySelector('#lobbyStartBtn')?.addEventListener('click', () => adminStartSession(container));
}

/** Update this user's lobby state (vote/ready) — optimistic local update */
async function updateMyLobbyState(updates) {
  const user = getUser();
  const lobbyState = { ...activeSession.lobby_state };
  if (!lobbyState.members) lobbyState.members = {};
  if (!lobbyState.members[user.id]) lobbyState.members[user.id] = {};
  Object.assign(lobbyState.members[user.id], updates);

  // Optimistic: update local state and patch UI immediately
  activeSession.lobby_state = lobbyState;
  if (lobbyContainer) renderLobby(lobbyContainer);

  // If host hasn't usurped, auto-follow the winning vote
  const dbUpdate = { lobby_state: lobbyState };
  if (!hostUsurped && getSessionAdmin() === user.id && updates.workout_vote) {
    const allMembers = activeSession.turn_order.map(uid => lobbyState.members?.[uid] || {});
    const winningVote = getWinningVote(allMembers);
    if (activeSession.workout_type !== winningVote) {
      dbUpdate.workout_type = winningVote;
      activeSession.workout_type = winningVote;
    }
  }

  await supabase.from('sessions').update(dbUpdate).eq('id', activeSession.id);
}

/** Host starts the workout — transition lobby → active */
async function adminStartSession(container) {
  const exercises = WORKOUTS[activeSession.workout_type];

  await supabase.from('sessions').update({
    status: 'active',
    current_exercise: exercises[0],
    current_turn_index: 0,
    current_set: 1,
  }).eq('id', activeSession.id);

  // The realtime subscription will pick up the status change and render
}

/** Leave the lobby and go back to groups */
async function leaveLobby() {
  const user = getUser();

  // Remove from turn order
  const newOrder = activeSession.turn_order.filter(uid => uid !== user.id);
  const lobbyState = { ...activeSession.lobby_state };
  if (lobbyState.members) delete lobbyState.members[user.id];

  if (newOrder.length === 0) {
    // Last person — delete the lobby session
    await supabase.from('session_members').delete().eq('session_id', activeSession.id);
    await supabase.from('sessions').delete().eq('id', activeSession.id);
  } else {
    await supabase.from('sessions').update({
      turn_order: newOrder,
      lobby_state: lobbyState,
    }).eq('id', activeSession.id);
    await supabase.from('session_members').delete()
      .eq('session_id', activeSession.id).eq('user_id', user.id);
  }

  cleanupSession();
  if (onSessionEnd) onSessionEnd();
}

// ─── ACTIVE SESSION ──────────────────────────────────────

/** Timer tick — increment rest timers for everyone except the active person */
function startTimerTick(container) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!activeSession || activeSession.status !== 'active') return;
    const activeTurnUserId = activeSession.turn_order[activeSession.current_turn_index];
    activeSession.turn_order.forEach(uid => {
      if (uid !== activeTurnUserId) {
        timers[uid] = (timers[uid] || 0) + 1;
      }
    });
    updateTimerDisplay();
  }, 1000);
}

/** Update just the timer values without full re-render */
function updateTimerDisplay() {
  activeSession.turn_order.forEach(uid => {
    const el = document.querySelector(`.timer-value[data-uid="${uid}"]`);
    if (el) el.textContent = formatTime(timers[uid] || 0);
    const bar = document.querySelector(`.timer-bar-fill[data-uid="${uid}"]`);
    if (bar) {
      const pct = Math.min((timers[uid] || 0) / 300, 1) * 100;
      bar.style.width = pct + '%';
      bar.classList.toggle('warn', timers[uid] >= 180 && timers[uid] < 300);
      bar.classList.toggle('over', timers[uid] >= 300);
    }
  });
}

/** Log a set (done or fail) */
async function logSet(success) {
  const user = getUser();
  const exercise = activeSession.current_exercise;
  const weight = memberWeights[user.id]?.[exercise] || 45;
  const myLogs = setLogs.filter(l => l.user_id === user.id && l.exercise === exercise);
  const setNumber = myLogs.length + 1;

  const { data: log, error } = await supabase
    .from('set_logs')
    .insert({
      session_id: activeSession.id,
      user_id: user.id,
      exercise,
      set_number: setNumber,
      reps: 5,
      weight_lbs: weight,
      success,
    })
    .select()
    .single();

  if (error) { toast(error.message); return; }

  if (!setLogs.find(l => l.id === log.id)) setLogs.push(log);
  timers[user.id] = 0;

  await advanceTurn();
}

/** Advance to next turn, next exercise, or end session */
async function advanceTurn() {
  const exercises = WORKOUTS[activeSession.workout_type];
  const exercise = activeSession.current_exercise;
  const maxSets = getMaxSets(exercise);

  // Check if everyone has finished their sets for this exercise
  const allDone = activeSession.turn_order.every(uid => {
    const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
    return userLogs.length >= maxSets;
  });

  if (allDone) {
    const currentIdx = exercises.indexOf(exercise);
    if (currentIdx < exercises.length - 1) {
      const nextExercise = exercises[currentIdx + 1];
      showExerciseSplash(exercise, () => {
        supabase.from('sessions').update({
          current_exercise: nextExercise,
          current_turn_index: 0,
          current_set: 1,
        }).eq('id', activeSession.id).then(() => {
          activeSession.turn_order.forEach(uid => { timers[uid] = 0; });
        });
      });
    } else {
      await endSession();
    }
    return;
  }

  // Find next person who still has sets to do
  let nextIdx = (activeSession.current_turn_index + 1) % activeSession.turn_order.length;
  let attempts = 0;
  while (attempts < activeSession.turn_order.length) {
    const uid = activeSession.turn_order[nextIdx];
    const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
    if (userLogs.length < maxSets) break;
    nextIdx = (nextIdx + 1) % activeSession.turn_order.length;
    attempts++;
  }

  await supabase.from('sessions').update({
    current_turn_index: nextIdx,
  }).eq('id', activeSession.id);
}

/** Show congratulatory splash between exercises */
function showExerciseSplash(exercise, onDone) {
  const splash = document.createElement('div');
  splash.className = 'splash-overlay';
  splash.innerHTML = `
    <div class="splash-content">
      <h2>${EXERCISE_NAMES[exercise]} Complete!</h2>
      <p>Great work, team. Next exercise loading...</p>
    </div>
  `;
  document.body.appendChild(splash);
  setTimeout(() => {
    splash.remove();
    onDone();
  }, 2000);
}

/** End the session */
async function endSession() {
  await supabase.from('sessions').update({
    status: 'completed',
    ended_at: new Date().toISOString(),
  }).eq('id', activeSession.id);

  // Toggle next workout for the group
  const nextWorkout = activeSession.workout_type === 'A' ? 'B' : 'A';
  await supabase.from('groups').update({ next_workout: nextWorkout }).eq('id', activeSession.group_id);

  await processProgression();

  // Show summary locally (other clients get it via realtime)
  const container = document.getElementById('sessionView');
  clearInterval(timerInterval);
  renderSessionSummary(container);
}

/** Process weight progression after session ends */
async function processProgression() {
  const exercises = WORKOUTS[activeSession.workout_type];

  for (const uid of activeSession.turn_order) {
    for (const exercise of exercises) {
      const maxSets = getMaxSets(exercise);
      const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
      const allSuccess = userLogs.length >= maxSets && userLogs.every(l => l.success);
      const anyFail = userLogs.some(l => !l.success);

      const { data: weightRow } = await supabase
        .from('profile_weights')
        .select('*')
        .eq('user_id', uid)
        .eq('exercise', exercise)
        .single();

      if (!weightRow) continue;

      if (allSuccess) {
        await supabase.from('profile_weights').update({
          weight_lbs: weightRow.weight_lbs + 5,
        }).eq('user_id', uid).eq('exercise', exercise);
      }
      // Update local cache so summary shows new weight
      if (allSuccess && memberWeights[uid]) {
        memberWeights[uid][exercise] = weightRow.weight_lbs + 5;
      }
    }
  }
}

/** Render the active session */
function renderSession(container) {
  if (!activeSession || activeSession.status !== 'active') return;

  const user = getUser();
  const exercise = activeSession.current_exercise;
  const exerciseName = EXERCISE_NAMES[exercise];
  const maxSets = getMaxSets(exercise);
  const exercises = WORKOUTS[activeSession.workout_type];
  const activeTurnUserId = activeSession.turn_order[activeSession.current_turn_index];
  const isMyTurn = activeTurnUserId === user.id;
  const activeAlias = sessionMembers.find(m => m.id === activeTurnUserId)?.alias || 'Unknown';
  const weight = memberWeights[activeTurnUserId]?.[exercise] || 45;

  const activeLogs = setLogs.filter(l => l.user_id === activeTurnUserId && l.exercise === exercise);
  const currentSetNum = activeLogs.length + 1;

  container.innerHTML = `
    <div class="exercise-banner">
      <div class="exercise-meta">Workout ${activeSession.workout_type} · ${exercises.indexOf(exercise) + 1}/${exercises.length}</div>
      <div class="exercise-name">${exerciseName}</div>
      <div class="exercise-meta">${maxSets} × 5 reps</div>
    </div>

    <div class="turn-indicator ${isMyTurn ? 'your-turn pulsing' : ''}">
      ${isMyTurn
        ? '🏋️ YOUR TURN'
        : `Waiting for <span class="name">${esc(activeAlias)}</span>`}
    </div>

    <div class="weight-display">
      ${weight} <span class="weight-unit">lbs</span>
    </div>

    <div class="set-dots">
      ${Array.from({ length: maxSets }, (_, i) => {
        const log = activeLogs[i];
        let cls = '';
        if (log && log.success) cls = 'done';
        else if (log && !log.success) cls = 'fail';
        else if (i === activeLogs.length) cls = 'current';
        return `<div class="set-dot ${cls}">${i + 1}</div>`;
      }).join('')}
    </div>

    ${isMyTurn ? `
      <div style="margin:16px 0;display:flex;flex-direction:column;gap:8px;align-items:center">
        <button class="btn btn-primary btn-large" id="doneBtn">
          DONE — Set ${currentSetNum}/${maxSets}
        </button>
        <button class="btn btn-fail" id="failBtn">
          FAIL
        </button>
      </div>
    ` : `
      <div style="margin:16px 0;text-align:center">
        <div class="muted">Wait for your turn...</div>
      </div>
    `}

    <div class="section">
      <h3>Rest Timers</h3>
      <div class="timer-stack">
        ${activeSession.turn_order.map(uid => {
          const member = sessionMembers.find(m => m.id === uid);
          const alias = member?.alias || 'Unknown';
          const isActive = uid === activeTurnUserId;
          const t = timers[uid] || 0;
          return `
            <div class="timer-row ${isActive ? 'active' : ''}">
              <div class="timer-alias">${esc(alias)}</div>
              <div class="timer-bar">
                <div class="timer-bar-fill" data-uid="${uid}" style="width:${Math.min(t / 300, 1) * 100}%"></div>
              </div>
              <div class="timer-value" data-uid="${uid}">${formatTime(t)}</div>
              <div class="timer-status">${isActive ? 'UP NEXT' : (t > 0 ? 'resting' : 'ready')}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="section">
      <h3>Progress — ${exerciseName}</h3>
      ${activeSession.turn_order.map(uid => {
        const member = sessionMembers.find(m => m.id === uid);
        const alias = member?.alias || 'Unknown';
        const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
        const mw = memberWeights[uid]?.[exercise] || 45;
        return `
          <div class="card" style="margin-bottom:6px">
            <div class="card-row">
              <div class="card-info">
                <div class="card-title">${esc(alias)} <span class="muted">${mw} lbs</span></div>
              </div>
              <div class="set-dots" style="margin:0">
                ${Array.from({ length: maxSets }, (_, i) => {
                  const log = userLogs[i];
                  let cls = '';
                  if (log && log.success) cls = 'done';
                  else if (log && !log.success) cls = 'fail';
                  return `<div class="set-dot ${cls}" style="width:20px;height:20px;font-size:9px">${i + 1}</div>`;
                }).join('')}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  if (isMyTurn) {
    container.querySelector('#doneBtn')?.addEventListener('click', () => logSet(true));
    container.querySelector('#failBtn')?.addEventListener('click', () => logSet(false));
  }
}

/** Render session summary after completion */
function renderSessionSummary(container) {
  const exercises = WORKOUTS[activeSession.workout_type];
  const nextWorkout = activeSession.workout_type === 'A' ? 'B' : 'A';

  container.innerHTML = `
    <div class="splash-content" style="animation:none">
      <h2>Workout ${activeSession.workout_type} Complete!</h2>
      <p class="muted">Next session: Workout ${nextWorkout}</p>
    </div>

    ${exercises.map(exercise => `
      <div class="summary-card">
        <h3>${EXERCISE_NAMES[exercise]}</h3>
        ${activeSession.turn_order.map(uid => {
          const member = sessionMembers.find(m => m.id === uid);
          const alias = member?.alias || 'Unknown';
          const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
          const successes = userLogs.filter(l => l.success).length;
          const fails = userLogs.filter(l => !l.success).length;
          const weight = userLogs[0]?.weight_lbs || '?';
          return `
            <div class="summary-row">
              <span>${esc(alias)}</span>
              <span>
                ${weight} lbs ·
                <span class="badge badge-success">${successes}✓</span>
                ${fails > 0 ? `<span class="badge badge-danger">${fails}✗</span>` : ''}
              </span>
            </div>
          `;
        }).join('')}
      </div>
    `).join('')}

    <button class="btn btn-primary btn-large" id="backToGroupsBtn" style="margin-top:20px">
      Back to Groups
    </button>
  `;

  container.querySelector('#backToGroupsBtn')?.addEventListener('click', () => {
    activeSession = null;
    if (onSessionEnd) onSessionEnd();
  });
}

/** Cleanup when leaving session view */
export function cleanupSession() {
  clearInterval(timerInterval);
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  realtimeChannel = null;
  activeSession = null;
  groupOwnerId = null;
  lobbyRendered = false;
  lobbyContainer = null;
  hostUsurped = false;
  setLogs = [];
  timers = {};
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
