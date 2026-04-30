// Shared utility helpers

/** Format seconds into M:SS */
export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Pool of 4–8 character words used to build join codes. Curated to be
 *  family-friendly and easy to say aloud. ~180 words → 180³ ≈ 5.8M unique
 *  3-word combinations, so collisions are functionally impossible until you
 *  have thousands of active groups. */
const JOIN_WORDS = [
  'ALPHA','ANKLES','ANVIL','APEX','ARMOR','ASHES','ATOM',
  'BACK','BACON','BANANA','BANG','BARBELL','BARN','BEANS','BEAR','BEAST','BENCH','BICEPS','BISON','BLAST','BOLD','BOOM','BRASS','BRAWN','BRONZE','BRUTAL','BUFFALO','BULL','BUTTER',
  'CALVES','CARDIO','CASTLE','CHAIN','CHALK','CHEST','CHICKEN','CHROME','CINDER','CLANK','COMET','COPPER','CORE','CRUSH','CRYSTAL','CURLS',
  'DEADS','DELTS','DIAMOND','DRAGON','DRIVE','DUNK',
  'EAGLE','EGGS','ELITE','EMBER','EPIC',
  'FALCON','FIBER','FIERCE','FIERY','FLAME','FLAMING','FLEX','FOCUS','FOREST','FORGE','FROST',
  'GAINS','GAUNTLET','GIANT','GIRTH','GLACIER','GLUTES','GOAT','GOLD','GORILLA','GRAND','GRANITE','GRIM','GRIND','GRIP',
  'HAMMER','HARDY','HAWK','HEAVY','HIPPO','HUGE','HULKS','HUSTLE','HYPER',
  'IRON','IRONS',
  'JOINT','JUICY','JUNGLE',
  'KALE','KETTLE','KINGS','KNEEL','KNEES','KODIAK','KRAKEN',
  'LANCE','LASER','LEGS','LIFT','LIFTS','LIGHT','LION',
  'MAGMA','MAMMOTH','MARBLE','MEAN','MEDAL','MIGHT','MIGHTY','MONSTER','MOOSE','MOUNTAIN','MYTHIC',
  'NECK','NERVE','NOBLE',
  'OATMEAL','OATS','OCEAN','OMEGA',
  'PLANET','PLANK','PLANTER','PLATE','POLAR','POWER','PRESS','PRIME','PROTEIN','PULL','PUMP','PUMPKIN','PUSH','PYTHON',
  'QUADS','QUARTZ',
  'RACK','RAGING','REBAR','REPS','RHINO','RICE','RIVER','ROCKET','ROYAL','RUBY','RUGGED','RUNE',
  'SAGA','SAVAGE','SETS','SHADOW','SHARP','SHIELD','SILVER','SMASH','SOLID','SPATULA','SPHINX','SQUAT','STAG','STEAK','STEED','STEEL','STORM','STOUT','SUPER','SURGE','SWOLE','SWORD',
  'TAVERN','THUNDER','TIGER','TITAN','TOAST','TOUGH','TRAPS','TUNDRA','TURBO',
  'ULTRA',
  'VAULT','VICE','VIGOR','VIPER',
  'WAVE','WEIGHT','WILD','WIZARD','WOLF','WRATH',
  'XENON','YIELD','ZONES','ZONK',
];

/** Build a 3-word join code separated by spaces, e.g. "FLAMING SQUAT PIE".
 *  Caller is responsible for verifying uniqueness against existing rows
 *  (see createGroup). With ~180 words the keyspace is ~5.8M, so collisions
 *  are functionally never an issue at the scales this app sees. */
export function generateJoinCode() {
  const pick = () => JOIN_WORDS[Math.floor(Math.random() * JOIN_WORDS.length)];
  return `${pick()} ${pick()} ${pick()}`;
}

/** Normalize a join code for matching. Uppercase, trim, and collapse any
 *  internal whitespace runs to single spaces — so "flaming  squat  pie",
 *  "  Flaming Squat Pie  ", and "FLAMING SQUAT PIE" all resolve to the
 *  same canonical form used both in storage and in joinGroup() lookup. */
export function normalizeJoinCode(input) {
  return (input || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Show a toast notification */
export function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('show'), duration);
}

/** Show/hide views with a smooth crossfade where supported. */
export function showView(viewId) {
  const swap = () => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(viewId);
    if (view) view.classList.add('active');
  };
  if (document.startViewTransition && !document.documentElement.classList.contains('vt-disabled')) {
    document.startViewTransition(swap);
  } else {
    swap();
  }
}

/** Exercises for each workout type */
export const WORKOUTS = {
  A: ['squat', 'bench', 'row'],
  B: ['squat', 'ohp', 'deadlift'],
};

/** Display names for exercises */
export const EXERCISE_NAMES = {
  squat: 'Squat',
  bench: 'Bench Press',
  ohp: 'Overhead Press',
  row: 'Barbell Row',
  deadlift: 'Deadlift',
};

/** Default sets for each exercise (deadlift = 1, rest = 5) */
export const DEFAULT_SETS = {
  squat: 5,
  bench: 5,
  ohp: 5,
  row: 5,
  deadlift: 1,
};

/** Starting weight for new users */
export const STARTING_WEIGHT = 45;

/** Render a small paw-print badge next to a member's alias if they've ever
 *  initiated a successful 6th-set vote. Awarded once per successful vote
 *  (count tracked in users.paw_count). The badge appears next to their
 *  name across all views — lobby member cards, session rest timers,
 *  progress cards, and their own header alias. Returns empty string when
 *  count is 0 so callers can blindly concat. */
export function pawBadge(count) {
  if (!count || count <= 0) return '';
  return `<span class="paw-badge" title="${count} successful 6th-set vote${count !== 1 ? 's' : ''} initiated"><svg viewBox="0 0 100 100"><use href="#icon-paw"/></svg></span>`;
}
