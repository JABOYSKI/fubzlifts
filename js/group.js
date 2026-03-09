// Group management module
import { supabase } from './supabase.js';
import { getUser } from './auth.js';
import { toast, generateJoinCode, STARTING_WEIGHT, EXERCISE_NAMES } from './utils.js';

/** Fetch all groups the current user belongs to */
export async function getMyGroups() {
  const user = getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('group_members')
    .select('group_id, is_admin, groups(*)')
    .eq('user_id', user.id);
  if (error) { toast(error.message); return []; }
  return (data || []).map(row => ({ ...row.groups, is_admin: row.is_admin }));
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

/** Get weights for all members in a group */
export async function getGroupWeights(groupId) {
  const { data, error } = await supabase
    .from('user_weights')
    .select('*')
    .eq('group_id', groupId);
  if (error) return [];
  return data || [];
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

  // Initialize weights for creator
  await initUserWeights(user.id, group.id);

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
    .eq('join_code', code.toUpperCase().trim())
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

  await initUserWeights(user.id, group.id);
  toast(`Joined "${group.name}"!`);
  return group;
}

/** Initialize default weights for a user in a group */
async function initUserWeights(userId, groupId) {
  const exercises = ['squat', 'bench', 'ohp', 'row', 'deadlift'];
  const rows = exercises.map(exercise => ({
    user_id: userId,
    group_id: groupId,
    exercise,
    weight_lbs: STARTING_WEIGHT,
    fail_streak: 0,
  }));
  await supabase.from('user_weights').upsert(rows);
}

/** Render group list view */
export function renderGroups(container, onSelectGroup, onStartSession) {
  let groups = [];

  async function load() {
    groups = await getMyGroups();
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
        ` : groups.map(g => `
          <div class="card group-card" data-id="${g.id}">
            <div class="card-row">
              <div class="card-info">
                <div class="card-title">${esc(g.name)}</div>
                <div class="card-subtitle">
                  Code: <strong style="color:var(--orange)">${g.join_code}</strong>
                </div>
                <div class="card-subtitle muted" style="font-size:11px">
                  Created ${new Date(g.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}
                </div>
              </div>
              <button class="btn btn-primary start-btn" data-id="${g.id}">Start</button>
            </div>
            <!-- Workout picker (hidden until Start is tapped) -->
            <div class="workout-picker" data-id="${g.id}" style="display:none">
              <div style="font-size:12px;color:var(--muted-color);margin:10px 0 6px;text-transform:uppercase;letter-spacing:.6px;font-weight:600">Pick workout</div>
              <div class="btn-group">
                <button class="btn pick-workout ${g.next_workout === 'A' ? 'btn-primary' : ''}" data-id="${g.id}" data-type="A">
                  A — Squat / Bench / Row
                </button>
                <button class="btn pick-workout ${g.next_workout === 'B' ? 'btn-primary' : ''}" data-id="${g.id}" data-type="B">
                  B — Squat / OHP / DL
                </button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="btn-group" style="margin-top:16px">
        <button class="btn btn-secondary" id="createGroupBtn">Create Group</button>
        <button class="btn btn-secondary" id="joinGroupBtn">Join Group</button>
      </div>

      <!-- Create group form (hidden) -->
      <div id="createGroupForm" class="section" style="display:none">
        <div class="card">
          <div class="form-group">
            <label>Group Name</label>
            <input class="field" id="newGroupName" placeholder="e.g. Monday Crew" maxlength="30" />
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
            <label>Join Code</label>
            <input class="field" id="joinCodeInput" placeholder="e.g. FLAME" maxlength="5" style="text-transform:uppercase" />
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
        if (e.target.closest('.start-btn')) return;
        onSelectGroup(card.dataset.id);
      });
    });

    // Event: start session — show workout picker
    container.querySelectorAll('.start-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Hide all other pickers
        container.querySelectorAll('.workout-picker').forEach(p => p.style.display = 'none');
        const picker = container.querySelector(`.workout-picker[data-id="${btn.dataset.id}"]`);
        picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
      });
    });

    // Event: pick A or B workout
    container.querySelectorAll('.pick-workout').forEach(btn => {
      btn.addEventListener('click', () => {
        onStartSession(btn.dataset.id, btn.dataset.type);
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
      const group = await createGroup(name);
      if (group) await load();
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
      const group = await joinGroup(code);
      if (group) await load();
    });

    // Enter key on inputs
    container.querySelector('#newGroupName')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') container.querySelector('#createGroupConfirm').click();
    });
    container.querySelector('#joinCodeInput')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') container.querySelector('#joinGroupConfirm').click();
    });
  }

  load();
  return { reload: load };
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
