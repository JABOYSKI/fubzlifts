// Session flow module — the heart of FubzLifts
import { supabase } from './supabase.js';
import { getUser } from './auth.js';
import { getGroupMembers, getGroupWeights } from './group.js';
import {
  toast, formatTime, showView,
  WORKOUTS, EXERCISE_NAMES, DEFAULT_SETS,
} from './utils.js';

let activeSession = null;
let sessionMembers = []; // { id, alias, avatar_url }
let memberWeights = {};  // { odified: { exercise: weight_lbs } }
let setLogs = [];         // all set_logs for this session
let timers = {};          // { odified: secondsSinceLastSet }
let timerInterval = null;
let realtimeChannel = null;
let onSessionEnd = null;

/** Start or join a session for a group */
export async function startSession(groupId, container, onEnd, chosenWorkoutType) {
  onSessionEnd = onEnd;
  const user = getUser();

  // Check for active session in this group
  let { data: existing } = await supabase
    .from('sessions')
    .select('*')
    .eq('group_id', groupId)
    .eq('status', 'active')
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
      await supabase.from('sessions').update({ turn_order: newOrder }).eq('id', activeSession.id);
      activeSession.turn_order = newOrder;
    }
  } else {
    // Use chosen workout type, or fall back to group's next_workout
    const workoutType = chosenWorkoutType || 'A';
    const exercises = WORKOUTS[workoutType];

    // Create new session
    const { data: session, error } = await supabase
      .from('sessions')
      .insert({
        group_id: groupId,
        workout_type: workoutType,
        status: 'active',
        turn_order: [user.id],
        current_exercise: exercises[0],
        current_turn_index: 0,
        current_set: 1,
      })
      .select()
      .single();
    if (error) { toast(error.message); return; }
    activeSession = session;

    // Add creator as session member
    await supabase.from('session_members').insert({
      session_id: session.id,
      user_id: user.id,
    });
  }

  // Load members and weights
  const members = await getGroupMembers(groupId);
  sessionMembers = members;
  const weights = await getGroupWeights(groupId);
  memberWeights = {};
  weights.forEach(w => {
    if (!memberWeights[w.user_id]) memberWeights[w.user_id] = {};
    memberWeights[w.user_id][w.exercise] = w.weight_lbs;
  });

  // Load existing set logs
  const { data: logs } = await supabase
    .from('set_logs')
    .select('*')
    .eq('session_id', activeSession.id)
    .order('logged_at', { ascending: true });
  setLogs = logs || [];

  // Init timers
  timers = {};
  activeSession.turn_order.forEach(uid => { timers[uid] = 0; });

  // Subscribe to real-time changes
  subscribeToSession(container);

  // Start timer tick
  startTimerTick(container);

  // Render
  renderSession(container);
}

