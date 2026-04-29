// Group management module
import { supabase } from './supabase.js';
import { getUser } from './auth.js';
import { toast, generateJoinCode, normalizeJoinCode } from './utils.js';

// Module-level cache so navigation can render instantly from last-known state
// while a fresh fetch runs in the background. Populated by getMyGroups, cleared
// by clearGroupsCache (e.g. on sign-out).
let cachedGroups = null;

// Live presence subscriptions — one channel per group with an active session.
// We don't track() here (Groups view is a passive observer); we only listen
// for presence:sync to count who's actually inside.
const presenceChannels = new Map(); // sessionId → RealtimeChannel

function teardownAllPresence() {
  for (const ch of presenceChannels.values()) supabase.removeChannel(ch);
  presenceChannels.clear();
}

export function getCachedGroups() { return cachedGroups; }
export function clearGroupsCache() {
  cachedGroups = null;
  teardownAllPresence();
}

/** Fetch all groups the current user belongs to, plus any active/lobby session per group */
export async function getMyGroups() {

  const user = getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('group_members')
    .select('group_id, is_admin, groups(*)')
    .eq('user_id', user.id);
  if (error) { toast(error.message); return []; }
  const groups = (data || []).map(row => ({ ...row.groups, is_admin: row.is_admin }));

  // Surface in-progress sessions so the home screen can show an indicator.
  // One open lobby/active session per group at a time, so we just attach it to the row.
  const ids = groups.map(g => g.id);
  if (ids.length > 0) {
    const { data: sessions } = await supabase
      .from('sessions')
      .select('id, group_id, status, workout_type, current_exercise')
      .in('group_id', ids)
      .in('status', ['lobby', 'active']);
    const byGroup = {};
    (sessions || []).forEach(s => { byGroup[s.group_id] = s; });
    groups.forEach(g => { g.activeSession = byGroup[g.id] || null; });
  }
  cachedGroups = groups;
  return groups;
}

/** Get group members with their aliases and weights */
export async function getGroupMembers(groupId) {
  const { data, error } = await supabase
    .from('group_members')
    .select('user_id, is_admin, users(id, alias, avatar_url)')
    .eq('group_id', groupId);
  if (error) { toast(error.message); return []; }
  return (data || []).map(row => ({ ...row.users, is_admin: row.is_admin }));
}

/** Create a new group */
export async function createGroup(name) {

  const user = getUser();
  if (!user) return null;

  // Generate unique join code (retry if collision)
  let joinCode = generateJoinCode();
  let attempts = 0;
  while (attempts < 10) {
    const { data: existing } = await supabase
      .from('groups')
      .select('id')
      .eq('join_code', joinCode)
      .single();
    if (!existing) break;
    joinCode = generateJoinCode();
    attempts++;
  }

  const { data: group, error } = await supabase
    .from('groups')
    .insert({ name, join_code: joinCode, owner_id: user.id })
    .select()
    .single();
  if (error) { toast(error.message); return null; }

  // Add creator as member + admin
  await supabase.from('group_members').insert({
    group_id: group.id, user_id: user.id, is_admin: true
  });

  toast(`Group "${name}" created! Code: ${joinCode}`);
  return group;
}

/** Join a group via code */
export async function joinGroup(code) {

  const user = getUser();
  if (!user) return null;

  const { data: group, error: findErr } = await supabase
    .from('groups')
    .select('*')
    .eq('join_code', normalizeJoinCode(code))
    .single();
  if (findErr || !group) { toast('Group not found — check the code'); return null; }

  // Check if already a member
  const { data: existing } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', group.id)
    .eq('user_id', user.id)
    .single();
  if (existing) { toast('You\'re already in this group'); return group; }

  // Check member count
  const { count } = await supabase
    .from('group_members')
    .select('*', { count: 'exact', head: true })
    .eq('group_id', group.id);
  if (count >= 4) { toast('Group is full (max 4 members)'); return null; }

  const { error } = await supabase
    .from('group_members')
    .insert({ group_id: group.id, user_id: user.id });
  if (error) { toast(error.message); return null; }

  toast(`Joined "${group.name}"!`);
  return group;
}

/** Non-admin: leave a group (remove self from group_members). Idempotent —
 *  if you're not actually a member, the delete just affects 0 rows. */
export async function leaveGroup(groupId) {
  const user = getUser();
  if (!user) return false;
  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', user.id);
  if (error) { toast(error.message); return false; }
  toast('Left group');
  return true;
}

