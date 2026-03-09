# FubzLifts — Group StrongLifts 5×5 App

## Overview
FubzLifts is a real-time group workout tracker built around the **StrongLifts 5×5** program. It's designed for 2–4 people who share a single barbell rack at the gym, taking turns set-by-set in a round-robin fashion. The app tracks weights, progression, rest timers, and session state — synced in real time across all group members.

---

## Core Concepts

### StrongLifts 5×5 Program Rules
- **5 exercises only:** Squat, Bench Press, Overhead Press (OHP), Barbell Row, Deadlift
- **A/B day split:**
  - **Workout A:** Squat 5×5, Bench Press 5×5, Barbell Row 5×5
  - **Workout B:** Squat 5×5, Overhead Press 5×5, Deadlift 1×5
- Workouts alternate: A, B, A, B...
- **Deadlift is 1×5** (one working set of five reps), all others are 5×5
  - Users may optionally increase deadlift sets up to 5×5 if they choose
- **Auto-progression:** Add 5 lbs per exercise per successful completion (all prescribed sets and reps completed)
- **Deload protocol:** After 3 consecutive failures on an exercise, prompt the user asking if they want to deload (reduce weight by 10%). Do NOT auto-deload — always ask.
- **No warm-up set tracking** — only working sets

### Group Model
- A **group** is 2–4 people who work out together consistently
- One person is the **group owner** (creator) with admin powers; they can grant admin to others
- Members join via a **5-character word code** (e.g., "FLAME", "SQUAT") shared verbally
- All workout data is **shared with the group automatically**
- A person can be in **multiple groups**
- Privacy: no emails exposed — members see only each other's **alias**

### User Profile
- **Alias** (display name visible to group)
- **Avatar** (optional, user-uploaded)
- **Per-exercise current working weight** (tracked automatically)
- No email or personal info shared with group members

---

## Session Flow (This is the heart of the app)

### Starting a Session
1. Any group member can start a session for a group
2. The app determines if it's an **A day or B day** based on the group's history
3. Members "tap in" to join the session — they can join late
4. **Turn order is set at session start** and stays fixed for the entire session (same order every exercise)
5. Even a single person can run a session solo — the logic is the same, just one person in the rotation

### During an Exercise (e.g., Squat 5×5)
- The app shows: **current exercise, whose turn it is, their required weight, and set/rep count**
- Only the person whose turn it is has the active controls
- **Two buttons for the active person:**
  - **"DONE" (prominent, primary)** — successfully completed the set (all 5 reps). Logs the set, starts their rest timer, advances to the next person
  - **"FAIL" (smaller, secondary)** — could not complete all reps. Still logs and advances. Also used to skip an exercise entirely (just press fail for each set)
- After pressing Done/Fail, that person's **rest timer starts counting up** and is visible to everyone
- The next person in the rotation becomes active
- Round-robin continues until everyone completes all prescribed sets for that exercise

### Rest Timer Stack
- **Every group member's rest timer is visible at all times** during a session
- Timers count up from 0 after each completed set
- No harsh warnings at 5 minutes — this is informational, not punitive
- The timer stack gives everyone situational awareness of pacing

### Between Exercises
- When all members finish their sets for an exercise, show a **brief congratulatory splash** (e.g., "Squats complete! 💪") before auto-advancing to the next exercise
- No manual confirmation needed to advance

### Ending a Session
- Session ends when all exercises for the day are complete
- Show a **session summary**: exercises completed, any fails logged, next workout day (A or B)
- Progression logic runs: for each user, if they completed all sets/reps for an exercise, their weight goes up 5 lbs for next time

### Late Joins
- A member can join a session already in progress
- They get inserted into the turn rotation for the current exercise
- For exercises already completed, they can either skip or do them afterward (keep it simple for v1 — just insert into current rotation)

### Offline Solo Mode
- If no internet, a user can start a solo workout using their **last known weights**
- Follows the same session flow (just one person)
- When connectivity returns, **sync results back to the group** (weights, completion, fails)

---

## Tech Stack

