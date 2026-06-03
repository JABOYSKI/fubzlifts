// Make the looped super-idle clips seamless by boomeranging them (forward +
// reversed). The reversed half ends exactly on frame 0, so loop=true wraps with
// no snap, and the forward→reverse midpoint shares a frame too. Reversed subtle
// motion (blink/breathe/ear-flick) is imperceptible. Requires ffmpeg on PATH.
//   node tools/loopify.mjs           → boomerang all stare-*.mp4 in place
import { readdir, rename, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const dir = path.resolve('companion/generated');
const re = /^stare-.*\.mp4$/;               // only the looped super-idle clips
const targets = (await readdir(dir)).filter((f) => re.test(f));
console.log(`loopify (boomerang) → ${targets.length} clip(s)`);

for (const f of targets) {
  const src = path.join(dir, f);
  const tmp = path.join(dir, '__loop_' + f);
  try {
    execFileSync('ffmpeg', [
      '-y', '-i', src,
      '-filter_complex', '[0:v]reverse[r];[0:v][r]concat=n=2:v=1,format=yuv420p[v]',
      '-map', '[v]', '-an', '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast',
      '-movflags', '+faststart', tmp,
    ], { stdio: 'ignore' });
    await rename(tmp, src);
    const kb = Math.round((await stat(src)).size / 1024);
    console.log(`  ✓ ${f}  (${kb} KB, seamless)`);
  } catch (e) {
    console.log(`  ✗ ${f}  — ${e.message}`);
  }
}