/** Delete a group — removes all related data */
export async function deleteGroup(groupId) {

  const user = getUser();
  if (!user) return false;

  // Delete in order: set_logs → session_members → sessions → group_members → group
  const sessionIds = (await supabase.from('sessions').select('id').eq('group_id', groupId)).data?.map(s => s.id) || [];
  if (sessionIds.length > 0) {
    await supabase.from('set_logs').delete().in('session_id', sessionIds);
    await supabase.from('session_members').delete().in('session_id', sessionIds);
  }
  await supabase.from('sessions').delete().eq('group_id', groupId);
  await supabase.from('group_members').delete().eq('group_id', groupId);
  const { error } = await supabase.from('groups').delete().eq('id', groupId);
  if (error) { toast(error.message); return false; }
  toast('Group deleted');
  return true;
}

/** Render group list view.
 *  - If we have a cache, renders synchronously from it and kicks off a
 *    background revalidation. Caller can showView() immediately for a
 *    snappy, native-feeling transition.
 *  - If there's no cache (first visit since sign-in), the function awaits
 *    the initial fetch + render before resolving so the View Transition
 *    snapshots a populated view.
 *  Returns a promise resolving to a handle with `reload()`. */
export async function renderGroups(container, onSelectGroup, onStartSession) {
  let groups = [];

  async function load() {
    const fresh = await getMyGroups();
    // Skip the re-render if data hasn't actually changed — most navigations
    // come back to identical state, and a no-op skip prevents the cache hit
    // from causing a visible flash on revalidation.
    if (sameGroupList(groups, fresh)) return;
    groups = fresh;
    render();
  }

  function render() {
    container.innerHTML = `
      <div class="section">
        <div class="section-header">
          <h3>Your Groups</h3>
        </div>
        ${groups.length === 0 ? `
          <div class="empty-state">
            <strong>No groups yet</strong>
            <span>Create one or join with a code</span>
          </div>
        ` : groups.map(g => {
          const inLobby = g.activeSession?.status === 'lobby';
          const inActive = g.activeSession?.status === 'active';
          // Indicator text gets live-updated by the presence subscriber once
          // it knows who's actually inside (see syncPresence below). Initial
          // markup uses the static fallbacks; presence sync swaps in counts.
          const exerciseSuffix = inActive && g.activeSession.current_exercise
            ? ' · ' + esc(g.activeSession.current_exercise.toUpperCase())
            : '';
          const baseText = inLobby
            ? 'Lobby open'
            : inActive
            ? `Workout in progress${exerciseSuffix}`
            : '';
          const isActive = g.activeSession?.status === 'active';
          // Default to is-empty (grey) until the presence channel reports an
          // actual count. If someone's already inside, the first sync flips
          // it to orange/green within ms, faster than the eye sees.
          const indicator = g.activeSession
            ? `<div class="card-subtitle group-presence is-empty ${isActive ? 'is-active' : ''}" data-session-id="${g.activeSession.id}" data-status="${g.activeSession.status}" data-exercise="${g.activeSession.current_exercise || ''}">
                 <span class="presence-dot"></span><span class="presence-text">${baseText}</span>
               </div>`
            : '';
          const startLabel = inLobby ? 'Join' : inActive ? 'Join' : 'Start';
          return `
          <div class="card group-card${g.activeSession ? ' has-active-session' : ''}" data-id="${g.id}">
            <div class="card-row">
              <div class="card-info">
                <div class="card-title">${esc(g.name)}</div>
                <div class="card-subtitle">
                  Code: <strong style="color:var(--orange)">${g.join_code}</strong>
                </div>
                ${indicator || `<div class="card-subtitle muted" style="font-size:11px">
                  Created ${new Date(g.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                </div>`}
              </div>
              <div style="display:flex;gap:6px;align-items:center">
                <button class="btn btn-primary start-btn" data-id="${g.id}">${startLabel}</button>
                <button class="btn btn-danger group-action-btn" data-id="${g.id}" data-admin="${g.is_admin ? '1' : '0'}" style="padding:6px 10px;font-size:12px" title="${g.is_admin ? 'Delete group' : 'Leave group'}">✕</button>
              </div>
            </div>
            ${g.is_admin ? `
            <!-- Admin: type DELETE to wipe the entire group -->
            <div class="delete-confirm" data-id="${g.id}" style="display:none">
              <div style="font-size:13px;color:var(--danger-text);margin:10px 0 8px;font-weight:600">Delete "${esc(g.name)}"?</div>
              <div class="delete-step1" data-id="${g.id}">
                <div style="font-size:12px;color:var(--muted-color);margin-bottom:8px">This will remove all group data permanently.</div>
                <div class="btn-group">
                  <button class="btn btn-danger delete-step1-yes" data-id="${g.id}">Yes, delete</button>
                  <button class="btn delete-cancel" data-id="${g.id}">Cancel</button>
                </div>
              </div>
              <div class="delete-step2" data-id="${g.id}" style="display:none">
                <div style="font-size:12px;color:var(--muted-color);margin-bottom:8px">Type <strong style="color:var(--danger-text)">DELETE</strong> to confirm:</div>
                <input class="field delete-confirm-input" data-id="${g.id}" name="delete-confirm-${g.id}" aria-label="Type DELETE to confirm" placeholder="Type DELETE" style="text-transform:uppercase;margin-bottom:8px" />
                <div class="btn-group">
                  <button class="btn btn-danger delete-final" data-id="${g.id}" disabled>Confirm Delete</button>
                  <button class="btn delete-cancel" data-id="${g.id}">Cancel</button>
                </div>
              </div>
            </div>
            ` : `
            <!-- Non-admin: leave the group (just removes self — single confirm) -->
            <div class="leave-confirm" data-id="${g.id}" style="display:none">
              <div style="font-size:13px;color:var(--danger-text);margin:10px 0 8px;font-weight:600">Leave "${esc(g.name)}"?</div>
              <div style="font-size:12px;color:var(--muted-color);margin-bottom:8px">You'll need the join code to come back.</div>
              <div class="btn-group">
                <button class="btn btn-danger leave-final" data-id="${g.id}">Yes, leave</button>
                <button class="btn leave-cancel" data-id="${g.id}">Cancel</button>
              </div>
            </div>
            `}
          </div>
        `;
        }).join('')}
      </div>
      <div class="btn-group" style="margin-top:16px">
        <button class="btn btn-secondary" id="createGroupBtn">Create Group</button>
        <button class="btn btn-secondary" id="joinGroupBtn">Join Group</button>
      </div>

      <!-- Create group form (hidden) -->
      <div id="createGroupForm" class="section" style="display:none">
        <div class="card">
          <div class="form-group">
            <label for="newGroupName">Group Name</label>
            <input class="field" id="newGroupName" name="newGroupName" placeholder="e.g. Monday Crew" maxlength="30" />
          </div>
          <div class="btn-group">
            <button class="btn btn-primary" id="createGroupConfirm">Create</button>
            <button class="btn" id="createGroupCancel">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Join group form (hidden) -->
      <div id="joinGroupForm" class="section" style="display:none">
        <div class="card">
          <div class="form-group">
            <label for="joinCodeInput">Join Code</label>
            <input class="field" id="joinCodeInput" name="joinCode" placeholder="e.g. FLAMING SQUAT PIE" maxlength="40" style="text-transform:uppercase" />
          </div>
          <div class="btn-group">
            <button class="btn btn-primary" id="joinGroupConfirm">Join</button>
            <button class="btn" id="joinGroupCancel">Cancel</button>
          </div>
        </div>
      </div>
    `;

    // Event: tap group card to view details
    container.querySelectorAll('.group-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.start-btn') || e.target.closest('.group-action-btn') || e.target.closest('.delete-confirm') || e.target.closest('.leave-confirm')) return;
        onSelectGroup(card.dataset.id);
      });
    });

    // Event: start session — go to lobby
    container.querySelectorAll('.start-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        onStartSession(btn.dataset.id);
      });
    });

    // Group action (✕) — admins see the DELETE-typing flow that wipes the
    // whole group; non-admins see a single-confirm "Leave group" flow that
    // just removes themselves from group_members.
    container.querySelectorAll('.group-action-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const gId = btn.dataset.id;
        const isAdmin = btn.dataset.admin === '1';
        // Close any other confirm panels
        container.querySelectorAll('.delete-confirm, .leave-confirm').forEach(p => p.style.display = 'none');

        if (isAdmin) {
          const confirm = container.querySelector(`.delete-confirm[data-id="${gId}"]`);
          if (!confirm) return;
          confirm.style.display = 'block';
          const step1 = confirm.querySelector(`.delete-step1[data-id="${gId}"]`);
          const step2 = confirm.querySelector(`.delete-step2[data-id="${gId}"]`);
          if (step1) step1.style.display = 'block';
          if (step2) step2.style.display = 'none';
        } else {
          const confirm = container.querySelector(`.leave-confirm[data-id="${gId}"]`);
          if (confirm) confirm.style.display = 'block';
        }
      });
    });

    // Non-admin: leave group
    container.querySelectorAll('.leave-final').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await leaveGroup(btn.dataset.id);
        if (ok) await load();
      });
    });
    container.querySelectorAll('.leave-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const confirm = container.querySelector(`.leave-confirm[data-id="${btn.dataset.id}"]`);
        if (confirm) confirm.style.display = 'none';
      });
    });

    // Step 1: "Yes, delete" → if multi-member, show step 2; if solo, delete immediately
    container.querySelectorAll('.delete-step1-yes').forEach(btn => {
      btn.addEventListener('click', async () => {
        const gId = btn.dataset.id;
        const members = await getGroupMembers(gId);
        if (members.length <= 1) {
          // Solo — delete now
          const ok = await deleteGroup(gId);
          if (ok) await load();
        } else {
          // Multi-member — require typing DELETE
          const step1 = container.querySelector(`.delete-step1[data-id="${gId}"]`);
          const step2 = container.querySelector(`.delete-step2[data-id="${gId}"]`);
          step1.style.display = 'none';
          step2.style.display = 'block';
        }
      });
    });

    // Step 2: enable final button only when "DELETE" is typed
    container.querySelectorAll('.delete-confirm-input').forEach(input => {
      input.addEventListener('input', () => {
        const gId = input.dataset.id;
        const finalBtn = container.querySelector(`.delete-final[data-id="${gId}"]`);
        finalBtn.disabled = input.value.trim().toUpperCase() !== 'DELETE';
      });
    });

    // Step 2: final delete
    container.querySelectorAll('.delete-final').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await deleteGroup(btn.dataset.id);
        if (ok) await load();
      });
    });

    // Cancel delete
    container.querySelectorAll('.delete-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const confirm = container.querySelector(`.delete-confirm[data-id="${btn.dataset.id}"]`);
        confirm.style.display = 'none';
      });
    });

    // Create group
    const createBtn = container.querySelector('#createGroupBtn');
    const createForm = container.querySelector('#createGroupForm');
    createBtn.addEventListener('click', () => {
      createForm.style.display = createForm.style.display === 'none' ? 'block' : 'none';
      container.querySelector('#joinGroupForm').style.display = 'none';
    });
    container.querySelector('#createGroupCancel').addEventListener('click', () => createForm.style.display = 'none');
    container.querySelector('#createGroupConfirm').addEventListener('click', async () => {
      const name = container.querySelector('#newGroupName').value.trim();
      if (!name) return toast('Enter a group name');
      const btn = container.querySelector('#createGroupConfirm');
      btn.disabled = true;
      btn.textContent = 'Creating...';
      try {
        const group = await createGroup(name);
        if (group) await load();
      } catch (e) {
        console.error('[FubzLifts] Create group error:', e);
        toast('Failed to create group');
      }
      btn.disabled = false;
      btn.textContent = 'Create';
    });

    // Join group
    const joinBtn = container.querySelector('#joinGroupBtn');
    const joinForm = container.querySelector('#joinGroupForm');
    joinBtn.addEventListener('click', () => {
      joinForm.style.display = joinForm.style.display === 'none' ? 'block' : 'none';
      createForm.style.display = 'none';
    });
    container.querySelector('#joinGroupCancel').addEventListener('click', () => joinForm.style.display = 'none');
    container.querySelector('#joinGroupConfirm').addEventListener('click', async () => {
      const code = container.querySelector('#joinCodeInput').value.trim();
      if (!code) return toast('Enter a join code');
      const btn = container.querySelector('#joinGroupConfirm');
      btn.disabled = true;
      btn.textContent = 'Joining...';
      try {
        const group = await joinGroup(code);
        if (group) await load();
      } catch (e) {
        console.error('[FubzLifts] Join group error:', e);
        toast('Failed to join group');
      }
      btn.disabled = false;
      btn.textContent = 'Join';
    });

    // Enter key on inputs
    container.querySelector('#newGroupName')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') container.querySelector('#createGroupConfirm').click();
    });
    container.querySelector('#joinCodeInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') container.querySelector('#joinGroupConfirm').click();
    });

    syncPresence();
  }

  /** Subscribe to a presence channel for each active session in the current
   *  groups list. The Groups view itself is a passive observer — it doesn't
   *  track(), so it doesn't appear in the count. Only session participants
   *  (clients in session.js that called track) show up. */
  function syncPresence() {
    const wantedIds = new Set(
      groups.filter(g => g.activeSession).map(g => g.activeSession.id)
    );
    // Drop channels for sessions no longer in the list
    for (const [sid, ch] of presenceChannels) {
      if (!wantedIds.has(sid)) {
        supabase.removeChannel(ch);
        presenceChannels.delete(sid);
      }
    }
    // Subscribe new ones
    for (const sid of wantedIds) {
      if (presenceChannels.has(sid)) continue;
      const onPresenceChange = () => {
        const state = channel.presenceState();
        const count = Object.keys(state).length;
        updatePresenceIndicator(sid, count);
      };
      const channel = supabase
        .channel(`session_${sid}`)
        // sync alone is supposed to cover all state changes, but in practice
        // it sometimes only fires on the initial subscribe and misses
        // subsequent join/leave events. Listening to all three guarantees
        // the indicator updates as soon as someone enters or leaves the
        // lobby — that's what makes it feel live without a refresh.
        .on('presence', { event: 'sync' }, onPresenceChange)
        .on('presence', { event: 'join' }, onPresenceChange)
        .on('presence', { event: 'leave' }, onPresenceChange)
        // Also watch the sessions row itself: status flips (lobby → active)
        // and current_exercise changes (squat → bench mid-workout) need to
        // update the indicator copy and dot color in real time.
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'sessions',
          filter: `id=eq.${sid}`,
        }, (payload) => {
          const next = payload.new;
          if (!next) return;
          updateIndicatorMeta(sid, next);
        })
        .subscribe();
      presenceChannels.set(sid, channel);
    }
  }

  /** Update the count + pulse on a single card's presence indicator. The dot
   *  is orange for lobbies and green for active workouts; pulses only when
   *  someone is actually inside. */
  function updatePresenceIndicator(sessionId, count) {
    const indicator = container.querySelector(`.group-presence[data-session-id="${sessionId}"]`);
    if (!indicator) return;
    const dot = indicator.querySelector('.presence-dot');
    const text = indicator.querySelector('.presence-text');
    const status = indicator.dataset.status;
    const exerciseRaw = indicator.dataset.exercise || '';
    const exerciseSuffix = exerciseRaw ? ' · ' + exerciseRaw.toUpperCase() : '';
    const isActive = status === 'active';
    const isEmpty = count === 0;
    indicator.classList.toggle('is-active', isActive);
    indicator.classList.toggle('is-empty', isEmpty);
    if (dot) {
      dot.classList.toggle('live', !isEmpty);
    }
    if (text) {
      text.textContent = isEmpty
        ? (isActive ? `Workout in progress${exerciseSuffix}` : 'Lobby open')
        : (isActive ? `${count} lifting${exerciseSuffix}` : `${count} in lobby`);
    }
  }

  /** React to a sessions-row UPDATE: refresh data-status / data-exercise on
   *  the indicator and recompute the visible text+color via the presence
   *  count we already track in the channel. If the session has ended
   *  (completed/cancelled), drop the indicator entirely so the card no
   *  longer pretends a session is running. */
  function updateIndicatorMeta(sessionId, session) {
    const indicator = container.querySelector(`.group-presence[data-session-id="${sessionId}"]`);
    if (!indicator) return;
    if (session.status === 'completed' || session.status === 'cancelled') {
      indicator.style.display = 'none';
      return;
    }
    indicator.style.display = '';
    indicator.dataset.status = session.status;
    indicator.dataset.exercise = session.current_exercise || '';
    const channel = presenceChannels.get(sessionId);
    const count = channel ? Object.keys(channel.presenceState()).length : 0;
    updatePresenceIndicator(sessionId, count);
  }

  // Optimistic path: if we have last-known groups, render them synchronously
  // so the caller's View Transition snapshots a populated view immediately.
  // Then revalidate in the background and only re-render on real changes.
  if (cachedGroups) {
    groups = cachedGroups;
    render();
    load(); // intentionally not awaited — silent background refresh
  } else {
    // First visit since sign-in: must await the fetch so the transition
    // doesn't snapshot an empty view.
    await load();
  }
  return { reload: load };
}

// Shallow check — order matters. Compares the fields renderGroups actually
// uses for output, so we don't trigger a redundant re-render on metadata
// noise like updated_at.
function sameGroupList(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id) return false;
    if (x.name !== y.name) return false;
    if (x.join_code !== y.join_code) return false;
    if ((x.is_admin || false) !== (y.is_admin || false)) return false;
    const xs = x.activeSession || null, ys = y.activeSession || null;
    if (!!xs !== !!ys) return false;
    if (xs && (xs.status !== ys.status || xs.current_exercise !== ys.current_exercise)) return false;
  }
  return true;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