### Frontend
- **Single-page app** hosted on **GitHub Pages** (repo: `jaboyski/fubzlifts`)
- Must work on: desktop browser, Android phone, iPhone
- **PWA** with service worker for offline support
- Framework decision: **TBD** — evaluate during implementation. Priorities:
  - Real-time reactivity (Supabase subscriptions)
  - Lightweight / fast on mobile
  - Simple build pipeline (ideally deployable to GitHub Pages)
  - Candidates: vanilla JS (like Tasknari), Svelte, Preact, or React

### Backend
- **Supabase** (free tier) for:
  - **Postgres database** — structured workout data
  - **Real-time subscriptions** — session sync across devices
  - **Auth** — lightweight, alias-based profiles
  - **Row-level security** — group data isolation
- No custom server needed

### Deployment
- Frontend: GitHub Pages at `jaboyski.github.io/fubzlifts`
- Backend: Supabase cloud (free tier: 500MB DB, real-time, auth)
- User runs deploy manually (no auto-deploy)

---

## Design System — Match Tasknari Aesthetic

Reference app: [Tasknari](https://jaboyski.github.io/tasknari/)
Source: `C:\Users\JABOYSKI 2025\Downloads\try\todo-try\todo-claude.html`

### Color Palette (from Tasknari)
```css
--bg: #131921;          /* page background */
--header: #232F3E;      /* header / top bar */
--panel: #1C2B3A;       /* panel backgrounds */
--card: #1F2D3D;        /* card surfaces */
--card-hover: #253647;  /* card hover state */
--border: #37475A;      /* borders */
--border-light: #2D3E50;/* subtle borders */
--text: #F0F2F2;        /* primary text */
--muted-color: #8D9EB0; /* secondary text */
--orange: #FF9900;       /* primary accent */
--orange-hover: #FEBD69; /* accent hover */
--orange-dim: rgba(255,153,0,.12); /* accent background tint */
--teal: #00A8B5;         /* secondary accent */
--teal-dim: rgba(0,168,181,.12);
--danger: #C0392B;       /* error / fail */
--danger-dim: rgba(192,57,43,.2);
--radius: 6px;
```

### Typography & Styling
- Font: `"Amazon Ember", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial`
- Font size: 14px base, line-height 1.55
- Section headers: 11px uppercase, letter-spacing .8px, muted color
- Buttons: 12px, font-weight 500–700, border-radius 6px, subtle transitions (.12s)
- Primary buttons: orange background, dark text, bold
- Cards: dark background, subtle border, hover glow
- Sticky header with orange bottom border (3px), box-shadow
- All transitions smooth (0.12s–0.15s)
- Cell-shaded SVG icon style

### Key UI Principles (from Tasknari)
- Clean, dark, Amazon-inspired aesthetic
- Orange (#FF9900) as the dominant accent everywhere
- Smooth micro-interactions and transitions
- Cards with subtle borders and hover states
- Chips and badges for status indicators
- Toast notifications for feedback
- Mobile-first, responsive layout (max-width: 980px container)

---

## Database Schema (Supabase / Postgres)

### Tables

```
users
  id            UUID (PK, from Supabase auth)
  alias         TEXT NOT NULL
  avatar_url    TEXT (nullable)
  created_at    TIMESTAMPTZ

groups
  id            UUID (PK)
  name          TEXT NOT NULL
  join_code     TEXT UNIQUE NOT NULL (5-char word, e.g., "FLAME")
  owner_id      UUID (FK → users.id)
  next_workout  TEXT ('A' or 'B')
  created_at    TIMESTAMPTZ

group_members
  group_id      UUID (FK → groups.id)
  user_id       UUID (FK → users.id)
  is_admin      BOOLEAN DEFAULT false
  PRIMARY KEY (group_id, user_id)

user_weights
  user_id       UUID (FK → users.id)
  group_id      UUID (FK → groups.id)
  exercise      TEXT ('squat', 'bench', 'ohp', 'row', 'deadlift')
  weight_lbs    NUMERIC NOT NULL
  fail_streak   INTEGER DEFAULT 0
  PRIMARY KEY (user_id, group_id, exercise)

sessions
  id            UUID (PK)
  group_id      UUID (FK → groups.id)
  workout_type  TEXT ('A' or 'B')
  status        TEXT ('active', 'completed')
  turn_order    TEXT[] (array of user_ids)
  current_exercise TEXT (nullable)
  started_at    TIMESTAMPTZ
  ended_at      TIMESTAMPTZ (nullable)

session_members
  session_id    UUID (FK → sessions.id)
  user_id       UUID (FK → users.id)
  joined_at     TIMESTAMPTZ
  PRIMARY KEY (session_id, user_id)

set_logs
  id            UUID (PK)
  session_id    UUID (FK → sessions.id)
  user_id       UUID (FK → users.id)
  exercise      TEXT
  set_number    INTEGER
  reps          INTEGER (target: 5)
  weight_lbs    NUMERIC
  success       BOOLEAN
  logged_at     TIMESTAMPTZ
```

### Real-Time Channels
- `session:{session_id}` — broadcasts turn changes, timer updates, exercise transitions
- `group:{group_id}` — member joins, session start notifications

---

## V1 Scope (MVP)

### In Scope
- [ ] Supabase setup (auth, database, RLS policies)
- [ ] User registration (alias + optional avatar)
- [ ] Group creation with 5-char word join code
- [ ] Group joining via code
- [ ] A/B day tracking per group
- [ ] Start session → determine A or B day → set turn order
- [ ] Round-robin set tracking with Done/Fail buttons
- [ ] Real-time rest timer stack (visible for all members)
- [ ] Auto-advance between exercises with congratulatory splash
- [ ] Session summary on completion
- [ ] Auto-progression (+5 lbs on success)
- [ ] Deload prompt after 3 consecutive fails (ask, don't auto-apply)
- [ ] Configurable deadlift sets (1×5 default, up to 5×5)
- [ ] Late join mid-session
- [ ] Offline solo mode with sync-on-reconnect
- [ ] PWA / installable
- [ ] GitHub Pages deployment

### Out of Scope (V2+)
- Progress charts and graphs per member/exercise
- Body weight / measurement tracking
- Notifications / reminders
- Plate calculator
- Exercise substitutions
- Chat or messaging within groups

---

## File Structure (Planned)
```
fubzlifts/
├── CLAUDE.md              ← this file
├── index.html             ← main app entry
├── css/
│   └── styles.css         ← Tasknari-matched design system
├── js/
│   ├── app.js             ← main app logic, routing
│   ├── supabase.js        ← Supabase client init & helpers
│   ├── auth.js            ← login, registration, profile
│   ├── group.js           ← group CRUD, join codes, membership
│   ├── session.js         ← session flow, turn management, timers
│   ├── offline.js         ← offline queue & sync logic
│   └── utils.js           ← shared helpers
├── sw.js                  ← service worker for PWA/offline
├── manifest.json          ← PWA manifest
├── icons/                 ← app icons (192, 512)
└── deploy.bat             ← manual deploy script
```

---

## Supabase Setup Guide

The user (jaboyski) needs to set up Supabase before development begins:

### Steps
1. Go to [supabase.com](https://supabase.com) and sign up (GitHub login works)
2. Click **"New Project"**
   - Name: `fubzlifts`
   - Database password: save this somewhere safe
   - Region: pick the closest to your location
3. Once created, go to **Settings → API** and note:
   - **Project URL** (e.g., `https://xxxxx.supabase.co`)
   - **Anon/public key** (safe to expose in frontend code)
4. Go to **SQL Editor** and run the table creation SQL (we'll generate this)
5. Set up **Row-Level Security (RLS)** policies (we'll generate these too)
6. Enable **Realtime** on the `sessions`, `session_members`, and `set_logs` tables:
   - Go to **Database → Tables** → click each table → **Enable Realtime**

### What to share with Claude after setup
- Project URL
- Anon public key
- (NEVER share the service_role key or DB password)

---

## Development Notes
- **Never auto-deploy** — user runs `deploy.bat` manually
- Primary test device: **Samsung Z Fold 5** (foldable, test both narrow and wide modes)
- Keep the Tasknari source (`todo-claude.html`) open as design reference
- SVG icons should match Tasknari's cell-shaded style
- Orange (#FF9900) is the dominant accent — use it for all primary actions
- The "DONE" button during a session should be the most prominent element on screen
- "FAIL" button should be present but visually secondary (smaller, muted styling)
