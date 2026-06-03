// Session flow module — the heart of FubzLifts
import { supabase, withTimeout, TimeoutError } from './supabase.js';
import { getUser } from './auth.js';
import { getGroupMembers, clearGroupsCache } from './group.js';
import {
  toast, formatTime, showView,
  WORKOUTS, EXERCISE_NAMES, DEFAULT_SETS, pawBadge,
} from './utils.js';
import { mountCompanion, unmountCompanion, triggerCompanion } from './companion.js';

let activeSession = null;
let sessionMembers = []; // { id, alias, avatar_url, is_admin }
let memberWeights = {};  // { odified: { exercise: weight_lbs } }
let setLogs = [];
let timers = {};
let timerInterval = null;
let realtimeChannel = null;
let onSessionEnd = null;
// Reliability backstop: realtime postgres_changes is lossy (a missed event
// during a websocket nap is never re-delivered), and the app otherwise only
// reads authoritative session state on entry / full reload. reconcileSession()
// re-fetches the truth without a reload; reconcileInterval runs it periodically
// while subscribed, and `reconciling` guards against overlapping runs.
let reconcileInterval = null;
let reconciling = false;
let hasSubscribedOnce = false; // so the SUBSCRIBED catch-up only fires on REconnect

let groupOwnerId = null; // the group's actual owner
let lastExercise = null; // track exercise for splash detection
// visibilityHandler removed — app.js invisible reload handles tab resume
let lobbyContainer = null; // ref for visibility reconnect

// "Claim host" is gated on session inactivity — a member can only take over
// after the session has been silent for HOST_INACTIVITY_THRESHOLD_MS. The
// timestamp is computed server-side at click time (max of session.started_at,
// lobby_state.last_activity_at, and the most recent set_log) so the gate
// works correctly even on a fresh page load days later.
const HOST_INACTIVITY_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Determine who is the session admin (host).
 *  Priority:
 *    1. lobby_state.host_uid — session-scoped override set by "Claim host"
 *       (lets a member take over when the original host is unreachable)
 *    2. group owner if present in turn_order
 *    3. first in turn_order */
function getSessionAdmin() {
  if (!activeSession) return null;
  const order = activeSession.turn_order || [];
  const override = activeSession.lobby_state?.host_uid;
  if (override && order.includes(override)) return override;
  if (groupOwnerId && order.includes(groupOwnerId)) return groupOwnerId;
  return order[0] || null;
}

/** Write a session-scoped host override into lobby_state. Any member can do
 *  this when the existing host is unresponsive. The realtime broadcast will
 *  re-render every client and surface host controls to the new host. */
/** Format a millisecond duration as "Xd Yh", "Xh Ym", or "Xm Ys".
 *  Used for the claim host inactivity countdown which can range from seconds
 *  (rare, only if threshold is small) to days at the default 48h threshold. */
