// Upload the curated companion pool (keeper clips in companion/generated/) to the
// public Supabase `companion` bucket under clips/, where the app reads them.
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY in tools/.env.
//   node --env-file=tools/.env tools/upload-pool.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const env = process.env;
const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_KEY || '';
if (!SUPABASE_URL || !KEY) {
  console.error('✖ Set SUPABASE_URL and SUPABASE_SERVICE_KEY in tools/.env first.');
  process.exit(1);
}

const dir = path.resolve('companion/generated');
// v2.0 ship set = the 55 CLEAN clips only. Excludes rest-* (bad seed, lost the
// folded ear) and pool-act-23..58 (still show the white collar tag). Those wait
// for a v2.1 regen. Ships: act-01..10, pool-act-01..22, face-1..6,
// pool-idle-01..12, stare-01..05.
const KEEPERS = /^(act-|face-|pool-idle-|stare-|pool-act-(0[1-9]|1[0-9]|2[0-2])-).*\.mp4$/;
const files = (await readdir(dir)).filter((f) => KEEPERS.test(f)).sort();

console.log(`Uploading ${files.length} clips → companion/clips/ ...`);
let ok = 0, fail = 0;
for (const f of files) {
  const buf = await readFile(path.join(dir, f));
  const url = `${SUPABASE_URL}/storage/v1/object/companion/clips/${f}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
    body: buf,
  });
  if (res.ok) { ok++; console.log(`  ✓ ${f}`); }
  else { fail++; console.log(`  ✗ ${f} — ${res.status} ${(await res.text()).slice(0, 120)}`); }
}
console.log(`\nDone: ${ok} uploaded, ${fail} failed.`);
