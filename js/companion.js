// On-screen cat companion — a floating mascot (the FubzLifts cat).
//
// COEXISTS with the workout UI: at idle it aligns to a layout slot
// (#fubzCompanionSlot) next to the weight / YOUR TURN block, so the two sit
// side-by-side. On a DONE/FAIL press it GROWS and CENTERS on screen for the
// duration of the action clip, then animates back to the slot. Positioning is a
// single GPU-composited transform (translate + scale), see applyPlacement().
//
// Idle is two-tiered so he reads as a calm cat, not a montage:
//   • SUPER-IDLE (baseline): a calm stare-* clip is LOOPED and held.
//   • AMBIENT BEAT (rare): every ~15–25s, occasionally one expression
//     (rest-/face-/pool-idle-), then back to staring.
//   • ACTION: a DONE/FAIL press plays a random act-*/pool-act- clip, grown and
//     centered on screen, then returns to the idle slot.
// Clip changes use a two-layer crossfade. Looped stares are pre-boomeranged
// (tools/loopify.mjs) so they loop seamlessly.
//
// Clip source: local manifest (companion/clips-manifest.json) first, else the
// Supabase bucket. Degrades to the static photo if nothing is reachable.

import { supabase, withTimeout } from './supabase.js';

const COMPANION = {
  idleSize: 128, cornerRadius: 16,           // visual size beside the weight (idle)
  intrinsic: 360,                            // the element's true px size; transform scales it (keeps video crisp)
  centerVw: 80, centerMaxPx: 360,            // on a DONE press: grow to this size, centered on screen
  fadeMs: 320,                               // crossfade between clips
  ambientMinMs: 13000, ambientMaxMs: 28000,  // idle pacing
  expressionChance: 0.6,                     // chance an idle beat is an expression
  superIdleMatch: /^stare-/,                 // calm baseline (looped/held)
  expressionMatch: /^(rest-|face-|pool-idle-)/,
  actionMatch: /^(act-|pool-act-)/,
  slotSelector: '#fubzCompanionSlot',        // align to this layout slot (next to the weight)
  fallbackLeftPx: 12, fallbackTopPct: 34,    // used only if no slot is present
  manifestSrc: 'companion/clips-manifest.json',
  bucket: 'companion', clipsFolder: 'clips',
  videoExts: ['.mp4', '.webm', '.mov', '.m4v'],
  posterSrc: 'assets/companion/cat-face-sq.jpg',
  posterFallback: 'icons/icon-192.png',
  maxClipMs: 9000, recentMemory: 24, recentKey: 'fubz_companion_recent_v2',
};

const TRIGGERS = { set_done: true, set_fail: true };

let root = null, layers = [], front = 0;
let superPool = [], exprPool = [], actionPool = [];
let listLoaded = false, listLoading = null;
let mode = 'static';        // 'static' | 'idle' | 'playing'
let playToken = 0;
let collapseTimer = null, ambientTimer = null;
let prefersReducedMotion = false;
let listenersBound = false;

// ─── styles ───────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('fubzCompanionStyles')) return;
  const C = COMPANION;
  const style = document.createElement('style');
  style.id = 'fubzCompanionStyles';
  style.textContent = `
    /* The element is a fixed ${C.intrinsic}px box positioned at (0,0); a JS-set
       transform translate()+scale() moves/sizes it (slot beside the weight ↔
       big & centered). Transform is GPU-composited so it animates reliably. */
    .fubz-companion {
      position: fixed; left: 0; top: 0; z-index: 90;
      width: ${C.intrinsic}px; height: ${C.intrinsic}px; transform-origin: 0 0;
      opacity: 0; pointer-events: none;
    }
    .fubz-companion.fc-ready { transition: transform .44s cubic-bezier(.34,1.2,.4,1), opacity .25s ease; }
    .fubz-companion.mounted { opacity: 1; pointer-events: auto; }
    .fubz-companion .fc-orb {
      position: absolute; inset: 0; padding: 0;
      border-radius: ${C.cornerRadius}px; border: 3px solid var(--orange); background: var(--card);
      box-shadow: 0 8px 26px rgba(0,0,0,.55); overflow: hidden; cursor: pointer;
      transition: border-color .3s ease; -webkit-tap-highlight-color: transparent;
    }
    .fubz-companion .fc-poster, .fubz-companion .fc-video {
      position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .fubz-companion .fc-video { opacity: 0; transition: opacity ${C.fadeMs}ms ease; }
    .fubz-companion .fc-video.front { opacity: 1; }
    .fubz-companion .fc-poster { opacity: 1; transition: opacity ${C.fadeMs}ms ease; }
    .fubz-companion.fc-live .fc-poster { opacity: 0; }
    /* a press = subtle border highlight only; NO resize, so it never covers the UI */
    .fubz-companion[data-state="playing"] .fc-orb { border-color: var(--orange-hover); }
    @keyframes fcPop {
      0% { transform: scale(1); } 35% { transform: scale(1.08) rotate(-3deg); }
      70% { transform: scale(.98) rotate(2deg); } 100% { transform: scale(1) rotate(0); }
    }
    .fubz-companion.fc-pop .fc-orb { animation: fcPop .6s ease-in-out; }
    @media (prefers-reduced-motion: reduce) {
      .fubz-companion, .fubz-companion .fc-orb, .fubz-companion .fc-video, .fubz-companion .fc-poster {
        transition: opacity .2s ease;
      }
      .fubz-companion.fc-pop .fc-orb { animation: none; }
    }
  `;
  document.head.appendChild(style);
}