function formatDuration(ms) {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.ceil(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (totalHr < 24) return min ? `${totalHr}h ${min}m` : `${totalHr}h`;
  const days = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return hr ? `${days}d ${hr}h` : `${days}d`;
}

/** Compute "last session activity" from server-side data. The most recent of:
 *    - session.started_at (bumped on each lobby→active transition)
 *    - lobby_state.last_activity_at (bumped on votes/readies/settings tweaks)
 *    - the latest set_logs.logged_at for this session
 *  Returns ms since epoch, or 0 if no signal is available. */
async function lastSessionActivityMs() {
  if (!activeSession) return 0;
  const startedAtMs = activeSession.started_at ? new Date(activeSession.started_at).getTime() : 0;
  const lobbyTs = activeSession.lobby_state?.last_activity_at;
  const lobbyMs = lobbyTs ? new Date(lobbyTs).getTime() : 0;
  const { data: lastLog } = await supabase
    .from('set_logs')
    .select('logged_at')
    .eq('session_id', activeSession.id)
    .order('logged_at', { ascending: false })
    .limit(1);
  const lastLogMs = lastLog?.[0]?.logged_at ? new Date(lastLog[0].logged_at).getTime() : 0;
  return Math.max(startedAtMs, lobbyMs, lastLogMs);
}

/** Host-only: remove a member from this session. Pulls them from
 *  turn_order, lobby_state.members, and session_members. The kicked client
 *  detects via the sessions realtime handler that their uid is gone from
 *  turn_order and bounces home with a toast. */
async function kickMember(uid) {
  if (!activeSession) return;
  if (uid === getUser().id) return; // host can't kick self — they should Leave instead
  const turnOrder = (activeSession.turn_order || []).filter(u => u !== uid);
  const lobbyState = JSON.parse(JSON.stringify(activeSession.lobby_state || { members: {} }));
  if (lobbyState.members) delete lobbyState.members[uid];
  // If the kicked member was the override host, clear the override so it
  // doesn't dangle pointing at a non-member.
  if (lobbyState.host_uid === uid) delete lobbyState.host_uid;
  lobbyState.last_activity_at = new Date().toISOString();

  // Recompute current_turn_index so the rotation keeps advancing on the
  // person who *was* active, even if the kick reshuffled positions.
  let newTurnIndex = activeSession.current_turn_index || 0;
  const oldActiveUid = activeSession.turn_order?.[newTurnIndex];
  if (oldActiveUid === uid) {
    // The kicked person was the active turn — wrap to whoever now sits at
    // that index in the shrunken array.
    newTurnIndex = turnOrder.length > 0 ? newTurnIndex % turnOrder.length : 0;
  } else {
    newTurnIndex = turnOrder.indexOf(oldActiveUid);
    if (newTurnIndex < 0) newTurnIndex = 0;
  }

  const [updRes, delRes] = await Promise.all([
    supabase.from('sessions').update({
      turn_order: turnOrder,
      current_turn_index: newTurnIndex,
      lobby_state: lobbyState,
    }).eq('id', activeSession.id),
    supabase.from('session_members').delete()
      .eq('session_id', activeSession.id)
      .eq('user_id', uid),
  ]);
  if (updRes.error || delRes.error) {
    console.error('[FubzLifts] kickMember error:', updRes.error || delRes.error);
    toast('Failed to kick — check connection');
    return;
  }
}

async function claimHost() {
  if (!activeSession) return;

  // Anti-abuse: only allow claim after HOST_INACTIVITY_THRESHOLD_MS of total
  // session silence. If anyone has done anything recently, claim is denied
  // with a countdown toast.
  const lastMs = await lastSessionActivityMs();
  const elapsed = Date.now() - lastMs;
  if (elapsed < HOST_INACTIVITY_THRESHOLD_MS) {
    toast(`Session is still active — try again in ${formatDuration(HOST_INACTIVITY_THRESHOLD_MS - elapsed)}`);
    return;
  }

  const user = getUser();
  const lobbyState = JSON.parse(JSON.stringify(activeSession.lobby_state || { members: {} }));
  lobbyState.host_uid = user.id;
  lobbyState.last_activity_at = new Date().toISOString();
  const { error } = await supabase.from('sessions').update({
    lobby_state: lobbyState,
  }).eq('id', activeSession.id);
  if (error) {
    console.error('[FubzLifts] claimHost error:', error);
    toast('Failed to claim host — check connection');
    return;
  }
  toast('You are now the host');
}

/** Bump the current user's paw_count after they initiated a successful
 *  vote. Each client updates only their own users row — that side-steps
 *  cross-user-update RLS and the "two clients race to bump the same row"
 *  problem since only the initiator's client runs this. Best-effort: we
 *  log on failure (e.g. RLS denial) but don't toast — the badge is a
 *  cosmetic reward, not a critical path. */
async function bumpMyPawCount() {
  const user = getUser();
  if (!user) return;
  try {
    const { data: row } = await supabase
      .from('users')
      .select('paw_count')
      .eq('id', user.id)
      .single();
    const next = (row?.paw_count || 0) + 1;
    const { error } = await supabase
      .from('users')
      .update({ paw_count: next })
      .eq('id', user.id);
    if (error) {
      console.error('[FubzLifts] paw_count bump failed:', error);
      return;
    }
    // Update the in-memory user so the header alias re-renders with badge
    // without waiting for a full reload.
    user.paw_count = next;
    const headerAlias = document.getElementById('headerAlias');
    if (headerAlias) headerAlias.innerHTML = esc(user.alias) + pawBadge(next);
  } catch (e) {
    console.error('[FubzLifts] paw_count bump exception:', e);
  }
}

// ─── Paw vote (secret 6th-set vote) ────────────────────────────
// State lives on activeSession.lobby_state:
//   - paw_vote: { voters: [uid, uid, ...], exercise: 'squat' }
//   - extra_sets: { squat: 1, bench: 0, ... }
// Any member can initiate by tapping the paw (revealed via long-pressing
// the header). Other members see the paw button automatically while a vote
// is active. Once every member in turn_order has voted, the bonus set is
// committed and the splash plays for everyone via the realtime handler.

/** Initiate or cast a vote for the current exercise's bonus set. */
async function castPawVote() {
  if (!activeSession || activeSession.status !== 'active') return;
  const user = getUser();
  const exercise = activeSession.current_exercise;
  if (!exercise) return;

  const lobbyState = JSON.parse(JSON.stringify(activeSession.lobby_state || { members: {} }));
  let pawVote = lobbyState.paw_vote;

  // If vote was started for a different exercise (e.g. exercise changed
  // mid-vote), reset and start fresh for the current one.
  if (!pawVote || pawVote.exercise !== exercise) {
    pawVote = { voters: [user.id], exercise };
  } else {
    // Already voting for this exercise — add me if I'm not already in.
    if (!pawVote.voters.includes(user.id)) {
      pawVote.voters.push(user.id);
    }
  }

  // Unanimous? Apply the bonus set and clear the vote in the same write.
  const allVoted = activeSession.turn_order.every(uid => pawVote.voters.includes(uid));
  if (allVoted) {
    const extra = { ...(lobbyState.extra_sets || {}) };
    extra[exercise] = (extra[exercise] || 0) + 1;
    lobbyState.extra_sets = extra;
    delete lobbyState.paw_vote;
  } else {
    lobbyState.paw_vote = pawVote;
  }
  lobbyState.last_activity_at = new Date().toISOString();

  const { error } = await supabase.from('sessions').update({
    lobby_state: lobbyState,
  }).eq('id', activeSession.id);
  if (error) {
    console.error('[FubzLifts] castPawVote error:', error);
    toast('Failed to vote — check connection');
  }
}

// Local-only "is the paw revealed on my screen" flag. Resets on session end.
// Other members don't see my reveal — but once *I* tap the paw and start a
// vote, lobby_state.paw_vote becomes truthy and updatePawVoteUI auto-shows
// the button for everyone.
let pawRevealed = false;

/** One-time setup: tap on the workout banner to reveal the secret paw,
 *  tap the paw to vote. Both are delegated from document so they survive
 *  renderSession's container.innerHTML rebuilds. Idempotent. */
export function setupPawListeners() {
  if (document._pawListenersAttached) return;
  document._pawListenersAttached = true;

  document.addEventListener('click', (e) => {
    if (!activeSession || activeSession.status !== 'active') return;
    // Paw button click → cast/initiate vote. Check this BEFORE the banner
    // check, because the paw is a child of the banner.
    if (e.target.closest('.paw-button')) {
      castPawVote();
      return;
    }
    // Banner click → toggle the secret paw locally. If a vote is in
    // progress, the paw stays visible regardless (lobby_state.paw_vote
    // wins over pawRevealed in updatePawVoteUI) so a member can't hide
    // the button while their teammates still need to vote.
    if (e.target.closest('.exercise-banner')) {
      pawRevealed = !pawRevealed;
      updatePawVoteUI();
    }
  });
}

/** Sync the paw button + pip indicator to current lobby_state.paw_vote.
 *  Called for two reasons: dynamic state changes (banner tap toggles
 *  pawRevealed; vote cast/completed) and re-renders (renderSession bakes
 *  the right classes into the template, then we ensure they're consistent).
 *  classList.toggle with the second arg is idempotent — if the class is
 *  already in the desired state, no change, no transition fires. That's
 *  what keeps re-renders from re-animating the reveal. */
function updatePawVoteUI() {
  const pawBtn = document.getElementById('pawButton');
  const pips = document.getElementById('pawPipsInline');

  const inActive = activeSession?.status === 'active';
  let pawVote = inActive ? activeSession.lobby_state?.paw_vote : null;
  // Treat votes for a different (already-finished) exercise as not active.
  if (pawVote && pawVote.exercise !== activeSession?.current_exercise) {
    pawVote = null;
  }
  const me = getUser();
  const iVoted = !!(pawVote && me && pawVote.voters?.includes(me.id));
  const shouldReveal = inActive && !!(pawVote || pawRevealed);

  if (pawBtn) {
    pawBtn.classList.toggle('revealed', shouldReveal);
    pawBtn.classList.toggle('voted', iVoted);
  }

  if (pips) {
    if (pawVote && activeSession?.turn_order) {
      pips.hidden = false;
      pips.innerHTML = activeSession.turn_order.map(uid => {
        const voted = pawVote.voters.includes(uid);
        return `<div class="paw-pip ${voted ? 'voted' : ''}"></div>`;
      }).join('');
    } else {
      pips.hidden = true;
      pips.innerHTML = '';
    }
  }
}

/** Show the TOMCATZ MEOW celebration splash — same retro RPG dialog box
 *  pattern as showExerciseSplash, but with the bonus-set chant. */
function showTomcatzSplash(onDone) {
  const message = 'TOMCATZ MEOW! ONE TWO THREE MEOW!!!';
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
        animation: catBounce 0.9s ease-in-out infinite;
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
      <h2 style="color:#E74C3C">+1 BONUS SET!</h2>
      <div style="display:flex;align-items:flex-start;justify-content:center;gap:14px;margin:24px 0">
        <img src="icons/icon-192.png" alt="" class="splash-cat" />
        <div class="splash-bubble"><span id="splashText"></span><span class="cursor"></span></div>
      </div>
      <p class="muted" style="font-size:12px;margin-top:14px">Tap anywhere to continue</p>
    </div>
  `;
  document.body.appendChild(splash);

  const textEl = splash.querySelector('#splashText');
  let charIdx = 0;
  const typeInterval = setInterval(() => {
    if (charIdx < message.length) {
      textEl.textContent += message[charIdx];
      charIdx++;
    } else {
      clearInterval(typeInterval);
    }
  }, 55);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearInterval(typeInterval);
    clearTimeout(autoTimer);
    splash.remove();
    if (onDone) onDone();
  };
  splash.addEventListener('click', dismiss);
  const autoTimer = setTimeout(dismiss, 8000);
}


function getMaxSets(exercise) {
  let base;
  if (exercise === 'deadlift' && activeSession?.lobby_state?.dl_sets) {
    base = activeSession.lobby_state.dl_sets;
  } else {
    base = DEFAULT_SETS[exercise];
  }
  const bonus = activeSession?.lobby_state?.extra_sets?.[exercise] || 0;
  return base + bonus;
}

/** Check if an exercise uses simultaneous mode (all lift at once) */
function isSimultaneous(exercise) {
  return !!activeSession?.lobby_state?.simultaneous?.[exercise];
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
    // Add to turn order if not present — merge-safe so a joiner can't clobber the
    // host's simultaneous/dl_sets settings (or another concurrent joiner) by
    // writing a whole lobby_state built from a stale snapshot.
    if (!activeSession.turn_order.includes(user.id)) {
      await mergeLobbyState((ls, fresh) => {
        const order = fresh.turn_order || [];
        const newOrder = order.includes(user.id) ? order : [...order, user.id];
        if (fresh.status === 'lobby' && !ls.members[user.id]) {
          ls.members[user.id] = { workout_vote: 'A', ready: false };
        }
        return { turn_order: newOrder };
      });
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

  // Filter to logs from the current run only — when a host ends early and
  // restarts from the lobby, started_at is bumped (see adminStartSession),
  // and logs from the prior attempt would otherwise reappear as "already done".
  // We can't DELETE the old rows (RLS denies cross-user delete), so we scope
  // by timestamp instead.
  const { data: logs } = await supabase
    .from('set_logs')
    .select('*')
    .eq('session_id', activeSession.id)
    .gte('logged_at', activeSession.started_at)
    .order('logged_at', { ascending: true });
  setLogs = logs || [];

  timers = {};
  activeSession.turn_order.forEach(uid => { timers[uid] = 0; });
  lastExercise = activeSession.current_exercise;
  startTimerTick(container);
  renderSession(container);
}

/** Re-fetch authoritative session state (the sessions row + this run's set_logs)
 *  and reconcile it into local state WITHOUT a page reload. This is the safety
 *  net that makes correctness independent of receiving every realtime event:
 *  a missed turn-advance or set_logs INSERT (websocket nap, brief drop) self-
 *  heals here within seconds instead of wedging the session until a manual
 *  reload. Best-effort and timeout-guarded — on failure it just leaves state
 *  as-is and the next tick/resume retries. Re-renders only when something
 *  actually changed, so the periodic backstop doesn't churn the DOM. */
export async function reconcileSession() {
  if (!activeSession || reconciling) return;
  // Don't yank state out from under an in-flight set log — let it finish; the
  // INSERT echo (or the next reconcile tick) will pick up the result.
  if (logSetInFlight) return;
  const sid = activeSession.id;
  const container = lobbyContainer;
  reconciling = true;
  try {
    const [sessRes, logRes] = await Promise.all([
      withTimeout(supabase.from('sessions').select('*').eq('id', sid).single(), 6000, 'reconcile.session'),
      withTimeout(
        supabase.from('set_logs').select('*')
          .eq('session_id', sid)
          .gte('logged_at', activeSession.started_at)
          .order('logged_at', { ascending: true }),
        6000, 'reconcile.logs'
      ),
    ]);
    // Session changed/ended underneath us while awaiting — abandon this pass.
    if (!activeSession || activeSession.id !== sid) return;
    const fresh = sessRes.data;
    if (!fresh) return;

    const me = getUser().id;
    // Kicked while away — mirror the realtime kick handler and bounce home.
    if (Array.isArray(fresh.turn_order) && !fresh.turn_order.includes(me)
        && Array.isArray(activeSession.turn_order) && activeSession.turn_order.includes(me)) {
      clearInterval(timerInterval);
      toast('You were removed from the session by the host');
      const cb = onSessionEnd;
      cleanupSession();
      if (cb) cb();
      return;
    }

    const prevStatus = activeSession.status;
    const prevExercise = activeSession.current_exercise;
    const prevIdx = activeSession.current_turn_index;
    const prevOrder = (activeSession.turn_order || []).join(',');
    const prevLogCount = setLogs.length;

    activeSession = fresh;
    setLogs = logRes.data || [];
    fresh.turn_order?.forEach(uid => { if (timers[uid] == null) timers[uid] = 0; });

    if (fresh.status === 'completed') {
      clearInterval(timerInterval);
      await applyMyProgression(); // catch-up path: apply own +5 if we only learned of completion here
      if (container) renderSessionSummary(container);
      return;
    }
    if (fresh.status === 'lobby') {
      lastExercise = null;
      if (container) { lobbyRendered = false; renderLobby(container); }
      return;
    }

    // status === 'active'
    lastExercise = fresh.current_exercise; // keep splash detector in sync
    const changed = fresh.status !== prevStatus
      || fresh.current_exercise !== prevExercise
      || fresh.current_turn_index !== prevIdx
      || (fresh.turn_order || []).join(',') !== prevOrder
      || setLogs.length !== prevLogCount;
    if (changed && container) renderSession(container);

    // Self-correct a wedged/raced turn or a stalled simultaneous exercise.
    await repairTurnIfNeeded();
  } catch (e) {
    if (!(e instanceof TimeoutError)) console.error('[FubzLifts] reconcileSession error:', e);
    // best-effort — leave local state intact, next tick/resume retries
  } finally {
    reconciling = false;
  }
}

/** Host-only self-correction so a desynced/raced turn index or a stalled
 *  simultaneous exercise can't wedge the group. Single-writer (only the session
 *  admin writes) and idempotent, so it's safe to call from reconcile and the
 *  realtime handler. Turn-based: if the active slot is invalid or points at a
 *  lifter who already finished, re-derive the next unfinished lifter and write a
 *  corrected index (or advance the exercise if everyone is done). Simultaneous:
 *  if everyone has logged all sets but it never advanced, advance it. */
async function repairTurnIfNeeded() {
  if (!activeSession || activeSession.status !== 'active') return;
  if (getSessionAdmin() !== getUser().id) return; // single writer avoids a write storm
  const exercise = activeSession.current_exercise;
  const maxSets = getMaxSets(exercise);
  const order = activeSession.turn_order || [];
  if (order.length === 0) return;
  const doneCount = uid => setLogs.filter(l => l.user_id === uid && l.exercise === exercise).length;

  if (isSimultaneous(exercise)) {
    if (order.every(uid => doneCount(uid) >= maxSets)) await advanceTurn();
    return;
  }

  const idx = activeSession.current_turn_index;
  const activeUid = order[idx];
  const invalid = idx == null || idx < 0 || idx >= order.length || activeUid === undefined;
  const finished = activeUid !== undefined && doneCount(activeUid) >= maxSets;
  if (!invalid && !finished) return;

  let foundIdx = -1;
  for (let i = 0; i < order.length; i++) {
    if (doneCount(order[i]) < maxSets) { foundIdx = i; break; }
  }
  if (foundIdx === -1) { await advanceTurn(); return; } // everyone done → move on
  if (foundIdx === idx) return;
  try {
    await withTimeout(
      supabase.from('sessions').update({ current_turn_index: foundIdx }).eq('id', activeSession.id),
      8000, 'repair.turn_index'
    );
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    window.fubzInvisibleReload?.();
  }
}

/** Subscribe to real-time session updates + visibility reconnect */
function subscribeToSession(container) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  lobbyContainer = container;
  hasSubscribedOnce = false;

  // Expose reconcile so app.js (resume/watchdog) can trigger a soft re-sync
  // without a reload, avoiding a circular import.
  window.fubzReconcileSession = reconcileSession;

  // Periodic reconciliation backstop — re-pull authoritative state every 25s so
  // a silently-dead/zombie websocket (which the channel-state checks miss) or a
  // missed event can't keep the session wedged for more than one tick.
  clearInterval(reconcileInterval);
  reconcileInterval = setInterval(() => {
    if (document.visibilityState === 'visible') reconcileSession();
  }, 25 * 1000);

  setupRealtimeChannel(container);
}

/** Wire up the Supabase realtime channel (separated so visibility handler can reconnect) */
function setupRealtimeChannel(container) {
  // Channel name is stable (no timestamp suffix) so all clients in this
  // session land on the same topic — this is what lets Supabase Presence
  // share state across them, and lets the Groups view (a passive observer)
  // count who's currently here. Presence key = user_id so multi-tab from the
  // same user counts as one presence, not N.
  realtimeChannel = supabase
    .channel(`session_${activeSession.id}`, {
      config: { presence: { key: getUser().id } },
    })
    // Empty presence:sync binding is required for the realtime client to
    // actually subscribe to presence events on this topic — otherwise track()
    // returns "ok" but the server never wires up presence delivery and other
    // observers see count=0. We don't read the state locally; the Groups view
    // is the consumer of this presence info.
    .on('presence', { event: 'sync' }, () => {})
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'sessions',
      filter: `id=eq.${activeSession.id}`,
    }, async payload => {
      // DELETE event (group owner deleted the group, cascading the session
      // row away). payload.new is null/undefined; bounce to home instead of
      // leaving the user in a zombie lobby/session view.
      if (payload.eventType === 'DELETE' || !payload.new) {
        if (payload.eventType === 'DELETE') {
          clearInterval(timerInterval);
          toast('This group was deleted');
          const cb = onSessionEnd;
          cleanupSession();
          if (cb) cb();
        }
        return;
      }
      const user = getUser();
      const wasInTurnOrder = activeSession.turn_order?.includes(user.id);
      const prevStatus = activeSession.status;
      // Snapshot paw-vote state before swapping in the new session row, so
      // the active-status branch can detect "vote just completed" and fire
      // the TOMCATZ splash for everyone.
      const prevExtraSets = JSON.stringify(activeSession.lobby_state?.extra_sets || {});
      const prevPawVote = activeSession.lobby_state?.paw_vote;
      activeSession = payload.new;
      const newExtraSets = JSON.stringify(activeSession.lobby_state?.extra_sets || {});
      const extraSetsGrew = prevExtraSets !== newExtraSets;
      // If extra_sets grew AND there was a paw_vote that's now gone, this
      // realtime payload is the "vote just unanimously passed" signal. The
      // initiator was voters[0] of the prior paw_vote; if that's me, bump
      // my own paw_count (each client only updates their own users row,
      // RLS-friendly and avoids races since only the initiator runs this).
      if (extraSetsGrew && prevPawVote && !activeSession.lobby_state?.paw_vote) {
        const initiatorId = prevPawVote.voters?.[0];
        if (initiatorId === user.id) bumpMyPawCount();
      }

      // I was kicked — host removed me from turn_order. Bounce home.
      if (wasInTurnOrder && !activeSession.turn_order?.includes(user.id)) {
        clearInterval(timerInterval);
        toast('You were removed from the session by the host');
        const cb = onSessionEnd;
        cleanupSession();
        if (cb) cb();
        return;
      }

      if (activeSession.status === 'completed') {
        clearInterval(timerInterval);
        await applyMyProgression(); // each client applies its own +5 (RLS-safe)
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
        } else if (extraSetsGrew) {
          // The paw vote just unanimously passed — everyone gets the splash.
          renderSession(container); // sync the new set count first
          showTomcatzSplash();
        } else {
          lastExercise = newExercise;
          renderSession(container);
        }
      } else if (activeSession.status === 'lobby') {
        // active → lobby = host ended the workout early; reset transient state
        // and re-render the lobby in place so everyone (including the host)
        // can ready up and restart with the same workout_type/turn_order.
        if (prevStatus === 'active') {
          clearInterval(timerInterval);
          setLogs = [];
          timers = {};
          lastExercise = null;
          lobbyRendered = false;
          hostUsurped = false;
          pendingUsurpType = null;
          const user = getUser();
          const adminId = getSessionAdmin();
          if (adminId !== user.id) {
            const adminAlias = sessionMembers.find(m => m.id === adminId)?.alias;
            toast(adminAlias ? `${adminAlias} ended the workout — back to lobby` : 'Workout ended — back to lobby');
          }
        }
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
    .subscribe(async (status) => {
      // Only call track() once the channel is actually subscribed; calling
      // it before that is a silent no-op and our presence wouldn't register.
      if (status === 'SUBSCRIBED') {
        try { await realtimeChannel.track({ uid: getUser().id }); }
        catch (e) { console.error('[FubzLifts] presence track error:', e); }
        // On a REsubscribe (the channel dropped and rejoined), postgres_changes
        // does not replay events missed during the gap — so catch up explicitly
        // by reconciling authoritative state. Skip the very first subscribe
        // (session entry already loaded fresh state).
        if (hasSubscribedOnce) reconcileSession();
        hasSubscribedOnce = true;
      }
    });
}

// ─── LOBBY ───────────────────────────────────────────────

let lobbyRendered = false; // track if lobby skeleton is already in DOM

/** Render the pre-session lobby — uses DOM patching to avoid full re-renders */
function renderLobby(container) {
  if (!activeSession || activeSession.status !== 'lobby') return;

  // The cat only belongs in an ACTIVE workout. Retire it here so it can't linger
  // over the lobby — covers the "host ended the workout early" active→lobby path
  // (realtime + reconcile) where we re-render the lobby without going through
  // cleanupSession(). Idempotent; no-op if the cat isn't mounted.
  unmountCompanion();

  const user = getUser();
  const lobbyState = activeSession.lobby_state || { members: {} };
  const adminId = getSessionAdmin();
  const isHost = adminId === user.id;
  const myVote = lobbyState.members?.[user.id] || { workout_vote: 'A', ready: false };

  const allMembers = activeSession.turn_order.map(uid => {
    const member = sessionMembers.find(m => m.id === uid);
    const vote = lobbyState.members?.[uid] || {};
    return { uid, alias: member?.alias || 'Unknown', paw_count: member?.paw_count || 0, ...vote };
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
        <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:8px">
          <h3 style="margin:0">Members</h3>
          ${isHost && allMembers.length > 1 ? '<button class="btn-link kick-manage-btn" id="lobbyManageBtn" style="font-size:11px;color:var(--muted-color);text-transform:none">Manage</button>' : ''}
        </div>
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

  // Reflect the current Manage state on the just-rendered button. Body class
  // persists across re-renders; without this the button would always say
  // "Manage" even mid-Manage-mode after a patch/render.
  const lobbyManageBtn = container.querySelector('#lobbyManageBtn');
  if (lobbyManageBtn) {
    lobbyManageBtn.textContent = document.body.classList.contains('kick-managing') ? 'Done' : 'Manage';
  }

  setupLobbyDelegation(container);
}

/** Render member cards HTML. The host gets a kick (✕) button on every other
 *  member; non-hosts see no kick affordance. The kick confirm is gated by a
 *  typed "KICK" input to make accidental clicks impossible. */
function renderMemberCards(allMembers, adminId) {
  const me = getUser();
  const iAmHost = adminId === me?.id;
  return allMembers.map(m => {
    const canKick = iAmHost && m.uid !== me.id;
    return `
    <div class="card lobby-member-card" data-uid="${m.uid}" style="margin-bottom:6px">
      <div class="card-row">
        <div class="card-info">
          <div class="card-title lobby-member-name">
            ${esc(m.alias)}${pawBadge(m.paw_count)}
            ${m.uid === adminId ? '<span class="muted" style="font-size:11px"> (host)</span>' : ''}
          </div>
          <div class="card-subtitle muted lobby-member-vote">
            Vote: <strong>${m.workout_vote || '?'}</strong>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="lobby-member-ready" style="font-size:22px;color:${m.ready ? 'var(--teal)' : 'var(--muted-color)'}">${m.ready ? '✓' : '○'}</div>
          ${canKick ? `<button class="btn btn-danger lobby-kick-btn" data-uid="${m.uid}" data-alias="${esc(m.alias)}" style="padding:4px 8px;font-size:11px" title="Kick ${esc(m.alias)}">✕</button>` : ''}
        </div>
      </div>
      ${canKick ? `
        <div class="lobby-kick-confirm" data-uid="${m.uid}" hidden style="margin-top:8px;border-top:1px solid var(--border-light);padding-top:8px">
          <div style="font-size:12px;color:var(--danger-text);margin-bottom:4px;font-weight:600">Kick ${esc(m.alias)}?</div>
          <div style="font-size:11px;color:var(--muted-color);margin-bottom:6px">Type <strong style="color:var(--danger-text)">KICK</strong> to confirm:</div>
          <input class="field lobby-kick-input" data-uid="${m.uid}" placeholder="Type KICK" style="text-transform:uppercase;margin-bottom:6px;font-size:12px;padding:6px" />
          <div class="btn-group">
            <button class="btn btn-danger lobby-kick-final" data-uid="${m.uid}" disabled style="font-size:11px">Confirm Kick</button>
            <button class="btn lobby-kick-cancel" data-uid="${m.uid}" style="font-size:11px">Cancel</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
}

/** Patch member cards in-place, only rebuilding if member count changed */
function patchMemberCards(container, allMembers, adminId) {
  const list = container.querySelector('#lobbyMembersList');
  if (!list) return;

  const me = getUser();
  const iAmHost = adminId === me?.id;
  const existing = list.querySelectorAll('.lobby-member-card');
  // Rebuild if member count changed OR host status flipped — the kick UI is
  // conditional on iAmHost, so a non-host → host transition has to add kick
  // buttons (and the inverse has to remove them).
  const hasKickButtons = !!list.querySelector('.lobby-kick-btn');
  const expectKickButtons = iAmHost && allMembers.some(m => m.uid !== me.id);
  if (existing.length !== allMembers.length || hasKickButtons !== expectKickButtons) {
    list.innerHTML = renderMemberCards(allMembers, adminId);
    return;
  }

  // Patch each card in-place
  allMembers.forEach((m, i) => {
    const card = existing[i];
    if (!card) return;

    const nameEl = card.querySelector('.lobby-member-name');
    if (nameEl) {
      const newName = `${esc(m.alias)}${pawBadge(m.paw_count)}${m.uid === adminId ? '<span class="muted" style="font-size:11px"> (host)</span>' : ''}`;
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
      <div style="text-align:center;border-top:1px solid var(--border-light);padding-top:8px;margin-top:4px">
        <button class="btn-link" id="lobbyClaimHostBtn" style="font-size:11px;color:var(--muted-color)">Host inactive? Claim host</button>
        <div id="lobbyClaimHostConfirm" hidden style="margin-top:8px">
          <p class="muted" style="margin:0 0 8px;font-size:12px">Take over as host? You'll get host controls and can start/end the workout.</p>
          <div class="btn-group">
            <button class="btn btn-primary" id="lobbyClaimHostYes" style="font-size:12px">Yes, claim host</button>
            <button class="btn" id="lobbyClaimHostNo" style="font-size:12px">Cancel</button>
          </div>
        </div>
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
    // Non-host → host transition (e.g. just claimed host): rebuild the host
    // area so admin controls actually exist before we try to patch their state.
    if (!container.querySelector('#adminWorkoutBtns')) {
      const hostArea = container.querySelector('#lobbyHostArea');
      if (hostArea) {
        hostArea.innerHTML = renderHostArea(true, allReady, readyCount, allMembers.length, lobbyState, allMembers);
      }
    }
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
    // A one-shot manual override shouldn't freeze the workout type forever: once
    // the live vote agrees with the host's choice, re-arm auto-follow so later
    // vote swings are honoured again.
    if (hostUsurped && currentType === winningVote) hostUsurped = false;
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
      const n = parseInt(target.dataset.sets);
      activeSession.lobby_state = { ...activeSession.lobby_state, dl_sets: n };
      container.querySelectorAll('.admin-set-dl').forEach(b => {
        b.classList.toggle('btn-primary', parseInt(b.dataset.sets) === n);
      });
      // Merge-safe write so a member readying up can't clobber this host setting.
      mergeLobbyState((ls) => { ls.dl_sets = n; })
        .catch(e => { if (!(e instanceof TimeoutError)) console.error('[FubzLifts] dl_sets write failed', e); });
      return;
    }

    // Toggle simultaneous mode
    if (target.classList.contains('admin-toggle-sim')) {
      const ex = target.dataset.exercise;
      const newVal = !activeSession.lobby_state?.simultaneous?.[ex];
      const sim = { ...(activeSession.lobby_state?.simultaneous || {}), [ex]: newVal };
      activeSession.lobby_state = { ...activeSession.lobby_state, simultaneous: sim };
      target.classList.toggle('btn-primary', newVal);
      // Merge-safe write — previously a fire-and-forget whole-blob write that got
      // clobbered by concurrent member ready/vote writes, so the toggle silently
      // didn't persist to the started workout. Now it merges against the freshest
      // lobby_state and is awaited.
      mergeLobbyState((ls) => { ls.simultaneous = { ...(ls.simultaneous || {}), [ex]: newVal }; })
        .catch(e => { if (!(e instanceof TimeoutError)) console.error('[FubzLifts] simultaneous toggle write failed', e); });
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

    // Claim host (lobby) — inline confirm pattern
    if (target.id === 'lobbyClaimHostBtn') {
      const confirmEl = container.querySelector('#lobbyClaimHostConfirm');
      if (confirmEl) confirmEl.hidden = !confirmEl.hidden;
      return;
    }
    if (target.id === 'lobbyClaimHostNo') {
      const confirmEl = container.querySelector('#lobbyClaimHostConfirm');
      if (confirmEl) confirmEl.hidden = true;
      return;
    }
    if (target.id === 'lobbyClaimHostYes') {
      claimHost();
      return;
    }

    // Toggle Manage members mode (reveals/hides kick ✕ buttons)
    if (target.id === 'lobbyManageBtn') {
      document.body.classList.toggle('kick-managing');
      const isManaging = document.body.classList.contains('kick-managing');
      target.textContent = isManaging ? 'Done' : 'Manage';
      // Closing manage mode also closes any open kick confirm panels
      if (!isManaging) {
        container.querySelectorAll('.lobby-kick-confirm').forEach(p => { p.hidden = true; });
      }
      return;
    }

    // Kick (lobby) — host-only, gated by typed "KICK" confirmation
    if (target.classList.contains('lobby-kick-btn')) {
      const uid = target.dataset.uid;
      // Only one kick panel open at a time
      container.querySelectorAll('.lobby-kick-confirm').forEach(p => { p.hidden = true; });
      const confirmEl = container.querySelector(`.lobby-kick-confirm[data-uid="${uid}"]`);
      if (confirmEl) {
        confirmEl.hidden = false;
        const input = confirmEl.querySelector('.lobby-kick-input');
        const finalBtn = confirmEl.querySelector('.lobby-kick-final');
        if (input) { input.value = ''; input.focus(); }
        if (finalBtn) finalBtn.disabled = true;
      }
      return;
    }
    if (target.classList.contains('lobby-kick-cancel')) {
      const uid = target.dataset.uid;
      const confirmEl = container.querySelector(`.lobby-kick-confirm[data-uid="${uid}"]`);
      if (confirmEl) confirmEl.hidden = true;
      return;
    }
    if (target.classList.contains('lobby-kick-final')) {
      kickMember(target.dataset.uid);
      return;
    }
  };

  container.addEventListener('click', container._lobbyClickHandler);

  // Input delegation for the KICK-typing confirmation. Persists with the
  // container, same as the click delegation, so kick UI patched in later
  // (e.g. after host-claim transition) still gates the Confirm button.
  if (container._lobbyInputHandler) {
    container.removeEventListener('input', container._lobbyInputHandler);
  }
  container._lobbyInputHandler = (e) => {
    if (!e.target.classList.contains('lobby-kick-input')) return;
    const uid = e.target.dataset.uid;
    const finalBtn = container.querySelector(`.lobby-kick-final[data-uid="${uid}"]`);
    if (finalBtn) finalBtn.disabled = e.target.value.trim().toUpperCase() !== 'KICK';
  };
  container.addEventListener('input', container._lobbyInputHandler);
}

/** Apply a change to the session's lobby_state WITHOUT clobbering concurrent
 *  edits to other sub-keys. The Supabase JS client replaces the whole JSONB
 *  column on update, so when one client rebuilt lobby_state from a stale local
 *  snapshot it would overwrite changes it hadn't yet received — e.g. a member
 *  readying up wiped the host's just-set Simultaneous-Sets / dl_sets toggle
 *  (the confirmed "simultaneous didn't persist" bug). mergeLobbyState re-reads
 *  the freshest row, runs `mutate(ls, fresh)` to apply ONLY the intended change,
 *  then writes it back — shrinking the clobber window to the tiny read→write gap.
 *  `mutate` may return sibling columns (e.g. { turn_order, workout_type }) to set
 *  in the same write. Timeout-guarded; throws TimeoutError so callers can recover. */
async function mergeLobbyState(mutate) {
  const sid = activeSession?.id;
  if (!sid) return;
  const { data: fresh } = await withTimeout(
    supabase.from('sessions').select('lobby_state,turn_order,workout_type,status').eq('id', sid).single(),
    8000, 'lobby.read'
  );
  if (!fresh) return;
  const ls = fresh.lobby_state || { members: {} };
  if (!ls.members) ls.members = {};
  const extra = mutate(ls, fresh) || {};
  ls.last_activity_at = new Date().toISOString();
  await withTimeout(
    supabase.from('sessions').update({ lobby_state: ls, ...extra }).eq('id', sid),
    8000, 'lobby.update'
  );
  if (activeSession && activeSession.id === sid) {
    activeSession.lobby_state = ls;
    if (extra.turn_order) activeSession.turn_order = extra.turn_order;
    if (extra.workout_type) activeSession.workout_type = extra.workout_type;
  }
}

/** Update this user's lobby state (vote/ready) — optimistic local update, then a
 *  merge-safe authoritative write (only touches members[me], never clobbers the
 *  host's simultaneous/dl_sets or other members' votes). */
async function updateMyLobbyState(updates) {
  const user = getUser();
  // Snapshot pre-optimistic state so we can roll back if the write fails.
  const prevLobbyState = activeSession.lobby_state;
  const prevWorkoutType = activeSession.workout_type;

  // Optimistic: update local state and patch UI immediately
  const optimistic = { ...activeSession.lobby_state, members: { ...(activeSession.lobby_state?.members || {}) } };
  optimistic.members[user.id] = { ...(optimistic.members[user.id] || {}), ...updates };
  activeSession.lobby_state = optimistic;
  if (lobbyContainer) renderLobby(lobbyContainer);

  // If host hasn't usurped, auto-follow the winning vote (optimistic)
  let newType = null;
  if (!hostUsurped && getSessionAdmin() === user.id && updates.workout_vote) {
    const allMembers = activeSession.turn_order.map(uid => optimistic.members?.[uid] || {});
    const winningVote = getWinningVote(allMembers);
    if (winningVote && activeSession.workout_type !== winningVote) {
      newType = winningVote;
      activeSession.workout_type = winningVote;
    }
  }

  // Authoritative merge-safe write. On a hang, recover via reload; on a normal
  // error, roll back so the optimistic UI doesn't lie.
  try {
    await mergeLobbyState((ls) => {
      ls.members[user.id] = { ...(ls.members[user.id] || {}), ...updates };
      return newType ? { workout_type: newType } : {};
    });
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn('[FubzLifts] updateMyLobbyState timed out — forcing recovery reload');
      toast('Reconnecting…');
      window.fubzInvisibleReload?.();
      return;
    }
    activeSession.lobby_state = prevLobbyState;
    activeSession.workout_type = prevWorkoutType;
    if (lobbyContainer) renderLobby(lobbyContainer);
    toast('Failed to update — check connection');
  }
}

/** Host starts the workout — transition lobby → active */
async function adminStartSession(container) {
  try {
    const exercises = WORKOUTS[activeSession.workout_type];

    const { error } = await supabase.from('sessions').update({
      status: 'active',
      workout_type: activeSession.workout_type,
      lobby_state: activeSession.lobby_state,
      current_exercise: exercises[0],
      current_turn_index: 0,
      current_set: 1,
      // Bump started_at so loadSessionState filters out any logs from a prior
      // run of this same session row (when a host ended early and restarted).
      started_at: new Date().toISOString(),
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

/** Leave an in-progress session. Works for both host and non-host — for the
 *  host, host duties pass to whoever's next in turn_order via the default
 *  getSessionAdmin priority, and we strip lobby_state.host_uid if it pointed
 *  at the leaver. If the leaver was the last member, mark the session
 *  completed (without progression — only natural completion of all sets
 *  bumps weights up). */
function leaveSession() {
  console.warn('[FubzLifts] leaveSession called');
  const user = getUser();
  const sessionId = activeSession.id;
  const turnOrder = [...activeSession.turn_order];
  const oldIndex = activeSession.current_turn_index || 0;
  const oldActiveUid = turnOrder[oldIndex];
  // Capture lobby_state before cleanupSession() nulls activeSession.
  const savedLobbyState = JSON.parse(JSON.stringify(activeSession.lobby_state || { members: {} }));

  const cb = onSessionEnd;
  cleanupSession();
  if (cb) cb();

  const newOrder = turnOrder.filter(uid => uid !== user.id);

  if (newOrder.length === 0) {
    // Last member out; mark the session completed without progression.
    // 'cancelled' would be more semantically accurate but the schema's
    // CHECK constraint only permits 'lobby' | 'active' | 'completed'.
    supabase.from('sessions').update({
      status: 'completed',
      ended_at: new Date().toISOString(),
    }).eq('id', sessionId)
      .then(() => supabase.from('session_members').delete().eq('session_id', sessionId))
      .catch(e => console.error('[FubzLifts] leaveSession cleanup error:', e));
    return;
  }

  // If the leaver was the claim-host override target, drop the override so
  // host falls back to the default priority (group owner / first in order).
  if (savedLobbyState.host_uid === user.id) delete savedLobbyState.host_uid;
  savedLobbyState.last_activity_at = new Date().toISOString();

  // Recompute the active turn index so the remaining clients keep advancing
  // through the right person, even if the leaver was active or before them.
  let newTurnIndex;
  if (user.id === oldActiveUid) {
    // Leaver was active; advance to whoever was next in the old order, then
    // map that to the new order.
    newTurnIndex = oldIndex % newOrder.length;
  } else {
    newTurnIndex = newOrder.indexOf(oldActiveUid);
    if (newTurnIndex < 0) newTurnIndex = 0;
  }

  Promise.all([
    supabase.from('sessions').update({
      turn_order: newOrder,
      current_turn_index: newTurnIndex,
      lobby_state: savedLobbyState,
    }).eq('id', sessionId),
    supabase.from('session_members').delete().eq('session_id', sessionId).eq('user_id', user.id),
  ]).catch(e => console.error('[FubzLifts] leaveSession cleanup error:', e));
}

/** Host-only: end the in-progress workout and revert the session back to
 *  the lobby. Un-readies all members (so a restart requires re-affirmation)
 *  and keeps workout_type / turn_order / dl_sets / simultaneous so the group
 *  can immediately restart with the same setup. The previous run's set_logs
 *  are left in the table (RLS denies cross-user DELETE) — they're filtered
 *  out on the next start by bumping started_at in adminStartSession. The
 *  realtime listener picks up the active→lobby transition and re-renders the
 *  lobby for everyone, including the host. */
async function cancelSession() {
  console.warn('[FubzLifts] cancelSession called');
  if (!activeSession) return;
  const sessionId = activeSession.id;

  const lobbyState = JSON.parse(JSON.stringify(activeSession.lobby_state || { members: {} }));
  if (lobbyState.members) {
    Object.keys(lobbyState.members).forEach(uid => {
      if (lobbyState.members[uid]) lobbyState.members[uid].ready = false;
    });
  }
  lobbyState.last_activity_at = new Date().toISOString();

  const { error } = await supabase.from('sessions').update({
    status: 'lobby',
    current_exercise: null,
    current_turn_index: 0,
    current_set: 1,
    lobby_state: lobbyState,
  }).eq('id', sessionId);
  if (error) {
    console.error('[FubzLifts] cancelSession error:', error);
    toast('Failed to end workout — check connection');
  }
}

// ─── ACTIVE SESSION ──────────────────────────────────────

// Wall-clock anchor for the timer tick. Each tick increments timers[uid] by
// the *actual* seconds elapsed since the last tick — not by a fixed +1. This
// way, when iOS pauses the JS context (app backgrounded), the timers stay
// accurate: on resume, the next tick computes the real elapsed time and
// jumps the values forward, instead of looking like the rest timer "froze"
// during the background period.
let lastTickAt = 0;

/** Timer tick — increment rest timers for everyone except the active person */
function startTimerTick(container) {
  clearInterval(timerInterval);
  lastTickAt = Date.now();
  timerInterval = setInterval(advanceTimers, 1000);
}

function advanceTimers() {
  if (!activeSession || activeSession.status !== 'active') return;
  const now = Date.now();
  const elapsedSec = Math.max(0, Math.round((now - lastTickAt) / 1000));
  if (elapsedSec === 0) return;
  lastTickAt = now;
  const simultaneous = isSimultaneous(activeSession.current_exercise);
  const activeTurnUserId = activeSession.turn_order[activeSession.current_turn_index];
  activeSession.turn_order.forEach(uid => {
    if (simultaneous || uid !== activeTurnUserId) {
      timers[uid] = (timers[uid] || 0) + elapsedSec;
    }
  });
  updateTimerDisplay();
}

// Force a catch-up tick the moment the page becomes visible again. setInterval
// might take up to a second to fire after iOS resume, but this fires
// synchronously on visibility resume so the timer jump is imperceptible.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') advanceTimers();
});
window.addEventListener('focus', advanceTimers);

/** Compute the status label for a timer row (e.g. "UP NEXT", "resting", "ready"). */
function timerStatusLabel(uid) {
  const simultaneous = isSimultaneous(activeSession.current_exercise);
  const activeTurnUserId = activeSession.turn_order[activeSession.current_turn_index];
  const isActive = uid === activeTurnUserId;
  const t = timers[uid] || 0;
  if (simultaneous) return t > 0 ? 'resting' : '';
  if (isActive) return 'UP NEXT';
  return t > 0 ? 'resting' : 'ready';
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
    // Refresh the status label too — otherwise it stays on whatever value
    // was baked in at the last full re-render and goes stale within seconds.
    const status = document.querySelector(`.timer-status[data-uid="${uid}"]`);
    if (status) status.textContent = timerStatusLabel(uid);
  });
}

// In-flight guard for logSet. The DONE/FAIL handlers are async and the insert
// can take up to 8s on a slow link; without this flag a fast double-tap (trivial
// on a phone) re-enters logSet before the first log is in setLogs, producing two
// rows with the same set_number AND two advanceTurn() calls — duplicate/extra
// sets and a corrupted turn rotation. The module flag is the load-bearing guard
// (survives the async boundary regardless of DOM); the button disable in
// renderSession is just visible feedback.
let logSetInFlight = false;

/** Log a set (done or fail) */
async function logSet(success) {
  if (logSetInFlight) return;
  logSetInFlight = true;
  try {
    const user = getUser();
    const exercise = activeSession.current_exercise;
    const weight = memberWeights[user.id]?.[exercise] || 45;
    const myLogs = setLogs.filter(l => l.user_id === user.id && l.exercise === exercise);
    const setNumber = myLogs.length + 1;

    let log, error;
    try {
      // 8s timeout — typical insert is <500ms; if the SDK is hung past this
      // the websocket/HTTP layer is dead and a reload is the recovery path.
      const result = await withTimeout(
        supabase
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
          .single(),
        8000,
        'set_logs.insert'
      );
      log = result.data;
      error = result.error;
    } catch (e) {
      if (e instanceof TimeoutError) {
        // Hung supabase — the "buttons unresponsive" symptom. Force a reload
        // to re-establish auth + websocket. Resume state is preserved by the
        // saveResumeState path in app.js, so the user lands back here mid-set.
        console.warn('[FubzLifts] logSet timed out — forcing recovery reload');
        toast('Reconnecting…');
        window.fubzInvisibleReload?.();
        return;
      }
      toast('Connection lost — tap to retry after reconnecting');
      return;
    }

    if (error) { toast('Failed to log set — check connection'); return; }

    if (!setLogs.find(l => l.id === log.id)) setLogs.push(log);
    timers[user.id] = 0;

    // Reward the press: the cat reacts with a random clip on every advance.
    triggerCompanion(success ? 'set_done' : 'set_fail');

    await advanceTurn();
  } finally {
    logSetInFlight = false;
  }
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
      try {
        // Update DB immediately — realtime handler shows splash for ALL clients
        await withTimeout(
          supabase.from('sessions').update({
            current_exercise: nextExercise,
            current_turn_index: 0,
            current_set: 1,
          }).eq('id', activeSession.id),
          8000,
          'sessions.update next exercise'
        );
      } catch (e) {
        if (e instanceof TimeoutError) {
          console.warn('[FubzLifts] advanceTurn (exercise) timed out — forcing recovery reload');
          window.fubzInvisibleReload?.();
          return;
        }
        throw e;
      }
      activeSession.turn_order.forEach(uid => { timers[uid] = 0; });
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

  try {
    await withTimeout(
      supabase.from('sessions').update({
        current_turn_index: nextIdx,
      }).eq('id', activeSession.id),
      8000,
      'sessions.update turn index'
    );
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn('[FubzLifts] advanceTurn (turn) timed out — forcing recovery reload');
      window.fubzInvisibleReload?.();
      return;
    }
    throw e;
  }
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

/** End the session */
async function endSession() {
  // These run off the FINAL set's DONE press. Unwrapped, a hung write here froze
  // the lifter on their last rep with no recovery (the watchdog sees healthy
  // auth+channel and won't act). Guard them so a hang triggers a reload instead.
  try {
    await withTimeout(
      supabase.from('sessions').update({
        status: 'completed',
        ended_at: new Date().toISOString(),
      }).eq('id', activeSession.id),
      8000,
      'sessions.update completed'
    );

    // Toggle next workout for the group
    const nextWorkout = activeSession.workout_type === 'A' ? 'B' : 'A';
    await withTimeout(
      supabase.from('groups').update({ next_workout: nextWorkout }).eq('id', activeSession.group_id),
      8000,
      'groups.update next_workout'
    );
  } catch (e) {
    if (e instanceof TimeoutError) {
      console.warn('[FubzLifts] endSession timed out — forcing recovery reload');
      window.fubzInvisibleReload?.();
      return;
    }
    throw e;
  }

  // Apply MY progression (each client does its own — see applyMyProgression).
  await applyMyProgression();

  // Show summary locally (other clients get it via realtime, and apply their
  // own progression in that handler).
  const container = document.getElementById('sessionView');
  clearInterval(timerInterval);
  renderSessionSummary(container);
}

// Guard: apply this client's progression at most once per completed session.
// Reset in cleanupSession so a fresh session can progress again.
let progressionDone = false;

/** Apply weight progression for the CURRENT USER ONLY when the session completes.
 *  CRITICAL: RLS only lets a user update their OWN profile_weights, so the old
 *  approach (the finisher looping turn_order and updating everyone) silently
 *  failed for every member except whoever pressed the last set — they never
 *  progressed. Now each client applies its own +5 on completion: the finisher
 *  from endSession, every other client from the 'completed' realtime/reconcile
 *  branch. Re-fetches MY set_logs from the DB (authoritative — avoids a missed
 *  realtime INSERT making a completed exercise look incomplete). Idempotent via
 *  progressionDone so the finisher's direct call + its own echo don't double-add. */
async function applyMyProgression() {
  const user = getUser();
  if (!user || !activeSession || progressionDone) return;
  progressionDone = true;
  const sid = activeSession.id;
  const startedAt = activeSession.started_at;
  const exercises = WORKOUTS[activeSession.workout_type] || [];
  try {
    const { data: myLogs } = await withTimeout(
      supabase.from('set_logs').select('exercise,success')
        .eq('session_id', sid).eq('user_id', user.id).gte('logged_at', startedAt),
      6000, 'progression.myLogs'
    );
    for (const exercise of exercises) {
      const maxSets = getMaxSets(exercise);
      const logs = (myLogs || []).filter(l => l.exercise === exercise);
      const allSuccess = logs.length >= maxSets && logs.every(l => l.success);
      if (!allSuccess) continue; // only fully-successful exercises progress
      try {
        const { data: wr } = await withTimeout(
          supabase.from('profile_weights').select('weight_lbs')
            .eq('user_id', user.id).eq('exercise', exercise).single(),
          6000, 'progression.select'
        );
        if (!wr) continue;
        await withTimeout(
          supabase.from('profile_weights').update({ weight_lbs: wr.weight_lbs + 5 })
            .eq('user_id', user.id).eq('exercise', exercise),
          6000, 'progression.update'
        );
        if (memberWeights[user.id]) memberWeights[user.id][exercise] = wr.weight_lbs + 5;
      } catch (e) {
        if (e instanceof TimeoutError) { console.warn('[FubzLifts] progression timed out for', exercise); continue; }
        throw e;
      }
    }
  } catch (e) {
    if (!(e instanceof TimeoutError)) console.error('[FubzLifts] applyMyProgression error:', e);
    // best-effort: never block the summary on progression
  }
}

/** Render the active session */
function renderSession(container) {
  if (!activeSession || activeSession.status !== 'active') return;

  // Reveal the cat companion while a workout is live (idempotent).
  mountCompanion();

  // Sync the paw vote indicator with the latest session state on every render.
  updatePawVoteUI();

  const user = getUser();
  const exercise = activeSession.current_exercise;
  const exerciseName = EXERCISE_NAMES[exercise];
  const maxSets = getMaxSets(exercise);
  const exercises = WORKOUTS[activeSession.workout_type];
  const simultaneous = isSimultaneous(exercise);
  // Clamp the turn index into range. A kick/leave racing an advanceTurn can leave
  // current_turn_index pointing past the (now shorter) turn_order in the DB; without
  // this every client would compute activeTurnUserId=undefined → nobody is "your
  // turn" → all DONE/FAIL buttons vanish and the session hard-wedges. The clamp is
  // deterministic (same idx+length on every client) so everyone still agrees on who
  // is active; repairTurnIfNeeded() then writes the corrected index authoritatively.
  const order = activeSession.turn_order || [];
  const rawIdx = activeSession.current_turn_index || 0;
  const safeIdx = order.length ? ((rawIdx % order.length) + order.length) % order.length : 0;
  // In simultaneous mode, show your own weight/progress; in turn mode, show active person's
  const activeTurnUserId = simultaneous ? user.id : order[safeIdx];
  const isMyTurn = simultaneous || activeTurnUserId === user.id;
  const activeAlias = sessionMembers.find(m => m.id === activeTurnUserId)?.alias || 'Unknown';
  const weight = memberWeights[activeTurnUserId]?.[exercise] || 45;
  const adminId = getSessionAdmin();

  const activeLogs = setLogs.filter(l => l.user_id === activeTurnUserId && l.exercise === exercise);
  // Clamp to maxSets so the brief render between "last set logged" and the
  // exercise-complete splash doesn't flash "Set 6/5" or similar overflow.
  const currentSetNum = Math.min(activeLogs.length + 1, maxSets);
  const mySetsDone = simultaneous && activeLogs.length >= maxSets;

  // Bake the paw button's revealed/voted state directly into the rendered
  // markup. Without this, every re-render of renderSession (which wipes the
  // banner DOM via innerHTML) would create a fresh button in default state,
  // and updatePawVoteUI re-adding .revealed would retrigger the slow reveal
  // transition each time. Baking means the animation only plays on actual
  // state transitions (banner tap, vote cast) — not on incidental re-renders.
  const pawVoteState = activeSession.lobby_state?.paw_vote;
  const isPawVoteForExercise = pawVoteState && pawVoteState.exercise === exercise;
  const shouldRevealPaw = !!(isPawVoteForExercise || pawRevealed);
  const iVotedPaw = !!(isPawVoteForExercise && pawVoteState.voters?.includes(user.id));
  const pawCls = `paw-button${shouldRevealPaw ? ' revealed' : ''}${iVotedPaw ? ' voted' : ''}`;
  // Pips render inline inside the banner, only when a vote's actually live.
  const pipsHTML = isPawVoteForExercise
    ? activeSession.turn_order.map(uid => {
        const voted = pawVoteState.voters?.includes(uid);
        return `<div class="paw-pip ${voted ? 'voted' : ''}"></div>`;
      }).join('')
    : '';

  container.innerHTML = `
    <div class="exercise-banner" id="exerciseBanner">
      <div class="exercise-meta">Workout ${activeSession.workout_type} · ${exercises.indexOf(exercise) + 1}/${exercises.length}</div>
      <div class="exercise-name">${exerciseName}</div>
      <div class="exercise-meta">${maxSets} × 5 reps</div>
      <button class="${pawCls}" id="pawButton" aria-label="Vote for 6th set">
        <svg><use href="#icon-paw"/></svg>
      </button>
      <div class="paw-pips-inline" id="pawPipsInline" ${pipsHTML ? '' : 'hidden'}>${pipsHTML}</div>
    </div>

    <div class="companion-turn-row" style="display:flex;align-items:center;justify-content:center;gap:18px;margin:8px 0">
      <div id="fubzCompanionSlot" style="width:128px;height:128px;flex:none"></div>
      <div>
        <div class="turn-indicator ${(isMyTurn && !mySetsDone) ? 'your-turn pulsing' : ''}" style="margin:0 0 6px">
          ${simultaneous
            ? (mySetsDone ? '⏳ Waiting for others...' : '🏋️ EVERYONE LIFTS')
            : (isMyTurn
              ? '🏋️ YOUR TURN'
              : `Waiting for <span class="name">${esc(activeAlias)}</span>`)}
        </div>
        <div class="weight-display" style="margin:0">
          ${weight} <span class="weight-unit">lbs</span>
        </div>
      </div>
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

    ${(isMyTurn && !mySetsDone) ? `
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
        <div class="muted">${mySetsDone ? 'All sets done — waiting for others' : 'Wait for your turn...'}</div>
      </div>
    `}

    ${activeSession.turn_order.length > 1 ? `
    <div class="section">
      <h3>Rest Timers</h3>
      <div class="timer-stack">
        ${activeSession.turn_order.map(uid => {
          const member = sessionMembers.find(m => m.id === uid);
          const alias = member?.alias || 'Unknown';
          const isActive = uid === activeTurnUserId;
          const t = timers[uid] || 0;
          const isHost = uid === adminId;
          return `
            <div class="timer-row ${isActive ? 'active' : ''}">
              <div class="timer-alias">${esc(alias)}${pawBadge(member?.paw_count)}${isHost ? '<span class="muted" style="font-size:10px;font-weight:400"> (host)</span>' : ''}</div>
              <div class="timer-bar">
                <div class="timer-bar-fill" data-uid="${uid}" style="width:${Math.min(t / 300, 1) * 100}%"></div>
              </div>
              <div class="timer-value" data-uid="${uid}">${formatTime(t)}</div>
              <div class="timer-status" data-uid="${uid}">${timerStatusLabel(uid)}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:8px">
        <h3 style="margin:0">Progress — ${exerciseName}</h3>
        ${adminId === user.id && activeSession.turn_order.length > 1 ? '<button class="btn-link kick-manage-btn" id="sessionManageBtn" style="font-size:11px;color:var(--muted-color);text-transform:none">Manage</button>' : ''}
      </div>
      ${activeSession.turn_order.map(uid => {
        const member = sessionMembers.find(m => m.id === uid);
        const alias = member?.alias || 'Unknown';
        const userLogs = setLogs.filter(l => l.user_id === uid && l.exercise === exercise);
        const mw = memberWeights[uid]?.[exercise] || 45;
        const isHost = uid === adminId;
        const iAmHost = adminId === user.id;
        const canKick = iAmHost && uid !== user.id;
        return `
          <div class="card" style="margin-bottom:6px">
            <div class="card-row">
              <div class="card-info">
                <div class="card-title">${esc(alias)}${pawBadge(member?.paw_count)}${isHost ? '<span class="muted" style="font-size:11px;font-weight:400"> (host)</span>' : ''} <span class="muted">${mw} lbs</span></div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <div class="set-dots" style="margin:0">
                  ${Array.from({ length: maxSets }, (_, i) => {
                    const log = userLogs[i];
                    let cls = '';
                    if (log && log.success) cls = 'done';
                    else if (log && !log.success) cls = 'fail';
                    return `<div class="set-dot ${cls}" style="width:20px;height:20px;font-size:9px">${i + 1}</div>`;
                  }).join('')}
                </div>
                ${canKick ? `<button class="btn btn-danger session-kick-btn" data-uid="${uid}" data-alias="${esc(alias)}" style="padding:4px 8px;font-size:11px" title="Kick ${esc(alias)}">✕</button>` : ''}
              </div>
            </div>
            ${canKick ? `
              <div class="session-kick-confirm" data-uid="${uid}" hidden style="margin-top:8px;border-top:1px solid var(--border-light);padding-top:8px">
                <div style="font-size:12px;color:var(--danger-text);margin-bottom:4px;font-weight:600">Kick ${esc(alias)}?</div>
                <div style="font-size:11px;color:var(--muted-color);margin-bottom:6px">Type <strong style="color:var(--danger-text)">KICK</strong> to confirm:</div>
                <input class="field session-kick-input" data-uid="${uid}" placeholder="Type KICK" style="text-transform:uppercase;margin-bottom:6px;font-size:12px;padding:6px" />
                <div class="btn-group">
                  <button class="btn btn-danger session-kick-final" data-uid="${uid}" disabled style="font-size:11px">Confirm Kick</button>
                  <button class="btn session-kick-cancel" data-uid="${uid}" style="font-size:11px">Cancel</button>
                </div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>

    <div class="session-footer">
      ${getSessionAdmin() === user.id ? `
        <div style="display:flex;justify-content:center;gap:20px;flex-wrap:wrap">
          <button class="btn-link" id="sessionEndBtn">End workout</button>
          <button class="btn-link" id="sessionLeaveBtn">Leave session</button>
        </div>
        <div class="session-action-confirm" id="sessionEndConfirm" hidden>
          <p class="muted" style="margin:0 0 10px;font-size:13px">
            End the workout and send everyone back to the lobby? Progress this
            session will be discarded — no weight progression will apply.
          </p>
          <div class="btn-group">
            <button class="btn btn-danger" id="confirmEndBtn">Yes, back to lobby</button>
            <button class="btn" id="cancelEndBtn">Keep going</button>
          </div>
        </div>
        <div class="session-action-confirm" id="sessionLeaveConfirm" hidden>
          <p class="muted" style="margin:0 0 10px;font-size:13px">
            Leave the session? Everyone else keeps going without you, and
            host duties pass to the next person in turn order.
          </p>
          <div class="btn-group">
            <button class="btn btn-danger" id="confirmLeaveBtn">Yes, leave</button>
            <button class="btn" id="cancelLeaveBtn">Stay</button>
          </div>
        </div>
      ` : `
        <button class="btn-link session-action-trigger" id="sessionActionBtn">Leave session</button>
        <div class="session-action-confirm" id="sessionActionConfirm" hidden>
          <p class="muted" style="margin:0 0 10px;font-size:13px">
            Leave the session? The rest of the group will keep going without you.
          </p>
          <div class="btn-group">
            <button class="btn btn-danger" id="confirmEndBtn">Yes, leave</button>
            <button class="btn" id="cancelEndBtn">Stay</button>
          </div>
        </div>
      `}
      ${getSessionAdmin() !== user.id ? `
        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border-light)">
          <button class="btn-link" id="sessionClaimHostBtn" style="font-size:11px;color:var(--muted-color)">Host inactive? Claim host</button>
          <div id="sessionClaimHostConfirm" hidden style="margin-top:8px">
            <p class="muted" style="margin:0 0 8px;font-size:12px">Take over as host? You'll be able to end the workout for everyone.</p>
            <div class="btn-group">
              <button class="btn btn-primary" id="sessionClaimHostYes" style="font-size:12px">Yes, claim host</button>
              <button class="btn" id="sessionClaimHostNo" style="font-size:12px">Cancel</button>
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  if (isMyTurn && !mySetsDone) {
    const doneBtn = container.querySelector('#doneBtn');
    const failBtn = container.querySelector('#failBtn');
    // Disable BOTH synchronously on tap so the button visibly reflects the
    // in-flight state; the logSetInFlight flag is the real double-tap guard.
    // Buttons are naturally re-enabled by the next renderSession innerHTML rebuild.
    const lockButtons = () => { if (doneBtn) doneBtn.disabled = true; if (failBtn) failBtn.disabled = true; };
    doneBtn?.addEventListener('click', () => { lockButtons(); logSet(true); });
    failBtn?.addEventListener('click', () => { lockButtons(); logSet(false); });
  }

  // End / Leave session — host has both options (End for everyone OR just
  // Leave themselves), non-host has only Leave. Each trigger toggles its
  // own inline confirm panel; opening one closes the other.
  if (getSessionAdmin() === user.id) {
    const endTrigger = container.querySelector('#sessionEndBtn');
    const leaveTrigger = container.querySelector('#sessionLeaveBtn');
    const endConfirm = container.querySelector('#sessionEndConfirm');
    const leaveConfirm = container.querySelector('#sessionLeaveConfirm');
    endTrigger?.addEventListener('click', () => {
      if (leaveConfirm) leaveConfirm.hidden = true;
      if (endConfirm) endConfirm.hidden = !endConfirm.hidden;
    });
    leaveTrigger?.addEventListener('click', () => {
      if (endConfirm) endConfirm.hidden = true;
      if (leaveConfirm) leaveConfirm.hidden = !leaveConfirm.hidden;
    });
    container.querySelector('#cancelEndBtn')?.addEventListener('click', () => {
      if (endConfirm) endConfirm.hidden = true;
    });
    container.querySelector('#cancelLeaveBtn')?.addEventListener('click', () => {
      if (leaveConfirm) leaveConfirm.hidden = true;
    });
    container.querySelector('#confirmEndBtn')?.addEventListener('click', () => cancelSession());
    container.querySelector('#confirmLeaveBtn')?.addEventListener('click', () => leaveSession());
  } else {
    const trigger = container.querySelector('#sessionActionBtn');
    const confirmEl = container.querySelector('#sessionActionConfirm');
    trigger?.addEventListener('click', () => {
      if (confirmEl) confirmEl.hidden = !confirmEl.hidden;
    });
    container.querySelector('#cancelEndBtn')?.addEventListener('click', () => {
      if (confirmEl) confirmEl.hidden = true;
    });
    container.querySelector('#confirmEndBtn')?.addEventListener('click', () => leaveSession());
  }

  // Claim host (active session) — inline confirm pattern
  const claimTrigger = container.querySelector('#sessionClaimHostBtn');
  const claimConfirm = container.querySelector('#sessionClaimHostConfirm');
  claimTrigger?.addEventListener('click', () => {
    if (claimConfirm) claimConfirm.hidden = !claimConfirm.hidden;
  });
  container.querySelector('#sessionClaimHostNo')?.addEventListener('click', () => {
    if (claimConfirm) claimConfirm.hidden = true;
  });
  container.querySelector('#sessionClaimHostYes')?.addEventListener('click', () => {
    claimHost();
  });

  // Manage members toggle (active session)
  const manageBtn = container.querySelector('#sessionManageBtn');
  if (manageBtn) {
    manageBtn.textContent = document.body.classList.contains('kick-managing') ? 'Done' : 'Manage';
    manageBtn.addEventListener('click', () => {
      document.body.classList.toggle('kick-managing');
      const isManaging = document.body.classList.contains('kick-managing');
      manageBtn.textContent = isManaging ? 'Done' : 'Manage';
      if (!isManaging) {
        container.querySelectorAll('.session-kick-confirm').forEach(p => { p.hidden = true; });
      }
    });
  }

  // Kick (active session) — host-only, gated by typed "KICK" confirmation.
  // The full container.innerHTML rewrite in renderSession means we re-attach
  // these per-render; handlers are local to this view and never delegated.
  container.querySelectorAll('.session-kick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const uid = btn.dataset.uid;
      // Close any other open kick panel
      container.querySelectorAll('.session-kick-confirm').forEach(p => { p.hidden = true; });
      const confirmEl = container.querySelector(`.session-kick-confirm[data-uid="${uid}"]`);
      if (confirmEl) {
        confirmEl.hidden = false;
        const input = confirmEl.querySelector('.session-kick-input');
        const finalBtn = confirmEl.querySelector('.session-kick-final');
        if (input) { input.value = ''; input.focus(); }
        if (finalBtn) finalBtn.disabled = true;
      }
    });
  });
  container.querySelectorAll('.session-kick-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const uid = btn.dataset.uid;
      const confirmEl = container.querySelector(`.session-kick-confirm[data-uid="${uid}"]`);
      if (confirmEl) confirmEl.hidden = true;
    });
  });
  container.querySelectorAll('.session-kick-input').forEach(input => {
    input.addEventListener('input', () => {
      const uid = input.dataset.uid;
      const finalBtn = container.querySelector(`.session-kick-final[data-uid="${uid}"]`);
      if (finalBtn) finalBtn.disabled = input.value.trim().toUpperCase() !== 'KICK';
    });
  });
  container.querySelectorAll('.session-kick-final').forEach(btn => {
    btn.addEventListener('click', () => {
      kickMember(btn.dataset.uid);
    });
  });
}

/** Render session summary after completion */
function renderSessionSummary(container) {
  // Retire the cat before the celebration screen — it lives on document.body and
  // would otherwise survive the container swap and float over the summary. This
  // one spot covers all three completion paths (endSession / realtime / reconcile);
  // cleanupSession() stays the catch-all for leave/navigate.
  unmountCompanion();

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
  unmountCompanion();
  clearInterval(timerInterval);
  clearInterval(reconcileInterval);
  reconcileInterval = null;
  reconciling = false;
  hasSubscribedOnce = false;
  progressionDone = false;
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  // Remove delegated click + input handlers
  if (lobbyContainer && lobbyContainer._lobbyClickHandler) {
    lobbyContainer.removeEventListener('click', lobbyContainer._lobbyClickHandler);
    lobbyContainer._lobbyClickHandler = null;
  }
  if (lobbyContainer && lobbyContainer._lobbyInputHandler) {
    lobbyContainer.removeEventListener('input', lobbyContainer._lobbyInputHandler);
    lobbyContainer._lobbyInputHandler = null;
  }
  realtimeChannel = null;
  activeSession = null;
  groupOwnerId = null;
  lobbyRendered = false;
  lobbyContainer = null;
  hostUsurped = false;
  pendingUsurpType = null;
  lastExercise = null;
  setLogs = [];
  timers = {};
  // Reset host's manage-mode toggle so it doesn't carry over into the next
  // session view (especially relevant if the user lost host status).
  document.body.classList.remove('kick-managing');
  // Reset paw vote local state and hide the indicator/button.
  pawRevealed = false;
  updatePawVoteUI();
  // Drop the groups-list cache so the home view doesn't briefly show a stale
  // "Workout in progress" indicator on the group we just left/ended/finished.
  clearGroupsCache();
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
