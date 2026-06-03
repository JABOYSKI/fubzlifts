// Build a grouped grid viewer of the companion pool (clips in companion/generated/).
// Run: node tools/make-viewer.mjs
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('companion/generated');
const GROUPS = [
  { title: 'ACTION clips', color: '#FF9900', re: /^(act-|pool-act-)/ },
  { title: 'IDLE reactions (expressions)', color: '#00A8B5', re: /^(face-|pool-idle-)/ },
  { title: 'AMBIENT idle (resting loops)', color: '#2ecc71', re: /^rest-/ },
  { title: 'SUPER idle (stare baseline)', color: '#2ecc71', re: /^stare-/ },
];

const all = (await readdir(dir)).filter((f) => /\.mp4$/.test(f));
const tile = (f) =>
  `<figure><video src="./${f}" muted loop autoplay playsinline preload="metadata"></video><figcaption>${f.replace('.mp4', '')}</figcaption></figure>`;

let total = 0;
const sections = GROUPS.map((g) => {
  const fs = all.filter((f) => g.re.test(f)).sort();
  total += fs.length;
  return `<h2 style="color:${g.color}">${g.title} <span style="color:#8D9EB0;font-weight:400">(${fs.length})</span></h2>
<div class="grid">${fs.map(tile).join('\n')}</div>`;
}).join('\n');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
body{margin:0;background:#131921;font-family:system-ui;color:#F0F2F2;padding:16px}
h1{font-size:16px;color:#F0F2F2;margin:0 0 4px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;margin:22px 0 8px}
.grid{display:flex;flex-wrap:wrap;gap:8px}
figure{margin:0;width:160px}
video{width:160px;height:160px;object-fit:cover;border-radius:8px;border:1.5px solid #37475A;background:#000}
figcaption{font-size:9px;color:#8D9EB0;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body>
<h1>FubzLifts companion — spot check (${total} clips)</h1>
${sections}
</body></html>`;

await writeFile(path.join(dir, '_viewer.html'), html);
console.log(`viewer built: ${total} clips across ${GROUPS.length} groups`);