function buildDom() {
  if (root) return;
  injectStyles();
  root = document.createElement('div');
  root.className = 'fubz-companion';
  root.id = 'fubzCompanion';
  root.setAttribute('data-state', 'idle');
  root.innerHTML = `
    <button class="fc-orb" type="button" aria-label="FubzLifts cat companion">
      <img class="fc-poster" alt="" src="${COMPANION.posterSrc}"
           onerror="this.onerror=null;this.src='${COMPANION.posterFallback}'" />
      <video class="fc-video" data-layer="a" muted playsinline preload="auto" aria-hidden="true"></video>
      <video class="fc-video" data-layer="b" muted playsinline preload="auto" aria-hidden="true"></video>
    </button>
  `;
  document.body.appendChild(root);
  layers = [...root.querySelectorAll('.fc-video')];
  front = 0;

  root.querySelector('.fc-orb').addEventListener('click', () => play());
  layers.forEach(v => {
    v.addEventListener('ended', () => {
      if (v.classList.contains('front')) { playToken++; clearTimeout(collapseTimer); enterSuperIdle(); }
    });
    v.addEventListener('error', () => { if (v.classList.contains('front')) toStatic(); });
  });

  if (!listenersBound) {
    listenersBound = true;
    window.addEventListener('scroll', applyPlacement, { passive: true });
    window.addEventListener('resize', applyPlacement);
  }
}

// ─── placement ────────────────────────────────────────────
// While PLAYING an action: big + centered on screen. Otherwise: aligned to the
// layout slot beside the weight (or a fallback corner). Re-run on scroll/resize
// and on each transition, so it animates smoothly between the two.

