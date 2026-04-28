// Shared utility helpers

/** Format seconds into M:SS */
export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Generate a 5-letter uppercase join code */
export function generateJoinCode() {
  const words = [
    'FLAME','SQUAT','PRESS','STEEL','POWER','CRUSH','GRIND','HEAVY',
    'FORGE','BEAST','VIGOR','SURGE','BRAWN','CLANK','DRIVE','FOCUS',
    'GAINS','HULKS','IRONS','JOINT','KINGS','LIFTS','MIGHT','NERVE',
    'OMEGA','PLANK','QUADS','REBAR','SWOLE','TITAN','ULTRA','VAULT',
    'WRATH','XENON','YIELD','ZONES','ARMOR','BENCH','CHAIN','DELTS',
    'ELITE','FIBER','GIRTH','HYPER','JUICY','KNEEL','LANCE','MEDAL',
  ];
  return words[Math.floor(Math.random() * words.length)];
}

/** Show a toast notification */
export function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('show'), duration);
}

/** Show/hide views */
export function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const view = document.getElementById(viewId);
  if (view) view.classList.add('active');
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
