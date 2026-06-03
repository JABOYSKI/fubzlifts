// Batch-generate FubzLifts cat-companion clips via the xAI Grok Imagine video API.
//
// Reads companion/clip-catalog.json (1000 prompts), generates each as an
// image-to-video clip seeded from the cat photo, downloads the result to
// companion/generated/, and (optionally) uploads to Supabase Storage.
//
// Runs ENTIRELY on your machine. The API key is read from tools/.env (gitignored)
// and never enters the app/browser.
//
//   1. cp tools/.env.example tools/.env   (then fill in XAI_API_KEY + SEED_IMAGE_URL)
//   2. node --env-file=tools/.env tools/generate-clips.mjs --limit 5      # test a few first!
//   3. node --env-file=tools/.env tools/generate-clips.mjs --all --upload # the full run
//
// Flags:
//   --limit N     generate only the first N not-yet-done clips
//   --all         generate every remaining clip (required for a full run)
//   --start N     skip clips with id < N (resume / re-do a range)
//   --force       re-generate even if the local .mp4 already exists
//   --text-only   ignore the seed image (cat will NOT look like your cat)
//   --upload      upload each finished clip to Supabase (needs SUPABASE_SERVICE_KEY)
//   --dry-run     print what would happen; make no API calls
//
// Resumable: clips whose .mp4 already exists locally are skipped, so you can
// stop (Ctrl-C) and re-run anytime.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'companion', 'generated');

const API_BASE = 'https://api.x.ai/v1';
const MODEL = 'grok-imagine-video';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000; // give each clip up to 8 min
const MAX_RETRIES = 2;                  // retries on a failed/errored generation

// ── args + env ────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const opts = {
  all: has('--all'),
  limit: valOf('--limit', null) ? parseInt(valOf('--limit'), 10) : null,
  start: valOf('--start', null) ? parseInt(valOf('--start'), 10) : 0,
  force: has('--force'),
  textOnly: has('--text-only'),
  upload: has('--upload'),
  dryRun: has('--dry-run'),
};

const env = process.env;
const API_KEY = env.XAI_API_KEY;
const SEED = (valOf('--seed', env.SEED_IMAGE_URL || '')).trim();
const DURATION = parseInt(valOf('--duration', env.CLIP_DURATION || '6'), 10);
const RESOLUTION = valOf('--resolution', env.CLIP_RESOLUTION || '480p');
const catalogArg = valOf('--catalog', 'companion/clip-catalog.json');
const CATALOG = path.isAbsolute(catalogArg) ? catalogArg : path.join(ROOT, catalogArg);
// reference-to-video: comma-separated image paths/URLs. When set, the request
// uses reference_images (guides content across all frames) INSTEAD of image
// (first-frame lock) — the API forbids combining the two.
const REFS = (valOf('--refs', env.REFERENCE_IMAGES || '')).split(',').map(s => s.trim()).filter(Boolean);
const ASPECT = env.CLIP_ASPECT_RATIO || '1:1';
const CONCURRENCY = Math.max(1, parseInt(env.CLIP_CONCURRENCY || '3', 10));
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || '';

// ── helpers ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

