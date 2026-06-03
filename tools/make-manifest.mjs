// Write companion/clips-manifest.json — a local list of the curated pool clips,
// used by the companion engine as an MVP clip source (no Supabase upload needed).
// Run: node tools/make-manifest.mjs
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('companion/generated');
const KEEPERS = /^(face-|act-|pool-act-|pool-idle-|rest-|stare-).*\.mp4$/;
const files = (await readdir(dir)).filter((f) => KEEPERS.test(f)).sort();
const clips = files.map((f) => `companion/generated/${f}`);

await writeFile(path.resolve('companion/clips-manifest.json'), JSON.stringify({ clips }, null, 2));
console.log(`manifest written: ${clips.length} clips`);
