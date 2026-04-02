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
let lastExercise = null; // track exercise for splash detection
let extraSetSplashShown = {}; // track which exercises already showed the +1 splash
// visibilityHandler removed — app.js invisible reload handles tab resume
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

/** Get max sets for an exercise, respecting lobby DL override and extra set vote */
function getMaxSets(exercise) {
  let sets = DEFAULT_SETS[exercise];
  if (exercise === 'deadlift' && activeSession?.lobby_state?.dl_sets) {
    sets = activeSession.lobby_state.dl_sets;
  }
  // Unanimous +1 set vote
  const extraVotes = activeSession?.lobby_state?.extra_set_votes?.[exercise];
  if (extraVotes && activeSession?.turn_order?.every(uid => extraVotes[uid])) {
    sets += 1;
  }
  return sets;
}

/** Check if an exercise uses simultaneous mode (all lift at once) */
function isSimultaneous(exercise) {
  return !!activeSession?.lobby_state?.simultaneous?.[exercise];
}

/** Compute rest timer for a user from DB timestamps (source of truth) */
function computeTimer(uid) {
  if (!activeSession) return 0;
  const simultaneous = isSimultaneous(activeSession.current_exercise);
  const activeTurnUserId = activeSession.turn_order[activeSession.current_turn_index];

  // Active person in turn mode — they're lifting, timer is 0
  if (!simultaneous && uid === activeTurnUserId) return 0;

  // Time since their last set for the current exercise
  const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === activeSession.current_exercise);
  if (userLogs.length > 0) {
    const lastLog = userLogs[userLogs.length - 1];
    return Math.max(0, Math.floor((Date.now() - new Date(lastLog.logged_at).getTime()) / 1000));
  }

  // No sets yet for this exercise — time since exercise started
  const exStarted = activeSession.lobby_state?.exercise_started_at;
  if (exStarted) {
    return Math.max(0, Math.floor((Date.now() - new Date(exStarted).getTime()) / 1000));
  }

  return 0;
}

/** Refresh all timer values from DB timestamps */
function refreshTimers() {
  if (!activeSession) return;
  activeSession.turn_order.forEach(uid => {
    timers[uid] = computeTimer(uid);
  });
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
      simultaneous: { row: false, deadlift: false },
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
  // Reload all members' weights so everyone sees correct weight for each lifter
  const { data: weights } = await supabase
    .from('profile_weights')
    .select('*')
    .in('user_id', activeSession.turn_order);
  memberWeights = {};
  (weights || []).forEach(w => {
    if (!memberWeights[w.user_id]) memberWeights[w.user_id] = {};
    memberWeights[w.user_id][w.exercise] = w.weight_lbs;
  });

  const { data: logs } = await supabase
    .from('set_logs')
    .select('*')
    .eq('session_id', activeSession.id)
    .order('logged_at', { ascending: true });
  setLogs = logs || [];

  // Timers are computed from DB timestamps (source of truth) — no client state needed
  timers = {};
  refreshTimers();
  lastExercise = activeSession.current_exercise;
  startTimerTick(container);
  renderSession(container);
}