function mimeFor(p) {
  const e = p.toLowerCase();
  if (e.endsWith('.png')) return 'image/png';
  if (e.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

// Resolve the seed image to whatever the API's `image.url` accepts:
// a public URL as-is, or a local file → base64 data URI.
// Resolve an image path/URL to what the API accepts: a public URL as-is, or a
// local file → base64 data URI.
async function resolveImage(value, label) {
  if (/^https?:\/\//i.test(value)) return value;
  const abs = path.isAbsolute(value) ? value : path.join(ROOT, value);
  if (!existsSync(abs)) die(`${label} points to a missing file: ${abs}`);
  const buf = await readFile(abs);
  return `data:${mimeFor(abs)};base64,${buf.toString('base64')}`;
}

async function resolveSeed() {
  if (opts.textOnly || !SEED) return null;
  return resolveImage(SEED, 'SEED_IMAGE_URL');
}

async function resolveRefs() {
  if (!REFS.length) return [];
  return Promise.all(REFS.map((r) => resolveImage(r, '--refs')));
}

async function startGeneration(prompt, seed, refs) {
  const body = { model: MODEL, prompt, duration: DURATION, aspect_ratio: ASPECT, resolution: RESOLUTION };
  if (refs && refs.length) body.reference_images = refs.map((url) => ({ url })); // reference-to-video mode
  else if (seed) body.image = { url: seed };                                     // image-to-video mode
  const res = await fetch(`${API_BASE}/videos/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.request_id) {
    throw new Error(`start failed (${res.status}): ${json?.error?.message || JSON.stringify(json).slice(0, 200)}`);
  }
  return json.request_id;
}

async function pollUntilDone(requestId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(`${API_BASE}/videos/${requestId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'done' && j.video?.url) return j;
    if (j.status === 'failed' || j.status === 'expired') {
      throw new Error(`generation ${j.status}: ${j?.error?.message || 'no detail'}`);
    }
    // else pending — keep polling
  }
  throw new Error('timed out waiting for generation');
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

async function uploadToSupabase(buf, filename) {
  const url = `${SUPABASE_URL}/storage/v1/object/companion/clips/${filename}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${(await res.text()).slice(0, 160)}`);
}

// ── one clip ──────────────────────────────────────────────
async function processClip(clip, seed, refs, state) {
  const dest = path.join(OUT_DIR, clip.filename);
  if (!opts.force && existsSync(dest)) { state.skipped++; return; }

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const id = await startGeneration(clip.prompt, seed, refs);
      const result = await pollUntilDone(id);
      const buf = Buffer.from(await (await fetch(result.video.url)).arrayBuffer());
      await writeFile(dest, buf);
      if (result.usage?.cost_in_usd_ticks) state.costTicks += result.usage.cost_in_usd_ticks;
      if (opts.upload && SUPABASE_URL && SUPABASE_KEY) await uploadToSupabase(buf, clip.filename);
      state.done++;
      log(`  ✓ ${clip.filename}  (${(buf.length / 1024).toFixed(0)} KB)  [${state.done + state.skipped}/${state.total}]`);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(2000 * (attempt + 1));
    }
  }
  state.failed.push({ id: clip.id, filename: clip.filename, error: String(lastErr?.message || lastErr) });
  log(`  ✗ ${clip.filename}  — ${lastErr?.message || lastErr}`);
}

// ── simple async worker pool ──────────────────────────────
async function runPool(items, worker, size) {
  let i = 0;
  const next = async () => { while (i < items.length) { const idx = i++; await worker(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, next));
}

// ── main ──────────────────────────────────────────────────
async function main() {
  if (!API_KEY) die('XAI_API_KEY is not set. Did you run with `node --env-file=tools/.env ...`?');
  if (!opts.all && !opts.limit) {
    die('Refusing to run without a scope. Use `--limit N` to test a few, or `--all` for everything.\n' +
        '  Generating all 1000 clips is a real API spend — start with `--limit 5`.');
  }

  const catalog = JSON.parse((await readFile(CATALOG, 'utf8')).replace(/^﻿/, ''));
  let queue = catalog.filter((c) => c.id >= opts.start);
  if (opts.limit) {
    // count "first N not-yet-done" so re-runs make progress instead of re-checking the same N
    const pending = queue.filter((c) => opts.force || !existsSync(path.join(OUT_DIR, c.filename)));
    queue = pending.slice(0, opts.limit);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const seed = await resolveSeed();
  const refs = await resolveRefs();

  const mode = refs.length
    ? `reference-to-video (${refs.length} ref image${refs.length > 1 ? 's' : ''})`
    : seed ? 'image-to-video (seed)' : 'text-to-video';
  log('\n🐈‍⬛  FubzLifts companion clip generator');
  log(`   model=${MODEL}  ${ASPECT} ${RESOLUTION} ${DURATION}s  concurrency=${CONCURRENCY}`);
  log(`   mode=${mode}`);
  log(`   upload=${opts.upload && SUPABASE_URL && SUPABASE_KEY ? 'yes → Supabase' : 'no (local only)'}`);
  log(`   to generate this run: ${queue.length} clip(s)\n`);

  if (opts.dryRun) {
    queue.slice(0, 10).forEach((c) => log(`   would generate ${c.filename}: ${c.prompt.slice(0, 70)}…`));
    if (queue.length > 10) log(`   …and ${queue.length - 10} more`);
    log('\n(dry run — no API calls made)\n');
    return;
  }
  if (!queue.length) { log('Nothing to do — everything is already generated.\n'); return; }

  const state = { total: queue.length, done: 0, skipped: 0, failed: [], costTicks: 0 };
  const t0 = Date.now();
  await runPool(queue, (c) => processClip(c, seed, refs, state), CONCURRENCY);

  if (state.failed.length) {
    await writeFile(path.join(OUT_DIR, '_failures.json'), JSON.stringify(state.failed, null, 2));
  }
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  log(`\n── done in ${mins} min ──`);
  log(`   generated: ${state.done}   skipped: ${state.skipped}   failed: ${state.failed.length}`);
  if (state.failed.length) log(`   failures logged to companion/generated/_failures.json (re-run to retry)`);
  if (state.costTicks) log(`   xAI usage: ${state.costTicks} cost ticks`);
  log('');
}

main().catch((e) => die(e?.stack || String(e)));