/** Subscribe to real-time session updates */
function subscribeToSession(container) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);

  realtimeChannel = supabase
    .channel(`session_${activeSession.id}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'sessions',
      filter: `id=eq.${activeSession.id}`,
    }, payload => {
      if (payload.new) {
        activeSession = payload.new;
        renderSession(container);
      }
    })
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'set_logs',
      filter: `session_id=eq.${activeSession.id}`,
    }, payload => {
      if (payload.new) {
        // Avoid duplicates
        if (!setLogs.find(l => l.id === payload.new.id)) {
          setLogs.push(payload.new);
        }
        // Reset timer for the user who just logged
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
      // Reload members when someone joins
      const members = await getGroupMembers(activeSession.group_id);
      sessionMembers = members;
      if (payload.new && !timers[payload.new.user_id]) {
        timers[payload.new.user_id] = 0;
      }
      renderSession(container);
    })
    .subscribe();
}

/** Timer tick — increment rest timers for everyone except the active person */
function startTimerTick(container) {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
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
    // Update bar fill
    const bar = document.querySelector(`.timer-bar-fill[data-uid="${uid}"]`);
    if (bar) {
      const pct = Math.min((timers[uid] || 0) / 300, 1) * 100; // 300s = 5min
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

  // Insert set log
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

  // Add locally immediately
  if (!setLogs.find(l => l.id === log.id)) setLogs.push(log);
  timers[user.id] = 0;

  // Determine next turn
  await advanceTurn();
}

/** Advance to next turn, next exercise, or end session */
async function advanceTurn() {
  const exercises = WORKOUTS[activeSession.workout_type];
  const exercise = activeSession.current_exercise;
  const maxSets = DEFAULT_SETS[exercise];

  // Check if everyone has finished their sets for this exercise
  const allDone = activeSession.turn_order.every(uid => {
    const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
    return userLogs.length >= maxSets;
  });

  if (allDone) {
    // Move to next exercise
    const currentIdx = exercises.indexOf(exercise);
    if (currentIdx < exercises.length - 1) {
      const nextExercise = exercises[currentIdx + 1];
      // Show splash then advance
      showExerciseSplash(exercise, () => {
        supabase.from('sessions').update({
          current_exercise: nextExercise,
          current_turn_index: 0,
          current_set: 1,
        }).eq('id', activeSession.id).then(() => {
          // Reset timers for new exercise
          activeSession.turn_order.forEach(uid => { timers[uid] = 0; });
        });
      });
    } else {
      // Session complete!
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
  // Update session status
  await supabase.from('sessions').update({
    status: 'completed',
    ended_at: new Date().toISOString(),
  }).eq('id', activeSession.id);

  // Toggle next workout for the group
  const nextWorkout = activeSession.workout_type === 'A' ? 'B' : 'A';
  await supabase.from('groups').update({ next_workout: nextWorkout }).eq('id', activeSession.group_id);

  // Process progression for each user
  await processProgression();

  // Show summary
  const container = document.getElementById('sessionView');
  renderSessionSummary(container);

  // Cleanup
  clearInterval(timerInterval);
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
}

/** Process weight progression after session ends */
async function processProgression() {
  const exercises = WORKOUTS[activeSession.workout_type];

  for (const uid of activeSession.turn_order) {
    for (const exercise of exercises) {
      const maxSets = DEFAULT_SETS[exercise];
      const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
      const allSuccess = userLogs.length >= maxSets && userLogs.every(l => l.success);
      const anyFail = userLogs.some(l => !l.success);

      const { data: weightRow } = await supabase
        .from('user_weights')
        .select('*')
        .eq('user_id', uid)
        .eq('group_id', activeSession.group_id)
        .eq('exercise', exercise)
        .single();

      if (!weightRow) continue;

      if (allSuccess) {
        // Progress: +5 lbs, reset fail streak
        await supabase.from('user_weights').update({
          weight_lbs: weightRow.weight_lbs + 5,
          fail_streak: 0,
        }).eq('user_id', uid).eq('group_id', activeSession.group_id).eq('exercise', exercise);
      } else if (anyFail) {
        const newStreak = weightRow.fail_streak + 1;
        await supabase.from('user_weights').update({
          fail_streak: newStreak,
        }).eq('user_id', uid).eq('group_id', activeSession.group_id).eq('exercise', exercise);
        // Deload prompt handled client-side for the current user
      }
    }
  }
}

/** Render the active session */
function renderSession(container) {
  if (!activeSession || activeSession.status === 'completed') return;

  const user = getUser();
  const exercise = activeSession.current_exercise;
  const exerciseName = EXERCISE_NAMES[exercise];
  const maxSets = DEFAULT_SETS[exercise];
  const exercises = WORKOUTS[activeSession.workout_type];
  const activeTurnUserId = activeSession.turn_order[activeSession.current_turn_index];
  const isMyTurn = activeTurnUserId === user.id;
  const activeAlias = sessionMembers.find(m => m.id === activeTurnUserId)?.alias || 'Unknown';
  const weight = memberWeights[activeTurnUserId]?.[exercise] || 45;

  // Current user's logs for this exercise
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

    <!-- Set dots for active person -->
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

    <!-- Action buttons (only active for current turn) -->
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

    <!-- Timer stack -->
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

    <!-- All members' progress for this exercise -->
    <div class="section">
      <h3>Progress — ${exerciseName}</h3>
      ${activeSession.turn_order.map(uid => {
        const member = sessionMembers.find(m => m.id === uid);
        const alias = member?.alias || 'Unknown';
        const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
        const memberWeight = memberWeights[uid]?.[exercise] || 45;
        return `
          <div class="card" style="margin-bottom:6px">
            <div class="card-row">
              <div class="card-info">
                <div class="card-title">${esc(alias)} <span class="muted">${memberWeight} lbs</span></div>
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

  // Button handlers
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
  activeSession = null;
  setLogs = [];
  timers = {};
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
