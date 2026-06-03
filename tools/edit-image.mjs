// Edit an image via the xAI image-edit API (grok-imagine-image-quality).
// Used to cleanly remove the cat's collar tag from a seed photo.
//   node --env-file=tools/.env tools/edit-image.mjs --in <path> --out <path> --prompt "..." [--aspect 3:4] [--res 2k]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.XAI_API_KEY;
const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const inPath = val('--in'), outPath = val('--out'), prompt = val('--prompt', 'Remove the tag.');
const aspect = val('--aspect', null), res = val('--res', '2k');
if (!KEY) { console.error('✖ no XAI_API_KEY (use --env-file=tools/.env)'); process.exit(1); }
if (!inPath || !outPath) { console.error('✖ need --in and --out'); process.exit(1); }

const buf = await readFile(path.resolve(inPath));
const lc = inPath.toLowerCase();
const mime = lc.endsWith('.png') ? 'png' : lc.endsWith('.webp') ? 'webp' : 'jpeg';
const dataUri = `data:image/${mime};base64,${buf.toString('base64')}`;

const body = {
  model: 'grok-imagine-image-quality',
  prompt,
  image: { url: dataUri, type: 'image_url' },
  response_format: 'b64_json',
  resolution: res,
};
if (aspect) body.aspect_ratio = aspect;

const r = await fetch('https://api.x.ai/v1/images/edits', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.data || !j.data[0]) {
  console.error('✖ edit failed', r.status, JSON.stringify(j).slice(0, 400));
  process.exit(1);
}
const d = j.data[0];
const outBuf = d.b64_json
  ? Buffer.from(d.b64_json, 'base64')
  : Buffer.from(await (await fetch(d.url)).arrayBuffer());
await writeFile(path.resolve(outPath), outBuf);
console.log(`✓ saved ${outPath}  (${(outBuf.length / 1024).toFixed(0)} KB) | cost ticks ${j.usage?.cost_in_usd_ticks ?? '?'}`);