/** Subscribe to real-time session updates + visibility reconnect */
function subscribeToSession(container) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  lobbyContainer = container;

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
        lastExercise = activeSession.current_exercise;
      } else if (activeSession.status === 'active') {
        // Check if exercise changed — show splash for all clients
        const newExercise = activeSession.current_exercise;
        if (lastExercise && newExercise !== lastExercise) {
          const completedExercise = lastExercise;
          lastExercise = newExercise;
          showExerciseSplash(completedExercise, () => renderSession(container));
        } else {
          lastExercise = newExercise;
          // Check if extra set vote just became unanimous
          const exVotes = activeSession.lobby_state?.extra_set_votes?.[newExercise];
          if (exVotes && !extraSetSplashShown[newExercise] && activeSession.turn_order.every(uid => exVotes[uid])) {
            extraSetSplashShown[newExercise] = true;
            showExtraSetSplash(() => renderSession(container));
            return;
          }
          renderSession(container);
        }
      } else if (activeSession.status === 'lobby') {
        // Refresh member list so new joiners have correct aliases
        const members = await getGroupMembers(activeSession.group_id);
        sessionMembers = members;
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
        refreshTimers();
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

  setupLobbyDelegation(container);
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
let pendingUsurpType = null; // for host override confirmation flow

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
        <div class="form-group" id="adminDlGroup" style="${currentType === 'B' ? '' : 'display:none'}">
          <label>Deadlift Sets</label>
          <div class="btn-group" id="adminDlBtns">
            ${[1,2,3,4,5].map(n => `
              <button class="btn ${(lobbyState.dl_sets || 1) === n ? 'btn-primary' : ''} admin-set-dl" data-sets="${n}">${n}</button>
            `).join('')}
          </div>
        </div>
        <div class="form-group" id="adminSimGroup" style="margin-top:12px">
          <label>Simultaneous Sets <span class="muted" style="font-size:11px;font-weight:400">(all lift at once)</span></label>
          <div class="btn-group">
            <button class="btn ${lobbyState.simultaneous?.row ? 'btn-primary' : ''} admin-toggle-sim" data-exercise="row" style="${currentType === 'A' ? '' : 'display:none'}">Row</button>
            <button class="btn ${lobbyState.simultaneous?.deadlift ? 'btn-primary' : ''} admin-toggle-sim" data-exercise="deadlift" style="${currentType === 'B' ? '' : 'display:none'}">Deadlift</button>
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
    // Show/hide DL sets based on workout type
    const dlGroup = container.querySelector('#adminDlGroup');
    if (dlGroup) dlGroup.style.display = currentType === 'B' ? '' : 'none';
    // Patch admin DL buttons
    container.querySelectorAll('.admin-set-dl').forEach(btn => {
      btn.classList.toggle('btn-primary', parseInt(btn.dataset.sets) === (lobbyState.dl_sets || 1));
    });
    // Patch simultaneous buttons visibility and state
    container.querySelectorAll('.admin-toggle-sim').forEach(btn => {
      const ex = btn.dataset.exercise;
      btn.style.display = (ex === 'row' && currentType === 'A') || (ex === 'deadlift' && currentType === 'B') ? '' : 'none';
      btn.classList.toggle('btn-primary', !!lobbyState.simultaneous?.[ex]);
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
      if (dlGroup) dlGroup.style.display = winningVote === 'B' ? '' : 'none';
      container.querySelectorAll('.admin-toggle-sim').forEach(btn => {
        const ex = btn.dataset.exercise;
        btn.style.display = (ex === 'row' && winningVote === 'A') || (ex === 'deadlift' && winningVote === 'B') ? '' : 'none';
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

/** Set up event delegation for all lobby clicks — survives DOM patching */
function setupLobbyDelegation(container) {
  // Remove previous handler if any (idempotent)
  if (container._lobbyClickHandler) {
    container.removeEventListener('click', container._lobbyClickHandler);
  }

  container._lobbyClickHandler = (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    console.warn('[FubzLifts] Lobby click:', target.id || target.className);

    // Vote workout type
    if (target.classList.contains('lobby-vote-workout')) {
      updateMyLobbyState({ workout_vote: target.dataset.type });
      return;
    }

    // Ready toggle
    if (target.id === 'lobbyReadyBtn') {
      const currentVote = activeSession.lobby_state?.members?.[getUser().id] || {};
      updateMyLobbyState({ ready: !currentVote.ready });
      return;
    }

    // Admin set workout type
    if (target.classList.contains('admin-set-workout')) {
      const type = target.dataset.type;
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
        pendingUsurpType = type;
        const confirm = container.querySelector('#usurpConfirm');
        if (confirm) confirm.style.display = 'block';
      } else {
        hostUsurped = false;
        activeSession.workout_type = type;
        container.querySelectorAll('.admin-set-workout').forEach(b => {
          b.classList.toggle('btn-primary', b.dataset.type === type);
        });
        const dlG = container.querySelector('#adminDlGroup');
        if (dlG) dlG.style.display = type === 'B' ? '' : 'none';
        container.querySelectorAll('.admin-toggle-sim').forEach(btn => {
          const ex = btn.dataset.exercise;
          btn.style.display = (ex === 'row' && type === 'A') || (ex === 'deadlift' && type === 'B') ? '' : 'none';
        });
        supabase.from('sessions').update({ workout_type: type }).eq('id', activeSession.id);
      }
      return;
    }

    // Usurp yes
    if (target.id === 'usurpYes') {
      if (pendingUsurpType) {
        hostUsurped = true;
        activeSession.workout_type = pendingUsurpType;
        const confirm = container.querySelector('#usurpConfirm');
        if (confirm) confirm.style.display = 'none';
        // Update admin workout buttons immediately
        container.querySelectorAll('.admin-set-workout').forEach(btn => {
          btn.classList.toggle('btn-primary', btn.dataset.type === pendingUsurpType);
        });
        // Show/hide DL sets and simultaneous buttons based on new type
        const dlGroup = container.querySelector('#adminDlGroup');
        if (dlGroup) dlGroup.style.display = pendingUsurpType === 'B' ? '' : 'none';
        container.querySelectorAll('.admin-toggle-sim').forEach(btn => {
          const ex = btn.dataset.exercise;
          btn.style.display = (ex === 'row' && pendingUsurpType === 'A') || (ex === 'deadlift' && pendingUsurpType === 'B') ? '' : 'none';
        });
        supabase.from('sessions').update({ workout_type: pendingUsurpType }).eq('id', activeSession.id);
        pendingUsurpType = null;
      }
      return;
    }

    // Usurp no
    if (target.id === 'usurpNo') {
      pendingUsurpType = null;
      const confirm = container.querySelector('#usurpConfirm');
      if (confirm) confirm.style.display = 'none';
      return;
    }

    // Admin DL sets
    if (target.classList.contains('admin-set-dl')) {
      const ls = { ...activeSession.lobby_state, dl_sets: parseInt(target.dataset.sets) };
      activeSession.lobby_state = ls;
      container.querySelectorAll('.admin-set-dl').forEach(b => {
        b.classList.toggle('btn-primary', parseInt(b.dataset.sets) === parseInt(target.dataset.sets));
      });
      supabase.from('sessions').update({ lobby_state: ls }).eq('id', activeSession.id);
      return;
    }

    // Toggle simultaneous mode
    if (target.classList.contains('admin-toggle-sim')) {
      const ex = target.dataset.exercise;
      const sim = { ...(activeSession.lobby_state?.simultaneous || {}), [ex]: !activeSession.lobby_state?.simultaneous?.[ex] };
      const ls = { ...activeSession.lobby_state, simultaneous: sim };
      activeSession.lobby_state = ls;
      target.classList.toggle('btn-primary');
      supabase.from('sessions').update({ lobby_state: ls }).eq('id', activeSession.id);
      return;
    }

    // Start workout
    if (target.id === 'lobbyStartBtn') {
      adminStartSession(container);
      return;
    }

    // Leave lobby
    if (target.id === 'lobbyLeaveBtn') {
      leaveLobby();
      return;
    }
  };

  container.addEventListener('click', container._lobbyClickHandler);
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
  console.warn('[FubzLifts] adminStartSession called');
  try {
    const exercises = WORKOUTS[activeSession.workout_type];

    const lobbyWithTimestamp = {
      ...activeSession.lobby_state,
      exercise_started_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('sessions').update({
      status: 'active',
      workout_type: activeSession.workout_type,
      lobby_state: lobbyWithTimestamp,
      current_exercise: exercises[0],
      current_turn_index: 0,
      current_set: 1,
    }).eq('id', activeSession.id);

    if (error) {
      console.error('[FubzLifts] adminStartSession error:', error);
      toast('Failed to start workout: ' + error.message);
    } else {
      console.warn('[FubzLifts] adminStartSession succeeded — waiting for realtime');
    }
  } catch (e) {
    console.error('[FubzLifts] adminStartSession exception:', e);
    toast('Failed to start workout — check connection');
  }
  // The realtime subscription will pick up the status change and render
}

/** Leave the lobby and go back to groups */
function leaveLobby() {
  console.warn('[FubzLifts] leaveLobby called');
  const user = getUser();
  const sessionId = activeSession.id;
  const turnOrder = [...activeSession.turn_order];
  const savedLobbyState = JSON.parse(JSON.stringify(activeSession.lobby_state || {}));

  // Navigate away IMMEDIATELY — don't wait for network
  const cb = onSessionEnd;
  cleanupSession();
  if (cb) cb();

  // Clean up server state in background (fire-and-forget)
  const newOrder = turnOrder.filter(uid => uid !== user.id);
  if (savedLobbyState.members) delete savedLobbyState.members[user.id];

  if (newOrder.length === 0) {
    supabase.from('session_members').delete().eq('session_id', sessionId)
      .then(() => supabase.from('sessions').delete().eq('id', sessionId))
      .catch(e => console.error('[FubzLifts] leaveLobby cleanup error:', e));
  } else {
    Promise.all([
      supabase.from('sessions').update({ turn_order: newOrder, lobby_state: savedLobbyState }).eq('id', sessionId),
      supabase.from('session_members').delete().eq('session_id', sessionId).eq('user_id', user.id),
    ]).catch(e => console.error('[FubzLifts] leaveLobby cleanup error:', e));
  }
}

// ─── ACTIVE SESSION ──────────────────────────────────────

/** Timer tick — increment rest timers for everyone except the active person */
function startTimerTick(container) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!activeSession || activeSession.status !== 'active') return;
    refreshTimers();
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

  let log, error;
  try {
    const result = await supabase
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
    log = result.data;
    error = result.error;
  } catch (e) {
    toast('Connection lost — tap to retry after reconnecting');
    return;
  }

  if (error) { toast('Failed to log set — check connection'); return; }

  if (!setLogs.find(l => l.id === log.id)) setLogs.push(log);

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
      // Update DB immediately — realtime handler shows splash for ALL clients
      // exercise_started_at is the source of truth for timer reset
      await supabase.from('sessions').update({
        current_exercise: nextExercise,
        current_turn_index: 0,
        current_set: 1,
        lobby_state: { ...activeSession.lobby_state, exercise_started_at: new Date().toISOString() },
      }).eq('id', activeSession.id);
    } else {
      await endSession();
    }
    return;
  }

  // In simultaneous mode, no turn rotation — set_logs INSERT triggers re-render
  if (isSimultaneous(exercise)) return;

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

/** Show congratulatory splash between exercises — retro RPG dialogue style */
function showExerciseSplash(exercise, onDone) {
  const message = 'Good job, Maria!!!';
  const splash = document.createElement('div');
  splash.className = 'splash-overlay';
  splash.innerHTML = `
    <style>
      @keyframes catBounce {
        0%, 100% { transform: translateY(0); }
        25% { transform: translateY(-6px) rotate(-3deg); }
        50% { transform: translateY(-2px); }
        75% { transform: translateY(-8px) rotate(3deg); }
      }
      .splash-cat {
        width: 72px; height: 72px; border-radius: 50%; flex-shrink: 0;
        animation: catBounce 1.2s ease-in-out infinite;
      }
      .splash-bubble {
        background: var(--card-bg); border: 2px solid var(--orange);
        border-radius: 14px 14px 14px 2px; padding: 12px 16px;
        font-family: monospace; font-size: 17px; color: var(--orange);
        min-height: 1.4em; letter-spacing: 1px;
      }
      .splash-bubble .cursor {
        display: inline-block; width: 2px; height: 1em;
        background: var(--orange); margin-left: 2px;
        animation: blink 0.5s step-end infinite;
        vertical-align: text-bottom;
      }
      @keyframes blink { 50% { opacity: 0; } }
    </style>
    <div class="splash-content">
      <h2>${EXERCISE_NAMES[exercise]} Complete!</h2>
      <div style="display:flex;align-items:flex-start;justify-content:center;gap:14px;margin:24px 0">
        <img src="icons/icon-192.png" alt="" class="splash-cat" />
        <div class="splash-bubble"><span id="splashText"></span><span class="cursor"></span></div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:14px">Tap anywhere to continue</p>
    </div>
  `;
  document.body.appendChild(splash);

  // Typewriter effect
  const textEl = splash.querySelector('#splashText');
  let charIdx = 0;
  const typeInterval = setInterval(() => {
    if (charIdx < message.length) {
      textEl.textContent += message[charIdx];
      charIdx++;
    } else {
      clearInterval(typeInterval);
    }
  }, 65);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearInterval(typeInterval);
    clearTimeout(autoTimer);
    splash.remove();
    onDone();
  };

  splash.addEventListener('click', dismiss);
  const autoTimer = setTimeout(dismiss, 10000);
}

/** Show extra set splash — cat says TOMCATZ MEOW */
function showExtraSetSplash(onDone) {
  const message = 'TOMCATZ MEOW 1 2 3 MEOW!!!';
  const splash = document.createElement('div');
  splash.className = 'splash-overlay';
  splash.innerHTML = `
    <style>
      @keyframes catBounce2 {
        0%, 100% { transform: translateY(0) rotate(0); }
        20% { transform: translateY(-10px) rotate(-5deg); }
        40% { transform: translateY(-4px) rotate(3deg); }
        60% { transform: translateY(-12px) rotate(-3deg); }
        80% { transform: translateY(-6px) rotate(5deg); }
      }
    </style>
    <div class="splash-content">
      <h2 style="color:var(--danger)">+1 SET!</h2>
      <div style="display:flex;align-items:flex-start;justify-content:center;gap:14px;margin:24px 0">
        <img src="icons/icon-192.png" alt="" style="width:72px;height:72px;border-radius:50%;flex-shrink:0;animation:catBounce2 0.8s ease-in-out infinite" />
        <div style="background:var(--card-bg);border:2px solid var(--danger);border-radius:14px 14px 14px 2px;padding:12px 16px;font-family:monospace;font-size:17px;color:var(--danger);min-height:1.4em;letter-spacing:1px">
          <span id="extraSplashText"></span><span style="display:inline-block;width:2px;height:1em;background:var(--danger);margin-left:2px;animation:blink 0.5s step-end infinite;vertical-align:text-bottom"></span>
        </div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:14px">Tap anywhere to continue</p>
    </div>
  `;
  document.body.appendChild(splash);

  const textEl = splash.querySelector('#extraSplashText');
  let charIdx = 0;
  const typeInterval = setInterval(() => {
    if (charIdx < message.length) {
      textEl.textContent += message[charIdx];
      charIdx++;
    } else {
      clearInterval(typeInterval);
    }
  }, 65);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearInterval(typeInterval);
    clearTimeout(autoTimer);
    splash.remove();
    onDone();
  };

  splash.addEventListener('click', dismiss);
  const autoTimer = setTimeout(dismiss, 10000);
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
  const simultaneous = isSimultaneous(exercise);
  // In simultaneous mode, show your own weight/progress; in turn mode, show active person's
  const activeTurnUserId = simultaneous ? user.id : activeSession.turn_order[activeSession.current_turn_index];
  const isMyTurn = simultaneous || activeTurnUserId === user.id;
  const activeAlias = sessionMembers.find(m => m.id === activeTurnUserId)?.alias || 'Unknown';
  const weight = memberWeights[activeTurnUserId]?.[exercise] || 45;

  const activeLogs = setLogs.filter(l => l.user_id === activeTurnUserId && l.exercise === exercise);
  const currentSetNum = activeLogs.length + 1;
  const mySetsDone = simultaneous && activeLogs.length >= maxSets;

  // Extra set vote state
  const extraVotes = activeSession.lobby_state?.extra_set_votes?.[exercise] || {};
  const iVotedExtra = !!extraVotes[user.id];
  const extraVoteCount = activeSession.turn_order.filter(uid => extraVotes[uid]).length;
  const extraSetActive = activeSession.turn_order.every(uid => extraVotes[uid]);

  // Build vote pips HTML
  const votePipsHtml = activeSession.turn_order.map(uid =>
    `<span class="vote-pip ${extraVotes[uid] ? 'lit' : ''}"></span>`
  ).join('');

  container.innerHTML = `
    <div class="exercise-banner" id="exerciseBanner" style="cursor:pointer">
      <div class="exercise-meta">Workout ${activeSession.workout_type} · ${exercises.indexOf(exercise) + 1}/${exercises.length}</div>
      <div class="exercise-name">${exerciseName}</div>
      <div class="exercise-meta">${maxSets} × 5 reps</div>
      <div class="claw-drawer" id="clawDrawer">
        <button class="claw-btn ${iVotedExtra ? 'voted' : ''}" id="clawVoteBtn" ${iVotedExtra || extraSetActive ? 'disabled' : ''}>
          <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" class="claw-svg">
            <!-- Claws — thick, prominent, visible at small sizes -->
            <path d="M18 24L12 4L24 20Z" fill="#222"/>
            <path d="M38 14L34 -6L46 12Z" fill="#222"/>
            <path d="M62 14L58 -6L70 12Z" fill="#222"/>
            <path d="M82 24L78 4L90 20Z" fill="#222"/>
            <!-- Toe pads -->
            <ellipse cx="22" cy="32" rx="11" ry="14" fill="#C0392B"/>
            <ellipse cx="42" cy="22" rx="10" ry="13" fill="#C0392B"/>
            <ellipse cx="58" cy="22" rx="10" ry="13" fill="#C0392B"/>
            <ellipse cx="78" cy="32" rx="11" ry="14" fill="#C0392B"/>
            <!-- Main pad -->
            <path d="M50 95C28 95 14 82 14 68C14 54 30 46 50 46C70 46 86 54 86 68C86 82 72 95 50 95Z" fill="#C0392B"/>
          </svg>
        </button>
      </div>
      ${extraVoteCount > 0 || extraSetActive ? `<div class="vote-pips" style="margin-top:8px">${votePipsHtml}</div>` : ''}
    </div>

    <div class="turn-indicator ${(isMyTurn && !mySetsDone) ? 'your-turn pulsing' : ''}">
      ${simultaneous
        ? (mySetsDone ? '⏳ Waiting for others...' : '🏋️ EVERYONE LIFTS')
        : (isMyTurn
          ? '🏋️ YOUR TURN'
          : `Waiting for <span class="name">${esc(activeAlias)}</span>`)}
    </div>

    <div class="weight-display">
      ${weight} <span class="weight-unit">lbs</span>
    </div>

    <div class="set-dots">
      ${Array.from({ length: maxSets }, (_, i) => {
        const log = activeLogs[i];
        let cls = '';
        const isNewest = i === activeLogs.length - 1;
        if (log && log.success) cls = 'done' + (isNewest ? ' gleam' : '');
        else if (log && !log.success) cls = 'fail' + (isNewest ? ' gleam' : '');
        else if (i === activeLogs.length) cls = 'current';
        return `<div class="set-dot ${cls}">${i + 1}</div>`;
      }).join('')}
    </div>

    ${(isMyTurn && !mySetsDone) ? `
      <div style="margin:8px 0;display:flex;flex-direction:column;gap:6px;align-items:center">
        <button class="btn btn-primary btn-large" id="doneBtn">
          DONE — Set ${currentSetNum}/${maxSets}
        </button>
        <button class="btn btn-fail" id="failBtn">
          FAIL
        </button>
      </div>
    ` : `
      <div style="margin:8px 0;min-height:72px;display:flex;align-items:center;justify-content:center">
        <div class="muted">${mySetsDone ? 'All sets done — waiting for others' : 'Wait for your turn...'}</div>
      </div>
    `}

    <div class="section">
      <h3 style="margin-bottom:4px;font-size:13px">Rest Timers</h3>
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
              <div class="timer-status">${simultaneous ? (t > 0 ? 'resting' : '') : (isActive ? 'UP NEXT' : (t > 0 ? 'resting' : 'ready'))}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <div class="section">
      <h3 style="margin-bottom:4px;font-size:13px">Progress — ${exerciseName}</h3>
      ${activeSession.turn_order.map(uid => {
        const member = sessionMembers.find(m => m.id === uid);
        const alias = member?.alias || 'Unknown';
        const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
        const mw = memberWeights[uid]?.[exercise] || 45;
        return `
          <div class="card" style="margin-bottom:4px;padding:6px 10px">
            <div class="card-row">
              <div class="card-info">
                <div class="card-title" style="font-size:13px">${esc(alias)} <span class="muted">${mw} lbs</span></div>
              </div>
              <div class="set-dots" style="margin:0">
                ${Array.from({ length: maxSets }, (_, i) => {
                  const log = userLogs[i];
                  let cls = '';
                  const isNewest = i === userLogs.length - 1;
                  if (log && log.success) cls = 'done' + (isNewest ? ' gleam' : '');
                  else if (log && !log.success) cls = 'fail' + (isNewest ? ' gleam' : '');
                  return `<div class="set-dot ${cls}" style="width:20px;height:20px;font-size:9px">${i + 1}</div>`;
                }).join('')}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  if (isMyTurn && !mySetsDone) {
    container.querySelector('#doneBtn')?.addEventListener('click', () => logSet(true));
    container.querySelector('#failBtn')?.addEventListener('click', () => logSet(false));
  }

  // Banner tap → toggle claw drawer
  const banner = container.querySelector('#exerciseBanner');
  const drawer = container.querySelector('#clawDrawer');
  if (banner && drawer) {
    banner.addEventListener('click', (e) => {
      // Don't toggle if they clicked the claw button itself
      if (e.target.closest('#clawVoteBtn')) return;
      drawer.classList.toggle('open');
    });
  }

  // Claw vote handler
  const clawBtn = container.querySelector('#clawVoteBtn');
  if (clawBtn && !iVotedExtra && !extraSetActive) {
    clawBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const votes = { ...(activeSession.lobby_state?.extra_set_votes || {}) };
      votes[exercise] = { ...(votes[exercise] || {}), [user.id]: true };
      const ls = { ...activeSession.lobby_state, extra_set_votes: votes };
      activeSession.lobby_state = ls;
      clawBtn.classList.add('voted');
      clawBtn.disabled = true;
      // Show pips immediately in the banner (outside drawer)
      const bannerEl = container.querySelector('#exerciseBanner');
      let pipsContainer = bannerEl.querySelector('.vote-pips');
      const pipsHtml = activeSession.turn_order.map(uid =>
        `<span class="vote-pip ${votes[exercise]?.[uid] ? 'lit' : ''}"></span>`
      ).join('');
      if (!pipsContainer) {
        const pipsDiv = document.createElement('div');
        pipsDiv.className = 'vote-pips';
        pipsDiv.style.marginTop = '8px';
        pipsDiv.innerHTML = pipsHtml;
        bannerEl.appendChild(pipsDiv);
      } else {
        pipsContainer.innerHTML = pipsHtml;
      }
      await supabase.from('sessions').update({ lobby_state: ls }).eq('id', activeSession.id);
    });
  }
}

