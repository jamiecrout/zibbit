'use strict';
/* A channel whose provider keeps going quiet: the buffer is restarted again and again, and the segment numbers must only ever go up.
 * Runs on its own (own temp folder, a fake ffmpeg, a clock it can move forward) and prints "ok" or "FAIL" lines for run-tests.js. */
const fs = require('fs'), os = require('os'), path = require('path');
process.env.TRANSCODE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ztc-'));
process.env.FFMPEG_PATH = path.join(__dirname, 'fake-ffmpeg.js');
const tc = require('../transcode');
let skew = 0; const real = Date.now; Date.now = () => real() + skew;
const newest = (dir) => { const m = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8').match(/^s(\d+)\.ts$/gm); return parseInt(m[m.length - 1].slice(1), 10); };
const open = () => tc.open('p:1', 'http://127.0.0.1/x.ts', { p: 'p', s: '1', keepSec: 1800 });
const say = (c, m) => console.log((c ? 'ok   ' : 'FAIL ') + m);
(async () => {
  let job = await open(); const seen = [newest(job.dir)];
  for (let i = 0; i < 5; i++) { tc.stop(job, true); skew += 4 * 60000; job = await open(); seen.push(newest(job.dir)); } // a restart every 4 minutes for 20 minutes
  say(seen.every((v, i) => i === 0 || v > seen[i - 1]), `segment numbers only go up across restarts every 4 minutes for 20 minutes (${seen.join(', ')})`);
  const before = seen[seen.length - 1];
  tc.stop(job, true); skew += 11 * 60000; await new Promise((r) => setTimeout(r, 5600)); // left alone for 11 minutes: the kept folder is dropped
  job = await open();
  say(newest(job.dir) > before, `a folder dropped after 11 quiet minutes still hands its numbering on (${before} then ${newest(job.dir)})`);
  tc.stopAll(); process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.message)); process.exit(1); });
