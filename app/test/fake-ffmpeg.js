#!/usr/bin/env node
'use strict';
/* A stand-in for ffmpeg in tests: writes an HLS playlist and a few segments the way the real one would, then stays running until it is killed. */
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a.includes('-version')) { console.log('ffmpeg version fake'); process.exit(0); }
const list = a[a.length - 1], dir = path.dirname(list);
const flag = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : ''; };
const append = /append_list/.test(flag('-hls_flags'));
let lines = [], n = parseInt(flag('-start_number'), 10) || 0;
if (append && fs.existsSync(list)) { lines = fs.readFileSync(list, 'utf8').split('\n').filter((l) => /^(#EXTINF|s\d+\.ts)/.test(l)); const m = lines.filter((l) => /^s\d+\.ts$/.test(l)); if (m.length) n = parseInt(m[m.length - 1].slice(1), 10) + 1; if (lines.length) lines.push('#EXT-X-DISCONTINUITY'); }
const write = () => fs.writeFileSync(list, ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-MEDIA-SEQUENCE:0', ...lines, ''].join('\n'));
for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(dir, `s${n}.ts`), 'x'); lines.push('#EXTINF:2.000000,', `s${n}.ts`); n++; }
write();
setInterval(() => {}, 1000);