/** Render session summary after completion */
function renderSessionSummary(container) {
  const exercises = WORKOUTS[activeSession.workout_type];
  const nextWorkout = activeSession.workout_type === 'A' ? 'B' : 'A';

  const summaryMessage = 'Good job, Maria!!!';
  container.innerHTML = `
    <style>
      @keyframes catBounce {
        0%, 100% { transform: translateY(0); }
        25% { transform: translateY(-6px) rotate(-3deg); }
        50% { transform: translateY(-2px); }
        75% { transform: translateY(-8px) rotate(3deg); }
      }
      .summary-cat {
        width: 72px; height: 72px; border-radius: 50%; flex-shrink: 0;
        animation: catBounce 1.2s ease-in-out infinite;
      }
      .summary-bubble {
        background: var(--card-bg); border: 2px solid var(--orange);
        border-radius: 14px 14px 14px 2px; padding: 12px 16px;
        font-family: monospace; font-size: 17px; color: var(--orange);
        min-height: 1.4em; letter-spacing: 1px;
      }
      .summary-bubble .cursor {
        display: inline-block; width: 2px; height: 1em;
        background: var(--orange); margin-left: 2px;
        animation: blink 0.5s step-end infinite;
        vertical-align: text-bottom;
      }
      @keyframes blink { 50% { opacity: 0; } }
    </style>
    <div class="splash-content" style="animation:none">
      <h2>Workout ${activeSession.workout_type} Complete!</h2>
      <div style="display:flex;align-items:flex-start;justify-content:center;gap:14px;margin:20px 0">
        <img src="icons/icon-192.png" alt="" class="summary-cat" />
        <div class="summary-bubble"><span id="summaryText"></span><span class="cursor"></span></div>
      </div>
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

  // Typewriter effect for summary
  const summaryTextEl = container.querySelector('#summaryText');
  let sIdx = 0;
  const summaryType = setInterval(() => {
    if (sIdx < summaryMessage.length) {
      summaryTextEl.textContent += summaryMessage[sIdx];
      sIdx++;
    } else {
      clearInterval(summaryType);
    }
  }, 65);

  container.querySelector('#backToGroupsBtn')?.addEventListener('click', () => {
    clearInterval(summaryType);
    activeSession = null;
    if (onSessionEnd) onSessionEnd();
  });
}

/** Cleanup when leaving session view */
export function cleanupSession() {
  clearInterval(timerInterval);
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  // Remove delegated click handler
  if (lobbyContainer && lobbyContainer._lobbyClickHandler) {
    lobbyContainer.removeEventListener('click', lobbyContainer._lobbyClickHandler);
    lobbyContainer._lobbyClickHandler = null;
  }
  realtimeChannel = null;
  activeSession = null;
  groupOwnerId = null;
  lobbyRendered = false;
  lobbyContainer = null;
  hostUsurped = false;
  pendingUsurpType = null;
  lastExercise = null;
  extraSetSplashShown = {};
  setLogs = [];
  timers = {};
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