function applyPlacement() {
  if (!root) return;
  let left, top, size;
  if (mode === 'playing') {                       // big + centered on screen
    size = Math.min(window.innerWidth * (COMPANION.centerVw / 100), COMPANION.centerMaxPx);
    left = (window.innerWidth - size) / 2;
    top = (window.innerHeight - size) / 2;
  } else {                                        // aligned to the slot beside the weight
    const slot = document.querySelector(COMPANION.slotSelector);
    const r = slot ? slot.getBoundingClientRect() : null;
    if (r && r.width > 0) { size = r.width; left = r.left; top = r.top; }
    else { size = COMPANION.idleSize; left = COMPANION.fallbackLeftPx; top = window.innerHeight * (COMPANION.fallbackTopPct / 100); }
  }
  const scale = size / COMPANION.intrinsic;
  root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px) scale(${scale.toFixed(4)})`;
}

// ─── clip list (manifest → Supabase fallback) ─────────────

function isVideo(name) {
  const n = (name || '').toLowerCase();
  return COMPANION.videoExts.some(ext => n.endsWith(ext));
}
function publicUrl(path) {
  return supabase.storage.from(COMPANION.bucket).getPublicUrl(path).data.publicUrl;
}
function baseName(u) { return u.split('?')[0].split('/').pop(); }

function splitPools(urls) {
  superPool = urls.filter(u => COMPANION.superIdleMatch.test(baseName(u)));
  exprPool = urls.filter(u => COMPANION.expressionMatch.test(baseName(u)));
  actionPool = urls.filter(u => COMPANION.actionMatch.test(baseName(u)));
  if (!superPool.length) superPool = exprPool.slice();
  const known = new Set([...superPool, ...exprPool, ...actionPool]);
  for (const u of urls) if (!known.has(u)) actionPool.push(u);
}

async function fetchList() {
  try {
    const res = await fetch(COMPANION.manifestSrc, { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      const arr = Array.isArray(data) ? data : data.clips;
      if (Array.isArray(arr) && arr.length) return arr.filter(isVideo);
    }
  } catch {}
  try {
    const { data, error } = await withTimeout(
      supabase.storage.from(COMPANION.bucket).list(COMPANION.clipsFolder, {
        limit: 1000, sortBy: { column: 'name', order: 'asc' },
      }), 8000, 'companion.list');
    if (!error && Array.isArray(data)) {
      return data.filter(f => isVideo(f.name)).map(f => publicUrl(`${COMPANION.clipsFolder}/${f.name}`));
    }
  } catch {}
  return [];
}

function loadClips() {
  if (listLoading) return listLoading;
  listLoading = (async () => {
    const urls = await fetchList();
    if (urls.length) { splitPools(urls); listLoaded = true; }
    listLoading = null;
    return urls;
  })();
  return listLoading;
}

// ─── selection (random, no recent repeats) ────────────────

function readRecent() {
  try { return JSON.parse(localStorage.getItem(COMPANION.recentKey) || '[]'); } catch { return []; }
}
function pushRecent(url) {
  try {
    const recent = readRecent(); recent.push(url);
    while (recent.length > COMPANION.recentMemory) recent.shift();
    localStorage.setItem(COMPANION.recentKey, JSON.stringify(recent));
  } catch {}
}
function pickFrom(pool) {
  if (!pool.length) return null;
  const recent = new Set(readRecent());
  const fresh = pool.filter(u => !recent.has(u));
  const choices = fresh.length ? fresh : pool;
  const url = choices[Math.floor(Math.random() * choices.length)];
  pushRecent(url);
  return url;
}

// ─── playback (crossfade between two layers) ──────────────

function stopLayer(v) {
  try { v.pause(); } catch {}
  v.removeAttribute('src');
  try { v.load(); } catch {}
}

function toStatic() {
  mode = 'static';
  clearTimeout(ambientTimer); clearTimeout(collapseTimer);
  if (!root) return;
  root.classList.remove('fc-live');
  root.setAttribute('data-state', 'idle');
  layers.forEach(v => { v.classList.remove('front'); stopLayer(v); });
}

function transition(url, newMode, loop) {
  if (!root) return;
  if (!url) { toStatic(); return; }
  const token = ++playToken;
  mode = newMode;
  root.setAttribute('data-state', newMode === 'playing' ? 'playing' : 'idle');
  applyPlacement();   // playing → grow to center; idle → shrink back to the slot (CSS-transitioned)

  const back = layers[1 - front];
  back.loop = !!loop;
  back.src = url;

  const reveal = () => {
    if (token !== playToken) return;
    back.oncanplay = null;
    const p = back.play(); if (p && p.catch) p.catch(() => {});
    back.classList.add('front');
    const oldFront = layers[front];
    oldFront.classList.remove('front');
    front = 1 - front;
    root.classList.add('fc-live');
    setTimeout(() => { if (oldFront !== layers[front]) stopLayer(oldFront); }, COMPANION.fadeMs + 60);
    clearTimeout(collapseTimer);
    if (newMode === 'playing') {
      collapseTimer = setTimeout(() => { if (token === playToken) enterSuperIdle(); }, COMPANION.maxClipMs);
    }
  };

  if (back.readyState >= 3) reveal();
  else {
    back.oncanplay = reveal;
    try { back.load(); } catch {}
    setTimeout(() => { if (token === playToken && !back.classList.contains('front')) reveal(); }, 1200);
  }
}

// ─── idle behaviour ───────────────────────────────────────

function enterSuperIdle() {
  clearTimeout(collapseTimer);
  if (prefersReducedMotion) { toStatic(); return; }
  const pool = superPool.length ? superPool : exprPool;
  if (!pool.length) { toStatic(); return; }
  transition(pickFrom(pool), 'idle', true);
  scheduleAmbientBeat();
}

function scheduleAmbientBeat() {
  clearTimeout(ambientTimer);
  const span = COMPANION.ambientMaxMs - COMPANION.ambientMinMs;
  ambientTimer = setTimeout(ambientBeat, COMPANION.ambientMinMs + Math.random() * span);
}

function ambientBeat() {
  if (mode !== 'idle') return;
  if (exprPool.length && Math.random() < COMPANION.expressionChance) {
    transition(pickFrom(exprPool), 'idle', false);
  } else {
    scheduleAmbientBeat();
  }
}

function popFallback() {
  if (!root) return;
  root.classList.remove('fc-pop'); void root.offsetWidth; root.classList.add('fc-pop');
  setTimeout(() => root && root.classList.remove('fc-pop'), 700);
}

/** Play a random ACTION clip (grown + centered), then return to super-idle. */
function play() {
  if (!root) return;
  if (prefersReducedMotion) { popFallback(); return; } // honor reduced-motion: no autoplay clip
  clearTimeout(ambientTimer);
  if (!listLoaded) { if (!listLoading) loadClips(); popFallback(); return; }
  const url = pickFrom(actionPool.length ? actionPool : superPool);
  if (!url) { popFallback(); return; }
  transition(url, 'playing', false);
}

// ─── public API ───────────────────────────────────────────

export function mountCompanion() {
  prefersReducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  buildDom();
  applyPlacement();
  requestAnimationFrame(() => { if (root) { root.classList.add('mounted', 'fc-ready'); applyPlacement(); } });
  loadClips().then(() => { if (mode === 'static') enterSuperIdle(); });
}

export function unmountCompanion() {
  if (!root) return;
  playToken++; clearTimeout(collapseTimer); clearTimeout(ambientTimer);
  toStatic();
  root.classList.remove('mounted');
}

export function triggerCompanion(event) {
  if (!TRIGGERS[event]) return;
  if (!root) mountCompanion();
  play();
}
